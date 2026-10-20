<script setup lang="ts">
// The list's rows as a grid of cards, the page's own paging, search and filters unchanged. Each
// card is the page's `card` slot when it has one (the campaigns list), else a TextCard built from
// the def's columns. The `thumb` slot (a picture per row) and `footer` slot (the row's buttons) go
// to the text card; they are only drawn when the page fills them. While the first page loads it
// shows skeleton cards in the same grid, so nothing jumps when the rows arrive.
import { computed } from 'vue';
import type { IndexDef } from './indexConfig';
import { cardFacts, cardHead } from './cardFacts';
import TextCard from './TextCard.vue';
import { rowAccent } from './accent';
import { groupRuns } from './indexView';
import { PICK_ATTR } from './pickMode';

type Row = Record<string, unknown>;

const props = defineProps<{
	def: IndexDef;
	rows: Row[];
	loading: boolean;
	rowKey: (row: Row) => string;
	/** A record row's address; null for a list whose rows open the drawer. */
	hrefFor: (row: Row) => string | null;
	/** Extra data per row key for a `card` slot (the campaigns list's counts), and whether it is still loading. */
	data?: ReadonlyMap<string, unknown> | null;
	dataLoading?: boolean;
	/** The Projects index's wider columns, for a designed card (the campaigns list). */
	wide?: boolean;
	/** Picker mode: each card carries its key, so the page can measure where it is (pickMode.ts). */
	pick?: boolean;
	/** The group a row is under (the rail's Group by): a header takes the full width above each run of cards. */
	groupOf?: ((row: Row) => string) | null;
}>();
const emit = defineEmits<{ open: [row: Row] }>();
const runs = computed(() => groupRuns(props.rows, props.groupOf));

const SKELETONS = Array.from({ length: 12 }, (_, i) => i);
</script>

<template>
	<ul v-if="loading && !rows.length" class="card-grid" :class="{ wide }" aria-hidden="true">
		<li v-for="n in SKELETONS" :key="n" class="skeleton"><span class="bar wide" /><span class="bar" /><span class="bar short" /></li>
	</ul>
	<ul v-else class="card-grid" :class="{ wide }">
		<template v-for="(run, n) in runs" :key="n">
		<li v-if="run.label !== null" class="group" role="presentation"><div role="heading" aria-level="3">{{ run.label }}</div></li>
		<li v-for="row in run.rows" :key="rowKey(row)" :[PICK_ATTR]="pick ? rowKey(row) : undefined">
			<slot name="card" :row="row" :data="data?.get(rowKey(row)) ?? null" :loading="!!dataLoading">
				<TextCard
					:link="cardHead(def, row).link"
					:mono="cardHead(def, row).mono"
					:sub="cardHead(def, row).sub"
					:facts="cardFacts(def, row)"
					:href="hrefFor(row)"
					:accent="rowAccent(def, row)"
					@open="emit('open', row)"
				>
					<template v-if="$slots.thumb" #thumb><slot name="thumb" :row="row" /></template>
					<template v-if="$slots.footer" #footer><slot name="footer" :row="row" /></template>
				</TextCard>
			</slot>
		</li>
		</template>
	</ul>
</template>

<style scoped>
.card-grid { list-style: none; margin: 6px 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(240px, 100%), 1fr)); gap: 12px; min-width: 0; }
.card-grid.wide { margin: 0; grid-template-columns: repeat(auto-fill, minmax(min(320px, 100%), 1fr)); }
.card-grid > li { min-width: 0; }
/* Cards of one row share a height, the designed campaign card included. */
.card-grid > li:not(.skeleton, .group) > :deep(*) { height: 100%; }
.card-grid > .group { grid-column: 1 / -1; margin-top: 6px; font-size: var(--fs-xs, 11px); font-weight: 650; text-transform: uppercase; letter-spacing: 0.04em; color: var(--d1-dim); }
.card-grid > .group:first-child { margin-top: 0; }
.skeleton {
	display: flex; flex-direction: column; gap: 8px; height: 96px; padding: 12px;
	border: 1px solid var(--d1-line); border-radius: 10px; background: var(--d1-tile);
}
/* The wide grid's cards are raised (the campaign card): its skeletons match, so rows do not jump. */
.card-grid.wide .skeleton { height: 150px; padding: 12px 14px; border-radius: var(--d1-radius, 12px); background: var(--d1-surface); box-shadow: var(--d1-shadow); }
.bar {
	display: block; height: 10px; width: 60%; border-radius: 5px;
	background: linear-gradient(90deg, var(--d1-tile) 25%, var(--d1-line) 50%, var(--d1-tile) 75%);
	background-size: 200% 100%; animation: shimmer 1.2s linear infinite;
}
.bar.wide { width: 80%; }
.bar.short { width: 40%; }
@keyframes shimmer { to { background-position: -200% 0; } }
@media (prefers-reduced-motion: reduce) { .bar { animation: none; } }
</style>
