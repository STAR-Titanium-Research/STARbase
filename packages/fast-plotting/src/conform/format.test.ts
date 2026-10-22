import { describe, expect, it } from 'vitest';
import {
	DASH, candidateLabel, candidatesEmptyText, formatClockRange, formatDuration, formatKw, formatKwh, kwhNumber, wholeLogNote, windowLine,
} from './format';

describe('shared Conform formats', () => {
	it('writes energy in kWh and demand in kW to 2 decimals', () => {
		expect(formatKwh(7.523869)).toBe('7.52 kWh');
		expect(formatKwh(0)).toBe('0.00 kWh');
		expect(formatKwh(7.5)).toBe('7.50 kWh');
		expect(formatKw(30.7)).toBe('30.70 kW');
		expect(kwhNumber(1.776252)).toBe('1.78');
		expect(formatKwh(null)).toBe(DASH);
		expect(formatKw(undefined)).toBe(DASH);
		expect(formatKwh(NaN)).toBe(DASH);
	});

	it('writes a length of time as 12 min 05 s under an hour, 1 h 23 min from an hour', () => {
		expect(formatDuration(725)).toBe('12 min 05 s');
		expect(formatDuration(0)).toBe('0 min 00 s');
		expect(formatDuration(59.6)).toBe('1 min 00 s');
		expect(formatDuration(899)).toBe('14 min 59 s');
		expect(formatDuration(3599)).toBe('59 min 59 s');
		expect(formatDuration(3600)).toBe('1 h 00 min');
		expect(formatDuration(4980)).toBe('1 h 23 min');
		expect(formatDuration(3600 * 12 + 5 * 60 + 59)).toBe('12 h 05 min');
		expect(formatDuration(null)).toBe(DASH);
		expect(formatDuration(-1)).toBe(DASH);
	});

	it('writes clock times as HH:MM:SS in UK time', () => {
		expect(formatClockRange('2025-07-01T12:00:00Z', '2025-07-01T12:30:05Z')).toBe('13:00:00 – 13:30:05');
		expect(formatClockRange(null, 'x')).toBe('');
	});
});

describe('choosing a log already uploaded', () => {
	it('words the candidates and the empty list the same everywhere', () => {
		expect(candidateLabel({ source_filename: 'a.csv', log_start: '2025-07-01T12:00:00Z' })).toBe('a.csv · 2025-07-01 13:00:00');
		expect(candidatesEmptyText('2025-01-15T00:00:00Z')).toBe("No Conform log from this machine starts within a day of this run's date.");
		expect(candidatesEmptyText(null)).toMatch(/within a day of today/);
	});

	it('words a window with its owner', () => {
		expect(windowLine({ label: 'Ti swarf', start: '2025-01-15T10:00:00Z', end: '2025-01-15T10:05:00Z' })).toBe('Ti swarf: 10:00:00 – 10:05:00');
	});

	const LOG = { log_start: '2025-01-15T10:00:00.000Z', log_end: '2025-01-15T10:14:59.000Z' };
	it('says when one window is the whole log', () => {
		const whole = { label: 'Ti swarf', readable: true, start: '2025-01-15T10:00:00.000Z', end: '2025-01-15T10:14:59.000Z' };
		expect(wholeLogNote(LOG, [whole])).toBe("The whole log is Ti swarf's window: narrow that run's window first");
		expect(wholeLogNote(LOG, [{ ...whole, label: 'Other run', readable: false }])).toBe("The whole log is another run's window: narrow that run's window first");
		expect(wholeLogNote(LOG, [{ ...whole, end: '2025-01-15T10:10:00.000Z' }])).toBeNull();
		expect(wholeLogNote(LOG, [])).toBeNull();
	});
});
