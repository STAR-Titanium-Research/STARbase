import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import type { DraftBody } from '@d1/ui';
import { apply, emptyBody, type DraftAction } from './draft';
import { catalogEntries, type MenuEntry } from './menuModel';
import { encodeSocket, type SocketRef } from './socketRefs';
import { DRAG_SLOP, LONG_PRESS_MS, NOT_HERE, TOUCH_SLOP, draggable, useAddDrag } from './useAddDrag';

// An entry of the palette carried over the canvas, in a node environment: window, document and the canvas element are small stand-ins.

type Listener = (e: any) => void;
let listeners: Record<string, Listener[]>;
const fire = (type: string, e: Record<string, unknown>) => [...(listeners[type] ?? [])].forEach((l) => l({ stopPropagation() {}, ...e }));

const run = (actions: DraftAction[], from: DraftBody = emptyBody()): DraftBody => actions.reduce((b, a) => apply(b, a), from);
const entries = catalogEntries({ methods: [{ id: 'mt', name: 'CNC Turning', code: 'MC', category: 'machining' }], testTypes: [] });
const turning = entries.find((e) => e.id === 'op:mt')!;
const pick = entries.find((e) => e.id === 'sample:pick')!;
const newSample = entries.find((e) => e.id === 'sample:new')!;

const socketEl = (sock: SocketRef, x: number, y: number, node = 'card:1') => ({
	dataset: { sock: encodeSocket(sock) },
	getBoundingClientRect: () => ({ left: x - 6, top: y - 6, width: 12, height: 12 }),
	closest: (sel: string) => (sel === '.vue-flow__node' ? { dataset: { id: node } } : null),
});

/** What the pointer is over: the empty canvas, a card, or a wire. */
type Under = 'empty' | 'card' | { wire: string };
function setup(opts: { sockets?: ReturnType<typeof socketEl>[]; under?: Under; inCanvas?: boolean; editing?: boolean; body?: DraftBody; wireRefusal?: { reason: string; locked: boolean } | null } = {}) {
	listeners = {};
	const style = { userSelect: '' };
	const state = { under: opts.under ?? 'empty' as Under };
	vi.stubGlobal('window', {
		addEventListener: (t: string, l: Listener) => void (listeners[t] = [...(listeners[t] ?? []), l]),
		removeEventListener: (t: string, l: Listener) => void (listeners[t] = (listeners[t] ?? []).filter((x) => x !== l)),
	});
	vi.stubGlobal('document', {
		visibilityState: 'visible',
		addEventListener: (t: string, l: Listener) => void (listeners[t] = [...(listeners[t] ?? []), l]),
		removeEventListener: (t: string, l: Listener) => void (listeners[t] = (listeners[t] ?? []).filter((x) => x !== l)),
		body: { style },
		elementFromPoint: () => {
			const u = state.under;
			if (u === 'empty') return { closest: () => null };
			if (u === 'card') return { closest: (sel: string) => (sel.includes('vue-flow__node') ? {} : null) };
			return { closest: (sel: string) => (sel.includes('vue-flow__edge') ? { getAttribute: () => u.wire } : null) };
		},
	});
	const rect = opts.inCanvas === false ? { left: 5000, top: 5000, right: 5100, bottom: 5100 } : { left: 100, top: 50, right: 900, bottom: 650 };
	const canvasEl = ref({ querySelectorAll: () => opts.sockets ?? [], getBoundingClientRect: () => rect, contains: () => true } as unknown as HTMLElement);
	const drop = ref<{ sock: string; ok: boolean } | null>(null);
	const applyAt = vi.fn(async () => undefined);
	const dropOnWire = vi.fn(() => true);
	const say = vi.fn();
	const wireVerdict = vi.fn(() => opts.wireRefusal ?? null);
	const drag = useAddDrag({
		body: () => opts.body ?? emptyBody(),
		editing: () => opts.editing ?? true,
		canvas: { toFlow: (x: number, y: number) => ({ x: x - 100, y: y - 50 }) },
		canvasEl,
		drop,
		applyAt,
		wireVerdict,
		dropOnWire,
		say,
	});
	const down = (entry: MenuEntry, x = 20, y = 20, over: Record<string, unknown> = {}) => drag.start(entry, { clientX: x, clientY: y, pointerType: 'mouse', button: 0, ...over } as PointerEvent);
	return { drag, drop, applyAt, dropOnWire, say, wireVerdict, down, state, style, move: (x: number, y: number, over: Record<string, unknown> = {}) => fire('pointermove', { clientX: x, clientY: y, ...over }), up: (x: number, y: number) => fire('pointerup', { clientX: x, clientY: y }) };
}
beforeEach(() => void (listeners = {}));
afterEach(() => void vi.unstubAllGlobals());

