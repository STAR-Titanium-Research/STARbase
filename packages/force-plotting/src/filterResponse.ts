// Analytic magnitude response of a FilterChain, for the filter preview and the spectrum's stop
// bands. Pure maths, so it works offline; applying the chain to data stays on the filter service
// (plugins/filter-service/app/filters.py, whose stages this mirrors). Butterworth stages use the
// bilinear-transform magnitude scipy's `butter` produces, and the notch is scipy's `iirnotch`, so
// the curves match the digital filters: -3.01 dB at a Butterworth cut-off, nothing at DC for a
// high-pass. Despike is non-linear and a DC-only detrend has no band, so neither is drawn.
import type { FilterChain } from './filterChain';

export interface ResponseOpts {
	/** Nyquist frequency of the signal the chain will run on (Hz). */
	nyquist: number;
	/** Mean rotation speed; notch harmonics are multiples of rpm / 60 (the service's rule). */
	rpm?: number | null;
	/** Filter passes. The service runs zero-phase (forward and back = 2), which doubles the dB
	 *  figures; the preview defaults to one pass, the textbook response. */
	passes?: number;
}

export type StageId = 'detrend' | 'highpass' | 'lowpass' | 'notch';

export interface ResponseStage { id: StageId; label: string; db: number[] }
export interface FilterResponseCurves { f: number[]; combined: number[]; stages: ResponseStage[] }

/** Where a stage cuts: a stop band [f0, f1] (Hz) with a short label. */
export interface StopBand { id: StageId; f0: number; f1: number; label: string }

/** The response never reads below this; a notch's exact zero would be -Infinity. */
export const FLOOR_DB = -120;

/** `n` log-spaced frequencies from `fMin` to `nyquist`. */
export function logFrequencies(fMin: number, nyquist: number, n = 240): number[] {
	const a = Math.log10(fMin), b = Math.log10(nyquist);
	return Array.from({ length: n }, (_, i) => 10 ** (a + ((b - a) * i) / (n - 1)));
}

/** "50 Hz", "2 kHz", "3.2 kHz"; without the unit (axis ticks) "50", "2k", "3.2k". */
export function fmtHz(f: number, unit = true): string {
	const k = f >= 1000, n = Number((k ? f / 1000 : f).toPrecision(3));
	return unit ? `${n} ${k ? 'kHz' : 'Hz'}` : `${n}${k ? 'k' : ''}`;
}

const toDb = (power: number) => Math.max(FLOOR_DB, 10 * Math.log10(Math.max(power, 1e-30)));

/** Gain (dB) of a digital Butterworth low- or high-pass of `order` at `f`. */
export function butterDb(kind: 'lowpass' | 'highpass', f: number, cutoff: number, order: number, nyquist: number): number {
	const k = Math.PI / (2 * nyquist);
	const r = Math.tan(Math.min(f, nyquist * 0.999999) * k) / Math.tan(cutoff * k);
	return toDb(1 / (1 + (kind === 'lowpass' ? r : 1 / r) ** (2 * order)));
}

/** Gain (dB) of scipy's `iirnotch(f0 / nyquist, q)` at `f`. */
export function notchDb(f: number, f0: number, q: number, nyquist: number): number {
	const w = (Math.PI * f) / nyquist, w0 = (Math.PI * f0) / nyquist;
	const g = 1 / (1 + Math.tan(w0 / q / 2));
	const c0 = Math.cos(w0);
	// |x0 + x1 z^-1 + x2 z^-2|^2 on the unit circle, for b = g * [1, -2 c0, 1] and a = [1, -2 g c0, 2 g - 1]
	const mag2 = (x0: number, x1: number, x2: number) => {
		const re = x0 + x1 * Math.cos(w) + x2 * Math.cos(2 * w);
		const im = x1 * Math.sin(w) + x2 * Math.sin(2 * w);
		return re * re + im * im;
	};
	return toDb(mag2(g, -2 * g * c0, g) / mag2(1, -2 * g * c0, 2 * g - 1));
}

