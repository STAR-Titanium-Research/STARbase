// Per-run summary over a run window of a Conform log.
import type { Trace } from '../fastCache';
import { energyKwh, powerChannels, type EnergyKwh, type PowerPart } from './power';

export interface ConformSummary {
	version: 1; duration_s: number; n_rows: number; gaps: number;
	extruding_s: number; mean_wheel_speed_rpm: number | null; mean_torque_pct: number | null; mean_tooling1_c: number | null;
	peak_torque_pct: number | null; peak_motor_current_a: number | null; peak_tooling1_c: number | null; peak_wheel_temp_c: number | null;
	ips_setpoint_c: number | null; energy_kwh: EnergyKwh; avg_demand_kw: number; missing: PowerPart[];
}

/** "Extruding": wheel speed at least this, and motor torque above the other. */
export const EXTRUDING_MIN_RPM = 1;
export const EXTRUDING_MIN_TORQUE_PCT = 10;
const GAP_S = 1.5;

export const traceValues = (trace: Trace, key: string): Float64Array | undefined => trace.series[key]?.values;

/**
 * The rows [from, to) of the trace whose instant t satisfies start <= t < end. When `endMs` reaches the log's
 * last row, that row is included too, so a whole-log window covers the whole log.
 */
export function windowRows(trace: Trace, logStartMs: number, startMs: number, endMs: number): [from: number, to: number] {
	const n = trace.n;
	if (n === 0) return [0, 0];
	const t0 = (startMs - logStartMs) / 1000;
	const t1 = (endMs - logStartMs) / 1000;
	const time = trace.time;
	let from = 0;
	while (from < n && time[from] < t0) from++;
	let to = from;
	while (to < n && time[to] < t1) to++;
	if (t1 >= time[n - 1] && to === n - 1) to = n;
	return [from, Math.max(from, to)];
}

const isExtruding = (speed: number, torque: number): boolean => speed >= EXTRUDING_MIN_RPM && torque > EXTRUDING_MIN_TORQUE_PCT;

function mean(v: Float64Array | undefined, rows: number[]): number | null {
	if (!v) return null;
	let s = 0;
	let c = 0;
	for (const i of rows) if (Number.isFinite(v[i])) { s += v[i]; c++; }
	return c ? s / c : null;
}

function peak(v: Float64Array | undefined, from: number, to: number): number | null {
	if (!v) return null;
	let m = -Infinity;
	for (let i = from; i < to; i++) if (Number.isFinite(v[i]) && v[i] > m) m = v[i];
	return m === -Infinity ? null : m;
}

/** The most common finite value over `rows`; the smallest when several tie. */
function mode(v: Float64Array | undefined, rows: number[]): number | null {
	if (!v) return null;
	const counts = new Map<number, number>();
	for (const i of rows) if (Number.isFinite(v[i])) counts.set(v[i], (counts.get(v[i]) ?? 0) + 1);
	let best: number | null = null;
	let bestN = 0;
	for (const [value, count] of counts) {
		if (count > bestN || (count === bestN && best !== null && value < best)) { best = value; bestN = count; }
	}
	return best;
}

export function summariseWindow(trace: Trace, logStartMs: number, startMs: number, endMs: number): ConformSummary {
	const [from, to] = windowRows(trace, logStartMs, startMs, endMs);
	const speed = traceValues(trace, 'wheel_speed_rpm');
	const torque = traceValues(trace, 'motor_torque_pct');
	const extruding: number[] = [];
	if (speed && torque) for (let i = from; i < to; i++) if (isExtruding(speed[i], torque[i])) extruding.push(i);

	let gaps = 0;
	for (let i = from + 1; i < to; i++) if (trace.time[i] - trace.time[i - 1] > GAP_S) gaps++;

	const pw = powerChannels((k) => traceValues(trace, k), trace.n);
	const energy = energyKwh(pw, from, to);
	const rows = to - from;
	return {
		version: 1,
		duration_s: rows > 1 ? trace.time[to - 1] - trace.time[from] : 0,
		n_rows: rows,
		gaps,
		extruding_s: extruding.length,
		mean_wheel_speed_rpm: mean(speed, extruding),
		mean_torque_pct: mean(torque, extruding),
		mean_tooling1_c: mean(traceValues(trace, 'tooling1_c'), extruding),
		peak_torque_pct: peak(torque, from, to),
		peak_motor_current_a: peak(traceValues(trace, 'motor_current_a'), from, to),
		peak_tooling1_c: peak(traceValues(trace, 'tooling1_c'), from, to),
		peak_wheel_temp_c: peak(traceValues(trace, 'wheel_temp_c'), from, to),
		ips_setpoint_c: mode(traceValues(trace, 'ips_setpoint_c'), extruding),
		energy_kwh: energy,
		avg_demand_kw: rows ? (energy.total * 3600) / rows : 0,
		missing: pw.missing,
	};
}
