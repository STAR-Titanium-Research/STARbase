// The state of one index page: the URL is the single source of truth (bookmark, q, chips, sort,
// page, open), the rows and chip options are loaded from it, and every change writes the URL back.
// Typing in the search box replaces the URL (debounced), clicks push a history entry, so reload and
// Back reproduce the view. Host-neutral: the API, navigation and route come in as arguments.
import { computed, getCurrentInstance, onBeforeUnmount, ref, watch } from 'vue';
import { choiceKindFor } from '../choiceLabels';
import type { ExplorerHost } from '../host';
import { errorText, isForbidden } from '../format';
import { useRequestGate } from '../composables/useRequestGate';
import { useExplorerNav } from '../nav/useExplorerNav';
import { bookmarkVisibleToUser } from '../nav/navConfig';
import type { Bookmark } from '../nav/navConfig';
import type { IndexDef } from './indexConfig';
import { mergePlots, plotRequests } from './plotData';
import type { PlotKey, RowPlots } from './plotData';
import { bookmarkSort, buildItemsParams, dataStudioLink, stateFromQuery } from './indexQuery';
import type { IndexState } from './indexQuery';
import {
	BOOL_OPTIONS, effectiveState, enumOptionParams, enumOptions, extraFields, hasActiveFilters, hasExplicitQ, nextSort,
	queryForState, relationKey, relationOptionParams, relationOptions, validSort, withChange, withSelected,
} from './indexView';
import type { ChipOption } from './indexView';

// The two things the composable needs of vue-router, so it does not depend on its route types.
export interface RouteLike {
	path: string;
	query: Record<string, any>;
	params: Record<string, any>;
}
export interface RouterLike {
	push(to: { path: string; query: Record<string, string> }): unknown;
	replace(to: { path: string; query: Record<string, string> }): unknown;
}

export const SEARCH_DEBOUNCE_MS = 250;
const BOOKMARK_FIELDS = 'id,bookmark,collection,user,role,filter,search,layout_query,icon';

export interface ChipView {
	field: string;
	label: string;
	/** A yes / off toggle rather than a select. */
	flag: boolean;
	options: ChipOption[];
	value: string;
}

// Chip options per signed-in session, keyed by the collection and field the list came from. One
// cache per host (a host is built per user), and it is emptied if the host's user turns out to be a
// different one from the user it was filled for. A failed request is not cached.
const chipCaches = new WeakMap<ExplorerHost, { userId: string | null; map: Map<string, ChipOption[]> }>();
export function chipCacheFor(host: ExplorerHost): Map<string, ChipOption[]> {
	const id = host.user.value?.id ?? null;
	let entry = chipCaches.get(host);
	if (!entry || (entry.userId && id && entry.userId !== id)) chipCaches.set(host, (entry = { userId: id, map: new Map() }));
	else if (!entry.userId) entry.userId = id;
	return entry.map;
}

