import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, reactive, ref } from 'vue';
import type { DraftBody } from '@d1/ui';
import type { MapNode, RecordNode } from '../model/types';
import { apply, emptyBody, type DraftAction } from './draft';
import { fakeServer, settle } from './fakeBuildServer';
import type { MenuTarget } from './menuTarget';
import { encodeSocket, type SocketRef } from './socketRefs';
import { CLICK_SLOP, canvasEditOf, useEditCanvas } from './useEditCanvas';
import { dropVerdict } from './wireDrop';
import { useEditMode } from './useEditMode';

// The pointer on sockets, in a node environment: window, document and the canvas element are small stand-ins that record what is
// asked of them.

type Listener = (e: any) => void;
let listeners: Record<string, Listener[]>;
const fire = (type: string, e: Record<string, unknown>) => [...(listeners[type] ?? [])].forEach((l) => l({ preventDefault() {}, stopPropagation() {}, ...e }));

/** A socket element at (x, y): `data-sock`, a rectangle, and the card it sits on. */
const socketEl = (sock: SocketRef, x: number, y: number, node = 'card:1', own: { handleId?: string; free?: boolean } = {}) => ({
	dataset: { sock: encodeSocket(sock), ...(own.handleId ? { handleid: own.handleId } : {}) },
	classList: { contains: (c: string) => c === 'free' && !!own.free },
	getBoundingClientRect: () => ({ left: x - 6, top: y - 6, width: 12, height: 12 }),
	closest: (sel: string) => (sel === '.vue-flow__node' ? { dataset: { id: node } } : null),
});

function setupDom(sockets: ReturnType<typeof socketEl>[], over: { empty?: boolean } = {}) {
	listeners = {};
	const style = { userSelect: '' };
	const onEmpty = over.empty ?? true;
	vi.stubGlobal('window', {
		addEventListener: (t: string, l: Listener) => void (listeners[t] = [...(listeners[t] ?? []), l]),
		removeEventListener: (t: string, l: Listener) => void (listeners[t] = (listeners[t] ?? []).filter((x) => x !== l)),
	});
	vi.stubGlobal('document', { body: { style }, elementFromPoint: () => ({ closest: () => (onEmpty ? null : {}) }) });
	const canvasEl = {
		querySelectorAll: () => sockets,
		getBoundingClientRect: () => ({ left: 100, top: 50 }),
		contains: () => true,
	};
	return { canvasEl: ref(canvasEl as unknown as HTMLElement), style };
}

const run = (actions: DraftAction[], from: DraftBody = emptyBody()): DraftBody => actions.reduce((b, a) => apply(b, a), from);

async function setup(body: DraftBody, sockets: ReturnType<typeof socketEl>[] = [], dom: { empty?: boolean } = {}, dropWire?: (s: SocketRef, socketId: string | null) => boolean) {
	const server = fakeServer();
	server.s.seed('d', body);
	const route = reactive({ path: '/map', query: { edit: 'd' } as Record<string, unknown> });
	const edit = useEditMode({ api: server.api, fieldsFor: async () => [], route, router: { replace: vi.fn() }, isPhone: ref(false), focus: () => null });
	await settle();
	await nextTick();
	const { canvasEl, style } = setupDom(sockets, dom);
	const opened: MenuTarget[] = [];
	const nodes: MapNode[] = [];
	const map = { graph: reactive({ value: { nodes } }), clearHover: vi.fn() } as never;
	const canvas = { toFlow: (x: number, y: number) => ({ x: x - 10, y: y - 20 }), remeasure: async () => undefined } as never;
	const connecting: MenuTarget[] = [];
	const ec = useEditCanvas({ edit, map, canvas, canvasEl, openMenu: (t) => void opened.push(t), openConnect: (t) => void connecting.push(t), dropWire });
	return { edit, ec, opened, connecting, style, server, map: map as { clearHover: ReturnType<typeof vi.fn> } };
}

