<script setup lang="ts">
import { computed, ref } from 'vue';
import { hasFan } from '../model/fans';
import type { Ref as RecordRef, Slot } from '../model/types';
import { recordHandlers, refKey, stopping, useMapActions, useMapView } from './actions';
import { KINDS, kindOfCollection, kindVar, slotText } from './kinds';

// One slot of a container's Inside tray (spec D6): a chip with the role and the record in it. The whole chip
// is the record: hovering anywhere on it asks the page for its hover card, clicking selects it in the rail.
// A merged batch slot can hold several records (`values`): "N different", opening to a list; when only some
// rows of the batch have the slot (`partial`) it says "some rows" instead, never "different".
const props = defineProps<{ item: Slot; open?: boolean; minor?: boolean }>();
const actions = useMapActions();
const view = useMapView();
const expanded = ref(!!props.open);

const values = computed(() => props.item.values ?? []);
const many = computed(() => !props.item.ref && values.value.length > 1);
// The record shown inline: the slot's own, or the only value of a merged slot.
const single = computed(() => props.item.ref ?? (values.value.length === 1 ? values.value[0] : null));
const summary = computed(() => (props.item.partial ? `${values.value.length} values` : `${values.value.length} different`));

const kind = computed(() => kindOfCollection((single.value ?? values.value[0])?.collection ?? ''));
const color = computed(() => (kind.value ? kindVar(KINDS[kind.value]) : 'var(--k-file)'));
const icon = computed(() => (kind.value ? KINDS[kind.value].icon : 'link'));

const focal = computed(() => {
	const sel = view.selectedRef.value;
	return !!sel && (single.value ? [single.value] : values.value).some((r) => refKey(r) === sel);
});

const on = (r: RecordRef) => recordHandlers(actions, () => r);
/** What the chip binds when it stands for one record: a button by role, named for the canvas keydown. */
const chip = computed(() => {
	const r = single.value;
	if (!r) return {};
	const h = on(r);
	return { role: 'button', tabindex: 0, 'data-map-id': refKey(r), onMouseenter: h.enter, onMouseleave: h.leave, onClick: h.select, onKeydown: h.key };
});
// ＋ on the record: what else used it, merged beside this card (spec §7 "Expand"); − once open takes it away again.
// Only records that have a used-in fan.
const fanOf = computed(() => (single.value && hasFan(single.value.collection) ? single.value : null));
const fanOpen = computed(() => !!fanOf.value && !!view.expanded?.value.has(refKey(fanOf.value)));
const toggleFan = stopping(() => {
	if (!fanOf.value) return;
	if (fanOpen.value) actions.collapse?.(refKey(fanOf.value));
	else actions.expand(refKey(fanOf.value));
});
</script>

<template>
	<div class="slot-wrap">
		<div class="slot nodrag nopan" :class="{ focal, one: !!single }" :style="{ '--k': color }" v-bind="chip">
			<span class="si k-ink k-tint"><v-icon :name="icon" x-small /></span>
			<span class="sr">{{ item.role }}</span>
			<span v-if="single" class="sc">{{ slotText(single) }}</span>
			<button v-else-if="many" type="button" class="vals" :aria-expanded="expanded" @click.stop="expanded = !expanded">{{ summary }}</button>
			<span v-else class="sc none">none</span>
			<span v-if="item.partial" class="part">some rows</span>
			<button
				v-if="fanOf"
				class="xbtn nodrag nopan"
				type="button"
				:aria-label="fanOpen ? `Hide what else used ${slotText(fanOf)}` : `Show what else used ${slotText(fanOf)}`"
				@click="toggleFan"
			>
				<v-icon :name="fanOpen ? 'remove' : 'add'" x-small />
			</button>
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
				{{ slotText(v) }}
			</li>
		</ul>
	</div>
</template>

<style scoped>
.slot { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 8px; background: var(--d1-surface); border: 1px solid var(--d1-line); transition: border-color 0.12s; }
.slot.one { cursor: pointer; }
.slot:hover { border-color: var(--k); }
.slot.focal { outline: 2px solid var(--d1-accent, var(--theme--primary)); }
.slot:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 1px; }
.si { width: 22px; height: 22px; border-radius: 6px; display: grid; place-items: center; flex: none; }
.sr { font-size: var(--fs-xs, 11px); color: var(--d1-dim); width: 64px; flex: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sc { font-family: var(--theme--fonts--monospace--font-family, monospace); font-size: var(--fs-sm, 12px); font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.sc.none { color: var(--d1-dim); font-weight: 500; }
.vals:focus-visible, .vlist .sc:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 1px; border-radius: 4px; }
.vals { border: 0; padding: 0; background: transparent; color: var(--d1-accent, var(--theme--primary)); font: inherit; font-size: var(--fs-sm, 12px); font-weight: 600; cursor: pointer; }
.xbtn { margin-left: auto; width: 18px; height: 18px; }
.part + .xbtn { margin-left: 4px; }
.part { margin-left: auto; font-size: var(--fs-xs, 11px); color: var(--d1-dim); white-space: nowrap; }
.vlist { list-style: none; margin: 0 0 0 38px; padding: 0 0 0 8px; border-left: 2px solid var(--d1-line); display: flex; flex-direction: column; gap: 2px; }
.vlist .sc { display: block; padding: 1px 0; cursor: pointer; }
</style>
