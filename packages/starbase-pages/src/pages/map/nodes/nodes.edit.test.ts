import { describe, expect, it, vi } from 'vitest';
import { createSSRApp, defineComponent, h, ref, type Component } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { setExplorerHostFactory, type DraftBody, type DraftItem, type ExplorerHost } from '@d1/ui';
import { apply, emptyBody, type DraftAction } from '../edit/draft';
import { EDIT_MODE_KEY, type EditMode } from '../edit/useEditMode';
import { draftKeysOfNode, newOperationOf } from '../edit/socketRefs';
import { toGraph } from '../edit/toGraph';
import { buildGraph } from '../model/buildGraph';
import { groupBatches } from '../model/groupBatches';
import type { ContainerNode as ContainerData, MapNode, RecordNode as RecordData } from '../model/types';
import { nodeOfSocket } from '../model/sockets';
import { MAP_ACTIONS, MAP_EDIT, MAP_VIEW, editSocketProps, type KindPick, type MapActions, type MapEdit } from './actions';
import ContainerNode from './ContainerNode.vue';
import RecordNode from './RecordNode.vue';
import WireEdge from './WireEdge.vue';

// Edit mode in the cards: free sockets are buttons, sockets that can be built from carry what the page needs to find them, a new
// operation offers ＋ output, and a card whose checks block Create wears the number. View mode draws none of it.
vi.mock('@vue-flow/core', async (orig) => ({
	...(await orig<typeof import('@vue-flow/core')>()),
	Handle: defineComponent({
		props: { id: String, type: String, position: String },
		setup: (p) => () => h('span', { class: 'sock', 'data-id': p.id, 'data-type': p.type }),
	}),
}));

const VIcon = defineComponent({ props: { name: String }, setup: (p) => () => h('i', { class: 'v-icon' }, p.name) });
const noop: MapActions = { select() {}, expand() {}, hover() {}, toggleRows() {}, toggleMore() {} };

const run = (actions: DraftAction[], from: DraftBody = emptyBody()): DraftBody => actions.reduce((b, a) => apply(b, a), from);
const graphOf = (body: DraftBody) => {
	const data = toGraph(null, body);
	const groups = groupBatches(data.operations, data.tests, { probable: false, stack: true });
	return buildGraph(data, groups, { slots: () => [] });
};
const nodesOf = (body: DraftBody): MapNode[] => graphOf(body).nodes;
/** `wiredSockets` as the page has it: the sockets of a card that a wire of the drawn graph touches. */
const wiredBy = (body: DraftBody) => (n: MapNode): ReadonlySet<string> => {
	const out = new Set<string>();
	for (const w of graphOf(body).wires) for (const s of [w.from, w.to]) if (nodeOfSocket(s) === n.id) out.add(s);
	return out;
};
const samples = (body: DraftBody) => nodesOf(body).filter((n): n is RecordData => n.type === 'record' && n.kind === 'sample');
const containers = (body: DraftBody) => nodesOf(body).filter((n): n is ContainerData => n.type === 'container');

function edit(over: Partial<MapEdit> = {}): MapEdit & { calls: unknown[][] } {
	const calls: unknown[][] = [];
	return {
		calls,
		editing: ref(true),
		drop: ref(null),
		socketDown: (...a) => void calls.push(['down', ...a]),
		socketKey: (...a) => void calls.push(['key', ...a]),
		socketClick: (...a) => void calls.push(['click', ...a]),
		badge: () => null,
		wiredSockets: () => new Set(),
		selectedWire: ref(null),
		selectWire: (id) => void calls.push(['selectWire', id]),
		lockOf: () => null,
		wireLock: () => null,
		...over,
	};
}

