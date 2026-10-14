<script setup lang="ts">
import { computed } from 'vue';
import { Handle } from '@vue-flow/core';
import { StatusBadge } from '@d1/ui';
import type { RecordNode } from '../model/types';
import { cardHandlers, useHiddenSides, useMapActions, useMapView, useSocketProps } from './actions';
import { edgeStyle, handlePosition } from './handle';
import HiddenPill from './HiddenPill.vue';
import { KINDS, kindVar, statusKindOf } from './kinds';

// A record as a card (spec §6.2): kind pill, status badge, ＋, code and one meta line. Sockets are
// Handles on the edges; a click on the body selects it, the ＋ button expands it.
const props = defineProps<{ id: string; data: RecordNode; selected?: boolean }>();
defineOptions({ inheritAttrs: false });
const actions = useMapActions();
const { direction } = useMapView();

const style = computed(() => KINDS[props.data.kind]);
// Stock flows (lots, powder batches, material) wire in the material colour, samples in the sample colour.
const flow = computed(() => (['stock_lot', 'powder_batch', 'material'].includes(props.data.kind) ? 'var(--k-material)' : 'var(--k-sample)'));
const card = cardHandlers(actions, () => props.id);
const sockProps = useSocketProps();
const hiddenSides = useHiddenSides(() => props.id);
</script>

<template>
	<div
		class="node rec"
		:class="{ focal: selected }"
		:style="{ '--k': kindVar(style), '--sk': flow }"
		@click="card.select"
		@mouseenter="card.enter"
		@mouseleave="card.leave"
	>
		<Handle
			v-for="(s, i) in data.ins"
			:id="s"
			:key="s"
			class="sock"
			type="target"
			:position="handlePosition(direction, 'in')"
			v-bind="sockProps(s, 'in')"
			:connectable="false"
			:style="edgeStyle(direction, 'in', i, data.ins.length)"
		/>
		<HiddenPill v-for="side in hiddenSides" :key="side" :side="side" />
		<div class="nb">
			<div class="ntop">
				<span class="kind k-ink k-tint"><v-icon :name="style.icon" x-small />{{ style.label }}</span>
				<StatusBadge class="st" :kind="statusKindOf(data.kind)" :value="data.status" />
				<button class="xbtn nodrag nopan" type="button" aria-label="Expand" @click="card.expand"><v-icon name="add" x-small /></button>
			</div>
			<div class="code">{{ data.ref.code }}</div>
			<div v-if="data.meta" class="meta">{{ data.meta }}</div>
		</div>
		<Handle
			v-for="(s, i) in data.outs"
			:id="s"
			:key="s"
			class="sock"
			type="source"
			:position="handlePosition(direction, 'out')"
			v-bind="sockProps(s, 'out')"
			:connectable="false"
			:style="edgeStyle(direction, 'out', i, data.outs.length)"
		/>
	</div>
</template>

<style scoped>
.nb { padding: 10px 12px; display: flex; flex-direction: column; gap: 4px; }
.ntop { display: flex; align-items: center; gap: 6px; }
.ntop .st { margin-left: auto; }
.ntop .kind + .xbtn { margin-left: auto; }
.code { font-family: var(--theme--fonts--monospace--font-family, monospace); font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.meta { font-size: var(--fs-sm, 12px); color: var(--d1-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
