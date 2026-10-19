import { describe, expect, it } from 'vitest';
import type { DraftBody } from '@d1/ui';
import { buildGraph } from '../model/buildGraph';
import { groupBatches } from '../model/groupBatches';
import { mkData, mkOp, mkSample } from '../model/fixtures';
import { nodeOfSocket } from '../model/sockets';
import type { MapNode, ProcessData, ProcessGraph, RecordNode } from '../model/types';
import { apply, emptyBody, type DraftAction } from './draft';
import type { MenuChoice } from './menuModel';
import { ALREADY_GOING, DONE_WIRE, SAVED_WIRE } from './removal';
import { BEFORE_RECORDED, NO_FIT, SAMPLE_BETWEEN, STACKED, TEST_AFTER, TEST_BETWEEN, insertAround, insertBeforeRefusal, insertOnWire, insertRefusal } from './insertModel';
import { toGraph } from './toGraph';

const run = (actions: DraftAction[], from: DraftBody = emptyBody()): DraftBody => actions.reduce((b, a) => apply(b, a), from);
const graphOf = (data: ProcessData | null, body: DraftBody): ProcessGraph => {
	const d = toGraph(data, body);
	return buildGraph(d, groupBatches(d.operations, d.tests, { probable: false, stack: true }), { slots: () => [] });
};
const node = (g: ProcessGraph, id: string): MapNode => g.nodes.find((n) => n.id === id)!;
/** The drawn wire from the card `from` to the card `to`. */
const wireOf = (g: ProcessGraph, from: string, to: string): string => g.wires.find((w) => nodeOfSocket(w.from) === from && nodeOfSocket(w.to) === to)?.id ?? `no wire ${from} > ${to}`;

const turning: MenuChoice = { kind: 'operation', methodId: 'mt', category: 'machining' };
const done = (v: ReturnType<typeof insertOnWire>): DraftAction[] => {
	if (!v.ok) throw new Error(`refused: ${v.reason}`);
	return v.actions;
};
const wiresText = (b: DraftBody): string[] => b.wires.map((w) => `${w.from.key}${w.from.row !== undefined ? `.${w.from.row}` : ''}>${w.to.key}${w.to.row !== undefined ? `.${w.to.row}` : ''}`).sort();
const kinds = (b: DraftBody): string[] => b.items.map((i) => `${i.key}:${i.kind}`);

/** n1 sample -> n2 operation (row n3) -> n4 sample. */
const chain = (): DraftBody => run([{ type: 'addSample' }, { type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'mm' }, from: { key: 'n1' } }, { type: 'addSample', from: { key: 'n2', row: 0 } }]);
/** n1 sample -> n2 operation -> n4 operation (wired op to op). */
const twoOps = (): DraftBody =>
	run([{ type: 'addSample' }, { type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'mm' }, from: { key: 'n1' } }, { type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'mf' }, from: { key: 'n2', row: 0 } }]);