describe('what can be carried', () => {
	it('a thing to add can; Existing sample… (it opens the picker) cannot', () => {
		expect([turning, newSample, pick].map(draggable)).toEqual([true, true, false]);
	});
});

describe('a click on an entry', () => {
	it('is no drag: nothing is dropped, and the click is the entry\'s own', () => {
		const t = setup();
		t.down(turning);
		t.move(20 + DRAG_SLOP - 2, 20);
		expect(t.drag.drag.value).toBeNull();
		t.up(20, 20);
		expect(t.applyAt).not.toHaveBeenCalled();
		expect(t.drag.consumeClick()).toBe(false);
	});

	it('an entry that is not a drag source starts nothing; nor does anything outside edit mode or a right button', () => {
		const a = setup();
		a.down(pick);
		a.move(300, 300);
		expect(a.drag.drag.value).toBeNull();
		const b = setup({ editing: false });
		b.down(turning);
		b.move(300, 300);
		expect(b.drag.drag.value).toBeNull();
		const c = setup();
		c.down(turning, 20, 20, { button: 2 });
		c.move(300, 300);
		expect(c.drag.drag.value).toBeNull();
	});
});

describe('letting go on the empty canvas', () => {
	it('adds a floating card at the pointer, in the map\'s own coordinates', () => {
		const t = setup();
		t.down(turning);
		t.move(400, 300);
		expect(t.drag.drag.value).toMatchObject({ over: 'canvas', ok: true, x: 400, y: 300 });
		expect(t.style.userSelect).toBe('none');
		t.up(400, 300);
		expect(t.applyAt).toHaveBeenCalledWith({ sock: null, at: { x: 400, y: 300 }, flow: { x: 300, y: 250 } }, turning.choice);
		expect(t.drag.drag.value).toBeNull();
		expect(t.style.userSelect).toBe('');
		// The click the drag leaves on its entry is not an add.
		expect(t.drag.consumeClick()).toBe(true);
		expect(t.drag.consumeClick()).toBe(false);
	});

	it('on a card says where it can go instead, and drops nothing; outside the canvas it does nothing at all', () => {
		const onCard = setup({ under: 'card' });
		onCard.down(turning);
		onCard.move(400, 300);
		expect(onCard.drag.drag.value).toMatchObject({ over: 'none', ok: false, reason: NOT_HERE });
		onCard.up(400, 300);
		expect(onCard.applyAt).not.toHaveBeenCalled();
		expect(onCard.say).toHaveBeenCalledWith(NOT_HERE, { x: 300, y: 250 });
		const outside = setup({ inCanvas: false });
		outside.down(turning);
		outside.move(400, 300);
		expect(outside.drag.drag.value).toMatchObject({ over: 'none', ok: null });
		outside.up(400, 300);
		expect(outside.applyAt).not.toHaveBeenCalled();
		expect(outside.say).not.toHaveBeenCalled();
	});
});

describe('letting go on a socket', () => {
	const body = run([{ type: 'addSample' }]);
	const out: SocketRef = { kind: 'sample', id: 'draft:n1', side: 'out' };
	const inn: SocketRef = { kind: 'sample', id: 'draft:n1', side: 'in' };

	it('connects there when it fits, marks the socket green while the pointer is near it, and puts the card beside the socket\'s card', () => {
		const t = setup({ sockets: [socketEl(out, 300, 200, 'card:n1')], body });
		t.down(turning);
		t.move(305, 204);
		expect(t.drop.value).toEqual({ sock: encodeSocket(out), ok: true });
		expect(t.drag.drag.value).toMatchObject({ over: 'socket', ok: true });
		t.up(305, 204);
		expect(t.applyAt).toHaveBeenCalledWith({ sock: out, at: { x: 305, y: 204 }, anchor: 'card:n1' }, turning.choice);
		expect(t.drop.value).toBeNull();
	});

	it('is refused where it does not fit: red while over it, with the reason, and said where it was let go; nothing is applied', () => {
		const t = setup({ sockets: [socketEl(inn, 300, 200)], body });
		t.down(newSample);
		t.move(302, 200);
		expect(t.drop.value).toEqual({ sock: encodeSocket(inn), ok: false });
		expect(t.drag.drag.value?.reason).toContain('made by an operation');
		t.up(302, 200);
		expect(t.applyAt).not.toHaveBeenCalled();
		expect(t.say).toHaveBeenCalledWith(expect.stringContaining('made by an operation'), { x: 202, y: 150 });
	});

	it('a socket far from the pointer is not the target: the canvas is', () => {
		const t = setup({ sockets: [socketEl(out, 300, 200)], body });
		t.down(turning);
		t.move(500, 400);
		expect(t.drop.value).toBeNull();
		expect(t.drag.drag.value?.over).toBe('canvas');
	});
});

