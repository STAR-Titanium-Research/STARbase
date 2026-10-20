import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, reactive, ref } from 'vue';
import type { ExplorerHost } from '../host';
import { indexDefBySlug } from './indexConfig';
import { SEARCH_DEBOUNCE_MS, useIndexPage } from './useIndexPage';
import type { RouteLike, RouterLike } from './useIndexPage';

// The composable with a fake host (a recording API) and a fake route/router that applies what is
// pushed, the way vue-router would.
const samples = indexDefBySlug('samples')!;

const flush = async () => {
	for (let i = 0; i < 6; i++) await Promise.resolve();
	await nextTick();
};

interface Call { path: string; params: Record<string, any> }

function setup(
	query: Record<string, string>,
	opts: { bookmarks?: any[]; presets?: Record<string, any>; user?: { id: string; role?: string | null } | null; collections?: string[]; host?: ExplorerHost } = {},
) {
	const calls: Call[] = [];
	const api = {
		get: vi.fn(async (path: string, config?: { params?: Record<string, any> }) => {
			calls.push({ path, params: config?.params ?? {} });
			if (path === '/collections') {
				return { data: { data: (opts.collections ?? ['physical_samples', 'projects', 'materials']).map((c) => ({ collection: c, meta: { hidden: false } })) } };
			}
			if (path === '/presets') return { data: { data: opts.bookmarks ?? [] } };
			if (path.startsWith('/presets/')) {
				const id = path.slice('/presets/'.length);
				const hit = opts.presets?.[id] ?? opts.bookmarks?.find((b) => String(b.id) === id);
				if (!hit) throw { response: { status: 403 } };
				return { data: { data: hit } };
			}
			if (path === '/items/physical_samples') {
				if (config?.params?.groupBy) return { data: { data: [{ current_status: 'active' }, { current_status: 'archived' }] } };
				return { data: { data: [{ sample_id: 's1', sample_code: 'A-1' }], meta: { filter_count: 120 } } };
			}
			if (path === '/items/projects') return { data: { data: [{ project_id: 'p1', project_code: 'STAR-01' }] } };
			if (path === '/items/materials') return { data: { data: [{ material_id: 'm1', alloy_code: 'Ti64' }] } };
			throw new Error(`unexpected ${path}`);
		}),
	};
	const host = opts.host ?? ({ api, navigate: vi.fn(), openDataStudio: vi.fn(), isAdmin: ref(false), adminKnown: ref(true), user: ref(opts.user ?? null) } as unknown as ExplorerHost);
	const route = reactive<RouteLike>({ path: '/home/samples', query, params: { slug: 'samples' } });
	const pushed: Array<{ how: string; query: Record<string, string> }> = [];
	const apply = (how: string) => (to: { path: string; query: Record<string, string> }) => {
		pushed.push({ how, query: to.query });
		route.query = to.query;
	};
	const router: RouterLike = { push: apply('push'), replace: apply('replace') };
	return { host, route, router, calls, pushed, items: () => calls.filter((c) => c.path === '/items/physical_samples' && !c.params.groupBy) };
}

