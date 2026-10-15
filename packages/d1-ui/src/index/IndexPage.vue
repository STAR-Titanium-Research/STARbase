<script setup lang="ts">
// One list page for every collection, driven by an IndexDef (spec section 5): saved-view chips,
// search, chip filters, a plain sortable table, paging, "+ New" and "Open in Data Studio". Rows go
// to the record's Explorer page or open the edit drawer, per the def. All state lives in the URL
// (see useIndexPage); the host (STARbase's ExplorerView) supplies the API and navigation.
// How the list is shown (table or cards, and the row density) is a per-browser preference kept
// per list (listPrefs), not part of the URL. The parent can fill the `thumb` slot (a small picture
// per row, shown as the first column at Roomy density, and the picture area of a text card).
// A list with a designed card (campaigns) fills the `card` slot and may pass `cardData`, a loader
// for what that card shows beyond the row (the campaigns' counts); it runs for the rows on screen,
// in Cards view only, and the slot gets each row's entry as `data` (null while loading or missing).
// The `footer` slot (a row's buttons) is drawn at the foot of a text card. Operations and samples
// get their Force / FAST buttons from here (RowPlotButtons, filled by useIndexPage's `plots`); the
// `thumb` slot also receives the row's `plots` (an operation's Fz figure comes from there).
// With `pick` the page is a row picker, opened over another page (the process map's sample picker): its state is kept in
// memory, not in the URL; a click on a row ticks it instead of opening it; a button hands the ticked rows back (`pick` event,
// pickMode.ts); the links, Plots, Process map, Pin, New and Data Studio buttons are not drawn.
import { computed, onBeforeUnmount, ref, useSlots, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import '../components/tokens.css';
import { useExplorerHost } from '../host';
import type { ExplorerHost } from '../host';
import { linkHref } from '../links';
import { dataStudioRoute, recordRoute } from '../recordRoute';
import AppLink from '../components/AppLink.vue';
import EditDrawer from '../components/EditDrawer.vue';
import LoadState from '../components/LoadState.vue';
import NotVisible from '../components/NotVisible.vue';
import { pinTargetForIndex } from '../components/pinTarget';
import { canonicalPath } from '../links';
import PageShell from '../components/PageShell.vue';
import { useRequestGate } from '../composables/useRequestGate';
import CardGrid from './CardGrid.vue';
import IndexTable from './IndexTable.vue';
import IndexToolbar from './IndexToolbar.vue';
import RowPlotButtons from './RowPlotButtons.vue';
import RowMapButton from './RowMapButton.vue';
import { MAP_ROW_COLLECTIONS } from '../mapLink';
import { sortOptions } from './cardFacts';
import type { ColumnDef, IndexDef } from './indexConfig';
import { PAGE_SIZE } from './indexQuery';
import { plotKind } from './plotData';
import { SELECT_MAX, cellText, hasNextPage, plotCode, rangeText, rowOpen } from './indexView';
import { readListPrefs, writeListPrefs } from './listPrefs';
import type { Density, ListView } from './listPrefs';
import { useRowSelection } from './useRowSelection';
import { memoryRoute, nounsFor } from './pickMode';
import type { PickedRow, PickNouns } from './pickMode';
import { usePickMode } from './usePickMode';
import { useIndexPage } from './useIndexPage';
import type { RouteLike, RouterLike } from './useIndexPage';

const props = defineProps<{
	def: IndexDef;
	cardData?: (host: ExplorerHost, rows: any[]) => Promise<ReadonlyMap<string, unknown>>;
	/** Picker mode (fixed for the life of the component). */
	pick?: boolean;
	/** Keys already taken (on the canvas): drawn, but cannot be ticked. */
	pickTaken?: readonly string[];
	/** What the confirm button counts ("Add 3 samples"); the def's title by default. */
	pickNouns?: PickNouns;
}>();
const emit = defineEmits<{ pick: [rows: PickedRow[]] }>();

const host: ExplorerHost = useExplorerHost();
// Picker mode keeps the list's state in memory: the page it is opened over keeps its own address (and has no router to ask).
const memory = props.pick ? memoryRoute(props.def.slug) : null;
const route: RouteLike = memory?.route ?? useRoute();
const router: RouterLike & { resolve(to: string): { href: string } } = memory
	? { ...memory.router, resolve: () => ({ href: '' }) }
	: (useRouter() as unknown as RouterLike & { resolve(to: string): { href: string } });

const {
	rows, total, plots, loading, error, forbidden, bookmarkUnavailable, teamNote, state, sort, bookmarks, searchText, chips, dsLink, filtered, hasFilters,
	reload, rowKey, relationSortable, setSearch, setBookmark, setFilter, setSort, setSortTo, setPage, clearFilters, closeOpen,
} = useIndexPage(host, props.def, route, router);

// ---- how the list is shown ----------------------------------------------------------------
const slots = useSlots();
const initial = readListPrefs(props.def.slug);
const view = ref<ListView>(initial.view);
const density = ref<Density>(initial.density);
const showThumb = computed(() => density.value === 'roomy' && !!slots.thumb);
// A designed card (campaigns) in Cards view: laid out like the Projects index, not in the panel.
const designedCards = computed(() => view.value === 'cards' && !!slots.card);
// Operations and samples carry Force / FAST buttons (a right-aligned "Plots" column, and a card's footer).
const hasPlots = computed(() => !props.pick && plotKind(props.def.collection) !== null);
// The kinds with no record page (and insert edges) get a Process map pill instead (spec section 8).
const hasMap = computed(() => !props.pick && MAP_ROW_COLLECTIONS.includes(props.def.collection));
// The row's name, for its buttons' accessible names (its first column, else its key).
const rowLabel = (row: Record<string, unknown>): string => cellText(row, props.def.columns[0], props.def) || rowKey(row);
const saveListPrefs = () => writeListPrefs(props.def.slug, { view: view.value, density: density.value });
function setView(v: ListView): void {
	view.value = v;
	saveListPrefs();
}
function setDensity(d: Density): void {
	density.value = d;
	saveListPrefs();
}

// ---- columns ------------------------------------------------------------------------------
const sortable = (c: ColumnDef) => !c.relation || relationSortable(c.relation.collection);
// ---- rows ---------------------------------------------------------------------------------
const drawerOpen = ref(false);
const drawerKey = ref('');

// A Lab Viewer is never given the edit drawer (an editable form): its row opens the record in Data Studio, read-only (see rowOpen).
const viewer = computed(() => host.canViewAllAccess?.value === true);
function openRow(row: Record<string, unknown>): void {
	if (props.pick) return pickState.toggle(row);
	const pk = rowKey(row);
	const open = rowOpen(props.def.rowTarget, viewer.value, props.def.collection, pk);
	if (open.kind === 'navigate') host.navigate(open.to);
	else if (open.kind === 'studio') host.openDataStudio(open.to);
	else {
		drawerKey.value = pk;
		drawerOpen.value = true;
	}
}

// ?open=<pk> (the finder) opens that row's drawer, on load and while the page is already showing.
watch(
	() => state.value.open,
	(pk) => {
		if (pk && props.def.rowTarget === 'drawer') {
			if (viewer.value) {
				host.openDataStudio(dataStudioRoute(props.def.collection, pk));
				closeOpen();
				return;
			}
			drawerKey.value = pk;
			drawerOpen.value = true;
		}
	},
	{ immediate: true },
);
function onDrawer(open: boolean): void {
	drawerOpen.value = open;
	if (!open) closeOpen();
}

// The record link in a row's first cell is a real <a>, so the browser's own link actions work
// (open in a new tab, copy the address). A plain click goes through the host like every other
// navigation; a modified click is left to the browser, and neither reaches the row's own handler.
const rowHref = (row: Record<string, unknown>): string => linkHref(recordRoute(props.def.collection, rowKey(row)), router);
function onRowLink(e: MouseEvent, row: Record<string, unknown>): void {
	e.stopPropagation();
	if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button !== 0) return;
	e.preventDefault();
	openRow(row);
}

