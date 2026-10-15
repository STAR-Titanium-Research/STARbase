import { describe, expect, it } from 'vitest';
import type { DraftBody } from '@d1/ui';
import { apply, emptyBody, type DraftAction } from './draft';
import type { ContainerNode, MapNode, RecordNode } from '../model/types';
import { decodeSocket, draftKeyOfNode, encodeSocket, isDraftNode, nearestSocket, newOperationOf, resolveEnd, rowItemOf, rowRecordId, sampleItemOf } from './socketRefs';

const run = (actions: DraftAction[], from: DraftBody = emptyBody()): DraftBody => actions.reduce((b, a) => apply(b, a), from);

/** n1 a new sample, n2 a blank operation (row n3) fed by it, n4 a test fed by the sample, n5 an existing sample. */
const body = (): DraftBody =>
	run([
		{ type: 'addSample' },
		{ type: 'addContainer', kind: 'operation', source: { from: 'blank' }, from: { key: 'n1' } },
		{ type: 'addContainer', kind: 'test', source: { from: 'blank', testType: 'tensile' }, from: { key: 'n1' } },
		{ type: 'addExistingSamples', samples: [{ id: 'real-1', version: 3 }] },
	]);

const sampleCard = (id: string): RecordNode => ({ id: `s:${id}`, type: 'record', kind: 'sample', ref: { collection: 'physical_samples', id, code: id }, ins: [], outs: [] });
const container = (rowIds: string[], kind: 'operation' | 'test' = 'operation', extra: Partial<ContainerNode> = {}): ContainerNode => ({
	id: `c:${rowIds[0]}`,
	type: 'container',
	kind,
	group: { id: `c:${rowIds[0]}`, kind, rowIds, batch: null },
	title: 'x',
	code: '',
	category: null,
	rows: [],
	slots: [],
	settings: [],
	bundled: false,
	probable: false,
	...extra,
});

describe('socket references in the page', () => {
	it('round-trip through the attribute', () => {
		const s = { kind: 'row', id: 'draft:n3', side: 'out' } as const;
		expect(decodeSocket(encodeSocket(s))).toEqual(s);
		expect(decodeSocket(encodeSocket({ kind: 'sample', id: '1b6f-uuid', side: 'in' }))).toEqual({ kind: 'sample', id: '1b6f-uuid', side: 'in' });
	});

	it('refuse what is not one', () => {
		for (const bad of [null, undefined, '', 'row', 'row|x', 'cat|x|in', 'row|x|up', 'row|x|in|extra']) expect(decodeSocket(bad)).toBeNull();
	});
});

describe('resolving a card or a socket against the draft', () => {
	it('finds a new sample by its draft id and an existing one by its record id', () => {
		const b = body();
		expect(sampleItemOf(b, 'draft:n1')?.key).toBe('n1');
		expect(sampleItemOf(b, 'real-1')?.key).toBe('n5');
		expect(sampleItemOf(b, 'draft:n9')).toBeUndefined();
		expect(sampleItemOf(b, 'other')).toBeUndefined();
	});

	it('finds an operation row by its row key and a test by its own', () => {
		const b = body();
		expect(rowItemOf(b, 'draft:n3')).toMatchObject({ item: { key: 'n2' }, row: 0 });
		expect(rowItemOf(b, 'draft:n4')).toMatchObject({ item: { key: 'n4' } });
		expect(rowItemOf(b, 'draft:n2')).toBeUndefined(); // an operation's key is not a row: its rows are drawn
	});

	it('turns a socket into the end of a wire', () => {
		const b = body();
		expect(resolveEnd(b, { kind: 'sample', id: 'draft:n1', side: 'out' })).toEqual({ key: 'n1' });
		expect(resolveEnd(b, { kind: 'row', id: 'draft:n3', side: 'out' })).toEqual({ key: 'n2', row: 0 });
		expect(resolveEnd(b, { kind: 'row', id: 'draft:n4', side: 'in' })).toEqual({ key: 'n4' });
		expect(resolveEnd(b, { kind: 'sample', id: 'old-sample', side: 'out' })).toBeNull(); // in the loaded history, not in the draft
		expect(resolveEnd(b, { kind: 'row', id: 'recorded-op', side: 'in' })).toBeNull();
	});

	it('rows of a cut each have their own end', () => {
		const b = run([{ type: 'addContainer', kind: 'operation', source: { from: 'blank' }, rows: 3 }]);
		expect([0, 1, 2].map((i) => resolveEnd(b, { kind: 'row', id: `draft:n${i + 2}`, side: 'out' }))).toEqual([
			{ key: 'n1', row: 0 },
			{ key: 'n1', row: 1 },
			{ key: 'n1', row: 2 },
		]);
	});

	it('an attached existing operation is its own row 0', () => {
		const b = run([{ type: 'attach', operation: { id: 'op-9', version: 2 }, workState: 'planned' }]);
		expect(resolveEnd(b, { kind: 'row', id: 'op-9', side: 'in' })).toEqual({ key: 'n1', row: 0 });
	});
});

