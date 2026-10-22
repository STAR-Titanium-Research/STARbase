<script setup lang="ts">
/*
 * The run windows of a log, an SVG overlay drawn inside FastChart's own svg (so in its coordinate space) under the lines.
 *   - Another run's window: a wash of the foreground colour at 5%.
 *   - The run being looked at: an accent wash at 10%; but when the view is already on its window (the plot opens there) a wash
 *     would grey the whole plot, so it is drawn as two 1px accent edge lines and no wash.
 *   - Labels go in the top margin above the plot area, on the top row of tiles only, cut with an ellipsis, with a
 *     surface-coloured halo so they stay legible over a gridline or an edge.
 */
import { computed } from 'vue';
import { drawBands } from './runBands';
import type { RunWindowBand } from './profile';

const props = defineProps<{
	bands: RunWindowBand[]; x0: number; x1: number; sx: (t: number) => number; top: number; bottom: number;
	/** Print the labels (the top row of tiles). */
	labels?: boolean;
	/** The labels start no further left than this (the y axis unit sits in the margin to its left). */
	labelMinX?: number;
	/** The baseline of the labels, in the margin above `top`. */
	labelY: number;
}>();
const drawn = computed(() => drawBands(props.bands, props.x0, props.x1, props.sx, props.labelMinX ?? 0));
</script>

<template>
	<g class="run-bands" aria-hidden="true">
		<g v-for="b in drawn" :key="b.key" class="run-band" :class="{ current: b.current, edges: b.mode === 'edges' }">
			<rect v-if="b.mode === 'wash'" class="wb" :x="b.x" :y="top" :width="b.width" :height="bottom - top" />
			<template v-else>
				<line v-if="b.startsInView" class="wb-edge" :x1="b.x" :x2="b.x" :y1="top" :y2="bottom" />
				<line v-if="b.endsInView" class="wb-edge" :x1="b.x + b.width" :x2="b.x + b.width" :y1="top" :y2="bottom" />
			</template>
			<text v-if="labels && b.label" class="wb-label" :x="b.labelX" :y="labelY">{{ b.label }}</text>
		</g>
	</g>
</template>

<style scoped>
.wb { fill: var(--theme--foreground); fill-opacity: 0.05; }
.current .wb { fill: var(--d1-accent, var(--theme--primary)); fill-opacity: 0.1; }
.wb-edge { stroke: var(--d1-accent, var(--theme--primary)); stroke-width: 1; }
.wb-label {
	fill: var(--d1-dim, var(--theme--foreground-subdued)); font-size: var(--fs-xs, 11px); font-weight: 600;
	paint-order: stroke; stroke: var(--fd-surface, var(--theme--background)); stroke-width: 3px; stroke-linejoin: round;
}
.current .wb-label { fill: var(--theme--foreground); }
</style>
