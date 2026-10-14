import { describe, expect, it, vi } from 'vitest';
import { createSSRApp, defineComponent, h, ref, type Component } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { buildGraph } from '../model/buildGraph';
import { groupsOf, mkData, mkLineage, mkOp, mkSample, mkTest } from '../model/fixtures';
import type { ContainerNode as ContainerData, JunctionNode as JunctionData, MapNode, ProcessData, RecordNode as RecordData, Slot, Wire } from '../model/types';
import { MAP_ACTIONS, MAP_VIEW, cardHandlers, recordHandlers, refKey, stopping, wireHandlers, type MapActions, type MapView } from './actions';
import ContainerNode from './ContainerNode.vue';
import JunctionNode from './JunctionNode.vue';
import RecordNode from './RecordNode.vue';
import SlotRow from './SlotRow.vue';
import WireEdge from './WireEdge.vue';
import { wireTooltip } from './wireTooltip';
import { KINDS } from './kinds';

// Vue Flow's Handle needs a running flow; the stub shows which socket ids get drawn.
vi.mock('@vue-flow/core', async (orig) => ({
	...(await orig<typeof import('@vue-flow/core')>()),
	Handle: defineComponent({
		props: { id: String, type: String, position: String },
		setup: (p) => () => h('span', { class: 'sock', 'data-id': p.id, 'data-type': p.type, 'data-pos': p.position }),
	}),
}));

const VIcon = defineComponent({ props: { name: String }, setup: (p) => () => h('i', { class: 'v-icon' }, p.name) });

function spies(): MapActions & { calls: unknown[][] } {
	const calls: unknown[][] = [];
	const rec = (name: string) => (...a: unknown[]) => void calls.push([name, ...a]);
	return { calls, select: rec('select'), expand: rec('expand'), hover: rec('hover'), toggleRows: rec('toggleRows'), toggleMore: rec('toggleMore') };
}

async function render(component: Component, props: Record<string, unknown>, view?: Partial<MapView>, actions = spies()): Promise<string> {
	const app = createSSRApp(component, props);
	app.component('v-icon', VIcon);
	app.provide(MAP_ACTIONS, actions);
	if (view) app.provide(MAP_VIEW, { direction: ref<'RIGHT' | 'DOWN'>('RIGHT'), moreOpen: ref(new Set<string>()), selectedRef: ref(null), ...view });
	return renderToString(app);
}