describe('letting go on a wire', () => {
	it('inserts: the wire is marked green while the pointer is on it, and the drop is the insert\'s with the flow point', () => {
		const t = setup({ under: { wire: 'a>b' } });
		t.down(turning);
		t.move(400, 300);
		expect(t.drag.dropWire.value).toEqual({ id: 'a>b', ok: true });
		expect(t.drag.drag.value).toMatchObject({ over: 'wire', ok: true });
		t.up(400, 300);
		expect(t.dropOnWire).toHaveBeenCalledWith('a>b', turning.choice, { x: 300, y: 250 }, { x: 300, y: 250 });
		expect(t.drag.dropWire.value).toBeNull();
		expect(t.applyAt).not.toHaveBeenCalled();
	});

	it('is refused with the reason (a done wire among them): red, said, nothing inserted', () => {
		const t = setup({ under: { wire: 'a>b' }, wireRefusal: { reason: "Done records' wires can't be changed from the map", locked: true } });
		t.down(turning);
		t.move(400, 300);
		expect(t.drag.dropWire.value).toEqual({ id: 'a>b', ok: false });
		expect(t.drag.drag.value?.reason).toBe("Done records' wires can't be changed from the map");
		t.up(400, 300);
		expect(t.dropOnWire).not.toHaveBeenCalled();
		expect(t.say).toHaveBeenCalledWith("Done records' wires can't be changed from the map", { x: 300, y: 250 });
	});
});

describe('letting go of nothing', () => {
	it('Esc and a cancelled pointer drop nothing, and let the page select text again', () => {
		const t = setup();
		t.down(turning);
		t.move(400, 300);
		fire('keydown', { key: 'Escape' });
		expect(t.drag.drag.value).toBeNull();
		t.up(400, 300);
		expect(t.applyAt).not.toHaveBeenCalled();
		expect(t.style.userSelect).toBe('');

		const c = setup();
		c.down(turning);
		c.move(400, 300);
		fire('pointercancel', {});
		expect(c.drag.drag.value).toBeNull();
		expect(listeners.pointermove ?? []).toHaveLength(0);
	});

	it('only one finger drags at a time', () => {
		const t = setup();
		t.down(turning, 20, 20, { pointerType: 'touch' });
		t.down(newSample, 20, 20, { pointerType: 'touch' });
		t.move(400, 300, { pointerType: 'touch' });
		expect(t.drag.drag.value?.entry).toBe(turning);
	});

	it('a mouse pressed again while a drag is still going lost the end of the first: that one is let go, nothing dropped, and the new one starts', () => {
		const t = setup();
		t.down(turning);
		t.move(400, 300, { buttons: 1 });
		expect(t.drag.drag.value?.entry).toBe(turning);
		t.down(newSample);
		expect(t.drag.drag.value).toBeNull();
		expect(t.applyAt).not.toHaveBeenCalled();
		t.move(400, 300, { buttons: 1 });
		expect(t.drag.drag.value?.entry).toBe(newSample);
	});
});

