<script setup lang="ts">
import { computed, nextTick, watch } from 'vue';
import type { DraftItem } from '@d1/ui';
import { KINDS, kindVar } from '../nodes/kinds';
import { cardFieldNames, cardSegments, flaggedFields, readonlyOnCard, type SlotKind } from './cardFields';
import { collectionOf } from './checks';
import DraftItemForm from './DraftItemForm.vue';
import { inheritedValues } from './inherit';
import { withCategory } from './railForm';
import { useEditRail } from './railContext';
import { useEditModeInjected } from './useEditMode';

// The fields of a new draft card, typed on the card itself (spec K4, K5, K6, K8): a sample's name, material, geometry and "Made by"; an
// operation's or test's machine, date and key settings (its kind is the dropdown under the header). The values are the draft item's own,
// the ones the side panel's form edits (`edit.setValues`, as EditRailItem does), so typing in one shows in the other. What the checks
// say is missing is amber (and counted in the card's header); a relation (the machine, a tool...) is a slot row with its icon, as in the
// Inside tray. The card draws it and reports when it grew, so the canvas makes room round it (R6).
const props = defineProps<{ item: DraftItem }>();
const emit = defineEmits<{ grew: [] }>();
const edit = useEditModeInjected();
const rail = useEditRail();

const collection = computed(() => collectionOf(props.item));
const defs = computed(() => edit?.catalog.rawFields.value[collection.value] ?? []);
const inherited = computed(() => (props.item.kind === 'sample' && edit ? inheritedValues(edit.body.value, props.item.key, edit.catalog.ctx()).values : undefined));
/** Nothing until the form's field definitions have been read (the card would show an empty box). */
const fields = computed(() => (edit ? cardFieldNames(props.item, edit.body.value, { form: defs.value, required: edit.catalog.ctx().fields?.[collection.value] }) : []));
const segments = computed(() => cardSegments(fields.value));
const flagged = computed(() => (edit ? flaggedFields(edit.checks.value, props.item.key, edit.body.value) : []));
const readonlyFields = computed(() => (edit ? readonlyOnCard(props.item, edit.body.value) : []));
const ready = computed(() => fields.value.length > 0);
/** What every form on the card is given; each segment adds only its own fields. */
const shared = computed(() => ({ item: props.item, fieldDefs: defs.value, inherited: inherited.value, compact: true, flagged: flagged.value, readonlyFields: readonlyFields.value }));

const slotStyle = (slot: SlotKind) => ({ '--k': kindVar(KINDS[slot]) });

function update(values: Record<string, unknown>): void {
	if (!edit) return;
	edit.setValues(props.item.key, withCategory(props.item, values, (id) => edit.catalog.methodById.value.get(id)?.category ?? undefined));
}

// The card grows when its fields first appear or its kind changes them: it is measured and room is made (the page does that on `grew`).
watch(() => [ready.value, fields.value.join()], () => ready.value && void nextTick(() => emit('grew')), { immediate: true, flush: 'post' });

/** Escape leaves the field and keeps the card selected (K5); it does not reach anything that clears the selection. */
function leave(e: KeyboardEvent): void {
	(e.target as HTMLElement | null)?.blur?.();
}
/** "All fields in the side panel": the card is selected and the panel's form takes the focus. */
async function openPanel(): Promise<void> {
	rail?.select(props.item.key);
	await nextTick();
	document.querySelector<HTMLElement>('.pm-item .d1-field-form [data-field] :is(input, select, textarea)')?.focus();
}
</script>

<template>
	<div v-if="ready" class="card-fields nodrag nopan nowheel" :data-fields-for="item.key" @dblclick.stop @keydown.esc.stop="leave">
		<template v-for="(seg, i) in segments" :key="i">
			<div v-if="seg.slot" class="slotrow" :style="slotStyle(seg.slot)">
				<span class="si k-ink k-tint"><v-icon :name="KINDS[seg.slot].icon" x-small /></span>
				<DraftItemForm v-bind="shared" :key-fields="seg.fields" :id-scope="`card${i}`" @update="update" />
			</div>
			<DraftItemForm v-else v-bind="shared" :key-fields="seg.fields" :id-scope="`card${i}`" @update="update" />
		</template>
		<button type="button" class="all" @click.stop="openPanel">All fields in the side panel</button>
	</div>
</template>

<style scoped>
.card-fields { display: flex; flex-direction: column; gap: 6px; margin: 6px 10px 10px; padding: 8px; border-radius: 10px; background: var(--d1-tile); border: 1px solid var(--d1-line); cursor: default; font-size: var(--fs-sm, 12px); text-align: left; }
.card-fields :deep(.d1-field-form) { gap: 6px; min-width: 0; flex: 1; }
.card-fields :deep(.row) { gap: 2px; }
.card-fields :deep(.lab) { font-size: var(--fs-xs, 11px); font-weight: 600; color: var(--d1-dim); }
.card-fields :deep(.ctl), .card-fields :deep(.sel), .card-fields :deep(.q) { padding: 3px 6px; font-size: var(--fs-sm, 12px); min-height: 0; }
/* The message under a field is for screen readers (the label's asterisk and the header's count say it on screen). */
.card-fields :deep(.miss) { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.card-fields :deep(.row) { position: relative; }

/* Missing, in amber: the field's border and tint, and the asterisk (never colour alone). */
.card-fields :deep(.row.flag .ctl), .card-fields :deep(.row.flag .sel), .card-fields :deep(.row.flag .q) { border-color: var(--theme--warning); background: color-mix(in srgb, var(--theme--warning) 12%, var(--d1-surface)); }
/* Red on a card is only for what the server would refuse (the header's chip): a required field the person has been into and left empty is amber too. */
.card-fields :deep(.row.missing .ctl), .card-fields :deep(.row.missing .sel), .card-fields :deep(.row.missing .q) { border-color: var(--theme--warning); }
.card-fields :deep(.req) { color: var(--d1-dim); }
.card-fields :deep(.row.flag .req), .card-fields :deep(.row.missing .req) { color: color-mix(in srgb, var(--theme--warning) 72%, var(--theme--foreground)); }

/* A relation (the machine, a tool, an insert edge, a recipe) is a slot row with its icon, as in the Inside tray. */
.slotrow { display: flex; align-items: flex-start; gap: 8px; padding: 5px 8px; border-radius: 8px; background: var(--d1-surface); border: 1px solid var(--d1-line); }
.slotrow:focus-within { border-color: var(--k); }
.si { width: 22px; height: 22px; margin-top: 14px; border-radius: 6px; display: grid; place-items: center; flex: none; }

.all { align-self: flex-start; padding: 0; border: 0; background: none; font: inherit; font-size: var(--fs-xs, 11px); font-weight: 600; color: var(--d1-accent, var(--theme--primary)); cursor: pointer; text-decoration: underline; }
.all:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 2px; border-radius: 4px; }
</style>
