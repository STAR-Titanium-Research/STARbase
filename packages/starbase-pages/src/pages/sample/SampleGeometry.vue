<script setup lang="ts">
import { computed } from 'vue';
import { buildGeometry, type Dims } from '../../geometry';

// The drawing of a sample at its real dimensions: the isometric SVG from geometry.ts with the CSS
// classes it emits. This is the ONE renderer of that drawing in the Explorer: the Sample page's rail
// uses it, and so must anything that shows the same sample smaller (the cards of the index pages),
// so a thumbnail looks exactly like the Sample page. It fills the width it is given (the drawing
// scales; at most 280px wide). Input is the numeric shape of the sample: `sampleDims(row)` from @d1/ui.
//
// geometry.ts is vendored into three extensions (scripts/sync_geometry.sh): do not change its logic
// here. The classes below are the ones it emits; `sync_geometry.sh --check` requires each to be
// styled in this file, so a class added to the engine fails the check until it is styled here.
//
// Form 'other' or no form: the engine draws nothing, and this says so (it does not invent a shape).
// `labelSize`: the dimension labels' size in viewBox units (the drawing is 260 wide). 12 reads at about
// 11px when the drawing is ~240px wide; a caller that draws it smaller passes more.
const props = withDefaults(defineProps<{ dims: Dims; labelSize?: number }>(), { labelSize: 12 });
const svg = computed(() => buildGeometry(props.dims, { labelSize: props.labelSize }));
</script>

<template>
	<div class="d1-geometry">
		<div v-if="svg" class="canvas" v-html="svg"></div>
		<p v-else class="no-drawing">No drawing for this form.</p>
	</div>
</template>

<style scoped>
.d1-geometry {
	padding: 8px;
	border: 1px solid var(--d1-line);
	border-radius: 10px;
	background: var(--d1-tile);
}
.canvas { width: 100%; }
.canvas :deep(svg) { width: 100%; max-width: 280px; height: auto; display: block; margin: 0 auto; }
.no-drawing { margin: 0; padding: 4px; text-align: center; font-size: var(--fs-sm); color: var(--d1-dim); }

.canvas :deep(.gt) { fill: #dbeafe; stroke: #1d4ed8; stroke-width: 1.3; stroke-linejoin: round; }
.canvas :deep(.gl) { fill: #bfdbfe; stroke: #1d4ed8; stroke-width: 1.3; stroke-linejoin: round; }
.canvas :deep(.gr) { fill: #93c5fd; stroke: #1d4ed8; stroke-width: 1.3; stroke-linejoin: round; }
.canvas :deep(.gh) { fill: #fff; stroke: #1d4ed8; stroke-width: 1.2; }
.canvas :deep(.gdim) { stroke: #475569; stroke-width: 0.8; }
.canvas :deep(.gext) { stroke: #94a3b8; stroke-width: 0.5; }
.canvas :deep(.gdimt) { fill: #334155; font-size: 8px; font-weight: 700; text-anchor: middle;
	font-family: -apple-system, "Segoe UI", Roboto, sans-serif; paint-order: stroke; stroke: #fff; stroke-width: 2.5px; }
.canvas :deep(.gsupport) { fill: #94a3b8; stroke: #475569; stroke-width: 0.6; }
.canvas :deep(.gload) { stroke: #b91c1c; stroke-width: 1.4; }
</style>
