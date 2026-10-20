<script setup lang="ts">
import { computed } from 'vue';
import type { WirePreview } from './useEditCanvas';

// The wire being dragged from a socket (spec E8): a curve from the socket to the pointer, green over a socket that takes it, red over
// one that does not, with the draft's reason beside the pointer; and, for a moment after a refused drop, the reason where it happened.
// Drawn over the canvas in the canvas's own pixels, not in the map's: it never moves with a pan.
const props = defineProps<{ preview: WirePreview | null; refusal: { text: string; x: number; y: number } | null }>();

const path = computed(() => {
	const p = props.preview;
	if (!p) return '';
	const dx = Math.max(40, Math.abs(p.to.x - p.from.x) / 2) * (p.to.x >= p.from.x ? 1 : -1);
	return `M ${p.from.x} ${p.from.y} C ${p.from.x + dx} ${p.from.y}, ${p.to.x - dx} ${p.to.y}, ${p.to.x} ${p.to.y}`;
});
const tone = computed(() => (props.preview?.ok === true ? 'ok' : props.preview?.ok === false ? 'bad' : 'idle'));
</script>

<template>
	<div class="pm-wirepreview">
		<svg v-if="preview" class="svg" aria-hidden="true">
			<path :d="path" class="line" :class="tone" />
			<circle :cx="preview.from.x" :cy="preview.from.y" r="5" class="dot" :class="tone" />
		</svg>
		<div v-if="preview?.reason" class="tip bad" :style="{ left: `${preview.to.x + 14}px`, top: `${preview.to.y + 14}px` }">{{ preview.reason }}</div>
		<div v-else-if="refusal" class="tip bad" role="status" :style="{ left: `${refusal.x + 14}px`, top: `${refusal.y + 14}px` }">{{ refusal.text }}</div>
	</div>
</template>

<style scoped>
.pm-wirepreview { position: absolute; inset: 0; z-index: 6; overflow: hidden; pointer-events: none; }
.svg { position: absolute; inset: 0; width: 100%; height: 100%; }
.line { fill: none; stroke-width: 2.6px; stroke-linecap: round; stroke-dasharray: 7 5; }
.line.idle { stroke: var(--k-sample, #9c27b0); }
.line.ok { stroke: var(--d1-ok); stroke-dasharray: none; }
.line.bad { stroke: var(--d1-bad); }
.dot { stroke: var(--d1-surface); stroke-width: 2px; }
.dot.idle { fill: var(--k-sample, #9c27b0); }
.dot.ok { fill: var(--d1-ok); }
.dot.bad { fill: var(--d1-bad); }
.tip {
	position: absolute;
	max-width: 260px;
	padding: 5px 10px;
	border-radius: 8px;
	background: var(--d1-surface);
	border: 1px solid var(--d1-bad);
	box-shadow: var(--d1-shadow-lg, 0 4px 14px rgb(0 0 0 / 0.18));
	color: var(--d1-bad);
	font-size: var(--fs-sm, 12px);
	line-height: 1.35;
}
</style>
