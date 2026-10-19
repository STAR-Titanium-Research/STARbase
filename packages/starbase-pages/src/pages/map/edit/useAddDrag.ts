// Dragging an entry of the palette onto the canvas (redesign R2): where the pointer lets go decides. Empty canvas: a floating card there (the
// pointer's place in the map's own coordinates). A socket: connected there, if it fits (the same rules as the add search opened at that socket,
// addDrop.ts) and refused with the reason where it does not. A wire: INSERTED between its two ends, as one undoable step, never touching a
// done wire (insertModel.ts). While dragging, the socket or wire under the pointer is marked green when it takes the entry and red when it does
// not, and the reason is said beside the pointer.
//
// It is pointer events on the window, like a wire dragged from a socket (useEditCanvas): the same code serves a mouse and a pen. Esc cancels.

import { getCurrentInstance, onBeforeUnmount, ref, shallowRef, type Ref } from 'vue';
import type { DraftBody } from '@d1/ui';
import type { useMapCanvas } from '../useMapCanvas';
import { socketVerdict } from './addDrop';
import { nodeIdOfSocket, onEmptyCanvas, overCanvas, socketSpots, wireAt } from './canvasHits';
import type { MenuChoice, MenuEntry } from './menuModel';
import type { MenuTarget } from './menuTarget';
import { encodeSocket, nearestSocket, type SocketRef } from './socketRefs';

type Canvas = ReturnType<typeof useMapCanvas>;

/** What is said when an entry is let go over a card, a control or the minimap. */
export const NOT_HERE = 'Drop it on the empty canvas, on a free socket or on a wire.';

/** A pointer that moves less than this many pixels between going down and up on an entry is a click (it adds the entry at the keyboard's place). */
export const DRAG_SLOP = 5;

/** What is being dragged and what is under it: the palette draws a chip at the pointer, in the colour of the verdict. */
export interface PaletteDrag {
	entry: MenuEntry;
	x: number;
	y: number;
	/** What the pointer is over: nothing it can drop on, the empty canvas, a socket, a wire. */
	over: 'none' | 'canvas' | 'socket' | 'wire';
	/** The drop would work (true), is refused (false), or there is nothing to say (null). */
	ok: boolean | null;
	reason: string | null;
}

/** An entry the pointer can carry: a thing to add, not a sub-menu ("Existing sample…" opens the picker). */
export const draggable = (e: MenuEntry): boolean => e.choice.kind === 'operation' || e.choice.kind === 'test' || e.choice.kind === 'newSample';

