import { describe, expect, it } from 'vitest';
import type { DraftBody } from '@d1/ui';
import { buildGraph } from '../model/buildGraph';
import { groupBatches } from '../model/groupBatches';
import { mkData, mkOp, mkSample, mkTest } from '../model/fixtures';
import type { ContainerNode, ProcessData, ProcessGraph, RecordNode } from '../model/types';
import { apply, emptyBody, type DraftAction } from './draft';
import { draftId, draftKeyOf, emptyData, toGraph, type ToGraphCtx } from './toGraph';

const run = (actions: DraftAction[], from: DraftBody = emptyBody()) => actions.reduce((b, a) => apply(b, a), from);
const slots = () => [];
const draw = (data: ProcessData): ProcessGraph => buildGraph(data, groupBatches(data.operations, data.tests, { probable: false, stack: true }), { slots });
const node = (g: ProcessGraph, id: string) => g.nodes.find((n) => n.id === id);
const container = (g: ProcessGraph, id: string) => node(g, id) as ContainerNode;
const record = (g: ProcessGraph, id: string) => node(g, id) as RecordNode;
const wire = (g: ProcessGraph, from: string, to: string) => g.wires.find((w) => w.from === from && w.to === to);

const ctx: ToGraphCtx = {
	alloyCode: (m) => ({ ti: 'Ti64' })[m],
	methodCode: (m) => ({ mc: 'MC', turn: 'TU' })[m],
	methods: { mc: { name: 'Wire cut', category: 'machining' }, turn: { name: 'Turning', category: 'machining' } },
	testTypes: { tensile: { name: 'Tensile', category: 'destructive' } },
	today: new Date(2026, 9, 14, 12),
};

