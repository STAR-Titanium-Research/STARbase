import { describe, expect, it } from 'vitest';
import { CONFORM_POWER_CONSTANTS, type ConformRunRow, type ConformStep } from '@d1/fast-plotting';
import { STEP_COLUMNS, energyRows, formatDuration, missingText, needsLog, needsRecompute, statusText, stepCells, totalsRows, windowText, withUnit } from './conformRows';

describe('withUnit and formatDuration', () => {
	it('writes a number to its places with the unit, and a dash for no reading', () => {
		expect(withUnit(7.666, 2, 'kWh')).toBe('7.67 kWh');
		expect(withUnit(300, 0, '°C')).toBe('300 °C');
		expect(withUnit(0, 1, '%')).toBe('0.0 %');
		expect(withUnit(null, 1, 'kW')).toBe('–');
		expect(withUnit(NaN, 1, 'kW')).toBe('–');
		expect(withUnit(3, 0, '')).toBe('3');
	});

	it('writes a length of time as H:MM:SS', () => {
		expect(formatDuration(0)).toBe('0:00:00');
		expect(formatDuration(899)).toBe('0:14:59');
		expect(formatDuration(7199)).toBe('1:59:59');
		expect(formatDuration(36000)).toBe('10:00:00');
		expect(formatDuration(null)).toBe('–');
		expect(formatDuration(-1)).toBe('–');
	});
});

describe('energy and totals', () => {
	it('lists the parts the log has, then the total and the average demand', () => {
		expect(energyRows({ motor: 44.57, ips: 0.78, cooling: 0.17, total: 45.52 }, 22.8)).toEqual([
			{ label: 'Motor', value: '44.57 kWh' },
			{ label: 'IPS', value: '0.78 kWh' },
			{ label: 'Cooling', value: '0.17 kWh' },
			{ label: 'Total', value: '45.52 kWh' },
			{ label: 'Average demand', value: '22.80 kW' },
		]);
	});

	it('leaves out a part with no channel (an older export)', () => {
		const labels = energyRows({ motor: 7, ips: null, cooling: null, total: 7 }, 1).map((r) => r.label);
		expect(labels).toEqual(['Motor', 'Total', 'Average demand']);
	});

	it('the whole-log block starts with the log length', () => {
		const rows = totalsRows({ duration_s: 7199, energy_kwh: { motor: 1, ips: 1, cooling: 1, total: 3 }, avg_demand_kw: 2, missing: [] });
		expect(rows[0]).toEqual({ label: 'Log length', value: '1:59:59' });
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
		expect(cells).toEqual(['13:38:20', '0:06:40', '250 °C', '7.5 rpm', '100.0–120.0 (20.0)', '400.0–430.0 (30.0)', '–', '22.5 %', '3.500 kWh']);
	});

	it('writes a whole wheel speed without a decimal', () => {
		expect(stepCells({ ...step, wheel_speed_rpm: 8 })[3]).toBe('8 rpm');
	});
});

describe('the run window and status', () => {
	it('writes the window as UK clock times, or nothing', () => {
		expect(windowText({ window_start: '2025-03-17T13:38:20Z', window_end: '2025-03-17T13:53:19Z' })).toBe('13:38:20 – 13:53:19');
		expect(windowText({ window_start: '2025-07-01T12:38:20Z', window_end: '2025-07-01T12:53:19Z' })).toBe('13:38:20 – 13:53:19');
		expect(windowText({ window_start: null, window_end: null })).toBe('');
		expect(windowText(null)).toBe('');
	});

	it('names each status', () => {
		expect(statusText(null)).toBe('No Conform log yet');
		expect(statusText({ status: 'no_log' })).toBe('No Conform log yet');
		expect(statusText({ status: 'no_window' })).toBe('Run window not set');
		expect(statusText({ status: 'done' })).toBe('Done');
		expect(statusText({ status: 'error' })).toBe('Could not be processed');
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
	const log = (version: number) => ({ constants: { ...CONFORM_POWER_CONSTANTS, version } });

	it('is true for a summary without a version, or a log processed with older constants', () => {
		expect(needsRecompute(run({ summary: {} as never }), log(CONFORM_POWER_CONSTANTS.version))).toBe(true);
		expect(needsRecompute(run({ summary: null }), log(CONFORM_POWER_CONSTANTS.version))).toBe(true);
		expect(needsRecompute(run(), log(CONFORM_POWER_CONSTANTS.version - 1))).toBe(true);
		expect(needsRecompute(run(), { constants: {} as never })).toBe(true);
	});

	it('is false when both are current, or there is no window or no readable log', () => {
		expect(needsRecompute(run(), log(CONFORM_POWER_CONSTANTS.version))).toBe(false);
		expect(needsRecompute(run({ window_start: null }), log(0))).toBe(false);
		expect(needsRecompute(run(), null)).toBe(false);
		expect(needsRecompute(null, log(0))).toBe(false);
	});
});