setExplorerHostFactory(() => ({ api: { get: async () => ({ data: { data: [] } }) } }) as unknown as ExplorerHost);
const defOf = (field: string, sort: number, meta: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({ field, type: 'string', schema: { data_type: 'text', is_nullable: true }, meta: { interface: 'input', sort, width: 'half', ...meta }, ...extra });
/** What the fields on a card read of edit mode: its draft, its checks and the form's field definitions. */
function fakeEditMode(body: DraftBody, _item?: DraftItem): EditMode {
	return {
		body: ref(body),
		checks: ref([]),
		setValues: () => undefined,
		catalog: {
			rawFields: ref({
				physical_samples: [defOf('nickname', 1), defOf('material_id', 2), defOf('form', 3), defOf('primary_method_id', 4)],
				manufacturing_operations: [defOf('equipment_id', 1), defOf('planned_date', 2), defOf('machining_feed_mm_per_rev', 3)],
				test_sessions: [],
			}),
			ctx: () => ({}),
			methodById: ref(new Map()),
		},
	} as unknown as EditMode;
}

async function render(component: Component, props: Record<string, unknown>, e?: MapEdit, editMode?: EditMode): Promise<string> {
	const app = createSSRApp(component, props);
	if (editMode) app.provide(EDIT_MODE_KEY, editMode);
	app.component('v-icon', VIcon);
	app.provide(MAP_ACTIONS, noop);
	app.provide(MAP_VIEW, { direction: ref<'RIGHT' | 'DOWN'>('RIGHT'), moreOpen: ref(new Set<string>()), selectedRef: ref(null), selectedId: ref(props.selected ? (props.id as string) : null) });
	if (e) app.provide(MAP_EDIT, e);
	return renderToString(app);
}
const socks = (html: string) => [...html.matchAll(/data-sock="([^"]*)"/g)].map((m) => m[1]);
const freeButtons = (html: string) => [...html.matchAll(/<button[^>]*class="[^"]*\bsock\b[^"]*\bfree\b[^"]*"[^>]*>/g)].map((m) => m[0]);

describe('a draft card is not a record yet', () => {
	it('has no ＋ (Expand): its id is not a record', async () => {
		const body = run([{ type: 'addSample' }, { type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'm' }, from: { key: 'n1' } }]);
		const [s] = samples(body);
		const [c] = containers(body);
		expect(await render(RecordNode, { id: s.id, data: s }, edit())).not.toContain('class="xbtn');
		expect(await render(ContainerNode, { id: c.id, data: c }, edit())).not.toContain('class="xbtn');
	});
});

describe('a sample card in edit mode', () => {
	it('has a free output to build from, and a free input when a new sample has nothing making it', async () => {
		const [s] = samples(run([{ type: 'addSample' }]));
		const html = await render(RecordNode, { id: s.id, data: s }, edit());
		expect(socks(html).sort()).toEqual(['sample|draft:n1|in', 'sample|draft:n1|out']);
		expect(freeButtons(html)).toHaveLength(2);
		expect(html).toContain('Free input of New sample');
		expect(html).toContain('Free output of New sample');
	});

	it('shows the socket of each wire, and a free one on a side only while selected (R5)', async () => {
		const body = run([{ type: 'addSample' }, { type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'm' }, from: { key: 'n1' } }, { type: 'addSample', from: { key: 'n2', row: 0 } }]);
		const made = samples(body).find((s) => s.ref.id === 'draft:n4')!;
		const e = edit({ wiredSockets: wiredBy(body) });
		// Made by an operation: its input is a wire's socket already, its output has none: only that one is free.
		const idle = await render(RecordNode, { id: made.id, data: made, selected: false }, e);
		expect(freeButtons(idle)).toHaveLength(1);
		expect(idle).toContain('Free output of');
		expect(socks(idle).sort()).toEqual(['sample|draft:n4|in', 'sample|draft:n4|out']);
		// Selected: still no free input, whatever the selection. An operation makes it already, and a sample has one maker.
		const picked = await render(RecordNode, { id: made.id, data: made, selected: true }, e);
		expect(freeButtons(picked)).toHaveLength(1);
		expect(freeButtons(picked)[0]).toContain('Free output');
		expect(socks(picked).filter((s) => s.endsWith('|in'))).toHaveLength(1);
	});

	it('has no free input once an operation makes it, selected or not (the input is a socket already, a place to drop; a sample has one maker)', async () => {
		const body = run([{ type: 'addSample' }, { type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'm' }, from: { key: 'n1' } }, { type: 'addSample', from: { key: 'n2', row: 0 } }]);
		const made = samples(body).find((s) => s.ref.id === 'draft:n4')!;
		const e = edit({ wiredSockets: wiredBy(body) });
		for (const selected of [false, true]) {
			const html = await render(RecordNode, { id: made.id, data: made, selected }, e);
			expect(freeButtons(html).filter((b) => b.includes('Free input'))).toHaveLength(0);
			expect(socks(html).filter((x) => x.endsWith('|in'))).toEqual(['sample|draft:n4|in']);
		}
	});

	it('a sample with a wire out keeps its socket and a free one beside it only while selected', async () => {
		const body = run([{ type: 'addSample' }, { type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'm' }, from: { key: 'n1' } }]);
		const [s] = samples(body);
		const e = edit({ wiredSockets: wiredBy(body) });
		const idle = await render(RecordNode, { id: s.id, data: s, selected: false }, e);
		expect(freeButtons(idle).filter((b) => b.includes('Free output'))).toHaveLength(0);
		expect(idle).toMatch(/data-id="s:draft:n1:out:0"/);
		const picked = await render(RecordNode, { id: s.id, data: s, selected: true }, e);
		expect(picked).toContain('Free output of');
		expect(picked).toMatch(/data-id="s:draft:n1:out:0"/);
	});

	it('offers the output of a sample of the loaded history too (the page adds it to the draft on first use), but no input', async () => {
		const old: RecordData = { id: 's:old', type: 'record', kind: 'sample', ref: { collection: 'physical_samples', id: 'old', code: 'S-1' }, ins: ['s:old:in:0'], outs: ['s:old:out:0'] };
		const html = await render(RecordNode, { id: old.id, data: old }, edit());
		expect(socks(html)).toEqual(['sample|old|out']);
		expect(freeButtons(html)).toHaveLength(1);
	});

	it('offers nothing to build from on a card that is not a sample', async () => {
		const lot: RecordData = { id: 'lot:1', type: 'record', kind: 'stock_lot', ref: { collection: 'raw_stock_lots', id: '1', code: 'L-1' }, ins: [], outs: ['lot:1:out:0'] };
		expect(socks(await render(RecordNode, { id: lot.id, data: lot }, edit()))).toEqual([]);
	});

	it('is plain in view mode, and while not editing', async () => {
		const [s] = samples(run([{ type: 'addSample' }]));
		for (const e of [undefined, edit({ editing: ref(false) })]) {
			const html = await render(RecordNode, { id: s.id, data: s }, e);
			expect(socks(html)).toEqual([]);
			expect(freeButtons(html)).toHaveLength(0);
		}
	});

	it('says how many things are missing in amber, with the words for a screen reader', async () => {
		const [s] = samples(run([{ type: 'addSample' }]));
		const html = await render(RecordNode, { id: s.id, data: s }, edit({ badge: () => ({ count: 2, text: 'Choose the material. Choose the method.', level: 'fill' as const }) }));
		expect(html).toMatch(/class="(?:chk fill|fill chk)"[^>]*aria-label="Choose the material\. Choose the method\."[^>]*>2 missing</);
	});

	it('says "ready" in green on a new sample whose fields are drawn and nothing is missing, and nothing on one with no fields', async () => {
		const [s] = samples(run([{ type: 'addSample' }]));
		const item = run([{ type: 'addSample' }]).items[0];
		const drawn = { fieldsOf: () => item, fieldNames: () => ['nickname', 'material_id'] };
		expect(await render(RecordNode, { id: s.id, data: s }, edit(drawn))).toMatch(/class="chk ready"[^>]*>ready</);
		expect(await render(RecordNode, { id: s.id, data: s }, edit())).not.toContain('class="chk');
		// the form's definitions are not read yet: the card is empty, so it does not say "ready" over it
		expect(await render(RecordNode, { id: s.id, data: s }, edit({ fieldsOf: () => item, fieldNames: () => [] }))).not.toContain('ready');
		// something is missing: the count, not "ready"
		const missing = await render(RecordNode, { id: s.id, data: s }, edit({ ...drawn, badge: () => ({ count: 1, text: 'x', level: 'fill' as const }) }));
		expect(missing).not.toContain('ready');
	});

	it('draws the card\'s fields below its header once edit mode gives it an item', async () => {
		const body = run([{ type: 'addSample' }]);
		const [s] = samples(body);
		const html = await render(RecordNode, { id: s.id, data: s }, edit({ fieldsOf: () => body.items[0] }), fakeEditMode(body));
		expect(html).toContain('class="card-fields nodrag nopan nowheel"');
		expect(html).toContain('data-field="nickname"');
		expect(html).toContain('data-field="primary_method_id"');
		expect(await render(RecordNode, { id: s.id, data: s }, edit({ fieldsOf: () => body.items[0] }))).not.toContain('card-fields'); // no edit mode provided: nothing to type into
	});
});

