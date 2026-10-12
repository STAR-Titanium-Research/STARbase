<script setup lang="ts">
// One list page for every collection, driven by an IndexDef (spec section 5): saved-view chips,
// search, chip filters, a plain sortable table, paging, "+ New" and "Open in Data Studio". Rows go
// to the record's Explorer page or open the edit drawer, per the def. All state lives in the URL
// (see useIndexPage); the host (ExplorerView in d1-home) supplies the API and navigation.
// How the list is shown (table or cards, and the row density) is a per-browser preference kept
// per list (listPrefs), not part of the URL. The parent can fill the `thumb` slot (a small picture
// per row, shown as the first column at Roomy density, and the picture area of a text card).
// A list with a designed card (campaigns) fills the `card` slot and may pass `cardData`, a loader
// for what that card shows beyond the row (the campaigns' counts); it runs for the rows on screen,
// in Cards view only, and the slot gets each row's entry as `data` (null while loading or missing).
// The `footer` slot (a row's buttons) is drawn at the foot of a text card.
import { computed, inject, onBeforeUnmount, ref, useSlots, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { EXPLORER_HOST } from '../host';
import type { ExplorerHost } from '../host';
import { recordRoute } from '../recordRoute';
import DataTable from '../components/DataTable.vue';
import EditDrawer from '../components/EditDrawer.vue';
import LoadState from '../components/LoadState.vue';
import NotVisible from '../components/NotVisible.vue';
import PageShell from '../components/PageShell.vue';
import SegmentedControl from '../components/SegmentedControl.vue';
import { useRequestGate } from '../composables/useRequestGate';
import CardGrid from './CardGrid.vue';
import { sortOptions } from './cardFacts';
import type { ColumnDef, IndexDef } from './indexConfig';
import { PAGE_SIZE } from './indexQuery';
import { cellText, hasNextPage, rangeText, sortDirection, sortKey } from './indexView';
import { readListPrefs, writeListPrefs } from './listPrefs';
import type { Density, ListView } from './listPrefs';
import { useIndexPage } from './useIndexPage';

const props = defineProps<{
	def: IndexDef;
	cardData?: (host: ExplorerHost, rows: any[]) => Promise<ReadonlyMap<string, unknown>>;
}>();

const injected = inject(EXPLORER_HOST);
if (!injected) throw new Error('IndexPage needs an ExplorerHost: render it inside ExplorerView');
const host: ExplorerHost = injected;
const route = useRoute();
const router = useRouter();

const {
	rows, total, loading, error, forbidden, bookmarkUnavailable, state, sort, bookmarks, searchText, chips, dsLink, filtered, hasFilters,
	reload, rowKey, relationSortable, setSearch, setBookmark, setFilter, setSort, setSortTo, setPage, clearFilters, closeOpen,
} = useIndexPage(host, props.def, route, router);

// ---- how the list is shown ----------------------------------------------------------------
const slots = useSlots();
const initial = readListPrefs(props.def.slug);
const view = ref<ListView>(initial.view);
const density = ref<Density>(initial.density);
const showThumb = computed(() => density.value === 'roomy' && !!slots.thumb);
const VIEW_OPTIONS = [
	{ value: 'table', label: 'Table', icon: '☰' },
	{ value: 'cards', label: 'Cards', icon: '▦' },
] as const;
const DENSITY_OPTIONS = [
	{ value: 'compact', label: 'Compact' },
	{ value: 'normal', label: 'Normal' },
	{ value: 'roomy', label: 'Roomy' },
] as const;
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
function ariaSort(c: ColumnDef): 'ascending' | 'descending' | undefined {
	const d = sortable(c) ? sortDirection(sort.value, sortKey(c)) : null;
	return d === 'asc' ? 'ascending' : d === 'desc' ? 'descending' : undefined;
}
const arrow = (c: ColumnDef) => (sortDirection(sort.value, sortKey(c)) === 'asc' ? '▲' : sortDirection(sort.value, sortKey(c)) === 'desc' ? '▼' : '');
const cellClass = (c: ColumnDef) => ({ num: c.format === 'number', mono: c.format === 'code' });

// ---- rows ---------------------------------------------------------------------------------
const drawerOpen = ref(false);
const drawerKey = ref('');

function openRow(row: Record<string, unknown>): void {
	const pk = rowKey(row);
	if (props.def.rowTarget === 'record') host.navigate(recordRoute(props.def.collection, pk));
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
const rowHref = (row: Record<string, unknown>): string => router.resolve(recordRoute(props.def.collection, rowKey(row))).href;
function onRowLink(e: MouseEvent, row: Record<string, unknown>): void {
	e.stopPropagation();
	if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button !== 0) return;
	e.preventDefault();
	openRow(row);
}

// ---- cards ----------------------------------------------------------------------------------
// With no column headers to click, the cards toolbar sorts through a select (the same URL sort).
const sortChoices = computed(() => sortOptions(props.def, sort.value, (c) => sortable(c)));
const cardHref = (row: Record<string, unknown>): string | null => (props.def.rowTarget === 'record' ? rowHref(row) : null);

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

const skeletonRows = Array.from({ length: 8 }, (_, i) => i);
</script>

<template>
	<PageShell>
		<nav class="d1-crumbs"><router-link to="/home">Home</router-link><span>›</span><span>{{ def.title }}</span></nav>

		<NotVisible v-if="forbidden" :what="`${def.title.toLowerCase()} list`" />

		<template v-else>
			<div class="head">
				<span class="range" role="status">{{ rangeText(state.page, rows.length, total) }}</span>
				<span class="spacer" />
				<SegmentedControl :model-value="view" :options="VIEW_OPTIONS" label="View" @update:model-value="setView" />
				<label v-if="view === 'cards'" class="sortsel">
					<span>Sort by</span>
					<select :value="sort" aria-label="Sort by" @change="setSortTo(($event.target as HTMLSelectElement).value)">
						<option v-for="o in sortChoices" :key="o.value" :value="o.value">{{ o.label }}</option>
					</select>
				</label>
				<SegmentedControl :model-value="density" :options="DENSITY_OPTIONS" label="Row density" @update:model-value="setDensity" />
				<button
					type="button"
					class="btn"
					:title="dsLink.note ?? undefined"
					@click="host.openDataStudio(dsLink.to)"
				>Open in Data Studio</button>
				<button type="button" class="btn pri" @click="host.openDataStudio(`/content/${def.collection}/+`)">+ New</button>
			</div>

			<div v-if="bookmarks.length" class="chips" role="group" aria-label="Saved views">
				<span class="lbl">Saved views</span>
				<span v-for="b in bookmarks" :key="b.id" class="chip" :class="{ on: state.bookmark === b.id }">
					<button
						type="button"
						class="chip-main"
						:aria-pressed="state.bookmark === b.id"
						@click="state.bookmark === b.id ? undefined : setBookmark(b.id)"
					>{{ b.bookmark }}</button>
					<button
						v-if="state.bookmark === b.id"
						type="button"
						class="chip-x"
						:aria-label="`Clear saved view ${b.bookmark}`"
						@click="setBookmark(null)"
					>×</button>
				</span>
			</div>
			<p v-if="bookmarkUnavailable" class="d1-note warn" role="status">
				That saved view isn't available.
				<button type="button" class="link" @click="setBookmark(null)">Show the whole list</button>
			</p>

			<div class="filters">
				<label class="field search">
					<span>Search</span>
					<input
						type="search"
						:value="searchText"
						:placeholder="`Search ${def.title.toLowerCase()}`"
						:aria-label="`Search ${def.title.toLowerCase()}`"
						@input="setSearch(($event.target as HTMLInputElement).value)"
					/>
				</label>
				<label v-for="chip in chips" :key="chip.field" class="field">
					<span>{{ chip.label }}</span>
					<select :value="chip.value" :aria-label="`Filter by ${chip.label.toLowerCase()}`" @change="setFilter(chip.field, ($event.target as HTMLSelectElement).value)">
						<option value="">Any {{ chip.label.toLowerCase() }}</option>
						<option v-for="o in chip.options" :key="o.value" :value="o.value">{{ o.label }}</option>
					</select>
				</label>
				<button v-if="hasFilters" type="button" class="link clear" @click="clearFilters">Clear filters</button>
			</div>

			<div v-if="error" class="state-row">
				<LoadState :error="error" />
				<button type="button" class="btn" @click="reload">Retry</button>
				<!-- The saved view's own filter may be what the server rejects: offer the list without it. -->
				<button v-if="state.bookmark !== null" type="button" class="btn" @click="setBookmark(null)">Show the whole list</button>
			</div>

			<div v-else class="panel" :class="{ busy: loading && rows.length }" :aria-busy="loading">
				<!-- Cards: the page's own `card` slot (campaigns), else a text card per row. Skeleton cards while the
					first page loads, so the grid does not flip to a table and back. -->
				<CardGrid
					v-if="view === 'cards' && (loading || rows.length)"
					:def="def"
					:rows="rows"
					:loading="loading"
					:row-key="rowKey"
					:href-for="cardHref"
					:data="cardMap"
					:data-loading="cardLoading"
					@open="openRow"
				>
					<template v-if="$slots.card" #card="s"><slot name="card" v-bind="s" /></template>
					<template v-if="$slots.thumb" #thumb="{ row }"><slot name="thumb" :row="row" /></template>
					<template v-if="$slots.footer" #footer="{ row }"><slot name="footer" :row="row" /></template>
				</CardGrid>
				<DataTable v-else-if="loading || rows.length" :density="density">
					<thead>
						<tr>
							<th v-if="showThumb" class="thumb" aria-hidden="true" />
							<th v-for="c in def.columns" :key="c.field" :class="{ num: c.format === 'number' }" :aria-sort="ariaSort(c)">
								<button v-if="sortable(c)" type="button" class="sort" @click="setSort(sortKey(c))">
									{{ c.label }}<span class="arrow" aria-hidden="true">{{ arrow(c) }}</span>
								</button>
								<template v-else>{{ c.label }}</template>
							</th>
						</tr>
					</thead>
					<tbody>
						<template v-if="loading && !rows.length">
							<tr v-for="n in skeletonRows" :key="n" class="skeleton" aria-hidden="true">
								<td v-if="showThumb" class="thumb"><span class="bar" /></td>
								<td v-for="c in def.columns" :key="c.field"><span class="bar" /></td>
							</tr>
						</template>
						<template v-else>
							<!-- The row stays a table row (so the table is still announced as one); the first cell holds
								the real link or button, and a click anywhere else on the row does the same for a mouse. -->
							<tr v-for="row in rows" :key="rowKey(row)" class="row" @click="openRow(row)">
								<td v-if="showThumb" class="thumb"><div class="thumb-box"><slot name="thumb" :row="row" /></div></td>
								<td v-for="(c, i) in def.columns" :key="c.field" :class="cellClass(c)">
									<template v-if="i === 0">
										<a
											v-if="def.rowTarget === 'record'"
											class="cell-link"
											:href="rowHref(row)"
											:aria-label="cellText(row, c, def) ? undefined : 'Open'"
											@click="onRowLink($event, row)"
										>{{ cellText(row, c, def) || '—' }}</a>
										<button
											v-else
											type="button"
											class="cell-link"
											:aria-label="cellText(row, c, def) ? undefined : 'Open'"
											@click.stop="openRow(row)"
										>{{ cellText(row, c, def) || '—' }}</button>
									</template>
									<template v-else>{{ cellText(row, c, def) }}</template>
								</td>
							</tr>
						</template>
					</tbody>
				</DataTable>
				<div v-else class="state-row">
					<LoadState empty :empty-text="filtered || state.page > 1 ? 'Nothing matches.' : 'Nothing here yet.'" />
					<button v-if="filtered || state.page > 1" type="button" class="link" @click="clearFilters">Clear filters</button>
				</div>
			</div>

			<div v-if="!error && total !== null && total > 0" class="foot">
				<span class="d1-note">Page {{ state.page }} of {{ Math.max(1, Math.ceil(total / PAGE_SIZE)) }}</span>
				<span class="pager">
					<button type="button" class="btn" :disabled="state.page <= 1" @click="setPage(state.page - 1)">‹ Previous</button>
					<button type="button" class="btn" :disabled="!hasNextPage(state.page, total)" @click="setPage(state.page + 1)">Next ›</button>
				</span>
			</div>

			<EditDrawer
				v-if="def.rowTarget === 'drawer'"
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
.head, .filters, .chips, .foot, .state-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.filters { align-items: flex-end; }
.spacer { flex: 1; }
.range { font-size: var(--fs-md, 13px); color: var(--d1-dim); }

.btn {
	display: inline-flex; align-items: center; height: 30px; padding: 0 12px;
	border: 1px solid var(--d1-line); border-radius: 8px;
	background: var(--d1-tile); color: var(--theme--foreground);
	font: inherit; font-size: var(--fs-sm, 12px); font-weight: 600; white-space: nowrap; cursor: pointer;
}
.btn:hover:not(:disabled) { border-color: var(--d1-accent, var(--theme--primary)); }
.btn:disabled { opacity: 0.45; cursor: default; }
.btn.pri { background: var(--d1-accent, var(--theme--primary)); border-color: var(--d1-accent, var(--theme--primary)); color: var(--d1-on-accent, #fff); }
.link {
	border: 0; background: none; padding: 0; font: inherit; font-size: var(--fs-sm, 12px); font-weight: 600;
	color: var(--d1-accent, var(--theme--primary)); cursor: pointer; text-decoration: underline;
}
.clear { align-self: center; margin-top: 16px; }

.lbl { font-size: var(--fs-xs, 11px); font-weight: 600; color: var(--d1-dim); margin-right: 2px; }
.chip {
	display: inline-flex; align-items: center; border-radius: 99px;
	border: 1px solid var(--d1-line); background: var(--d1-surface);
	font-size: var(--fs-sm, 12px); font-weight: 600; color: var(--d1-accent, var(--theme--primary)); white-space: nowrap;
}
.chip.on { background: var(--d1-accent, var(--theme--primary)); border-color: var(--d1-accent, var(--theme--primary)); color: var(--d1-on-accent, #fff); }
.chip button { border: 0; background: none; font: inherit; color: inherit; cursor: pointer; }
.chip-main { padding: 3px 10px; border-radius: 99px; }
.chip.on .chip-main { padding-right: 4px; }
.chip-x { padding: 3px 8px 3px 2px; border-radius: 99px; font-size: var(--fs-lg, 15px); line-height: 1; }

.field { display: flex; flex-direction: column; gap: 3px; font-size: var(--fs-xs, 11px); font-weight: 600; color: var(--d1-dim); }
.field input, .field select {
	height: 30px; min-width: 140px; padding: 0 10px;
	border: 1px solid var(--theme--border-color); border-radius: 8px;
	background: var(--theme--form--field--input--background, var(--theme--background));
	color: var(--theme--foreground); font: inherit; font-size: var(--fs-md, 13px);
}
.field.search input { min-width: 240px; }

.panel {
	background: var(--d1-surface); border: 1px solid var(--d1-line); border-radius: var(--d1-radius, 12px);
	padding: 6px 16px 4px; box-shadow: var(--d1-shadow);
}
.panel.busy { opacity: 0.6; }
.state-row { padding: 6px 0; }

.sort {
	border: 0; background: none; padding: 0; font: inherit; color: inherit; cursor: pointer;
	display: inline-flex; align-items: center; gap: 4px;
}
.sort:hover { color: var(--theme--foreground); }
.arrow { font-size: 9px; }
th.num .sort { justify-content: flex-end; }

.row { cursor: pointer; }
.cell-link {
	display: inline; padding: 0; border: 0; background: none; font: inherit; text-align: inherit;
	color: inherit; text-decoration: none; cursor: pointer;
}
.cell-link:hover { color: var(--d1-accent, var(--theme--primary)); text-decoration: underline; }
.cell-link:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 2px; border-radius: 3px; }
/* Long free text (outcomes, notes) is cut instead of stretching the row. */
.row td { max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.sortsel { display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-sm, 12px); font-weight: 600; color: var(--d1-dim); }
.sortsel select {
	height: 28px; padding: 0 8px; border: 1px solid var(--d1-line); border-radius: 8px;
	background: var(--d1-surface); color: var(--theme--foreground); font: inherit; font-size: var(--fs-sm, 12px);
}
/* The roomy row's picture box: a fixed 8:5 frame (the size of the thumbnail request, scaled down), so rows do not jump as pictures load. */
.thumb-box { box-sizing: border-box; width: 72px; height: 45px; overflow: hidden; border: 1px solid var(--d1-line); border-radius: 6px; background: var(--d1-tile); line-height: 0; }
.skeleton .thumb .bar { width: 72px; height: 45px; border-radius: 6px; }

.skeleton .bar {
	display: block; height: 10px; width: 70%; border-radius: 5px;
	background: linear-gradient(90deg, var(--d1-tile) 25%, var(--d1-line) 50%, var(--d1-tile) 75%);
	background-size: 200% 100%; animation: shimmer 1.2s linear infinite;
}
@keyframes shimmer { to { background-position: -200% 0; } }
@media (prefers-reduced-motion: reduce) { .skeleton .bar { animation: none; } }

.foot { justify-content: space-between; }
.pager { display: inline-flex; gap: 8px; }
.d1-note.warn { color: var(--d1-warn); }
</style>
