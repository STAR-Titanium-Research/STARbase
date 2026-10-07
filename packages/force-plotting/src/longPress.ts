// Touch long-press -> context menu. A touchscreen has no right button, and iOS Safari fires no
// `contextmenu` on a hold (Android Chrome does, on its own timing), so the map views and the env
// charts open their menus from this instead: one finger held within a small slop for ~500 ms.
//
// Pure of the DOM (it takes the few PointerEvent fields it reads and uses setTimeout), so it is
// unit-tested with fake timers. Mouse and pen presses are ignored: the mouse has the real right
// button (createClickTracker in cloudPick.ts), and a pen's barrel button reaches `contextmenu`.

/**
 * How far down-right of the finger a long-press menu opens. The menu's first item would otherwise
 * sit exactly under the held finger, and the release (or the click some browsers synthesise from
 * it) could activate it. The menu clamps itself into the viewport, so near an edge it shifts back.
 */
export const TOUCH_MENU_OFFSET_PX = 24;

// isPrimary is optional so hand-built events (tests) can omit it: absent means "not known to be a new gesture".
export interface PressEvent { pointerId: number; pointerType: string; clientX: number; clientY: number; isPrimary?: boolean }

/**
 * Is this `contextmenu` the browser's echo of a touch hold (ours already opened the menu: swallow it)?
 * Only while a touch is down, and never for a mouse: Chrome's contextmenu is a PointerEvent whose
 * pointerType says which device raised it; other browsers send a plain MouseEvent (no pointerType),
 * which can only be a touch echo while a finger is actually down.
 */
export function isTouchContextMenu(ev: MouseEvent, touching: boolean): boolean {
	return touching && (ev as PointerEvent).pointerType !== 'mouse';
}

export function createLongPress(
	onPress: (clientX: number, clientY: number) => void, holdMs = 500, slopPx = 10,
) {
	const down = new Set<number>();   // touch pointers currently on the screen
	let id = -1, x = 0, y = 0, x0 = 0, y0 = 0, timer: ReturnType<typeof setTimeout> | null = null;
	const stop = () => { if (timer !== null) { clearTimeout(timer); timer = null; } id = -1; };
	const isTouch = (ev: PressEvent) => ev.pointerType === 'touch';
	return {
		/** A pointerdown. Starts the hold timer for a lone touch; a second finger cancels it for good. */
		down(ev: PressEvent) {
			if (!isTouch(ev)) return;
			// The first finger of a gesture is `isPrimary`: it starts a new one, so any pointer still in the set
			// is stale (its pointerup went to a canvas that was swapped out, or to another element) and would
			// otherwise make every later hold look like a second finger.
			if (ev.isPrimary) { down.clear(); stop(); }
			down.add(ev.pointerId);
			if (down.size > 1) { stop(); return; }   // a pan/pinch, not a hold (the timer only ever starts here)
			id = ev.pointerId; x = x0 = ev.clientX; y = y0 = ev.clientY;
			timer = setTimeout(() => { timer = null; onPress(x, y); }, holdMs);
		},
		/** A pointermove: drifting past the slop turns the hold into a pan. Follows the finger inside the slop. */
		move(ev: PressEvent) {
			if (ev.pointerId !== id) return;
			if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > slopPx) { stop(); return; }   // measured from where it landed, so a slow drift can't creep past
			x = ev.clientX; y = ev.clientY;   // the menu opens where the finger is now, not where it landed
		},
		/** A pointerup or pointercancel: the finger is gone, so a pending hold is cancelled. */
		up(ev: PressEvent): void {
			if (!isTouch(ev)) return;
			down.delete(ev.pointerId);
			if (ev.pointerId === id) stop();
		},
		/** Whether a touch is on the screen: a `contextmenu` the browser raises for it is ours to swallow. */
		get touching(): boolean { return down.size > 0; },
		/** Drop everything (unmount, deactivate). */
		cancel() { down.clear(); stop(); },
	};
}