describe('a container in edit mode', () => {
	it('draws a blank operation as a row with a free input; its output is a socket with nothing on it', async () => {
		const body = run([{ type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'm' } }]);
		const [c] = containers(body);
		expect(c.rows).toHaveLength(1);
		expect(c.draft).toBe(true);
		const html = await render(ContainerNode, { id: c.id, data: c }, edit());
		expect(socks(html)).toEqual(['row|draft:n2|in', 'row|draft:n2|out']);
		expect(freeButtons(html)).toHaveLength(2); // nothing is wired: a free socket on each side, none more
		expect(html).toContain('rail-sock in free'); // on the rail, at the left edge
		expect(html).toContain('Makes 1 sample');
	});

	it('draws a blank test with only a free input: nothing comes out of a test', async () => {
		const [c] = containers(run([{ type: 'addContainer', kind: 'test', source: { from: 'blank', testType: 'tensile' } }]));
		const html = await render(ContainerNode, { id: c.id, data: c }, edit());
		expect(socks(html)).toEqual(['row|draft:n1|in']);
		expect(freeButtons(html)).toHaveLength(1);
	});

	it('keeps the socket of a wire as a socket, and a side with nothing on it gets the one free button', async () => {
		const body = run([{ type: 'addSample' }, { type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'm' }, from: { key: 'n1' } }]);
		const [c] = containers(body);
		expect(c.rows[0].in).toBeTruthy();
		const html = await render(ContainerNode, { id: c.id, data: c }, edit({ wiredSockets: wiredBy(body) }));
		expect(socks(html)).toEqual(['row|draft:n3|in', 'row|draft:n3|out']);
		expect(html).toMatch(/data-id="op:draft:n3:in:0"/); // the input has its wire: a socket of its own
		expect(freeButtons(html)).toHaveLength(1); // the output has none: the free one, and no spare Handle beside it
		expect(html).not.toMatch(/data-id="op:draft:n3:out:0"/);
	});

	it('gives each row of a cut its own socket, a free one for each piece that has no wire yet', async () => {
		const body = run([{ type: 'addSample' }, { type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'm' }, rows: 3, from: { key: 'n1' } }]);
		const [c] = containers(body);
		const html = await render(ContainerNode, { id: c.id, data: c }, edit({ wiredSockets: wiredBy(body) }));
		expect(socks(html).filter((s) => s.endsWith('|out'))).toEqual(['row|draft:n3|out', 'row|draft:n4|out', 'row|draft:n5|out']);
		expect(freeButtons(html).filter((b) => b.includes(' out '))).toHaveLength(3);
		// Nothing is wired out of the pieces, so the card does not claim to make samples: Create writes them as operations that make none (in place).
		expect(html.match(/class="sum"[^>]*>([^<]*)/)?.[1]).toMatch(/in place/);
	});

	it('once a piece is wired its socket stays; the pieces that have none keep theirs, and the selected card has one more that adds a piece', async () => {
		const body = run([
			{ type: 'addSample' },
			{ type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'm' }, rows: 3, from: { key: 'n1' } },
			{ type: 'addSample', from: { key: 'n2', row: 0 } },
		]);
		const [c] = containers(body);
		const e = edit({ wiredSockets: wiredBy(body) });
		const idle = await render(ContainerNode, { id: c.id, data: c, selected: false }, e);
		expect(socks(idle).filter((s) => s.endsWith('|out'))).toEqual(['row|draft:n3|out', 'row|draft:n4|out', 'row|draft:n5|out']);
		expect(freeButtons(idle).filter((b) => b.includes(' out '))).toHaveLength(2); // the pieces with no wire
		const picked = await render(ContainerNode, { id: c.id, data: c, selected: true }, e);
		expect(socks(picked).filter((s) => s.endsWith('|out'))).toEqual(['row|draft:n3|out', 'row|draft:n4|out', 'row|draft:n5|out']);
	});

	it('has no ＋ output row: a connection to the free socket adds the piece', async () => {
		const [c] = containers(run([{ type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'm' } }]));
		const html = await render(ContainerNode, { id: c.id, data: c }, edit());
		expect(html).not.toContain('addrow');
		expect(html).not.toContain('Add an output');
	});

	it('when every row has a wire on a side, the selected card offers a free socket that adds a row', async () => {
		const body = run([
			{ type: 'addSample' },
			{ type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'm' }, from: { key: 'n1' } },
			{ type: 'addSample', from: { key: 'n2', row: 0 } },
		]);
		const [c] = containers(body);
		const e = edit({ wiredSockets: wiredBy(body) });
		expect(socks(await render(ContainerNode, { id: c.id, data: c, selected: false }, e))).toEqual(['row|draft:n3|in', 'row|draft:n3|out']);
		const picked = socks(await render(ContainerNode, { id: c.id, data: c, selected: true }, e));
		expect(picked).toEqual(['row|draft:n3|in', 'row|draft:n3|in|add', 'row|draft:n3|out', 'row|draft:n3|out|add']);
	});

	it('wears an amber "N missing" for what can still be filled in', async () => {
		const [c] = containers(run([{ type: 'addContainer', kind: 'operation', source: { from: 'blank' } }]));
		const html = await render(ContainerNode, { id: c.id, data: c }, edit({ badge: () => ({ count: 1, text: 'No machine yet.', level: 'fill' as const }) }));
		expect(html).toMatch(/class="(?:chk fill|fill chk)"[^>]*aria-label="No machine yet\."[^>]*>1 missing</);
	});

	it('wears a red "N refused" only for what the server would refuse', async () => {
		const [c] = containers(run([{ type: 'addContainer', kind: 'operation', source: { from: 'blank' } }]));
		const html = await render(ContainerNode, { id: c.id, data: c }, edit({ badge: () => ({ count: 3, text: 'Not allowed.', level: 'refused' as const }) }));
		expect(html).toMatch(/class="(?:chk refused|refused chk)"[^>]*>3 refused</);
	});

	it('says "ready" on a new operation with its fields drawn and nothing missing', async () => {
		const body = run([{ type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'm' } }]);
		const [c] = containers(body);
		expect(await render(ContainerNode, { id: c.id, data: c }, edit({ fieldsOf: () => body.items[0], fieldNames: () => ['equipment_id'] }))).toMatch(/class="chk ready"[^>]*>ready</);
		expect(await render(ContainerNode, { id: c.id, data: c }, edit())).not.toContain('ready');
		// the form's definitions are not read yet: nothing is drawn on the card, so it is not "ready"
		expect(await render(ContainerNode, { id: c.id, data: c }, edit({ fieldsOf: () => body.items[0], fieldNames: () => [] }))).not.toContain('ready');
	});

	it('draws the fields typed on the card, and leaves out of the Inside tray and the settings list only what they would repeat', async () => {
		const body = run([{ type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'm' } }]);
		const [c] = containers(body);
		const item = { ...body.items[0], values: { ...body.items[0].values, process_category: 'machining' } } as DraftItem;
		const ref = (collection: string, code: string) => ({ collection, id: code, code });
		const full: ContainerData = {
			...c,
			slots: [
				{ field: 'equipment_id', role: 'Machine', ref: ref('equipment', 'M1'), major: true },
				{ field: 'tool_id', role: 'Tool', ref: ref('tools', 'T1'), major: true },
				{ field: 'operator_person_id', role: 'Operator', ref: ref('people', 'Ada'), major: false },
			],
			settings: [{ label: 'Feed', value: '0.2 mm/rev' }],
		};
		const typed = edit({ fieldsOf: () => item, fieldNames: () => ['equipment_id', 'planned_date'] });
		const withFields = await render(ContainerNode, { id: c.id, data: full }, typed, fakeEditMode(run([]), item));
		expect(withFields).toContain('class="card-fields nodrag nopan nowheel"');
		// the machine is typed on the card; what was set only in the side panel (a tool, an operator) is still drawn
		const tray = withFields.slice(withFields.indexOf('class="slots"'));
		expect(tray).toContain('Tool');
		expect(tray).not.toContain('Machine');
		expect(withFields).toContain('+1 more from the form');
		expect(withFields).not.toContain('class="params"');
		const without = await render(ContainerNode, { id: c.id, data: full }, edit());
		expect(without).toContain('Machine');
		expect(without).toContain('class="params"');
		// the definitions are not read yet: the tray is whole until the fields are there
		expect(await render(ContainerNode, { id: c.id, data: full }, edit({ fieldsOf: () => item, fieldNames: () => [] }))).toContain('Machine');
	});

	it('wears the Planned / Done chip of a new operation (R9), and none without edit mode or when the page offers none', async () => {
		const [c] = containers(run([{ type: 'addContainer', kind: 'operation', source: { from: 'blank' } }]));
		const chip = (state: 'planned' | 'done') => edit({ work: () => ({ state, label: `label ${state}`, toggle() {} }) });
		const planned = await render(ContainerNode, { id: c.id, data: c }, chip('planned'));
		expect(planned).toMatch(/<button[^>]*class="[^"]*\bwchip\b[^"]*"[^>]*aria-label="label planned"[^>]*data-work="planned"[^>]*>Planned</);
		const done = await render(ContainerNode, { id: c.id, data: c }, chip('done'));
		expect(done).toMatch(/data-work="done"[^>]*>Done</);
		expect(await render(ContainerNode, { id: c.id, data: c }, edit())).not.toContain('wchip');
		expect(await render(ContainerNode, { id: c.id, data: c })).not.toContain('wchip');
		expect(await render(ContainerNode, { id: c.id, data: c }, edit({ editing: ref(false), work: () => ({ state: 'planned', label: 'x', toggle() {} }) }))).not.toContain('wchip');
	});

	it('is plain in view mode: a recorded operation has none of it, and a draft one without edit mode neither', async () => {
		const [c] = containers(run([{ type: 'addContainer', kind: 'operation', source: { from: 'blank' } }]));
		const html = await render(ContainerNode, { id: c.id, data: c });
		expect(socks(html)).toEqual([]);
		expect(freeButtons(html)).toHaveLength(0);
		expect(html).not.toContain('class="chk');
		const recorded: ContainerData = { ...c, id: 'op:x', draft: undefined, group: { ...c.group, rowIds: ['x'] }, rows: [{ recordId: 'x', in: 'op:x:in:0', out: 'op:x:out:0' }] };
		expect(socks(await render(ContainerNode, { id: recorded.id, data: recorded }, edit()))).toEqual([]);
	});
});