describe('dropping an operation on a wire', () => {
	it('sample -> operation: the sample feeds the new operation, which makes a new sample that feeds the old one', () => {
		const body = chain();
		const g = graphOf(null, body);
		const wire = wireOf(g, 's:draft:n1', 'op:draft:n3');
		const actions = done(insertOnWire(body, g, wire, turning));
		const after = run(actions, body);
		expect(kinds(after)).toEqual(['n1:sample', 'n2:operation', 'n4:sample', 'n5:operation', 'n7:sample']);
		expect(wiresText(after)).toEqual(['n1>n5.0', 'n2.0>n4', 'n5.0>n7', 'n7>n2.0']);
		expect(after.items.find((i) => i.key === 'n5')).toMatchObject({ values: { method_id: 'mt', process_category: 'machining' } });
	});

	it('operation -> sample: the operation makes a new sample, which the new operation turns into the old one', () => {
		const body = chain();
		const g = graphOf(null, body);
		const after = run(done(insertOnWire(body, g, wireOf(g, 'op:draft:n3', 's:draft:n4'), turning)), body);
		expect(wiresText(after)).toEqual(['n1>n2.0', 'n2.0>n5', 'n5>n6.0', 'n6.0>n4']);
	});

	it('operation -> operation: the new operation goes between them', () => {
		const body = twoOps();
		const g = graphOf(null, body);
		const wire = wireOf(g, 'op:draft:n3', 'op:draft:n5');
		const after = run(done(insertOnWire(body, g, wire, turning)), body);
		expect(wiresText(after)).toContain('n2.0>n6.0');
		expect(wiresText(after)).toContain('n6.0>n4.0');
		expect(wiresText(after)).not.toContain('n2.0>n4.0');
	});

	it('is the planned operation the catalog gives: planned, with its method and category, at the drop point', () => {
		const body = chain();
		const g = graphOf(null, body);
		const actions = done(insertOnWire(body, g, wireOf(g, 's:draft:n1', 'op:draft:n3'), turning, { x: 120, y: 80 }));
		const after = run(actions, body);
		expect(after.items.find((i) => i.key === 'n5')).toMatchObject({ kind: 'operation', workState: 'planned' });
		expect(after.positions.n5).toEqual({ x: 120, y: 80 });
	});

	it('a test cannot go between two cards: it has nothing coming out', () => {
		const body = chain();
		const g = graphOf(null, body);
		expect(insertOnWire(body, g, wireOf(g, 's:draft:n1', 'op:draft:n3'), { kind: 'test', testType: 'xrd' })).toEqual({ ok: false, reason: TEST_BETWEEN, locked: false });
	});

	it('a new sample goes between two operations, not between a sample and an operation', () => {
		const body = twoOps();
		const g = graphOf(null, body);
		const after = run(done(insertOnWire(body, g, wireOf(g, 'op:draft:n3', 'op:draft:n5'), { kind: 'newSample' })), body);
		expect(wiresText(after)).toEqual(['n1>n2.0', 'n2.0>n6', 'n6>n4.0']);
		const c = chain();
		const gc = graphOf(null, c);
		expect(insertOnWire(c, gc, wireOf(gc, 's:draft:n1', 'op:draft:n3'), { kind: 'newSample' })).toEqual({ ok: false, reason: SAMPLE_BETWEEN, locked: false });
	});

	it('refuses what is neither: an existing sample, a wire that is gone', () => {
		const body = chain();
		const g = graphOf(null, body);
		expect(insertOnWire(body, g, wireOf(g, 's:draft:n1', 'op:draft:n3'), { kind: 'pickSamples' })).toEqual({ ok: false, reason: NO_FIT, locked: false });
		expect(insertOnWire(body, g, 'nope', turning)).toMatchObject({ ok: false });
	});

	it('an operation that works in place on its sample: the new operation goes in front, the pass goes on working on what it makes', () => {
		const body = run([{ type: 'addSample' }, { type: 'addPass', sample: { key: 'n1' }, values: { method_id: 'mm' } }]);
		const g = graphOf(null, body);
		const after = run(done(insertOnWire(body, g, wireOf(g, 's:draft:n1', 'op:draft:n3'), turning)), body);
		expect(after.wires.some((w) => w.from.key === 'n1' && w.to.key === 'n2')).toBe(false);
		expect(after.wires.some((w) => w.to.key === 'n2' && w.from.key !== 'n1')).toBe(true);
	});
});

/** s1 (done) -> o1 (done) -> s2 (done); s1 -> o2 (planned) -> s3 (planned). Saved records only. */
const history = (): ProcessData =>
	mkData({
		samples: [mkSample('s1', { status: 'active' }), mkSample('s2', { status: 'active' }), mkSample('s3', { status: 'planned' })],
		operations: [
			mkOp({ id: 'o1', sampleId: 's1', outputSampleId: 's2', methodName: 'Cut', date: '2026-09-01T09:00:00Z' }),
			mkOp({ id: 'o2', sampleId: 's1', outputSampleId: 's3', methodName: 'Cut', workState: 'planned' }),
		],
	});

