// The rolling force plot's time window is a VIEW parameter, not a buffer limit (#105/#76/#34).
// RecordClient keeps a fixed amount of trace history (retainSec, at least the slider's maximum)
// and each plot slices its own window out of it — so changing a window applies at once, widening
// it shows history that is already there, and two panels can show different windows of one trace.

/** Smallest window any control accepts. A non-positive window would drop every point. */
export const WINDOW_MIN_SEC = 1;
/** The window sliders' maximum, and so the least trace history RecordClient keeps. */
export const WINDOW_SLIDER_MAX_SEC = 60;
/** The number inputs' maximum, and the most trace history anything can ask RecordClient for. */
export const WINDOW_MAX_SEC = 300;
export const DEFAULT_WINDOW_SEC = 12;

/** A finite window in [WINDOW_MIN_SEC, WINDOW_MAX_SEC], or `fallback` for anything unusable
 *  (a cleared number input, NaN, a hand-edited localStorage value). */
export function clampWindowSec(v: unknown, fallback = DEFAULT_WINDOW_SEC): number {
	const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
	if (!Number.isFinite(n) || n <= 0) return fallback;
	return Math.min(WINDOW_MAX_SEC, Math.max(WINDOW_MIN_SEC, n));
}

/** First index with t[i] >= sec in an ascending array (t.length when there is none). */
export function firstAtOrAfter(t: ArrayLike<number>, sec: number): number {
	let lo = 0, hi = t.length;
	while (lo < hi) { const m = (lo + hi) >> 1; if (t[m] < sec) lo = m + 1; else hi = m; }
	return lo;
}

/**
 * What a plot of `windowSec` should draw from the ascending time axis `t`: an x-range that is
 * always exactly `windowSec` wide, and the first index to draw from. Once the history is longer
 * than the window the range is [newest - windowSec, newest], scrolling with the data. Until then
 * it is anchored at the oldest sample and the trace fills it from the left, like a sweep, rather
 * than autoscaling to whatever happens to be retained (which is why the window slider used to
 * look like it did nothing).
 *
 * i0 is one sample BEFORE the window's left edge when there is one, so a clipped plot's envelope
 * runs right up to the edge instead of starting a little way in. null when there is nothing to draw.
 */
export function windowView(t: ArrayLike<number>, windowSec: number): { i0: number; x0: number; x1: number } | null {
	const n = t.length;
	if (n === 0) return null;
	const w = clampWindowSec(windowSec);
	const newest = t[n - 1];
	if (newest - t[0] <= w) return { i0: 0, x0: t[0], x1: t[0] + w };
	const x0 = newest - w;
	return { i0: Math.max(0, firstAtOrAfter(t, x0) - 1), x0, x1: newest };
}

/** A gap is a step in time longer than this many times the typical bin spacing (#185). */
const GAP_FACTOR = 3;

/**
 * Typical spacing of the ascending time axis `t` over [from, to): the median step, estimated from
 * at most ~256 evenly spaced steps so a long window stays cheap. 0 when there are fewer than two
 * points.
 */
export function medianSpacing(t: ArrayLike<number>, from: number, to: number): number {
	const end = Math.min(to, t.length);
	const start = Math.max(0, from);
	const steps = end - start - 1;
	if (steps < 1) return 0;
	const stride = Math.max(1, Math.floor(steps / 256));
	const d: number[] = [];
	for (let i = start; i + 1 < end; i += stride) d.push(t[i + 1] - t[i]);
	d.sort((a, b) => a - b);
	return d[d.length >> 1];
}

/**
 * Split [from, to) into runs of consecutive points with no hole between them: a new run starts
 * wherever the step in time exceeds `factor` times the median spacing. A live plot that joins the
 * points across a hole draws it as a flat line (#185: the stream was away, or the backend dropped
 * frames under backpressure). Returned as [start, end) index pairs; a gap-free series is one run.
 */
export function splitAtGaps(t: ArrayLike<number>, from: number, to: number, factor = GAP_FACTOR): Array<[number, number]> {
	const end = Math.min(to, t.length);
	const start = Math.max(0, from);
	if (end <= start) return [];
	const med = medianSpacing(t, start, end);
	if (!(med > 0)) return [[start, end]];
	const limit = factor * med;
	const runs: Array<[number, number]> = [];
	let a = start;
	for (let i = start + 1; i < end; i++) {
		if (t[i] - t[i - 1] > limit) { runs.push([a, i]); a = i; }
	}
	runs.push([a, end]);
	return runs;
}
