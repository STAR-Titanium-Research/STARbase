// Run statistics derived from a parsed FAST trace: phases, durations, energy, densification.
// Pure functions of the trace (time in seconds, series keyed as in scripts/fast_mapping.py), so the
// Statistics tab and its tests share one definition. Every figure works on the whole run or on a time
// window (the shared zoom). A figure whose series is missing is left out, never shown as zero.

import { fmtNum } from './chartMath';
import type { Trace } from './fastCache';

export interface TimeWindow { start: number; end: number; }
type Span = [number, number];

/** Heating runs from the start to the hold, the hold is within HOLD_BAND_C of the target, cooling from the end of the hold to COOL_END_C. */
export interface Phases { heating: Span; hold: Span; cooling: Span; target: number; }
export interface StatTile { key: string; label: string; value: string; unit: string; }
export interface RunStats { phases: Phases | null; tiles: StatTile[]; }
export interface StatOptions {
	/** Target temperature in °C (the recipe's); the peak of the run when absent or never reached. */
	target?: number | null;
	/** Recorded sample mass in grams, for the energy per gram. */
	massG?: number | null;
	/** Zoom window in seconds; null or absent is the whole run. */
	window?: TimeWindow | null;
}

export const HOLD_BAND_C = 10;
export const COOL_END_C = 200;
const HOT_C = 1000;
const TEMP_KEYS = ['pyro_top', 'pyro_b', 'tc1', 'ptc_top'];
const TRAVEL_KEYS = ['piston_rel', 'piston_abs'];
/** The shrink rate is the slope over at least this long, so sensor noise does not read as a rate. */
const RATE_SPAN_S = 30;
/** The power is on above this share of the run's peak power. */
const POWER_ON_SHARE = 0.02;
/** The heating begins when the temperature has risen this far above where it started. */
const HEAT_RISE_C = 20;

/** The first of the series that has readings; `varying` also skips one that is flat or never above zero (a dead sensor). */
function usable(trace: Trace, keys: string[], varying = false): Float64Array | null {
	for (const k of keys) {
		const v = trace.series[k]?.values;
		if (!v) continue;
		let lo = Infinity, hi = -Infinity;
		for (let i = 0; i < v.length; i++) if (Number.isFinite(v[i])) { if (v[i] < lo) lo = v[i]; if (v[i] > hi) hi = v[i]; }
		if (hi >= lo && (!varying || (hi > 0 && hi > lo))) return v;
	}
	return null;
}

function peak(vals: Float64Array): number {
	let m = -Infinity;
	for (let i = 0; i < vals.length; i++) if (vals[i] > m) m = vals[i];
	return m;
}

/** The part of [a,b] inside the window, or null when they do not overlap. */
function overlap(a: number, b: number, w: Span): Span | null {
	const s = Math.max(a, w[0]), e = Math.min(b, w[1]);
	return e > s ? [s, e] : null;
}

/** Calls fn(t0, v0, t1, v1) for each segment clipped to [a,b], with the values interpolated at the cut. */
function eachSegment(time: Float64Array, vals: Float64Array, a: number, b: number, fn: (t0: number, v0: number, t1: number, v1: number) => void): void {
	for (let i = 0; i + 1 < time.length; i++) {
		const ta = time[i], tb = time[i + 1], va = vals[i], vb = vals[i + 1];
		if (tb <= a || ta >= b || !(tb > ta) || !Number.isFinite(va) || !Number.isFinite(vb)) continue;
		const s = Math.max(ta, a), e = Math.min(tb, b);
		const at = (t: number) => va + ((vb - va) * (t - ta)) / (tb - ta);
		fn(s, at(s), e, at(e));
	}
}

/** Integral of the values over [a,b] (trapezoids), in value-seconds. */
function integrate(time: Float64Array, vals: Float64Array, a: number, b: number): number {
	let sum = 0;
	eachSegment(time, vals, a, b, (t0, v0, t1, v1) => { sum += ((v0 + v1) / 2) * (t1 - t0); });
	return sum;
}

/** Time-weighted mean of the values over [a,b], leaving out the gaps where a value is missing. */
function meanOver(time: Float64Array, vals: Float64Array, a: number, b: number): number | null {
	let sum = 0, span = 0;
	eachSegment(time, vals, a, b, (t0, v0, t1, v1) => { sum += ((v0 + v1) / 2) * (t1 - t0); span += t1 - t0; });
	return span > 0 ? sum / span : null;
}