describe('wires of saved records are not touched', () => {
	it('a done wire says why, and locks', () => {
		const g = graphOf(history(), emptyBody());
		expect(insertOnWire(emptyBody(), g, wireOf(g, 's:s1', 'op:o1'), turning)).toEqual({ ok: false, reason: DONE_WIRE, locked: true });
	});

	it('a planned record\'s wire is saved too: remove the record instead', () => {
		const g = graphOf(history(), emptyBody());
		expect(insertOnWire(emptyBody(), g, wireOf(g, 's:s1', 'op:o2'), turning)).toEqual({ ok: false, reason: SAVED_WIRE, locked: false });
	});
});

describe('insert before and after a selected card', () => {
	const sampleNode = (g: ProcessGraph, id: string) => node(g, `s:${id}`) as RecordNode;

	it('before a new sample something makes: on the wire that makes it', () => {
		const body = chain();
		const g = graphOf(null, body);
		const after = run(done(insertAround({ body, graph: g, node: sampleNode(g, 'draft:n4'), where: 'before', choice: turning })), body);
		expect(wiresText(after)).toEqual(['n1>n2.0', 'n2.0>n5', 'n5>n6.0', 'n6.0>n4']);
	});

	it('before a new sample nothing makes: an operation makes it, with a new sample going in', () => {
		const body = run([{ type: 'addSample' }]);
		const g = graphOf(null, body);
		const after = run(done(insertAround({ body, graph: g, node: sampleNode(g, 'draft:n1'), where: 'before', choice: turning })), body);
		expect(kinds(after)).toEqual(['n1:sample', 'n2:operation', 'n4:sample']);
		expect(wiresText(after)).toEqual(['n2.0>n1', 'n4>n2.0']);
	});

	it('before a planned sample that exists is refused up front: its history is recorded', () => {
		const data = mkData({ samples: [mkSample('s4', { status: 'planned' })] });
		const body = run([{ type: 'addExistingSamples', samples: [{ id: 's4', version: 1 }] }]);
		const g = graphOf(data, body);
		expect(insertAround({ body, graph: g, node: sampleNode(g, 's4'), where: 'before', choice: turning })).toEqual({ ok: false, reason: BEFORE_RECORDED, locked: true });
		// Not even in the draft yet: the same answer, nothing to add first.
		const g0 = graphOf(data, emptyBody());
		expect(insertAround({ body: emptyBody(), graph: g0, node: sampleNode(g0, 's4'), where: 'before', choice: turning })).toEqual({ ok: false, reason: BEFORE_RECORDED, locked: true });
	});

	it('before a DONE sample is refused with the one reason, whatever is chosen and whether or not it is in the draft; nothing is planned', () => {
		const body = run([{ type: 'addExistingSamples', samples: [{ id: 's2', version: 1 }] }]);
		const g = graphOf(history(), body);
		const s2 = sampleNode(g, 's2');
		expect(BEFORE_RECORDED).toBe("Its history is recorded and can't change from the map. Start from a new sample instead.");
		expect(insertAround({ body, graph: g, node: s2, where: 'before', choice: turning })).toEqual({ ok: false, reason: BEFORE_RECORDED, locked: true });
		expect(insertAround({ body, graph: g, node: s2, where: 'before', choice: { kind: 'newSample' } })).toEqual({ ok: false, reason: BEFORE_RECORDED, locked: true });
		const g0 = graphOf(history(), emptyBody());
		expect(insertAround({ body: emptyBody(), graph: g0, node: sampleNode(g0, 's2'), where: 'before', choice: turning })).toEqual({ ok: false, reason: BEFORE_RECORDED, locked: true });
	});

	it('insertBeforeRefusal: a sample that is a record (done or planned) is refused; a new sample, a container and a junction are not', () => {
		const g = graphOf(history(), emptyBody());
		expect(insertBeforeRefusal(sampleNode(g, 's2'))).toBe(BEFORE_RECORDED);
		expect(insertBeforeRefusal(node(g, 'op:o1'))).toBeNull();
		const fresh = chain();
		const gf = graphOf(null, fresh);
		expect(insertBeforeRefusal(sampleNode(gf, 'draft:n4'))).toBeNull();
		const gp = graphOf(mkData({ samples: [mkSample('s4', { status: 'planned' })] }), emptyBody());
		expect(insertBeforeRefusal(sampleNode(gp, 's4'))).toBe(BEFORE_RECORDED);
	});

	it('after a sample with one outgoing wire: between them', () => {
		const body = chain();
		const g = graphOf(null, body);
		const after = run(done(insertAround({ body, graph: g, node: sampleNode(g, 'draft:n1'), where: 'after', choice: turning })), body);
		expect(wiresText(after)).toEqual(['n1>n5.0', 'n2.0>n4', 'n5.0>n7', 'n7>n2.0']);
	});

	it('after a sample nothing leaves: an operation it feeds; after a done sample too (a new branch)', () => {
		const body = run([{ type: 'addSample' }]);
		const g = graphOf(null, body);
		const after = run(done(insertAround({ body, graph: g, node: sampleNode(g, 'draft:n1'), where: 'after', choice: turning })), body);
		expect(wiresText(after)).toEqual(['n1>n2.0']);
		const b2 = run([{ type: 'addExistingSamples', samples: [{ id: 's2', version: 1 }] }]);
		const g2 = graphOf(history(), b2);
		const branch = run(done(insertAround({ body: b2, graph: g2, node: sampleNode(g2, 's2'), where: 'after', choice: turning })), b2);
		expect(wiresText(branch)).toEqual(['n1>n2.0']);
	});

	it('after an operation that makes nothing yet: a new sample comes out of it and the operation works on that', () => {
		const body = run([{ type: 'addSample' }, { type: 'addContainer', kind: 'operation', source: { from: 'blank' }, from: { key: 'n1' } }]);
		const g = graphOf(null, body);
		const after = run(done(insertAround({ body, graph: g, node: node(g, 'op:draft:n3'), where: 'after', choice: turning })), body);
		expect(wiresText(after)).toEqual(['n1>n2.0', 'n2.0>n4', 'n4>n5.0']);
	});

	it('before an operation nothing feeds: a new operation makes a new sample that feeds it', () => {
		const body = run([{ type: 'addContainer', kind: 'operation', source: { from: 'blank' } }]);
		const g = graphOf(null, body);
		const after = run(done(insertAround({ body, graph: g, node: node(g, 'op:draft:n2'), where: 'before', choice: turning })), body);
		expect(wiresText(after)).toEqual(['n3.0>n5', 'n5>n1.0']);
		expect(after.wires).toHaveLength(2);
		expect(after.items.map((i) => i.kind)).toEqual(['operation', 'operation', 'sample']);
	});

	it('before an operation with one input: on that wire; after a test: nothing comes out of it', () => {
		const body = run([{ type: 'addSample' }, { type: 'addContainer', kind: 'test', source: { from: 'blank', testType: 'xrd' }, from: { key: 'n1' } }]);
		const g = graphOf(null, body);
		const t = node(g, 'test:draft:n2');
		const before = run(done(insertAround({ body, graph: g, node: t, where: 'before', choice: turning })), body);
		expect(before.wires.some((w) => w.from.key === 'n1' && w.to.key === 'n2')).toBe(false);
		expect(insertAround({ body, graph: g, node: t, where: 'after', choice: turning })).toEqual({ ok: false, reason: TEST_AFTER, locked: false });
	});

	it('a saved operation is not changed from the map: its reason, with the lock when it is done', () => {
		const g = graphOf(history(), emptyBody());
		expect(insertAround({ body: emptyBody(), graph: g, node: node(g, 'op:o1'), where: 'before', choice: turning })).toEqual({ ok: false, reason: DONE_WIRE, locked: true });
		expect(insertAround({ body: emptyBody(), graph: g, node: node(g, 'op:o2'), where: 'after', choice: turning })).toEqual({ ok: false, reason: SAVED_WIRE, locked: false });
	});

	it('a sample the draft does not hold yet is the page\'s to add first', () => {
		const g = graphOf(history(), emptyBody());
		expect(insertAround({ body: emptyBody(), graph: g, node: node(g, 's:s1') as RecordNode, where: 'after', choice: turning })).toMatchObject({ ok: false });
	});
});

