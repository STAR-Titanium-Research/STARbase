import { describe, expect, it } from 'vitest';
import { SHOWN_WHEN_FOLDED, railSockets, socketOwners } from './railSockets';
import type { ContainerNode, SampleRow } from './types';

const con = (rows: SampleRow[], over: Partial<ContainerNode> = {}): ContainerNode =>
	({
		id: 'op:o1',
		type: 'container',
		kind: 'operation',
		group: { id: 'op:o1', kind: 'operation', rowIds: rows.map((r) => r.recordId), batch: null },
		title: 'Cut',
		code: 'OP-1',
		category: 'machining',
		rows,
		slots: [],
		settings: [],
		bundled: false,
		probable: false,
		...over,
	}) as ContainerNode;

const ids = (list: { id: string }[]) => list.map((s) => s.id);

describe('railSockets', () => {
	it('lists each socket id once, in row order (a cut\'s shared input once)', () => {
		const node = con([
			{ recordId: 'a', in: 'op:o1:in:0', out: 'op:o1:out:0' },
			{ recordId: 'b', in: 'op:o1:in:0', out: 'op:o1:out:1' },
		]);
		expect(ids(railSockets(node, 'in'))).toEqual(['op:o1:in:0']);
		expect(ids(railSockets(node, 'out'))).toEqual(['op:o1:out:0', 'op:o1:out:1']);
		expect(railSockets(node, 'out').map((s) => [s.recordId, s.row])).toEqual([['a', 0], ['b', 1]]);
	});

	it('draws the rows past the fold on one fat bundle socket, last', () => {
		const rows: SampleRow[] = ['a', 'b', 'c', 'd'].map((r, i) => (i < SHOWN_WHEN_FOLDED ? { recordId: r, in: `op:o1:in:${i}`, out: `op:o1:out:${i}` } : { recordId: r, in: 'op:o1:in:b', out: 'op:o1:out:b' }));
		const node = con(rows, { bundled: true });
		const outs = railSockets(node, 'out');
		expect(ids(outs)).toEqual(['op:o1:out:0', 'op:o1:out:1', 'op:o1:out:b']);
		expect(outs[2]).toMatchObject({ fat: true, recordId: null, row: -1 });
	});

	it('gives a row with nothing wired a free socket in edit mode only', () => {
		const node = con([{ recordId: 'draft:n3', out: 'op:o1:out:0' }]);
		expect(railSockets(node, 'in')).toEqual([]);
		expect(railSockets(node, 'in', { editable: true })).toEqual([{ id: 'free:in:draft:n3', fat: false, recordId: 'draft:n3', row: 0, free: true }]);
		expect(railSockets(node, 'out', { editable: true }).map((s) => s.free)).toEqual([false]);
	});

	it('gives a test no output, wired or free', () => {
		const node = con([{ recordId: 't1' }], { kind: 'test' });
		expect(railSockets(node, 'out', { editable: true })).toEqual([]);
		expect(ids(railSockets(node, 'in', { editable: true }))).toEqual(['free:in:t1']);
	});
});

describe('socketOwners', () => {
	it('says which row and side each wired socket is, and nothing of a bundle', () => {
		const rows: SampleRow[] = ['a', 'b', 'c'].map((r, i) => (i < SHOWN_WHEN_FOLDED ? { recordId: r, in: `op:o1:in:${i}`, out: `op:o1:out:${i}` } : { recordId: r, in: 'op:o1:in:b', out: 'op:o1:out:b' }));
		const owners = socketOwners(con(rows, { bundled: true }));
		expect(owners.get('op:o1:in:1')).toEqual({ recordId: 'b', side: 'in', row: 1 });
		expect(owners.get('op:o1:out:0')).toEqual({ recordId: 'a', side: 'out', row: 0 });
		expect(owners.has('op:o1:in:b')).toBe(false);
	});

	it('gives a shared socket to the first row that has it, and a test\'s output to nobody', () => {
		const shared = con([{ recordId: 'a', in: 'op:o1:in:0' }, { recordId: 'b', in: 'op:o1:in:0' }]);
		expect(socketOwners(shared).get('op:o1:in:0')).toMatchObject({ recordId: 'a' });
		const test = con([{ recordId: 't1', in: 'op:t1:in:0', out: 'op:t1:out:0' }], { kind: 'test' });
		expect(socketOwners(test).has('op:t1:out:0')).toBe(false);
		expect(socketOwners(test).has('op:t1:in:0')).toBe(true);
	});
});
