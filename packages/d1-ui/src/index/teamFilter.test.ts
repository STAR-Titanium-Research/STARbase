import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, reactive, ref } from 'vue';
import type { ExplorerHost } from '../host';
import { INDEX_DEFS, TEAM_FILTER_FIELD, indexDefBySlug } from './indexConfig';
import { NO_MATCH_ID, buildItemsParams, queryFromState, stateFromQuery } from './indexQuery';
import type { IndexState } from './indexQuery';
import { teamTruncatedNote } from './indexView';
import { useIndexPage } from './useIndexPage';
import type { RouteLike, RouterLike } from './useIndexPage';

// The Team filter (People 4, Ruling M1): the chip's definition, the query it builds from the ids the d1-teams endpoint gives, the URL
// round trip (f.team=<id>) and the page's two-step load (ids first, then the rows).

const samples = indexDefBySlug('samples')!;
const state = (over: Partial<IndexState> = {}): IndexState => ({ bookmark: null, q: '', filters: {}, sort: null, page: 1, open: null, ...over });
const filterOf = (p: Record<string, unknown>) => JSON.parse(p.filter as string);

describe('the Team chip on the index definitions', () => {
	it('is offered on samples, operations, tests and campaigns, as f.team, once each', () => {
		for (const slug of ['samples', 'operations', 'tests', 'campaigns']) {
			const chips = indexDefBySlug(slug)!.filters.filter((f) => f.options.kind === 'team');
			expect(chips, slug).toEqual([{ field: 'team', label: 'Team', options: { kind: 'team' } }]);
		}
		expect(TEAM_FILTER_FIELD).toBe('team');
	});

	it('is on no other list (an inventory or reference list has no teams; projects have a page of their own)', () => {
		const withTeam = INDEX_DEFS.filter((d) => d.filters.some((f) => f.options.kind === 'team')).map((d) => d.slug).sort();
		expect(withTeam).toEqual(['campaigns', 'operations', 'samples', 'tests']);
	});
});

describe('buildItemsParams with the Team chip', () => {
	it('filters the primary key to the team\'s ids', () => {
		const p = buildItemsParams(samples, state({ filters: { team: 't1' } }), null, null, ['a', 'b']);
		expect(filterOf(p)).toEqual({ _and: [{ sample_id: { _in: ['a', 'b'] } }] });
	});

	it('matches nothing for a team with no readable records, or when the ids are not known: never every row', () => {
		const nothing = { _and: [{ sample_id: { _in: [NO_MATCH_ID] } }] };
		expect(filterOf(buildItemsParams(samples, state({ filters: { team: 't1' } }), null, null, []))).toEqual(nothing);
		expect(filterOf(buildItemsParams(samples, state({ filters: { team: 't1' } }), null, null, null))).toEqual(nothing);
		expect(NO_MATCH_ID).toBe('00000000-0000-0000-0000-000000000000');
	});

	it('adds nothing without the chip, whatever ids are passed', () => {
		expect(buildItemsParams(samples, state(), null, null, ['a']).filter).toBeUndefined();
	});

	it('uses each list\'s own primary key and combines with the other filters', () => {
		const ops = indexDefBySlug('operations')!;
		const p = buildItemsParams(ops, state({ q: 'x', filters: { team: 't1', project_id: 'p1' } }), null, null, ['o1']);
		const and = filterOf(p)._and as Record<string, unknown>[];
		expect(and).toContainEqual({ operation_id: { _in: ['o1'] } });
		expect(and).toContainEqual({ project_id: { _eq: 'p1' } });
		expect(and).toHaveLength(3); // + the search
		expect(buildItemsParams(indexDefBySlug('tests')!, state({ filters: { team: 't' } }), null, null, ['s1']).filter).toContain('session_id');
		expect(buildItemsParams(indexDefBySlug('campaigns')!, state({ filters: { team: 't' } }), null, null, ['c1']).filter).toContain('campaign_id');
	});

	it('round-trips through the URL as f.team', () => {
		const s = state({ filters: { team: 't1', project_id: 'p1' } });
		expect(queryFromState(s)).toEqual({ 'f.team': 't1', 'f.project_id': 'p1' });
		expect(stateFromQuery(queryFromState(s))).toEqual(s);
	});

	it('words the truncation note', () => {
		expect(teamTruncatedNote(500)).toBe("Showing the latest 500 of this team's records.");
	});
});

// ---- the page ---------------------------------------------------------------------------------------

const flush = async () => {
	for (let i = 0; i < 10; i++) await Promise.resolve();
	await nextTick();
};
const TEAMS = [{ team_id: 't1', name: 'Additive' }, { team_id: 't2', name: 'Beta' }];

