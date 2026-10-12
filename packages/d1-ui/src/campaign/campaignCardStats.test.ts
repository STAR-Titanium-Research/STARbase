import { describe, expect, it } from 'vitest';
import type { ExplorerHost } from '../host';
import { CARD_STATS_MAX, campaignCardStats, loadCampaignStats } from './campaignCardStats';

interface Call { path: string; params: Record<string, any> }

// A fake host: a recording API whose answers are chosen per collection (an Error fails the read).
function fakeHost(answers: Record<string, unknown[] | Error>, doneAnswer?: unknown[] | Error) {
	const calls: Call[] = [];
	const host = {
		api: {
			get: async (path: string, config?: { params?: Record<string, any> }) => {
				const params = config?.params ?? {};
				calls.push({ path, params });
				const collection = path.replace('/items/', '');
				// the "done tests" read is the test_sessions one whose filter has a status clause
				const isDone = collection === 'test_sessions' && typeof params.filter === 'string' && params.filter.includes('"status"');
				const answer = isDone && doneAnswer !== undefined ? doneAnswer : answers[collection];
				if (answer instanceof Error) throw answer;
				return { data: { data: answer ?? [] } };
			},
		},
	} as unknown as ExplorerHost;
	return { host, calls };
}

const testing = { campaign_id: 'c-test', campaign_type: 'testing_campaign' };
const machining = { campaign_id: 'c-mach', campaign_type: 'machining_trial' };

describe('campaignCardStats', () => {
	it('counts samples, operations and tests per campaign and builds the progress bars', async () => {
		const { host } = fakeHost(
			{
				campaign_samples: [{ campaign_id: 'c-test', count: '4' }, { campaign_id: 'c-mach', count: '2' }],
				manufacturing_operations: [{ campaign_id: 'c-mach', count: '3' }, ...[]],
				test_sessions: [{ campaign_id: 'c-test', count: '5' }],
			},
			[{ campaign_id: 'c-test', count: '2' }],
		);
		const stats = await campaignCardStats(host, [testing, machining]);
		const t = stats.get('c-test')!;
		expect([t.samples, t.operations, t.tests]).toEqual([4, 0, 5]);
		expect(t.progress).toEqual({ kind: 'bar', label: 'Tests complete', done: 2, total: 5 });
		const m = stats.get('c-mach')!;
		expect([m.samples, m.operations, m.tests]).toEqual([2, 3, 0]);
		expect(m.progress.kind).toBe('bar');
	});

	it('filters every read by the campaign ids, sent as JSON', async () => {
		const { host, calls } = fakeHost({});
		await campaignCardStats(host, [testing, machining]);
		expect(calls.length).toBeGreaterThanOrEqual(6);
		for (const c of calls) {
			expect(typeof c.params.filter).toBe('string');
			expect(c.params.filter).toContain('"_in":["c-test","c-mach"]');
		}
		expect(calls.some((c) => c.path === '/items/machining_force_analysis')).toBe(true);
	});

	it('does not read force rows when no campaign is a machining trial', async () => {
		const { host, calls } = fakeHost({});
		await campaignCardStats(host, [testing]);
		expect(calls.some((c) => c.path === '/items/machining_force_analysis')).toBe(false);
	});

	it('asks for at most 50 campaigns', async () => {
		const many = Array.from({ length: 80 }, (_, i) => ({ campaign_id: `c${i}`, campaign_type: 'imaging_campaign' }));
		const { host, calls } = fakeHost({});
		await campaignCardStats(host, many);
		const ids = JSON.parse(calls[0].params.filter).campaign_id._in as string[];
		expect(ids).toHaveLength(CARD_STATS_MAX);
	});

	it('asks for nothing when there are no campaigns', async () => {
		const { host, calls } = fakeHost({});
		expect((await campaignCardStats(host, [])).size).toBe(0);
		expect(calls).toHaveLength(0);
	});

	it('gives no stats at all when one of the three counts cannot be read', async () => {
		const { host } = fakeHost({ campaign_samples: new Error('403'), test_sessions: [{ campaign_id: 'c-test', count: '1' }] });
		expect((await campaignCardStats(host, [testing])).size).toBe(0);
	});

	it('keeps the counts when only the done-tests read fails, and marks that bar unavailable', async () => {
		const { host } = fakeHost({ test_sessions: [{ campaign_id: 'c-test', count: '5' }] }, new Error('boom'));
		const t = (await campaignCardStats(host, [testing])).get('c-test')!;
		expect(t.tests).toBe(5);
		expect(t.progress).toEqual({ kind: 'unavailable', label: 'Tests complete', reason: 'forbidden' });
	});

	it('marks a machining bar unavailable when the force rows cannot be read, keeping the counts', async () => {
		const { host } = fakeHost({
			campaign_samples: [{ campaign_id: 'c-mach', count: '2' }],
			machining_force_analysis: new Error('403'),
		});
		const m = (await campaignCardStats(host, [machining])).get('c-mach')!;
		expect(m.samples).toBe(2);
		expect(m.progress).toEqual({ kind: 'unavailable', label: 'Force analysed', reason: 'forbidden' });
	});
});

describe('loadCampaignStats', () => {
	it('uses the scope it is given (the Project page passes its project)', async () => {
		const seen: unknown[] = [];
		const scope = { campaign_id: { project_id: { _eq: 'p1' } } };
		const getItems = async (_c: string, params: Record<string, unknown>) => {
			seen.push(params.filter);
			return [];
		};
		const out = await loadCampaignStats(getItems, [testing], scope);
		expect(out?.get('c-test')?.samples).toBe(0);
		expect(seen[0]).toBe(scope);
	});
	it('is null when a count read fails', async () => {
		const getItems = async (c: string) => {
			if (c === 'manufacturing_operations') throw new Error('x');
			return [];
		};
		expect(await loadCampaignStats(getItems, [testing], {})).toBeNull();
	});
});
