<script setup lang="ts">
// The table of an index page (IndexPage): sortable column heads, a skeleton while the first page loads, and the rows.
// The row stays a table row (so the table is still announced as one); the first cell holds the real link or button, and
// a click anywhere else on the row does the same for a mouse. In picker mode the first cell is text and a click ticks
// the row. It draws what IndexPage hands it and reports clicks.
import { computed } from 'vue';
import DataTable from '../components/DataTable.vue';
import { rowAccent } from './accent';
import RowMapButton from './RowMapButton.vue';
import RowPlotButtons from './RowPlotButtons.vue';
import type { ColumnDef, IndexDef } from './indexConfig';
import { cellText, groupHeader, plotCode, sortDirection, sortKey } from './indexView';
import { PICK_ATTR } from './pickMode';
import type { RowPlots } from './plotData';
import type { Density } from './listPrefs';

type Row = Record<string, unknown>;

const props = defineProps<{
	def: IndexDef;
	density: Density;
	rows: Row[];
	loading: boolean;
	rowKey: (row: Row) => string;
	/** The row's name, for its buttons' accessible names. */
	rowLabel: (row: Row) => string;
	showThumb: boolean;
	plots: Record<string, RowPlots>;
	hasPlots: boolean;
	hasMap: boolean;
	pick?: boolean;
	/** The tick column (a select action, or picker mode) and its state. */
	ticks: boolean;
	isPicked: (row: Row) => boolean;
	isTaken: (row: Row) => boolean;
	allPicked: boolean;
	full: boolean;
	/** The current sort ("-created_at"), whether a column can be sorted, and a record row's address. */
	sort: string;
	sortable: (c: ColumnDef) => boolean;
	rowHref: (row: Row) => string;
	/** The group a row is under (the rail's Group by): a header row is drawn above each run of rows. */
	groupOf?: ((row: Row) => string) | null;
}>();
const emit = defineEmits<{
	open: [row: Row];
	toggle: [row: Row];
	togglePage: [];
	sort: [key: string];
	rowLink: [event: MouseEvent, row: Row];
}>();

const skeletonRows = Array.from({ length: 8 }, (_, i) => i);
function ariaSort(c: ColumnDef): 'ascending' | 'descending' | undefined {
	const d = props.sortable(c) ? sortDirection(props.sort, sortKey(c)) : null;
	return d === 'asc' ? 'ascending' : d === 'desc' ? 'descending' : undefined;
}
const arrow = (c: ColumnDef) => (sortDirection(props.sort, sortKey(c)) === 'asc' ? '▲' : sortDirection(props.sort, sortKey(c)) === 'desc' ? '▼' : '');
const colCount = computed(() => (props.ticks ? 1 : 0) + (props.showThumb ? 1 : 0) + props.def.columns.length + (props.hasPlots ? 1 : 0) + (props.hasMap ? 1 : 0));
const header = (i: number): string | null => (props.groupOf ? groupHeader(props.rows, i, props.groupOf) : null);
const cellClass = (c: ColumnDef) => ({ num: c.format === 'number', mono: c.format === 'code' });
</script>

