import { computed, ref } from 'vue';
import type { ComputedRef, Ref } from 'vue';
import type { ExplorerHost } from '../host';
import { BOOKMARK_VISIBILITY_FILTER, buildNav } from './navConfig';
import type { Bookmark, VisibleNav } from './navConfig';

// What the sidebar loads: the collections this user can read and their saved views (spec section
// 3). Once per app session: the state lives in module scope, keyed by the host, so moving between
// pages (each page mounts its own sidebar) does not fetch again. refresh() is the Retry button.

export interface ExplorerNavState {
	nav: ComputedRef<VisibleNav>;
	// The collections the user may read (null until known, or when that request failed): what the
	// finder queries by.
	visible: Ref<Set<string> | null>;
	loading: Ref<boolean>;
	// True when either request failed; the sidebar then says so quietly and offers Retry.
	error: Ref<boolean>;
	refresh: () => Promise<void>;
}

const BOOKMARK_FIELDS = 'id,bookmark,collection,user,role,filter,search,layout_query,icon';

// /collections returns only what the user may read, with a `meta` block for the configured ones;
// a collection without meta (an unconfigured table) or marked hidden is not an Explorer page.
async function fetchVisibleCollections(host: ExplorerHost): Promise<Set<string>> {
	const res = await host.api.get('/collections', { params: { fields: 'collection,meta.hidden' } });
	const rows: Array<{ collection: string; meta?: { hidden?: boolean } | null }> = res.data?.data ?? [];
	return new Set(rows.filter((r) => r.meta && !r.meta.hidden).map((r) => r.collection));
}

async function fetchBookmarks(host: ExplorerHost): Promise<Bookmark[]> {
	const res = await host.api.get('/presets', {
		params: {
			// A JSON string: the nested _and/_or arrays survive any params serializer (indexQuery does the same).
			filter: JSON.stringify(BOOKMARK_VISIBILITY_FILTER),
			fields: BOOKMARK_FIELDS,
			sort: 'bookmark',
			limit: -1,
		},
	});
	return res.data?.data ?? [];
}

const states = new WeakMap<ExplorerHost, ExplorerNavState>();

export function useExplorerNav(host: ExplorerHost): ExplorerNavState {
	const existing = states.get(host);
	if (existing) return existing;

	const visible = ref<Set<string> | null>(null);
	const bookmarks = ref<Bookmark[]>([]);
	const loading = ref(true);
	const error = ref(false);

	// Retry clicked twice, or while the first load is still running, joins that load.
	let inFlight: Promise<void> | null = null;

	function refresh(): Promise<void> {
		if (!inFlight) inFlight = load().finally(() => { inFlight = null; });
		return inFlight;
	}

	async function load(): Promise<void> {
		loading.value = true;
		// Independent: the pages list still works when only the saved views fail, and the reverse.
		const [collections, presets] = await Promise.allSettled([fetchVisibleCollections(host), fetchBookmarks(host)]);
		visible.value = collections.status === 'fulfilled' ? collections.value : null;
		bookmarks.value = presets.status === 'fulfilled' ? presets.value : [];
		error.value = collections.status === 'rejected' || presets.status === 'rejected';
		loading.value = false;
	}

	// Until the first answer there is nothing to trim by: show only the entries that need no
	// collection (the same as the failure case), and the component shows a loading line.
	const nav = computed(() => buildNav(visible.value, bookmarks.value, host.isAdmin.value, {
		id: host.user.value?.id,
		role: host.user.value?.role,
	}));

	const state: ExplorerNavState = { nav, visible, loading, error, refresh };
	states.set(host, state);
	void refresh();
	return state;
}