describe('toGraph', () => {
	it('a blank canvas with one new sample draws one draft card', () => {
		const body = run([{ type: 'addSample', values: { material_id: 'ti', form: 'disc', sample_code: '{seq}-Ti64-MC-2026-10-14', diameter_mm: 20 } }]);
		const data = toGraph(null, body, ctx);
		expect(data.samples).toEqual([
			{ id: 'draft:n1', code: '?-Ti64-MC-2026-10-14', nickname: null, form: 'disc', status: null, projectId: null, materialRef: { collection: 'materials', id: 'ti', code: 'Ti64' }, facts: { Diameter: '20 mm' }, draft: true },
		]);
		expect(data.focus).toMatchObject({ id: 'draft:n1', kind: 'sample' });
		const g = draw(data);
		expect(g.nodes.map((n) => n.id)).toEqual(['s:draft:n1', 'm:draft:n1']);
		expect(record(g, 's:draft:n1').draft).toBe(true);
	});

	it('an empty draft on an empty canvas draws nothing', () => {
		const data = toGraph(null, emptyBody(), ctx);
		expect(data).toEqual(emptyData());
		expect(draw(data).nodes).toEqual([]);
	});

	it('does not change the loaded data or the draft', () => {
		const loaded = mkData({ samples: [mkSample('s1')] });
		const body = run([{ type: 'addExistingSamples', samples: [{ id: 's1', version: 1 }] }, { type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'mc' }, from: { key: 'n1' } }]);
		const before = JSON.stringify([loaded, body]);
		const out = toGraph(loaded, body, ctx);
		expect(JSON.stringify([loaded, body])).toBe(before);
		expect(out).not.toBe(loaded);
		expect(loaded.operations).toEqual([]);
		expect(out.operations).toHaveLength(1);
	});

	it('a planned operation on a loaded sample: a draft, planned container wired from the sample', () => {
		const loaded = mkData({ samples: [mkSample('s1')] });
		const body = run([
			{ type: 'addExistingSamples', samples: [{ id: 's1', version: 1 }] },
			{ type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'turn' }, from: { key: 'n1' } },
			{ type: 'setValues', key: 'n2', values: { equipment_id: 'lathe', planned_date: '2026-11-02', machining_feed_mm_per_rev: 0.1 } },
		]);
		const data = toGraph(loaded, body, ctx);
		expect(data.samples.map((s) => s.id)).toEqual(['s1']); // the loaded sample is not added again
		expect(data.operations[0]).toMatchObject({
			id: 'draft:n3', methodId: 'turn', methodName: 'Turning', category: 'machining', sampleId: 's1', outputSampleId: null,
			equipmentId: 'lathe', date: '2026-11-02', workState: 'planned', plannedDate: '2026-11-02', draft: true, settings: { machining_feed_mm_per_rev: 0.1 },
		});
		const g = draw(data);
		const c = container(g, 'op:draft:n3');
		expect(c).toMatchObject({ draft: true, planned: true, title: 'Turning', settings: [{ label: 'Feed', value: '0.1 mm/rev' }] });
		expect(c.rows[0]).toMatchObject({ inPlace: true });
		expect(wire(g, 's:s1:out:0', c.rows[0].in!)).toBeDefined();
	});

	it('a cut with four rows and four new samples: one container, four outputs, planned samples', () => {
		let body = run([
			{ type: 'addExistingSamples', samples: [{ id: 'disc', version: 1 }] },
			{ type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'mc' }, from: { key: 'n1' } },
		]);
		for (let i = 0; i < 3; i += 1) body = apply(body, { type: 'addOutputRow', key: 'n2' });
		for (let row = 0; row < 4; row += 1) body = apply(body, { type: 'addSample', from: { key: 'n2', row } });
		const data = toGraph(mkData({ samples: [mkSample('disc')] }), body, ctx);
		expect(data.operations).toHaveLength(4);
		expect(data.operations.every((o) => o.batchId === 'draft:n2' && o.sampleId === 'disc')).toBe(true);
		expect(data.operations.map((o) => o.outputSampleId)).toEqual(['draft:n7', 'draft:n8', 'draft:n9', 'draft:n10']);
		const g = draw(data);
		const cut = container(g, 'batch:draft:n2');
		expect(cut.rows).toHaveLength(4);
		expect(cut.group.rowIds).toHaveLength(4);
		for (const out of ['draft:n7', 'draft:n8', 'draft:n9', 'draft:n10']) {
			const row = cut.rows.find((r) => r.sampleId === out)!;
			expect(wire(g, row.out!, `s:${out}:in:0`)).toBeDefined();
			expect(record(g, `s:${out}`).draft).toBe(true);
		}
	});

	it('a new sample made by a planned operation is a planned card, inheriting material and form', () => {
		const body = run([
			{ type: 'addSample', values: { material_id: 'ti', form: 'disc' } },
			{ type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'mc' }, from: { key: 'n1' } },
			{ type: 'addSample', from: { key: 'n2', row: 0 } },
		]);
		const data = toGraph(null, body, ctx);
		const made = data.samples.find((s) => s.id === 'draft:n4')!;
		expect(made).toMatchObject({ status: 'planned', form: 'disc', materialRef: { id: 'ti', code: 'Ti64' }, draft: true });
		const g = draw(data);
		expect(record(g, 's:draft:n4')).toMatchObject({ planned: true, draft: true });
		// done: an active sample
		const done = apply(body, { type: 'setWorkState', key: 'n2', workState: 'done' });
		expect(toGraph(null, done, ctx).samples.find((s) => s.id === 'draft:n4')?.status).toBeNull();
	});

	it('a pass appended in place to a stack of passes of the same work state joins the stack, drawn through buildGraph', () => {
		// Planned recorded passes: a planned draft pass stacks with them (a done stack and a planned pass stay apart, groupBatches).
		const pass = (id: string, day: number) =>
			mkOp({ id, sampleId: 's1', outputSampleId: null, methodId: 'turn', methodName: 'Turning', category: 'machining', equipmentId: 'lathe', date: `2026-09-0${day}T09:00:00Z`, workState: 'planned' });
		const loaded = mkData({ samples: [mkSample('s1')], operations: [pass('a', 1), pass('b', 2)] });
		const body = run([
			{ type: 'addPass', sample: { id: 's1', version: 4 }, values: { method_id: 'turn', equipment_id: 'lathe', operation_date: '2026-09-09', notes: 'drop me' }, workState: 'planned' },
		]);
		const data = toGraph(loaded, body, ctx);
		const added = data.operations.find((o) => o.draft)!;
		expect(added).toMatchObject({ sampleId: 's1', outputSampleId: null, methodId: 'turn', equipmentId: 'lathe', batchId: null, workState: 'planned' });
		const g = draw(data);
		const stack = container(g, 'stack:a,b,draft:n3');
		expect(stack).toMatchObject({ stacked: true, title: '3 passes' });
		// Recorded passes and a draft one: a mixed stack is neither flag as a whole.
		expect(stack.draft).toBeUndefined();
		expect(g.nodes.filter((n) => n.type === 'container')).toHaveLength(1);
	});

	it('a planned pass appended to done passes is a container of its own', () => {
		const pass = (id: string, day: number) =>
			mkOp({ id, sampleId: 's1', outputSampleId: null, methodId: 'turn', methodName: 'Turning', category: 'machining', equipmentId: 'lathe', date: `2026-09-0${day}T09:00:00Z` });
		const loaded = mkData({ samples: [mkSample('s1')], operations: [pass('a', 1), pass('b', 2)] });
		const body = run([{ type: 'addPass', sample: { id: 's1', version: 4 }, values: { method_id: 'turn', equipment_id: 'lathe' }, workState: 'planned' }]);
		const g = draw(toGraph(loaded, body, ctx));
		expect(container(g, 'stack:a,b').planned).toBeUndefined();
		expect(container(g, 'op:draft:n3')).toMatchObject({ draft: true, planned: true });
	});

	it('duplicate x N of an in-place pass makes a stack of N + 1 once drawn', () => {
		const body = run([
			{ type: 'addExistingSamples', samples: [{ id: 's1', version: 1 }] },
			{ type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'turn' }, from: { key: 'n1' } },
			{ type: 'wire', from: { key: 'n2', row: 0 }, to: { key: 'n1' } },
			{ type: 'setValues', key: 'n2', values: { equipment_id: 'lathe' } },
			{ type: 'duplicate', key: 'n2', n: 3 },
		]);
		const data = toGraph(mkData({ samples: [mkSample('s1')] }), body, ctx);
		expect(data.operations).toHaveLength(4);
		const g = draw(data);
		const stacks = g.nodes.filter((n): n is ContainerNode => n.type === 'container');
		expect(stacks).toHaveLength(1);
		expect(stacks[0]).toMatchObject({ stacked: true, title: '4 passes', draft: true, planned: true });
		// In the order of the draft: original first.
		expect(stacks[0].group.rowIds).toEqual(['draft:n3', 'draft:n5', 'draft:n7', 'draft:n9']);
	});

	it('a test wired from a sample: a draft test container with the sample as its subject; a destructive type ends the chain', () => {
		const body = run([
			{ type: 'addExistingSamples', samples: [{ id: 's1', version: 1 }] },
			{ type: 'addContainer', kind: 'test', source: { from: 'blank', testType: 'tensile' }, from: { key: 'n1' } },
		]);
		const data = toGraph(mkData({ samples: [mkSample('s1')] }), body, ctx);
		expect(data.tests[0]).toMatchObject({ id: 'draft:n2', testType: 'Tensile', category: 'destructive', subjectSampleIds: ['s1'], workState: 'planned', draft: true });
		const g = draw(data);
		const t = container(g, 'test:draft:n2');
		expect(t).toMatchObject({ draft: true, planned: true, category: 'test' });
		expect(wire(g, 's:s1:out:0', t.rows[0].in!)).toBeDefined();
		expect(t.rows[0].out).toBeUndefined();
	});

	it('numbers the draft steps in the order Create writes them: wires first, then the order of the draft', () => {
		// n1 sample; B (n2, row n3) is laid out first but wired after A (n4, row n5): sample → A → B.
		let body = run([
			{ type: 'addExistingSamples', samples: [{ id: 's1', version: 1 }] },
			{ type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'turn' } },
			{ type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'turn' }, from: { key: 'n1' } },
		]);
		body = apply(body, { type: 'wire', from: { key: 'n4', row: 0 }, to: { key: 'n2' } });
		const data = toGraph(mkData({ samples: [mkSample('s1')] }), body, ctx);
		const seq = (id: string) => data.operations.find((o) => o.id === id)!.sequence!;
		expect(seq('draft:n5')).toBeLessThan(seq('draft:n3'));
		expect(data.operations.find((o) => o.id === 'draft:n3')!.sampleId).toBe('s1');
		// Untouched wires keep the order of the draft.
		const plain = run([{ type: 'addExistingSamples', samples: [{ id: 's1', version: 1 }] }, { type: 'addPass', sample: { key: 'n1' }, values: {} }, { type: 'addPass', sample: { key: 'n1' }, values: {} }]);
		const d2 = toGraph(mkData({ samples: [mkSample('s1')] }), plain, ctx);
		expect(d2.operations.map((o) => o.id)).toEqual(['draft:n3', 'draft:n5']);
		expect(d2.operations[0].sequence!).toBeLessThan(d2.operations[1].sequence!);
	});

	it('an undated draft pass goes after the undated recorded passes on its sample', () => {
		const recorded = mkOp({ id: 'rec', sampleId: 's1', outputSampleId: null, methodId: 'turn', methodName: 'Turning', category: 'machining', equipmentId: 'lathe', date: null, sequence: null, workState: 'planned' });
		const body = run([{ type: 'addPass', sample: { id: 's1', version: 1 }, values: { method_id: 'turn', equipment_id: 'lathe' } }]);
		const data = toGraph(mkData({ samples: [mkSample('s1')], operations: [recorded] }), body, ctx);
		const g = draw(data);
		const stack = g.nodes.find((n): n is ContainerNode => n.type === 'container')!;
		expect(stack.group.rowIds).toEqual(['rec', 'draft:n3']);
	});

	it('an operation and a test wired on from a cut work on the piece the cut made', () => {
		let body = run([
			{ type: 'addExistingSamples', samples: [{ id: 's1', version: 1 }] },
			{ type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'mc' }, from: { key: 'n1' } },
			{ type: 'addSample', from: { key: 'n2', row: 0 } },
			{ type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'turn' } },
			{ type: 'addContainer', kind: 'test', source: { from: 'blank', testType: 'tensile' } },
		]);
		body = apply(body, { type: 'wire', from: { key: 'n2', row: 0 }, to: { key: 'n5' } });
		body = apply(body, { type: 'wire', from: { key: 'n2', row: 0 }, to: { key: 'n7' } });
		const data = toGraph(mkData({ samples: [mkSample('s1')] }), body, ctx);
		const turn = data.operations.find((o) => o.id === 'draft:n6')!;
		expect(turn.sampleId).toBe('draft:n4');
		expect(data.tests[0].subjectSampleIds).toEqual(['draft:n4']);
	});

	it('a test after an in-place operation takes the sample through it', () => {
		let body = run([{ type: 'addExistingSamples', samples: [{ id: 's1', version: 1 }] }, { type: 'addPass', sample: { key: 'n1' }, values: { method_id: 'turn' } }]);
		body = apply(body, { type: 'addContainer', kind: 'test', source: { from: 'blank', testType: 'tensile' }, from: { key: 'n2', row: 0 } });
		const data = toGraph(mkData({ samples: [mkSample('s1')] }), body, ctx);
		expect(data.tests[0].subjectSampleIds).toEqual(['s1']);
	});

	it('an existing operation that is attached gets the sample as its input, in place of its loaded record', () => {
		const loaded = mkData({
			samples: [mkSample('s1'), mkSample('made')],
			operations: [mkOp({ id: 'fast', sampleId: null, outputSampleId: 'made', methodName: 'FAST', date: '2026-09-01T09:00:00Z' })],
		});
		const body = run([
			{ type: 'addExistingSamples', samples: [{ id: 's1', version: 1 }] },
			{ type: 'attach', operation: { id: 'fast', version: 7 }, workState: 'done', from: { key: 'n1' } },
		]);
		const data = toGraph(loaded, body, ctx);
		expect(data.operations).toHaveLength(1);
		expect(data.operations[0]).toMatchObject({ id: 'fast', sampleId: 's1', outputSampleId: 'made', methodName: 'FAST' });
		const g = draw(data);
		expect(wire(g, 's:s1:out:0', 'op:fast:in:0')).toBeDefined();
	});

	it('an attached operation that is not loaded is read from ctx, else drawn as a stub', () => {
		const body = run([{ type: 'addExistingSamples', samples: [{ id: 's1', version: 1 }] }, { type: 'attach', operation: { id: 'x', version: 1 }, workState: 'planned', from: { key: 'n1' } }]);
		const fromCtx = toGraph(mkData({ samples: [mkSample('s1')] }), body, { ...ctx, operations: { x: mkOp({ id: 'x', methodName: 'Polish', outputSampleId: null }) } });
		expect(fromCtx.operations[0]).toMatchObject({ id: 'x', methodName: 'Polish', sampleId: 's1' });
		const stub = toGraph(mkData({ samples: [mkSample('s1')] }), body, ctx);
		expect(stub.operations[0]).toMatchObject({ id: 'x', sampleId: 's1' });
	});

	it('an existing sample outside the loaded family is added from ctx, else as a stub with its label', () => {
		const body = run([{ type: 'addExistingSamples', samples: [{ id: 'far', version: 2 }] }]);
		expect(toGraph(null, body, { ...ctx, samples: { far: mkSample('far', { code: 'S-FAR' }) } }).samples[0].code).toBe('S-FAR');
		expect(toGraph(null, body, { ...ctx, label: (c, id) => (c === 'physical_samples' ? `L-${id}` : undefined) }).samples[0].code).toBe('L-far');
		expect(toGraph(null, body, ctx).samples[0]).toMatchObject({ id: 'far', code: 'far' });
		expect(toGraph(null, body, ctx).samples[0].draft).toBeUndefined();
	});

	describe('a planned record the draft deletes', () => {
		const loaded = () =>
			mkData({
				samples: [mkSample('s1'), mkSample('s2', { status: 'planned' }), mkSample('s3', { status: 'planned' })],
				operations: [
					mkOp({ id: 'o1', sampleId: 's1', outputSampleId: 's2', methodName: 'Cut', workState: 'planned' }),
					mkOp({ id: 'o2', sampleId: 's1', outputSampleId: 's3', methodName: 'Cut', workState: 'planned' }),
				],
				tests: [mkTest({ id: 't1', subjectSampleIds: ['s1'], workState: 'planned' })],
			});
		const removed = (kind: 'operation' | 'test' | 'sample', id: string) => {
			const add: DraftAction =
				kind === 'sample' ? { type: 'addExistingSamples', samples: [{ id, version: 1 }] } : { type: 'addExisting', kind, record: { id, version: 1 }, workState: 'planned' };
			return run([add, { type: 'remove', key: 'n1', deleteRecord: true }]);
		};

		it('is marked removing, with the planned sample its operation made', () => {
			const data = toGraph(loaded(), removed('operation', 'o1'), ctx);
			expect(data.operations.find((o) => o.id === 'o1')?.removing).toBe(true);
			expect(data.operations.find((o) => o.id === 'o2')?.removing).toBeUndefined();
			expect(data.samples.find((x) => x.id === 's2')?.removing).toBe(true);
			expect(data.samples.find((x) => x.id === 's3')?.removing).toBeUndefined();
			const g = draw(data);
			expect(container(g, 'op:o1').removing).toBe(true);
			expect(container(g, 'op:o2').removing).toBeUndefined();
			expect(record(g, 's:s2').removing).toBe(true);
			expect(record(g, 's:s1').removing).toBeUndefined();
		});

		it('a test and a sample are marked the same way, and the loaded data is not touched', () => {
			const base = loaded();
			expect(toGraph(base, removed('test', 't1'), ctx).tests[0].removing).toBe(true);
			expect(record(draw(toGraph(base, removed('sample', 's3'), ctx)), 's:s3').removing).toBe(true);
			expect(base.tests[0].removing).toBeUndefined();
			expect(base.samples[2].removing).toBeUndefined();
		});

		it('a record that is only in the draft, not removed, is not marked', () => {
			const body = run([{ type: 'addExisting', kind: 'operation', record: { id: 'o1', version: 1 }, workState: 'planned' }]);
			expect(toGraph(loaded(), body, ctx).operations.some((o) => o.removing)).toBe(false);
		});
	});

	it('relations of the form become refs the Inside tray reads', () => {
		const body = run([
			{ type: 'addExistingSamples', samples: [{ id: 's1', version: 1 }] },
			{ type: 'addContainer', kind: 'operation', source: { from: 'template', values: { method_id: 'turn', equipment_id: 'e1', tool_id: 't1' } }, from: { key: 'n1' } },
		]);
		const data = toGraph(mkData({ samples: [mkSample('s1')] }), body, { ...ctx, label: (c, id) => (c === 'equipment' && id === 'e1' ? 'NLX-1' : undefined) });
		expect(data.operations[0].relations).toMatchObject({
			equipment_id: { collection: 'equipment', id: 'e1', code: 'NLX-1' },
			tool_id: { collection: 'tools', id: 't1', code: 't1' },
		});
	});

	it('draft ids round-trip', () => {
		expect(draftId('n4')).toBe('draft:n4');
		expect(draftKeyOf('draft:n4')).toBe('n4');
		expect(draftKeyOf('op-uuid')).toBeNull();
	});

	it('uses the draft project for records that have none of their own', () => {
		const body = run([{ type: 'setProject', projectId: 'p1' }, { type: 'addSample', values: { project_id: 'p2' } }, { type: 'addSample' }]);
		expect(toGraph(null, body, ctx).samples.map((s) => s.projectId)).toEqual(['p2', 'p1']);
	});

	it('draws a tests-only draft on a loaded family without touching its tests', () => {
		const loaded = mkData({ samples: [mkSample('s1')], tests: [mkTest({ id: 'old', subjectSampleIds: ['s1'] })] });
		const body = run([{ type: 'addExistingSamples', samples: [{ id: 's1', version: 1 }] }, { type: 'addContainer', kind: 'test', source: { from: 'blank', testType: 'tensile' }, from: { key: 'n1' } }]);
		const data = toGraph(loaded, body, ctx);
		expect(data.tests.map((t) => t.id)).toEqual(['old', 'draft:n2']);
	});
});
