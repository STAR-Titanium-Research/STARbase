import { describe, expect, it } from 'vitest';
import { formatUkDateTime, formatUkTime, ukDate, ukInputValue, ukLocalToMs } from './clock';

const iso = (ms: number) => new Date(ms).toISOString();

describe('ukLocalToMs', () => {
	it('reads a winter clock time as UTC (GMT)', () => {
		expect(iso(ukLocalToMs('2025-03-17 13:38:20'))).toBe('2025-03-17T13:38:20.000Z');
		expect(iso(ukLocalToMs('2025-03-17T13:38:20'))).toBe('2025-03-17T13:38:20.000Z');
	});

	it('reads a summer clock time as an hour before UTC (BST)', () => {
		expect(iso(ukLocalToMs('2025-07-01 13:38:20'))).toBe('2025-07-01T12:38:20.000Z');
	});

	it('takes seconds as optional', () => {
		expect(iso(ukLocalToMs('2025-03-17 13:38'))).toBe('2025-03-17T13:38:00.000Z');
	});

	it('handles the clock changes: the repeated autumn hour is read as its first pass, the skipped spring hour as the hour after', () => {
		// 2025-10-26: BST ends at 02:00 BST (01:00 UTC); 01:30 happens twice.
		expect(iso(ukLocalToMs('2025-10-26 01:30:00'))).toBe('2025-10-26T00:30:00.000Z');
		expect(iso(ukLocalToMs('2025-10-26 02:30:00'))).toBe('2025-10-26T02:30:00.000Z');
		// 2025-03-30: the clock jumps from 01:00 GMT to 02:00 BST; 01:30 does not exist.
		expect(iso(ukLocalToMs('2025-03-30 00:30:00'))).toBe('2025-03-30T00:30:00.000Z');
		expect(iso(ukLocalToMs('2025-03-30 02:30:00'))).toBe('2025-03-30T01:30:00.000Z');
		expect(Number.isFinite(ukLocalToMs('2025-03-30 01:30:00'))).toBe(true);
	});

	it('is NaN for what is not a clock time or a day', () => {
		for (const bad of ['', 'x', '2025-03-17', '17/03/2025 13:38', '2025-02-30 10:00', '2025-03-17 24:00', '2025-03-17 10:60']) expect(ukLocalToMs(bad), bad).toBeNaN();
	});
});

describe('ukInputValue', () => {
	it('writes an instant as UK time for a datetime-local input', () => {
		expect(ukInputValue('2025-03-17T13:38:20Z')).toBe('2025-03-17T13:38:20');
		expect(ukInputValue('2025-07-01T12:38:20Z')).toBe('2025-07-01T13:38:20');
		expect(ukInputValue(Date.parse('2025-07-01T23:30:00Z'))).toBe('2025-07-02T00:30:00');
	});

	it('is empty for nothing or an invalid instant', () => {
		expect(ukInputValue(null)).toBe('');
		expect(ukInputValue(undefined)).toBe('');
		expect(ukInputValue('')).toBe('');
		expect(ukInputValue('not a date')).toBe('');
	});

	it('round-trips with ukLocalToMs', () => {
		for (const t of ['2025-03-17T13:38:20Z', '2025-07-01T12:38:20Z', '2025-12-31T23:59:59Z', '2025-06-15T23:30:00Z']) {
			expect(iso(ukLocalToMs(ukInputValue(t)))).toBe(iso(Date.parse(t)));
		}
	});
});

describe('showing a clock time', () => {
	it('formats in Europe/London, including summer time', () => {
		expect(formatUkTime('2025-03-17T13:38:20.000Z')).toBe('13:38:20');
		expect(formatUkTime('2025-07-01T12:00:00Z')).toBe('13:00:00');
		expect(formatUkDateTime('2025-07-01T23:30:00Z')).toBe('2025-07-02 00:30:00');
		expect(ukDate('2025-07-01T23:30:00Z')).toBe('2025-07-02');
		expect(formatUkTime('nonsense')).toBe('');
	});
});