const bm = (over: Record<string, any> = {}) => ({
	id: 7, bookmark: 'Mine', collection: 'physical_samples', user: null, role: null, filter: { owner: { _eq: '$CURRENT_USER' } }, search: null, layout_query: null, ...over,
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('useIndexPage', () => {
	it('loads the page from the URL and reads the total from filter_count', async () => {
		const t = setup({ page: '2' });
		const page = useIndexPage(t.host, samples, t.route, t.router);
		await flush();
		expect(t.items()).toHaveLength(1);
		expect(t.items()[0].params.page).toBe(2);
		expect(page.total.value).toBe(120);
		expect(page.rows.value).toHaveLength(1);
		expect(page.loading.value).toBe(false);
	});

	it('fills the search from a saved view when the URL has no q, and sends it', async () => {
		const t = setup({ bookmark: '7' }, { bookmarks: [bm({ search: 'ti64' })] });
		const page = useIndexPage(t.host, samples, t.route, t.router);
		await flush();
		expect(page.state.value.q).toBe('ti64');
		expect(page.searchText.value).toBe('ti64');
		const filter = JSON.parse(t.items().at(-1)!.params.filter);
		expect(JSON.stringify(filter)).toContain('ti64');
	});

	it('opens a saved view in the Data Studio with its own search, but not an extra one', async () => {
		const t = setup({ bookmark: '7' }, { bookmarks: [bm({ search: 'ti64' })] });
		const page = useIndexPage(t.host, samples, t.route, t.router);
		await flush();
		expect(page.dsLink.value).toEqual({ to: '/content/physical_samples?bookmark=7', note: null });
		t.route.query = { bookmark: '7', q: 'other' };
		await flush();
		expect(page.dsLink.value.to).toBe('/content/physical_samples');
		expect(page.dsLink.value.note).not.toBeNull();
	});

	it('keeps an emptied search empty over such a saved view', async () => {
		const t = setup({ bookmark: '7' }, { bookmarks: [bm({ search: 'ti64' })] });
		const page = useIndexPage(t.host, samples, t.route, t.router);
		await flush();
		page.setSearch('');
		vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
		await flush();
		expect(t.route.query).toEqual({ bookmark: '7', q: '' });
		expect(page.state.value.q).toBe('');
		expect(JSON.stringify(JSON.parse(t.items().at(-1)!.params.filter))).not.toContain('ti64');
	});

	it('writes typing with replace after 250 ms, once, and clicks with push', async () => {
		const t = setup({});
		const page = useIndexPage(t.host, samples, t.route, t.router);
		await flush();
		page.setSearch('t');
		page.setSearch('ti');
		page.setSearch('ti6');
		vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1);
		expect(t.pushed).toHaveLength(0);
		vi.advanceTimersByTime(1);
		expect(t.pushed).toEqual([{ how: 'replace', query: { q: 'ti6' } }]);
		page.setFilter('current_status', 'active');
		expect(t.pushed.at(-1)).toEqual({ how: 'push', query: { q: 'ti6', 'f.current_status': 'active' } });
		page.setSort('sample_code');
		expect(t.pushed.at(-1)!.query.sort).toBe('sample_code');
		page.setPage(3);
		expect(t.pushed.at(-1)!.query.page).toBe('3');
	});

	it('starts again from page 1 when the search, a chip or the sort changes', async () => {
		const t = setup({ page: '4' });
		const page = useIndexPage(t.host, samples, t.route, t.router);
		await flush();
		page.setFilter('current_status', 'active');
		expect(t.pushed.at(-1)!.query.page).toBeUndefined();
	});

	it('toggles the header sort from the default, ascending first', async () => {
		const t = setup({});
		const page = useIndexPage(t.host, samples, t.route, t.router);
		await flush();
		expect(page.sort.value).toBe('-created_at');
		page.setSort('sample_code');
		await flush();
		page.setSort('sample_code');
		expect(t.pushed.at(-1)!.query.sort).toBe('-sample_code');
	});

	it('says so when the saved view in the URL cannot be read, and loads the list without it', async () => {
		const t = setup({ bookmark: '9' });
		const page = useIndexPage(t.host, samples, t.route, t.router);
		await flush();
		expect(page.bookmarkUnavailable.value).toBe(true);
		expect(page.rows.value).toHaveLength(1);
		expect(t.items().at(-1)!.params.filter).toBeUndefined();
	});

	it('rejects a saved view of another collection', async () => {
		const t = setup({ bookmark: '9' }, { presets: { 9: bm({ id: 9, collection: 'campaigns' }) } });
		const page = useIndexPage(t.host, samples, t.route, t.router);
		await flush();
		expect(page.bookmarkUnavailable.value).toBe(true);
	});

	it('does not apply another user private saved view fetched by id', async () => {
		const t = setup({ bookmark: '9' }, { user: { id: 'u1', role: 'r1' }, presets: { 9: bm({ id: 9, user: 'u2', filter: { owner: { _eq: 'x' } } }) } });
		const page = useIndexPage(t.host, samples, t.route, t.router);
		await flush();
		expect(page.bookmarkUnavailable.value).toBe(true);
		expect(t.items().at(-1)!.params.filter).toBeUndefined();
	});

	it('applies the signed-in user own view and a global one fetched by id', async () => {
		const own = setup({ bookmark: '9' }, { user: { id: 'u1', role: 'r1' }, presets: { 9: bm({ id: 9, user: 'u1', filter: { owner: { _eq: 'x' } } }) } });
		const p1 = useIndexPage(own.host, samples, own.route, own.router);
		await flush();
		expect(p1.bookmarkUnavailable.value).toBe(false);
		expect(own.items().at(-1)!.params.filter).toContain('owner');
		const global = setup({ bookmark: '9' }, { user: { id: 'u1', role: 'r1' }, presets: { 9: bm({ id: 9, filter: { owner: { _eq: 'y' } } }) } });
		const p2 = useIndexPage(global.host, samples, global.route, global.router);
		await flush();
		expect(p2.bookmarkUnavailable.value).toBe(false);
	});

	it('judges a private view again once the signed-in user is known', async () => {
		const t = setup({ bookmark: '9' }, { presets: { 9: bm({ id: 9, user: 'u1', filter: { owner: { _eq: 'x' } } }) } });
		const page = useIndexPage(t.host, samples, t.route, t.router);
		await flush();
		// the user is not known yet: nothing but a global view can be judged
		expect(page.bookmarkUnavailable.value).toBe(true);
		(t.host.user as any).value = { id: 'u1', role: 'r1' };
		await flush();
		await flush();
		expect(page.bookmarkUnavailable.value).toBe(false);
		expect(t.items().at(-1)!.params.filter).toContain('owner');
	});

	it('ignores a ?sort= the page does not offer', async () => {
		const t = setup({ sort: 'password' });
		const page = useIndexPage(t.host, samples, t.route, t.router);
		await flush();
		expect(page.sort.value).toBe('-created_at');
		expect(t.items().at(-1)!.params.sort).toEqual(['-created_at']);
		const ok = setup({ sort: '-nickname' });
		useIndexPage(ok.host, samples, ok.route, ok.router);
		await flush();
		expect(ok.items().at(-1)!.params.sort).toEqual(['-nickname']);
	});

	it('does not ask for a relation display of a collection the user cannot read', async () => {
		const t = setup({}, { collections: ['physical_samples', 'materials'] });
		useIndexPage(t.host, samples, t.route, t.router);
		await flush();
		const fields = t.items().at(-1)!.params.fields as string[];
		expect(fields).toContain('material_id.alloy_code');
		expect(fields).toContain('project_id');
		expect(fields).not.toContain('project_id.project_code');
	});

	it('loads the chip options once per session, not once per page', async () => {
		const a = setup({});
		useIndexPage(a.host, samples, a.route, a.router);
		await flush();
		await flush();
		const asked = (t: ReturnType<typeof setup>) => t.calls.filter((c) => c.path === '/items/projects' || (c.path === '/items/physical_samples' && c.params.groupBy)).length;
		expect(asked(a)).toBe(2);
		// a second page on the same host: the options come from the cache
		const b = setup({}, { host: a.host });
		const page = useIndexPage(b.host, samples, b.route, b.router);
		await flush();
		await flush();
		expect(asked(a)).toBe(2); // b shares a's host and recording API: no new option requests
		expect(page.chips.value.find((c) => c.field === 'project_id')!.options).toEqual([{ value: 'p1', label: 'STAR-01' }]);
	});

	it('offers a relation chip only for a visible collection, and loads enum values', async () => {
		const t = setup({});
		const page = useIndexPage(t.host, samples, t.route, t.router);
		await flush();
		await flush();
		const fields = page.chips.value.map((c) => c.field);
		// project and material are visible; status is an enum
		expect(fields).toEqual(['project_id', 'current_status', 'material_id', 'no_owner']);
		expect(page.chips.value.find((c) => c.field === 'current_status')!.options.map((o) => o.value)).toEqual(['active', 'archived']);
		expect(page.chips.value.find((c) => c.field === 'project_id')!.options).toEqual([{ value: 'p1', label: 'STAR-01' }]);
	});

	it('shows the not-visible state on a 403', async () => {
		const t = setup({});
		t.host.api.get = vi.fn(async (path: string) => {
			if (path.startsWith('/items/')) throw { response: { status: 403 } };
			return { data: { data: [] } };
		});
		const page = useIndexPage(t.host, samples, t.route, t.router);
		await flush();
		expect(page.forbidden.value).toBe(true);
		expect(page.error.value).toBe('');
	});

	it('does not reload when only the drawer key changes, and ignores a route to another page', async () => {
		const t = setup({});
		useIndexPage(t.host, samples, t.route, t.router);
		await flush();
		const before = t.items().length;
		t.route.query = { open: 'abc' };
		await flush();
		expect(t.items()).toHaveLength(before);
		t.route.params = { slug: 'tools' };
		t.route.query = { q: 'x' };
		await flush();
		expect(t.items()).toHaveLength(before);
	});

	it('drops a slow response that a newer request has replaced', async () => {
		const t = setup({});
		const original = (t.host.api.get as any).getMockImplementation() as (p: string, c?: any) => Promise<any>;
		const held: Array<{ page: number; release: () => void }> = [];
		(t.host.api.get as any).mockImplementation((path: string, config?: any) => {
			if (path !== '/items/physical_samples' || config?.params?.groupBy) return original(path, config);
			const page = config.params.page as number;
			return new Promise((resolve) => {
				held.push({
					page,
					release: () => resolve({ data: { data: [{ sample_id: `s${page}`, sample_code: `PAGE-${page}` }], meta: { filter_count: 120 } } }),
				});
			});
		});
		const page = useIndexPage(t.host, samples, t.route, t.router);
		await flush();
		page.setPage(2);
		await flush();
		expect(held.map((h) => h.page)).toEqual([1, 2]);
		held[1].release();
		await flush();
		held[0].release(); // the first, slower answer arrives last
		await flush();
		expect(page.rows.value).toEqual([{ sample_id: 's2', sample_code: 'PAGE-2' }]);
		expect(page.loading.value).toBe(false);
	});

	it('closeOpen removes ?open with replace and keeps the rest of the view', async () => {
		const t = setup({ q: 'ti', page: '2', open: 's1' });
		const page = useIndexPage(t.host, samples, t.route, t.router);
		await flush();
		page.closeOpen();
		expect(t.pushed.at(-1)).toEqual({ how: 'replace', query: { q: 'ti', page: '2' } });
		const n = t.pushed.length;
		page.closeOpen(); // nothing open any more
		expect(t.pushed).toHaveLength(n);
	});

	it('"Clear filters" clears search and chips but keeps the saved view', async () => {
		const t = setup({ bookmark: '7', q: 'ti', 'f.current_status': 'active', page: '3' }, { bookmarks: [bm()] });
		const page = useIndexPage(t.host, samples, t.route, t.router);
		await flush();
		expect(page.hasFilters.value).toBe(true);
		page.clearFilters();
		expect(t.pushed.at(-1)).toEqual({ how: 'push', query: { bookmark: '7' } });
		await flush();
		expect(page.state.value.bookmark).toBe(7);
		expect(page.hasFilters.value).toBe(false);
	});

	it('keeps a saved view\'s own search cleared by "Clear filters"', async () => {
		const t = setup({ bookmark: '7' }, { bookmarks: [bm({ search: 'ti64' })] });
		const page = useIndexPage(t.host, samples, t.route, t.router);
		await flush();
		page.clearFilters();
		expect(t.pushed.at(-1)!.query).toEqual({ bookmark: '7', q: '' });
	});

	it('with no search or chip left, "Clear filters" drops the saved view too', async () => {
		const t = setup({ bookmark: '7', page: '2' }, { bookmarks: [bm()] });
		const page = useIndexPage(t.host, samples, t.route, t.router);
		await flush();
		expect(page.hasFilters.value).toBe(false);
		page.clearFilters();
		expect(t.pushed.at(-1)!.query).toEqual({});
	});

	it('a click drops typing that has not reached the URL, so it cannot overwrite the click', async () => {
		const t = setup({});
		const page = useIndexPage(t.host, samples, t.route, t.router);
		await flush();
		page.setSearch('ti6');
		page.setSort('sample_code');
		const after = t.pushed.length;
		vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 2);
		expect(t.pushed).toHaveLength(after); // no late replace
		expect(t.route.query).toEqual({ sort: 'sample_code' });
		expect(page.searchText.value).toBe('');
	});

	it('the other clicks drop pending typing too', async () => {
		for (const click of [
			(p: ReturnType<typeof useIndexPage>) => p.setBookmark(7),
			(p: ReturnType<typeof useIndexPage>) => p.setFilter('current_status', 'active'),
			(p: ReturnType<typeof useIndexPage>) => p.setPage(2),
			(p: ReturnType<typeof useIndexPage>) => p.clearFilters(),
		]) {
			const t = setup({}, { bookmarks: [bm()] });
			const page = useIndexPage(t.host, samples, t.route, t.router);
			await flush();
			page.setSearch('zzz');
			click(page);
			const after = t.pushed.length;
			vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 2);
			expect(t.pushed).toHaveLength(after);
			expect(t.route.query.q).toBeUndefined();
		}
	});
});

