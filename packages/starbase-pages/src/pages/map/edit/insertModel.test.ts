import { describe, expect, it } from 'vitest';
import type { DraftBody } from '@d1/ui';
import { buildGraph } from '../model/buildGraph';
import { groupBatches } from '../model/groupBatches';
import { mkData, mkOp, mkSample } from '../model/fixtures';
import { nodeOfSocket } from '../model/sockets';
import type { MapNode, ProcessData, ProcessGraph, RecordNode } from '../model/types';
import { apply, emptyBody, type DraftAction } from './draft';
import type { MenuChoice } from './menuModel';
import { DONE_WIRE, SAVED_WIRE } from './removal';
import { NO_FIT, SAMPLE_BETWEEN, TEST_AFTER, TEST_BETWEEN, earlierStep, insertAround, insertOnWire } from './insertModel';
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

	it('before a planned sample that exists: the draft refuses to give it a maker, and says so', () => {
		const data = mkData({ samples: [mkSample('s4', { status: 'planned' })] });
		const body = run([{ type: 'addExistingSamples', samples: [{ id: 's4', version: 1 }] }]);
		const g = graphOf(data, body);
		const v = insertAround({ body, graph: g, node: sampleNode(g, 's4'), where: 'before', choice: turning });
		expect(v).toMatchObject({ ok: false, reason: 'That sample already exists with its own history: it cannot be made by this operation.' });
	});

	it('before a DONE sample is never a new parent: an operation is refused, and Add an earlier step starts a chain upstream that is wired to nothing', () => {
		const body = run([{ type: 'addExistingSamples', samples: [{ id: 's2', version: 1 }] }]);
		const g = graphOf(history(), body);
		const s2 = sampleNode(g, 's2');
		expect(insertAround({ body, graph: g, node: s2, where: 'before', choice: turning })).toEqual({ ok: false, reason: DONE_WIRE, locked: true });
		const after = run(done(insertAround({ body, graph: g, node: s2, where: 'before', choice: { kind: 'earlierStep' } })), body);
		expect(kinds(after)).toEqual(['n1:sample', 'n2:sample', 'n3:operation', 'n5:sample']);
		expect(after.items.find((i) => i.key === 'n3')).toMatchObject({ workState: 'planned' });
		// Wired among the new things only; the done sample gets no wire.
		expect(wiresText(after)).toEqual(['n2>n3.0', 'n3.0>n5']);
		expect(after.items[0]).toMatchObject({ existing: { id: 's2' } });
	});

	it('Add an earlier step is only for a done sample before it', () => {
		const body = chain();
		const g = graphOf(null, body);
		expect(insertAround({ body, graph: g, node: sampleNode(g, 'draft:n4'), where: 'before', choice: { kind: 'earlierStep' } })).toMatchObject({ ok: false });
		const b2 = run([{ type: 'addExistingSamples', samples: [{ id: 's2', version: 1 }] }]);
		const g2 = graphOf(history(), b2);
		expect(insertAround({ body: b2, graph: g2, node: sampleNode(g2, 's2'), where: 'after', choice: { kind: 'earlierStep' } })).toMatchObject({ ok: false });
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

describe('Add an earlier step', () => {
	it('is a planned sample, an operation of no method yet that it feeds, and the sample that makes: three new items, two wires', () => {
		const v = earlierStep(emptyBody(), { x: 5, y: 6 });
		const body = run(done(v));
		expect(kinds(body)).toEqual(['n1:sample', 'n2:operation', 'n4:sample']);
		expect(wiresText(body)).toEqual(['n1>n2.0', 'n2.0>n4']);
		expect(body.positions.n1).toEqual({ x: 5, y: 6 });
	});
});
