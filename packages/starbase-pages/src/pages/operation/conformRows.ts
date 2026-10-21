// What the Operation page's "Conform run" section says, as rows of text: the summary, the energy, the steps table and the whole-log totals,
// formatted with units and UK clock times (the CONTEXT.md words: Conform run, Conform log, Run window, Step). Pure: the numbers come from
// @d1/fast-plotting's summary, steps and totals; no Vue, no I/O.

import {
	CONFORM_POWER_CONSTANTS, formatUkTime, type ConformLogRow, type ConformRange, type ConformRunRow, type ConformStep, type ConformSummary, type ConformTotals,
	type EnergyKwh, type PowerPart,
} from '@d1/fast-plotting';

export interface TextRow {
	label: string;
	value: string;
}

const DASH = '–';
const isNum = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n);

/** `7.67 kWh`: the number to `digits` places, then the unit; a dash for no reading. */
export function withUnit(n: number | null | undefined, digits: number, unit: string): string {
	return isNum(n) ? `${n.toFixed(digits)}${unit ? ` ${unit}` : ''}` : DASH;
}

/** Seconds as `H:MM:SS` (a length of time, not a clock time). */
export function formatDuration(seconds: number | null | undefined): string {
	if (!isNum(seconds) || seconds < 0) return DASH;
	const s = Math.round(seconds);
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	return `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

const MISSING_WORDS: Record<PowerPart, string> = { motor: 'motor current', ips: 'IPS coil', cooling: 'wheel cooling pump current' };

/** "No IPS coil channel in this log, so its energy is left out", or '' when nothing is missing. */
export function missingText(missing: readonly PowerPart[] | undefined): string {
	if (!missing?.length) return '';
	const names = missing.map((m) => MISSING_WORDS[m] ?? m);
	return `This log has no ${names.join(' or ')} channel, so ${missing.length === 1 ? 'that part' : 'those parts'} of the energy ${missing.length === 1 ? 'is' : 'are'} left out.`;
}

/** The energy of a window or a whole log: each component present, the total, and the average demand. */
export function energyRows(energy: EnergyKwh, avgDemandKw: number): TextRow[] {
	const rows: TextRow[] = [];
	if (isNum(energy.motor)) rows.push({ label: 'Motor', value: withUnit(energy.motor, 2, 'kWh') });
	if (isNum(energy.ips)) rows.push({ label: 'IPS', value: withUnit(energy.ips, 2, 'kWh') });
	if (isNum(energy.cooling)) rows.push({ label: 'Cooling', value: withUnit(energy.cooling, 2, 'kWh') });
	rows.push({ label: 'Total', value: withUnit(energy.total, 2, 'kWh') });
	rows.push({ label: 'Average demand', value: withUnit(avgDemandKw, 2, 'kW') });
	return rows;
}

/** The run summary (window only): times, speed, torque and temperatures. Energy has its own rows. */
export function summaryRows(s: ConformSummary): TextRow[] {
	return [
		{ label: 'Window length', value: formatDuration(s.duration_s) },
		{ label: 'Extruding time', value: formatDuration(s.extruding_s) },
		{ label: 'Mean wheel speed', value: withUnit(s.mean_wheel_speed_rpm, 1, 'rpm') },
		{ label: 'Mean torque', value: withUnit(s.mean_torque_pct, 1, '%') },
		{ label: 'Mean Tooling 1', value: withUnit(s.mean_tooling1_c, 1, '°C') },
		{ label: 'Peak torque', value: withUnit(s.peak_torque_pct, 1, '%') },
		{ label: 'Peak motor current', value: withUnit(s.peak_motor_current_a, 1, 'A') },
		{ label: 'Peak Tooling 1', value: withUnit(s.peak_tooling1_c, 1, '°C') },
		{ label: 'Peak wheel temperature', value: withUnit(s.peak_wheel_temp_c, 1, '°C') },
		{ label: 'IPS setpoint', value: withUnit(s.ips_setpoint_c, 0, '°C') },
	];
}

/** The whole-log totals, shown beside the run's own: length of the log and its energy. */
export function totalsRows(t: ConformTotals): TextRow[] {
	return [{ label: 'Log length', value: formatDuration(t.duration_s) }, ...energyRows(t.energy_kwh, t.avg_demand_kw)];
}

const range = (r: ConformRange | null): string => (r ? `${r.min.toFixed(1)}–${r.max.toFixed(1)} (${r.range.toFixed(1)})` : DASH);
const trimmed = (n: number): string => String(Math.round(n * 10) / 10);

export const STEP_COLUMNS = ['Start', 'Length', 'IPS setpoint', 'Wheel speed', 'Wheel temp (range)', 'Tooling 1 (range)', 'Tooling 2 (range)', 'Mean torque', 'Energy'] as const;

/** One step as the cells of the steps table, in STEP_COLUMNS order. */
export function stepCells(s: ConformStep): string[] {
	return [
		formatUkTime(s.start),
		formatDuration(s.duration_s),
		withUnit(s.ips_setpoint_c, 0, '°C'),
		`${trimmed(s.wheel_speed_rpm)} rpm`,
		range(s.wheel_temp_c),
		range(s.tooling1_c),
		range(s.tooling2_c),
		withUnit(s.mean_torque_pct, 1, '%'),
		withUnit(s.energy_kwh, 3, 'kWh'),
	];
}

/** The run window as UK clock times, `13:38:20 – 13:53:19`; empty when there is none. */
export function windowText(run: Pick<ConformRunRow, 'window_start' | 'window_end'> | null | undefined): string {
	return run?.window_start && run.window_end ? `${formatUkTime(run.window_start)} – ${formatUkTime(run.window_end)}` : '';
}

/**
 * The run's summary and steps were worked out by older code (no version on the summary) or from older power constants (the log was
 * processed with a lower constants version): "Recompute" redoes them from the stored CSV. Only a run with a window and a readable log can.
 */
export function needsRecompute(run: ConformRunRow | null | undefined, log: Pick<ConformLogRow, 'constants'> | null | undefined): boolean {
	if (!run || !log || !run.window_start || !run.window_end) return false;
	const summaryVersion = (run.summary as { version?: number } | null)?.version;
	return !summaryVersion || (log.constants?.version ?? 0) < CONFORM_POWER_CONSTANTS.version;
}

/** True when the run can take a log: none is linked yet. */
export const needsLog = (run: Pick<ConformRunRow, 'status' | 'log_id'> | null | undefined): boolean => !run || run.status === 'no_log' || !run.log_id;

/** The one line under the section's heading. */
export function statusText(run: Pick<ConformRunRow, 'status'> | null | undefined): string {
	switch (run?.status) {
		case 'done': return 'Done';
		case 'no_window': return 'Run window not set';
		case 'error': return 'Could not be processed';
		default: return 'No Conform log yet';
	}
}
