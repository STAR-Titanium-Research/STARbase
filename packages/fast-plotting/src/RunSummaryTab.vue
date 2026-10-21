<script setup lang="ts">
/*
 * The Statistics tab of a profile that keeps a summary on the run (Conform): the figures over the run window,
 * and what the log did not have. It reads the saved summary, so it shows even when the log itself is not
 * visible to the reader.
 */
import type { SummaryTile } from './profile';

defineProps<{ tiles: SummaryTile[]; note: string | null; window: string | null; empty: string }>();
</script>

<template>
	<div class="sum">
		<div class="title"><b>Statistics</b><span class="fd-dim">over the run window</span></div>
		<div v-if="window" class="fd-dim win">{{ window }}</div>
		<div v-if="tiles.length" class="fd-tiles">
			<div v-for="t in tiles" :key="t.key" class="fd-fig" :class="{ key: t.key === 'energy' }">
				<span class="top"><span class="val">{{ t.value }}</span><span class="unit">{{ t.unit }}</span></span>
				<span class="lab">{{ t.label }}</span>
			</div>
		</div>
		<div v-else class="fd-empty">{{ empty }}</div>
		<p v-if="note && tiles.length" class="fd-dim note">{{ note }}</p>
	</div>
</template>

<style scoped>
.sum { display: flex; flex-direction: column; gap: 8px; }
.title { display: flex; align-items: baseline; gap: 6px; font-size: var(--fs-md, 13px); }
.win { font-size: var(--fs-sm, 12px); font-variant-numeric: tabular-nums; }
.note { margin: 0; font-size: var(--fs-sm, 12px); }
</style>
