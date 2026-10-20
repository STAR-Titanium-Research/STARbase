// Pointer -> sample index for ForceChart's shared hover crosshair.
//
// The plot's x-axis spans the VISIBLE window, narrower than xs once the view is zoomed, so the
// pointer's x value (geom.xAt, linear or log) is matched to the nearest sample by value; applying a
// pixel fraction to the whole index range put the crosshair on the wrong sample after any zoom.

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