const ids = (html: string) => [...html.matchAll(/data-id="([^"]*)"/g)].map((m) => m[1]);
const wireClass = (html: string) => /<path class="([^"]*\bwire\b[^"]*)"/.exec(html)?.[1] ?? '';
const text = (html: string) => html.replace(/<!--.*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

const sam = (...names: string[]) => names.map((id) => mkSample(id));
const containers = (data: ProcessData, probable = false, slots: () => Slot[] = () => []) =>
	buildGraph(data, groupsOf(data, probable), { slots }).nodes.filter((n): n is ContainerData => n.type === 'container');

const DAY = '2026-09-01T09:00:00Z';
const cutOf = (n: number): ProcessData =>
	mkData({
		samples: sam('p', ...Array.from({ length: n }, (_, i) => `c${i}`)),
		operations: Array.from({ length: n }, (_, i) => mkOp({ id: `cut${i}`, sampleId: 'p', outputSampleId: `c${i}`, date: DAY, methodName: 'Wire cut', equipmentId: 'eq1' })),
	});

const refOf = (collection: string, id: string, code: string) => ({ collection, id, code });
const machine = (code: string): Slot => ({ field: 'equipment_id', role: 'Machine', ref: refOf('equipment', 'eq1', code), major: true });
const minor = (field: string, role: string, code: string): Slot => ({ field, role, ref: refOf('people', field, code), major: false });

describe('refKey', () => {
	it('is <collection>:<id>', () => expect(refKey(refOf('equipment', 'eq1', 'X'))).toBe('equipment:eq1'));
});

describe('ContainerNode', () => {
	it('renders header, 2 rows + "+2 more samples" for 4 rows, Inside tray with majors then "+N more from the form"', async () => {
		const [c] = containers(cutOf(4), true, () => [machine('NLX-1'), minor('operator', 'Operator', 'Ada'), minor('owner', 'Owner', 'Bob')]);
		const html = await render(ContainerNode, { id: c.id, data: c });
		const t = text(html);

		expect(t).toContain('Probable batch · Wire cut');
		expect(html).toContain('aria-label="Expand"');
		expect(t).toContain('+2 more samples');
		expect(t).toContain('Inside');
		expect(t).toContain('NLX-1');
		expect(t).toContain('+2 more from the form');
		expect(t).not.toContain('Ada'); // minors stay folded
		// one shared input socket, two own outputs, the bundle out; every id exactly once
		const all = ids(html);
		expect(all).toEqual([`${c.id}:in:0`, `${c.id}:out:0`, `${c.id}:out:1`, `${c.id}:out:b`]);
		expect(new Set(all).size).toBe(all.length);
		expect(html).toMatch(/class="sock[^"]*"[^>]*data-id="[^"]*:out:b"/); // bundle socket present
	});

	it('draws the bundle input socket for a recorded batch of several samples', async () => {
		const data = mkData({ samples: sam('a', 'b', 'c', 'd'), operations: ['a', 'b', 'c', 'd'].map((s) => mkOp({ id: `h${s}`, sampleId: s, batchId: 'B1' })) });
		const [c] = containers(data);
		const all = ids(await render(ContainerNode, { id: c.id, data: c }));
		expect(all).toContain('batch:B1:in:b');
		expect(all.filter((i) => i === 'batch:B1:in:b')).toHaveLength(1);
		expect(new Set(all).size).toBe(all.length);
	});

	it('shows the minor slots once the page has opened them', async () => {
		const [c] = containers(cutOf(1), false, () => [machine('NLX-1'), minor('operator', 'Operator', 'Ada')]);
		const html = await render(ContainerNode, { id: c.id, data: c }, { moreOpen: ref(new Set([c.id])) });
		expect(text(html)).toContain('Ada');
		expect(text(html)).toContain('Show fewer');
	});

	it('a probable batch says "Probable batch" and has a dashed class', async () => {
		const [c] = containers(cutOf(2), true);
		const html = await render(ContainerNode, { id: c.id, data: c });
		expect(text(html)).toContain('Probable batch');
		expect(text(html)).not.toContain(c.code); // the method is shown, not the first row's code
		expect(html).toMatch(/class="[^"]*\bprobable\b/);
		const [solo] = containers(cutOf(1));
		expect(await render(ContainerNode, { id: solo.id, data: solo })).not.toMatch(/class="[^"]*\bprobable\b/);
	});

	it('zero rows renders the tray without row sockets', async () => {
		const [c] = containers(cutOf(1), false, () => [machine('NLX-1')]);
		const empty: ContainerData = { ...c, rows: [], bundled: false };
		const html = await render(ContainerNode, { id: c.id, data: empty });
		expect(ids(html)).toEqual([]);
		expect(text(html)).toContain('Inside');
		expect(text(html)).toContain('NLX-1');
	});

	it('a destructive test row has no out handle', async () => {
		const data = mkData({ samples: sam('s1'), tests: [mkTest({ id: 't1', subjectSampleIds: ['s1'], category: 'destructive', testType: 'Tensile' })] });
		const [c] = containers(data);
		const html = await render(ContainerNode, { id: c.id, data: c });
		expect(ids(html).filter((i) => i.includes(':out:'))).toEqual([]);
		expect(ids(html).filter((i) => i.includes(':in:'))).toHaveLength(1);
		expect(html).toMatch(/class="[^"]*\btest\b/);
	});

	it('an in-place row draws the dashed pass-through line', async () => {
		const data = mkData({ samples: sam('s1'), operations: [mkOp({ id: 'turn', sampleId: 's1', outputSampleId: null })] });
		const [c] = containers(data);
		expect(c.rows[0].inPlace).toBe(true);
		const html = await render(ContainerNode, { id: c.id, data: c });
		expect(html).toContain('class="pass"');
		const [cut] = containers(cutOf(2), true);
		expect(await render(ContainerNode, { id: cut.id, data: cut })).not.toContain('class="pass"');
	});

	it('shows key settings and offers to fold an unfolded batch', async () => {
		const [c] = containers(cutOf(5), true);
		const unfolded: ContainerData = { ...c, bundled: false, settings: [{ label: 'Feed', value: '0.2 mm/rev' }] };
		const t = text(await render(ContainerNode, { id: c.id, data: unfolded }));
		expect(t).toContain('Feed');
		expect(t).toContain('0.2 mm/rev');
		expect(t).toContain('Fold samples');
	});

	it('DOWN direction puts handles on Top/Bottom', async () => {
		const [c] = containers(cutOf(1));
		const html = await render(ContainerNode, { id: c.id, data: c }, { direction: ref('DOWN') });
		expect(html).toContain('data-pos="top"');
		expect(html).toContain('data-pos="bottom"');
	});
});