const down = (sock: SocketRef, at: { x: number; y: number }, ec: { mapEdit: { socketDown: (s: SocketRef, e: PointerEvent) => void } }, own: { handleId?: string; free?: boolean } = {}) => {
	const el = socketEl(sock, at.x, at.y, 'card:1', own);
	ec.mapEdit.socketDown(sock, { currentTarget: el, button: 0, pointerType: 'mouse', clientX: at.x, clientY: at.y } as unknown as PointerEvent);
};

const SAMPLE_OUT: SocketRef = { kind: 'sample', id: 'draft:n1', side: 'out' };
const ROW_IN: SocketRef = { kind: 'row', id: 'draft:n3', side: 'in' };

/** n1 a sample, n2 a blank operation (row n3) that nothing feeds. */
const twoCards = () => run([{ type: 'addSample' }, { type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'm-turn' } }]);

beforeEach(() => void vi.stubGlobal('window', undefined));
afterEach(() => void vi.unstubAllGlobals());

describe('a click on a socket', () => {
	it('opens the Add menu at the socket, naming the card it is on', async () => {
		const { ec, opened } = await setup(twoCards());
		down(SAMPLE_OUT, { x: 300, y: 200 }, ec);
		fire('pointermove', { clientX: 301, clientY: 201 });
		fire('pointerup', { clientX: 301, clientY: 201 });
		expect(opened).toEqual([{ sock: SAMPLE_OUT, at: { x: 300, y: 200 }, anchor: 'card:1' }]);
	});

	it('is a click while the pointer moves less than the slop; nothing is left listening afterwards', async () => {
		const { ec, opened, style } = await setup(twoCards());
		down(SAMPLE_OUT, { x: 300, y: 200 }, ec);
		fire('pointermove', { clientX: 300 + CLICK_SLOP - 1, clientY: 200 });
		expect(ec.preview.value).toBeNull();
		fire('pointerup', { clientX: 300, clientY: 200 });
		expect(opened).toHaveLength(1);
		expect(Object.values(listeners).flat()).toHaveLength(0);
		expect(style.userSelect).toBe('');
	});

	it('C on a focused socket opens Connect to… instead (E21), and Ctrl+C is left alone', async () => {
		const { ec, opened, connecting } = await setup(twoCards());
		const el = socketEl(SAMPLE_OUT, 300, 200);
		const ev = (over: Record<string, unknown>) => ({ currentTarget: el, preventDefault() {}, stopPropagation() {}, ...over }) as unknown as KeyboardEvent;
		ec.mapEdit.socketKey(SAMPLE_OUT, ev({ key: 'c' }));
		ec.mapEdit.socketKey(SAMPLE_OUT, ev({ key: 'c', ctrlKey: true }));
		expect(connecting).toEqual([{ sock: SAMPLE_OUT, at: { x: 300, y: 200 }, anchor: 'card:1' }]);
		expect(opened).toHaveLength(0);
	});

	it('does nothing when the draft cannot be changed', async () => {
		const { ec, opened, edit } = await setup(twoCards());
		(edit as { editing: { value: boolean } }).editing = { value: false } as never;
		down(SAMPLE_OUT, { x: 300, y: 200 }, ec);
		fire('pointerup', { clientX: 300, clientY: 200 });
		expect(opened).toHaveLength(0);
	});

	it('Enter on a focused socket opens its menu too (E21)', async () => {
		const { ec, opened } = await setup(twoCards());
		const el = socketEl(ROW_IN, 400, 300, 'card:2');
		ec.mapEdit.socketKey(ROW_IN, { key: 'Enter', currentTarget: el, preventDefault() {}, stopPropagation() {} } as unknown as KeyboardEvent);
		ec.mapEdit.socketKey(ROW_IN, { key: 'a', currentTarget: el, preventDefault() {}, stopPropagation() {} } as unknown as KeyboardEvent);
		expect(opened).toEqual([{ sock: ROW_IN, at: { x: 400, y: 300 }, anchor: 'card:2' }]);
	});
});

