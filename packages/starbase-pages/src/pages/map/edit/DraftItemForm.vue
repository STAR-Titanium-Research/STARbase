<script setup lang="ts">
import { computed } from 'vue';
import { FieldForm, toFormFields } from '@d1/ui';
import type { DraftItem, FieldDef, FormField, FormValues } from '@d1/ui';
import { collectionFor, existingModel, existingPatch, formDefsFor, inheritedFor, patchOf, TEXT_OVERRIDES } from './draftForm';

// STARbase's own form for one item of a draft (spec E15, E17), over the kit's FieldForm. The item's `values` are the v-model:
// only what the person set (a new record: all its fields; an existing one: the changes), and `update` carries a patch ready for
// the draft's setValues (a cleared field is part of it, see patchOf). Left out: what d1-build refuses in a draft (the wires,
// the work state, who and when, the batch, a sample's status, a test's subject), the date a planned record was done, and on a
// new record the codes (numbered at Create). The codes and the process category show as
// read-only text. `inherited` values (a new output sample's material and form from its input, E15) show greyed and are
// replaced by typing. `compact` draws only `keyFields`: the key settings a container shows inline.
const props = withDefaults(
	defineProps<{
		item: DraftItem;
		/** The raw `/fields/<collection>` rows of the item's collection. */
		fieldDefs: unknown[];
		/** Greyed, overridable values: a new sample's inheritance (E15). */
		inherited?: Record<string, unknown>;
		/**
		 * An existing record's fields as loaded. Given, the form edits the record itself (its values with the draft's changes over
		 * them) and `update` keeps in the draft only what differs; clearing a field the record has writes `null` at Create.
		 */
		current?: Record<string, unknown>;
		compact?: boolean;
		/** With `compact`: the fields to draw (see `keySettingsFor`). */
		keyFields?: string[];
		readonly?: boolean;
		/** Mark every required field that is empty (after a failed Create), not only those the person has been into. */
		showMissing?: boolean;
	}>(),
	{ inherited: undefined, current: undefined, compact: false, keyFields: undefined, readonly: false, showMissing: false },
);
const emit = defineEmits<{
	/**
	 * A change for the draft's `setValues` (which merges): the item's values as they now are, and a cleared field as `undefined`
	 * (removed from a new record) or `null` (an existing record's field written as empty at Create).
	 */
	update: [values: Record<string, unknown>];
	/** A field the form cannot draw: show its value and "Open in Data Studio". */
	openExternal: [field: FormField];
}>();

const collection = computed(() => collectionFor(props.item));
const editsRecord = computed(() => !!props.item.existing && !!props.current);
const model = computed(() => (editsRecord.value ? existingModel(props.item, props.current!) : props.item.values));
function onUpdate(next: Record<string, unknown>) {
	emit('update', editsRecord.value ? existingPatch(props.item, props.current!, next) : patchOf(props.item, next));
}
const fields = computed(() =>
	toFormFields(formDefsFor(props.fieldDefs, props.item, { compact: props.compact, keyFields: props.keyFields }) as FieldDef[], { override: TEXT_OVERRIDES }),
);
</script>

<template>
	<FieldForm
		:key="item.key"
		:class="['pm-item-form', { compact }]"
		:collection="`${collection}-${item.key}`"
		:fields="fields"
		:model-value="model as FormValues"
		:inherited="(editsRecord ? undefined : inheritedFor(item, inherited)) as FormValues | undefined"
		:readonly="readonly"
		:show-missing="showMissing"
		@update:model-value="onUpdate($event)"
		@open-external="emit('openExternal', $event)"
	/>
</template>
