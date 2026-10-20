import { describe, expect, it } from 'vitest';
import { campaignStatusParts, parseTimelineRange, readTimelineRange, writeTimelineRange, TIMELINE_RANGE_KEY, projectDatesText, plannedFromCounts, splitCampaigns, timelineCampaigns } from './projectHero';

describe('splitCampaigns', () => {
	it('puts planned, active and on hold first, keeps the given order inside a status, and folds the complete ones', () => {
		const rows = [
			{ id: 1, status: 'complete' },
			{ id: 2, status: 'active' },
			{ id: 3, status: 'on_hold' },
			{ id: 4, status: 'planned' },
			{ id: 5, status: 'active' },
			{ id: 6, status: 'weird' },
			{ id: 7, status: null },
		];
		const { open, complete } = splitCampaigns(rows);
		expect(open.map((c) => c.id)).toEqual([4, 2, 5, 3, 6, 7]);
		expect(complete.map((c) => c.id)).toEqual([1]);
	});
	it('handles none', () => {
		expect(splitCampaigns([])).toEqual({ open: [], complete: [] });
	});
});

describe('campaignStatusParts', () => {
	it('lists the open statuses in the line order and leaves out zeros and complete', () => {
		expect(campaignStatusParts({ planned: 1, active: 1, on_hold: 1, complete: 4 })).toEqual([
			{ n: 1, label: 'active' }, { n: 1, label: 'planned' }, { n: 1, label: 'on hold' },
		]);
		expect(campaignStatusParts({ active: 2, planned: 0 })).toEqual([{ n: 2, label: 'active' }]);
		expect(campaignStatusParts({})).toEqual([]);
	});
});

describe('timelineCampaigns', () => {
	it('maps the page rows and falls back to the name for a campaign without a code', () => {
		expect(timelineCampaigns([
			{ campaign_id: 'a', campaign_code: '10', name: 'Cutting', status: 'active', start_date: '2026-01-01', end_date: null },
			{ campaign_id: 'b', campaign_code: null, name: 'Loose', status: null },
		])).toEqual([
			{ id: 'a', code: '10', name: 'Cutting', status: 'active', start: '2026-01-01', end: null },
			{ id: 'b', code: 'Loose', name: 'Loose', status: '', start: null, end: null },
		]);
	});
});

describe('plannedFromCounts', () => {
	it('sorts by date and drops empty groups', () => {
		expect(plannedFromCounts(new Map([['2026-11-02', 2], ['2026-10-25', 1], ['2026-12-01', 0]]))).toEqual([
			{ date: '2026-10-25', n: 1 }, { date: '2026-11-02', n: 2 },
		]);
	});
});

describe('parseTimelineRange', () => {
	it('accepts the three ranges and defaults to all', () => {
		expect(parseTimelineRange('30d')).toBe('30d');
		expect(parseTimelineRange('6mo')).toBe('6mo');
		expect(parseTimelineRange('all')).toBe('all');
		expect(parseTimelineRange('1y')).toBe('all');
		expect(parseTimelineRange(null)).toBe('all');
	});
});

describe('the remembered timeline range', () => {
	const fake = (initial: Record<string, string> = {}): Storage => {
		const m = new Map(Object.entries(initial));
		return { get length() { return m.size; }, clear: () => m.clear(), getItem: (k) => m.get(k) ?? null, key: (i) => [...m.keys()][i] ?? null, removeItem: (k) => void m.delete(k), setItem: (k, v) => void m.set(k, String(v)) };
	};
	const blocked = (): Storage => ({ ...fake(), getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } });
	it('round-trips, and is "all" with nothing stored, a stale value or no storage', () => {
		const s = fake();
		expect(readTimelineRange(s)).toBe('all');
		writeTimelineRange('30d', s);
		expect(s.getItem(TIMELINE_RANGE_KEY)).toBe('30d');
		expect(readTimelineRange(s)).toBe('30d');
		expect(readTimelineRange(fake({ [TIMELINE_RANGE_KEY]: '1y' }))).toBe('all');
		expect(readTimelineRange(null)).toBe('all');
	});
	it('survives storage that throws', () => {
		expect(readTimelineRange(blocked())).toBe('all');
		expect(() => writeTimelineRange('6mo', blocked())).not.toThrow();
		expect(() => writeTimelineRange('6mo', null)).not.toThrow();
	});
});

describe('projectDatesText', () => {
	it('words each combination', () => {
		expect(projectDatesText('2025-01-13', '2027-03-31')).toBe('13 Jan 2025 to 31 Mar 2027');
		expect(projectDatesText('2024-06-01', null)).toBe('From 1 Jun 2024, no end date');
		expect(projectDatesText(null, '2027-03-31')).toBe('Until 31 Mar 2027');
		expect(projectDatesText(null, undefined)).toBe('No dates set');
	});
});