// ---- ticked rows (defs with a selectAction): kept across pages, in the order ticked ----------------
// In picker mode every list can tick (not only those with a selectAction), and rows already taken are not tickable,
// so "tick every row on this page" leaves them out.
const ticks = !!props.pick || !!props.def.selectAction;
const tickable = computed(() => (props.pick ? rows.value.filter((r) => !pickState.isTaken(r)) : rows.value));
const sel = useRowSelection(props.def, tickable, rowKey, (to) => host.navigate(to));
const root = ref<unknown>(null);
const pickState = usePickMode({
	sel,
	rows,
	rowKey,
	rowLabel,
	root,
	taken: () => props.pickTaken ?? [],
	nouns: props.pickNouns ?? nounsFor(props.def.title),
	emit: (picked) => emit('pick', picked),
});

// ---- cards ----------------------------------------------------------------------------------
// With no column headers to click, the cards toolbar sorts through a select (the same URL sort).
const sortChoices = computed(() => sortOptions(props.def, sort.value, (c) => sortable(c)));
const cardHref = (row: Record<string, unknown>): string | null => (props.def.rowTarget === 'record' && !props.pick ? rowHref(row) : null);

// What a designed card shows beyond the row (the campaigns' counts), for the rows on screen. A
// failure leaves the map empty: the cards then say the numbers are unavailable.
const cardMap = ref<ReadonlyMap<string, unknown> | null>(null);
const cardLoading = ref(false);
const cardGate = useRequestGate();
watch(
	[() => view.value, rows],
	async ([v, list]) => {
		const token = cardGate.begin();
		cardMap.value = null;
		if (v !== 'cards' || !props.cardData || !list.length) {
			cardLoading.value = false;
			return;
		}
		cardLoading.value = true;
		let data: ReadonlyMap<string, unknown> = new Map();
		try {
			data = await props.cardData(host, list);
		} catch {
			// no numbers, not an error page
		}
		if (!cardGate.isCurrent(token)) return;
		cardMap.value = data;
		cardLoading.value = false;
	},
	{ immediate: true },
);
onBeforeUnmount(() => cardGate.cancel());