describe('cards of the draft', () => {
	it('are the cards whose records the draft holds', () => {
		const b = body();
		expect(draftKeyOfNode(b, sampleCard('draft:n1'))).toBe('n1');
		expect(draftKeyOfNode(b, sampleCard('real-1'))).toBe('n5');
		expect(draftKeyOfNode(b, sampleCard('old'))).toBeNull();
		expect(draftKeyOfNode(b, container(['draft:n3']))).toBe('n2');
		expect(draftKeyOfNode(b, container(['draft:n4'], 'test'))).toBe('n4');
		expect(draftKeyOfNode(b, container(['recorded-op']))).toBeNull();
		expect(draftKeyOfNode(b, undefined)).toBeNull();
		expect(isDraftNode(b, sampleCard('draft:n1'))).toBe(true);
		expect(isDraftNode(b, sampleCard('old'))).toBe(false);
	});

	it('a stack of passes is the item of its first pass', () => {
		const b = run([{ type: 'addSample' }, { type: 'addPass', sample: { key: 'n1' }, values: { method_id: 'turn' } }, { type: 'duplicate', key: 'n2' }]);
		const stack = container(['draft:n3', 'draft:n5'], 'operation', { stacked: true });
		expect(draftKeyOfNode(b, stack)).toBe('n2');
	});

	it('a record card that is not a sample has no draft key', () => {
		const lot: MapNode = { id: 'lot:1', type: 'record', kind: 'stock_lot', ref: { collection: 'raw_stock_lots', id: '1', code: 'L' }, ins: [], outs: [] };
		expect(draftKeyOfNode(body(), lot)).toBeNull();
	});

	it('a new operation can get another output row; an existing one cannot', () => {
		const b = run([...[{ type: 'addContainer', kind: 'operation', source: { from: 'blank' } }] as DraftAction[], { type: 'attach', operation: { id: 'op-9', version: 1 }, workState: 'planned' }]);
		expect(newOperationOf(b, 'n1')?.key).toBe('n1');
		expect(newOperationOf(b, 'n3')).toBeNull();
		expect(newOperationOf(b, null)).toBeNull();
	});
});

describe('a stack of passes', () => {
	it('takes its input from its first pass and its output from its last', () => {
		const stack = { group: { rowIds: ['a', 'b', 'c'] }, stacked: true };
		expect(rowRecordId(stack, 'a', 'in')).toBe('a');
		expect(rowRecordId(stack, 'a', 'out')).toBe('c');
		expect(rowRecordId({ group: { rowIds: ['a', 'b'] } }, 'b', 'out')).toBe('b');
		expect(rowRecordId({ group: { rowIds: ['a'] }, stacked: true }, 'a', 'out')).toBe('a');
	});
});

describe('the socket under the pointer', () => {
	const spots = [
		{ sock: { kind: 'sample', id: 'a', side: 'out' } as const, x: 100, y: 100 },
		{ sock: { kind: 'row', id: 'b', side: 'in' } as const, x: 130, y: 100 },
	];
	it('is the nearest one within the radius', () => {
		expect(nearestSocket(spots, 104, 102)?.sock.id).toBe('a');
		expect(nearestSocket(spots, 125, 100)?.sock.id).toBe('b');
	});
	it('is none when nothing is close enough', () => {
		expect(nearestSocket(spots, 200, 200)).toBeNull();
		expect(nearestSocket([], 0, 0)).toBeNull();
		expect(nearestSocket(spots, 100, 120, 18)).toBeNull();
	});
});