describe('the keyboard and assistive technology on a socket', () => {
	const kev = (el: unknown, over: Record<string, unknown>) => ({ currentTarget: el, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...over }) as unknown as KeyboardEvent;

	it('Space opens the menu on a wired socket (a span with role button), but leaves a real button to its click', async () => {
		const { ec, opened } = await setup(twoCards());
		const span = { ...socketEl(ROW_IN, 400, 300, 'card:2'), tagName: 'SPAN' };
		const button = { ...socketEl(ROW_IN, 400, 300, 'card:2'), tagName: 'BUTTON' };
		ec.mapEdit.socketKey(ROW_IN, kev(span, { key: ' ' }));
		expect(opened).toHaveLength(1);
		ec.mapEdit.socketKey(ROW_IN, kev(button, { key: ' ' }));
		expect(opened).toHaveLength(1);
	});

	it('a click with no pointer behind it (detail 0: Space on a button, a screen reader) opens the menu; a pointer\'s click does not (pointerdown did)', async () => {
		const { ec, opened } = await setup(twoCards());
		const el = { ...socketEl(ROW_IN, 400, 300, 'card:2'), tagName: 'BUTTON' };
		const click = (detail: number) => ({ currentTarget: el, detail, preventDefault: vi.fn(), stopPropagation: vi.fn() }) as unknown as MouseEvent;
		ec.mapEdit.socketClick(ROW_IN, click(1));
		expect(opened).toHaveLength(0);
		ec.mapEdit.socketClick(ROW_IN, click(0));
		expect(opened).toEqual([{ sock: ROW_IN, at: { x: 400, y: 300 }, anchor: 'card:2' }]);
	});
});