describe('a drag that loses its pointer is let go, not left holding it', () => {
	const dragging = () => {
		const t = setup();
		t.down(turning);
		t.move(400, 300, { buttons: 1 });
		expect(t.drag.drag.value).not.toBeNull();
		return t;
	};
	const gone = (t: ReturnType<typeof setup>) => {
		expect(t.drag.drag.value).toBeNull();
		expect(t.drop.value).toBeNull();
		expect(t.style.userSelect).toBe('');
		for (const type of ['pointermove', 'pointerup', 'pointercancel', 'blur', 'keydown', 'visibilitychange', 'touchmove']) expect(listeners[type] ?? [], type).toHaveLength(0);
		// A later pointerup (the button let go in the page again) drops nothing.
		t.up(400, 300);
		expect(t.applyAt).not.toHaveBeenCalled();
		expect(t.drag.consumeClick()).toBe(false);
	};

	it('the window losing focus (a pointerup outside the window never arrives)', () => {
		const t = dragging();
		fire('blur', {});
		gone(t);
	});

	it('the page being hidden, but not becoming visible', () => {
		const t = dragging();
		fire('visibilitychange', {});
		expect(t.drag.drag.value).not.toBeNull();
		(document as unknown as { visibilityState: string }).visibilityState = 'hidden';
		fire('visibilitychange', {});
		gone(t);
	});

	it('a mouse or pen that moves with no button down: its button was let go somewhere that heard nothing', () => {
		for (const pointerType of ['mouse', 'pen']) {
			const t = dragging();
			t.move(410, 310, { buttons: 0, pointerType });
			gone(t);
		}
	});

	it('a finger has no buttons: moving on is still dragging', () => {
		const t = setup();
		t.down(turning, 20, 20, { pointerType: 'touch' });
		t.move(60, 20, { buttons: 0, pointerType: 'touch' });
		t.move(400, 300, { buttons: 0, pointerType: 'touch' });
		expect(t.drag.drag.value).toMatchObject({ over: 'canvas', x: 400, y: 300 });
	});

	it('a drag started again after one was lost works (stop was released)', () => {
		const t = dragging();
		fire('blur', {});
		t.down(newSample);
		t.move(400, 300, { buttons: 1 });
		expect(t.drag.drag.value?.entry).toBe(newSample);
		t.up(400, 300);
		expect(t.applyAt).toHaveBeenCalledTimes(1);
	});
});

describe('a finger scrolls the palette and carries an entry only on purpose', () => {
	const touch = { pointerType: 'touch', buttons: 1 };
	beforeEach(() => void vi.useFakeTimers());
	afterEach(() => void vi.useRealTimers());

	it('a vertical move is a scroll: nothing is carried, even after the long press time', () => {
		const t = setup();
		t.down(turning, 20, 20, touch);
		t.move(20, 20 + TOUCH_SLOP + 4, touch);
		expect(t.drag.drag.value).toBeNull();
		vi.advanceTimersByTime(LONG_PRESS_MS + 50);
		expect(t.drag.drag.value).toBeNull();
		t.move(400, 300, touch);
		t.up(400, 300);
		expect(t.applyAt).not.toHaveBeenCalled();
		expect(listeners.pointermove ?? []).toHaveLength(0);
	});

	it('a clearly horizontal move carries it, at once', () => {
		const t = setup();
		t.down(turning, 20, 20, touch);
		t.move(20 + TOUCH_SLOP + 2, 24, touch);
		expect(t.drag.drag.value?.entry).toBe(turning);
		t.move(400, 300, touch);
		t.up(400, 300);
		expect(t.applyAt).toHaveBeenCalledWith({ sock: null, at: { x: 400, y: 300 }, flow: { x: 300, y: 250 } }, turning.choice);
	});

	it('a long press carries it (the chip shows at the finger), then any move follows, up as well as sideways', () => {
		const t = setup();
		t.down(turning, 20, 20, touch);
		vi.advanceTimersByTime(LONG_PRESS_MS - 10);
		expect(t.drag.drag.value).toBeNull();
		vi.advanceTimersByTime(20);
		expect(t.drag.drag.value).toMatchObject({ entry: turning, x: 20, y: 20 });
		t.move(404, 300, touch);
		expect(t.drag.drag.value).toMatchObject({ over: 'canvas', x: 404, y: 300 });
		t.up(400, 300);
		expect(t.applyAt).toHaveBeenCalledTimes(1);
	});

	it('a finger lifted before the long press, without moving, is a tap: the entry\'s own click', () => {
		const t = setup();
		t.down(turning, 20, 20, touch);
		vi.advanceTimersByTime(100);
		t.up(20, 20);
		vi.advanceTimersByTime(LONG_PRESS_MS * 2);
		expect(t.drag.drag.value).toBeNull();
		expect(t.applyAt).not.toHaveBeenCalled();
		expect(t.drag.consumeClick()).toBe(false);
	});

	it('the page does not pan under a finger that is carrying an entry (touchmove is cancelled), but is left alone before', () => {
		const t = setup();
		t.down(turning, 20, 20, touch);
		const early = { cancelable: true, preventDefault: vi.fn() };
		fire('touchmove', early);
		expect(early.preventDefault).not.toHaveBeenCalled();
		vi.advanceTimersByTime(LONG_PRESS_MS + 10);
		const later = { cancelable: true, preventDefault: vi.fn() };
		fire('touchmove', later);
		expect(later.preventDefault).toHaveBeenCalled();
	});

	it('a mouse is unchanged: any move past the slop carries it, no long press', () => {
		const t = setup();
		t.down(turning);
		t.move(20, 20 + DRAG_SLOP + 1, { buttons: 1 });
		expect(t.drag.drag.value?.entry).toBe(turning);
	});
});
