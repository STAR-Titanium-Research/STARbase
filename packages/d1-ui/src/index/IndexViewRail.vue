<script setup lang="ts">
import { computed } from 'vue';
import SegmentedControl from '../components/SegmentedControl.vue';
import ViewRail from '../components/ViewRail.vue';
import ViewRailSection from '../components/ViewRailSection.vue';
import ColumnPicker from './ColumnPicker.vue';
import type { SortOption } from './cardFacts';
import type { GroupChoice } from './groupBy';
import type { IndexDef } from './indexConfig';
import { flipSort, hasNextPage, rangeText, splitSort, viewChanged, viewSummary } from './indexView';
import { PAGE_SIZES } from './listPrefs';
import type { Density, ListPrefs, ListView, PageSize } from './listPrefs';

// The View rail of an index page (DESIGN.md section 5, "The View rail"): everything about HOW rows are shown, in
// the order of the design: the count with its pager, Layout and Density, then Sort, Group by, Columns and Rows
// per page. Filters never go here (they are the toolbar's). It draws what IndexPage hands it and reports changes;
// IndexPage keeps them (listPrefs.ts, `change` carries what changed) and the sort in the URL.
// `defaultOpen` is what the rail does when this device has not chosen yet (open from 1500px of page width).
const props = defineProps<{
	def: IndexDef;
	/** Where this device remembers open or closed. */
	storageKey: string;
	defaultOpen: boolean;
	prefs: ListPrefs;
	/** The sort in force (the URL's, a saved view's or the list's own) and the URL's own, if any. */
	sort: string;
	urlSort: string | null;
	sortFields: SortOption[];
	groups: GroupChoice[];
	/** The grouping in use (a stored one the list cannot offer is not). */
	groupBy: string | null;
	/** The count: the page, how many rows it has and the total (null until known). */
	page: number;
	shown: number;
	total: number | null;
}>();
const emit = defineEmits<{
	page: [delta: 1 | -1];
	change: [patch: Partial<ListPrefs>];
	sort: [value: string];
}>();

const LAYOUTS = [
	{ value: 'table', label: 'Table', icon: '▤' },
	{ value: 'cards', label: 'Cards', icon: '▦' },
	{ value: 'list', label: 'List', icon: '☰' },
] as const;
const DENSITIES = [
	{ value: 'compact', label: 'Compact' },
	{ value: 'normal', label: 'Normal' },
	{ value: 'roomy', label: 'Roomy' },
] as const;
const SIZES = PAGE_SIZES.map((n) => ({ value: String(n), label: String(n) }));

const sorted = computed(() => splitSort(props.sort));
const range = computed(() => rangeText(props.page, props.shown, props.total, props.prefs.pageSize));
// A saved view's own sort (no column) cannot be turned round: choose a column to leave it.
const savedSort = computed(() => !!props.sortFields.find((o) => o.value === sorted.value.key)?.saved);
const sortField = (key: string) => emit('sort', sorted.value.desc ? `-${key}` : key);
</script>

<template>
	<ViewRail :storage-key="storageKey" :default-open="defaultOpen" :summary="viewSummary(def, prefs, sort)" :modified="viewChanged(def, prefs, groupBy, urlSort)">
		<ViewRailSection v-if="range">
			<div class="count">
				<span class="range" role="status">{{ range }}</span>
				<span class="pager">
					<button type="button" class="step" aria-label="Previous page" title="Previous page" :disabled="page <= 1" @click="emit('page', -1)">‹</button>
					<button type="button" class="step" aria-label="Next page" title="Next page" :disabled="!hasNextPage(page, total, prefs.pageSize)" @click="emit('page', 1)">›</button>
				</span>
			</div>
		</ViewRailSection>
		<ViewRailSection label="Layout">
			<SegmentedControl :model-value="prefs.view" :options="LAYOUTS" label="Layout" icon-only @update:model-value="emit('change', { view: $event as ListView })" />
		</ViewRailSection>
		<ViewRailSection label="Density">
			<SegmentedControl :model-value="prefs.density" :options="DENSITIES" label="Row density" @update:model-value="emit('change', { density: $event as Density })" />
		</ViewRailSection>
		<ViewRailSection label="Sort">
			<div class="pair">
				<select class="sel" :value="sorted.key" aria-label="Sort by" @change="sortField(($event.target as HTMLSelectElement).value)">
					<option v-for="o in sortFields" :key="o.value" :value="o.value">{{ o.label }}</option>
				</select>
				<button
					type="button"
					class="dir"
					:disabled="savedSort"
					:aria-label="sorted.desc ? 'Descending' : 'Ascending'"
					:title="savedSort ? 'Sorted by the saved view' : sorted.desc ? 'Descending: click for ascending' : 'Ascending: click for descending'"
					@click="emit('sort', flipSort(sort))"
				>{{ sorted.desc ? '↓' : '↑' }}</button>
			</div>
		</ViewRailSection>
		<ViewRailSection v-if="groups.length" label="Group by">
			<select class="sel" :value="groupBy ?? ''" aria-label="Group by" @change="emit('change', { groupBy: ($event.target as HTMLSelectElement).value || null })">
				<option value="">None</option>
				<option v-for="g in groups" :key="g.value" :value="g.value">{{ g.label }}</option>
			</select>
		</ViewRailSection>
		<ViewRailSection label="Columns">
			<ColumnPicker :def="def" :model-value="prefs.columns" @update:model-value="emit('change', { columns: $event })" />
		</ViewRailSection>
		<ViewRailSection label="Rows per page">
			<SegmentedControl :model-value="String(prefs.pageSize)" :options="SIZES" label="Rows per page" @update:model-value="emit('change', { pageSize: Number($event) as PageSize })" />
		</ViewRailSection>
	</ViewRail>
</template>

<style scoped>
.count { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.range { font-weight: 650; font-variant-numeric: tabular-nums; }
.pager { display: inline-flex; gap: 4px; }
.step, .dir {
	display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0;
	border: 1px solid var(--d1-line); border-radius: 8px; background: var(--d1-surface); color: var(--theme--foreground);
	font: inherit; font-size: var(--fs-lg, 15px); line-height: 1; cursor: pointer;
}
.step:hover:not(:disabled), .dir:hover:not(:disabled) { border-color: var(--d1-accent, var(--theme--primary)); }
.step:disabled, .dir:disabled { opacity: 0.4; cursor: default; }
.pair { display: flex; gap: 6px; }
.pair .sel { flex: 1; min-width: 0; }
.dir { flex: none; height: 30px; width: 30px; }
.sel {
	box-sizing: border-box; width: 100%; height: 30px; padding: 0 8px; border: 1px solid var(--theme--border-color); border-radius: 8px;
	background: var(--d1-surface); color: var(--theme--foreground); font: inherit; font-size: var(--fs-md, 13px);
}
.step:focus-visible, .dir:focus-visible, .sel:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 1px; }
</style>