// ---- pin ------------------------------------------------------------------------------------
// The header's Pin toggle pins the saved view when one is open, else the page. A saved view that is
// not available (deleted, or not the person's to see) is not pinnable, and the page is not offered
// in its place: the toggle would then say something other than what is shown.
const pinTarget = computed(() => (bookmarkUnavailable.value ? null : pinTargetForIndex(canonicalPath(route.path), state.value.bookmark)));
const pinLabel = computed(() => (state.value.bookmark !== null ? (bookmarks.value.find((b) => b.id === state.value.bookmark)?.bookmark ?? props.def.title) : props.def.title));
</script>

<template>
	<PageShell ref="root" :class="{ picking: pick }">
		<nav v-if="!pick" class="d1-crumbs"><AppLink to="/home">Home</AppLink><span>›</span><span>{{ def.title }}</span></nav>

		<NotVisible v-if="forbidden" :what="`${def.title.toLowerCase()} list`" />

		<template v-else>
			<IndexToolbar
				:def="def"
				:pick="pick"
				:range="rangeText(state.page, rows.length, total)"
				:pin-target="pinTarget"
				:pin-label="pinLabel"
				:pick-text="pickState.text.value"
				:pick-count="pickState.count.value"
				:picked-count="sel.picked.value.length"
				:view="view"
				:density="density"
				:sort="sort"
				:sort-choices="sortChoices"
				:ds-link="dsLink"
				:bookmarks="bookmarks"
				:active-bookmark="state.bookmark"
				:bookmark-unavailable="bookmarkUnavailable"
				:search-text="searchText"
				:chips="chips"
				:has-filters="hasFilters"
				@confirm="pickState.confirm"
				@run="sel.run"
				@view="setView"
				@density="setDensity"
				@sort="setSortTo"
				@bookmark="setBookmark"
				@search="setSearch"
				@filter="setFilter"
				@clear="clearFilters"
			/>
			<p v-if="teamNote" class="d1-note" role="status">{{ teamNote }}</p>

			<div v-if="error" class="state-row">
				<LoadState :error="error" />
				<button type="button" class="btn" @click="reload">Retry</button>
				<!-- The saved view's own filter may be what the server rejects: offer the list without it. -->
				<button v-if="state.bookmark !== null" type="button" class="btn" @click="setBookmark(null)">Show the whole list</button>
			</div>

			<div v-else class="panel" :class="{ busy: loading && rows.length, bare: designedCards }" :aria-busy="loading">
				<!-- Cards: the page's own `card` slot (campaigns), else a text card per row. Skeleton cards while the
					first page loads, so the grid does not flip to a table and back. Designed cards sit on the page
					ground in the Projects index's wider grid, not inside the panel. -->
				<CardGrid
					v-if="view === 'cards' && (loading || rows.length)"
					:def="def"
					:wide="designedCards"
					:rows="rows"
					:loading="loading"
					:row-key="rowKey"
					:href-for="cardHref"
					:pick="pick"
					:data="cardMap"
					:data-loading="cardLoading"
					@open="openRow"
				>
					<template v-if="$slots.card" #card="s"><slot name="card" v-bind="s" /></template>
					<template v-if="$slots.thumb" #thumb="{ row }"><slot name="thumb" :row="row" :plots="plots[rowKey(row)] ?? null" /></template>
					<template v-if="$slots.footer || hasPlots || hasMap || ticks" #footer="{ row }">
						<label v-if="ticks" class="tick">
							<input type="checkbox" :checked="sel.isPicked(row)" :disabled="pickState.isTaken(row) || (!sel.isPicked(row) && sel.full.value)" @change="sel.toggle(row)" />
							<span>{{ pickState.isTaken(row) ? 'Already added' : 'Select' }}</span>
						</label>
						<RowPlotButtons v-if="hasPlots" size="card" :collection="def.collection" :id="rowKey(row)" :code="plotCode(row)" :label="rowLabel(row)" :plots="plots[rowKey(row)]" />
						<RowMapButton v-if="hasMap" size="card" :collection="def.collection" :id="rowKey(row)" :label="rowLabel(row)" />
						<slot name="footer" :row="row" />
					</template>
				</CardGrid>
				<IndexTable
					v-else-if="loading || rows.length"
					:def="def"
					:density="density"
					:rows="rows"
					:loading="loading"
					:row-key="rowKey"
					:row-label="rowLabel"
					:show-thumb="showThumb"
					:plots="plots"
					:has-plots="hasPlots"
					:has-map="hasMap"
					:pick="pick"
					:ticks="ticks"
					:is-picked="sel.isPicked"
					:is-taken="pickState.isTaken"
					:all-picked="sel.allPicked.value"
					:full="sel.full.value"
					:sort="sort"
					:sortable="sortable"
					:row-href="rowHref"
					@open="openRow"
					@toggle="sel.toggle"
					@toggle-page="sel.togglePage"
					@sort="setSort"
					@row-link="onRowLink"
				>
					<template v-if="$slots.thumb" #thumb="{ row }"><slot name="thumb" :row="row" :plots="plots[rowKey(row)] ?? null" /></template>
				</IndexTable>
				<div v-else class="state-row">
					<LoadState empty :empty-text="filtered || state.page > 1 ? 'Nothing matches.' : 'Nothing here yet.'" />
					<button v-if="filtered || state.page > 1" type="button" class="link" @click="clearFilters">Clear filters</button>
				</div>
			</div>

			<p v-if="ticks && sel.full.value" class="d1-note warn" role="status">Up to {{ SELECT_MAX }} rows can be ticked at once.</p>

			<div v-if="!error && total !== null && total > 0" class="foot">
				<span class="d1-note">Page {{ state.page }} of {{ Math.max(1, Math.ceil(total / PAGE_SIZE)) }}</span>
				<span class="pager">
					<button type="button" class="btn" :disabled="state.page <= 1" @click="setPage(state.page - 1)">‹ Previous</button>
					<button type="button" class="btn" :disabled="!hasNextPage(state.page, total)" @click="setPage(state.page + 1)">Next ›</button>
				</span>
			</div>

			<EditDrawer
				v-if="def.rowTarget === 'drawer' && !pick && !viewer"
				:model-value="drawerOpen"
				:collection="def.collection"
				:primary-key="drawerKey"
				@update:model-value="onDrawer"
				@saved="reload"
			/>
		</template>
	</PageShell>
