import { describe, expect, it } from 'vitest';
import { answerOf, initialAnswer, isIsoDay, leadText } from './markDone';

describe('isIsoDay', () => {
	it('accepts real days only', () => {
		expect(isIsoDay('2026-10-15')).toBe(true);
		expect(isIsoDay('2028-02-29')).toBe(true);
		expect(isIsoDay('2026-02-29')).toBe(false);
		expect(isIsoDay('2026-13-01')).toBe(false);
		expect(isIsoDay('15/10/2026')).toBe(false);
		expect(isIsoDay('')).toBe(false);
		expect(isIsoDay(null)).toBe(false);
	});
});

describe('initialAnswer', () => {
	it('is today, and the person when known', () => {
		expect(initialAnswer('p1', new Date(2026, 9, 5))).toEqual({ done_date: '2026-10-05', done_by: 'p1' });
		expect(initialAnswer(null, new Date(2026, 9, 5))).toEqual({ done_date: '2026-10-05' });
		expect(initialAnswer(undefined, new Date(2026, 0, 31))).toEqual({ done_date: '2026-01-31' });
	});
});

describe('answerOf', () => {
	it('is the date and the person', () => {
		expect(answerOf({ done_date: '2026-10-05', done_by: 'p1' })).toEqual({ date: '2026-10-05', personId: 'p1' });
	});
	it('no person is null, so the server takes the caller\'s own', () => {
		expect(answerOf({ done_date: '2026-10-05' })).toEqual({ date: '2026-10-05', personId: null });
	});
	it('keeps the day of a date-time', () => {
		expect(answerOf({ done_date: '2026-10-05T09:30:00' })?.date).toBe('2026-10-05');
	});
	it('is null while the date is missing or not a day', () => {
		expect(answerOf({})).toBeNull();
		expect(answerOf({ done_date: '2026-02-30' })).toBeNull();
	});
});

describe('leadText', () => {
	it('names how many go together', () => {
		expect(leadText(1, 'test_sessions')).toBe('Say when it was done and who did it.');
		expect(leadText(3, 'manufacturing_operations')).toContain('All 3 operations');
		expect(leadText(2, 'test_sessions')).toContain('All 2 tests');
	});
});
