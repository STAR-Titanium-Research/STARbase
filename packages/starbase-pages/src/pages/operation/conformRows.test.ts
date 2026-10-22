import { describe, expect, it } from 'vitest';
import { CONFORM_FIGURES, CONFORM_POWER_CONSTANTS, CONFORM_STATUS, type ConformRunRow, type ConformStep, type ConformSummary } from '@d1/fast-plotting';
import { statusStyle } from '@d1/ui';
import { STEP_COLUMNS, energyRows, logSpanText, missingText, needsLog, needsRecompute, stepCells, summaryRows, totalsRows, windowText } from './conformRows';

describe('summary rows', () => {
	const summary = {
		duration_s: 899, extruding_s: 880, mean_wheel_speed_rpm: 7.5, mean_torque_pct: 22.456, mean_tooling1_c: 401.7, peak_torque_pct: 38,
		peak_motor_current_a: 120.4, peak_tooling1_c: 432.19, peak_wheel_temp_c: 99.96, ips_setpoint_c: 250,
	} as unknown as ConformSummary;

	it('uses the shared labels, and the number rule: integers from 100, one decimal from 10, up to two below', () => {
		const rows = summaryRows(summary);
		expect(rows.map((r) => r.label)).toEqual(['Duration', 'Extruding time', 'Mean wheel speed', 'Mean motor torque', 'Mean tooling 1', 'Peak motor torque', 'Peak motor current', 'Peak tooling 1', 'Peak wheel temperature', 'IPS setpoint']);
		expect(rows.map((r) => r.value)).toEqual(['14 min 59 s', '14 min 40 s', '7.5 rpm', '22.5 %', '402 °C', '38 %', '120 A', '432 °C', '100 °C', '250 °C']);
	});

	it('a missing reading is an em dash with no unit', () => {
		const rows = summaryRows({ ...summary, mean_torque_pct: null, peak_tooling1_c: NaN } as unknown as ConformSummary);
		expect(rows.find((r) => r.label === 'Mean motor torque')?.value).toBe('—');
		expect(rows.find((r) => r.label === 'Peak tooling 1')?.value).toBe('—');
	});

	it('every label is the one in the figure table', () => {
		expect(summaryRows(summary).every((r) => Object.values(CONFORM_FIGURES).some((f) => f.label === r.label))).toBe(true);
	});
});

describe('lengths of time use the shared format', () => {
	it('writes the window length and the extruding time as 12 min 05 s, or 1 h 23 min from an hour', () => {
		const rows = summaryRows({ duration_s: 899, extruding_s: 4980 } as never);
		expect(rows[0]).toEqual({ label: 'Duration', value: '14 min 59 s' });
		expect(rows[1]).toEqual({ label: 'Extruding time', value: '1 h 23 min' });
	});
});

describe('energy and totals', () => {
	it('lists the parts the log has, then the total and the average demand', () => {
		expect(energyRows({ motor: 44.57, ips: 0.78, cooling: 0.17, total: 45.52 }, 22.8)).toEqual([
			{ label: 'Motor energy', value: '44.57 kWh' },
			{ label: 'IPS energy', value: '0.78 kWh' },
			{ label: 'Cooling energy', value: '0.17 kWh' },
			{ label: 'Total energy', value: '45.52 kWh' },
			{ label: 'Average demand', value: '22.80 kW' },
		]);
	});

	it('leaves out a part with no channel (an older export)', () => {
		const labels = energyRows({ motor: 7, ips: null, cooling: null, total: 7 }, 1).map((r) => r.label);
		expect(labels).toEqual(['Motor energy', 'Total energy', 'Average demand']);
	});

	it('the whole-log block starts with the log length', () => {
		const rows = totalsRows({ duration_s: 7199, energy_kwh: { motor: 1, ips: 1, cooling: 1, total: 3 }, avg_demand_kw: 2, missing: [] });
		expect(rows[0]).toEqual({ label: 'Log length', value: '1 h 59 min' });
		expect(rows.at(-1)).toEqual({ label: 'Average demand', value: '2.00 kW' });
	});

	it('says what is missing, in the lab\'s words', () => {
		expect(missingText([])).toBe('');
		expect(missingText(undefined)).toBe('');
		expect(missingText(['ips'])).toBe('This log has no IPS coil channel, so that part of the energy is left out.');
		expect(missingText(['ips', 'cooling'])).toContain('IPS coil or wheel cooling pump current channel, so those parts of the energy are left out');
	});
});

