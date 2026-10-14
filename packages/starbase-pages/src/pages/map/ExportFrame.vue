<script setup lang="ts">
import type { ExportPlan } from './model/exportPlan';
import { KINDS, kindVar } from './nodes/kinds';

// The picture the export takes (spec D26): the header, the whole map, the legend, at the size the plan
// worked out. Drawn by the page only while an export runs, over the page but invisible (it has to be laid
// out to be photographed); useMapExport puts a copy of the Vue Flow pane into `.pm-export-graph`.
defineProps<{ plan: ExportPlan }>();
</script>

<template>
	<div class="pm-export-frame" aria-hidden="true" :style="{ width: `${plan.width}px`, height: `${plan.height}px` }">
		<header class="pm-xf-head" :style="{ height: `${plan.headerHeight}px` }">
			<div class="pm-xf-title">{{ plan.header[0] }}</div>
			<div class="pm-xf-sub">{{ plan.header[1] }}</div>
		</header>
		<div class="pm-export-graph" :style="{ height: `${plan.graph.height}px` }"><slot /></div>
		<footer v-if="plan.legend.length" class="pm-xf-legend" :style="{ height: `${plan.legendHeight}px` }">
			<span v-for="l in plan.legend" :key="l.kind" class="pm-xf-key"><i :style="{ background: kindVar(KINDS[l.kind]) }" />{{ l.label }}</span>
		</footer>
	</div>
</template>

<style scoped>
.pm-export-frame {
	position: fixed;
	left: 0;
	top: 0;
	z-index: -1;
	opacity: 0;
	pointer-events: none;
	overflow: hidden;
	box-sizing: border-box;
	display: flex;
	flex-direction: column;
	color: var(--theme--foreground);
	background: var(--d1-surface, var(--theme--background));
}
.pm-xf-head { box-sizing: border-box; padding: 12px 24px 0; flex: none; }
.pm-xf-title { font-size: 20px; font-weight: 700; line-height: 28px; }
.pm-xf-sub { font-size: 13px; line-height: 20px; color: var(--d1-dim, var(--theme--foreground-subdued)); }
.pm-export-graph { position: relative; flex: none; overflow: hidden; }
.pm-xf-legend { box-sizing: border-box; flex: none; display: flex; flex-wrap: wrap; align-content: flex-start; gap: 0; padding: 10px 24px 0; font-size: 12px; }
.pm-xf-key { display: inline-flex; align-items: center; gap: 6px; width: 130px; height: 24px; }
.pm-xf-key i { width: 12px; height: 12px; border-radius: 3px; flex: none; }
</style>
