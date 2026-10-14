<script setup lang="ts">
import { computed, reactive } from 'vue';
import '../components/tokens.css';
import FormNodeView from './FormNodeView.vue';
import { effectiveValues, fieldViews, formTree, toFormFields, withValue } from './fieldModel';
import type { FieldDef, FormField } from './fieldModel';
import type { RuleContext, Values } from './conditions';

// STARbase's own form, generated from a collection's Directus field definitions (ADR-0018, spec 7.3): the Field
// groups as headed sections, each field drawn by its interface, required marks and conditions (hidden, read-only,
// required) applied live to what is entered. v-model is the record's values object; only fields the person has
// changed or filled are in it. `inherited` values (a campaign's project, an alloy from the method) show greyed in
// an empty field and are replaced by typing; clearing the field goes back to them. A field it cannot draw shows
// its value and "Open in Data Studio" (openExternal). Reads (record pickers) go through the host's API.
const props = withDefaults(
	defineProps<{
		/** The collection the fields belong to (names the form's ids). */
		collection: string;
		/** The field definitions as Directus sends them, or FormField[] already made by toFormFields. */
		fields: readonly (FieldDef | FormField)[];
		modelValue: Values;
		inherited?: Values;
		readonly?: boolean;
		/** Mark every required field that is empty (set after a failed Create), not only those the person has been into. */
		showMissing?: boolean;
		/** What `$CURRENT_USER` and `$NOW` in a field's conditions mean; without it a rule using one never matches. */
		context?: RuleContext;
	}>(),
	{ inherited: undefined, readonly: false, showMissing: false, context: undefined },
);
const emit = defineEmits<{
	(e: 'update:modelValue', value: Values): void;
	(e: 'openExternal', field: FormField): void;
}>();

const isFormField = (f: FieldDef | FormField): f is FormField => typeof (f as FormField).kind === 'string' && Array.isArray((f as FormField).conditions);
const formFields = computed<FormField[]>(() => {
	const list = props.fields;
	return list.length && list.every(isFormField) ? (list as FormField[]) : toFormFields(list as FieldDef[]);
});
const tree = computed(() => formTree(formFields.value));
// Conditions read what is shown: the person's value, else the inherited one.
const views = computed(() => fieldViews(formFields.value, effectiveValues(props.modelValue, props.inherited), { context: props.context }));
const touched = reactive(new Set<string>());
const idPrefix = `d1-form-${props.collection}`;

function change(field: FormField, value: unknown): void {
	emit('update:modelValue', withValue(props.modelValue, field.field, value));
}
</script>

<template>
	<form class="d1-field-form d1-kit" novalidate @submit.prevent>
		<FormNodeView
			v-for="node in tree"
			:key="node.field.field"
			:node="node"
			:views="views"
			:own="modelValue"
			:inherited="inherited"
			:readonly="readonly"
			:show-missing="showMissing"
			:touched="touched"
			:id-prefix="idPrefix"
			:level="0"
			@change="change"
			@touch="touched.add($event.field)"
			@open-external="emit('openExternal', $event)"
		/>
	</form>
</template>

<style scoped>
.d1-field-form { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
</style>
