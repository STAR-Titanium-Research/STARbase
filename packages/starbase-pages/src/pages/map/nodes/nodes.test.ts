import { describe, expect, it, vi } from 'vitest';
import { createSSRApp, defineComponent, h, ref, type Component } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { buildGraph } from '../model/buildGraph';
import { groupBatches } from '../model/groupBatches';
import { groupsOf, mkData, mkLineage, mkOp, mkSample, mkTest } from '../model/fixtures';
import type { ContainerNode as ContainerData, JunctionNode as JunctionData, MapNode, ProcessData, RecordNode as RecordData, Slot, Wire } from '../model/types';
import { MAP_ACTIONS, MAP_VIEW, activating, cardHandlers, recordHandlers, refKey, socketHandlers, socketProps, stopping, wireHandlers, type MapActions, type MapView } from './actions';
import { cardLabel, socketLabeller } from './a11y';
import ContainerNode from './ContainerNode.vue';
import JunctionNode from './JunctionNode.vue';
import MoreNode from './MoreNode.vue';
import RecordNode from './RecordNode.vue';
import SlotRow from './SlotRow.vue';
import WireEdge from './WireEdge.vue';
import { socketTooltip, wireTooltip } from './wireTooltip';
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
	return { calls, select: rec('select'), expand: rec('expand'), hover: rec('hover'), toggleRows: rec('toggleRows'), toggleMore: rec('toggleMore'), unstack: rec('unstack'), restack: rec('restack') };
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
	it('renders header, a rail with "+2 more" for 4 rows, the tray with majors then "+N more from the form"', async () => {
		const [c] = containers(cutOf(4), true, () => [machine('NLX-1'), minor('operator', 'Operator', 'Ada'), minor('owner', 'Owner', 'Bob')]);
		const html = await render(ContainerNode, { id: c.id, data: c });
		const t = text(html);

		expect(t).toContain('Probable batch · Wire cut');
		expect(html).toContain('aria-label="Expand"');
		expect(t).toContain('1 sample → 4 pieces'); // counted over every row, folded ones too
		expect(t).toContain('+2 more');
		expect(t).not.toContain('Inside'); // the tray has no label: its chips say what they are
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

	it('a cut is one summary line, its shared input drawn once, no per-row labels', async () => {
		const [c] = containers(cutOf(3), true);
		const unfolded: ContainerData = { ...c, bundled: false };
		const html = await render(ContainerNode, { id: c.id, data: unfolded });
		const t = text(html);
		expect(t).toContain('1 sample → 3 pieces');
		expect(t).not.toMatch(/Sample \d/);
		expect(ids(html)).toEqual([`${c.id}:in:0`, `${c.id}:out:0`, `${c.id}:out:1`, `${c.id}:out:2`]);
	});

	it('samples processed in place say so', async () => {
		const data = mkData({ samples: sam('a', 'b'), operations: ['a', 'b'].map((s) => mkOp({ id: `h${s}`, sampleId: s, batchId: 'B1' })) });
		const [c] = containers(data);
		expect(text(await render(ContainerNode, { id: c.id, data: c }))).toContain('2 samples · in place');
	});

	it('an operation that makes a sample from nothing says what it makes', async () => {
		const op = mkOp({ id: 'f1', sampleId: null, outputSampleId: 's1', methodName: 'FAST sintering' });
		const [c] = containers(mkData({ samples: sam('s1'), operations: [op] }));
		expect(text(await render(ContainerNode, { id: c.id, data: c }))).toContain('Makes 1 sample');
	});

	it('more than three unfolded rows offer "fold"', async () => {
		const [c] = containers(cutOf(4), true);
		const html = await render(ContainerNode, { id: c.id, data: { ...c, bundled: false } });
		expect(text(html)).toContain('fold');
		expect(text(html)).not.toContain('more');
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
		expect(html).toContain('class="slots"');
		expect(text(html)).toContain('NLX-1');
	});

	it('a destructive test row has no out handle', async () => {
		const data = mkData({ samples: sam('s1'), tests: [mkTest({ id: 't1', subjectSampleIds: ['s1'], category: 'destructive', testType: 'Tensile' })] });
		const [c] = containers(data);
		const html = await render(ContainerNode, { id: c.id, data: c });
		expect(ids(html).filter((i) => i.includes(':out:'))).toEqual([]);
		expect(ids(html).filter((i) => i.includes(':in:'))).toHaveLength(1);
		expect(html).toMatch(/class="[^"]*\btest\b/);
		expect(text(html)).toContain('1 sample tested');
	});

	it('an in-place row says "in place"; a cut does not', async () => {
		const data = mkData({ samples: sam('s1'), operations: [mkOp({ id: 'turn', sampleId: 's1', outputSampleId: null })] });
		const [c] = containers(data);
		expect(c.rows[0].inPlace).toBe(true);
		expect(text(await render(ContainerNode, { id: c.id, data: c }))).toContain('1 sample · in place');
		const [cut] = containers(cutOf(2), true);
		expect(text(await render(ContainerNode, { id: cut.id, data: cut }))).not.toContain('in place');
	});

	it('shows key settings and offers to fold an unfolded batch', async () => {
		const [c] = containers(cutOf(5), true);
		const unfolded: ContainerData = { ...c, bundled: false, settings: [{ label: 'Feed', value: '0.2 mm/rev' }] };
		const t = text(await render(ContainerNode, { id: c.id, data: unfolded }));
		expect(t).toContain('Feed');
		expect(t).toContain('0.2 mm/rev');
		expect(t).toContain('fold');
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
		expect(html).toContain('class="xbtn nodrag nopan"');
		expect(html).toContain('aria-label="Expand"');
		expect(ids(html)).toEqual(['s:s1:in:0', 's:s1:out:0']);
	});

	it('a material card shows its name as the title, with its code on the meta line; without a name, its code', async () => {
		const mat = (label?: string): RecordData => ({ id: 'm:s1', type: 'record', kind: 'material', ref: { collection: 'materials', id: 'm1', code: 'AA', ...(label ? { label } : {}) }, ins: [], outs: ['m:s1:out:0'] });
		const named = await render(RecordNode, { id: 'm:s1', data: mat('Ti-6Al-4V Grade 5') });
		expect(named).toMatch(/<div class="code"[^>]*title="Ti-6Al-4V Grade 5"[^>]*>Ti-6Al-4V Grade 5<\/div>/);
		expect(text(named)).toContain('AA');
		const bare = await render(RecordNode, { id: 'm:s1', data: mat() });
		expect(bare).toMatch(/<div class="code"[^>]*>AA<\/div>/);
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

	it('draws each output socket on the output edge of the card, in its own full-width row, with or without a fraction', async () => {
		// The html of each output row: everything from one "out" div up to the next.
		const rows = (html: string) => html.split(/<div[^>]*class="out[ "]/).slice(1);
		const styleOf = (html: string, socket: string) => new RegExp(`data-id="${socket}"[^>]*style="([^"]*)"`).exec(html)?.[1] ?? '';
		const right = await render(JunctionNode, { id: j.id, data: j });
		// Each out is a block row (div.out) holding exactly its own socket, not an inline span.
		expect(rows(right)).toHaveLength(2);
		j.outs.forEach((o, i) => expect(rows(right)[i], o.socket).toContain(`data-id="${o.socket}"`));
		// RIGHT: the right edge of the row (the card's edge), level with that row.
		expect(styleOf(right, j.outs[0].socket)).toBe('left:100%;top:50%;');
		expect(styleOf(right, j.outs[1].socket)).toBe('left:100%;top:50%;');
		// Null fraction renders no text but the row (and its socket) is still there.
		expect(right).toContain('data-pos="right"');
		// DOWN: on the bottom edge, spread across the card like a container's.
		const down = await render(JunctionNode, { id: j.id, data: j }, { direction: ref<'RIGHT' | 'DOWN'>('DOWN') });
		expect(styleOf(down, j.outs[0].socket)).toBe('top:100%;left:33.33333333333333%;');
		expect(styleOf(down, j.outs[1].socket)).toBe('top:100%;left:66.66666666666666%;');
		expect(down).toContain('data-pos="bottom"');
		// The input socket is unchanged: on the input edge.
		expect(styleOf(right, j.in)).toBe('left:0;top:50%;');
		expect(styleOf(down, j.in)).toBe('top:0;left:50%;');
		// A single output with no fraction at all still gets the edge.
		const one = { ...j, outs: [{ socket: 'j:s:cut_from:out:0', childId: 'a', fraction: null }] };
		expect(styleOf(await render(JunctionNode, { id: j.id, data: one }), 'j:s:cut_from:out:0')).toBe('left:100%;top:50%;');
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

	it('omits the sample line, never a raw id, when the sample is not drawn', () => {
		const without = new Map([...byId].filter(([k]) => k !== 's:s1'));
		const lines = wireTooltip({ ...wire, carries: 's1' }, without);
		expect(lines).toEqual(['from OP-17', 'into OP-18']);
		expect(lines.join(' ')).not.toContain('s1');
	});

	it('a socket lists one "<code> · <kind>" line per wire on it', () => {
		const lot: MapNode = { id: 'lot:l1', type: 'record', kind: 'stock_lot', ref: { collection: 'raw_stock_lots', id: 'l1', code: 'LOT-9' }, ins: [], outs: ['lot:l1:out:0'] };
		const wires: Wire[] = [
			{ ...wire, from: 's:s1:out:0', to: 'op:o1:in:0', origin: 's:s1', carries: 's1' },
			{ id: 'lot:l1:out:0>op:o1:in:0', from: 'lot:l1:out:0', to: 'op:o1:in:0', carries: null, flow: 'stock', bundled: false, origin: 'lot:l1' },
			{ ...wire, from: 's:s1:out:0', to: 'op:o2:in:0', origin: 's:s1', carries: 's1' },
		];
		const drawn = new Map([...byId, [lot.id, lot]]);
		expect(socketTooltip('op:o1:in:0', wires, drawn)).toEqual(['S-0412-A · Sample', 'LOT-9 · Stock lot']);
		// A socket with two wires carrying the same sample names it once.
		expect(socketTooltip('s:s1:out:0', wires, drawn)).toEqual(['S-0412-A · Sample']);
		expect(socketTooltip('op:o9:in:0', wires, drawn)).toEqual(['Not connected']);
		expect(socketTooltip('op:o1:in:0', wires, new Map())).toEqual(['Connected records are not shown']);
	});

	it('names a junction without a code by its type', () => {
		const j: JunctionData = { id: 'j:s1:cut_from', type: 'junction', lineageType: 'cut_from', parentId: 's1', in: 'j:s1:cut_from:in:0', outs: [] };
		const lines = wireTooltip({ ...wire, from: 's:s1:out:0', origin: 's:s1', to: 'j:s1:cut_from:in:0' }, new Map([...byId, [j.id, j]]));
		expect(lines).toEqual(['S-0412-A · Sample', 'from S-0412-A', 'into Cut from']);
	});

	it('names an unnamed batch container by its title, never blank', () => {
		const batch: MapNode = { id: 'batch:b9', type: 'container', kind: 'operation', group: { id: 'batch:b9', kind: 'operation', rowIds: ['o2'], batch: { recorded: true, code: null } }, title: 'Batch', code: '', category: 'machining', rows: [], slots: [], settings: [], bundled: false, probable: false };
		const lines = wireTooltip({ ...wire, to: 'batch:b9:in:0', carries: null }, new Map([...byId, [batch.id, batch]]));
		expect(lines).toEqual(['from OP-17', 'into Batch']);
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

	it('renders a bezier wire with a wide hit path, as thick as any other when it carries a folded bundle', async () => {
		const html = await render(WireEdge, edgeProps());
		expect(html).toMatch(/<path class="[^"]*\bwire\b[^"]*" d="M/);
		expect(html).toContain('class="hit"');
		expect(wireClass(html)).not.toContain('fat');
		const bundled = await render(WireEdge, edgeProps({ data: { wire: { ...wire, bundled: true }, tooltip: [] } }));
		expect(wireClass(bundled)).not.toContain('fat'); // the bundle socket is fat; the wire into it is not
		const stock = await render(WireEdge, edgeProps({ data: { wire: { ...wire, flow: 'stock' }, tooltip: [] } }));
		expect(stock).toContain('flow-stock');
	});

	it('puts the tooltip lines on the hit path for the page to show', async () => {
		const lines = wireTooltip(wire, new Map([...byId, ['s:s1', nodes[0]]]));
		const html = await render(WireEdge, edgeProps({ data: { wire, tooltip: lines } }));
		expect(/data-tip="([^"]*)"/.exec(html)?.[1]).toBe('S-0412-A · Sample\nfrom OP-17\ninto OP-18');
	});
	it('a stackable wire is drawn twice: its colour, then a background core on top; a normal wire once', async () => {
		const html = await render(WireEdge, edgeProps({ data: { wire: { ...wire, stackable: true }, tooltip: [] } }));
		const paths = [...html.matchAll(/<path class="([^"]*)"/g)].map((m) => m[1]);
		expect(paths).toHaveLength(3); // colour, core, hit
		expect(paths[0]).toContain('wire');
		expect(paths[0]).toContain('stackable');
		expect(paths[1]).toBe('core');
		expect(paths[2]).toBe('hit');
		const d = [...html.matchAll(/<path class="([^"]*)" d="([^"]*)"/g)].filter((m) => m[1] !== 'hit').map((m) => m[2]);
		expect(d[0]).toBe(d[1]); // the same path
		const normal = [...(await render(WireEdge, edgeProps())).matchAll(/<path class="([^"]*)"/g)].map((m) => m[1]);
		expect(normal).toEqual([expect.stringContaining('wire'), 'hit']);
	});

	it('the tooltip of a stackable wire says how to stack the passes again', () => {
		expect(wireTooltip({ ...wire, stackable: true }, byId)).toEqual(['S-0412-A · Sample', 'from OP-17', 'into OP-18', 'Double-click a pass to stack again']);
		expect(wireTooltip(wire, byId)).not.toContain('Double-click a pass to stack again');
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

	it('activating: a button-like element acts on Enter and on Space, and Space does not scroll the page (L2)', () => {
		const ran: string[] = [];
		const act = activating(() => ran.push('run'));
		for (const key of ['Enter', ' ']) {
			const e = { key, preventDefault: vi.fn(), stopPropagation: vi.fn() };
			act(e);
			expect(e.preventDefault, key).toHaveBeenCalled();
			expect(e.stopPropagation, key).toHaveBeenCalled();
		}
		expect(ran).toEqual(['run', 'run']);
		const other = { key: 'Tab', preventDefault: vi.fn(), stopPropagation: vi.fn() };
		act(other);
		expect(ran).toHaveLength(2);
		expect(other.preventDefault).not.toHaveBeenCalled();
	});

	it('a slot record also selects from the keyboard on Enter or Space', () => {
		const a = spies();
		const rec = recordHandlers(a, () => refOf('equipment', 'eq1', 'NLX-1'));
		rec.key({ key: ' ', preventDefault() {}, stopPropagation() {} });
		rec.key({ key: 'Enter', preventDefault() {}, stopPropagation() {} });
		rec.key({ key: 'a', preventDefault() {}, stopPropagation() {} });
		expect(a.calls).toEqual([['select', 'equipment:eq1'], ['select', 'equipment:eq1']]);
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

describe('controls inside cards do not start a Vue Flow drag or pan', () => {
	const noDrag = (html: string, marker: RegExp) => {
		const m = marker.exec(html);
		expect(m, String(marker)).not.toBeNull();
		expect(m![0]).toMatch(/\bnodrag\b/);
		expect(m![0]).toMatch(/\bnopan\b/);
	};

	it('the ＋ button, the rail\'s "+N more" / "fold" and "+N more from the form" toggle', async () => {
		const [folded] = containers(cutOf(4), true, () => [machine('NLX-1'), minor('operator', 'Operator', 'Ada')]);
		const html = await render(ContainerNode, { id: folded.id, data: folded });
		noDrag(html, /<button class="xbtn[^"]*"/);
		noDrag(html, /<button class="rtoggle[^"]*"/);
		noDrag(html, /class="slot more-toggle[^"]*"/);
		const unfolded: ContainerData = { ...folded, bundled: false };
		noDrag(await render(ContainerNode, { id: folded.id, data: unfolded }), /<button class="rtoggle[^"]*"/);
	});

	it('the ＋ button of a record card and every slot row', async () => {
		const rec: RecordData = { id: 's:a', type: 'record', kind: 'sample', ref: refOf('physical_samples', 'a', 'S-A'), ins: [], outs: [] };
		noDrag(await render(RecordNode, { id: rec.id, data: rec }), /<button class="xbtn[^"]*"/);
		noDrag(await render(SlotRow, { item: machine('NLX-1') }), /class="slot [^"]*"/);
	});
});

describe('used-in fan cards (D20)', () => {
	const collapsed: ContainerData = {
		id: 'op:u0',
		type: 'container',
		kind: 'operation',
		group: { id: 'op:u0', kind: 'operation', rowIds: ['u0'], batch: null },
		title: 'Turning',
		code: 'OP-17',
		category: 'machining',
		rows: [{ recordId: 'u0', in: 'op:u0:in:0' }],
		// Whatever the data holds, a collapsed container draws none of it.
		slots: [{ field: 'equipment_id', role: 'Machine', ref: refOf('equipment', 'eq1', 'NLX-1'), major: true }],
		settings: [{ label: 'Speed', value: '900' }],
		bundled: false,
		collapsed: true,
		meta: '2026-09-28',
		probable: false,
	};

	it('a collapsed container is its header, its date and one input socket, with the plus button', async () => {
		const html = await render(ContainerNode, { id: collapsed.id, data: collapsed });
		const t = text(html);
		expect(t).toContain('Turning');
		expect(t).toContain('2026-09-28');
		expect(html).not.toContain('class="slots"');
		expect(t).not.toContain('Sample');
		expect(t).not.toContain('Speed');
		expect(ids(html)).toEqual(['op:u0:in:0']);
		expect(html).toContain('aria-label="Expand"');
		expect(html).toContain('collapsed');
	});

	it('an opened container (collapsed gone) draws its rows and Inside tray again', async () => {
		const html = await render(ContainerNode, { id: collapsed.id, data: { ...collapsed, collapsed: undefined, rows: [{ recordId: 'u0', sampleId: 'y0', in: 'op:u0:in:0', out: 'op:u0:out:0' }] } });
		expect(html).toContain('class="slots"');
		expect(ids(html)).toEqual(['op:u0:in:0', 'op:u0:out:0']);
	});

	it('the "+N more" stub says how many and has no sockets', async () => {
		const html = await render(MoreNode, { id: 'more:tools:t1', data: { id: 'more:tools:t1', type: 'more', of: 'tools:t1', remaining: 27 } });
		expect(text(html)).toContain('+27 more');
		expect(html).toContain('role="button"');
		expect(html).toContain('aria-label="Load +27 more"');
		expect(ids(html)).toEqual([]);
	});

	it('a record that has a used-in fan offers a plus button in its slot; one that has none does not', async () => {
		const tool: Slot = { field: 'tool_id', role: 'Tool', ref: refOf('tools', 't1', 'TL-1'), major: true };
		expect(await render(SlotRow, { item: tool })).toContain('Show what else used TL-1');
		expect(await render(SlotRow, { item: minor('operator_person_id', 'Operator', 'Ada') })).not.toContain('Show what else used');
	});

	it('the stub asks the page to load the next page by its own id', () => {
		const a = spies();
		stopping(() => a.expand('more:tools:t1'))({ stopPropagation() {} });
		expect(a.calls).toEqual([['expand', 'more:tools:t1']]);
	});
});

describe('keyboard and screen readers (spec D23)', () => {
	const sample: RecordData = { id: 's:s1', type: 'record', kind: 'sample', ref: { collection: 'physical_samples', id: 's1', code: 'S-0412-A' }, status: 'active', ins: ['s:s1:in:0'], outs: ['s:s1:out:0'] };
	const label = (socket: string, side: 'in' | 'out') => `${side}:${socket}`;

	it('every socket is a tab stop named for what it connects, in a card, a container and a junction', async () => {
		const rec = await render(RecordNode, { id: sample.id, data: sample }, { socketLabel: label });
		expect(rec.match(/tabindex="0"/g)).toHaveLength(2);
		expect(rec).toContain('aria-label="in:s:s1:in:0"');
		expect(rec).toContain('aria-label="out:s:s1:out:0"');

		const [c] = containers(cutOf(4), true);
		const html = await render(ContainerNode, { id: c.id, data: c }, { socketLabel: label });
		const socks = [...html.matchAll(/<span class="sock[^"]*"[^>]*>/g)].map((m) => m[0]);
		expect(socks).toHaveLength(4); // the shared input, two own outputs, the bundle output
		for (const s of socks) expect(s).toMatch(/tabindex="0"[^>]*aria-label="(in|out):/);

		const j: JunctionData = { id: 'j:s1:cut_from', type: 'junction', lineageType: 'cut_from', parentId: 's1', in: 'j:s1:cut_from:in:0', outs: [{ socket: 'j:s1:cut_from:out:0', childId: 'c1', fraction: 0.5 }] };
		const jh = await render(JunctionNode, { id: j.id, data: j }, { socketLabel: label });
		expect(jh.match(/tabindex="0"/g)).toHaveLength(2);
	});

	it('without a page behind it a socket still says which side it is', async () => {
		const html = await render(RecordNode, { id: sample.id, data: sample });
		expect(html).toContain('aria-label="Input socket"');
		expect(html).toContain('aria-label="Output socket"');
	});

	it('a keyboard-focused socket reports itself like a hovered one, and blur lets go', () => {
		const a = spies();
		const el = { matches: (sel: string) => sel === ':focus-visible' } as unknown as HTMLElement;
		const h = socketHandlers(a, () => 'op:o1:in:0');
		h.focus({ currentTarget: el });
		h.blur({ currentTarget: el });
		expect(a.calls).toEqual([['hover', 'op:o1:in:0', el], ['hover', null]]);

		const p = socketProps(a, 'op:o1:out:0', 'out');
		p.onFocus({ currentTarget: el });
		expect(a.calls[2]).toEqual(['hover', 'op:o1:out:0', el]);
		p.onBlur({ currentTarget: el }); // a fresh handler set (a re-render) still pops what the focus pushed
		expect(a.calls[3]).toEqual(['hover', null]);
	});

	it('a mouse click on a socket (pointer focus) leaves the hover stack as mouseenter / mouseleave made it', () => {
		const a = spies();
		const el = { matches: () => false } as unknown as HTMLElement;
		const h = socketHandlers(a, () => 'op:o1:in:0');
		h.enter({ currentTarget: el });
		h.focus({ currentTarget: el }); // not :focus-visible: no second push
		h.leave();
		h.blur({ currentTarget: el }); // and no pop of something it never pushed
		expect(a.calls).toEqual([['hover', 'op:o1:in:0', el], ['hover', null]]);
	});

	it('focus without :focus-visible support counts as keyboard focus (the safe side)', () => {
		const a = spies();
		const el = {} as HTMLElement; // no matches(): the check throws
		socketHandlers(a, () => 's').focus({ currentTarget: el });
		expect(a.calls).toEqual([['hover', 's', el]]);
	});

	it('Inside records carry their ref key, for the canvas keydown', async () => {
		const slot: Slot = { field: 'tool_id', role: 'Tool', ref: refOf('tools', 't1', 'T-1'), major: true };
		expect(await render(SlotRow, { item: slot })).toContain('data-map-id="tools:t1"');
	});

	it('names cards: code and kind, the method for a container, the lineage type for a junction', () => {
		expect(cardLabel(sample)).toBe('S-0412-A, Sample');
		const [c] = containers(cutOf(1));
		expect(cardLabel(c)).toMatch(/, Operation$/);
		const j: JunctionData = { id: 'j:s1:cut_from', type: 'junction', lineageType: 'cut_from', parentId: 's1', in: 'x', outs: [] };
		expect(cardLabel(j)).toBe('Cut from, Lineage');
		expect(cardLabel({ id: 'more:tools:t1', type: 'more', remaining: 3 } as unknown as MapNode)).toBeNull();
	});

	it('labels a socket with the lines of its tooltip, grouping the wires once', () => {
		const op: ContainerData = containers(cutOf(1))[0];
		const nodes = new Map<string, MapNode>([[sample.id, sample], [op.id, op]]);
		const wires: Wire[] = [{ id: 'w', from: 's:s1:out:0', to: `${op.id}:in:0`, carries: 's1', flow: 'sample', bundled: false, origin: 's:s1' }];
		const labelOf = socketLabeller(wires, nodes);
		expect(labelOf(`${op.id}:in:0`, 'in')).toBe('Input: S-0412-A · Sample');
		expect(labelOf('s:s1:out:0', 'out')).toBe('Output: S-0412-A · Sample');
		expect(labelOf('s:s9:out:0', 'out')).toBe('Output: Not connected');
		expect(labelOf(`${op.id}:in:0`, 'in')).toBe(socketLabeller(wires, nodes)(`${op.id}:in:0`, 'in')); // same answer however asked
	});
});

describe('card tweaks: title bar, name line, stacks, chips, ＋/−', () => {
	const turning = (p: Parameters<typeof mkOp>[0] = {}) =>
		mkOp({ code: '10-AA-MF-2023-03-31-F1-30MPM_0.05feed_0.1DoC', sampleId: 'p', outputSampleId: 'p', methodName: 'Turning', category: 'machining', date: DAY, ...p });

	it('the title bar says process | method; the full operation name and its date are in the card', async () => {
		const [c] = containers(mkData({ samples: sam('p'), operations: [turning({ id: 'o1' })] }));
		const html = await render(ContainerNode, { id: c.id, data: c });
		expect(/<span class="m"[^>]*>([^<]*)</.exec(html)?.[1]).toBe('Machining | Turning');
		expect(html).toMatch(/class="code n"[^>]*>10-AA-MF-2023-03-31-F1-30MPM_0\.05feed_0\.1DoC</);
		expect(text(html)).toContain('1 Sept 2026');
	});

	it('a test says Test | its type', async () => {
		const [c] = containers(mkData({ samples: sam('s1'), tests: [mkTest({ id: 't1', subjectSampleIds: ['s1'], testType: 'Tensile' })] }));
		expect(/<span class="m"[^>]*>([^<]*)</.exec(await render(ContainerNode, { id: c.id, data: c }))?.[1]).toBe('Test | Tensile');
	});

	it('a stack is a deck: ×N in the title bar, "N passes", and Unstack', async () => {
		const ops = ['a', 'b', 'c'].map((id, i) => turning({ id, methodId: 'turn', date: `2026-09-0${i + 1}T09:00:00Z` }));
		const data = mkData({ samples: sam('p'), operations: ops });
		const [c] = buildGraph(data, groupBatches(ops, [], { probable: true, stack: true }), { slots: () => [] }).nodes.filter((n): n is ContainerData => n.type === 'container');
		const a = spies();
		const calls: unknown[] = [];
		const html = await render(ContainerNode, { id: c.id, data: c }, undefined, { ...a, unstack: (id: string) => void calls.push(id) });
		expect(html).toMatch(/class="[^"]*\bstacked\b/);
		expect(text(html)).toContain('×3');
		expect(text(html)).toContain('3 passes');
		expect(html).toContain('aria-label="Unstack 3 passes"');
		expect(ids(html)).toEqual([`${c.id}:in:0`, `${c.id}:out:0`]);
	});

	it('a stacked card: double-click on its body unstacks it, with a hint on the button; a pass of an unstacked stack restacks; buttons and sockets do nothing extra', async () => {
		const ops = ['a', 'b', 'c'].map((id, i) => turning({ id, methodId: 'turn', date: `2026-09-0${i + 1}T09:00:00Z` }));
		const data = mkData({ samples: sam('p'), operations: ops });
		const stacked = buildGraph(data, groupBatches(ops, [], { probable: true, stack: true }), { slots: () => [] }).nodes.find((n): n is ContainerData => n.type === 'container')!;
		const html = await render(ContainerNode, { id: stacked.id, data: stacked });
		expect(html).toMatch(/title="[^"]*double-click[^"]*"[^>]*>Unstack</);
		const a = spies();
		const body = { stopPropagation: vi.fn(), target: { closest: () => null } };
		const inner = (sel: string) => ({ stopPropagation: vi.fn(), target: { closest: (s: string) => (s.includes(sel) ? {} : null) } });
		const stack = cardHandlers(a, () => stacked.id, () => false, () => 'unstack');
		stack.dblclick(body);
		for (const sel of ['button', '.sock', '.slots']) stack.dblclick(inner(sel));
		expect(a.calls).toEqual([['unstack', stacked.id]]);
		const pass = cardHandlers(a, () => 'op:b', () => false, () => 'restack');
		pass.dblclick(body);
		pass.dblclick(inner('button'));
		cardHandlers(a, () => 'op:z', () => false, () => null).dblclick(body); // a card that is no pass of a stack
		cardHandlers(a, () => 'op:z').dblclick(body);
		expect(a.calls).toEqual([['unstack', stacked.id], ['restack', 'op:b']]);
	});

	it('the card of a pass of an unstacked stack is marked, and a stack is not', async () => {
		const ops = ['a', 'b'].map((id, i) => turning({ id, methodId: 'turn', date: `2026-09-0${i + 1}T09:00:00Z` }));
		const data = mkData({ samples: sam('p'), operations: ops });
		const g = buildGraph(data, groupBatches(ops, [], { probable: true, stack: true, unstacked: new Set(['a', 'b']) }), { slots: () => [], unstackedGroups: [['a', 'b']] });
		const c = g.nodes.find((n): n is ContainerData => n.type === 'container')!;
		expect(c.unstackedPass).toBe(true);
	});

	it('an expanded card draws − and its button collapses', async () => {
		const [c] = containers(cutOf(1));
		const html = await render(ContainerNode, { id: c.id, data: c }, { expanded: ref(new Set([c.id])) });
		expect(html).toContain('aria-label="Collapse"');
		expect(html).toContain('>remove<');
		const calls: unknown[][] = [];
		const a: MapActions = { ...spies(), expand: (id) => void calls.push(['expand', id]), collapse: (id) => void calls.push(['collapse', id]) };
		const ev = { stopPropagation() {}, currentTarget: null };
		cardHandlers(a, () => c.id, () => true).expand(ev);
		cardHandlers(a, () => c.id, () => false).expand(ev);
		expect(calls).toEqual([['collapse', c.id], ['expand', c.id]]);
		const rec: RecordData = { id: 's:a', type: 'record', kind: 'sample', ref: refOf('physical_samples', 'a', 'S-A'), ins: [], outs: [] };
		expect(await render(RecordNode, { id: rec.id, data: rec }, { expanded: ref(new Set(['s:a'])) })).toContain('aria-label="Collapse"');
	});

	it('a slot is one chip: the whole chip is the record, a tool shows its name', async () => {
		const tool: Slot = { field: 'tool_id', role: 'Tool', ref: { collection: 'tools', id: 't1', code: '6576cc99', label: 'Roughing holder' }, major: true };
		const html = await render(SlotRow, { item: tool });
		expect(html).toMatch(/<div class="slot nodrag nopan[^"]*"[^>]*role="button"[^>]*data-map-id="tools:t1"/);
		expect(text(html)).toContain('Roughing holder');
		expect(text(html)).not.toContain('6576cc99');
		expect(html).toContain('aria-label="Show what else used Roughing holder"');
		const open = await render(SlotRow, { item: tool }, { expanded: ref(new Set(['tools:t1'])) });
		expect(open).toContain('aria-label="Hide what else used Roughing holder"');
		// A tool's own card (the root of its used-in fan) is named the same way, its code under it.
		const card: RecordData = { id: 'f:tools:t1', type: 'record', kind: 'tool', ref: tool.ref!, ins: [], outs: [] };
		const rec = text(await render(RecordNode, { id: card.id, data: card }));
		expect(rec).toContain('Roughing holder');
		expect(rec).toContain('6576cc99');
		// A minor slot (Owner, Campaign...) is the same chip.
		expect(await render(SlotRow, { item: minor('owner', 'Owner', 'Bob') })).toMatch(/class="slot nodrag nopan one"/);
	});
});

describe('planned and draft cards (ADR-0019, edit mode)', () => {
	it('a planned container and a planned sample get the planned class, a draft one the draft class, a recorded one neither', async () => {
		const data = mkData({
			samples: [mkSample('s1'), mkSample('s2', { status: 'planned' })],
			operations: [mkOp({ id: 'cut', sampleId: 's1', outputSampleId: 's2', workState: 'planned', draft: true })],
		});
		const g = buildGraph(data, groupsOf(data), { slots: () => [] });
		const c = g.nodes.find((x): x is ContainerData => x.type === 'container')!;
		const r = g.nodes.find((x) => x.id === 's:s2') as RecordData;
		const plain = g.nodes.find((x) => x.id === 's:s1') as RecordData;
		const cls = (html: string) => /class="(node [^"]*)"/.exec(html)?.[1].split(' ') ?? [];
		expect(cls(await render(ContainerNode, { id: c.id, data: c }))).toEqual(expect.arrayContaining(['planned', 'draft']));
		expect(cls(await render(RecordNode, { id: r.id, data: r }))).toContain('planned');
		expect(cls(await render(RecordNode, { id: r.id, data: r }))).not.toContain('draft');
		expect(cls(await render(RecordNode, { id: plain.id, data: plain }))).not.toContain('planned');
		expect(cls(await render(ContainerNode, { id: c.id, data: { ...c, planned: undefined, draft: undefined } }))).not.toContain('planned');
		expect(text(await render(RecordNode, { id: r.id, data: r }))).toContain('Planned'); // the status badge: no extra pill needed
	});
});
