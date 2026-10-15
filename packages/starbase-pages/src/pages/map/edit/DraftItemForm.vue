<script setup lang="ts">
import { computed } from 'vue';
import { FieldForm, toFormFields } from '@d1/ui';
import type { DraftItem, FieldDef, FormField, FormValues } from '@d1/ui';
import { collectionFor, formDefsFor, TEXT_OVERRIDES } from './draftForm';

// STARbase's own form for one item of a draft (spec E15, E17), over the kit's FieldForm. The item's `values` are the v-model:
// only what the person set (a new record: all its fields; an existing one: the changes), so `update` carries the item's
// complete new values, ready for the draft's setValues. Left out: what the draft sets itself (the wires, the work state,
// who and when, the batch) and, on a new record, the codes (numbered at Create). The codes and the process category show as
// read-only text. `inherited` values (a new output sample's material and form from its input, E15) show greyed and are
// replaced by typing. `compact` draws only `keyFields`: the key settings a container shows inline.
const props = withDefaults(
	defineProps<{
		item: DraftItem;
		/** The raw `/fields/<collection>` rows of the item's collection. */
		fieldDefs: unknown[];
		/** Greyed, overridable values: a new sample's inheritance, or an existing record's fields as they stand. */
		inherited?: Record<string, unknown>;
		compact?: boolean;
		/** With `compact`: the fields to draw (see `keySettingsFor`). */
		keyFields?: string[];
		readonly?: boolean;
	}>(),
	{ inherited: undefined, compact: false, keyFields: undefined, readonly: false },
);
const emit = defineEmits<{
	/** The item's complete new values. */
	update: [values: Record<string, unknown>];
	/** A field the form cannot draw: show its value and "Open in Data Studio". */
	openExternal: [field: FormField];
}>();

const collection = computed(() => collectionFor(props.item));
const fields = computed(() =>
	toFormFields(formDefsFor(props.fieldDefs, props.item, { compact: props.compact, keyFields: props.keyFields }) as FieldDef[], { override: TEXT_OVERRIDES }),
);
</script>

<template>
	<FieldForm
		:class="['pm-item-form', { compact }]"
		:collection="`${collection}-${item.key}`"
		:fields="fields"
		:model-value="item.values as FormValues"
		:inherited="inherited as FormValues | undefined"
		:readonly="readonly"
		@update:model-value="emit('update', $event)"
		@open-external="emit('openExternal', $event)"
	/>
</template>
