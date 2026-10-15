// Touch on the Process map (spec D24): a finger resting on a card for 500 ms shows its hover card; a
// move of more than 10 px (a pan, a drag) cancels it; a tap just selects. Pure timers: no Vue, no DOM,
// tested with fake timers. The page feeds it the canvas's pointer events.

export const LONG_PRESS_MS = 500;
export const LONG_PRESS_SLOP = 10;

export interface LongPress<T> {
	/** A finger went down at (x, y) on `payload`; fires after the delay unless cancelled. Starting again cancels the one before. */
	start(x: number, y: number, payload: T): void;
	/** The finger moved: further than the slop from where it went down cancels. */
	move(x: number, y: number): void;
	/** The finger lifted, or the gesture became a pan or pinch: nothing fires any more. */
	cancel(): void;
	/** True once after a press that fired: the click that follows the lift is not a tap. */
	consumeFired(): boolean;
}

export function createLongPress<T>(fire: (payload: T) => void, opts: { delay?: number; slop?: number } = {}): LongPress<T> {
	const delay = opts.delay ?? LONG_PRESS_MS;
	const slop = opts.slop ?? LONG_PRESS_SLOP;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let origin = { x: 0, y: 0 };
	let fired = false;
	const stop = () => {
		if (timer) clearTimeout(timer);
		timer = null;
	};
	return {
		start(x, y, payload) {
			stop();
			fired = false;
			origin = { x, y };
			timer = setTimeout(() => {
				timer = null;
				fired = true;
				fire(payload);
			}, delay);
		},
		move(x, y) {
			if (timer && Math.hypot(x - origin.x, y - origin.y) > slop) stop();
		},
		cancel: stop,
		consumeFired() {
			const was = fired;
			fired = false;
			return was;
		},
	};
}

/**
 * Whether the last pointer was a finger. Phones send an emulated mouseenter after a tap, which would
 * open the hover card on every tap; while a finger is the pointer the page ignores hovers (a long
 * press asks for the card itself). A mouse move, or a key, hands control back.
 */
export function createPointerKind() {
	let touch = false;
	return {
		note(pointerType: string): void {
			if (pointerType === 'touch') touch = true;
			else if (pointerType === 'mouse') touch = false;
		},
		keyboard(): void {
			touch = false;
		},
		get touch(): boolean {
			return touch;
		},
	};
}
