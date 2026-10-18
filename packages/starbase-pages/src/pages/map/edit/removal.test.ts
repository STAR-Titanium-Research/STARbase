import { describe, expect, it } from 'vitest';
import type { DraftBody } from '@d1/ui';
import { buildGraph } from '../model/buildGraph';
import { groupBatches } from '../model/groupBatches';
import { mkData, mkOp, mkSample, mkTest } from '../model/fixtures';
import type { ContainerNode, MapNode, ProcessData, ProcessGraph, RecordNode } from '../model/types';
import { apply, emptyBody, type DraftAction } from './draft';
import { undo, redo, createHistory, push } from './history';
import {
	ALREADY_GOING, DONE_HANGS, DONE_LOCK, DONE_WIRE, NOT_REMOVABLE, SAVED_WIRE,
	dissolveVerdict, doneHangsOff, removeActions, removeVerdict, unwireActions, unwireVerdict,
} from './removal';
import { toGraph } from './toGraph';

const run = (actions: DraftAction[], from: DraftBody = emptyBody()): DraftBody => actions.reduce((b, a) => apply(b, a), from);
const graphOf = (data: ProcessData | null, body: DraftBody): ProcessGraph => {
	const d = toGraph(data, body);
	return buildGraph(d, groupBatches(d.operations, d.tests, { probable: false, stack: true }), { slots: () => [] });
};
const node = (g: ProcessGraph, id: string): MapNode => g.nodes.find((n) => n.id === id)!;
const sample = (g: ProcessGraph, id: string) => node(g, `s:${id}`) as RecordNode;
const box = (g: ProcessGraph, id: string) => node(g, id) as ContainerNode;
const inHistory = (ids: string[]) => ({ inHistory: (id: string) => ids.includes(id) });

/** s1 (done, active) → o1 (done cut) → s2 (done) ; s1 → o2 (planned cut) → s3 (planned); t1 planned test on s3. */
const history = (): ProcessData =>
	mkData({
		samples: [mkSample('s1', { status: 'active' }), mkSample('s2', { status: 'active' }), mkSample('s3', { status: 'planned' })],
		operations: [
			mkOp({ id: 'o1', sampleId: 's1', outputSampleId: 's2', methodName: 'Cut', date: '2026-09-01T09:00:00Z' }),
			mkOp({ id: 'o2', sampleId: 's1', outputSampleId: 's3', methodName: 'Cut', workState: 'planned' }),
		],
		tests: [mkTest({ id: 't1', subjectSampleIds: ['s3'], workState: 'planned' })],
	});

