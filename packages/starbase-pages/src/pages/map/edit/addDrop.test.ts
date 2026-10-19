import { describe, expect, it } from 'vitest';
import type { DraftBody } from '@d1/ui';
import { apply, emptyBody, type DraftAction } from './draft';
import type { MenuChoice } from './menuModel';
import { NOT_IN_DRAFT, recordedSocketReason, socketVerdict } from './addDrop';
import { buildGraph } from '../model/buildGraph';
import { groupBatches } from '../model/groupBatches';
import { mkData, mkOp, mkSample } from '../model/fixtures';
import type { ProcessData } from '../model/types';
import { DONE_WIRE, SAVED_WIRE } from './removal';
import { toGraph } from './toGraph';
import type { SocketRef } from './socketRefs';

const run = (actions: DraftAction[], from: DraftBody = emptyBody()): DraftBody => actions.reduce((b, a) => apply(b, a), from);
const sock = (kind: 'sample' | 'row', id: string, side: 'in' | 'out', add = false): SocketRef => ({ kind, id, side, ...(add ? { add: true as const } : {}) });

const graphOf = (data: ProcessData) => {
	const d = toGraph(data, emptyBody());
	return buildGraph(d, groupBatches(d.operations, d.tests, { probable: false, stack: true }), { slots: () => [] });
};
const turning: MenuChoice = { kind: 'operation', methodId: 'mt', category: 'machining' };
const test: MenuChoice = { kind: 'test', testType: 'xrd' };
const sample: MenuChoice = { kind: 'newSample' };

/** n1 a sample, n2 an operation fed by it (row n3), n4 a test on n1, n5 a free sample. */
const body = (): DraftBody =>
	run([
		{ type: 'addSample' },
		{ type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'mt' }, from: { key: 'n1' } },
		{ type: 'addContainer', kind: 'test', source: { from: 'blank', testType: 'tensile' }, from: { key: 'n1' } },
		{ type: 'addSample' },
	]);

describe('dropping a catalog entry on a socket', () => {
	it('an operation or a test fits a sample\'s output', () => {
		expect(socketVerdict(body(), sock('sample', 'draft:n5', 'out'), turning)).toEqual({ ok: true });
		expect(socketVerdict(body(), sock('sample', 'draft:n5', 'out'), test)).toEqual({ ok: true });
	});

	it('an operation (not a test) fits a free sample\'s input: it is what makes it', () => {
		expect(socketVerdict(body(), sock('sample', 'draft:n5', 'in'), turning)).toEqual({ ok: true });
		expect(socketVerdict(body(), sock('sample', 'draft:n5', 'in'), test).ok).toBe(false);
	});

	it('a new sample fits an operation\'s output and the input of an operation or a test', () => {
		expect(socketVerdict(body(), sock('row', 'draft:n3', 'out'), sample)).toEqual({ ok: true });
		const free = run([{ type: 'addContainer', kind: 'operation', source: { from: 'blank' } }, { type: 'addContainer', kind: 'test', source: { from: 'blank', testType: 'xrd' } }]);
		expect(socketVerdict(free, sock('row', 'draft:n2', 'in'), sample)).toEqual({ ok: true });
		expect(socketVerdict(free, sock('row', 'draft:n3', 'in'), sample)).toEqual({ ok: true });
	});

	it('refuses with the reason where it does not fit', () => {
		const b = body();
		expect(socketVerdict(b, sock('row', 'draft:n3', 'out'), turning)).toMatchObject({ ok: false, reason: expect.stringContaining('output takes a sample') });
		expect(socketVerdict(b, sock('row', 'draft:n3', 'in'), turning)).toMatchObject({ ok: false, reason: expect.stringContaining('input takes a sample') });
		expect(socketVerdict(b, sock('sample', 'draft:n5', 'out'), sample)).toMatchObject({ ok: false, reason: expect.stringContaining('joined through an operation') });
		expect(socketVerdict(b, sock('sample', 'draft:n5', 'in'), sample)).toMatchObject({ ok: false, reason: expect.stringContaining('made by an operation') });
		expect(socketVerdict(b, sock('row', 'draft:n4', 'out'), sample)).toEqual({ ok: false, reason: 'A test has no output.' });
		expect(socketVerdict(b, sock('row', 'draft:n4', 'out'), test)).toEqual({ ok: false, reason: 'A test has no output.' });
		expect(socketVerdict(b, sock('sample', 'draft:n5', 'out'), { kind: 'pickSamples' })).toMatchObject({ ok: false });
	});

	it('From database… fits a sample\'s output (the picker chooses the operation), and nothing else', () => {
		const db: MenuChoice = { kind: 'fromDatabase' };
		expect(socketVerdict(body(), sock('sample', 'draft:n5', 'out'), db)).toEqual({ ok: true });
		for (const s of [sock('sample', 'draft:n5', 'in'), sock('row', 'draft:n3', 'out'), sock('row', 'draft:n3', 'in'), sock('row', 'draft:n4', 'in')]) {
			expect(socketVerdict(body(), s, db)).toMatchObject({ ok: false, reason: expect.stringContaining('attached to a sample') });
		}
	});

	it('refuses with the draft\'s own reason when the reducer says no: an operation output that already goes to a sample', () => {
		const made = run([{ type: 'addSample' }, { type: 'addContainer', kind: 'operation', source: { from: 'blank' }, from: { key: 'n1' } }, { type: 'addSample', from: { key: 'n2', row: 0 } }]);
		expect(socketVerdict(made, sock('row', 'draft:n3', 'out'), sample)).toEqual({ ok: false, reason: 'That output already goes to a sample.' });
	});

	it('a wired input takes no second sample', () => {
		expect(socketVerdict(body(), sock('row', 'draft:n3', 'in'), sample)).toEqual({ ok: false, reason: 'That input already has a sample.' });
	});

	it('a free socket that stands for a new row is judged as the draft with the row', () => {
		expect(socketVerdict(body(), sock('row', 'draft:n3', 'out', true), sample)).toEqual({ ok: true });
	});

	it('a wired socket of a recorded operation or test (not in the draft) takes nothing, and says why: its lock, or that it is not in the draft', () => {
		for (const side of ['in', 'out'] as const) {
			expect(socketVerdict(emptyBody(), sock('row', 'o1', side), sample)).toEqual({ ok: false, reason: NOT_IN_DRAFT });
			expect(socketVerdict(emptyBody(), sock('row', 'o1', side), sample, () => DONE_WIRE)).toEqual({ ok: false, reason: DONE_WIRE });
		}
		const g = graphOf(mkData({ samples: [mkSample('s1', { status: 'active' })], operations: [mkOp({ id: 'o1', sampleId: 's1', date: '2026-09-01T09:00:00Z' }), mkOp({ id: 'o2', sampleId: 's1', workState: 'planned' })] }));
		expect(recordedSocketReason(g, sock('row', 'o1', 'in'))).toBe(DONE_WIRE);
		expect(recordedSocketReason(g, sock('row', 'o2', 'out'))).toBe(SAVED_WIRE);
		expect(recordedSocketReason(g, sock('row', 'nope', 'out'))).toBe(NOT_IN_DRAFT);
	});

	it('a sample of the loaded history: something may be built from its output; nothing can make it', () => {
		expect(socketVerdict(emptyBody(), sock('sample', 'old', 'out'), turning)).toEqual({ ok: true });
		expect(socketVerdict(emptyBody(), sock('sample', 'old', 'in'), turning)).toEqual({ ok: false, reason: 'That sample already exists with its own history: it cannot be made by this operation.' });
	});
});
