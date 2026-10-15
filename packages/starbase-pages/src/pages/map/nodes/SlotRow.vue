<script setup lang="ts">
import { computed, ref } from 'vue';
import { hasFan, slotKindOf } from '../model/collections';
import type { Ref as RecordRef, Slot } from '../model/types';
import { recordHandlers, refKey, stopping, useMapActions, useMapView } from './actions';
import { KINDS, kindVar } from './kinds';

// One slot of a container's Inside tray (spec D6): the role, and the record in it. A merged batch slot
// can hold several records (`values`): "N different", opening to a list; when only some rows of the
// batch have the slot (`partial`) it says "some rows" instead, never "different". Hovering or clicking
// a record asks the page for its hover card / rail by refKey.
const props = defineProps<{ item: Slot; open?: boolean; minor?: boolean }>();
const actions = useMapActions();
const view = useMapView();
const expanded = ref(!!props.open);

const values = computed(() => props.item.values ?? []);
const many = computed(() => !props.item.ref && values.value.length > 1);
// The record shown inline: the slot's own, or the only value of a merged slot.
const single = computed(() => props.item.ref ?? (values.value.length === 1 ? values.value[0] : null));
const summary = computed(() => (props.item.partial ? `${values.value.length} values` : `${values.value.length} different`));

const kind = computed(() => slotKindOf((single.value ?? values.value[0])?.collection ?? ''));
const color = computed(() => (kind.value ? kindVar(KINDS[kind.value]) : 'var(--k-file)'));
const icon = computed(() => (kind.value ? KINDS[kind.value].icon : 'link'));

const focal = computed(() => {
	const sel = view.selectedRef.value;
	return !!sel && (single.value ? [single.value] : values.value).some((r) => refKey(r) === sel);
});

const on = (r: RecordRef) => recordHandlers(actions, () => r);
// ＋ on the record: what else used it, merged beside this card (spec §7 "Expand"). Only records that have a used-in fan.
const fanOf = computed(() => (single.value && hasFan(single.value.collection) ? single.value : null));
const showFan = stopping(() => fanOf.value && actions.expand(refKey(fanOf.value)));
</script>

<template>
	<div class="slot-wrap">
		<div class="slot nodrag nopan" :class="{ focal, minor }" :style="{ '--k': color }">
			<span class="si k-ink k-tint"><v-icon :name="icon" x-small /></span>
			<span class="sr">{{ item.role }}</span>
			<span
				v-if="single"
				class="sc"
				role="button"
				tabindex="0"
				:data-map-id="refKey(single)"
				@mouseenter="on(single).enter"
				@mouseleave="on(single).leave"
				@click="on(single).select"
				@keydown="on(single).key"
				>{{ single.code }}</span
			>
			<button v-else-if="many" type="button" class="vals" :aria-expanded="expanded" @click.stop="expanded = !expanded">{{ summary }}</button>
			<span v-else class="sc none">none</span>
			<span v-if="item.partial" class="part">some rows</span>
			<button v-if="fanOf" class="xbtn nodrag nopan" type="button" :aria-label="`Show what else used ${fanOf.code}`" @click="showFan"><v-icon name="add" x-small /></button>
		</div>
		<ul v-if="many && expanded" class="vlist">
			<li
				v-for="v in values"
				:key="refKey(v)"
				class="sc nodrag nopan"
				role="button"
				tabindex="0"
				:data-map-id="refKey(v)"
				@mouseenter="on(v).enter"
				@mouseleave="on(v).leave"
				@click="on(v).select"
				@keydown="on(v).key"
			>
				{{ v.code }}
			</li>
		</ul>
	</div>
</template>

<style scoped>
.slot { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 8px; background: var(--d1-surface); border: 1px solid var(--d1-line); transition: border-color 0.12s; }
.slot:hover { border-color: var(--k); }
.slot.focal { outline: 2px solid var(--d1-accent, var(--theme--primary)); }
.slot.minor { background: transparent; border-color: transparent; padding: 3px 8px; }
.si { width: 22px; height: 22px; border-radius: 6px; display: grid; place-items: center; flex: none; }
.sr { font-size: var(--fs-xs, 11px); color: var(--d1-dim); max-width: 64px; flex: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sc { font-family: var(--theme--fonts--monospace--font-family, monospace); font-size: var(--fs-sm, 12px); font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; cursor: pointer; }
.minor .sc { font-weight: 600; font-family: inherit; }
.sc.none { color: var(--d1-dim); font-weight: 500; cursor: default; }
.sc:focus-visible, .vals:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 1px; border-radius: 4px; }
.vals { border: 0; padding: 0; background: transparent; color: var(--d1-accent, var(--theme--primary)); font: inherit; font-size: var(--fs-sm, 12px); font-weight: 600; cursor: pointer; }
.xbtn { margin-left: auto; width: 18px; height: 18px; }
.part + .xbtn { margin-left: 4px; }
.part { margin-left: auto; font-size: var(--fs-xs, 11px); color: var(--d1-dim); white-space: nowrap; }
.vlist { list-style: none; margin: 0 0 0 38px; padding: 0 0 0 8px; border-left: 2px solid var(--d1-line); display: flex; flex-direction: column; gap: 2px; }
.vlist .sc { display: block; padding: 1px 0; }
</style>