describe('removing a card', () => {
	it('a new sample vanishes, a new operation too', () => {
		const body = run([{ type: 'addSample' }, { type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'm' }, from: { key: 'n1' } }]);
		const g = graphOf(null, body);
		expect(removeVerdict(body, g, sample(g, 'draft:n1'), inHistory([]))).toEqual({ ok: true, keys: ['n1'], existing: [] });
		const v = removeVerdict(body, g, box(g, 'op:draft:n3'), inHistory([]));
		expect(v).toEqual({ ok: true, keys: ['n2'], existing: [] });
		const after = removeActions(body, v as never).reduce((b, a) => apply(b, a), body);
		expect(after.items.map((i) => i.key)).toEqual(['n1']);
		expect(after.wires).toEqual([]);
	});

	it('a done record is locked with its reason, whichever way it is asked for', () => {
		const g = graphOf(history(), emptyBody());
		const sv = removeVerdict(emptyBody(), g, sample(g, 's1'), inHistory(['s1']));
		expect(sv).toEqual({ ok: false, reason: DONE_LOCK, locked: true });
		expect(DONE_LOCK).toBe("Done records can't be removed from the map");
		expect(removeVerdict(emptyBody(), g, box(g, 'op:o1'), inHistory([]))).toEqual({ ok: false, reason: DONE_LOCK, locked: true });
		// Even once the draft holds it (it was built from).
		const body = run([{ type: 'addExistingSamples', samples: [{ id: 's1', version: 1 }] }]);
		expect(removeVerdict(body, graphOf(history(), body), sample(graphOf(history(), body), 's1'), inHistory(['s1']))).toMatchObject({ ok: false, locked: true });
	});

	it('a planned record that exists is deleted at Create: it goes to the draft marked, not out of the canvas', () => {
		const g = graphOf(history(), emptyBody());
		const v = removeVerdict(emptyBody(), g, box(g, 'op:o2'), inHistory([]));
		expect(v).toEqual({ ok: true, keys: [], existing: [{ kind: 'operation', id: 'o2' }] });
		// removeActions needs the record in the draft first (the page adds it).
		expect(removeActions(emptyBody(), v as never)).toEqual([]);
		const body = run([{ type: 'addExisting', kind: 'operation', record: { id: 'o2', version: 3 }, workState: 'planned' }]);
		const acts = removeActions(body, v as never);
		expect(acts).toEqual([{ type: 'remove', key: 'n1', deleteRecord: true }]);
		const after = acts.reduce((b, a) => apply(b, a), body);
		expect(after.items[0]).toMatchObject({ existing: { id: 'o2' }, remove: true });
		expect(removeVerdict(after, graphOf(history(), after), box(graphOf(history(), after), 'op:o2'), inHistory([]))).toEqual({ ok: false, reason: ALREADY_GOING, locked: false });
	});

	it('a planned sample with a planned test on it can be deleted (what hangs off it is planned: the server says to remove that too)', () => {
		const g = graphOf(history(), emptyBody());
		expect(removeVerdict(emptyBody(), g, sample(g, 's3'), inHistory(['s3']))).toEqual({ ok: true, keys: [], existing: [{ kind: 'sample', id: 's3' }] });
	});

	it('a planned sample with only planned work after it can be deleted', () => {
		const data = mkData({ samples: [mkSample('s1'), mkSample('s3', { status: 'planned' })], operations: [mkOp({ id: 'o2', sampleId: 's1', outputSampleId: 's3', workState: 'planned' })] });
		const g = graphOf(data, emptyBody());
		expect(removeVerdict(emptyBody(), g, sample(g, 's3'), inHistory(['s3']))).toEqual({ ok: true, keys: [], existing: [{ kind: 'sample', id: 's3' }] });
		const t = mkData({ samples: [mkSample('s1')], tests: [mkTest({ id: 't1', subjectSampleIds: ['s1'], workState: 'planned' })] });
		const gt = graphOf(t, emptyBody());
		expect(removeVerdict(emptyBody(), gt, box(gt, 'test:t1'), inHistory([]))).toEqual({ ok: true, keys: [], existing: [{ kind: 'test', id: 't1' }] });
	});

	it('a planned record something done hangs off is locked', () => {
		const data = mkData({
			samples: [mkSample('s1'), mkSample('s3', { status: 'planned' })],
			operations: [
				mkOp({ id: 'o2', sampleId: 's1', outputSampleId: 's3', workState: 'planned' }),
				mkOp({ id: 'o9', sampleId: 's3', outputSampleId: null, methodName: 'Polish', date: '2026-09-09T09:00:00Z' }),
			],
		});
		const g = graphOf(data, emptyBody());
		expect(doneHangsOff(g, box(g, 'op:o2'))).toBe(true);
		expect(removeVerdict(emptyBody(), g, box(g, 'op:o2'), inHistory([]))).toEqual({ ok: false, reason: DONE_HANGS, locked: true });
		expect(removeVerdict(emptyBody(), g, sample(g, 's3'), inHistory(['s3']))).toEqual({ ok: false, reason: DONE_HANGS, locked: true });
	});

	it('an existing sample the draft only picked from the index is taken off: the record is untouched', () => {
		const body = run([{ type: 'addExistingSamples', samples: [{ id: 'far', version: 1 }] }]);
		const g = graphOf(mkData({ samples: [mkSample('s1')] }), body);
		expect(removeVerdict(body, g, sample(g, 'far'), inHistory(['s1']))).toEqual({ ok: true, keys: ['n1'], existing: [] });
	});

	it('an existing operation the draft attached is taken off: its wiring goes, the record stays, even a done one', () => {
		const data = mkData({ samples: [mkSample('s1'), mkSample('made')], operations: [mkOp({ id: 'fast', sampleId: null, outputSampleId: 'made', methodName: 'FAST', date: '2026-09-01T09:00:00Z' })] });
		const body = run([
			{ type: 'addExistingSamples', samples: [{ id: 's1', version: 1 }] },
			{ type: 'attach', operation: { id: 'fast', version: 7 }, workState: 'done', from: { key: 'n1' } },
		]);
		const g = graphOf(data, body);
		expect(removeVerdict(body, g, box(g, 'op:fast'), inHistory(['s1', 'made']))).toEqual({ ok: true, keys: ['n2'], existing: [] });
	});

	it('a stack made of a recorded planned pass and a draft pass: the first Delete takes the draft pass only, a second takes the recorded one (deleted at Create)', () => {
		const data = mkData({
			samples: [mkSample('s1')],
			operations: [mkOp({ id: 'a', sampleId: 's1', outputSampleId: null, methodId: 'turn', methodName: 'Turning', category: 'machining', equipmentId: 'lathe', workState: 'planned', date: '2026-09-01T09:00:00Z' })],
		});
		const body = run([{ type: 'addPass', sample: { id: 's1', version: 1 }, values: { method_id: 'turn', equipment_id: 'lathe' }, workState: 'planned' }]);
		const g = graphOf(data, body);
		const stack = g.nodes.find((n): n is ContainerNode => n.type === 'container' && !!n.stacked);
		expect(stack).toBeDefined();
		const first = removeVerdict(body, g, stack, inHistory(['s1']));
		expect(first).toEqual({ ok: true, keys: ['n2'], existing: [] });
		// What is left is the recorded pass alone, which the next Delete deletes.
		const after = removeActions(body, first as never).reduce((b, a) => apply(b, a), body);
		const g2 = graphOf(data, after);
		expect(removeVerdict(after, g2, box(g2, 'op:a'), inHistory(['s1']))).toEqual({ ok: true, keys: [], existing: [{ kind: 'operation', id: 'a' }] });
	});

	it('a stack of a draft pass and DONE recorded passes: the draft pass goes, nothing done is touched', () => {
		const data = mkData({
			samples: [mkSample('s1')],
			operations: [mkOp({ id: 'a', sampleId: 's1', outputSampleId: null, methodId: 'turn', methodName: 'Turning', category: 'machining', equipmentId: 'lathe', date: '2026-09-01T09:00:00Z' })],
		});
		const body = run([{ type: 'addPass', sample: { id: 's1', version: 1 }, values: { method_id: 'turn', equipment_id: 'lathe' }, workState: 'planned' }]);
		const g = graphOf(data, body);
		const stack = g.nodes.find((n): n is ContainerNode => n.type === 'container' && !!n.stacked);
		if (stack) expect(removeVerdict(body, g, stack, inHistory(['s1']))).toEqual({ ok: true, keys: ['n2'], existing: [] });
	});

	it('cards that are not samples, operations or tests are not removable, and nothing selected is nothing', () => {
		const data = mkData({ samples: [mkSample('s1', { materialRef: { collection: 'materials', id: 'm', code: 'Ti' } })] });
		const g = graphOf(data, emptyBody());
		const mat = g.nodes.find((n) => n.type === 'record' && n.kind === 'material');
		expect(removeVerdict(emptyBody(), g, mat, inHistory([]))).toEqual({ ok: false, reason: NOT_REMOVABLE, locked: false });
		expect(removeVerdict(emptyBody(), g, undefined, inHistory([]))).toMatchObject({ ok: false });
	});
});

