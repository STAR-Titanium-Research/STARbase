// What the Operation page's "Conform run" section says, as rows of text: the summary, the energy, the steps table and the whole-log totals,
// formatted with units and UK clock times (the CONTEXT.md words: Conform run, Conform log, Run window, Step). Pure: the numbers come from
// @d1/fast-plotting's summary, steps and totals; no Vue, no I/O.

import {
	CONFORM_FIGURES, CONFORM_POWER_CONSTANTS, DASH, formatClockRange, formatFigure, formatUkDate, formatUkDateTimeDisplay, formatUkTime, niceNumber,
	type ConformRange, type ConformRunRow, type ConformStep, type ConformSummary, type ConformTotals, type EnergyKwh, type PowerPart,
} from '@d1/fast-plotting';

export interface TextRow {
	label: string;
	value: string;
}

const isNum = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n);
const row = (key: keyof typeof CONFORM_FIGURES, value: number | null | undefined): TextRow => ({ label: CONFORM_FIGURES[key].label, value: formatFigure(key, value) });

const MISSING_WORDS: Record<PowerPart, string> = { motor: 'motor current', ips: 'IPS coil', cooling: 'wheel cooling pump current' };

/** "No IPS coil channel in this log, so its energy is left out", or '' when nothing is missing. */
export function missingText(missing: readonly PowerPart[] | undefined): string {
	if (!missing?.length) return '';
	const names = missing.map((m) => MISSING_WORDS[m] ?? m);
	return `This log has no ${names.join(' or ')} channel, so ${missing.length === 1 ? 'that part' : 'those parts'} of the energy ${missing.length === 1 ? 'is' : 'are'} left out.`;
}

/** The energy of a window or a whole log: each component present, the total, and the average demand (labels and formats from `CONFORM_FIGURES`). */
export function energyRows(energy: EnergyKwh, avgDemandKw: number): TextRow[] {
	const rows: TextRow[] = [];
	if (isNum(energy.motor)) rows.push(row('energy_motor', energy.motor));
	if (isNum(energy.ips)) rows.push(row('energy_ips', energy.ips));
	if (isNum(energy.cooling)) rows.push(row('energy_cooling', energy.cooling));
	rows.push(row('energy_total', energy.total));
	rows.push(row('avg_demand_kw', avgDemandKw));
	return rows;
}

/** The run summary (window only): times, speed, torque and temperatures. Energy has its own rows. */
export function summaryRows(s: ConformSummary): TextRow[] {
	return [
		row('duration_s', s.duration_s),
		row('extruding_s', s.extruding_s),
		row('mean_wheel_speed_rpm', s.mean_wheel_speed_rpm),
		row('mean_torque_pct', s.mean_torque_pct),
		row('mean_tooling1_c', s.mean_tooling1_c),
		row('peak_torque_pct', s.peak_torque_pct),
		row('peak_motor_current_a', s.peak_motor_current_a),
		row('peak_tooling1_c', s.peak_tooling1_c),
		row('peak_wheel_temp_c', s.peak_wheel_temp_c),
		row('ips_setpoint_c', s.ips_setpoint_c),
	];
}

/** The whole-log totals, shown beside the run's own: length of the log and its energy. */
export function totalsRows(t: ConformTotals): TextRow[] {
	return [{ label: 'Log length', value: formatFigure('duration_s', t.duration_s) }, ...energyRows(t.energy_kwh, t.avg_demand_kw)];
}

/** `400–430 °C (30)`: the low and high, then the spread in brackets (the header says "range"); a dash for no reading. */
const range = (r: ConformRange | null, unit: string): string => {
	const lo = r ? niceNumber(r.min) : null;
	const hi = r ? niceNumber(r.max) : null;
	const spread = r ? niceNumber(r.range) : null;
	return lo === null || hi === null || spread === null ? DASH : `${lo}–${hi} ${unit} (${spread})`;
};

export const STEP_COLUMNS = ['Start', 'Length', 'IPS setpoint', 'Wheel speed', 'Wheel temp (range)', 'Tooling 1 (range)', 'Tooling 2 (range)', 'Mean torque', 'Energy'] as const;

/** One step as the cells of the steps table, in STEP_COLUMNS order. */
export function stepCells(s: ConformStep): string[] {
	return [
		formatUkTime(s.start),
		formatFigure('duration_s', s.duration_s),
		formatFigure('ips_setpoint_c', s.ips_setpoint_c),
		formatFigure('mean_wheel_speed_rpm', s.wheel_speed_rpm),
		range(s.wheel_temp_c, '°C'),
		range(s.tooling1_c, '°C'),
		range(s.tooling2_c, '°C'),
		formatFigure('mean_torque_pct', s.mean_torque_pct),
		formatFigure('energy_total', s.energy_kwh),
	];
}

/** The log's span in the display form: `17 Mar 2025, 13:38:20 – 14:50:01`, or both dates when it crosses midnight. */
export function logSpanText(start: string | null | undefined, end: string | null | undefined): string {
	if (!start || !end) return '';
	const first = formatUkDateTimeDisplay(start);
	return formatUkDate(start) === formatUkDate(end) ? `${first} – ${formatUkTime(end)}` : `${first} – ${formatUkDateTimeDisplay(end)}`;
}

/** The run window as UK clock times, `13:38:20 – 13:53:19`; empty when there is none. */
export function windowText(run: Pick<ConformRunRow, 'window_start' | 'window_end'> | null | undefined): string {
	return formatClockRange(run?.window_start, run?.window_end);
}

/**
 * The run's summary and steps were worked out by older code (no version on the summary) or with older power constants (its
 * `constants_version` is missing or lower than the code's): "Recompute" redoes them from the stored CSV, writing the run only.
 * Only a run with a window can. (The log row's own `constants` are not compared: members cannot update a log.)
 */
export function needsRecompute(run: ConformRunRow | null | undefined): boolean {
	if (!run || !run.window_start || !run.window_end) return false;
	const s = run.summary as { version?: number; constants_version?: number } | null;
	return !s?.version || (s.constants_version ?? 0) < CONFORM_POWER_CONSTANTS.version;
}

/** True when the run can take a log: none is linked yet. */
export const needsLog = (run: Pick<ConformRunRow, 'status' | 'log_id'> | null | undefined): boolean => !run || run.status === 'no_log' || !run.log_id;