describe('useIndexPage plots (the Force / FAST buttons)', () => {
	const operations = indexDefBySlug('operations')!;
	// `rowsFor(page)`: the operation ids the list returns for a page (default: o1 and o2, whatever the page).
	// A handler may return a promise, to answer a plot request late.
	function opsSetup(handlers: Record<string, () => unknown>, rowsFor: (page: number) => string[] = () => ['o1', 'o2']) {
		const calls: Call[] = [];
		const api = {
			get: vi.fn(async (path: string, config?: { params?: Record<string, any> }) => {
				calls.push({ path, params: config?.params ?? {} });
				if (path === '/collections') return { data: { data: ['manufacturing_operations', 'projects'].map((c) => ({ collection: c, meta: { hidden: false } })) } };
				if (path === '/presets') return { data: { data: [] } };
				if (path === '/items/manufacturing_operations') {
					const ids = rowsFor(Number(config?.params?.page ?? 1));
					return { data: { data: ids.map((operation_id) => ({ operation_id })), meta: { filter_count: 200 } } };
				}
				const h = handlers[path];
				if (h) return { data: { data: await h() } };
				throw { response: { status: 403 } };
			}),
		};
		const host = { api, navigate: vi.fn(), openDataStudio: vi.fn(), isAdmin: ref(false), adminKnown: ref(true), user: ref(null) } as unknown as ExplorerHost;
		const route = reactive<RouteLike>({ path: '/home/operations', query: {}, params: { slug: 'operations' } });
		const router: RouterLike = { push: () => undefined, replace: () => undefined };
		return { host, route, router, calls };
	}

	it('asks once per kind for the rows on screen and exposes what came back by row key', async () => {
		const t = opsSetup({
			'/items/machining_force_analysis': () => [{ operation_id: 'o1', frm_fz: 'f1' }],
			'/items/fast_run_data': () => [{ operation_id: 'o2' }],
		});
		const page = useIndexPage(t.host, operations, t.route, t.router);
		await flush();
		await flush();
		const force = t.calls.filter((c) => c.path === '/items/machining_force_analysis');
		const fast = t.calls.filter((c) => c.path === '/items/fast_run_data');
		expect(force).toHaveLength(1);
		expect(fast).toHaveLength(1);
		expect(JSON.parse(force[0].params.filter)._and[0]).toEqual({ operation_id: { _in: ['o1', 'o2'] } });
		expect(page.plots.value).toEqual({
			o1: { force: true, fast: false, frmFz: 'f1' },
			o2: { force: false, fast: true, frmFz: null },
		});
	});

	it('a failed plot request shows no buttons of that kind and never errors the list', async () => {
		const t = opsSetup({ '/items/fast_run_data': () => [{ operation_id: 'o2' }] }); // force answers 403
		const page = useIndexPage(t.host, operations, t.route, t.router);
		await flush();
		await flush();
		expect(page.error.value).toBe('');
		expect(page.forbidden.value).toBe(false);
		expect(page.rows.value).toHaveLength(2);
		expect(page.plots.value.o1).toEqual({ force: false, fast: false, frmFz: null });
		expect(page.plots.value.o2.fast).toBe(true);
	});

	// A request the test answers by hand.
	const deferred = <T,>() => {
		let resolve!: (v: T) => void;
		const promise = new Promise<T>((r) => { resolve = r; });
		return { promise, resolve };
	};

	it('drops a slow plots answer that arrives after the user moved to another page', async () => {
		const slow = deferred<unknown[]>();
		let forceCalls = 0;
		const t = opsSetup(
			{
				'/items/machining_force_analysis': () => (++forceCalls === 1 ? slow.promise : [{ operation_id: 'o3', frm_fz: 'new' }]),
				'/items/fast_run_data': () => [],
			},
			(page) => (page === 1 ? ['o1', 'o2'] : ['o3']),
		);
		const page = useIndexPage(t.host, operations, t.route, t.router);
		await flush();
		t.route.query = { page: '2' };
		await flush();
		await flush();
		expect(page.rows.value.map(page.rowKey)).toEqual(['o3']);
		expect(page.plots.value).toEqual({ o3: { force: true, fast: false, frmFz: 'new' } });
		// Page 1's answer comes in last and must not touch page 2's buttons.
		slow.resolve([{ operation_id: 'o1', frm_fz: 'old' }]);
		await flush();
		await flush();
		expect(Object.keys(page.plots.value)).toEqual(['o3']);
		expect(page.plots.value.o3.frmFz).toBe('new');
	});

	it('clears the buttons on a reload and fills them again when the answers arrive', async () => {
		const second = deferred<unknown[]>();
		let forceCalls = 0;
		const t = opsSetup({
			'/items/machining_force_analysis': () => (++forceCalls === 1 ? [{ operation_id: 'o1', frm_fz: 'f1' }] : second.promise),
			'/items/fast_run_data': () => [],
		});
		const page = useIndexPage(t.host, operations, t.route, t.router);
		await flush();
		await flush();
		expect(page.plots.value.o1.force).toBe(true);
		const reloaded = page.reload();
		await flush();
		await reloaded;
		expect(page.plots.value).toEqual({}); // no stale buttons against the new rows
		second.resolve([{ operation_id: 'o2', frm_fz: 'f2' }]);
		await flush();
		await flush();
		expect(page.plots.value.o1.force).toBe(false);
		expect(page.plots.value.o2).toEqual({ force: true, fast: false, frmFz: 'f2' });
	});

	it('a samples page asks once for the force rows of its samples and counts distinct operations', async () => {
		const t = setup({});
		const get = t.host.api.get as any;
		const base = get.getMockImplementation() as (path: string, config?: any) => Promise<any>;
		get.mockImplementation(async (path: string, config?: any) => {
			if (path === '/items/machining_force_analysis') {
				t.calls.push({ path, params: config?.params ?? {} });
				return {
					data: {
						data: [
							{ operation_id: { operation_id: 'o1', sample_id: 's1' } },
							{ operation_id: { operation_id: 'o1', sample_id: 's1' } },
							{ operation_id: { operation_id: 'o2', sample_id: 's1' } },
						],
					},
				};
			}
			return base(path, config);
		});
		const page = useIndexPage(t.host, samples, t.route, t.router);
		await flush();
		await flush();
		const asked = t.calls.filter((c) => c.path === '/items/machining_force_analysis');
		expect(asked).toHaveLength(1);
		expect(JSON.parse(asked[0].params.filter)._and[1]).toEqual({ operation_id: { sample_id: { _in: ['s1'] } } });
		expect(page.plots.value.s1).toEqual({ force: true, fast: false, frmFz: null, forceCount: 2 });
		expect(t.calls.filter((c) => c.path === '/items/fast_run_data')).toHaveLength(0);
	});

	// The flag chip's view model (it is a toggle, not a select): shown without waiting for any options
	// request, and on once its URL value is set.
	it('the "With force data" chip is a flag: no options request, on after setFilter', async () => {
		const t = opsSetup({}, () => ['o1']);
		const route = t.route;
		const router: RouterLike = {
			push: (to) => { route.query = to.query; },
			replace: (to) => { route.query = to.query; },
		};
		const page = useIndexPage(t.host, operations, route, router);
		await flush();
		const hasForce = () => page.chips.value.find((c) => c.field === 'has_force');
		expect(hasForce()).toEqual({ field: 'has_force', label: 'With force data', flag: true, options: [], value: '' });
		expect(page.chips.value.at(-1)).toMatchObject({ field: 'no_owner', flag: true, options: [] });
		page.setFilter('has_force', 'true');
		await flush();
		expect(hasForce()?.value).toBe('true');
		const asked = (t.host.api.get as any).mock.calls.map((c: any[]) => c[0] as string);
		// Options are loaded for the enum and relation chips only, never for a flag.
		expect(asked.filter((p: string) => p === '/items/projects' || p === '/items/manufacturing_methods')).not.toHaveLength(0);
		expect(asked.some((p: string) => p.includes('force_analyses') || p.includes('no_owner'))).toBe(false);
	});
});