describe('removing a wire', () => {
	const built = () =>
		run([
			{ type: 'addSample' },
			{ type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'm' }, from: { key: 'n1' } },
			{ type: 'addSample', from: { key: 'n2', row: 0 } },
		]);

	it('a wire of the draft goes', () => {
		const body = built();
		const g = graphOf(null, body);
		const into = g.wires.find((w) => w.to.startsWith('op:draft:n3:in'))!;
		const v = unwireVerdict(body, g, into.id);
		expect(v).toEqual({ ok: true, wires: [{ from: { key: 'n1' }, to: { key: 'n2', row: 0 } }], rows: [] });
		const after = unwireActions(v as never).reduce((b, a) => apply(b, a), body);
		expect(after.wires).toEqual([{ from: { key: 'n2', row: 0 }, to: { key: 'n4' } }]);
		const out = g.wires.find((w) => w.from.startsWith('op:draft:n3:out'))!;
		const vo = unwireVerdict(body, g, out.id);
		expect(vo).toEqual({ ok: true, wires: [{ from: { key: 'n2', row: 0 }, to: { key: 'n4' } }], rows: [] });
	});

	it('the way back to the sample goes with the way in (an operation in place on it)', () => {
		const body = run([{ type: 'addSample' }, { type: 'addPass', sample: { key: 'n1' }, values: {} }]);
		expect(body.wires).toHaveLength(2);
		const g = graphOf(null, body);
		const into = g.wires.find((w) => w.to.includes('draft:n3'))!;
		const v = unwireVerdict(body, g, into.id);
		expect(v.ok).toBe(true);
		if (v.ok) expect(unwireActions(v).reduce((b, a) => apply(b, a), body).wires).toEqual([]);
	});

	it('a wire from a done sample to a planned operation is the planned record\'s, not done wiring', () => {
		const g = graphOf(history(), emptyBody());
		const w = g.wires.find((x) => x.to.startsWith('op:o2'))!;
		expect(unwireVerdict(emptyBody(), g, w.id)).toMatchObject({ ok: false, locked: false });
	});

	it('a wire of done records is refused with the lock', () => {
		const g = graphOf(history(), emptyBody());
		const done = g.wires.find((w) => w.to.startsWith('op:o1'))!;
		expect(unwireVerdict(emptyBody(), g, done.id)).toEqual({ ok: false, reason: DONE_WIRE, locked: true });
	});

	it('a wire of planned records that are saved is refused: remove the record instead', () => {
		const g = graphOf(history(), emptyBody());
		const planned = g.wires.find((w) => w.from.startsWith('op:o2'))!;
		expect(unwireVerdict(emptyBody(), g, planned.id)).toEqual({ ok: false, reason: SAVED_WIRE, locked: false });
	});

	it('a wire that is not drawn any more says so', () => {
		expect(unwireVerdict(emptyBody(), graphOf(history(), emptyBody()), 'nope')).toMatchObject({ ok: false, locked: false });
	});
});

