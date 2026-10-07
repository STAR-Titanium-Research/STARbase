import { describe, expect, it, vi } from 'vitest';
import { ACTIVITY_ROW_CAP, fetchActivityRows } from './activityRows';
import { anyProjectFilter, projectScopeFilter } from './projectScope';

const NOW = new Date('2026-10-07T12:00:00Z');

describe('fetchActivityRows', () => {
	it('scopes one project by the kit rule and reads the campaign project too', async () => {
		const getItems = vi.fn().mockResolvedValue([]);
		await fetchActivityRows(getItems, 'p1', 26, NOW);
		const [collection, params] = getItems.mock.calls[0];
		expect(collection).toBe('manufacturing_operations');
		expect(params.filter._and[0]).toEqual(projectScopeFilter('p1'));
		expect(params.fields).toEqual(['project_id', 'campaign_id.project_id', 'operation_date']);
	});
	it('scopes every project by the any-project rule', async () => {
		const getItems = vi.fn().mockResolvedValue([]);
		await fetchActivityRows(getItems, undefined, 26, NOW);
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
	it('says so when a read hit its cap', async () => {
		const full = Array.from({ length: ACTIVITY_ROW_CAP }, () => ({ project_id: 'a', operation_date: '2026-10-01T00:00:00Z' }));
		const getItems = vi.fn(async (c: string) => (c === 'manufacturing_operations' ? full : []));
		expect((await fetchActivityRows(getItems, 'a', 26, NOW)).truncated).toBe(true);
	});
});
