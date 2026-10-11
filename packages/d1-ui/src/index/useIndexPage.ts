// The state of one index page: the URL is the single source of truth (bookmark, q, chips, sort,
// page, open), the rows and chip options are loaded from it, and every change writes the URL back.
// Typing in the search box replaces the URL (debounced), clicks push a history entry, so reload and
// Back reproduce the view. Host-neutral: the API, navigation and route come in as arguments.
import { computed, getCurrentInstance, onBeforeUnmount, ref, watch } from 'vue';
import type { ExplorerHost } from '../host';
import { errorText, isForbidden } from '../format';
import { useRequestGate } from '../composables/useRequestGate';
import { useExplorerNav } from '../nav/useExplorerNav';
import type { Bookmark } from '../nav/navConfig';
import type { IndexDef } from './indexConfig';
import { bookmarkSort, buildItemsParams, dataStudioLink, stateFromQuery } from './indexQuery';
import type { IndexState } from './indexQuery';
import {
	BOOL_OPTIONS, effectiveState, enumOptionParams, enumOptions, extraFields, hasActiveFilters, hasExplicitQ, nextSort,
	queryForState, relationKey, relationOptionParams, relationOptions, withChange, withSelected,
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
	options: ChipOption[];
	value: string;
}

export function useIndexPage(host: ExplorerHost, def: IndexDef, route: RouteLike, router: RouterLike) {
	const { nav, error: navError } = useExplorerNav(host);
	const gate = useRequestGate();
	let timer: ReturnType<typeof setTimeout> | null = null;

	const rows = ref<Record<string, unknown>[]>([]);
	const total = ref<number | null>(null);
	const loading = ref(true);
	const error = ref('');
	const forbidden = ref(false);
	// The URL named a saved view that could not be read (or is not this collection's).
	const settledBookmark = ref<number | null>(null);

	// ---- state from the URL -------------------------------------------------------------------
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

	// A saved view's own search fills the box when the URL carries no q.
	const state = computed<IndexState>(() => effectiveState(raw.value, qExplicit.value, bookmark.value));
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
		fetched.value = { ...fetched.value, [id]: found };
		return found !== null;
	}

	// ---- the rows -----------------------------------------------------------------------------
	async function load(): Promise<void> {
		const token = gate.begin();
		loading.value = true;
		error.value = '';
		forbidden.value = false;
		const id = raw.value.bookmark;
		const ok = await ensureBookmark(id);
		if (!gate.isCurrent(token)) return;
		settledBookmark.value = ok ? null : id;

		const params = buildItemsParams(def, state.value, bookmark.value);
		params.fields = [...(params.fields as string[]), ...extraFields(def).filter((f) => !(params.fields as string[]).includes(f))];
		try {
			const res = await host.api.get(`/items/${def.collection}`, { params });
			if (!gate.isCurrent(token)) return;
			rows.value = res.data?.data ?? [];
			const count = Number(res.data?.meta?.filter_count);
			total.value = Number.isFinite(count) ? count : rows.value.length;
		} catch (e) {
			if (!gate.isCurrent(token)) return;
			rows.value = [];
			total.value = null;
			if (isForbidden(e)) forbidden.value = true;
			else error.value = errorText(e, 'Could not load the list');
		} finally {
			if (gate.isCurrent(token)) loading.value = false;
		}
	}

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
	const visibleCollections = computed(() => new Set(nav.value.groups.flatMap((g) => g.links).map((l) => l.collection).filter(Boolean) as string[]));
	// With the list of readable collections unavailable, a relation chip is tried (a 403 on its
	// options drops it); otherwise only a visible collection's chip is offered.
	const collectionOffered = (collection: string) => navError.value || visibleCollections.value.has(collection);

	const optionLists = ref<Record<string, ChipOption[]>>({});
	const failedChips = ref<string[]>([]);
	const requested = new Set<string>();

	async function loadOptions(field: string): Promise<void> {
		const filter = def.filters.find((f) => f.field === field);
		if (!filter) return;
		try {
			if (filter.options.kind === 'relation') {
				const key = relationKey(filter.options.collection);
				if (!key) throw new Error('unknown relation');
				const res = await host.api.get(`/items/${filter.options.collection}`, { params: relationOptionParams(key, filter.options.display) });
				optionLists.value = { ...optionLists.value, [field]: relationOptions(res.data?.data, key, filter.options.display) };
			} else if (filter.options.kind === 'enum') {
				if (filter.options.values) {
					optionLists.value = { ...optionLists.value, [field]: filter.options.values.map((v) => ({ value: v, label: v })) };
					return;
				}
				const res = await host.api.get(`/items/${def.collection}`, { params: enumOptionParams(field) });
				optionLists.value = { ...optionLists.value, [field]: enumOptions(res.data?.data, field) };
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
				if (f.options.kind !== 'bool') void loadOptions(f.field);
			}
		},
		{ immediate: true },
	);

	const chips = computed<ChipView[]>(() =>
		def.filters.filter((f) => offered(f.field)).map((f) => {
			const value = state.value.filters[f.field] ?? '';
			const base = f.options.kind === 'bool' ? BOOL_OPTIONS : (optionLists.value[f.field] ?? []);
			return { field: f.field, label: f.label, options: withSelected(base, value), value };
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
		rows, total, loading, error, forbidden, bookmarkUnavailable,
		state, sort, bookmarks, searchText, chips, dsLink, filtered, hasFilters,
		reload: load, rowKey, relationSortable,
		setSearch, setBookmark, setFilter, setSort, setPage, clearFilters, closeOpen,
	};
}