describe('dissolve', () => {
	/** s1 (existing) → cut (n2) → made (n4) → polish (n5, row n6) → polished (n7). */
	const chain = (): DraftBody =>
		run([
			{ type: 'addSample', values: { material_id: 'ti' } },
			{ type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'cut' }, from: { key: 'n1' } },
			{ type: 'addSample', from: { key: 'n2', row: 0 } },
			{ type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'pol' }, from: { key: 'n4' } },
			{ type: 'addSample', from: { key: 'n5', row: 0 } },
		]);

	it('removes the operation and its output sample and wires the input straight to what came next', () => {
		const body = chain();
		const g = graphOf(null, body);
		const v = dissolveVerdict(body, g, box(g, 'op:draft:n3'));
		expect(v.ok).toBe(true);
		if (!v.ok) return;
		const after = v.actions.reduce((b, a) => apply(b, a), body);
		expect(after.items.map((i) => i.key)).toEqual(['n1', 'n5', 'n7']);
		expect(after.wires).toEqual([
			{ from: { key: 'n5', row: 0 }, to: { key: 'n7' } },
			{ from: { key: 'n1' }, to: { key: 'n5', row: 0 } },
		]);
	});

	it('is one undoable step: undo brings the operation, its output and the wires back, redo takes them away again', () => {
		const body = chain();
		const g = graphOf(null, body);
		const v = dissolveVerdict(body, g, box(g, 'op:draft:n3'));
		if (!v.ok) throw new Error('expected a dissolve');
		const after = v.actions.reduce((b, a) => apply(b, a), body);
		let h = push(createHistory(body), after);
		h = undo(h);
		expect(h.present).toBe(body);
		expect(h.present.items.map((i) => i.key)).toEqual(['n1', 'n2', 'n4', 'n5', 'n7']);
		h = redo(h);
		expect(h.present).toBe(after);
	});

	it('an operation that leaves its sample in place is simply taken out', () => {
		const body = run([{ type: 'addSample' }, { type: 'addPass', sample: { key: 'n1' }, values: {} }]);
		const g = graphOf(null, body);
		const c = g.nodes.find((n): n is ContainerNode => n.type === 'container')!;
		const v = dissolveVerdict(body, g, c);
		expect(v.ok).toBe(true);
		if (v.ok) expect(v.actions.reduce((b, a) => apply(b, a), body).items.map((i) => i.key)).toEqual(['n1']);
	});

	it('a stack of passes goes as a whole', () => {
		const body = run([{ type: 'addSample' }, { type: 'addPass', sample: { key: 'n1' }, values: { method_id: 'turn', equipment_id: 'l' } }, { type: 'addPass', sample: { key: 'n1' }, values: { method_id: 'turn', equipment_id: 'l' } }]);
		const g = graphOf(null, body);
		const stack = g.nodes.find((n): n is ContainerNode => n.type === 'container' && !!n.stacked)!;
		const v = dissolveVerdict(body, g, stack);
		expect(v.ok).toBe(true);
		if (v.ok) expect(v.actions.reduce((b, a) => apply(b, a), body).items.map((i) => i.key)).toEqual(['n1']);
	});

	it('explains why not: a test, no input, more than one output, an input that is not a sample, a record that exists', () => {
		const tested = run([{ type: 'addSample' }, { type: 'addContainer', kind: 'test', source: { from: 'blank', testType: 't' }, from: { key: 'n1' } }]);
		const gt = graphOf(null, tested);
		expect(dissolveVerdict(tested, gt, box(gt, 'test:draft:n2'))).toMatchObject({ ok: false, locked: false });

		const lonely = run([{ type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'm' } }]);
		const gl = graphOf(null, lonely);
		expect(dissolveVerdict(lonely, gl, box(gl, 'op:draft:n2'))).toMatchObject({ ok: false, reason: expect.stringContaining('sample going in') });

		const cut = run([{ type: 'addSample' }, { type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'm' }, rows: 3, from: { key: 'n1' } }]);
		const gc = graphOf(null, cut);
		const c = gc.nodes.find((n): n is ContainerNode => n.type === 'container')!;
		expect(dissolveVerdict(cut, gc, c)).toMatchObject({ ok: false, reason: expect.stringContaining('3 outputs') });

		const g = graphOf(history(), emptyBody());
		expect(dissolveVerdict(emptyBody(), g, box(g, 'op:o1'))).toEqual({ ok: false, reason: DONE_LOCK, locked: true });
		expect(dissolveVerdict(emptyBody(), g, box(g, 'op:o2'))).toMatchObject({ ok: false, locked: false });
		expect(dissolveVerdict(emptyBody(), g, sample(g, 's1'))).toMatchObject({ ok: false });
		expect(dissolveVerdict(emptyBody(), g, undefined)).toMatchObject({ ok: false });
	});

	it('an output that feeds two things is not dissolved', () => {
		const body = run([
			{ type: 'addSample' },
			{ type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'm' }, from: { key: 'n1' } },
			{ type: 'addSample', from: { key: 'n2', row: 0 } },
			{ type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'm' }, from: { key: 'n4' } },
			{ type: 'addContainer', kind: 'test', source: { from: 'blank', testType: 't' }, from: { key: 'n4' } },
		]);
		const g = graphOf(null, body);
		// Both the polish and the test hang off the made sample: they are both wired to the input afterwards.
		const v = dissolveVerdict(body, g, box(g, 'op:draft:n3'));
		expect(v.ok).toBe(true);
		if (v.ok) {
			const after = v.actions.reduce((b, a) => apply(b, a), body);
			expect(after.wires.filter((w) => w.from.key === 'n1')).toHaveLength(2);
		}
	});
});

