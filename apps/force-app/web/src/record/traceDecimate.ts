// Per-pixel min/max decimation for the end-of-cut force trace (#77). A finished cut is 250k+
// samples per channel; stroking every one of them on each crop-handle drag frame is what made the
// handles lag. One column per device pixel keeps every visible feature -- each column draws its
// first, min, max and last sample, so a spike narrower than a pixel still shows at full height and
// neighbouring columns join up exactly as the full-resolution polyline would.
export interface Decimated {
	cols: number;
	/** Per column; NaN where no sample falls in the column. */
	first: Float32Array;
	min: Float32Array;
	max: Float32Array;
	last: Float32Array;
}

/** Min and max over every array, or null when there are no finite values. */
export function seriesRange(arrays: readonly ArrayLike<number>[]): [number, number] | null {
	let lo = Infinity, hi = -Infinity;
	for (const a of arrays) {
		for (let i = 0; i < a.length; i++) {
			const v = a[i];
			if (v < lo) lo = v;
			if (v > hi) hi = v;
		}
	}
	return Number.isFinite(lo) && Number.isFinite(hi) ? [lo, hi] : null;
}

/**
 * Bucket `v` (sampled at times `t`, ascending) into `cols` equal time columns over [t0, t1].
 * Samples outside the window are ignored.
 */
export function decimateMinMax(
	t: ArrayLike<number>, v: ArrayLike<number>, t0: number, t1: number, cols: number,
): Decimated {
	const n = Math.max(1, Math.floor(cols));
	const first = new Float32Array(n).fill(NaN);
	const min = new Float32Array(n).fill(NaN);
	const max = new Float32Array(n).fill(NaN);
	const last = new Float32Array(n).fill(NaN);
	const span = t1 - t0;
	const len = Math.min(t.length, v.length);
	if (!(span > 0)) return { cols: n, first, min, max, last };
	const k = n / span;
	for (let i = 0; i < len; i++) {
		const ti = t[i];
		if (ti < t0 || ti > t1) continue;
		const c = Math.min(n - 1, Math.floor((ti - t0) * k));
		const y = v[i];
		if (Number.isNaN(first[c])) { first[c] = y; min[c] = y; max[c] = y; }
		else { if (y < min[c]) min[c] = y; if (y > max[c]) max[c] = y; }
		last[c] = y;
	}
	return { cols: n, first, min, max, last };
}

/** Decimating only pays off when there are clearly more samples than columns to draw them in. */
export function shouldDecimate(samples: number, cols: number): boolean {
	return samples > cols * 4;
}
