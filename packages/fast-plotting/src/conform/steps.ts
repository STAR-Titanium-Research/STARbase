// Steps of a Conform run: stretches at one (IPS setpoint, wheel speed demand) pair.
import type { Trace } from '../fastCache';
import { formatUkDateTime } from './clock';
import { energyKwh, powerChannels } from './power';
import { traceValues, windowRows } from './summary';

export interface ConformRange { min: number; max: number; range: number }
export interface ConformStep {
	start: string; end: string; duration_s: number; ips_setpoint_c: number; wheel_speed_rpm: number;
	wheel_temp_c: ConformRange | null;
	tooling1_c: ConformRange | null;
	tooling2_c: ConformRange | null;
	mean_torque_pct: number | null; energy_kwh: number;
}

/** A stretch shorter than this many rows is a transient, and belongs to no step. */
export const MIN_STEP_ROWS = 60;

function rangeOf(v: Float64Array | undefined, from: number, to: number): ConformRange | null {
	if (!v) return null;
	let min = Infinity;
	let max = -Infinity;
	for (let i = from; i < to; i++) {
		const x = v[i];
		if (!Number.isFinite(x)) continue;
		if (x < min) min = x;
		if (x > max) max = x;
	}
	return min === Infinity ? null : { min, max, range: max - min };
}

function meanOf(v: Float64Array | undefined, from: number, to: number): number | null {
	if (!v) return null;
	let s = 0;
	let c = 0;
	for (let i = from; i < to; i++) if (Number.isFinite(v[i])) { s += v[i]; c++; }
	return c ? s / c : null;
}

/**
 * Walk the window and start a new step whenever the key (IPS setpoint, wheel speed demand rounded to 0.5 rpm)
 * changes. Stretches under MIN_STEP_ROWS rows are dropped. Without a wheel speed demand channel there is
 * nothing to key on and no steps are returned; a log without an IPS setpoint channel is keyed on speed alone
 * (setpoint 0).
 */
export function detectSteps(trace: Trace, logStartMs: number, startMs: number, endMs: number): ConformStep[] {
	const [from, to] = windowRows(trace, logStartMs, startMs, endMs);
	const demand = traceValues(trace, 'wheel_speed_demand_rpm');
	if (!demand) return [];
	const setpoint = traceValues(trace, 'ips_setpoint_c');
	const pw = powerChannels((k) => traceValues(trace, k), trace.n);
	const wheelTemp = traceValues(trace, 'wheel_temp_c');
	const t1 = traceValues(trace, 'tooling1_c');
	const t2 = traceValues(trace, 'tooling2_c');
	const torque = traceValues(trace, 'motor_torque_pct');

	const keyAt = (i: number): string | null => {
		const sp = setpoint ? setpoint[i] : 0;
		const d = demand[i];
		return Number.isFinite(sp) && Number.isFinite(d) ? `${sp}|${Math.round(d * 2) / 2}` : null;
	};
	const iso = (i: number) => new Date(logStartMs + trace.time[i] * 1000).toISOString();

	const steps: ConformStep[] = [];
	const close = (a: number, b: number) => {   // rows [a, b)
		if (b - a < MIN_STEP_ROWS) return;
		steps.push({
			start: iso(a),
			end: iso(b - 1),
			duration_s: b - a,
			ips_setpoint_c: setpoint ? setpoint[a] : 0,
			wheel_speed_rpm: Math.round(demand[a] * 2) / 2,
			wheel_temp_c: rangeOf(wheelTemp, a, b),
			tooling1_c: rangeOf(t1, a, b),
			tooling2_c: rangeOf(t2, a, b),
			mean_torque_pct: meanOf(torque, a, b),
			energy_kwh: energyKwh(pw, a, b).total,
		});
	};

	let runStart = from;
	let runKey = from < to ? keyAt(from) : null;
	for (let i = from + 1; i <= to; i++) {
		const k = i < to ? keyAt(i) : null;
		if (i === to || k !== runKey) {
			if (runKey !== null) close(runStart, i);
			runStart = i;
			runKey = k;
		}
	}
	return steps;
}

const f = (x: number | null, digits: number): string => (x === null ? '' : x.toFixed(digits));
const rangeCells = (r: ConformRange | null): string[] => [f(r && r.min, 1), f(r && r.max, 1), f(r && r.range, 1)];

/** The steps as CSV for pasting into a spreadsheet: one header row, one row per step, UK local clock times. */
export function stepsToCsv(steps: ConformStep[]): string {
	const header = [
		'Start', 'End', 'Duration (s)', 'IPS setpoint (°C)', 'Wheel speed (rpm)',
		'Wheel temp min (°C)', 'Wheel temp max (°C)', 'Wheel temp range (°C)',
		'Tooling 1 min (°C)', 'Tooling 1 max (°C)', 'Tooling 1 range (°C)',
		'Tooling 2 min (°C)', 'Tooling 2 max (°C)', 'Tooling 2 range (°C)',
		'Mean torque (%)', 'Energy (kWh)',
	];
	const rows = steps.map((s) => [
		formatUkDateTime(s.start), formatUkDateTime(s.end), String(s.duration_s), String(s.ips_setpoint_c), String(s.wheel_speed_rpm),
		...rangeCells(s.wheel_temp_c), ...rangeCells(s.tooling1_c), ...rangeCells(s.tooling2_c),
		f(s.mean_torque_pct, 1), f(s.energy_kwh, 4),
	]);
	return [header, ...rows].map((r) => r.join(',')).join('\n') + '\n';
}