</template>

<style scoped>
.foot, .state-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.btn {
	display: inline-flex; align-items: center; height: 30px; padding: 0 12px;
	border: 1px solid var(--d1-line); border-radius: 8px;
	background: var(--d1-tile); color: var(--theme--foreground);
	font: inherit; font-size: var(--fs-sm, 12px); font-weight: 600; white-space: nowrap; cursor: pointer;
}
.btn:hover:not(:disabled) { border-color: var(--d1-accent, var(--theme--primary)); }
.btn:disabled { opacity: 0.45; cursor: default; }
.link {
	border: 0; background: none; padding: 0; font: inherit; font-size: var(--fs-sm, 12px); font-weight: 600;
	color: var(--d1-accent, var(--theme--primary)); cursor: pointer; text-decoration: underline;
}

.panel {
	background: var(--d1-surface); border: 1px solid var(--d1-line); border-radius: var(--d1-radius, 12px);
	padding: 6px 16px 4px; box-shadow: var(--d1-shadow); min-width: 0;
}
.panel.bare { background: none; border: 0; border-radius: 0; padding: 0; box-shadow: none; }
.panel.busy { opacity: 0.6; }
.state-row { padding: 6px 0; }
/* In an overlay the page has no frame of its own to pad. */
.d1-page.picking { padding: 0 0 8px; max-width: none; }
.tick { display: inline-flex; align-items: center; gap: 5px; font-size: var(--fs-sm, 12px); font-weight: 600; color: var(--d1-dim); cursor: pointer; }
.foot { justify-content: space-between; }
.pager { display: inline-flex; gap: 8px; }
.d1-note.warn { color: var(--d1-warn); }
</style>
