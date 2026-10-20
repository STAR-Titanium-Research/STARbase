import { describe, expect, it, vi } from 'vitest';
import { ACTIVITY_ROW_CAP, fetchActivityRows } from './activityRows';
import { windowStart } from './activity';
import { anyProjectFilter, projectScopeFilter } from './projectScope';

const NOW = new Date('2026-10-07T12:00:00Z');

describe('fetchActivityRows', () => {
	it('scopes one project by the kit rule and reads only the date', async () => {
		const getItems = vi.fn().mockResolvedValue([]);
		await fetchActivityRows(getItems, 'p1', 26, NOW);
		const [collection, params] = getItems.mock.calls[0];
		expect(collection).toBe('manufacturing_operations');
		expect(params.filter._and[0]).toEqual(projectScopeFilter('p1'));
		expect(params.fields).toEqual(['operation_date']);
		expect(params.filter._and[1]).toEqual({ operation_date: { _gte: windowStart(26, NOW) } });
	});
	it('files the rows of one project under it', async () => {
		const getItems = vi.fn(async (c: string) => (c === 'manufacturing_operations' ? [{ operation_date: '2026-10-01T00:00:00Z' }] : []));
		expect((await fetchActivityRows(getItems, 'p1')).ops).toEqual([{ project_id: 'p1', operation_date: '2026-10-01T00:00:00Z' }]);
	});
	it('scopes every project by the any-project rule and reads the campaign project too', async () => {
		const getItems = vi.fn().mockResolvedValue([]);
		await fetchActivityRows(getItems, undefined, 26, NOW);
		expect(getItems.mock.calls[0][1].fields).toEqual(['project_id', 'campaign_id.project_id', 'operation_date']);
		expect(getItems.mock.calls[1][1].filter._and[0]).toEqual(anyProjectFilter());
	});
	it('files a row without its own project under the project of its campaign', async () => {
		const getItems = vi.fn(async (c: string) =>
			c === 'manufacturing_operations'
				? [
						{ project_id: 'a', campaign_id: null, operation_date: '2026-10-01T00:00:00Z' },
						{ project_id: null, campaign_id: { project_id: 'b' }, operation_date: '2026-10-02T00:00:00Z' },
					]
				: [{ project_id: null, campaign_id: { project_id: 'b' }, session_date: '2026-10-03T00:00:00Z' }],
		);
		const rows = await fetchActivityRows(getItems, undefined, 26, NOW);
		expect(rows.ops.map((r) => r.project_id)).toEqual(['a', 'b']);
		expect(rows.tests).toEqual([{ project_id: 'b', session_date: '2026-10-03T00:00:00Z' }]);
		expect(rows.truncated).toBe(false);
	});
	it('reads only dated rows, with no start, for the "all" window', async () => {
		const getItems = vi.fn().mockResolvedValue([]);
		await fetchActivityRows(getItems, 'p1', 'all', NOW);
		expect(getItems.mock.calls[0][1].filter._and[1]).toEqual({ operation_date: { _nnull: true } });
		expect(getItems.mock.calls[1][1].filter._and[1]).toEqual({ session_date: { _nnull: true } });
		await fetchActivityRows(getItems, 'p1', 5, NOW);
		expect(getItems.mock.calls[2][1].filter._and[1].operation_date._gte).toEqual(expect.any(String));
	});
	it('for "all", starts the chart at the oldest date of a capped series, so the other series shows no weeks the capped one cannot', async () => {
		const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
		const ops = Array.from({ length: ACTIVITY_ROW_CAP }, (_, i) => ({ project_id: 'a', operation_date: day(i % 60) }));
		const tests = [{ project_id: 'a', session_date: day(10) }, { project_id: 'a', session_date: day(300) }];
		const getItems = vi.fn(async (c: string) => (c === 'manufacturing_operations' ? ops : tests));
		const rows = await fetchActivityRows(getItems, 'a', 'all', NOW);
		expect(rows.truncated).toBe(true);
		expect(rows.ops).toHaveLength(ACTIVITY_ROW_CAP);
		expect(rows.tests).toEqual([{ project_id: 'a', session_date: day(10) }]);
		// a bounded window is left as read, and so is "all" when nothing was capped
		expect((await fetchActivityRows(getItems, 'a', 26, NOW)).tests).toHaveLength(2);
		const small = vi.fn(async (c: string) => (c === 'manufacturing_operations' ? ops.slice(0, 3) : tests));
		expect((await fetchActivityRows(small, 'a', 'all', NOW)).tests).toHaveLength(2);
	});
	it('says so when a read hit its cap', async () => {
		const full = Array.from({ length: ACTIVITY_ROW_CAP }, () => ({ project_id: 'a', operation_date: '2026-10-01T00:00:00Z' }));
		const getItems = vi.fn(async (c: string) => (c === 'manufacturing_operations' ? full : []));
		expect((await fetchActivityRows(getItems, 'a', 26, NOW)).truncated).toBe(true);
	});
	it('reads done work only, in both collections', async () => {
		const getItems = vi.fn().mockResolvedValue([]);
		await fetchActivityRows(getItems, 'p1');
		for (const call of getItems.mock.calls) expect(call[1].filter._and).toContainEqual({ work_state: { _eq: 'done' } });
	});
	it('keeps the tests when the operations read fails, and says which failed', async () => {
		const boom = new Error('forbidden');
		const getItems = vi.fn(async (c: string) => {
			if (c === 'manufacturing_operations') throw boom;
			return [{ session_date: '2026-10-03T00:00:00Z' }];
		});
		const rows = await fetchActivityRows(getItems, 'p1');
		expect(rows.ops).toEqual([]);
		expect(rows.tests).toEqual([{ project_id: 'p1', session_date: '2026-10-03T00:00:00Z' }]);
		expect(rows.failed).toEqual([{ collection: 'operations', error: boom }]);
	});
	it('keeps the operations when the tests read fails', async () => {
		const getItems = vi.fn(async (c: string) => {
			if (c === 'test_sessions') throw new Error('nope');
			return [{ operation_date: '2026-10-01T00:00:00Z' }];
		});
		const rows = await fetchActivityRows(getItems, 'p1');
		expect(rows.ops).toHaveLength(1);
		expect(rows.failed.map((f) => f.collection)).toEqual(['tests']);
	});
	it('throws when both reads fail', async () => {
		const getItems = vi.fn().mockRejectedValue(new Error('down'));
		await expect(fetchActivityRows(getItems, 'p1')).rejects.toThrow('down');
	});
	it('reports no failure when both answer', async () => {
		expect((await fetchActivityRows(vi.fn().mockResolvedValue([]), 'p1')).failed).toEqual([]);
	});
});