describe('SlotRow', () => {
	it('a merged slot with 2 values says "2 different" and lists them on open', async () => {
		const slot: Slot = { field: 'tool_id', role: 'Tool', ref: null, major: true, values: [refOf('tools', 't1', 'T-1'), refOf('tools', 't2', 'T-2')] };
		expect(text(await render(SlotRow, { item: slot }))).toContain('2 different');
		const open = text(await render(SlotRow, { item: slot, open: true }));
		expect(open).toContain('T-1');
		expect(open).toContain('T-2');
	});

	it('a partial slot says "some rows", never "different"', async () => {
		const one: Slot = { field: 'tool_id', role: 'Tool', ref: null, major: true, values: [refOf('tools', 't1', 'T-1')], partial: true };
		const t = text(await render(SlotRow, { item: one }));
		expect(t).toContain('T-1');
		expect(t).toContain('some rows');
		expect(t).not.toContain('different');
		const two: Slot = { ...one, values: [refOf('tools', 't1', 'T-1'), refOf('tools', 't2', 'T-2')] };
		const t2 = text(await render(SlotRow, { item: two, open: true }));
		expect(t2).toContain('some rows');
		expect(t2).not.toContain('different');
		expect(t2).toContain('T-2');
	});

	it('a plain slot shows role and code', async () => {
		const t = text(await render(SlotRow, { item: machine('NLX-1') }));
		expect(t).toContain('Machine');
		expect(t).toContain('NLX-1');
	});
});

describe('RecordNode', () => {
	const sample: RecordData = { id: 's:s1', type: 'record', kind: 'sample', ref: { collection: 'physical_samples', id: 's1', code: 'S-0412-A' }, status: 'active', meta: 'Ti-6Al-4V', ins: ['s:s1:in:0'], outs: ['s:s1:out:0'] };

	it('shows kind pill, code, status badge and a ＋ button', async () => {
		const html = await render(RecordNode, { id: sample.id, data: sample });
		const t = text(html);
		expect(t).toContain('Sample');
		expect(t).toContain('S-0412-A');
		expect(t).toContain('Active');
		expect(t).toContain('Ti-6Al-4V');
		expect(html).toContain('class="xbtn"');
		expect(html).toContain('aria-label="Expand"');
		expect(ids(html)).toEqual(['s:s1:in:0', 's:s1:out:0']);
	});

	it('marks the selected card focal', async () => {
		expect(await render(RecordNode, { id: sample.id, data: sample, selected: true })).toMatch(/class="[^"]*\bfocal\b/);
		expect(await render(RecordNode, { id: sample.id, data: sample })).not.toMatch(/class="[^"]*\bfocal\b/);
	});

	it('every kind has a label, an icon and a --k variable', () => {
		for (const k of Object.values(KINDS)) {
			expect(k.label).toBeTruthy();
			expect(k.icon).toBeTruthy();
			expect(k.color).toMatch(/^--k-/);
		}
	});
});

