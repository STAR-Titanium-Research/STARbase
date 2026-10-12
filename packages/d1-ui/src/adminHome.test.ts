import { describe, expect, it } from 'vitest';
import {
	CRAWLER_ONLINE_MS, FUTURE_TOLERANCE_MS, ago, attentionView, crawlerOnline, isAuthRefusal, normaliseOverview, overviewTime, ownerlessRows, ownerlessTotal,
} from './adminHome';

const NOW = Date.parse('2026-10-12T12:00:00Z');
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

describe('crawlerOnline', () => {
	it('is online for a heartbeat younger than 30 s', () => {
		expect(crawlerOnline(at(0), NOW)).toBe(true);
		expect(crawlerOnline(at(CRAWLER_ONLINE_MS - 1), NOW)).toBe(true);
	});
	it('is offline at 30 s and beyond', () => {
		expect(crawlerOnline(at(CRAWLER_ONLINE_MS), NOW)).toBe(false);
		expect(crawlerOnline(at(5 * 60_000), NOW)).toBe(false);
	});
	it('is offline with no or unreadable heartbeat', () => {
		expect(crawlerOnline(null, NOW)).toBe(false);
		expect(crawlerOnline(undefined, NOW)).toBe(false);
		expect(crawlerOnline('nonsense', NOW)).toBe(false);
	});
	it('counts a heartbeat slightly ahead as online, one far ahead as a mis-set clock', () => {
		expect(crawlerOnline(at(-5000), NOW)).toBe(true);
		expect(crawlerOnline(at(-(FUTURE_TOLERANCE_MS - 1)), NOW)).toBe(true);
		expect(crawlerOnline(at(-(FUTURE_TOLERANCE_MS + 1000)), NOW)).toBe(false);
	});
});

describe('overviewTime', () => {
	const fetchedAt = Date.parse('2026-10-12T12:30:00Z'); // a browser clock half an hour out
	it('uses the database clock, not the browser clock, as the reference', () => {
		expect(overviewTime('2026-10-12T12:00:00Z', fetchedAt)).toBe(NOW);
		// A healthy crawler (heartbeat 8 s before the database's now) is online whatever the browser says.
		expect(crawlerOnline(at(8000), overviewTime(new Date(NOW).toISOString(), fetchedAt))).toBe(true);
	});
	it('does not drift the online verdict: it is judged at the moment of the answer', () => {
		const hb = at(8000);
		const server = new Date(NOW).toISOString();
		expect(crawlerOnline(hb, overviewTime(server, fetchedAt))).toBe(true);
		// The age text moves on with the time since the answer, the verdict does not.
		expect(ago(hb, overviewTime(server, fetchedAt, fetchedAt + 25_000))).toBe('33 s ago');
	});
	it('falls back to the fetch time when the server time is missing or unreadable', () => {
		expect(overviewTime(null, fetchedAt)).toBe(fetchedAt);
		expect(overviewTime('junk', fetchedAt, fetchedAt + 5000)).toBe(fetchedAt + 5000);
	});
	it('never runs backwards if now is before the fetch', () => {
		expect(overviewTime(null, fetchedAt, fetchedAt - 9000)).toBe(fetchedAt);
	});
});

describe('isAuthRefusal', () => {
	it('is true for 401 and 403 only', () => {
		expect(isAuthRefusal({ response: { status: 401 } })).toBe(true);
		expect(isAuthRefusal({ response: { status: 403 } })).toBe(true);
		expect(isAuthRefusal({ response: { status: 500 } })).toBe(false);
		expect(isAuthRefusal(new Error('network'))).toBe(false);
		expect(isAuthRefusal(null)).toBe(false);
	});
});

describe('ago', () => {
	it('picks the unit', () => {
		expect(ago(at(12_000), NOW)).toBe('12 s ago');
		expect(ago(at(5 * 60_000), NOW)).toBe('5 min ago');
		expect(ago(at(3 * 3_600_000), NOW)).toBe('3 h ago');
		expect(ago(at(2 * 86_400_000), NOW)).toBe('2 d ago');
	});
	it('never shows a negative age and is empty without a time', () => {
		expect(ago(at(-9000), NOW)).toBe('0 s ago');
		expect(ago(null, NOW)).toBe('');
		expect(ago('x', NOW)).toBe('');
	});
});

