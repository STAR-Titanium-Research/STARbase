import { describe, expect, it } from 'vitest';
import { dayLabel, dayOf, emptyText, plannedDayOf, niceStep, projectTimeline, timelineData, timelineXTicks, weekLabel, yAxis, type TimelineInput } from './projectTimeline';

const DAY = 86_400_000;
const TODAY = new Date(2026, 9, 16); // Friday 16 Oct 2026
const d = (s: string) => dayOf(s)!;

const base = (over: Partial<TimelineInput> = {}): TimelineInput => ({
	project: { start: '2024-06-01', end: '2027-01-31' },
	campaigns: [],
	ops: [],
	tests: [],
	plannedOps: [],
	plannedTests: [],
	today: TODAY,
	range: 'all',
	...over,
});

describe('dayOf', () => {
	it('reads a date-only string as that local day', () => {
		const ms = dayOf('2026-10-09')!;
		expect(new Date(ms).getDate()).toBe(9);
		expect(new Date(ms).getHours()).toBe(0);
	});
	it('takes the local day of a timestamp and ignores blanks', () => {
		expect(dayOf(new Date(2026, 9, 9, 15, 30))).toBe(new Date(2026, 9, 9).getTime());
		expect(dayOf(null)).toBeNull();
		expect(dayOf('')).toBeNull();
		expect(dayOf('not a date')).toBeNull();
	});
	it('words a day', () => {
		expect(dayLabel(d('2026-10-09'))).toBe('9 Oct 2026');
	});
});

describe('range 30d', () => {
	const m = projectTimeline(base({ range: '30d', ops: ['2026-10-12', '2026-09-01'], tests: ['2026-10-13'] }));
	it('runs from the Monday on or before today minus 30 days to today plus a quarter of it', () => {
		expect(m.domain[0]).toBe(d('2026-09-14')); // 16 Sep is a Wednesday
		expect(m.domain[1]).toBe(TODAY.getTime() + 7.5 * DAY);
	});
	it('keeps only the weeks in range, with operations and tests apart', () => {
		expect(m.weeks).toEqual([{ ms: d('2026-10-12'), ops: 1, tests: 1 }]);
	});
	it('ticks weekly', () => {
		expect(m.xTicks.map((t) => t.label)).toEqual(['21 Sep', '28 Sep', '5 Oct', '12 Oct', '19 Oct']);
	});
	it('names the week for screen readers', () => {
		expect(weekLabel(m.weeks[0])).toBe('2026-W42');
	});
});