/** Seconds within [a,b] for which the value (at the start of each step) satisfies the test. */
function timeWhere(time: Float64Array, vals: Float64Array, test: (v: number) => boolean, a: number, b: number): number {
	let sum = 0;
	eachSegment(time, vals, a, b, (t0, v0, t1) => { if (test(v0)) sum += t1 - t0; });
	return sum;
}

/** When the heating begins: the temperature first 20 degC above where it started, or the power first on, whichever is earlier. */
function heatingStart(time: Float64Array, temp: Float64Array, power: Float64Array | null): number | null {
	let start = Infinity;
	const base = temp.find((v) => Number.isFinite(v));
	if (base !== undefined) { const i = temp.findIndex((v) => v >= base + HEAT_RISE_C); if (i >= 0) start = time[i]; }
	if (power) { const on = peak(power) * POWER_ON_SHARE; const i = power.findIndex((v) => v > on); if (i >= 0) start = Math.min(start, time[i]); }
	return Number.isFinite(start) ? start : null;
}

/** `start` is when the heating begins (the pump-down before it belongs to no phase); the start of the trace when absent. */
export function findPhases(time: Float64Array, temp: Float64Array, target?: number | null, start?: number | null): Phases | null {
	const n = Math.min(time.length, temp.length);
	if (n < 2) return null;
	const top = peak(temp.subarray(0, n));
	if (!(top > 0)) return null;
	const near = (goal: number) => {
		let first = -1, last = -1;
		for (let i = 0; i < n; i++) if (temp[i] >= goal - HOLD_BAND_C) { if (first < 0) first = i; last = i; }
		return [first, last] as const;
	};
	let goal = target && target > 0 ? target : top;
	let [first, last] = near(goal);
	if (first < 0) { goal = top; [first, last] = near(goal); }
	let cool = n - 1;
	for (let i = last + 1; i < n; i++) if (Number.isFinite(temp[i]) && temp[i] < COOL_END_C) { cool = i; break; }
	return {
		heating: [Math.min(start ?? time[0], time[first]), time[first]], hold: [time[first], time[last]], cooling: [time[last], time[cool]], target: goal,
	};
}

const fixed = (v: number, dp: number) => v.toFixed(dp);
const minutes = (s: number) => fixed(s / 60, 1);

export function runStats(trace: Trace, opts: StatOptions = {}): RunStats {
	const { time } = trace;
	if (time.length < 2) return { phases: null, tiles: [] };
	const t0 = time[0], tEnd = time[time.length - 1];
	const win: Span = [Math.max(t0, opts.window?.start ?? t0), Math.min(tEnd, opts.window?.end ?? tEnd)];
	const zoomed = win[0] > t0 || win[1] < tEnd;
	const temp = usable(trace, TEMP_KEYS, true);
	const power = usable(trace, ['sps_power']);
	const travel = usable(trace, TRAVEL_KEYS);
	const phases = temp ? findPhases(time, temp, opts.target, heatingStart(time, temp, power)) : null;
	const tiles: StatTile[] = [];
	const add = (key: string, label: string, value: string, unit: string) => tiles.push({ key, label, value, unit });

	add('duration', zoomed ? 'Window' : 'Run duration', minutes(win[1] - win[0]), 'min');
	if (temp) add('over', `Over ${HOT_C} °C`, minutes(timeWhere(time, temp, (v) => v >= HOT_C, win[0], win[1])), 'min');
	if (temp && phases) {
		const heat = overlap(phases.heating[0], phases.heating[1], win);
		let first = 0;
		while (first < temp.length && !Number.isFinite(temp[first])) first++;
		const ramp = heat && first < temp.length ? meanRamp(time, temp, heat, time[first]) : null;
		if (ramp !== null) add('ramp', 'Mean ramp', fmtNum(ramp), '°C/min');
	}
	let kwh: number | null = null;
	if (power) {
		kwh = integrate(time, power, win[0], win[1]) / 3600;
		const on = peak(power) * POWER_ON_SHARE;
		add('energy', zoomed ? 'Energy' : 'Total energy', fixed(kwh, 2), 'kWh');
		add('poweron', 'Power on', minutes(timeWhere(time, power, (v) => v > on, win[0], win[1])), 'min');
		const hold = phases ? overlap(phases.hold[0], phases.hold[1], win) : null;
		const holdKw = hold ? meanOver(time, power, hold[0], hold[1]) : null;
		if (holdKw !== null) add('holdpower', 'Hold power', fmtNum(holdKw), 'kW');
	}
	if (travel) {
		const moved = travelStats(time, travel, win);
		if (moved) {
			add('densification', 'Densification', fmtNum(moved.net), 'mm');
			add('shrink', 'Shrink rate', fmtNum(moved.rate), 'mm/min');
		}
	}
	if (kwh !== null && opts.massG && opts.massG > 0) add('pergram', 'Per gram', fmtNum((kwh * 1000) / opts.massG), 'Wh/g');
	return { phases, tiles };
}

