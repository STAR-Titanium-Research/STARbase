<script setup lang="ts">
import { computed } from 'vue';
import { getBezierPath, type Position } from '@vue-flow/core';
import type { Wire } from '../model/types';
import { useMapActions, useMapEdit, wireHandlers } from './actions';

// A wire (spec §6.3, D17): a bezier coloured by what flows (sample, or stock), the same thickness whether or not it carries
// a folded bundle (the bundle socket is the fat one; the wire is not). A wide transparent path takes the hover (the page shows the tooltip from its data-tip,
// lines made by wireTooltip) and Ctrl/⌘+click, which selects and centres the wire's origin. No label.
// The wire between two passes of an unstacked stack (`stackable`) is striped lengthwise, purple | white | purple: the same path
// stroked twice, its colour at full width and then the canvas colour at a third of it on top (the export reads both from the live style).
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

const edit = useMapEdit();
const bezier = computed(() =>
	getBezierPath({
		sourceX: props.sourceX,
		sourceY: props.sourceY,
		sourcePosition: props.sourcePosition,
		targetX: props.targetX,
		targetY: props.targetY,
		targetPosition: props.targetPosition,
	}),
);
const path = computed(() => bezier.value[0]);
/** Edit mode: the wire the person clicked, to be taken off with Delete; a wire of done records wears a lock and says why. */
const selected = computed(() => !!edit?.editing.value && edit.selectedWire.value === props.id);
const lock = computed(() => (selected.value ? (edit?.wireLock(props.id) ?? null) : null));
const wire = computed(() => props.data.wire);
// The tooltip text, one line per fact; the page reads it from the hovered path (el.dataset.tip).
const tip = computed(() => props.data.tooltip.join('\n'));
const on = wireHandlers(actions, () => props.data.wire, edit);
const colour = computed(() => (wire.value.flow === 'stock' ? 'var(--k-material)' : 'var(--k-sample)'));
</script>

<template>
	<g class="d1-wire" :class="{ sel: selected }" :style="{ '--k': colour }">
		<path class="wire" :class="[`flow-${wire.flow}`, { stackable: wire.stackable }]" :d="path" />
		<path v-if="wire.stackable" class="core" :d="path" />
		<path class="hit" :d="path" :data-tip="tip" @mouseenter="on.enter" @mouseleave="on.leave" @click="on.click" />
		<!-- A wire of done records: a padlock where it is, and the reason. -->
		<g v-if="lock" class="lock" role="img" :aria-label="lock" :transform="`translate(${bezier[1]} ${bezier[2]})`">
			<title>{{ lock }}</title>
			<rect x="-7" y="-2" width="14" height="10" rx="2" />
			<path d="M-4 -2 v-3 a4 4 0 0 1 8 0 v3" fill="none" />
		</g>
	</g>
</template>

<style scoped>
.wire { fill: none; stroke: color-mix(in srgb, var(--k) 70%, var(--theme--border-color)); stroke-width: 2.4px; }
.wire.stackable { stroke-width: 4.2px; }
.core { fill: none; stroke: var(--d1-surface, var(--theme--background)); stroke-width: 1.4px; pointer-events: none; }
.hit { fill: none; stroke: transparent; stroke-width: 14px; pointer-events: stroke; cursor: pointer; }
.sel .wire { stroke: var(--d1-accent, var(--theme--primary)); stroke-width: 4px; stroke-dasharray: 7 5; }
.lock rect { fill: var(--d1-surface); stroke: var(--d1-bad); stroke-width: 1.6px; }
.lock path { stroke: var(--d1-bad); stroke-width: 1.6px; }
</style>
