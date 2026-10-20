<script setup lang="ts">
// ForceChart's hover crosshair + dot (part="svg", inside the <svg>) and readout (part="tip", outside
// it), split out so a mouse move redraws only these (#100). The index is read only here; see chartHover.ts.
// One cursor runs across every chart of a group: the chart under the pointer (`local.hot`) shows the
// tooltip and an x tag on its axis, the others a value dot with a surface ring.
import { computed, type Ref } from 'vue';
import { hoverPoint, type HoverGeom, type HoverSource } from './chartHover';

const props = defineProps<{
	part: 'svg' | 'tip';
	hover?: HoverSource;
	local?: { hot: Ref<boolean> };   // a stable wrapper like `hover`: only this layer reads `.hot`
	tagBelow?: boolean;              // the x tag sits under the axis (this chart has tick labels), else inside the plot
	geom: HoverGeom;
	kind: 'env' | 'line';
	data: any;
	yLabelUnit: string;
	xUnit?: string;
	stroke: string;
	top: number;       // plot area top / bottom edges (the crosshair's extent)
	bottom: number;
}>();

const pt = computed(() => hoverPoint(props.geom, props.hover?.index.value, props.kind, props.data, props.yLabelUnit, props.xUnit));
const tagW = computed(() => Math.max(28, (pt.value?.sub.length ?? 0) * 6.2 + 12));
</script>

<template>
	<g v-if="part === 'svg' && pt">
		<line :x1="pt.px" :x2="pt.px" :y1="top" :y2="bottom" class="hv-line" stroke-width="1" />
		<circle :cx="pt.px" :cy="pt.py" r="4.5" class="hv-ring" />
		<circle :cx="pt.px" :cy="pt.py" r="3" :style="{ fill: stroke }" />
		<g v-if="local?.hot.value" class="hv-tag">
			<rect :x="pt.px - tagW / 2" :y="tagBelow ? bottom + 3 : bottom - 17" :width="tagW" height="14" rx="3" />
			<text :x="pt.px" :y="tagBelow ? bottom + 13.5 : bottom - 6.5" text-anchor="middle">{{ pt.sub }}</text>
		</g>
	</g>
	<div v-else-if="part === 'tip' && pt && local?.hot.value" class="chart-tip"><strong>{{ pt.label }}</strong><span>{{ pt.sub }}</span></div>
</template>

<style scoped>
.hv-line { stroke: var(--theme--foreground-subdued, #64748b); stroke-opacity: 0.8; }
.hv-ring { fill: var(--theme--background, #fff); }
.hv-tag rect { fill: var(--theme--foreground, #1e293b); }
.hv-tag text { fill: var(--theme--background, #fff); font-size: var(--fs-xs, 11px); font-weight: 600; font-variant-numeric: tabular-nums; }
.chart-tip {
	/* below the header row so it never covers the "peak … N" readout in the top-right */
	position: absolute; top: 30px; right: 12px; display: flex; flex-direction: column; align-items: flex-end;
	background: color-mix(in srgb, var(--theme--background, #fff) 85%, transparent); border-radius: 8px; padding: 2px 7px; pointer-events: none;
}
.chart-tip strong { font-size: var(--fs-sm, 12px); font-variant-numeric: tabular-nums; }
.chart-tip span { font-size: var(--fs-xs, 11px); color: var(--theme--foreground-subdued, #98a2b3); }
</style>
