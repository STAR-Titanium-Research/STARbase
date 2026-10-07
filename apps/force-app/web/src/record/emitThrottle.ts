// Leading + trailing throttle for a value that changes many times a second but only needs
// publishing a few times a second (LiveFrm's colour-scale histogram, #103).
//
// A leading-only throttle drops the LAST change of a burst whenever it lands inside the interval,
// and nothing ever publishes it if no further change follows — which is exactly what happens when
// playback pauses or a scrub settles: the histogram was left showing the empty strip a reset had
// just published, until the next change, which while paused never comes. `flush` is the trailing
// edge that publishes it once the interval has passed.
export interface EmitThrottle {
	/** Something changed at `now`. True = publish now; false = it is pending for flush(). */
	mark(now: number, force?: boolean): boolean;
	/** Trailing edge: true once a pending change has waited out the interval. */
	flush(now: number): boolean;
	readonly pending: boolean;
}

export function createEmitThrottle(intervalMs: number): EmitThrottle {
	let last = -Infinity;
	let pending = false;
	return {
		mark(now, force = false) {
			if (force || now - last >= intervalMs) { last = now; pending = false; return true; }
			pending = true;
			return false;
		},
		flush(now) {
			if (!pending || now - last < intervalMs) return false;
			last = now; pending = false;
			return true;
		},
		get pending() { return pending; },
	};
}
