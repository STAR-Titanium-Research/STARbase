// Fixed-bin value distribution, for the CloudCompare-style colour-scale editor's histogram strip.
// Two entry points share one binning rule -- `histogramFrom` and `createAccumulator`'s `push` both
// use the identical `floor(((v-lo)/span)*n)` formula, deliberately, so an incremental accumulator's
// running result is byte-identical to a one-shot recompute over the same data (pinned by
// histogram.test.ts's "incremental matches one-shot" case):
//
//   - `histogramFrom` -- one-shot, for a static/finished cut (FrmCloud, archived cuts): the whole
//     scalar array is already resident, so there is no reason to bin it any other way than in one
//     pass.
//   - `createAccumulator` -- incremental, for a LIVE recording: `push()` only the newly-arrived
//     slice each tick (O(1) amortised per point, cheaper than the strided sort axisAutoLimits
//     already does), and `sawOutOfRange()` flags when a live value fell outside the accumulator's
//     current [lo, hi) window so the caller can widen the range and `rebin()` -- a full recompute
//     from the resident buffer (liveClient.ts's `client.frm.cx/cy/cz` hold every point up to
//     `count`, capped at 2M, so this is bounded and needs no re-fetch).
//
// Both clamp an out-of-[lo,hi) value into the nearest edge bin rather than dropping it -- so a
// live histogram still shows a (edge-spike) shape for the points already pushed while it waits for
// the next throttled rebin, rather than silently under-counting `total`.

export interface Histogram {
	bins: Uint32Array;
	lo: number; hi: number;
	total: number;    // points binned, INCLUDING any clamped-to-edge out-of-range ones
	max: number;      // largest single-bin count, for the caller's y-axis scale
}

const DEFAULT_BINS = 64;

// NaN/Infinity are skipped entirely (not binned, not counted) -- the running channel-max buffers
// this reads from (liveClient.ts's cx/cy/cz) are otherwise always finite, but a masked/undefined
// sample elsewhere in this codebase (e.g. resid_z under a paint mask) is a real, seen NaN source.
function isBinnable(v: number): boolean {
	return Number.isFinite(v);
}

export function histogramFrom(
	arr: Float32Array, count: number, lo: number, hi: number, nBins = DEFAULT_BINS,
): Histogram {
	const n = Math.max(1, Math.round(nBins) || DEFAULT_BINS);
	const bins = new Uint32Array(n);
	const span = hi > lo ? hi - lo : 1e-9;
	const c = Math.max(0, Math.min(count, arr.length));
	let max = 0, total = 0;
	for (let i = 0; i < c; i++) {
		const v = arr[i];
		if (!isBinnable(v)) continue;
		total++;
		let idx = Math.floor(((v - lo) / span) * n);
		if (idx < 0) idx = 0; else if (idx >= n) idx = n - 1;
		const b = ++bins[idx];
		if (b > max) max = b;
	}
	return { bins, lo, hi, total, max };
}

export interface HistogramAccumulator {
	push(arr: Float32Array, from: number, to: number): void;
	sawOutOfRange(): boolean;
	rebin(lo: number, hi: number): void;
	snapshot(): Histogram;
}

export function createAccumulator(lo: number, hi: number, nBins = DEFAULT_BINS): HistogramAccumulator {
	const n = Math.max(1, Math.round(nBins) || DEFAULT_BINS);
	let _lo = lo, _hi = hi;
	let bins = new Uint32Array(n);
	let total = 0, max = 0, oor = false;

	function push(arr: Float32Array, from: number, to: number) {
		const span = _hi > _lo ? _hi - _lo : 1e-9;
		const end = Math.min(to, arr.length);
		for (let i = Math.max(0, from); i < end; i++) {
			const v = arr[i];
			if (!isBinnable(v)) continue;
			total++;
			let idx = Math.floor(((v - _lo) / span) * n);
			if (idx < 0) { oor = true; idx = 0; }
			else if (idx >= n) { oor = true; idx = n - 1; }
			const b = ++bins[idx];
			if (b > max) max = b;
		}
	}

	return {
		push,
		sawOutOfRange() { return oor; },
		rebin(newLo: number, newHi: number) {
			_lo = newLo; _hi = newHi;
			bins = new Uint32Array(n);
			total = 0; max = 0; oor = false;
		},
		// Copies `bins` so the caller (a reactive Vue ref) can hold a stable snapshot that this
		// accumulator's next push() cannot mutate out from under it.
		snapshot(): Histogram {
			return { bins: bins.slice(), lo: _lo, hi: _hi, total, max };
		},
	};
}