/** The rotation speed the service notches at: the mean of the cache's rpm channel (0 when empty). */
export function meanRpm(rpm: ArrayLike<number> | null | undefined): number {
	if (!rpm || !rpm.length) return 0;
	let s = 0;
	for (let i = 0; i < rpm.length; i++) s += rpm[i];
	return s / rpm.length;
}

/** The notch frequencies of a chain (Hz): each harmonic times the rotation frequency. */
export function notchFrequencies(chain: FilterChain, rpm: number | null | undefined, nyquist: number): number[] {
	const f0 = (rpm ?? 0) / 60;
	if (!chain.notch.on || !(f0 > 0)) return [];
	return chain.notch.harmonics.map((h) => f0 * h).filter((f) => f > 0 && f < nyquist);
}

/** The linear stages of the chain that are on and below Nyquist: what the response is built from. */
function activeStages(chain: FilterChain, o: ResponseOpts) {
	const out: { id: StageId; label: string; fn: (f: number) => number }[] = [];
	const ny = o.nyquist;
	const d = chain.detrend;
	if (d.on && d.mode === 'highpass' && d.cutoff_hz < ny) out.push({ id: 'detrend', label: 'Detrend', fn: (f) => butterDb('highpass', f, d.cutoff_hz, 2, ny) });
	const hp = chain.highpass;
	if (hp.on && hp.cutoff_hz < ny) out.push({ id: 'highpass', label: 'High-pass', fn: (f) => butterDb('highpass', f, hp.cutoff_hz, hp.order, ny) });
	const lp = chain.lowpass;
	if (lp.on && lp.cutoff_hz < ny) out.push({ id: 'lowpass', label: 'Low-pass', fn: (f) => butterDb('lowpass', f, lp.cutoff_hz, lp.order, ny) });
	const nf = notchFrequencies(chain, o.rpm, ny);
	if (nf.length) out.push({ id: 'notch', label: 'Notch', fn: (f) => nf.reduce((s, f0) => s + notchDb(f, f0, chain.notch.q, ny), 0) });
	return out;
}

/** Gain in dB of every active stage and of the whole chain at each frequency in `f`. */
export function filterResponse(chain: FilterChain, f: number[], o: ResponseOpts): FilterResponseCurves {
	const passes = o.passes ?? 1;
	const stages = activeStages(chain, o).map((s) => ({ id: s.id, label: s.label, db: f.map((x) => Math.max(FLOOR_DB, s.fn(x) * passes)) }));
	const combined = f.map((_, i) => Math.max(FLOOR_DB, stages.reduce((s, st) => s + st.db[i], 0)));
	return { f, combined, stages };
}

/** The stop bands to shade on a spectrum: below a high-pass cut-off, above a low-pass cut-off,
 *  and a notch's -3 dB width (f0 / Q) around each harmonic. */
export function stopBands(chain: FilterChain | null | undefined, o: ResponseOpts): StopBand[] {
	if (!chain) return [];
	const ny = o.nyquist, out: StopBand[] = [];
	const d = chain.detrend, hp = chain.highpass, lp = chain.lowpass;
	if (d.on && d.mode === 'highpass' && d.cutoff_hz < ny) out.push({ id: 'detrend', f0: 0, f1: d.cutoff_hz, label: `Detrend ${fmtHz(d.cutoff_hz)}` });
	if (hp.on && hp.cutoff_hz < ny) out.push({ id: 'highpass', f0: 0, f1: hp.cutoff_hz, label: `High-pass ${fmtHz(hp.cutoff_hz)}` });
	if (lp.on && lp.cutoff_hz < ny) out.push({ id: 'lowpass', f0: lp.cutoff_hz, f1: ny, label: `Low-pass ${fmtHz(lp.cutoff_hz)}` });
	for (const f of notchFrequencies(chain, o.rpm, ny)) {
		const half = f / chain.notch.q / 2;
		out.push({ id: 'notch', f0: f - half, f1: Math.min(ny, f + half), label: `Notch ${fmtHz(f)}` });
	}
	return out;
}