describe('the props of a socket in edit mode', () => {
	it('carry what the page finds the socket by, and report the pointer and the keys', () => {
		const e = edit();
		const p = editSocketProps(e, { kind: 'row', id: 'draft:n3', side: 'in' });
		expect(p['data-sock']).toBe('row|draft:n3|in');
		expect(p.class).toEqual({ editable: true, 'drop-ok': false, 'drop-bad': false });
		// A wired socket is a span: while editing it is a button, and says which keys work.
		expect(p.role).toBe('button');
		expect(p['aria-keyshortcuts']).toBe('Enter C');
		p.onPointerdown({} as PointerEvent);
		p.onKeydown({} as KeyboardEvent);
		p.onClick({} as MouseEvent);
		expect(e.calls.map((c) => c[0])).toEqual(['down', 'key', 'click']);
		expect(e.calls[0][1]).toEqual({ kind: 'row', id: 'draft:n3', side: 'in' });
	});

	it('are marked green or red while a dragged wire is over the socket', () => {
		const e = edit({ drop: ref({ sock: 'row|draft:n3|in', ok: true }) });
		expect(editSocketProps(e, { kind: 'row', id: 'draft:n3', side: 'in' }).class).toMatchObject({ 'drop-ok': true, 'drop-bad': false });
		e.drop.value = { sock: 'row|draft:n3|in', ok: false };
		expect(editSocketProps(e, { kind: 'row', id: 'draft:n3', side: 'in' }).class).toMatchObject({ 'drop-ok': false, 'drop-bad': true });
		expect(editSocketProps(e, { kind: 'row', id: 'draft:n3', side: 'out' }).class).toMatchObject({ 'drop-ok': false, 'drop-bad': false });
	});
});