describe('a drag from a socket', () => {
	const target = socketEl(ROW_IN, 500, 260);

	it('draws a preview that follows the pointer, relative to the canvas, and marks the socket under it', async () => {
		const { ec } = await setup(twoCards(), [target]);
		down(SAMPLE_OUT, { x: 300, y: 200 }, ec);
		fire('pointermove', { clientX: 400, clientY: 230 });
		expect(ec.preview.value).toMatchObject({ from: { x: 200, y: 150 }, to: { x: 300, y: 180 }, ok: null });
		fire('pointermove', { clientX: 497, clientY: 262 });
		expect(ec.preview.value).toMatchObject({ ok: true, reason: null });
		expect(ec.mapEdit.drop.value).toEqual({ sock: encodeSocket(ROW_IN), ok: true });
		fire('pointermove', { clientX: 700, clientY: 500 });
		expect(ec.mapEdit.drop.value).toBeNull();
	});

	it('wires the two when it is dropped on a socket that fits', async () => {
		const { ec, edit, opened } = await setup(twoCards(), [target]);
		down(SAMPLE_OUT, { x: 300, y: 200 }, ec);
		fire('pointermove', { clientX: 497, clientY: 262 });
		fire('pointerup', { clientX: 497, clientY: 262 });
		await settle();
		expect(edit.body.value.wires).toEqual([{ from: { key: 'n1' }, to: { key: 'n2', row: 0 } }]);
		expect(opened).toHaveLength(0);
		expect(ec.preview.value).toBeNull();
		expect(ec.mapEdit.drop.value).toBeNull();
	});

	it('works from the input end too', async () => {
		const sampleOut = socketEl(SAMPLE_OUT, 300, 200);
		const { ec, edit } = await setup(twoCards(), [sampleOut]);
		down(ROW_IN, { x: 500, y: 260 }, ec);
		fire('pointermove', { clientX: 303, clientY: 203 });
		fire('pointerup', { clientX: 303, clientY: 203 });
		await settle();
		expect(edit.body.value.wires).toHaveLength(1);
	});

	it('says why when it is dropped on a socket that does not fit, and wires nothing', async () => {
		const fed = run([{ type: 'wire', from: { key: 'n1' }, to: { key: 'n2', row: 0 } }], twoCards());
		const { ec, edit } = await setup(fed, [target]);
		down({ kind: 'sample', id: 'draft:n1', side: 'out' }, { x: 300, y: 200 }, ec);
		fire('pointermove', { clientX: 497, clientY: 262 });
		expect(ec.preview.value).toMatchObject({ ok: false, reason: 'Those two are already wired.' });
		expect(ec.mapEdit.drop.value).toEqual({ sock: encodeSocket(ROW_IN), ok: false });
		fire('pointerup', { clientX: 497, clientY: 262 });
		expect(ec.refusal.value).toMatchObject({ text: 'Those two are already wired.' });
		expect(edit.body.value.wires).toHaveLength(1);
	});

	it('opens the Add menu where it is dropped on empty canvas, in the map\'s own coordinates', async () => {
		const { ec, opened } = await setup(twoCards(), [target]);
		down(SAMPLE_OUT, { x: 300, y: 200 }, ec);
		fire('pointermove', { clientX: 650, clientY: 420 });
		fire('pointerup', { clientX: 650, clientY: 420 });
		expect(opened).toEqual([{ sock: SAMPLE_OUT, at: { x: 650, y: 420 }, flow: { x: 640, y: 400 }, anchor: 'card:1' }]);
	});

	it('a wired input dragged off and dropped on empty canvas takes the wire instead of opening the menu, and says which socket was grabbed (R4)', async () => {
		const taken: [SocketRef, string | null][] = [];
		const { ec, opened } = await setup(twoCards(), [target], {}, (s, id) => (taken.push([s, id]), true));
		down(ROW_IN, { x: 300, y: 200 }, ec, { handleId: 'op:draft:n3:in:0' });
		fire('pointermove', { clientX: 650, clientY: 420 });
		fire('pointerup', { clientX: 650, clientY: 420 });
		expect(taken).toEqual([[ROW_IN, 'op:draft:n3:in:0']]);
		expect(opened).toHaveLength(0);
	});

	it('a socket with no wire to take opens the menu as before', async () => {
		const { ec, opened } = await setup(twoCards(), [target], {}, () => false);
		down(ROW_IN, { x: 300, y: 200 }, ec, { handleId: 'op:draft:n3:in:0' });
		fire('pointermove', { clientX: 650, clientY: 420 });
		fire('pointerup', { clientX: 650, clientY: 420 });
		expect(opened).toHaveLength(1);
	});

	it('a FREE socket never takes a wire: it carries the reference of the wired socket of its row, but nothing is wired to it (R4)', async () => {
		const asked: unknown[] = [];
		const { ec, opened } = await setup(twoCards(), [target], {}, (...a) => (asked.push(a), true));
		down(ROW_IN, { x: 300, y: 200 }, ec, { free: true });
		fire('pointermove', { clientX: 650, clientY: 420 });
		fire('pointerup', { clientX: 650, clientY: 420 });
		expect(asked).toEqual([]);
		expect(opened).toHaveLength(1);
		expect(opened[0].sock).toEqual(ROW_IN);
	});

	it('does nothing when it is dropped on a card that is not a socket', async () => {
		const { ec, opened, edit } = await setup(twoCards(), [target], { empty: false });
		down(SAMPLE_OUT, { x: 300, y: 200 }, ec);
		fire('pointermove', { clientX: 650, clientY: 420 });
		fire('pointerup', { clientX: 650, clientY: 420 });
		expect(opened).toHaveLength(0);
		expect(edit.body.value.wires).toHaveLength(0);
	});

	it('is called off by Escape, and by the browser cancelling the pointer', async () => {
		const { ec, opened, style } = await setup(twoCards(), [target]);
		down(SAMPLE_OUT, { x: 300, y: 200 }, ec);
		fire('pointermove', { clientX: 400, clientY: 230 });
		expect(style.userSelect).toBe('none');
		fire('keydown', { key: 'Escape' });
		expect(ec.preview.value).toBeNull();
		expect(style.userSelect).toBe('');
		expect(Object.values(listeners).flat()).toHaveLength(0);
		down(SAMPLE_OUT, { x: 300, y: 200 }, ec);
		fire('pointermove', { clientX: 400, clientY: 230 });
		fire('pointercancel', {});
		expect(ec.preview.value).toBeNull();
		expect(opened).toHaveLength(0);
	});

	it('ignores a second pointer down while one is on, and a right button', async () => {
		const { ec, opened } = await setup(twoCards(), [target]);
		down(SAMPLE_OUT, { x: 300, y: 200 }, ec);
		down(SAMPLE_OUT, { x: 300, y: 200 }, ec);
		expect(listeners.pointermove).toHaveLength(1);
		fire('pointerup', { clientX: 300, clientY: 200 });
		const el = socketEl(SAMPLE_OUT, 300, 200);
		ec.mapEdit.socketDown(SAMPLE_OUT, { currentTarget: el, button: 2, pointerType: 'mouse', clientX: 300, clientY: 200 } as unknown as PointerEvent);
		expect(listeners.pointermove ?? []).toHaveLength(0);
		expect(opened).toHaveLength(1);
	});
});

