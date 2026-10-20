<script setup lang="ts">
// The compact list of an index page (Layout "list"): two lines per row, the code (the row's link) with its title on
// the first and the other shown columns, values only, on the second. It does what the table does for a row: the
// first line is a real link (or a button for a drawer row), a click anywhere else on the row opens it, a tick
// column when the list has a select action or is picking, and the Force / FAST / map buttons at the end. It draws
// what IndexPage hands it and reports clicks.
import { rowAccent } from './accent';
import { cardFacts, cardHead } from './cardFacts';
import RowMapButton from './RowMapButton.vue';
import RowPlotButtons from './RowPlotButtons.vue';
import type { IndexDef } from './indexConfig';
import { groupHeader, plotCode } from './indexView';
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
	plots: Record<string, RowPlots>;
	hasPlots: boolean;
	hasMap: boolean;
	pick?: boolean;
	ticks: boolean;
	isPicked: (row: Row) => boolean;
	isTaken: (row: Row) => boolean;
	full: boolean;
	rowHref: (row: Row) => string;
	/** The group a row is under (the rail's Group by): a header is drawn above each run of rows. */
	groupOf?: ((row: Row) => string) | null;
}>();
const emit = defineEmits<{ open: [row: Row]; toggle: [row: Row]; rowLink: [event: MouseEvent, row: Row] }>();

const SKELETONS = Array.from({ length: 8 }, (_, i) => i);
const header = (i: number): string | null => (props.groupOf ? groupHeader(props.rows, i, props.groupOf) : null);
</script>

<template>
	<ul v-if="loading && !rows.length" class="list" aria-hidden="true">
		<li v-for="n in SKELETONS" :key="n" class="row skeleton" :class="density"><span class="bar wide" /><span class="bar" /></li>
	</ul>
	<ul v-else class="list">
		<template v-for="(row, i) in rows" :key="rowKey(row)">
			<li v-if="header(i) !== null" class="group" role="presentation">{{ header(i) }}</li>
			<li
				class="row"
				:class="[density, { on: pick && isPicked(row), taken: pick && isTaken(row) }]"
				:[PICK_ATTR]="pick ? rowKey(row) : undefined"
				@click="emit('open', row)"
			>
				<input
					v-if="ticks"
					type="checkbox"
					class="tick"
					:checked="isPicked(row)"
					:disabled="isTaken(row) || (!isPicked(row) && full)"
					:aria-label="isTaken(row) ? 'Already added' : 'Tick this row'"
					@click.stop
					@change="emit('toggle', row)"
				/>
				<div class="main">
					<div class="l1">
						<span v-if="rowAccent(def, row)" class="swatch" :style="{ background: rowAccent(def, row) as string }" aria-hidden="true" />
						<span v-if="pick" class="cell-text" :class="{ mono: cardHead(def, row).mono }">{{ cardHead(def, row).link || '—' }}<span v-if="isTaken(row)" class="taken-tag">already added</span></span>
						<a
							v-else-if="def.rowTarget === 'record'"
							class="cell-link"
							:class="{ mono: cardHead(def, row).mono }"
							:href="rowHref(row)"
							:aria-label="cardHead(def, row).link ? undefined : 'Open'"
							@click="emit('rowLink', $event, row)"
						>{{ cardHead(def, row).link || '—' }}</a>
						<button
							v-else
							type="button"
							class="cell-link"
							:class="{ mono: cardHead(def, row).mono }"
							:aria-label="cardHead(def, row).link ? undefined : 'Open'"
							@click.stop="emit('open', row)"
						>{{ cardHead(def, row).link || '—' }}</button>
						<span v-if="cardHead(def, row).sub" class="sub">{{ cardHead(def, row).sub }}</span>
					</div>
					<div class="l2">{{ cardFacts(def, row, Infinity).map((f) => f.value).join(' · ') }}</div>
				</div>
				<RowPlotButtons v-if="hasPlots" :collection="def.collection" :id="rowKey(row)" :code="plotCode(row)" :label="rowLabel(row)" :plots="plots[rowKey(row)]" />
				<RowMapButton v-if="hasMap" :collection="def.collection" :id="rowKey(row)" :label="rowLabel(row)" />
			</li>
		</template>
	</ul>
</template>

<style scoped>
.list { list-style: none; margin: 0 -8px; padding: 0; min-width: 0; }
.group {
	padding: 10px 8px 4px; font-size: var(--fs-xs, 11px); font-weight: 650; text-transform: uppercase; letter-spacing: 0.04em; color: var(--d1-dim);
	border-bottom: 1px solid var(--theme--border-color);
}
.row {
	display: flex; align-items: center; gap: 10px; padding: 7px 8px; border-bottom: 1px solid var(--d1-line); cursor: pointer; min-width: 0;
}
.row:hover { background: var(--d1-tile); }
.row.compact { padding-block: 4px; }
.row.roomy { padding-block: 11px; }
.row.on { background: var(--d1-tint); }
.row.taken { opacity: 0.55; cursor: default; }
.list > .row:last-child { border-bottom: 0; }
.main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.l1 { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.l2 { font-size: var(--fs-sm, 12px); color: var(--d1-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sub { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--theme--foreground); }
.mono { font-family: var(--theme--fonts--monospace--font-family, monospace); font-weight: 600; }
.cell-link { display: inline; flex: none; padding: 0; border: 0; background: none; font: inherit; color: inherit; text-decoration: none; cursor: pointer; }
.cell-link.mono { font-weight: 700; }
.cell-link:hover { color: var(--d1-accent, var(--theme--primary)); text-decoration: underline; }
.cell-link:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 2px; border-radius: 3px; }
.cell-text { flex: none; }
.taken-tag { margin-left: 8px; font-size: var(--fs-xs, 11px); font-weight: 600; color: var(--d1-dim); }
.swatch { align-self: center; flex: none; width: 12px; height: 12px; border-radius: 3px; box-shadow: 0 0 0 1px color-mix(in srgb, var(--theme--foreground) 30%, transparent); }
.skeleton { flex-direction: column; align-items: flex-start; gap: 6px; cursor: default; }
.skeleton:hover { background: none; }
.bar {
	display: block; height: 10px; width: 40%; border-radius: 5px;
	background: linear-gradient(90deg, var(--d1-tile) 25%, var(--d1-line) 50%, var(--d1-tile) 75%);
	background-size: 200% 100%; animation: shimmer 1.2s linear infinite;
}
.bar.wide { width: 60%; }
@keyframes shimmer { to { background-position: -200% 0; } }
@media (prefers-reduced-motion: reduce) { .bar { animation: none; } }
</style>
