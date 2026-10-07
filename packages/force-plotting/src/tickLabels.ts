// Axis tick labels chosen from the tick STEP, not from each value's own magnitude. frmExport's
// fmt() picks its precision per value, so on a narrow range neighbouring ticks collapse to the same
// text (12.30, 12.35 ... -> "12", "12", "12"; 1195-1205 rpm -> "1.2k" x6). With a step in hand the
// number of decimals is exactly what separates one tick from the next.

// "Nice" round tick positions across [lo, hi] (~`target` of them). Exported for ColorBar.vue's
// tick labels too -- it's the same "nice" rounding either way, no reason for a second copy just
// because the caller draws to a <canvas> here and a DOM strip there.
export function niceTicks(lo: number, hi: number, target = 6): number[] {
	const span = hi - lo;
	if (!(span > 0) || !isFinite(span)) return [lo];
	const raw = span / target;
	const mag = Math.pow(10, Math.floor(Math.log10(raw)));
	const norm = raw / mag;
	const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
	const out: number[] = [];
	for (let t = Math.ceil(lo / step) * step; t <= hi + step * 1e-6; t += step) out.push(Number(t.toFixed(6)));
	return out;
}
export function fmt(v: number): string {
	const a = Math.abs(v);
	if (a === 0) return '0';
	if (a >= 1000) return (v / 1000).toFixed(1) + 'k';
	if (a < 0.1) return v.toFixed(3);
	if (a < 10) return v.toFixed(1);
	return v.toFixed(0);
}

/** The smallest positive gap between neighbouring ticks (0 when there is none). */
export function tickStep(ticks: readonly number[]): number {
	let step = Infinity;
	for (let i = 1; i < ticks.length; i++) {
		const d = Math.abs(ticks[i] - ticks[i - 1]);
		if (d > 0 && d < step) step = d;
	}
	return Number.isFinite(step) ? step : 0;
}

/** Decimals needed so ticks `step` apart read differently: max(0, -floor(log10(step))). The tiny
 *  epsilon stops a step of 0.1 that arrives as 0.0999999999 from costing an extra digit. */
export function tickDecimals(step: number): number {
	if (!(step > 0) || !Number.isFinite(step)) return 0;
	return Math.min(8, Math.max(0, -Math.floor(Math.log10(step) + 1e-9)));
}

/** One label for `v` on an axis whose ticks are `step` apart. From a step of 100 up the one-decimal
 *  k suffix (and M from a step of 100k, once the value is in the millions) is unambiguous, so the
 *  compact form stays, as before; below that the value is written in full with `tickDecimals`. */
export function fmtTick(v: number, step: number): string {
	if (!(step > 0)) return fmt(v);
	const a = Math.abs(v);
	if (step >= 1e5 && a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
	if (step >= 100) return fmt(v);
	const s = v.toFixed(tickDecimals(step));
	return /^-0(\.0*)?$/.test(s) ? s.slice(1) : s; // never "-0.00"
}

/** Labels for a whole set of ticks, distinct from one another by construction. */
export function tickLabels(ticks: readonly number[]): string[] {
	const step = tickStep(ticks);
	return ticks.map((t) => fmtTick(t, step));
}

/** Labels for log-axis ticks (decades, or the two-point fallback): plain numbers down to 0.001,
 *  scientific below, never rounded to "0.000". */
export function logTickLabels(ticks: readonly number[]): string[] {
	return ticks.map((t) => {
		if (!(t > 0)) return fmt(t);
		if (t >= 1000) return fmt(t);
		if (t >= 0.001) return String(Number(t.toPrecision(3)));
		return Number(t.toPrecision(2)).toExponential();
	});
}