<template>
	<DataTable :density="density">
		<thead>
			<tr>
				<th v-if="ticks" class="fit">
					<input type="checkbox" :checked="allPicked" aria-label="Tick every row on this page" @change="emit('togglePage')" />
				</th>
				<th v-if="showThumb" class="thumb" aria-hidden="true" />
				<th v-for="c in def.columns" :key="c.field" :class="{ num: c.format === 'number' }" :aria-sort="ariaSort(c)">
					<button v-if="sortable(c)" type="button" class="sort" @click="emit('sort', sortKey(c))">
						{{ c.label }}<span class="arrow" aria-hidden="true">{{ arrow(c) }}</span>
					</button>
					<template v-else>{{ c.label }}</template>
				</th>
				<th v-if="hasPlots" class="plots">Plots</th>
				<th v-if="hasMap" class="plots"><span class="sr-only">Process map</span></th>
			</tr>
		</thead>
		<tbody>
			<template v-if="loading && !rows.length">
				<tr v-for="n in skeletonRows" :key="n" class="skeleton" aria-hidden="true">
					<td v-if="ticks" />
					<td v-if="showThumb" class="thumb"><span class="bar" /></td>
					<td v-for="c in def.columns" :key="c.field"><span class="bar" /></td>
					<td v-if="hasPlots" class="plots" />
					<td v-if="hasMap" class="plots" />
				</tr>
			</template>
			<template v-else>
				<template v-for="(row, i) in rows" :key="rowKey(row)">
				<tr v-if="header(i) !== null" class="group"><th :colspan="colCount" scope="colgroup">{{ header(i) }}</th></tr>
				<tr
					class="row"
					:class="{ on: pick && isPicked(row), taken: pick && isTaken(row) }"
					:[PICK_ATTR]="pick ? rowKey(row) : undefined"
					@click="emit('open', row)"
				>
					<td v-if="ticks" class="fit" @click.stop>
						<input
							type="checkbox"
							:checked="isPicked(row)"
							:disabled="isTaken(row) || (!isPicked(row) && full)"
							:aria-label="isTaken(row) ? 'Already added' : 'Tick this row'"
							@click.stop
							@change="emit('toggle', row)"
						/>
					</td>
					<td v-if="showThumb" class="thumb"><div class="thumb-box"><slot name="thumb" :row="row" :plots="plots[rowKey(row)] ?? null" /></div></td>
					<td v-for="(c, i) in def.columns" :key="c.field" :class="cellClass(c)">
						<template v-if="i === 0">
							<span v-if="rowAccent(def, row)" class="swatch" :style="{ background: rowAccent(def, row) as string }" aria-hidden="true" />
							<!-- Picking: the row is ticked by a click, so its first cell is text, not a link. -->
							<span v-if="pick" class="cell-text">{{ cellText(row, c, def) || '—' }}<span v-if="isTaken(row)" class="taken-tag">already added</span></span>
							<a
								v-else-if="def.rowTarget === 'record'"
								class="cell-link"
								:href="rowHref(row)"
								:aria-label="cellText(row, c, def) ? undefined : 'Open'"
								@click="emit('rowLink', $event, row)"
							>{{ cellText(row, c, def) || '—' }}</a>
							<button
								v-else
								type="button"
								class="cell-link"
								:aria-label="cellText(row, c, def) ? undefined : 'Open'"
								@click.stop="emit('open', row)"
							>{{ cellText(row, c, def) || '—' }}</button>
						</template>
						<template v-else>{{ cellText(row, c, def) }}</template>
					</td>
					<td v-if="hasPlots" class="plots">
						<RowPlotButtons :collection="def.collection" :id="rowKey(row)" :code="plotCode(row)" :label="rowLabel(row)" :plots="plots[rowKey(row)]" />
					</td>
					<td v-if="hasMap" class="plots">
						<RowMapButton :collection="def.collection" :id="rowKey(row)" :label="rowLabel(row)" />
					</td>
				</tr>
				</template>
			</template>
		</tbody>
	</DataTable>
</template>

<style scoped>
.sort {
	border: 0; background: none; padding: 0; font: inherit; color: inherit; cursor: pointer;
	display: inline-flex; align-items: center; gap: 4px;
}
.sort:hover { color: var(--theme--foreground); }
.arrow { font-size: 9px; }
th.num .sort { justify-content: flex-end; }

.group th { padding-top: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
.row { cursor: pointer; }
.row.on td { background: var(--d1-tint); }
.row.taken { opacity: 0.55; cursor: default; }
.taken-tag { margin-left: 8px; font-size: var(--fs-xs, 11px); font-weight: 600; color: var(--d1-dim); }
.plots { text-align: right; }
.sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.row td.plots { overflow: visible; }
.cell-link {
	display: inline; padding: 0; border: 0; background: none; font: inherit; text-align: inherit;
	color: inherit; text-decoration: none; cursor: pointer;
}
.swatch { display: inline-block; width: 12px; height: 12px; margin-right: 6px; vertical-align: -1px; border-radius: 3px; box-shadow: 0 0 0 1px color-mix(in srgb, var(--theme--foreground) 30%, transparent); }
.cell-link:hover { color: var(--d1-accent, var(--theme--primary)); text-decoration: underline; }
.cell-link:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 2px; border-radius: 3px; }
/* Long free text (outcomes, notes) is cut instead of stretching the row. */
.row td { max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* The roomy row's picture box: a fixed 8:5 frame (the size of the thumbnail request, scaled down), so rows do not jump as pictures load; the picture inside is contained (IndexThumb), never cropped. */
.thumb-box { box-sizing: border-box; width: 72px; height: 45px; overflow: hidden; border: 1px solid var(--d1-line); border-radius: 6px; background: var(--d1-tile); line-height: 0; }
.skeleton .thumb .bar { width: 72px; height: 45px; border-radius: 6px; }

.skeleton .bar {
	display: block; height: 10px; width: 70%; border-radius: 5px;
	background: linear-gradient(90deg, var(--d1-tile) 25%, var(--d1-line) 50%, var(--d1-tile) 75%);
	background-size: 200% 100%; animation: shimmer 1.2s linear infinite;
}
@keyframes shimmer { to { background-position: -200% 0; } }
@media (prefers-reduced-motion: reduce) { .skeleton .bar { animation: none; } }
</style>