describe('useIndexPage, the view settings', () => {
	const view = (pageSize = 50, groupBy: string | null = null) => ({ pageSize: ref(pageSize), groupBy: ref<string | null>(groupBy) });

	it('asks for the chosen number of rows', async () => {
		const t = setup({ page: '2' });
		useIndexPage(t.host, samples, t.route, t.router, view(25));
		await flush();
		expect(t.items()[0].params).toMatchObject({ limit: 25, page: 2 });
	});

	it('goes back to page 1 and reloads when the page size changes on a later page', async () => {
		const t = setup({ page: '3' });
		const v = view(50);
		useIndexPage(t.host, samples, t.route, t.router, v);
		await flush();
		v.pageSize.value = 100;
		await flush();
		expect(t.route.query).toEqual({});
		expect(t.items().at(-1)!.params).toMatchObject({ limit: 100, page: 1 });
	});

	it('reloads on page 1 when the page size changes there, without touching the URL', async () => {
		const t = setup({});
		const v = view(50);
		useIndexPage(t.host, samples, t.route, t.router, v);
		await flush();
		const before = t.items().length;
		v.pageSize.value = 25;
		await flush();
		expect(t.items()).toHaveLength(before + 1);
		expect(t.items().at(-1)!.params.limit).toBe(25);
		expect(t.pushed).toEqual([]);
	});

	it('sorts by the group field first, and keeps the URL sort after it', async () => {
		const t = setup({ sort: 'nickname' });
		const v = view(50, 'current_status');
		const page = useIndexPage(t.host, samples, t.route, t.router, v);
		await flush();
		expect(t.items()[0].params.sort).toEqual(['current_status', 'nickname']);
		expect(page.activeGroup.value).toBe('current_status');
		v.groupBy.value = null;
		await flush();
		expect(t.items().at(-1)!.params.sort).toEqual(['nickname']);
	});

	it('does not group by a relation whose collection the user cannot read', async () => {
		const t = setup({}, { collections: ['physical_samples'] });
		const page = useIndexPage(t.host, samples, t.route, t.router, view(50, 'project_id'));
		await flush();
		expect(page.groups.value.map((g) => g.value)).toEqual(['current_status']);
		expect(page.activeGroup.value).toBeNull();
		expect(t.items()[0].params.sort).toEqual(['-created_at']);
	});
});
