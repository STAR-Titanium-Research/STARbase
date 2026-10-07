// Pass-to-pass differencing: align two cuts' per-revolution signals onto their shared
// overlapping revolution range and subtract. What's consistent between two passes on the
// same tool/insert is most likely the tool/machine signature; what survives the subtraction
// is more likely material variation -- the highest-information single feature for telling
// those two apart, and cheap enough (one interpolation, one subtraction) to run client-side
// once both passes' WorkingSets are already loaded, unlike the server-side Gi*/HDBSCAN work.

export interface AlignedDiff {
	rev: Float32Array;
	aAligned: Float32Array;
	bAligned: Float32Array;
	diff: Float32Array;
}

/** Optional [lo, hi] (same units as rev) the overlap is further restricted to. */
export type RevRange = readonly [number, number];

// Linear interpolation mirroring numpy's np.interp (the same primitive
// scripts/diag/angular.py's angular_resample already uses server-side): `xp` must be sorted
// ascending; `x` is assumed sorted ascending too (true by construction here, since it's a
// evenly-spaced generated grid), which lets the lookup walk forward with a single pointer
// instead of binary-searching per query point.
function interp(x: Float32Array, xp: Float32Array, fp: Float32Array): Float32Array {
	const out = new Float32Array(x.length);
	let j = 0;
	for (let i = 0; i < x.length; i++) {
		const xi = x[i];
		if (xi <= xp[0]) {
			out[i] = fp[0];
			continue;
		}
		if (xi >= xp[xp.length - 1]) {
			out[i] = fp[fp.length - 1];
			continue;
		}
		while (j < xp.length - 2 && xp[j + 1] < xi) j++;
		const x0 = xp[j];
		const x1 = xp[j + 1];
		const y0 = fp[j];
		const y1 = fp[j + 1];
		const t = (xi - x0) / (x1 - x0);
		out[i] = y0 + t * (y1 - y0);
	}
	return out;
}

export function alignAndDiff(
	revA: Float32Array,
	sigA: Float32Array,
	revB: Float32Array,
	sigB: Float32Array,
	samplesPerRev: number,
	range?: RevRange,
): AlignedDiff {
	if (revA.length !== sigA.length) {
		throw new Error(`revA/sigA length mismatch: ${revA.length} vs ${sigA.length}`);
	}
	if (revB.length !== sigB.length) {
		throw new Error(`revB/sigB length mismatch: ${revB.length} vs ${sigB.length}`);
	}
	const lo = Math.max(revA[0], revB[0], range?.[0] ?? -Infinity);
	const hi = Math.min(revA[revA.length - 1], revB[revB.length - 1], range?.[1] ?? Infinity);
	if (hi <= lo) {
		throw new Error(
			`no overlapping revolution range between the two cuts (A: [${revA[0]}, ${revA[revA.length - 1]}], B: [${revB[0]}, ${revB[revB.length - 1]}])`,
		);
	}
	const n = Math.floor((hi - lo) * samplesPerRev);
	if (n < 1) {
		throw new Error('overlapping revolution range too small to resample');
	}
	const rev = new Float32Array(n);
	for (let i = 0; i < n; i++) rev[i] = lo + i / samplesPerRev;

	const aAligned = interp(rev, revA, sigA);
	const bAligned = interp(rev, revB, sigB);
	const diff = new Float32Array(n);
	for (let i = 0; i < n; i++) diff[i] = aAligned[i] - bAligned[i];

	return { rev, aAligned, bAligned, diff };
}

// ---- Difference of two stored force envelopes -------------------------------------------------
// The Plot page keeps each cut's force as a min/max envelope ({ t, min, max }) on the analysis row,
// which is what Compare already has loaded for every chip. Differencing works on its mid-line,
// aligned on the overlapping stretch of the two time bases (the "rev" argument of alignAndDiff is
// just a monotone x; seconds here).

export interface EnvelopeSeries { t: ArrayLike<number>; min: ArrayLike<number>; max: ArrayLike<number> }

export interface EnvelopeDiff {
	/** Shared x (seconds) the difference is sampled on. */
	t: Float32Array;
	/** current - reference. */
	diff: Float32Array;
	mean: number;
	rms: number;
}

const MAX_DIFF_POINTS = 4000;

function midLine(s: EnvelopeSeries): { x: Float32Array; y: Float32Array } | null {
	const n = Math.min(s.t?.length ?? 0, s.min?.length ?? 0, s.max?.length ?? 0);
	if (n < 2) return null;
	const x = new Float32Array(n), y = new Float32Array(n);
	for (let i = 0; i < n; i++) { x[i] = s.t[i]; y[i] = (s.min[i] + s.max[i]) / 2; }
	return x[n - 1] > x[0] ? { x, y } : null;
}

