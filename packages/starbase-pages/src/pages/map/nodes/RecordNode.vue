<script setup lang="ts">
import { computed } from 'vue';
import { Handle } from '@vue-flow/core';
import { StatusBadge } from '@d1/ui';
import type { SocketRef } from '../edit/socketRefs';
import type { RecordNode } from '../model/types';
import { cardHandlers, editSocketProps, freeSocketLabel, useExpanded, useHiddenSides, useMapActions, useMapEdit, useMapView, useSocketBinder } from './actions';
import { edgeStyle, handlePosition } from './handle';
import HiddenPill from './HiddenPill.vue';
import { KINDS, kindVar, slotText, statusKindOf } from './kinds';

// A record as a card (spec §6.2): kind pill, status badge, ＋, code and one meta line. Sockets are
// Handles on the edges; a click on the body selects it, the ＋ button expands it and, once open, is − to collapse it.
const props = defineProps<{ id: string; data: RecordNode; selected?: boolean }>();
defineOptions({ inheritAttrs: false });
const actions = useMapActions();
const { direction } = useMapView();

const style = computed(() => KINDS[props.data.kind]);
// Stock flows (lots, powder batches, material) wire in the material colour, samples in the sample colour.
const flow = computed(() => (['stock_lot', 'powder_batch', 'material'].includes(props.data.kind) ? 'var(--k-material)' : 'var(--k-sample)'));
const open = useExpanded(() => props.id);
// A tool, a campaign or a material is named by its name (the full name in the title when the card clips it); its code moves to the meta line.
const name = computed(() => slotText(props.data.ref));
const meta = computed(() => (name.value !== props.data.ref.code ? [props.data.ref.code, props.data.meta].filter(Boolean).join(' · ') : props.data.meta));
const card = cardHandlers(actions, () => props.id, () => open.value);
const bind = useSocketBinder();
const hiddenSides = useHiddenSides(() => props.id);

// Edit mode (spec E8): a sample's output is the place to build from, whatever else is wired to it; a new sample with nothing making it
// has a free input, where an operation's output can be dropped. Both are `SocketRef`s the page resolves against the draft.
const edit = useMapEdit();
const isSample = computed(() => props.data.kind === 'sample');
const outRef = computed<SocketRef | null>(() => (isSample.value ? { kind: 'sample', id: props.data.ref.id, side: 'out' } : null));
const inRef = computed<SocketRef | null>(() => (isSample.value && props.data.draft ? { kind: 'sample', id: props.data.ref.id, side: 'in' } : null));
const freeIn = computed(() => !!edit?.editing.value && !!inRef.value && props.data.ins.length === 0);
const badge = computed(() => (edit?.editing.value ? edit.badge(props.data) : null));
const freeInProps = computed(() => (edit && inRef.value ? editSocketProps(edit, inRef.value) : {}));
</script>

<template>
	<div
		class="node rec"
		:class="{ planned: data.planned, draft: data.draft, focal: selected }"
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
			v-bind="bind(s, 'in', inRef)"
			:connectable="false"
			:style="edgeStyle(direction, 'in', i, data.ins.length)"
		/>
		<button
			v-if="freeIn"
			type="button"
			class="sock free nodrag nopan"
			:style="edgeStyle(direction, 'in', 0, 1)"
			:aria-label="freeSocketLabel('in', data.ref.code)"
			v-bind="freeInProps"
		></button>
		<HiddenPill v-for="side in hiddenSides" :key="side" :side="side" />
		<div class="nb">
			<div class="ntop">
				<span class="kind k-ink k-tint"><v-icon :name="style.icon" x-small />{{ style.label }}</span>
				<StatusBadge class="st" :kind="statusKindOf(data.kind)" :value="data.status" />
				<span v-if="badge" class="chk" role="img" :aria-label="badge.text" :title="badge.text">{{ badge.count }}</span>
				<button class="xbtn nodrag nopan" type="button" :aria-label="open ? 'Collapse' : 'Expand'" @click="card.expand"><v-icon :name="open ? 'remove' : 'add'" x-small /></button>
			</div>
			<div class="code" :title="name">{{ name }}</div>
			<div v-if="data.kind === 'sample' && data.ref.label" class="nick" :title="data.ref.label">{{ data.ref.label }}</div>
			<div v-if="meta" class="meta">{{ meta }}</div>
		</div>
		<Handle
			v-for="(s, i) in data.outs"
			:id="s"
			:key="s"
			class="sock"
			type="source"
			:position="handlePosition(direction, 'out')"
			v-bind="bind(s, 'out', outRef)"
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
.ntop .st + .chk, .ntop .kind + .chk { margin-left: 6px; }
.code { font-family: var(--theme--fonts--monospace--font-family, monospace); font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.nick { font-size: var(--fs-sm, 12px); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.meta { font-size: var(--fs-sm, 12px); color: var(--d1-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