describe('JunctionNode', () => {
	const j: JunctionData = {
		id: 'j:s:cut_from',
		type: 'junction',
		lineageType: 'cut_from',
		parentId: 's',
		in: 'j:s:cut_from:in:0',
		outs: [
			{ socket: 'j:s:cut_from:out:0', childId: 'a', fraction: 0.25 },
			{ socket: 'j:s:cut_from:out:1', childId: 'b', fraction: null },
		],
	};

	it('labels "Cut from" and fractions', async () => {
		const html = await render(JunctionNode, { id: j.id, data: j });
		const t = text(html);
		expect(t).toContain('Cut from');
		expect(t).toContain('0.25');
		expect(ids(html)).toEqual([j.in, 'j:s:cut_from:out:0', 'j:s:cut_from:out:1']);
	});

	it('names the other lineage types', async () => {
		const t = async (lineageType: JunctionData['lineageType']) => text(await render(JunctionNode, { id: j.id, data: { ...j, lineageType } }));
		expect(await t('sintered_from')).toContain('Sintered from');
		expect(await t('powder_from')).toContain('Powder from');
		expect(await t('derived_from')).toContain('Derived from');
	});
});

describe('WireEdge', () => {
	const nodes: MapNode[] = [
		{ id: 's:s1', type: 'record', kind: 'sample', ref: { collection: 'physical_samples', id: 's1', code: 'S-0412-A' }, ins: [], outs: [] },
		{ id: 'op:o1', type: 'container', kind: 'operation', group: { id: 'op:o1', kind: 'operation', rowIds: ['o1'], batch: null }, title: 'Turning', code: 'OP-17', category: 'machining', rows: [], slots: [], settings: [], bundled: false, probable: false },
		{ id: 'op:o2', type: 'container', kind: 'operation', group: { id: 'op:o2', kind: 'operation', rowIds: ['o2'], batch: null }, title: 'Polish', code: 'OP-18', category: 'machining', rows: [], slots: [], settings: [], bundled: false, probable: false },
	];
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const wire: Wire = { id: 'op:o1:out:0>op:o2:in:0', from: 'op:o1:out:0', to: 'op:o2:in:0', carries: 's1', flow: 'sample', bundled: false, origin: 'op:o1' };

	it('tooltip text "S-0412-A · Sample / from OP-… / into OP-…"', () => {
		expect(wireTooltip({ ...wire, carries: 's1' }, new Map([...byId, ['s:s1', nodes[0]]]))).toEqual(['S-0412-A · Sample', 'from OP-17', 'into OP-18']);
	});

	it('skips the sample line when the wire carries none', () => {
		expect(wireTooltip({ ...wire, carries: null }, byId)).toEqual(['from OP-17', 'into OP-18']);
	});

	it('names a junction without a code by its type', () => {
		const j: JunctionData = { id: 'j:s1:cut_from', type: 'junction', lineageType: 'cut_from', parentId: 's1', in: 'j:s1:cut_from:in:0', outs: [] };
		const lines = wireTooltip({ ...wire, from: 's:s1:out:0', origin: 's:s1', to: 'j:s1:cut_from:in:0' }, new Map([...byId, [j.id, j]]));
		expect(lines).toEqual(['S-0412-A · Sample', 'from S-0412-A', 'into Cut from']);
	});

	const edgeProps = (over: Record<string, unknown> = {}) => ({
		id: wire.id,
		source: 'op:o1',
		target: 'op:o2',
		sourceX: 0,
		sourceY: 0,
		targetX: 100,
		targetY: 40,
		sourcePosition: 'right',
		targetPosition: 'left',
		data: { wire, tooltip: [] },
		...over,
	});

	it('renders a bezier wire with a wide hit path, thicker when bundled', async () => {
		const html = await render(WireEdge, edgeProps());
		expect(html).toMatch(/<path class="[^"]*\bwire\b[^"]*" d="M/);
		expect(html).toContain('class="hit"');
		expect(wireClass(html)).not.toContain('fat');
		const fat = await render(WireEdge, edgeProps({ data: { wire: { ...wire, bundled: true }, tooltip: [] } }));
		expect(wireClass(fat)).toContain('fat');
		const stock = await render(WireEdge, edgeProps({ data: { wire: { ...wire, flow: 'stock' }, tooltip: [] } }));
		expect(stock).toContain('flow-stock');
	});

	it('puts the tooltip lines on the hit path for the page to show', async () => {
		const lines = wireTooltip(wire, new Map([...byId, ['s:s1', nodes[0]]]));
		const html = await render(WireEdge, edgeProps({ data: { wire, tooltip: lines } }));
		expect(/data-tip="([^"]*)"/.exec(html)?.[1]).toBe('S-0412-A · Sample\nfrom OP-17\ninto OP-18');
	});
});