/** Mean slope of the temperature across the heating inside the window, in °C/min (from the first reading when it starts later). */
function meanRamp(time: Float64Array, temp: Float64Array, heat: Span, firstReading: number): number | null {
	const a = Math.max(heat[0], firstReading), b = heat[1];
	if (!(b - a >= 1)) return null;
	const [ta, tb] = [valueAt(time, temp, a), valueAt(time, temp, b)];
	return Number.isFinite(ta) && Number.isFinite(tb) ? ((tb - ta) / (b - a)) * 60 : null;
}

function valueAt(time: Float64Array, vals: Float64Array, t: number): number {
	let lo = 0, hi = time.length - 1;
	while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (time[mid] <= t) lo = mid; else hi = mid; }
	const span = time[hi] - time[lo];
	return span > 0 ? vals[lo] + ((vals[hi] - vals[lo]) * (t - time[lo])) / span : vals[lo];
}

/** Net ram travel (mm, positive in the direction of the net move) and the fastest move (mm/min) inside the window. */
function travelStats(time: Float64Array, vals: Float64Array, win: Span): { net: number; rate: number } | null {
	const idx: number[] = [];
	for (let i = 0; i < time.length; i++) if (time[i] >= win[0] && time[i] <= win[1] && Number.isFinite(vals[i])) idx.push(i);
	if (idx.length < 2) return null;
	const delta = vals[idx[idx.length - 1]] - vals[idx[0]];
	const sign = delta < 0 ? -1 : 1;
	let rate = 0, j = 0;
	for (let k = 0; k < idx.length; k++) {
		if (j < k) j = k;
		while (j < idx.length - 1 && time[idx[j]] - time[idx[k]] < RATE_SPAN_S) j++;
		const dt = time[idx[j]] - time[idx[k]];
		if (dt >= RATE_SPAN_S) rate = Math.max(rate, (sign * (vals[idx[j]] - vals[idx[k]]) * 60) / dt);
	}
	return { net: Math.abs(delta), rate };
}

const csvCell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** The statistics as CSV (figure, value, unit): the phase durations first, then the tiles. */
export function statsCsv(stats: RunStats, scope: string): string {
	const rows = [['Figure', 'Value', 'Unit'], ['Scope', scope, '']];
	if (stats.phases) {
		for (const [name, span] of [['Heating', stats.phases.heating], ['Hold', stats.phases.hold], ['Cooling', stats.phases.cooling]] as const) {
			rows.push([`${name} duration (whole run)`, minutes(span[1] - span[0]), 'min']);
		}
	}
	for (const t of stats.tiles) rows.push([t.label, t.value, t.unit]);
	return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** Cumulative energy over the whole run in kWh, thinned to at most `points` samples for the chart. */
export function cumulativeEnergy(trace: Trace, points = 400): { t: Float64Array; kwh: Float64Array } | null {
	const power = usable(trace, ['sps_power']);
	const { time } = trace;
	if (!power || time.length < 2) return null;
	const step = Math.max(1, Math.floor(time.length / points));
	const t: number[] = [], kwh: number[] = [];
	let total = 0;
	for (let i = 0; i < time.length; i++) {
		if (i > 0) {
			const [p0, p1] = [power[i - 1], power[i]];
			if (Number.isFinite(p0) && Number.isFinite(p1)) total += ((p0 + p1) / 2) * (time[i] - time[i - 1]) / 3600;
		}
		if (i % step === 0 || i === time.length - 1) { t.push(time[i]); kwh.push(total); }
	}
	return { t: Float64Array.from(t), kwh: Float64Array.from(kwh) };
}
