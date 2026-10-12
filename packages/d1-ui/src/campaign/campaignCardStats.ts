// The numbers on a campaign card: samples, operations and tests per campaign, and the progress bar
// ("force analysed n / m" for a machining trial, "tests complete n / m" for a testing campaign).
// One loader serves both places a campaign card appears: the Project page (campaigns of one project,
// scope = that project) and the campaigns index (the campaigns on the page, scope = their ids).
// Counts are exact aggregates grouped by campaign; only the force-analysis states need rows, and a
// read that hits the cap withholds the bar instead of drawing a wrong one. Every read is fail-soft:
// a collection the role cannot read costs its own number, never the cards.

import type { ExplorerHost } from '../host';
import { TEST_DONE_STATUSES } from '../status';
import { operationCategoryFor } from './campaignType';
import { campaignProgress, countsByKey } from '../projects';
import type { CampaignLite, CampaignProgress, ForceRows } from '../projects';

export type CampaignStats = CampaignProgress;
export type ItemsReader = (collection: string, params: Record<string, unknown>) => Promise<any[]>;

// A page of the campaigns index is at most 50 rows; more than that is not asked for.
export const CARD_STATS_MAX = 50;
// Cap of the row reads behind the machining progress bar; past it the bar is withheld, not wrong.
export const PROGRESS_ROW_CAP = 5000;

const soft = async <T>(read: () => Promise<T>, fallback: T): Promise<{ data: T; ok: boolean }> => {
	try {
		return { data: await read(), ok: true };
	} catch {
		return { data: fallback, ok: false };
	}
};

/**
 * `scope` is a filter on the rows that belong to a campaign of interest, written against the child
 * collections' `campaign_id` (e.g. `{ campaign_id: { _in: ids } }`). Null when the three counts could
 * not be read (a card then says "Counts unavailable"); the progress bar degrades on its own.
 */
export async function loadCampaignStats(
	getItems: ItemsReader,
	campaigns: ReadonlyArray<CampaignLite>,
	scope: Record<string, unknown>,
): Promise<Map<string, CampaignStats> | null> {
	const grouped = (collection: string, filter: Record<string, unknown>) =>
		getItems(collection, { aggregate: { count: '*' }, groupBy: ['campaign_id'], filter, limit: -1 });
	const hasMachining = campaigns.some((c) => operationCategoryFor(c.campaign_type) === 'machining');
	const machining = (path: Record<string, unknown>) => ({ _and: [path, { campaign_id: { campaign_type: { _eq: 'machining_trial' } } }] });
	const [samples, ops, tests, testsDone, force] = await Promise.all([
		soft(() => grouped('campaign_samples', scope), [] as any[]),
		soft(() => grouped('manufacturing_operations', scope), [] as any[]),
		soft(() => grouped('test_sessions', scope), [] as any[]),
		soft(() => grouped('test_sessions', { _and: [scope, { status: { _in: TEST_DONE_STATUSES } }] }), [] as any[]),
		soft(async (): Promise<ForceRows> => {
			if (!hasMachining) return { operations: [], analyses: [], truncated: false };
			const [operations, analyses] = await Promise.all([
				getItems('manufacturing_operations', {
					filter: machining(scope),
					fields: ['operation_id', 'campaign_id', 'process_category'],
					limit: PROGRESS_ROW_CAP,
				}),
				getItems('machining_force_analysis', {
					filter: { operation_id: machining(scope) },
					fields: ['operation_id', 'status'],
					limit: PROGRESS_ROW_CAP,
				}),
			]);
			return { operations, analyses, truncated: operations.length >= PROGRESS_ROW_CAP || analyses.length >= PROGRESS_ROW_CAP };
		}, null as ForceRows | null),
	]);
	if (!(samples.ok && ops.ok && tests.ok)) return null;
	return campaignProgress({
		campaigns,
		samplesByCampaign: countsByKey(samples.data, 'campaign_id'),
		operationsByCampaign: countsByKey(ops.data, 'campaign_id'),
		testsByCampaign: countsByKey(tests.data, 'campaign_id'),
		testsDoneByCampaign: testsDone.ok ? countsByKey(testsDone.data, 'campaign_id') : null,
		forceRows: force.ok ? force.data : null,
	});
}

// The kit's version for a list page: reads through the host's API (filters sent as JSON, like the
// index's own requests) for up to 50 campaigns, by id. Returns the stats by campaign id; an id with
// no entry has none (its counts could not be read), and the whole map is empty on a failure.
export async function campaignCardStats(
	host: ExplorerHost,
	campaigns: ReadonlyArray<CampaignLite>,
): Promise<Map<string, CampaignStats>> {
	const list = campaigns.slice(0, CARD_STATS_MAX);
	if (!list.length) return new Map();
	const getItems: ItemsReader = async (collection, params) => {
		const sent = params.filter === undefined ? params : { ...params, filter: JSON.stringify(params.filter) };
		const res = await host.api.get(`/items/${collection}`, { params: sent });
		return (res.data?.data ?? []) as any[];
	};
	const ids = list.map((c) => c.campaign_id);
	return (await loadCampaignStats(getItems, list, { campaign_id: { _in: ids } })) ?? new Map();
}