describe('lineage junction from the model renders', () => {
	it('builds and renders a junction node from buildGraph', async () => {
		const data = mkData({ samples: sam('s', 'a', 'b'), lineage: [mkLineage('s', 'a', 'cut_from', 0.5), mkLineage('s', 'b', 'cut_from', 0.5)] });
		const g = buildGraph(data, groupsOf(data), { slots: () => [] });
		const j = g.nodes.find((n): n is JunctionData => n.type === 'junction')!;
		const html = await render(JunctionNode, { id: j.id, data: j });
		expect(text(html)).toContain('0.5');
		expect(new Set(ids(html)).size).toBe(ids(html).length);
	});
});

// ---- event wiring ---------------------------------------------------------------------------------
// The components bind these handlers (SSR cannot click and the repo has no DOM environment), so the
// click / hover behaviour is tested on the handlers themselves; the markup tests above check the
// elements they hang on.
const ev = (init: Record<string, unknown> = {}) => ({ stopPropagation: vi.fn(), currentTarget: { el: true }, ...init });

describe('event handlers', () => {
	it('a card: body click selects, hover reports it, the + button expands and stops propagation', () => {
		const a = spies();
		const card = cardHandlers(a, () => 'op:1');
		card.select();
		const enter = ev();
		card.enter(enter);
		card.leave();
		const plus = ev();
		card.expand(plus);
		expect(a.calls).toEqual([['select', 'op:1'], ['hover', 'op:1', enter.currentTarget], ['hover', null], ['expand', 'op:1']]);
		expect(plus.stopPropagation).toHaveBeenCalled();
	});

	it('a slot record: hover and click act on its refKey and the click stops propagation', () => {
		const a = spies();
		const rec = recordHandlers(a, () => refOf('equipment', 'eq1', 'NLX-1'));
		const enter = ev();
		rec.enter(enter);
		rec.leave();
		const click = ev();
		rec.select(click);
		expect(a.calls).toEqual([['hover', 'equipment:eq1', enter.currentTarget], ['hover', null], ['select', 'equipment:eq1']]);
		expect(click.stopPropagation).toHaveBeenCalled();
	});

	it('stopping runs its action after stopping the event', () => {
		const order: string[] = [];
		stopping(() => order.push('run'))({ stopPropagation: () => order.push('stop') });
		expect(order).toEqual(['stop', 'run']);
	});

	it('a wire: Ctrl or ⌘+click selects and centres the origin, a plain click does nothing, hover reports the wire', () => {
		const a = spies();
		const w = wireHandlers(a, () => ({ id: 'a:out:0>b:in:0', origin: 'a' }));
		w.click(ev());
		expect(a.calls).toEqual([]);
		const ctrl = ev({ ctrlKey: true });
		w.click(ctrl);
		w.click(ev({ metaKey: true }));
		expect(ctrl.stopPropagation).toHaveBeenCalled();
		expect(a.calls).toEqual([['select', 'a', { centre: true }], ['select', 'a', { centre: true }]]);

		a.calls.length = 0;
		const enter = ev();
		w.enter(enter);
		w.leave();
		expect(a.calls).toEqual([['hover', 'a:out:0>b:in:0', enter.currentTarget], ['hover', null]]);
	});
});