describe('steps', () => {
	const step: ConformStep = {
		start: '2025-07-01T12:38:20Z', end: '2025-07-01T12:45:00Z', duration_s: 400, ips_setpoint_c: 250, wheel_speed_rpm: 7.5,
		wheel_temp_c: { min: 100, max: 120, range: 20 }, tooling1_c: { min: 400.04, max: 430, range: 29.96 }, tooling2_c: null, mean_torque_pct: 22.46, energy_kwh: 3.5,
	};

	it('one cell per column, in UK clock time', () => {
		const cells = stepCells(step);
		expect(cells).toHaveLength(STEP_COLUMNS.length);
		expect(cells).toEqual(['13:38:20', '6 min 40 s', '250 °C', '7.5 rpm', '100–120 °C (20)', '400–430 °C (30)', '—', '22.5 %', '3.50 kWh']);
	});

	it('writes a whole wheel speed without a decimal, and a missing one as a dash with no unit', () => {
		expect(stepCells({ ...step, wheel_speed_rpm: 8 })[3]).toBe('8 rpm');
		expect(stepCells({ ...step, wheel_speed_rpm: NaN, mean_torque_pct: null as never })).toEqual(expect.arrayContaining(['—']));
		expect(stepCells({ ...step, wheel_speed_rpm: NaN })[3]).toBe('—');
	});
});

describe('the run window and status', () => {
	it('writes the window as UK clock times, or nothing', () => {
		expect(windowText({ window_start: '2025-03-17T13:38:20Z', window_end: '2025-03-17T13:53:19Z' })).toBe('13:38:20 – 13:53:19');
		expect(windowText({ window_start: '2025-07-01T12:38:20Z', window_end: '2025-07-01T12:53:19Z' })).toBe('13:38:20 – 13:53:19');
		expect(windowText({ window_start: null, window_end: null })).toBe('');
		expect(windowText(null)).toBe('');
	});

	it('the kit\'s conform status words and tones are the plotting package\'s', () => {
		for (const [key, v] of Object.entries(CONFORM_STATUS)) expect(statusStyle('conform', key)).toEqual({ label: v.label, tone: v.tone });
	});

	it('writes the log\'s span in the display form, with the second date only across midnight', () => {
		expect(logSpanText('2025-03-17T13:38:20Z', '2025-03-17T14:50:01Z')).toBe('17 Mar 2025, 13:38:20 – 14:50:01');
		expect(logSpanText('2025-03-17T23:30:00Z', '2025-03-18T01:10:00Z')).toBe('17 Mar 2025, 23:30:00 – 18 Mar 2025, 01:10:00');
		expect(logSpanText(null, '2025-03-17T14:50:01Z')).toBe('');
	});

	it('a run needs a log when none is linked', () => {
		expect(needsLog(null)).toBe(true);
		expect(needsLog({ status: 'no_log', log_id: null })).toBe(true);
		expect(needsLog({ status: 'no_window', log_id: 'l1' })).toBe(false);
		expect(needsLog({ status: 'done', log_id: null })).toBe(true);
	});
});

describe('needsRecompute', () => {
	const run = (over: Partial<ConformRunRow> = {}) =>
		({ status: 'done', log_id: 'l1', window_start: '2025-03-17T13:00:00Z', window_end: '2025-03-17T14:00:00Z', summary: { version: 1 }, ...over }) as ConformRunRow;
	const current = { version: 1, constants_version: CONFORM_POWER_CONSTANTS.version } as never;

	it('is true for a summary with no version, or whose constants_version is missing or lower', () => {
		expect(needsRecompute(run({ summary: {} as never }))).toBe(true);
		expect(needsRecompute(run({ summary: null }))).toBe(true);
		expect(needsRecompute(run({ summary: { version: 1 } as never }))).toBe(true);
		expect(needsRecompute(run({ summary: { version: 1, constants_version: CONFORM_POWER_CONSTANTS.version - 1 } as never }))).toBe(true);
	});

	it('is false for a current summary, or a run with no window', () => {
		expect(needsRecompute(run({ summary: current }))).toBe(false);
		expect(needsRecompute(run({ summary: { version: 1, constants_version: CONFORM_POWER_CONSTANTS.version + 1 } as never }))).toBe(false);
		expect(needsRecompute(run({ window_start: null }))).toBe(false);
		expect(needsRecompute(null)).toBe(false);
	});
});
