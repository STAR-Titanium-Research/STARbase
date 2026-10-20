import { describe, expect, it } from 'vitest';
import { dateRangeText } from './projectFacts';

describe('dateRangeText', () => {
	it('words a range, an open start, an open end and no dates', () => {
		expect(dateRangeText('2024-01-05', '2025-03-09')).toBe('5 Jan 2024 to 9 Mar 2025');
		expect(dateRangeText('2024-01-05', null)).toBe('From 5 Jan 2024');
		expect(dateRangeText(null, '2025-03-09')).toBe('Until 9 Mar 2025');
		expect(dateRangeText(null, undefined)).toBe('');
	});
});
