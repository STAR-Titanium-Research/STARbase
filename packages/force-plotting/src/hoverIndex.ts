// Pointer -> sample index for ForceChart's shared hover crosshair.
//
// The plot's x-axis spans the VISIBLE window [x0, x1], which is narrower than xs once the view is
// zoomed, so a pixel fraction must map to x0 + frac*(x1 - x0) and then to the nearest sample by
// value. The old code applied the fraction to the whole index range, so after any zoom the
// crosshair landed on the wrong sample (review 3.4).

/** Index in [lo, hi] of the element of ascending `xs` nearest to `x` (ties go to the lower index). */
export function nearestIndex(xs: ArrayLike<number>, x: number, lo = 0, hi = xs.length - 1): number {
	if (hi < lo) return lo;
	let a = lo, b = hi;
	while (a < b) {
		const mid = (a + b) >> 1;
		if (xs[mid] < x) a = mid + 1; else b = mid;
	}
	// a = first index with xs[a] >= x (or hi); the nearer of a and its predecessor wins.
	if (a > lo && Math.abs(x - xs[a - 1]) <= Math.abs(xs[a] - x)) a--;
	return a;
}

/** Hover index for a pointer at `frac` (0..1, clamped) across the plot window [x0, x1]; result stays inside [iA, iB]. */
export function hoverIndexAt(xs: ArrayLike<number>, x0: number, x1: number, frac: number, iA = 0, iB = xs.length - 1): number {
	const f = Math.min(1, Math.max(0, frac));
	return nearestIndex(xs, x0 + f * (x1 - x0), iA, iB);
}