export function useIndexPage(host: ExplorerHost, def: IndexDef, route: RouteLike, router: RouterLike) {
	const { nav, visible, loading: navLoading, error: navError } = useExplorerNav(host);
	const gate = useRequestGate();
	let timer: ReturnType<typeof setTimeout> | null = null;

	const rows = ref<Record<string, unknown>[]>([]);
	const total = ref<number | null>(null);
	// Force / FAST data per row key (operations, samples), from a second round of requests after the page loads.
	const plots = ref<Record<string, RowPlots>>({});
	const loading = ref(true);
	const error = ref('');
	const forbidden = ref(false);
	// The URL named a saved view that could not be read (or is not this collection's).
	const settledBookmark = ref<number | null>(null);

	// ---- state from the URL -------------------------------------------------------------------
	// Which related collections the user may read (see useExplorerNav). With the list of readable
	// collections unavailable, a relation chip or sort is tried (a 403 on its options drops the
	// chip); otherwise only a visible collection's is offered.
	const collectionOffered = (collection: string) => navError.value || (visible.value?.has(collection) ?? false);

	const raw = computed(() => stateFromQuery(route.query));
	const qExplicit = computed(() => hasExplicitQ(route.query));

	// This collection's saved views, from the cached sidebar list; one that is not in it (the list
	// is still loading, or the view is unreadable) is fetched by id.
	const bookmarks = computed<Bookmark[]>(() =>
		nav.value.groups.flatMap((g) => g.links).filter((l) => l.collection === def.collection).flatMap((l) => l.bookmarks),
	);
	const fetched = ref<Record<number, Bookmark | null>>({});
	const bookmarkById = (id: number | null): Bookmark | null =>
		id === null ? null : (bookmarks.value.find((b) => b.id === id) ?? fetched.value[id] ?? null);
	const bookmark = computed(() => bookmarkById(raw.value.bookmark));

	// A saved view's own search fills the box when the URL carries no q. A ?sort= the page does not
	// offer is dropped (see validSort), so a hand-edited URL falls back to the default order.
	const state = computed<IndexState>(() => {
		const s = effectiveState(raw.value, qExplicit.value, bookmark.value);
		const sort = validSort(def, s.sort, bookmark.value, (c) => !c.relation || collectionOffered(c.relation.collection));
		return sort === s.sort ? s : { ...s, sort };
	});
	const bookmarkUnavailable = computed(() => settledBookmark.value !== null && settledBookmark.value === raw.value.bookmark && !bookmark.value);
	const sort = computed(() => state.value.sort ?? bookmarkSort(bookmark.value) ?? def.defaultSort);

	async function ensureBookmark(id: number | null): Promise<boolean> {
		if (id === null || bookmarkById(id)) return true;
		if (id in fetched.value) return false;
		let found: Bookmark | null = null;
		try {
			const res = await host.api.get(`/presets/${id}`, { params: { fields: BOOKMARK_FIELDS } });
			const b = res.data?.data as Bookmark | undefined;
			found = b && b.bookmark && b.collection === def.collection ? b : null;
		} catch {
			found = null;
		}
		// An admin can read anyone's preset by id, so the sidebar's rule applies here too: someone
		// else's private view (or another role's) is "not available", not applied. While who is
		// signed in is unknown only a global view can be told apart, and that verdict is not cached:
		// it is asked again once the user is known (see the watch below).
		const me = host.user.value;
		if (found && !bookmarkVisibleToUser(found, me)) {
			if (!me) return false;
			found = null;
		}
		fetched.value = { ...fetched.value, [id]: found };
		return found !== null;
	}

	// ---- the rows -----------------------------------------------------------------------------
	function navSettled(): Promise<void> {
		if (!navLoading.value) return Promise.resolve();
		return new Promise((resolve) => {
			const stop = watch(navLoading, (now) => {
				if (!now) {
					stop();
					resolve();
				}
			});
		});
	}

	async function load(): Promise<void> {
		const token = gate.begin();
		loading.value = true;
		error.value = '';
		forbidden.value = false;
		// The relation columns depend on which collections the user can read: wait for that answer
		// (once per session, shared with the sidebar) instead of asking for a field it refuses.
		await navSettled();
		const id = raw.value.bookmark;
		const ok = await ensureBookmark(id);
		if (!gate.isCurrent(token)) return;
		settledBookmark.value = ok ? null : id;

		const params = buildItemsParams(def, state.value, bookmark.value, visible.value);
		params.fields = [...(params.fields as string[]), ...extraFields(def, visible.value).filter((f) => !(params.fields as string[]).includes(f))];
		try {
			const res = await host.api.get(`/items/${def.collection}`, { params });
			if (!gate.isCurrent(token)) return;
			rows.value = res.data?.data ?? [];
			plots.value = {};
			const count = Number(res.data?.meta?.filter_count);
			total.value = Number.isFinite(count) ? count : rows.value.length;
		} catch (e) {
			if (!gate.isCurrent(token)) return;
			rows.value = [];
			plots.value = {};
			total.value = null;
			if (isForbidden(e)) forbidden.value = true;
			else error.value = errorText(e, 'Could not load the list');
		} finally {
			if (gate.isCurrent(token)) loading.value = false;
		}
		void loadPlots(token);
	}

	// The Force / FAST buttons: one request per kind for the rows on screen, after the list is shown.
	// These collections are hidden ones the page's readable list does not hold, so each request stands
	// alone and fails soft (null: no buttons of that kind). A newer load drops a slow answer.
	async function loadPlots(token: number): Promise<void> {
		if (!gate.isCurrent(token) || !rows.value.length) return;
		const ids = rows.value.map(rowKey);
		const requests = plotRequests(def.collection, ids);
		if (!requests.length) return;
		const answers = await Promise.all(
			requests.map(async (r) => {
				try {
					const res = await host.api.get(r.path, { params: r.params });
					const data = res.data?.data;
					return [r.key, Array.isArray(data) ? data : null] as const;
				} catch {
					return [r.key, null] as const;
				}
			}),
		);
		if (!gate.isCurrent(token)) return;
		plots.value = mergePlots(def.collection, ids, Object.fromEntries(answers) as Partial<Record<PlotKey, unknown[] | null>>);
	}

	// The signed-in user arrives after the first load: a saved view that could not be judged without
	// it is looked at again.
	watch(
		() => host.user.value?.id,
		(id) => {
			if (id && settledBookmark.value !== null) void load();
		},
	);

	// A change of the opened drawer's key alone (?open) does not reload the list.
	const queryKey = computed(() => JSON.stringify({ ...route.query, open: undefined }));
	watch(queryKey, () => {
		// While the route moves to another page this instance is about to be replaced: do not
		// send its request with the other page's query.
		if (route.params.slug !== def.slug) return;
		void load();
	});
	void load();
	// (Not in a component only under test, where there is nothing to unmount.)
	if (getCurrentInstance()) {
		onBeforeUnmount(() => {
			gate.cancel();
			if (timer) clearTimeout(timer);
		});
	}

	// ---- writing the URL ----------------------------------------------------------------------
	// A click (a saved view, a chip, a sort, a page, clear) supersedes typing that has not reached the
	// URL yet: its pending write is dropped, so it cannot land after the click and overwrite the
	// click's URL. The box then shows what the URL says.
	function dropPendingSearch(): void {
		if (!timer) return;
		clearTimeout(timer);
		timer = null;
		searchText.value = state.value.q;
	}

	function go(patch: Partial<IndexState>, opts: { replace?: boolean; qExplicit?: boolean; keepTyping?: boolean } = {}): void {
		if (!opts.keepTyping) dropPendingSearch();
		const next = withChange(raw.value, patch);
		const query = queryForState(next, bookmarkById(next.bookmark), opts.qExplicit ?? qExplicit.value);
		const to = { path: route.path, query };
		void (opts.replace ? router.replace(to) : router.push(to));
	}

	// The search box. `searchText` is what is typed; the URL follows 250 ms after the last key.
	const searchText = ref(state.value.q);
	function setSearch(text: string): void {
		searchText.value = text;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = null;
			go({ q: text }, { replace: true, qExplicit: true });
		}, SEARCH_DEBOUNCE_MS);
	}
	// Back, a link or a cleared filter changes the URL's search: the box follows unless typing.
	watch(
		() => state.value.q,
		(q) => {
			if (!timer && q !== searchText.value) searchText.value = q;
		},
	);

	const setBookmark = (id: number | null) => go({ bookmark: id, q: '', filters: {}, sort: null }, { qExplicit: false });
	function setFilter(field: string, value: string): void {
		const filters = { ...raw.value.filters };
		if (value) filters[field] = value;
		else delete filters[field];
		go({ filters });
	}
	const setSort = (key: string) => go({ sort: nextSort(sort.value, key) });
	// The cards toolbar's select names the sort outright (a header click toggles).
	const setSortTo = (value: string) => go({ sort: value });
	const setPage = (page: number) => go({ page: Math.max(1, page) });
	// "Clear filters": the search and the chips go, the saved view stays (it is a choice of its own,
	// with its own x). With no search or chip left to clear, it drops the saved view too, so the
	// button always gets you somewhere (the empty state's).
	function clearFilters(): void {
		if (hasActiveFilters(state.value)) go({ q: '', filters: {}, page: 1 }, { qExplicit: true });
		else go({ bookmark: null, q: '', filters: {}, page: 1 }, { qExplicit: false });
	}
	// The drawer's ?open goes when it closes; the rest of the view stays.
	function closeOpen(): void {
		if (raw.value.open === null) return;
		go({ open: null, page: raw.value.page }, { replace: true, keepTyping: true });
	}

	// ---- chips --------------------------------------------------------------------------------
	const optionLists = ref<Record<string, ChipOption[]>>({});
	const failedChips = ref<string[]>([]);
	const requested = new Set<string>();

	// Options come from the session cache when an earlier page already asked: moving between lists
	// does not refetch the same projects and statuses every time.
	function setOptions(field: string, cacheKey: string | null, options: ChipOption[]): void {
		if (cacheKey) chipCacheFor(host).set(cacheKey, options);
		optionLists.value = { ...optionLists.value, [field]: options };
	}

	async function loadOptions(field: string): Promise<void> {
		const filter = def.filters.find((f) => f.field === field);
		if (!filter) return;
		try {
			if (filter.options.kind === 'relation') {
				const key = relationKey(filter.options.collection);
				if (!key) throw new Error('unknown relation');
				const { collection, display, fallback } = filter.options;
				const cacheKey = `${collection}.${display}${fallback ? `.${fallback}` : ''}`;
				const hit = chipCacheFor(host).get(cacheKey);
				if (hit) return setOptions(field, null, hit);
				const res = await host.api.get(`/items/${filter.options.collection}`, { params: relationOptionParams(key, display, fallback) });
				setOptions(field, cacheKey, relationOptions(res.data?.data, key, display, fallback));
			} else if (filter.options.kind === 'enum') {
				if (filter.options.values) {
					setOptions(field, null, filter.options.values.map((v) => ({ value: v, label: v })));
					return;
				}
				const cacheKey = `${def.collection}.${field}`;
				const hit = chipCacheFor(host).get(cacheKey);
				if (hit) return setOptions(field, null, hit);
				const res = await host.api.get(`/items/${def.collection}`, { params: enumOptionParams(field) });
				setOptions(field, cacheKey, enumOptions(res.data?.data, field, choiceKindFor(def.collection, field)));
			}
		} catch {
			failedChips.value = [...failedChips.value, field];
		}
	}

	function offered(field: string): boolean {
		const filter = def.filters.find((f) => f.field === field);
		if (!filter || failedChips.value.includes(field)) return false;
		return filter.options.kind === 'relation' ? collectionOffered(filter.options.collection) : true;
	}

	watch(
		() => def.filters.filter((f) => offered(f.field)).map((f) => f.field).join(','),
		() => {
			for (const f of def.filters) {
				if (!offered(f.field) || requested.has(f.field)) continue;
				requested.add(f.field);
				if (f.options.kind === 'relation' || f.options.kind === 'enum') void loadOptions(f.field);
			}
		},
		{ immediate: true },
	);

	const chips = computed<ChipView[]>(() =>
		def.filters.filter((f) => offered(f.field)).map((f) => {
			const value = state.value.filters[f.field] ?? '';
			const flag = f.options.kind === 'flag';
			const base = f.options.kind === 'bool' ? BOOL_OPTIONS : flag ? [] : (optionLists.value[f.field] ?? []);
			return { field: f.field, label: f.label, flag, options: flag ? [] : withSelected(base, value), value };
		}),
	);

	// ---- header and rows ----------------------------------------------------------------------
	// A search that only came from the saved view is the view's own: the Data Studio applies it with the bookmark.
	const dsLink = computed(() => dataStudioLink(def, qExplicit.value ? state.value : raw.value));
	const rowKey = (row: Record<string, unknown>): string => String(row[def.primaryKey]);
	// A relation column sorts by the related row's field, which needs that collection readable.
	const relationSortable = (collection: string) => collectionOffered(collection);
	const filtered = computed(() => hasActiveFilters(state.value) || raw.value.bookmark !== null);
	// Search or chips set (the filter bar's "Clear filters" is for these; a saved view alone has its x).
	const hasFilters = computed(() => hasActiveFilters(state.value));

	return {
		rows, total, plots, loading, error, forbidden, bookmarkUnavailable,
		state, sort, bookmarks, searchText, chips, dsLink, filtered, hasFilters,
		reload: load, rowKey, relationSortable,
		setSearch, setBookmark, setFilter, setSort, setSortTo, setPage, clearFilters, closeOpen,
	};
}
