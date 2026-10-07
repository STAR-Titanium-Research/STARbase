import { describe, expect, it } from 'vitest';
import { binWeekly, datesByKey, isoWeek, lastWeeks, weekStart, weeklyActivity, windowStart } from './activity';

// Local-time constructors at noon, so the tests do not depend on the machine's time zone.
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h);

describe('isoWeek', () => {
	it('numbers ordinary weeks', () => {
		expect(isoWeek(at(2026, 10, 7))).toEqual({ isoYear: 2026, isoWeek: 41 });
	});
	it('puts the first days of January into the previous ISO year when they precede the first Thursday', () => {
		// 2027-01-01 is a Friday; its Thursday is 2026-12-31, so it is week 53 of 2026.
		expect(isoWeek(at(2027, 1, 1))).toEqual({ isoYear: 2026, isoWeek: 53 });
		expect(isoWeek(at(2026, 12, 31))).toEqual({ isoYear: 2026, isoWeek: 53 });
		expect(isoWeek(at(2027, 1, 4))).toEqual({ isoYear: 2027, isoWeek: 1 });
	});
	it('puts late December into week 1 of the next year when its Thursday is in January', () => {
		// 2024-12-30 is a Monday; its Thursday is 2025-01-02.
		expect(isoWeek(at(2024, 12, 30))).toEqual({ isoYear: 2025, isoWeek: 1 });
	});
});

describe('weekStart', () => {
	it('is the Monday, also for a Sunday', () => {
		expect(weekStart(at(2026, 10, 11)).getDate()).toBe(5); // Sunday 11 Oct -> Monday 5 Oct
		expect(weekStart(at(2026, 10, 5)).getDate()).toBe(5);
	});
});

describe('lastWeeks', () => {
	it('lists N Mondays, oldest first, ending with the current week', () => {
		const weeks = lastWeeks(3, at(2026, 10, 7));
		expect(weeks.map((w) => w.start)).toEqual(['2026-09-21', '2026-09-28', '2026-10-05']);
	});
	it('spans a year boundary without a gap or a duplicate', () => {
		const weeks = lastWeeks(4, at(2027, 1, 6));
		expect(weeks.map((w) => w.start)).toEqual(['2026-12-14', '2026-12-21', '2026-12-28', '2027-01-04']);
		expect(weeks.map((w) => `${w.isoYear}-W${w.isoWeek}`)).toEqual(['2026-W51', '2026-W52', '2026-W53', '2027-W1']);
	});
	it('keeps Mondays across a daylight-saving change', () => {
		const weeks = lastWeeks(12, at(2026, 4, 15));
		for (const w of weeks) expect(new Date(`${w.start}T12:00:00`).getDay()).toBe(1);
	});
	it('returns nothing for zero weeks', () => {
		expect(lastWeeks(0)).toEqual([]);
	});
});

describe('binWeekly', () => {
	const now = at(2026, 10, 7);
	it('counts per week with empty weeks as 0', () => {
		const counts = binWeekly([at(2026, 10, 5), at(2026, 10, 7), at(2026, 9, 22)], 4, now);
		expect(counts).toEqual([0, 1, 0, 2]);
	});
	it('counts the two sides of a year boundary in the same ISO week', () => {
		const counts = binWeekly([at(2026, 12, 31), at(2027, 1, 1), at(2027, 1, 4)], 3, at(2027, 1, 6));
		expect(counts).toEqual([0, 2, 1]);
	});
	it('ignores dates outside the window, in the future, empty or invalid', () => {
		const counts = binWeekly([at(2025, 1, 1), at(2026, 10, 20), '', null, undefined, 'not a date'], 4, now);
		expect(counts).toEqual([0, 0, 0, 0]);
	});
	it('accepts ISO strings', () => {
		expect(binWeekly([at(2026, 10, 6).toISOString()], 2, now)).toEqual([0, 1]);
	});
});

describe('weeklyActivity', () => {
	it('returns ops and tests as two aligned series with totals', () => {
		const a = weeklyActivity([at(2026, 10, 6), at(2026, 10, 1)], [at(2026, 10, 7)], 3, at(2026, 10, 7));
		expect(a.weeks).toHaveLength(3);
		expect(a.ops).toEqual([0, 1, 1]);
		expect(a.tests).toEqual([0, 0, 1]);
		expect([a.totalOps, a.totalTests]).toEqual([2, 1]);
	});
	it('is all zeros for no data', () => {
		const a = weeklyActivity([], [], 5, at(2026, 10, 7));
		expect(a.ops).toEqual([0, 0, 0, 0, 0]);
		expect(a.totalOps + a.totalTests).toBe(0);
	});
});

describe('windowStart', () => {
	it('is local midnight of the oldest Monday', () => {
		const d = new Date(windowStart(3, at(2026, 10, 7)));
		expect([d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours()]).toEqual([2026, 9, 21, 0]);
	});
});

describe('datesByKey', () => {
	it('groups dates by key and skips rows without a key or date', () => {
		const rows = [
			{ p: 'a', d: '2026-10-01' },
			{ p: 'a', d: '2026-10-02' },
			{ p: 'b', d: '2026-10-03' },
			{ p: null, d: '2026-10-04' },
			{ p: 'c', d: null },
		];
		const m = datesByKey(rows, (r) => r.p, (r) => r.d);
		expect([...m.keys()]).toEqual(['a', 'b']);
		expect(m.get('a')).toEqual(['2026-10-01', '2026-10-02']);
	});
});