describe('after a sample whose one outgoing wire is done', () => {
	it('falls back to a new branch (an operation it feeds), as a sample with none or several already does', () => {
		const data = mkData({ samples: [mkSample('s1', { status: 'active' }), mkSample('s2', { status: 'active' })], operations: [mkOp({ id: 'o1', sampleId: 's1', outputSampleId: 's2', methodName: 'Cut', date: '2026-09-01T09:00:00Z' })] });
		const body = run([{ type: 'addExistingSamples', samples: [{ id: 's1', version: 1 }] }]);
		const g = graphOf(data, body);
		expect(g.wires.filter((w) => nodeOfSocket(w.from) === 's:s1')).toHaveLength(1);
		const after = run(done(insertAround({ body, graph: g, node: node(g, 's:s1') as RecordNode, where: 'after', choice: turning })), body);
		expect(wiresText(after)).toEqual(['n1>n2.0']);
		// Before it is refused whole: the wire that makes it is never changed.
		const b2 = run([{ type: 'addExistingSamples', samples: [{ id: 's2', version: 1 }] }]);
		const g2 = graphOf(data, b2);
		expect(insertAround({ body: b2, graph: g2, node: node(g2, 's:s2') as RecordNode, where: 'before', choice: turning })).toEqual({ ok: false, reason: BEFORE_RECORDED, locked: true });
	});
});

