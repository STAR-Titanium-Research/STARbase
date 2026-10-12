<script setup lang="ts">
// The list's rows as a grid of cards, the page's own paging, search and filters unchanged. Each
// card is the page's `card` slot when it has one (the campaigns list), else a TextCard built from
// the def's columns. The `thumb` slot (a picture per row) and `footer` slot (the row's buttons) go
// to the text card; they are only drawn when the page fills them. While the first page loads it
// shows skeleton cards in the same grid, so nothing jumps when the rows arrive.
import type { IndexDef } from './indexConfig';
import { cardFacts, cardHead } from './cardFacts';
import TextCard from './TextCard.vue';

type Row = Record<string, unknown>;

defineProps<{
	def: IndexDef;
	rows: Row[];
	loading: boolean;
	rowKey: (row: Row) => string;
	/** A record row's address; null for a list whose rows open the drawer. */
	hrefFor: (row: Row) => string | null;
	/** Extra data per row key for a `card` slot (the campaigns list's counts), and whether it is still loading. */
	data?: ReadonlyMap<string, unknown> | null;
	dataLoading?: boolean;
}>();
const emit = defineEmits<{ open: [row: Row] }>();

const SKELETONS = Array.from({ length: 12 }, (_, i) => i);
</script>

<template>
	<ul v-if="loading && !rows.length" class="card-grid" aria-hidden="true">
		<li v-for="n in SKELETONS" :key="n" class="skeleton"><span class="bar wide" /><span class="bar" /><span class="bar short" /></li>
	</ul>
	<ul v-else class="card-grid">
		<li v-for="row in rows" :key="rowKey(row)">
			<slot name="card" :row="row" :data="data?.get(rowKey(row)) ?? null" :loading="!!dataLoading">
				<TextCard
					:link="cardHead(def, row).link"
					:mono="cardHead(def, row).mono"
					:sub="cardHead(def, row).sub"
					:facts="cardFacts(def, row)"
					:href="hrefFor(row)"
					@open="emit('open', row)"
				>
					<template v-if="$slots.thumb" #thumb><slot name="thumb" :row="row" /></template>
					<template v-if="$slots.footer" #footer><slot name="footer" :row="row" /></template>
				</TextCard>
			</slot>
		</li>
	</ul>
</template>

<style scoped>
.card-grid { list-style: none; margin: 6px 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
.card-grid > li { min-width: 0; }
.skeleton {
	display: flex; flex-direction: column; gap: 8px; height: 96px; padding: 12px;
	border: 1px solid var(--d1-line); border-radius: 10px; background: var(--d1-tile);
}
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
