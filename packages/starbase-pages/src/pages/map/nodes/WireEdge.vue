<script setup lang="ts">
import { computed } from 'vue';
import { getBezierPath, type Position } from '@vue-flow/core';
import type { Wire } from '../model/types';
import { useMapActions, wireHandlers } from './actions';

// A wire (spec §6.3, D17): a bezier coloured by what flows (sample, or stock), the same thickness whether or not it carries
// a folded bundle (the bundle socket is the fat one; the wire is not). A wide transparent path takes the hover (the page shows the tooltip from its data-tip,
// lines made by wireTooltip) and Ctrl/⌘+click, which selects and centres the wire's origin. No label.
// The page marks wires `.hi` / `.dim` on the edge's own wrapper while a card is hovered (mapTokens.css).
const props = defineProps<{
	id: string;
	sourceX: number;
	sourceY: number;
	targetX: number;
	targetY: number;
	sourcePosition: Position;
	targetPosition: Position;
	data: { wire: Wire; tooltip: string[] };
}>();
defineOptions({ inheritAttrs: false });
const actions = useMapActions();

const path = computed(
	() =>
		getBezierPath({
			sourceX: props.sourceX,
			sourceY: props.sourceY,
			sourcePosition: props.sourcePosition,
			targetX: props.targetX,
			targetY: props.targetY,
			targetPosition: props.targetPosition,
		})[0],
);
const wire = computed(() => props.data.wire);
// The tooltip text, one line per fact; the page reads it from the hovered path (el.dataset.tip).
const tip = computed(() => props.data.tooltip.join('\n'));
const on = wireHandlers(actions, () => props.data.wire);
const colour = computed(() => (wire.value.flow === 'stock' ? 'var(--k-material)' : 'var(--k-sample)'));
</script>

<template>
	<g class="d1-wire" :style="{ '--k': colour }">
		<path class="wire" :class="`flow-${wire.flow}`" :d="path" />
		<path class="hit" :d="path" :data-tip="tip" @mouseenter="on.enter" @mouseleave="on.leave" @click="on.click" />
	</g>
</template>

<style scoped>
.wire { fill: none; stroke: color-mix(in srgb, var(--k) 70%, var(--theme--border-color)); stroke-width: 2.4px; }
.hit { fill: none; stroke: transparent; stroke-width: 14px; pointer-events: stroke; cursor: pointer; }
</style>