function setup(query: Record<string, string>, records: (teamId: string) => Promise<{ ids: string[]; truncated: boolean }> | { ids: string[]; truncated: boolean }) {
	const calls: { path: string; params: Record<string, any> }[] = [];
	const api = {
		get: vi.fn(async (path: string, config?: { params?: Record<string, any> }) => {
			calls.push({ path, params: config?.params ?? {} });
			if (path === '/collections') return { data: { data: ['physical_samples', 'projects', 'materials'].map((c) => ({ collection: c, meta: { hidden: false } })) } };
			if (path === '/presets') return { data: { data: [] } };
			if (path === '/d1-teams') return { data: { teams: TEAMS } };
			const m = /^\/d1-teams\/([^/]+)\/records$/.exec(path);
			if (m) return { data: await records(decodeURIComponent(m[1])) };
			if (path === '/items/physical_samples') return { data: { data: [{ sample_id: 's1', sample_code: 'A-1' }], meta: { filter_count: 1 } } };
			if (path === '/items/projects') return { data: { data: [] } };
			if (path === '/items/materials') return { data: { data: [] } };
			throw new Error(`unexpected ${path}`);
		}),
	};
	const host = { api, navigate: vi.fn(), openDataStudio: vi.fn(), isAdmin: ref(false), adminKnown: ref(true), user: ref(null) } as unknown as ExplorerHost;
	const route = reactive<RouteLike>({ path: '/home/samples', query, params: { slug: 'samples' } });
	const pushed: Record<string, string>[] = [];
	const to = (t: { path: string; query: Record<string, string> }) => {
		pushed.push(t.query);
		route.query = t.query;
	};
	const router: RouterLike = { push: to, replace: to };
	return {
		host, route, router, pushed, calls,
		items: () => calls.filter((c) => c.path === '/items/physical_samples' && !c.params.groupBy),
		recordCalls: () => calls.filter((c) => c.path.endsWith('/records')),
	};
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('useIndexPage with the Team filter', () => {
	it('offers the teams as the chip\'s options', async () => {
		const t = setup({}, () => ({ ids: [], truncated: false }));
		const page = useIndexPage(t.host, samples, t.route, t.router);
		await flush();
		const chip = page.chips.value.find((c) => c.field === 'team')!;
		expect(chip).toMatchObject({ label: 'Team', flag: false, value: '', options: [{ value: 't1', label: 'Additive' }, { value: 't2', label: 'Beta' }] });
		expect(t.recordCalls()).toHaveLength(0); // no team chosen: no ids asked for, one plain list request
		expect(t.items()).toHaveLength(1);
		expect(t.items()[0].params.filter).toBeUndefined();
	});

	it('asks the endpoint for the team\'s ids first, then filters the rows to them', async () => {
		const t = setup({ 'f.team': 't1' }, () => ({ ids: ['s1', 's2'], truncated: false }));
		const page = useIndexPage(t.host, samples, t.route, t.router);
		await flush();
		expect(t.recordCalls()).toEqual([{ path: '/d1-teams/t1/records', params: { collection: 'physical_samples', limit: 500 } }]);
		expect(filterOf(t.items().at(-1)!.params)).toEqual({ _and: [{ sample_id: { _in: ['s1', 's2'] } }] });
		expect(page.teamNote.value).toBe('');
		expect(page.rows.value).toHaveLength(1);
	});

	it('a team with no readable records shows nothing, not every row', async () => {
		const t = setup({ 'f.team': 't1' }, () => ({ ids: [], truncated: false }));
		useIndexPage(t.host, samples, t.route, t.router);
		await flush();
		expect(filterOf(t.items().at(-1)!.params)).toEqual({ _and: [{ sample_id: { _in: [NO_MATCH_ID] } }] });
	});

	it('says so when only the latest 500 of a larger team are shown, and clears the note with the chip', async () => {
		const t = setup({ 'f.team': 't1' }, () => ({ ids: ['s1'], truncated: true }));
		const page = useIndexPage(t.host, samples, t.route, t.router);
		await flush();
		expect(page.teamNote.value).toBe("Showing the latest 500 of this team's records.");
		page.setFilter('team', '');
		await flush();
		expect(page.teamNote.value).toBe('');
	});

	it('choosing a team writes f.team to the URL and loads that team\'s ids', async () => {
		const t = setup({}, (id) => ({ ids: [`${id}-s`], truncated: false }));
		const page = useIndexPage(t.host, samples, t.route, t.router);
		await flush();
		page.setFilter('team', 't2');
		expect(t.pushed.at(-1)).toEqual({ 'f.team': 't2' });
		await flush();
		expect(filterOf(t.items().at(-1)!.params)).toEqual({ _and: [{ sample_id: { _in: ['t2-s'] } }] });
	});

	it('a failed ids request is an error, never the unfiltered list', async () => {
		const t = setup({ 'f.team': 't1' }, () => { throw Object.assign(new Error('x'), { response: { status: 500, data: { errors: [{ message: 'boom' }] } } }); });
		const page = useIndexPage(t.host, samples, t.route, t.router);
		await flush();
		expect(t.items()).toHaveLength(0);
		expect(page.rows.value).toEqual([]);
		expect(page.error.value).not.toBe('');
		expect(page.loading.value).toBe(false);
	});

	it('the latest choice wins: a slow answer for the team chosen before is dropped', async () => {
		let release!: () => void;
		const slow = new Promise<void>((r) => { release = r; });
		const t = setup({ 'f.team': 't1' }, async (id) => {
			if (id === 't1') await slow;
			return { ids: [`${id}-s`], truncated: id === 't1' };
		});
		const page = useIndexPage(t.host, samples, t.route, t.router);
		await flush();
		page.setFilter('team', 't2');
		await flush();
		release();
		await flush();
		expect(t.items()).toHaveLength(1);
		expect(filterOf(t.items()[0].params)).toEqual({ _and: [{ sample_id: { _in: ['t2-s'] } }] });
		expect(page.teamNote.value).toBe(''); // t1's truncated note did not land
	});
});