describe('a wire from a sample of the loaded history', () => {
	it('adds the sample to the draft with the version it was read at, takes its project, then wires it', async () => {
		const { ec, edit } = await setup(twoCards(), [socketEl(ROW_IN, 500, 260)]);
		const old: SocketRef = { kind: 'sample', id: 's1', side: 'out' };
		down(old, { x: 300, y: 200 }, ec);
		fire('pointermove', { clientX: 497, clientY: 262 });
		expect(ec.preview.value).toMatchObject({ ok: true });
		fire('pointerup', { clientX: 497, clientY: 262 });
		await settle();
		const item = edit.body.value.items.find((i) => i.kind === 'sample' && i.existing?.id === 's1');
		expect(item?.existing).toEqual({ id: 's1', version: 4 });
		expect(edit.body.value.projectId).toBe('proj1');
		expect(edit.body.value.wires).toEqual([{ from: { key: item!.key }, to: { key: 'n2', row: 0 } }]);
		// The sample, its project and the wire are one undo step: one Ctrl+Z takes them all back.
		edit.undo();
		expect(edit.body.value.items.map((i) => i.key)).toEqual(['n1', 'n2']);
		expect(edit.body.value.wires).toEqual([]);
		expect(edit.body.value.projectId).toBeNull();
	});

	it('says so when the sample cannot be read, and changes nothing', async () => {
		const { ec, edit } = await setup(twoCards(), [socketEl(ROW_IN, 500, 260)]);
		const before = edit.body.value;
		const ghost: SocketRef = { kind: 'sample', id: 'nope', side: 'out' };
		down(ghost, { x: 300, y: 200 }, ec);
		fire('pointermove', { clientX: 497, clientY: 262 });
		fire('pointerup', { clientX: 497, clientY: 262 });
		await settle();
		expect(ec.problem.value).toMatch(/could not be read/);
		expect(edit.body.value).toBe(before);
	});

	it('ensureSample keeps a sample the draft already has', async () => {
		const { ec, edit } = await setup(run([{ type: 'addExistingSamples', samples: [{ id: 's2', version: 2 }] }]));
		expect(await ec.ensureSample('s2')).toBe(true);
		expect(edit.body.value.items).toHaveLength(1);
	});
});