export function useAddDrag(o: {
	body: () => DraftBody;
	editing: () => boolean;
	canvas: Pick<Canvas, 'toFlow'>;
	canvasEl: Ref<HTMLElement | null>;
	/** The socket under the pointer, as the cards draw it (the same state a dragged wire uses). */
	drop: Ref<{ sock: string; ok: boolean } | null>;
	/** Does what a choice at a target does: connects at a socket, adds on empty canvas. */
	applyAt: (t: MenuTarget, choice: MenuChoice) => Promise<void>;
	/** An entry on a wire: the reason it is refused (and whether the wire is locked), or null; and doing it. */
	wireVerdict: (wireId: string, choice: MenuChoice) => { reason: string; locked: boolean } | null;
	dropOnWire: (wireId: string, choice: MenuChoice, flow: { x: number; y: number } | undefined, at: { x: number; y: number }) => boolean;
	/** Says why a drop was refused, at the point (the canvas's own pixels). */
	say: (text: string, at: { x: number; y: number }) => void;
}) {
	const drag = shallowRef<PaletteDrag | null>(null);
	/** The wire under the pointer, for the wire to draw itself green or red. */
	const dropWire = ref<{ id: string; ok: boolean } | null>(null);
	let stop: (() => void) | null = null;
	/** A drag just ended on the entry it began on: the click that follows it is not a click. */
	let swallow = false;

	type Hit = Pick<PaletteDrag, 'over' | 'ok' | 'reason'> & { sock?: SocketRef; wire?: string };
	function hitAt(choice: MenuChoice, x: number, y: number): Hit {
		if (!overCanvas(o.canvasEl.value, x, y)) return { over: 'none', ok: null, reason: null };
		// The sockets are read where they are NOW: the cards glide to their places after a change, and a map can be zoomed with the wheel mid-drag.
		const spot = nearestSocket(socketSpots(o.canvasEl.value), x, y);
		if (spot) {
			const v = socketVerdict(o.body(), spot.sock, choice);
			return { over: 'socket', ok: v.ok, reason: v.ok ? null : (v.reason ?? null), sock: spot.sock };
		}
		const wire = wireAt(o.canvasEl.value, x, y);
		if (wire) {
			const refused = o.wireVerdict(wire, choice);
			return { over: 'wire', ok: !refused, reason: refused?.reason ?? null, wire };
		}
		// On a card (not one of its sockets), a control or the minimap: nowhere an entry can go. Said, so a drop there is not a silent nothing.
		return onEmptyCanvas(o.canvasEl.value, x, y) ? { over: 'canvas', ok: true, reason: null } : { over: 'none', ok: false, reason: NOT_HERE };
	}
	const relative = (x: number, y: number) => {
		const r = o.canvasEl.value?.getBoundingClientRect();
		return { x: x - (r?.left ?? 0), y: y - (r?.top ?? 0) };
	};

	/** A pointer went down on `entry`: from here it is a click (nothing, the click handler adds it) or a drag. */
	function start(entry: MenuEntry, e: PointerEvent): void {
		if (!o.editing() || !draggable(entry) || (e.pointerType === 'mouse' && e.button !== 0) || stop) return;
		const choice = entry.choice;
		const down = { x: e.clientX, y: e.clientY };
		const before = document.body.style.userSelect;
		let moved = false;
		let last: Hit = { over: 'none', ok: null, reason: null };

		const onMove = (ev: PointerEvent) => {
			if (!moved && Math.hypot(ev.clientX - down.x, ev.clientY - down.y) < DRAG_SLOP) return;
			if (!moved) {
				moved = true;
				document.body.style.userSelect = 'none';
			}
			last = hitAt(choice, ev.clientX, ev.clientY);
			o.drop.value = last.sock && last.ok !== null ? { sock: encodeSocket(last.sock), ok: !!last.ok } : null;
			dropWire.value = last.wire ? { id: last.wire, ok: !!last.ok } : null;
			drag.value = { entry, x: ev.clientX, y: ev.clientY, over: last.over, ok: last.ok, reason: last.reason };
		};
		const finish = () => {
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp);
			window.removeEventListener('pointercancel', onCancel);
			window.removeEventListener('keydown', onKey, true);
			document.body.style.userSelect = before;
			o.drop.value = null;
			dropWire.value = null;
			drag.value = null;
			stop = null;
		};
		const onUp = (ev: PointerEvent) => {
			const hit = moved ? hitAt(choice, ev.clientX, ev.clientY) : null;
			finish();
			if (!hit) return; // a click: the entry's own click handler adds it
			swallow = true;
			setTimeout(() => void (swallow = false), 0);
			const at = { x: ev.clientX, y: ev.clientY };
			if (hit.ok === false) return o.say(hit.reason ?? 'That does not fit there.', relative(at.x, at.y));
			if (hit.over === 'none') return;
			const flow = o.canvas.toFlow(at.x, at.y);
			if (hit.over === 'socket' && hit.sock) void o.applyAt({ sock: hit.sock, at, anchor: nodeIdOfSocket(o.canvasEl.value, hit.sock) }, choice);
			else if (hit.over === 'wire' && hit.wire) o.dropOnWire(hit.wire, choice, flow, relative(at.x, at.y));
			else void o.applyAt({ sock: null, at, flow }, choice);
		};
		const onCancel = () => finish();
		const onKey = (ev: KeyboardEvent) => {
			if (ev.key !== 'Escape') return;
			ev.stopPropagation();
			moved = false;
			finish();
		};
		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp);
		window.addEventListener('pointercancel', onCancel);
		window.addEventListener('keydown', onKey, true);
		stop = finish;
	}

	/** True once for the click a drag leaves behind on the entry it began on. */
	const consumeClick = (): boolean => {
		const was = swallow;
		swallow = false;
		return was;
	};

	if (getCurrentInstance()) onBeforeUnmount(() => stop?.());

	return { drag, dropWire, start, consumeClick };
}

export type AddDrag = ReturnType<typeof useAddDrag>;