describe('the cards of a draft', () => {
	it('say which draft items they are made of, and a new operation can take another output row', () => {
		const body = run([{ type: 'addSample' }, { type: 'addContainer', kind: 'operation', source: { from: 'blank' }, from: { key: 'n1' } }]);
		const [c] = containers(body);
		expect(draftKeysOfNode(body, c)).toEqual(['n2']);
		expect(newOperationOf(body, 'n2')).not.toBeNull();
	});
});

describe('a planned record the draft deletes', () => {
	const sample: RecordData = { id: 's:s3', type: 'record', kind: 'sample', ref: { collection: 'physical_samples', id: 's3', code: 'S-3' }, status: 'planned', ins: [], outs: ['s:s3:out:0'], planned: true, removing: true };
	const op: ContainerData = {
		id: 'op:o2', type: 'container', kind: 'operation', group: { id: 'op:o2', kind: 'operation', rowIds: ['o2'], batch: null }, title: 'Cut', code: 'OP-2', category: 'machining',
		rows: [], slots: [], settings: [], bundled: false, probable: false, planned: true, removing: true,
	};

	it('is struck through by its class, whatever the card is', async () => {
		expect(await render(RecordNode, { id: sample.id, data: sample }, edit())).toMatch(/class="[^"]*\bremoving\b/);
		expect(await render(ContainerNode, { id: op.id, data: op }, edit())).toMatch(/class="[^"]*\bremoving\b/);
		expect(await render(RecordNode, { id: sample.id, data: { ...sample, removing: undefined } }, edit())).not.toMatch(/\bremoving\b/);
	});
});

