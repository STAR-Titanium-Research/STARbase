// Tick maths for ForceChart's axes (DESIGN.md 5b, "Chart rules"): steps of 1, 2, 2.5 or 5 x 10^n,
// five or six ticks, the top tick above the data, real minus signs, and decade ticks with fainter
// minor lines on a log frequency axis. Pure, so it is unit-tested without a DOM.
import { tickLabels } from './tickLabels';

const STEP_FACTORS = [1, 2, 2.5, 5, 10];

// Floating-point noise out of k * step (0.1 * 3 = 0.30000000000000004).
const clean = (v: number) => Number(v.toPrecision(12));

/** The smallest 1/2/2.5/5 x 10^n step for which `count(step)` is at most `maxTicks`. */
function pickStep(span: number, maxTicks: number, count: (step: number) => number): number {
	const mag = 10 ** Math.floor(Math.log10(span / maxTicks));
	for (let m = mag / 10; m <= mag * 1000; m *= 10) {
		for (const f of STEP_FACTORS) if (count(f * m) <= maxTicks) return f * m;
	}
	return span;
}

/** A y scale over [lo, hi]: ticks every nice step, the range grown to the step on both sides so the
 *  top tick is at or above the data. */
export function niceScale(lo: number, hi: number, maxTicks = 6): { lo: number; hi: number; step: number; ticks: number[] } {
	if (!(hi > lo)) hi = lo + 1;
	const step = pickStep(hi - lo, maxTicks, (s) => Math.ceil(hi / s - 1e-9) - Math.floor(lo / s + 1e-9) + 1);
	const a = Math.floor(lo / step + 1e-9), b = Math.ceil(hi / step - 1e-9);
	const ticks: number[] = [];
	for (let k = a; k <= b; k++) ticks.push(clean(k * step));
	return { lo: clean(a * step), hi: clean(b * step), step, ticks };
}

/** Nice ticks that lie inside [x0, x1] (an x axis keeps its range; it does not grow). */
export function niceTicksIn(x0: number, x1: number, maxTicks = 6): number[] {
	if (!(x1 > x0)) return [x0];
	const step = pickStep(x1 - x0, maxTicks, (s) => Math.floor(x1 / s + 1e-9) - Math.ceil(x0 / s - 1e-9) + 1);
	const out: number[] = [];
	for (let k = Math.ceil(x0 / step - 1e-9); k * step <= x1 + step * 1e-9; k++) out.push(clean(k * step));
	return out;
}

/** Labels for a set of linear ticks, with the ASCII hyphen swapped for a real minus sign. */
export function axisLabels(ticks: readonly number[]): string[] {
	return tickLabels(ticks).map((s) => s.replace('-', '−'));
}

/** dB re 1 N of a magnitude in N (floored so a zero bin is not -Infinity). */
export const toDb = (a: number) => 20 * Math.log10(Math.max(a, 1e-9));

/** A spectrum {f, amp} with its amplitudes in dB. */
export const dbSeries = (d: { f: ArrayLike<number>; amp: ArrayLike<number> }) => ({ f: d.f, amp: Array.from(d.amp, toDb) });

/** Where a log frequency axis starts: the decade of the first non-zero bin, never below 1 Hz. */
export function firstDecade(freqs: ArrayLike<number>): number {
	for (let i = 0; i < freqs.length; i++) if (freqs[i] > 0) return Math.max(1, 10 ** Math.floor(Math.log10(freqs[i])));
	return 1;
}

/** Which labels fit: of spans [x0, x1] (px), the leftmost is kept, then each one that starts at
 *  least `gap` past the last kept. Flags come back in the order given. */
export function labelsThatFit(spans: { x0: number; x1: number }[], gap = 4): boolean[] {
	const keep = spans.map(() => false);
	let end = -Infinity;
	for (const i of spans.map((_, k) => k).sort((a, b) => spans[a].x0 - spans[b].x0)) {
		if (spans[i].x0 >= end + gap) { keep[i] = true; end = spans[i].x1; }
	}
	return keep;
}

/** Ticks of a log axis over [x0, x1] (both above 0): `major` carry labels (the decades, or 1/2/5 of
 *  a decade when the range spans less than two of them), `minor` are the 2-9 lines between. */
export function logTicks(x0: number, x1: number): { major: number[]; minor: number[] } {
	const major: number[] = [], minor: number[] = [];
	if (!(x0 > 0) || !(x1 > x0)) return { major, minor };
	const k0 = Math.floor(Math.log10(x0)), k1 = Math.ceil(Math.log10(x1));
	const decades = Math.floor(Math.log10(x1)) - Math.ceil(Math.log10(x0)) + 1;
	for (let k = k0; k <= k1; k++) {
		for (let m = 1; m <= 9; m++) {
			const v = clean(m * 10 ** k);
			if (v < x0 * (1 - 1e-9) || v > x1 * (1 + 1e-9)) continue;
			(m === 1 || (decades < 2 && (m === 2 || m === 5)) ? major : minor).push(v);
		}
	}
	return { major, minor };
}
