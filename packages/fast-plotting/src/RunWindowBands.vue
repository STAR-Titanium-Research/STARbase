<script setup lang="ts">
/*
 * The run windows of a log as faint labelled bands, an SVG overlay drawn inside FastChart's own svg (so in its
 * coordinate space) under the lines. The window of the run being looked at is slightly stronger. The label sits
 * at the top-left of each band and is cut to fit.
 */
import { computed } from 'vue';
import { drawBands } from './runBands';
import type { RunWindowBand } from './profile';

const props = defineProps<{ bands: RunWindowBand[]; x0: number; x1: number; sx: (t: number) => number; top: number; bottom: number }>();
const drawn = computed(() => drawBands(props.bands, props.x0, props.x1, props.sx));
</script>

<template>
	<g class="run-bands" aria-hidden="true">
		<g v-for="b in drawn" :key="b.key" class="run-band" :class="{ current: b.current }">
			<rect class="wb" :x="b.x" :y="top" :width="b.width" :height="bottom - top" />
			<text v-if="b.label" class="wb-label" :x="b.x + 4" :y="top + 11">{{ b.label }}</text>
		</g>
	</g>
</template>

<style scoped>
.wb { fill: var(--theme--foreground); fill-opacity: 0.05; }
.current .wb { fill: var(--d1-accent, var(--theme--primary)); fill-opacity: 0.13; }
.wb-label { fill: var(--d1-dim, var(--theme--foreground-subdued)); font-size: var(--fs-xs, 11px); font-weight: 600; }
.current .wb-label { fill: var(--theme--foreground); }
</style>