describe('a wire taken off a piece of a cut', () => {
	const cut = () =>
		run([
			{ type: 'addSample' },
			{ type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'm' }, rows: 2, from: { key: 'n1' } },
			{ type: 'addSample', from: { key: 'n2', row: 0 } },
			{ type: 'addSample', from: { key: 'n2', row: 1 } },
		]);
	/** What taking off the drawn wire that ends on a socket (the card's id as a prefix: `s:draft:n6:in`) does. */
	const into = (body: DraftBody, socket: string) => {
		const g = graphOf(null, body);
		const wire = g.wires.find((w) => w.to.startsWith(socket));
		return wire ? unwireVerdict(body, g, wire.id) : ({ ok: false, reason: 'no such wire', locked: false } as const);
	};

	it('takes the piece with it: a socket nothing leaves is not kept', () => {
		const body = cut();
		const v = into(body, 's:draft:n6:in');
		expect(v).toMatchObject({ ok: true, rows: [{ key: 'n2', row: 1 }] });
		if (!v.ok) return;
		const after = unwireActions(v).reduce((b, a) => apply(b, a), body);
		const op = after.items.find((i) => i.key === 'n2') as { rows: unknown[] };
		expect(op.rows).toHaveLength(1);
		expect(after.wires).toEqual([
			{ from: { key: 'n1' }, to: { key: 'n2', row: 0 } },
			{ from: { key: 'n2', row: 0 }, to: { key: 'n5' } },
		]);
		// One undo step brings the piece, its input and its output wire back.
		let h = push(createHistory(body), after);
		h = undo(h);
		expect(h.present).toBe(body);
	});

	it('never takes the last piece, and an operation of one piece keeps its row', () => {
		const body = cut();
		const first = into(body, 's:draft:n6:in');
		const afterFirst = unwireActions(first as never).reduce((b, a) => apply(b, a), body);
		expect(into(afterFirst, 's:draft:n5:in')).toMatchObject({ ok: true, rows: [] });
		const single = run([{ type: 'addSample' }, { type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'm' }, from: { key: 'n1' } }, { type: 'addSample', from: { key: 'n2', row: 0 } }]);
		expect(into(single, 's:draft:n4:in')).toMatchObject({ ok: true, rows: [] });
	});

	it('an input wire taken off does not take the piece: it still has its output', () => {
		expect(into(cut(), 'batch:draft:n2:in')).toMatchObject({ ok: true, rows: [] });
	});

	/** n1 feeds row 0 of the operation; n2 is a second sample of its own, the input of row 1 (one more sample in a batch); each row makes a sample. */
	const batch = () =>
		run([
			{ type: 'addSample' },
			{ type: 'addSample' },
			{ type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'm' }, from: { key: 'n1' } },
			{ type: 'addOutputRow', key: 'n3', share: false },
			{ type: 'wire', from: { key: 'n2' }, to: { key: 'n3', row: 1 } },
			{ type: 'addSample', from: { key: 'n3', row: 0 } },
			{ type: 'addSample', from: { key: 'n3', row: 1 } },
		]);

	it('a row that has an input sample of its own is kept when its output goes: it carries on as an operation on that sample (finding 5)', () => {
		const body = batch();
		expect(body.wires).toContainEqual({ from: { key: 'n2' }, to: { key: 'n3', row: 1 } });
		const v = into(body, 's:draft:n7:in');
		expect(v).toMatchObject({ ok: true, rows: [] });
		if (!v.ok) return;
		const after = unwireActions(v).reduce((b, a) => apply(b, a), body);
		expect((after.items.find((i) => i.key === 'n3') as { rows: unknown[] }).rows).toHaveLength(2);
		expect(after.wires, 'its own input sample is still wired to it').toContainEqual({ from: { key: 'n2' }, to: { key: 'n3', row: 1 } });
	});

	it('taking away the sample a piece of a cut made takes the piece too; the row of a batch with an input of its own stays (finding 9)', () => {
		const c = cut();
		const g = graphOf(null, c);
		const v = removeVerdict(c, g, sample(g, 'draft:n6'), inHistory([]));
		expect(v).toEqual({ ok: true, keys: ['n6'], existing: [] });
		const acts = removeActions(c, v as never);
		expect(acts).toEqual([{ type: 'remove', key: 'n6' }, { type: 'removeRow', key: 'n2', row: 1 }]);
		const after = acts.reduce((b, a) => apply(b, a), c);
		expect((after.items.find((i) => i.key === 'n2') as { rows: unknown[] }).rows).toHaveLength(1);
		const b = batch();
		const gb = graphOf(null, b);
		const vb = removeVerdict(b, gb, sample(gb, 'draft:n7'), inHistory([]));
		expect(removeActions(b, vb as never)).toEqual([{ type: 'remove', key: 'n7' }]);
	});
});
