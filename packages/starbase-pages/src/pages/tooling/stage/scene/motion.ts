// The one policy for motion in the 3D view: everything animates (camera flights between focuses, the recentre, the
// spring back at the rotation limits, insert lifts), because a view that snaps is hard to follow. Under
// prefers-reduced-motion the same moves are just a little shorter (REDUCED_SCALE), never instant. Pure: the durations
// and eases here are all the scene needs.

export const REDUCED_SCALE = 0.75;

// How long each move takes (ms), before the reduced-motion scaling.
export const FLIGHT_MS = 400; // the camera from one focus to the next, and the selected insert's lift in step with it
export const RECENTRE_MS = 380; // back to the focus's own framing after the user lets go
export const HOVER_UP_MS = 150; // a hovered insert rising a little
export const HOVER_DOWN_MS = 200; // ... and settling back

export function prefersReducedMotion(): boolean {
	try {
		return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
	} catch {
		return false;
	}
}

// A duration under the user's motion preference: a little shorter when they prefer reduced motion, never zero.
export function motionMs(ms: number, reduced = prefersReducedMotion()): number {
	return Math.max(1, reduced ? ms * REDUCED_SCALE : ms);
}

export function easeInOutCubic(t: number): number {
	const x = Math.min(1, Math.max(0, t));
	return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

export function easeOutCubic(t: number): number {
	const x = Math.min(1, Math.max(0, t));
	return 1 - Math.pow(1 - x, 3);
}

export type Ease = (t: number) => number;