/** Mean and root-mean-square of a difference trace. */
export function diffStats(diff: ArrayLike<number>): { mean: number; rms: number } {
	let sum = 0, sq = 0;
	for (let i = 0; i < diff.length; i++) { sum += diff[i]; sq += diff[i] * diff[i]; }
	const n = diff.length || 1;
	return { mean: sum / n, rms: Math.sqrt(sq / n) };
}

// ---- Windowing -----------------------------------------------------------------------------------
// Compare draws every cut at its own recording time (series t), so the Difference is windowed in
// that same base: the intersection of the two cuts' crop windows (the part that is actually the
// cut, not lead-in/out air) and, when the chart is zoomed, the zoomed x-range.

export interface TimeWindow { start: number; end: number }

/** The fields of an analysis row that define its crop (what the dashboard's crop handles use). */
export interface CropFields {
	sample_rate?: number | null;
	cut_start_idx?: number | null;
	cut_end_idx?: number | null;
	crop_start_idx_override?: number | null;
	crop_end_idx_override?: number | null;
}

/** A cut's crop window in seconds: a saved override wins over the derived auto-crop; null when it
 *  has neither (or no sample rate), i.e. unbounded. */
export function cropWindowSec(row: CropFields | null | undefined): TimeWindow | null {
	const fs = Number(row?.sample_rate);
	if (!row || !(fs > 0)) return null;
	const pick = (a: number | null | undefined, b: number | null | undefined) =>
		a != null && b != null ? { start: Number(a) / fs, end: Number(b) / fs } : null;
	const w = pick(row.crop_start_idx_override, row.crop_end_idx_override) ?? pick(row.cut_start_idx, row.cut_end_idx);
	return w && Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start ? w : null;
}

/** Intersect windows; a null/undefined window is unbounded. Returns null when every input is
 *  unbounded, and a window with end <= start when they do not overlap. */
export function intersectWindows(...windows: (TimeWindow | null | undefined)[]): TimeWindow | null {
	let out: TimeWindow | null = null;
	for (const w of windows) {
		if (!w) continue;
		out = out ? { start: Math.max(out.start, w.start), end: Math.min(out.end, w.end) } : { ...w };
	}
	return out;
}

/** The window the Difference is computed over: both cuts' crops, then the zoom (when both zoom
 *  ends are set). null means unrestricted. */
export function diffWindow(
	currentCrop: TimeWindow | null | undefined, referenceCrop: TimeWindow | null | undefined,
	zoomStart: number | null | undefined, zoomEnd: number | null | undefined,
): TimeWindow | null {
	const zoom = zoomStart != null && zoomEnd != null && Number.isFinite(zoomStart) && Number.isFinite(zoomEnd)
		? { start: Math.min(zoomStart, zoomEnd), end: Math.max(zoomStart, zoomEnd) } : null;
	return intersectWindows(currentCrop, referenceCrop, zoom);
}

/**
 * current - reference over the time range both envelopes cover (and `window`, when given), or null
 * when either is unusable or they do not overlap. Never throws: this feeds a live readout, and a bad
 * cut should just show "no overlap" rather than break the panel.
 */
export function diffEnvelopes(
	current: EnvelopeSeries | null | undefined, reference: EnvelopeSeries | null | undefined,
	window?: TimeWindow | null,
): EnvelopeDiff | null {
	if (!current || !reference) return null;
	const a = midLine(current), b = midLine(reference);
	if (!a || !b) return null;
	const lo = Math.max(a.x[0], b.x[0], window?.start ?? -Infinity);
	const hi = Math.min(a.x[a.x.length - 1], b.x[b.x.length - 1], window?.end ?? Infinity);
	if (!(hi > lo)) return null;
	// Resolve the denser of the two traces, bounded so a long recording stays cheap to redraw.
	const density = Math.max(a.x.length / (a.x[a.x.length - 1] - a.x[0]), b.x.length / (b.x[b.x.length - 1] - b.x[0]));
	const spr = Math.min(density, MAX_DIFF_POINTS / (hi - lo));
	try {
		const r = alignAndDiff(a.x, a.y, b.x, b.y, spr, window ? [lo, hi] : undefined);
		return { t: r.rev, diff: r.diff, ...diffStats(r.diff) };
	} catch { return null; }
}
