<script setup lang="ts">
import { computed } from 'vue';
import { Handle } from '@vue-flow/core';
import type { JunctionNode } from '../model/types';
import { socketHandlers, useMapActions, useMapView } from './actions';
import { edgeStyle, handlePosition } from './handle';
import { KINDS, LINEAGE_LABEL, kindVar } from './kinds';

// Lineage with no operation behind it (spec D10): a small dashed card, the type as a pill, one input
// socket and an output per child with its fraction.
const props = defineProps<{ id: string; data: JunctionNode; selected?: boolean }>();
defineOptions({ inheritAttrs: false });
const { direction } = useMapView();
const actions = useMapActions();
const sock = (id: string) => socketHandlers(actions, () => id);

const style = KINDS.junction;
const label = computed(() => LINEAGE_LABEL[props.data.lineageType]);
const fraction = (f: number | null) => (f === null ? '' : String(Number(f.toPrecision(4))));
</script>

<template>
	<div class="node junction dashed" :class="{ focal: selected }" :style="{ '--k': kindVar(style), '--sk': 'var(--k-sample)' }">
		<Handle
			:id="data.in"
			class="sock"
			type="target"
			:position="handlePosition(direction, 'in')"
			:connectable="false"
			:style="edgeStyle(direction, 'in', 0, 1)"
			@mouseenter="sock(data.in).enter"
			@mouseleave="sock(data.in).leave"
		/>
		<div class="nb">
			<span class="kind k-ink k-tint"><v-icon :name="style.icon" x-small />{{ label }}</span>
			<span class="meta">No operation logged</span>
		</div>
		<div class="outs">
			<span v-for="o in data.outs" :key="o.socket" class="out">
				{{ fraction(o.fraction) }}
				<Handle
					:id="o.socket"
					class="sock row out"
					type="source"
					:position="handlePosition(direction, 'out')"
					:connectable="false"
					@mouseenter="sock(o.socket).enter"
					@mouseleave="sock(o.socket).leave"
				/>
			</span>
		</div>
	</div>
</template>

<style scoped>
.junction { width: 150px; cursor: default; }
.nb { padding: 10px 12px; display: flex; flex-direction: column; gap: 2px; align-items: flex-start; }
.meta { font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
.outs { display: flex; flex-direction: column; gap: 8px; padding: 0 12px 10px; font-size: var(--fs-xs, 11px); color: var(--d1-dim); text-align: right; }
.out { position: relative; min-height: 12px; font-variant-numeric: tabular-nums; }
</style>