describe('badges and ＋ output', () => {
	const container = (rowId: string, extra: Record<string, unknown> = {}): MapNode =>
		({ id: `c:${rowId}`, type: 'container', kind: 'operation', group: { id: `c:${rowId}`, kind: 'operation', rowIds: [rowId], batch: null }, title: 'x', code: '', category: null, rows: [], slots: [], settings: [], bundled: false, probable: false, ...extra }) as MapNode;

	it('count what blocks Create on a card, with the words', async () => {
		const { ec } = await setup(twoCards());
		const op = container('draft:n3');
		expect(ec.mapEdit.badge(op)).toMatchObject({ count: 1, level: 'block' });
		expect(ec.mapEdit.badge(op)!.text).toMatch(/needs a sample/);
		expect(ec.mapEdit.badge(container('recorded'))).toBeNull();
	});

	it('show an amber badge, not a red one, on a card with only warnings (an operation with no machine yet)', async () => {
		const body = run([{ type: 'addSample' }, { type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'm-turn' } }, { type: 'wire', from: { key: 'n1' }, to: { key: 'n2' } }]);
		const { ec } = await setup(body);
		const badge = ec.mapEdit.badge(container('draft:n3'));
		expect(badge).toMatchObject({ level: 'warn' });
		expect(badge!.count).toBeGreaterThan(0);
		expect(badge!.text).toMatch(/No machine yet/);
	});

	it('show only a warning on a card that is not blocking (a sample whose record changed since it was added)', async () => {
		const body = run([{ type: 'addExistingSamples', samples: [{ id: 's1', version: 1 }] }]);
		const { ec } = await setup(body);
		const card = { id: 's:s1', type: 'record', kind: 'sample', ref: { collection: 'physical_samples', id: 's1', code: 'PS-001' }, ins: [], outs: [] } as MapNode;
		expect(ec.mapEdit.badge(card)).toMatchObject({ level: 'warn', text: expect.stringMatching(/Changed since you added it/) });
	});

	it('lists the sockets of a card that have a wire, from the drawn graph', async () => {
		const { ec, map } = await setup(twoCards());
		(map as unknown as { graph: { value: { nodes: MapNode[]; wires: unknown[] } } }).graph.value.wires = [
			{ id: 'w1', from: 's:a:out:0', to: 'op:b:in:0' },
			{ id: 'w2', from: 'op:b:out:0', to: 's:c:in:0' },
		];
		const op = container('draft:n3');
		const wired = ec.mapEdit.wiredSockets({ ...op, id: 'op:b' });
		expect([...wired].sort()).toEqual(['op:b:in:0', 'op:b:out:0']);
		expect([...ec.mapEdit.wiredSockets({ ...op, id: 'op:z' })]).toEqual([]);
	});

	it('a connection to a free socket that stands for a new row adds the row and wires it, as one undoable step', async () => {
		// n1 sample → n2 (row n3) → n4 sample; every row has its wire: the free sockets add rows.
		const body = run([
			{ type: 'addSample' },
			{ type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'm' }, from: { key: 'n1' } },
			{ type: 'addSample', from: { key: 'n2', row: 0 } },
			{ type: 'addSample' },
		]);
		const { ec, edit } = await setup(body);
		const v = dropVerdict(edit.body.value, { kind: 'row', id: 'draft:n3', side: 'out', add: true }, { kind: 'sample', id: 'draft:n5', side: 'in' });
		expect(v.ok).toBe(true);
		expect(await ec.connect(v)).toBe(true);
		const op = edit.body.value.items.find((i) => i.key === 'n2');
		expect(op?.kind === 'operation' && op.rows).toHaveLength(2);
		// The new piece shares the one sample going in, and makes the sample it was wired to.
		expect(edit.body.value.wires).toContainEqual({ from: { key: 'n1' }, to: { key: 'n2', row: 1 } });
		expect(edit.body.value.wires).toContainEqual({ from: { key: 'n2', row: 1 }, to: { key: 'n5' } });
		edit.undo();
		const back = edit.body.value.items.find((i) => i.key === 'n2');
		expect(back?.kind === 'operation' && back.rows).toHaveLength(1);
		expect(edit.body.value.wires).toHaveLength(2);
	});

	it('a connection to a free input that adds a row gives the new row its own sample, not the first row\'s', async () => {
		const body = run([
			{ type: 'addSample' },
			{ type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'm' }, from: { key: 'n1' } },
			{ type: 'addSample' },
		]);
		const { ec, edit } = await setup(body);
		const v = dropVerdict(edit.body.value, { kind: 'sample', id: 'draft:n4', side: 'out' }, { kind: 'row', id: 'draft:n3', side: 'in', add: true });
		expect(v.ok).toBe(true);
		expect(await ec.connect(v)).toBe(true);
		expect(edit.body.value.wires).toEqual([
			{ from: { key: 'n1' }, to: { key: 'n2', row: 0 } },
			{ from: { key: 'n4' }, to: { key: 'n2', row: 1 } },
		]);
	});
});

