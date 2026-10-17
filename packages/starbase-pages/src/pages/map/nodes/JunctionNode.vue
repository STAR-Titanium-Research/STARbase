<script setup lang="ts">
import { computed } from 'vue';
import { Handle } from '@vue-flow/core';
import type { JunctionNode } from '../model/types';
import { useMapView, useSocketProps } from './actions';
import { edgeStyle, handlePosition } from './handle';
import { KINDS, LINEAGE_LABEL, kindVar } from './kinds';

// Lineage with no operation behind it (spec D10): a small dashed card, the type as a pill, one input
// socket and an output per child with its fraction.
const props = defineProps<{ id: string; data: JunctionNode; selected?: boolean }>();
defineOptions({ inheritAttrs: false });
const { direction } = useMapView();
const sockProps = useSocketProps();

const style = KINDS.junction;
const label = computed(() => LINEAGE_LABEL[props.data.lineageType]);
const fraction = (f: number | null) => (f === null ? '' : String(Number(f.toPrecision(4))));

// Pointing down, the outputs are not rows (a row each would make a tall empty card with every socket bunched in a corner): they sit
// along the bottom edge, 18 px apart, and the card widens to fit them. Up to 6 outputs have a small fraction label above their socket;
// with more there is no room for labels, and the fraction is in the socket's title (hover).
const SOCKET_PITCH = 18;
const MIN_WIDTH = 150;
const MAX_LABELLED = 6;
const down = computed(() => direction.value === 'DOWN');
const downWidth = computed(() => Math.max(MIN_WIDTH, props.data.outs.length * SOCKET_PITCH + 24));
const labelled = computed(() => props.data.outs.length <= MAX_LABELLED);
const along = (i: number) => `${((i + 1) / (props.data.outs.length + 1)) * 100}%`;
</script>

<template>
	<div class="node junction dashed" :class="{ focal: selected }" :style="{ '--k': kindVar(style), '--sk': 'var(--k-sample)', ...(down ? { width: `${downWidth}px` } : {}) }">
		<Handle
			:id="data.in"
			class="sock"
			type="target"
			:position="handlePosition(direction, 'in')"
			:connectable="false"
			:style="edgeStyle(direction, 'in', 0, 1)"
			v-bind="sockProps(data.in, 'in')"
		/>
		<div class="nb">
			<span class="kind k-ink k-tint"><v-icon :name="style.icon" x-small />{{ label }}</span>
			<span class="meta">No operation logged</span>
		</div>
		<!-- One full-width row per output; the socket sits on the card's output edge (right edge level with its row, or bottom edge spread across the card),
		     not inside the label, so an empty fraction cannot pull it into the card. -->
		<div class="outs" :class="{ down }" :style="down ? { height: labelled ? '24px' : '8px' } : undefined">
			<div v-for="(o, i) in data.outs" :key="o.socket" class="out" :class="{ across: down }">
				<span v-if="!down" class="frac">{{ fraction(o.fraction) }}</span>
				<span v-else-if="labelled && o.fraction !== null" class="dfrac" :style="{ left: along(i) }">{{ fraction(o.fraction) }}</span>
				<Handle
					:id="o.socket"
					class="sock"
					type="source"
					:position="handlePosition(direction, 'out')"
					:connectable="false"
					:style="down ? edgeStyle(direction, 'out', i, data.outs.length) : edgeStyle(direction, 'out', 0, 1)"
					:title="down && o.fraction !== null ? fraction(o.fraction) : undefined"
					v-bind="sockProps(o.socket, 'out')"
				/>
			</div>
		</div>
	</div>
</template>

<style scoped>
.junction { width: 150px; cursor: default; }
.nb { padding: 10px 12px; display: flex; flex-direction: column; gap: 2px; align-items: flex-start; }
.meta { font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
.outs { display: flex; flex-direction: column; padding: 0 0 10px; font-size: var(--fs-xs, 11px); color: var(--d1-dim); text-align: right; }
/* A full-width row, so its socket (left: 100%) is on the card's right edge. Pointing down, the row steps aside so the socket resolves against the card. */
.out { position: relative; min-height: 16px; padding: 0 12px; font-variant-numeric: tabular-nums; }
.out.across { position: static; }
.frac { display: block; min-height: 16px; }
/* Pointing down: no rows. The zero-padding strip only keeps room for the labels under the card's text; a label sits above its socket on the bottom edge. */
.outs.down { padding: 0; }
.outs.down .out { min-height: 0; padding: 0; }
.dfrac { position: absolute; bottom: 4px; transform: translateX(-50%); line-height: 1; }
</style>
