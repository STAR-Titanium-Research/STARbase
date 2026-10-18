<script setup lang="ts">
import { computed } from 'vue';
import { Section, type FormField } from '@d1/ui';
import { collectionOf, recordKey } from './checks';
import DraftItemForm from './DraftItemForm.vue';
import { inheritedValues } from './inherit';
import { formTitle, keyFieldsFor, withCategory } from './railForm';
import { useEditRail } from './railContext';
import { useEditModeInjected } from './useEditMode';

// The rail's form for the draft item selected on the canvas (spec E17, §7.1): its key settings first, every other field under
// "All fields". D2's DraftItemForm draws them from the Directus field definitions; what the person types goes to the draft as setValues.
// An existing record is edited over its loaded values (the draft keeps the differences); a new output sample shows what it inherits
// greyed (E15). Nothing is drawn outside edit mode, or when no item of the draft is selected.
const edit = useEditModeInjected();
const rail = useEditRail();

const item = computed(() => (edit?.editing.value ? edit.selectedItem.value : null));
const collection = computed(() => (item.value ? collectionOf(item.value) : null));
const defs = computed(() => (collection.value ? (edit?.catalog.rawFields.value[collection.value] ?? []) : []));
const current = computed(() => (item.value?.existing && collection.value ? edit?.catalog.records.get(recordKey(collection.value, item.value.existing.id))?.values : undefined));
const inherited = computed(() => (item.value && !item.value.existing && item.value.kind === 'sample' && edit ? inheritedValues(edit.body.value, item.value.key, edit.catalog.ctx()).values : undefined));
const keyFields = computed(() => (item.value ? keyFieldsFor(item.value, current.value) : []));
/** An existing record is edited once it has been read: until then the form would show it empty. */
const ready = computed(() => !!item.value && (!item.value.existing || !!current.value));

function update(values: Record<string, unknown>) {
	const it = item.value;
	if (!it || !edit) return;
	edit.setValues(it.key, withCategory(it, values, (id) => edit.catalog.methodById.value.get(id)?.category ?? undefined));
}
function external(field: FormField) {
	if (item.value) rail?.openExternal(item.value.key, field);
}
</script>

<template>
	<template v-if="item && ready">
		<Section :title="`${formTitle(item)}: key settings`" class="pm-item">
			<DraftItemForm
				:item="item"
				:field-defs="defs"
				:inherited="inherited"
				:current="current"
				compact
				:key-fields="keyFields"
				:show-missing="rail?.showMissing.value"
				@update="update"
				@open-external="external"
			/>
		</Section>
		<Section :title="`${formTitle(item)}: all fields`" collapsible collapsed class="pm-item">
			<DraftItemForm :item="item" :field-defs="defs" :inherited="inherited" :current="current" :show-missing="rail?.showMissing.value" @update="update" @open-external="external" />
		</Section>
	</template>
	<p v-else-if="item" class="pm-item-wait" role="status">Reading the record…</p>
</template>

<style scoped>
.pm-item-wait { margin: 0; padding: 10px 14px; color: var(--d1-dim); font-size: var(--fs-sm, 12px); }
</style>