describe('where the draft keeps its cards', () => {
	const card: RecordNode = { id: 's:draft:n1', type: 'record', kind: 'sample', ref: { collection: 'physical_samples', id: 'draft:n1', code: 'x' }, ins: [], outs: [] };

	it('says the place a card was put, and only while editing', async () => {
		const { edit } = await setup(run([{ type: 'addSample', at: { x: 40, y: 50 } }]));
		const hooks = canvasEditOf(edit);
		expect(hooks.positionOf(card)).toEqual({ x: 40, y: 50 });
		expect(hooks.positionOf({ ...card, ref: { ...card.ref, id: 'draft:n9' } })).toBeUndefined();
	});

	it('a card moved off its place to clear another keeps the new place in the step that added the card: undo takes both', async () => {
		const { edit } = await setup(emptyBody());
		const hooks = canvasEditOf(edit);
		edit.apply({ type: 'addSample', at: { x: 10, y: 10 } });
		hooks.settled?.([{ node: card, at: { x: 400, y: 10 } }]);
		expect(edit.body.value.positions.n1).toEqual({ x: 400, y: 10 });
		edit.undo();
		expect(edit.body.value.items).toEqual([]);
		expect(edit.body.value.positions).toEqual({});
		edit.redo();
		expect(edit.body.value.positions.n1).toEqual({ x: 400, y: 10 });
	});

	it('says which cards are the draft\'s own for Tidy: new items, and samples picked from the index, nothing of the loaded history', async () => {
		const { edit } = await setup(run([{ type: 'addSample' }, { type: 'addExistingSamples', samples: [{ id: 'picked', version: 1 }, { id: 'old', version: 1 }] }, { type: 'addContainer', kind: 'operation', source: { from: 'blank' } }]));
		// Both are in the catalog (a sample is read when the draft first builds from it), but only 'old' is part of what the map loaded.
		for (const id of ['picked', 'old']) edit.catalog.samples.set(id, { id, code: id, nickname: null, form: null, status: null, projectId: null, materialRef: null, facts: {} });
		const hooks = canvasEditOf(edit, (id) => id === 'old');
		const rec = (id: string, extra: Record<string, unknown> = {}) => ({ id: `s:${id}`, type: 'record', kind: 'sample', ref: { collection: 'physical_samples', id, code: id }, ins: [], outs: [], ...extra }) as MapNode;
		expect(hooks.owned?.(rec('draft:n1', { draft: true }))).toBe(true);
		expect(hooks.owned?.(rec('picked'))).toBe(true);
		expect(hooks.owned?.(rec('old'))).toBe(false); // in the draft because it was built from, but part of the history
		expect(hooks.owned?.(rec('elsewhere'))).toBe(false);
		const box = { id: 'op:draft:n5', type: 'container', draft: true } as unknown as MapNode;
		expect(hooks.owned?.(box)).toBe(true);
		expect(hooks.owned?.({ id: 'op:o1', type: 'container' } as unknown as MapNode)).toBe(false);
	});

	it('keeps a card that is dropped, and every card after a re-layout as one undoable step', async () => {
		const { edit } = await setup(run([{ type: 'addSample' }, { type: 'addSample' }]));
		const hooks = canvasEditOf(edit);
		hooks.moved(card, { x: 7, y: 8 });
		expect(edit.body.value.positions.n1).toEqual({ x: 7, y: 8 });
		const second: RecordNode = { ...card, id: 's:draft:n2', ref: { ...card.ref, id: 'draft:n2' } };
		hooks.relaid([{ node: card, at: { x: 1, y: 1 } }, { node: second, at: { x: 2, y: 2 } }, { node: { ...card, ref: { ...card.ref, id: 'old' } }, at: { x: 3, y: 3 } }]);
		expect(edit.body.value.positions).toEqual({ n1: { x: 1, y: 1 }, n2: { x: 2, y: 2 } });
		edit.undo();
		expect(edit.body.value.positions).toEqual({ n1: { x: 7, y: 8 } });
	});
});