describe('range 6mo', () => {
	const m = projectTimeline(base({ range: '6mo', ops: ['2026-03-01', '2026-10-01'] }));
	it('is 182 days back, so a record from March is out and one from October is in', () => {
		expect(m.domain[0]).toBe(d('2026-04-13'));
		expect(m.weeks.map((w) => w.ms)).toEqual([d('2026-09-28')]);
	});
	it('ticks by month', () => {
		expect(m.xTicks.map((t) => t.label)).toEqual(['May 2026', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov']);
	});
	it('widens the month step to fit a small label budget', () => {
		const few = projectTimeline(base({ range: '6mo', ops: ['2026-10-01'], xTickBudget: 3 }));
		expect(few.xTicks.map((t) => t.label)).toEqual(['Jul 2026', 'Oct']);
	});
});

describe('range all', () => {
	it('runs from the project start to the later of its end, today and the last plan, plus 4%', () => {
		const m = projectTimeline(base({ project: { start: '2026-01-05', end: '2026-12-31' }, ops: ['2026-03-02'] }));
		const x0 = d('2026-01-05');
		expect(m.domain[0]).toBe(x0);
		const end = d('2026-12-31');
		expect(m.domain[1]).toBeCloseTo(end + (end - x0) * 0.04, 0);
	});
	it('uses the first record when the project has no start, and the last planned date when it is the latest', () => {
		const m = projectTimeline(base({ project: { start: null, end: null }, ops: ['2026-02-11'], plannedOps: [{ date: '2027-02-01', n: 3 }] }));
		expect(m.domain[0]).toBe(d('2026-02-09'));
		const end = d('2027-02-01');
		expect(m.domain[1]).toBeCloseTo(end + (end - d('2026-02-09')) * 0.04, 0);
	});
	it('does not hide a record older than the project start', () => {
		const m = projectTimeline(base({ project: { start: '2026-06-01', end: null }, ops: ['2026-05-04'] }));
		expect(m.domain[0]).toBe(d('2026-05-04'));
		expect(m.weeks).toHaveLength(1);
	});
	it('picks 2-month ticks for about a year', () => {
		const m = projectTimeline(base({ project: { start: '2025-11-01', end: '2026-10-31' }, ops: ['2026-03-02'], xTickBudget: 7 }));
		expect(m.xTicks.map((t) => t.label)).toEqual(['Nov 2025', 'Jan 2026', 'Mar', 'May', 'Jul', 'Sep', 'Nov']);
		expect(projectTimeline(base({ project: { start: '2025-11-01', end: '2026-10-31' }, xTickBudget: 6 })).xTicks.map((t) => t.label)).toEqual(['Jan 2026', 'Apr', 'Jul', 'Oct']);
	});
});

describe('project bar', () => {
	it('has an open end when there is no end date: it runs to today', () => {
		const m = projectTimeline(base({ project: { start: '2024-06-01', end: null } }));
		expect(m.project).toEqual({ start: d('2024-06-01'), end: TODAY.getTime(), openEnd: true });
	});
	it('is clipped to the domain', () => {
		const m = projectTimeline(base({ range: '30d', project: { start: '2024-06-01', end: '2027-01-31' } }));
		expect(m.project).toEqual({ start: m.domain[0], end: m.domain[1], openEnd: false });
	});
	it('starts at the left edge with no start date', () => {
		const m = projectTimeline(base({ range: '30d', project: { start: null, end: '2026-10-20' } }));
		expect(m.project).toEqual({ start: m.domain[0], end: d('2026-10-20'), openEnd: false });
	});
	it('is absent when the project ended before the domain', () => {
		expect(projectTimeline(base({ range: '30d', project: { start: '2024-01-01', end: '2025-01-01' } })).project).toBeNull();
	});
});

describe('campaigns', () => {
	const campaigns = [
		{ id: 'c6', code: '6', name: 'Six', status: 'active', start: null, end: null },
		{ id: 'c2', code: '2', name: 'Two', status: 'complete', start: '2025-03-01', end: '2025-04-01' },
		{ id: 'c1', code: '1', name: 'One', status: 'complete', start: '2024-09-01', end: '2024-12-01' },
		{ id: 'c7', code: '7', name: 'Seven', status: 'planned', start: '2026-10-01', end: null },
		{ id: 'c3', code: '3', name: 'Three', status: 'active', start: '2026-09-01', end: '2026-11-30' },
	];
	it('lists dated campaigns by start and the rest as undated, whatever the range', () => {
		const all = projectTimeline(base({ campaigns }));
		expect(all.campaigns.map((c) => c.code)).toEqual(['1', '2', '3']);
		expect(all.undated).toEqual(['6', '7']);
		const recent = projectTimeline(base({ campaigns, range: '30d' }));
		expect(recent.campaigns.map((c) => c.code)).toEqual(['3']);
		expect(recent.undated).toEqual(['6', '7']);
	});
	it('keeps the real dates of a campaign that runs past the domain', () => {
		const m = projectTimeline(base({ campaigns, range: '30d' }));
		expect(m.campaigns[0]).toMatchObject({ start: d('2026-09-01'), end: d('2026-11-30') });
	});
	it('does not call a range empty when a dated campaign is in it', () => {
		const m = projectTimeline(base({ campaigns, range: '30d' }));
		expect(m.weeks).toEqual([]);
		expect(m.empty).toBe(false);
	});
});

describe('planned work', () => {
	it('adds up a day, keeps what is in range, and tells operations from tests', () => {
		const m = projectTimeline(base({
			range: '30d',
			plannedOps: [{ date: '2026-10-20', n: 1 }, { date: '2026-10-20', n: 2 }, { date: '2026-01-01', n: 9 }],
			plannedTests: [{ date: '2026-10-22', n: 4 }, { date: '2026-10-21', n: 0 }],
		}));
		expect(m.planned).toEqual([
			{ date: d('2026-10-20'), kind: 'op', n: 3 },
			{ date: d('2026-10-22'), kind: 'test', n: 4 },
		]);
		expect(m.empty).toBe(false);
	});
});

describe('planned work ahead on a short range', () => {
	it('extends the domain to a planned date up to one range-length after today, with a little room', () => {
		const m = projectTimeline(base({ range: '30d', plannedOps: [{ date: '2026-11-10', n: 2 }] })); // 25 days ahead
		expect(m.domain[1]).toBe(d('2026-11-10') + DAY);
		expect(m.planned).toEqual([{ date: d('2026-11-10'), kind: 'op', n: 2 }]);
		expect(m.empty).toBe(false);
	});
	it('ignores a planned date farther ahead than one range-length', () => {
		const m = projectTimeline(base({ range: '30d', plannedOps: [{ date: '2026-12-25', n: 1 }] }));
		expect(m.domain[1]).toBe(TODAY.getTime() + 7.5 * DAY);
		expect(m.planned).toEqual([]);
		expect(m.empty).toBe(true);
	});
	it('keeps the quarter-range margin when the planned work is nearer than that', () => {
		expect(projectTimeline(base({ range: '30d', plannedOps: [{ date: '2026-10-18', n: 1 }] })).domain[1]).toBe(TODAY.getTime() + 7.5 * DAY);
	});
	it('does the same for 6 months', () => {
		const m = projectTimeline(base({ range: '6mo', plannedTests: [{ date: '2027-03-01', n: 1 }] }));
		expect(m.planned).toHaveLength(1);
		expect(m.domain[1]).toBeGreaterThan(d('2027-03-01'));
	});
});

describe('today on range all', () => {
	it('is inside the domain for a project that starts in the future', () => {
		const m = projectTimeline(base({ project: { start: '2027-03-01', end: '2027-09-01' } }));
		expect(m.domain[0]).toBeLessThanOrEqual(m.today);
		expect(m.domain[1]).toBeGreaterThan(m.today);
	});
	it('keeps the project start as the left edge when it is in the past', () => {
		expect(projectTimeline(base({ project: { start: '2026-01-05', end: '2026-12-31' } })).domain[0]).toBe(d('2026-01-05'));
	});
});

describe('a project whose end is before its start', () => {
	it('keeps its bar, earlier date first', () => {
		const m = projectTimeline(base({ range: '30d', project: { start: '2026-10-20', end: '2026-10-01' } }));
		expect(m.project).toEqual({ start: d('2026-10-01'), end: d('2026-10-20'), openEnd: false });
	});
	it('starts the all-range axis at the earlier date', () => {
		const m = projectTimeline(base({ project: { start: '2026-12-01', end: '2026-02-02' } }));
		expect(m.domain[0]).toBe(d('2026-02-02'));
		expect(m.project).toEqual({ start: d('2026-02-02'), end: d('2026-12-01'), openEnd: false });
	});
});

describe('planned dates as calendar days', () => {
	it('reads a date and a UTC midnight timestamp as the same local day, in any time zone', () => {
		expect(plannedDayOf('2026-10-20')).toBe(d('2026-10-20'));
		expect(plannedDayOf('2026-10-20T00:00:00Z')).toBe(d('2026-10-20'));
		expect(plannedDayOf('2026-10-20T00:00:00.000+00:00')).toBe(d('2026-10-20'));
		expect(plannedDayOf('')).toBeNull();
		expect(plannedDayOf(null)).toBeNull();
		expect(plannedDayOf('soon')).toBeNull();
	});
	it('puts the marker on its own day and adds the two spellings of one day together', () => {
		const m = projectTimeline(base({ range: '30d', plannedOps: [{ date: '2026-10-20T00:00:00Z', n: 1 }, { date: '2026-10-20', n: 2 }] }));
		expect(m.planned).toEqual([{ date: d('2026-10-20'), kind: 'op', n: 3 }]);
	});
});

describe('empty', () => {
	it('is empty with nothing done, planned or dated in range', () => {
		const m = projectTimeline(base({ range: '6mo', ops: ['2020-01-01'], tests: ['2020-01-02'], plannedOps: [{ date: '2030-01-01', n: 1 }] }));
		expect(m.empty).toBe(true);
		expect(m.weeks).toEqual([]);
		// the newest record is still reported, whatever the range
		expect(m.lastOp).toBe(d('2020-01-01'));
		expect(m.lastTest).toBe(d('2020-01-02'));
	});
	it('has no last operation or test for a project with none, and a model that still draws', () => {
		const m = projectTimeline(base({ project: { start: null, end: null } }));
		expect(m.empty).toBe(true);
		expect(m.lastOp).toBeNull();
		expect(m.lastTest).toBeNull();
		expect(m.domain[1]).toBeGreaterThan(m.domain[0]);
	});
	it('words the empty line for each range', () => {
		expect(emptyText('30d')).toBe('No operations or tests in the last 30 days.');
		expect(emptyText('6mo')).toBe('No operations or tests in the last 6 months.');
		expect(emptyText('all')).toBe('No operations or tests in the project.');
	});
});

describe('y axis', () => {
	it('uses steps of 1, 2, 2.5 and 5 times a power of ten', () => {
		expect(niceStep(100)).toBe(25);
		expect(niceStep(230)).toBe(100);
		expect(niceStep(180)).toBe(50);
	});
	it('never steps by a fraction for counts', () => {
		expect(niceStep(1)).toBe(1);
		expect(niceStep(3)).toBe(1);
		expect(niceStep(10)).toBe(5);
	});
	it('puts the top tick above the busiest week', () => {
		expect(yAxis(1)).toEqual({ top: 2, step: 1, ticks: [0, 1, 2] });
		expect(yAxis(4).ticks).toEqual([0, 1, 2, 3, 4, 5]);
		expect(yAxis(10).ticks).toEqual([0, 5, 10, 15]);
		expect(yAxis(20).ticks).toEqual([0, 5, 10, 15, 20, 25]);
		for (const max of [1, 2, 7, 11, 24, 25, 99, 100, 640]) {
			const y = yAxis(max);
			expect(y.top).toBeGreaterThan(max);
			expect(y.ticks.length).toBeLessThanOrEqual(7);
		}
	});
	it('scales to the busiest stacked week', () => {
		const m = projectTimeline(base({ ops: ['2026-10-12', '2026-10-13', '2026-10-14'], tests: ['2026-10-15', '2026-10-15'] }));
		expect(m.weeks[0]).toMatchObject({ ops: 3, tests: 2 });
		expect(m.y.top).toBeGreaterThan(5);
	});
});

describe('data and x ticks apart', () => {
	it('gives the same model as projectTimeline, the x ticks following only the domain and the budget', () => {
		const input = base({ range: '6mo', ops: ['2026-10-01'] });
		const data = timelineData(input);
		expect(data).not.toHaveProperty('xTicks');
		for (const xTickBudget of [3, 8]) {
			expect(projectTimeline({ ...input, xTickBudget })).toEqual({ ...data, xTicks: timelineXTicks(data.domain, xTickBudget) });
		}
		expect(timelineXTicks(data.domain, 3).length).toBeLessThan(timelineXTicks(data.domain, 8).length);
	});
});