describe('normaliseOverview', () => {
	it('is null for a non-object answer', () => {
		expect(normaliseOverview(null)).toBeNull();
		expect(normaliseOverview('<html>')).toBeNull();
		expect(normaliseOverview([])).toBeNull();
	});
	it('keeps a failed part as null and the others intact', () => {
		const o = normaliseOverview({
			missingFiles: null,
			fingerprints: { done: '4', error: 1, missing: 2 },
			crawler: { state: null, analyses: { pending: 3, processing: 0, done: 9, error: 1 } },
			ownerless: { samples: 5, campaigns: 0, machiningOperations: 2 },
			serverTime: '2026-10-12T12:00:00Z',
		});
		expect(o?.serverTime).toBe('2026-10-12T12:00:00Z');
		expect(o?.missingFiles).toBeNull();
		expect(o?.fingerprints).toEqual({ done: 4, error: 1, missing: 2 });
		expect(o?.crawler?.state).toBeNull();
		expect(o?.crawler?.analyses.pending).toBe(3);
		expect(o?.ownerless?.samples).toBe(5);
	});
	it('coerces numbers and tolerates a missing part', () => {
		const o = normaliseOverview({
			missingFiles: { count: 'x', recent: [{ id: 7, filename_download: '', missing_since: '2026-10-01T00:00:00Z' }, 'bad'] },
			crawler: { state: { desired_state: 'running', processed_count: '12', error_count: null }, analyses: null },
		});
		expect(o?.missingFiles).toEqual({ count: 0, recent: [{ id: '7', filename_download: null, missing_since: '2026-10-01T00:00:00Z' }] });
		expect(o?.crawler?.state).toMatchObject({ desired_state: 'running', processed_count: 12, error_count: 0, last_heartbeat_at: null });
		expect(o?.crawler?.analyses).toEqual({ pending: 0, processing: 0, done: 0, error: 0 });
		expect(o?.fingerprints).toBeNull();
		expect(o?.ownerless).toBeNull();
		expect(o?.serverTime).toBeNull();
	});
});

describe('ownerless', () => {
	const o = { samples: 3, campaigns: 0, machiningOperations: 4 };
	it('links each row to its Explorer list', () => {
		expect(ownerlessRows(o).map((r) => [r.key, r.count, r.to])).toEqual([
			['samples', 3, '/home/samples'],
			['campaigns', 0, '/home/campaigns'],
			['operations', 4, '/home/operations'],
		]);
	});
	it('totals the three', () => {
		expect(ownerlessTotal(o)).toBe(7);
		expect(ownerlessTotal({ samples: 0, campaigns: 0, machiningOperations: 0 })).toBe(0);
	});
});

describe('attentionView', () => {
	const t = (key: string, count: number | null, error = '', loading = false) => ({ key, count, error, loading });
	it('lists only non-zero tiles', () => {
		expect(attentionView([t('a', 0), t('b', 2), t('c', 0)])).toEqual({ rows: ['b'], status: 'items' });
	});
	it('says clear when everything answered zero', () => {
		expect(attentionView([t('a', 0), t('b', 0)])).toEqual({ rows: [], status: 'clear' });
	});
	it('is loading while counts are pending and nothing is known', () => {
		expect(attentionView([t('a', null, '', true), t('b', 0)]).status).toBe('loading');
		expect(attentionView([]).status).toBe('loading');
	});
	it('shows what is known while others still load', () => {
		expect(attentionView([t('a', null, '', true), t('b', 1)])).toEqual({ rows: ['b'], status: 'items' });
	});
	it('keeps a failed count visible for an admin', () => {
		expect(attentionView([t('a', null, 'boom'), t('b', 0)])).toEqual({ rows: ['a'], status: 'items' });
	});
	it('hides a failed count when errors are not to be shown', () => {
		expect(attentionView([t('a', null, 'boom'), t('b', 2)], false)).toEqual({ rows: ['b'], status: 'items' });
		expect(attentionView([t('a', null, 'boom')], false)).toEqual({ rows: [], status: 'clear' });
	});
});
