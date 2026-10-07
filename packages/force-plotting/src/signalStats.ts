// Post-mortem signal statistics, computed client-side from the live cache (no host
// round-trip). Two scopes per axis:
//   window  — mean/RMS/std/min/max over the crop window (what actually feeds the FRM)
//   signal  — quantisation + rail analysis over the WHOLE cached signal: the effective
//             bit depth "required to contain" the data, and whether it pinned at the
//             extremes (sustained rail contact = likely over-range / clipping).
// The dyno chain is 12-bit at source, so effective bits ≈ 12 means the full ADC range
// was used; much lower means under-ranged (poor resolution utilisation).
import { type Cache, idxOfTime } from './liveCache';

export interface AxisStats {
	n: number;                       // samples in the crop window
	mean: number; rms: number; std: number;
	min: number; max: number; p2p: number;   // window extremes
	effBits: number | null;          // dynamic-range bits ≈ log2(signal p2p / noise floor)
	railLoPct: number;               // % of ALL samples at the signal's global minimum
	railHiPct: number;               // % of ALL samples at the signal's global maximum
	clipped: boolean;                // sustained rail contact -> flag as likely clipping
}

export interface SignalStats {
	windowSec: [number, number];     // the crop window analysed
	axes: Record<'Fx' | 'Fy' | 'Fz', AxisStats>;
	rpm: { mean: number; std: number; min: number; max: number };
	/** Per-sample |F| = sqrt(Fx²+Fy²+Fz²) over the window (cuttingMetrics.ts). */
	resultant: { mean: number; peak: number };
	/** The cache's own crop start (s): where the turning-spiral model puts the outer diameter. */
	cacheCropStartSec: number;
}

// Noise-floor estimate via robust first differences: sigma ≈ 1.4826·median(|x[i+1]−x[i]|)/√2
// (MAD of the diffs, assuming high-frequency noise dominates sample-to-sample changes).
// NOTE a naive "smallest quantisation gap" does NOT work here: the dyno calibration sums /
// matrix-mixes 8 ADC channels, which destroys the single-axis code lattice — min-gap then
// measures float dust and reports absurd 20+ bit depths. Dynamic range vs the noise floor
// is the honest post-calibration metric.
function noiseSigma(a: Float32Array): number | null {
	const stride = Math.max(1, Math.floor(a.length / 120_000));
	const diffs: number[] = [];
	for (let i = stride; i < a.length && diffs.length < 120_000; i += stride) {
		diffs.push(Math.abs(a[i] - a[i - stride]));
	}
	if (diffs.length < 32) return null;
	diffs.sort((x, y) => x - y);
	const mad = diffs[Math.floor(diffs.length / 2)];
	const sigma = (1.4826 * mad) / Math.SQRT2;
	return sigma > 0 ? sigma : null;
}

function axisStats(a: Float32Array, i0: number, i1: number): AxisStats {
	// --- whole-signal extremes + noise floor (rails don't depend on the crop) ---
	let gMin = Infinity, gMax = -Infinity;
	for (let i = 0; i < a.length; i++) { const v = a[i]; if (v < gMin) gMin = v; if (v > gMax) gMax = v; }
	const sigma = noiseSigma(a);
	const eps = sigma != null ? sigma * 2 : (gMax - gMin) * 1e-6;
	let railLo = 0, railHi = 0, runLo = 0, runHi = 0, maxRunLo = 0, maxRunHi = 0;
	for (let i = 0; i < a.length; i++) {
		const v = a[i];
		if (v <= gMin + eps) { railLo++; runLo++; if (runLo > maxRunLo) maxRunLo = runLo; } else runLo = 0;
		if (v >= gMax - eps) { railHi++; runHi++; if (runHi > maxRunHi) maxRunHi = runHi; } else runHi = 0;
	}
	const railLoPct = (railLo / a.length) * 100;
	const railHiPct = (railHi / a.length) * 100;
	// sustained, repeated rail contact = pinned signal (over-range) rather than a single peak
	const clipped = (maxRunLo >= 5 && railLoPct > 0.02) || (maxRunHi >= 5 && railHiPct > 0.02);
	const p2pSig = gMax - gMin;
	// Dynamic-range bits: log2(signal p2p / noise floor). A clean full-range 12-bit capture
	// lands near ~12-13; well below that = under-ranged (signal buried in few noisy codes).
	const effBits = sigma != null && p2pSig > 0 ? Math.log2(p2pSig / sigma) : null;

	// --- crop-window stats ---
	let n = 0, sum = 0, sumSq = 0, mn = Infinity, mx = -Infinity;
	for (let i = i0; i <= i1; i++) {
		const v = a[i];
		n++; sum += v; sumSq += v * v;
		if (v < mn) mn = v; if (v > mx) mx = v;
	}
	const mean = n ? sum / n : 0;
	const rms = n ? Math.sqrt(sumSq / n) : 0;
	const std = n ? Math.sqrt(Math.max(0, sumSq / n - mean * mean)) : 0;
	return { n, mean, rms, std, min: mn, max: mx, p2p: mx - mn, effBits, railLoPct, railHiPct, clipped };
}

/**
 * The window the statistics panel should analyse. The dashboard's crop refs default to 0/0 when no
 * crop is set, and a crop end of 0 can never be a real window, so `end` is what says "unset" (then
 * the cache's own crop is used). A START of 0 is a real crop start: it used to be treated as unset
 * by `cropStartSec || c.csSec` and silently replaced by the cache's start (review 3.11).
 */
export function resolveStatsWindow(
	start: number | null | undefined, end: number | null | undefined, c: Pick<Cache, 'csSec' | 'ceSec'>,
): [number, number] {
	if (!end) return [c.csSec, c.ceSec];
	return [start ?? c.csSec, end];
}

export function computeSignalStats(c: Cache, cropStartSec: number, cropEndSec: number): SignalStats {
	const i0 = idxOfTime(c.t, cropStartSec);
	let i1 = idxOfTime(c.t, cropEndSec);
	if (c.t[i1] > cropEndSec && i1 > i0) i1--;
	const win: [number, number] = [c.t[i0], c.t[i1]];
	let rn = 0, rSum = 0, rSq = 0, rMin = Infinity, rMax = -Infinity;
	let fSum = 0, fPeak = 0;
	for (let i = i0; i <= i1; i++) {
		const f = Math.sqrt(c.Fx[i] * c.Fx[i] + c.Fy[i] * c.Fy[i] + c.Fz[i] * c.Fz[i]);
		fSum += f; if (f > fPeak) fPeak = f;
		const v = c.rpm[i]; rn++; rSum += v; rSq += v * v;
		if (v < rMin) rMin = v; if (v > rMax) rMax = v;
	}
	const rMean = rn ? rSum / rn : 0;
	return {
		windowSec: win,
		axes: {
			Fx: axisStats(c.Fx, i0, i1),
			Fy: axisStats(c.Fy, i0, i1),
			Fz: axisStats(c.Fz, i0, i1),
		},
		rpm: { mean: rMean, std: rn ? Math.sqrt(Math.max(0, rSq / rn - rMean * rMean)) : 0, min: rMin, max: rMax },
		resultant: { mean: rn ? fSum / rn : 0, peak: fPeak },
		cacheCropStartSec: c.csSec,
	};
}