describe('a cut, and a stack of passes', () => {
	/** n1 sample cut into three pieces: one operation (n2) with three rows, all fed by n1. */
	const cut = (): DraftBody => run([{ type: 'addSample' }, { type: 'addContainer', kind: 'operation', source: { from: 'blank' }, from: { key: 'n1' } }, { type: 'addOutputRow', key: 'n2', share: true }, { type: 'addOutputRow', key: 'n2', share: true }]);
	const pass = { type: 'addPass', sample: { key: 'n1' }, values: { method_id: 'mm' } } as const;

	it('is one wire to the eye and one insert: the new operation makes a sample that feeds all three pieces', () => {
		const body = cut();
		expect(body.wires).toHaveLength(3);
		const g = graphOf(null, body);
		const wire = g.wires.find((w) => nodeOfSocket(w.to) === 'batch:draft:n2')!.id;
		const after = run(done(insertOnWire(body, g, wire, turning)), body);
		expect(wiresText(after)).toEqual(['n1>n6.0', 'n6.0>n8', 'n8>n2.0', 'n8>n2.1', 'n8>n2.2']);
		// One input stays shared; no piece was left on the old sample.
		expect(after.wires.filter((w) => w.from.key === 'n1')).toHaveLength(1);
	});

	it('insert before the cut card, without a wire in hand, does the same', () => {
		const body = cut();
		const g = graphOf(null, body);
		const after = run(done(insertAround({ body, graph: g, node: node(g, 'batch:draft:n2'), where: 'before', choice: turning })), body);
		expect(after.wires.filter((w) => w.to.key === 'n2').map((w) => w.from.key)).toEqual(['n8', 'n8', 'n8']);
	});

	it('a stack of passes says it is a stack (not "several wires meet here")', () => {
		const body = run([{ type: 'addSample' }, pass, pass, pass]);
		const g = graphOf(null, body);
		const wire = g.wires.find((w) => nodeOfSocket(w.to).startsWith('stack:'))!.id;
		expect(insertOnWire(body, g, wire, turning)).toEqual({ ok: false, reason: STACKED, locked: false });
		expect(insertAround({ body, graph: g, node: node(g, nodeOfSocket(g.wires.find((w) => nodeOfSocket(w.to).startsWith('stack:'))!.to)), where: 'before', choice: turning })).toEqual({ ok: false, reason: STACKED, locked: false });
	});

	it('after an in-place pass (or the last of a stack): the operation is wired to the pass itself, not to a sample (its way back already goes to one)', () => {
		const one = run([{ type: 'addSample' }, pass]);
		const g = graphOf(null, one);
		const after = run(done(insertAround({ body: one, graph: g, node: node(g, 'op:draft:n3'), where: 'after', choice: turning })), one);
		expect(wiresText(after)).toContain('n2.0>n4.0');
		expect(after.items.map((i) => i.kind)).toEqual(['sample', 'operation', 'operation']);
		const stack = run([{ type: 'addSample' }, pass, pass]);
		const gs = graphOf(null, stack);
		const stackNode = gs.nodes.find((n) => n.type === 'container')!;
		const s2 = run(done(insertAround({ body: stack, graph: gs, node: stackNode, where: 'after', choice: turning })), stack);
		expect(wiresText(s2)).toContain('n4.0>n6.0');
	});
});