describe('the lock on a done record', () => {
	const reason = "Done records can't be removed from the map";
	const done: RecordData = { id: 's:s1', type: 'record', kind: 'sample', ref: { collection: 'physical_samples', id: 's1', code: 'S-1' }, status: 'active', ins: [], outs: ['s:s1:out:0'] };
	const cut: ContainerData = {
		id: 'op:o1', type: 'container', kind: 'operation', group: { id: 'op:o1', kind: 'operation', rowIds: ['o1'], batch: null }, title: 'Cut', code: 'OP-1', category: 'machining',
		rows: [], slots: [], settings: [], bundled: false, probable: false,
	};

	it('is worn by the selected card, with the reason as text and as its label', async () => {
		for (const [component, data] of [[RecordNode, done], [ContainerNode, cut]] as const) {
			const html = await render(component, { id: data.id, data, selected: true }, edit({ lockOf: () => reason }));
			expect(html).toContain('class="lock"');
			expect(html).toContain(`aria-label="${reason.replace(/'/g, '&#39;')}"`);
			expect(html.replace(/<[^>]+>/g, ' ')).toContain("Done records can't be removed from the map".replace(/'/g, '&#39;'));
		}
	});

	it('is not worn by a card that is not selected, nor outside edit mode, nor by one that can go', async () => {
		expect(await render(RecordNode, { id: done.id, data: done, selected: false }, edit({ lockOf: () => reason }))).not.toContain('class="lock"');
		expect(await render(RecordNode, { id: done.id, data: done, selected: true })).not.toContain('class="lock"');
		expect(await render(RecordNode, { id: done.id, data: done, selected: true }, edit({ lockOf: () => null }))).not.toContain('class="lock"');
		expect(await render(RecordNode, { id: done.id, data: done, selected: true }, edit({ editing: ref(false), lockOf: () => reason }))).not.toContain('class="lock"');
	});
});

describe('a wire in edit mode', () => {
	const wire = { id: 'a:out:0>b:in:0', from: 'a:out:0', to: 'b:in:0', carries: null, flow: 'sample' as const, bundled: false, origin: 'a' };
	const props = { id: wire.id, source: 'a', target: 'b', sourceX: 0, sourceY: 0, targetX: 100, targetY: 40, sourcePosition: 'right', targetPosition: 'left', data: { wire, tooltip: [] } };

	it('the selected wire is marked, and a wire of done records wears a padlock with the reason', async () => {
		const reason = "Done records' wires can't be removed from the map";
		const html = await render(WireEdge, props, edit({ selectedWire: ref(wire.id), wireLock: () => reason }));
		expect(html).toMatch(/class="d1-wire sel"/);
		expect(html).toContain('class="lock"');
		expect(html).toMatch(/<title[^>]*>Done records&#39; wires can&#39;t be removed from the map<\/title>/);
	});

	it('another wire, or no edit mode, is drawn as it was', async () => {
		expect(await render(WireEdge, props, edit({ selectedWire: ref('other'), wireLock: () => 'x' }))).not.toContain('sel');
		expect(await render(WireEdge, props)).not.toContain('class="lock"');
		expect(await render(WireEdge, props, edit({ editing: ref(false), selectedWire: ref(wire.id) }))).not.toMatch(/\bsel\b/);
	});
});

describe('the kind dropdown of a new card (K3)', () => {
	const pick = (over: Partial<KindPick> = {}): KindPick => ({ kind: 'operation', value: null, methods: [{ id: 'm1', name: 'Turning', code: 'T', category: 'machining' }], testTypes: [], choose() {}, ...over });
	const select = (html: string) => /<select[^>]*data-kind-select[^>]*>/.exec(html)?.[0];

	it('is drawn under the header of a new operation, with the choice and the lists the page gave', async () => {
		const [c] = containers(run([{ type: 'addContainer', kind: 'operation', source: { from: 'blank' } }]));
		const html = await render(ContainerNode, { id: c.id, data: c }, edit({ kind: () => pick({ value: 'm1' }) }));
		expect(select(html)).toContain('aria-label="Kind of operation"');
		expect(html).toMatch(/<optgroup label="Machining"[^>]*>(?:<!--\[-->)?<option value="m1" selected[^>]*>Turning</);
		expect(html.indexOf('data-kind-select')).toBeGreaterThan(html.indexOf('class="ohead"'));
		expect(html.indexOf('data-kind-select')).toBeLessThan(html.indexOf('class="oname"'));
	});

	it('is the type of test on a new test', async () => {
		const [c] = containers(run([{ type: 'addContainer', kind: 'test', source: { from: 'blank' } }]));
		const html = await render(ContainerNode, { id: c.id, data: c }, edit({ kind: () => pick({ kind: 'test', testTypes: [{ value: 'tensile', name: 'Destructive — Tensile' }] }) }));
		expect(select(html)).toContain('aria-label="Type of test"');
		expect(html).toMatch(/<optgroup label="Destructive"[^>]*>(?:<!--\[-->)?<option value="tensile"[^>]*>Tensile</);
	});

	it('is not drawn on a recorded card (the page offers none), without edit mode, or while the card cannot be edited', async () => {
		const [c] = containers(run([{ type: 'addContainer', kind: 'operation', source: { from: 'blank' } }]));
		const recorded: ContainerData = { ...c, id: 'op:x', draft: undefined, group: { ...c.group, rowIds: ['x'] }, rows: [{ recordId: 'x', in: 'op:x:in:0', out: 'op:x:out:0' }] };
		expect(select(await render(ContainerNode, { id: recorded.id, data: recorded }, edit({ kind: () => null })))).toBeUndefined();
		expect(select(await render(ContainerNode, { id: c.id, data: c }, edit()))).toBeUndefined();
		expect(select(await render(ContainerNode, { id: c.id, data: c }))).toBeUndefined();
		expect(select(await render(ContainerNode, { id: c.id, data: c }, edit({ editing: ref(false), kind: () => pick() })))).toBeUndefined();
		expect(select(await render(ContainerNode, { id: c.id, data: { ...c, collapsed: true } }, edit({ kind: () => pick() })))).toBeUndefined();
	});
});
