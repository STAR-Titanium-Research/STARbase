import { describe, expect, it } from 'vitest';
import { CONFORM_STATUS, DASH, formatFigure, niceNumber } from './format';
import { formatUkDate, formatUkDateTimeDisplay } from './clock';

describe('Conform figures', () => {
	it('follow DESIGN.md 5b: integers from 100, one decimal from 10, up to two below, no trailing zeros', () => {
		expect(niceNumber(344.94)).toBe('345');
		expect(niceNumber(48.04)).toBe('48');
		expect(niceNumber(17.904)).toBe('17.9');
		expect(niceNumber(4.6289)).toBe('4.63');
		expect(niceNumber(5)).toBe('5');
		expect(niceNumber(null)).toBeNull();
	});
	it('print energy and demand to 2 decimals, times as durations, and an em dash with no unit for no reading', () => {
		expect(formatFigure('energy_total', 7.523869)).toBe('7.52 kWh');
		expect(formatFigure('avg_demand_kw', 30.7)).toBe('30.70 kW');
		expect(formatFigure('extruding_s', 870)).toBe('14 min 30 s');
		expect(formatFigure('peak_tooling1_c', 430.355)).toBe('430 °C');
		expect(formatFigure('mean_tooling1_c', undefined)).toBe(DASH);
		expect(DASH).toBe('—');
	});
	it('word the run status the same everywhere', () => {
		expect(CONFORM_STATUS.no_window).toMatchObject({ label: 'No run window', tone: 'warning' });
	});
	it('show dates as "17 Mar 2025" in UK time', () => {
		expect(formatUkDate('2025-03-17T13:38:20Z')).toBe('17 Mar 2025');
		expect(formatUkDateTimeDisplay('2025-07-01T12:00:00Z')).toBe('1 Jul 2025, 13:00:00');
	});
});