describe('around a planned operation that already exists', () => {
	/** s1 (done) feeds o3, a planned operation that makes nothing yet (a saved record, not a draft one). */
	const planned = (): ProcessData => mkData({ samples: [mkSample('s1', { status: 'active' })], operations: [mkOp({ id: 'o3', sampleId: 's1', methodName: 'Cut', workState: 'planned' })] });
	const held = (): DraftBody => run([{ type: 'addExisting', kind: 'operation', record: { id: 'o3', version: 2 }, workState: 'planned' }]);

	it('is refused whichever side: the draft would write operation -> sample on a saved operation, which d1-build refuses', () => {
		const body = held();
		const g = graphOf(planned(), body);
		for (const where of ['before', 'after'] as const) {
			expect(insertAround({ body, graph: g, node: node(g, 'op:o3'), where, choice: turning })).toEqual({ ok: false, reason: SAVED_WIRE, locked: false });
		}
	});

	it('one struck through as "will be deleted" says so, and nothing is written', () => {
		const body = run([{ type: 'remove', key: 'n1', deleteRecord: true }], held());
		const g = graphOf(planned(), body);
		expect((node(g, 'op:o3') as { removing?: boolean }).removing).toBe(true);
		for (const where of ['before', 'after'] as const) {
			expect(insertAround({ body, graph: g, node: node(g, 'op:o3'), where, choice: turning })).toEqual({ ok: false, reason: ALREADY_GOING, locked: false });
		}
	});

	it('a planned sample struck through is not inserted around either', () => {
		const data = mkData({ samples: [mkSample('s4', { status: 'planned' })] });
		const body = run([{ type: 'addExistingSamples', samples: [{ id: 's4', version: 1 }] }, { type: 'remove', key: 'n1', deleteRecord: true }]);
		const g = graphOf(data, body);
		expect(insertAround({ body, graph: g, node: node(g, 's:s4') as RecordNode, where: 'after', choice: turning })).toEqual({ ok: false, reason: ALREADY_GOING, locked: false });
	});

	it('canInsertAround says no up front, with the reason, for it and for a container that is not in the draft', () => {
		const g = graphOf(history(), emptyBody());
		expect(insertRefusal(emptyBody(), node(g, 'op:o1'))).toEqual({ reason: DONE_WIRE, locked: true });
		expect(insertRefusal(emptyBody(), node(g, 'op:o2'))).toEqual({ reason: SAVED_WIRE, locked: false });
		const body = held();
		const gp = graphOf(planned(), body);
		expect(insertRefusal(body, node(gp, 'op:o3'))).toEqual({ reason: SAVED_WIRE, locked: false });
		const gone = run([{ type: 'remove', key: 'n1', deleteRecord: true }], body);
		expect(insertRefusal(gone, node(graphOf(planned(), gone), 'op:o3'))).toEqual({ reason: ALREADY_GOING, locked: false });
		// What can be inserted around: a new card, and a sample (a done one only after it: before it is refused by insertBeforeRefusal).
		const fresh = chain();
		const gf = graphOf(null, fresh);
		expect(insertRefusal(fresh, node(gf, 'op:draft:n3'))).toBeNull();
		expect(insertRefusal(fresh, node(gf, 's:draft:n1'))).toBeNull();
		expect(insertRefusal(emptyBody(), node(g, 's:s2'))).toBeNull();
	});
});
