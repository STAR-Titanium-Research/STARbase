<script setup lang="ts">
// The target step of an Edit <field> action: the new value (a choice, a link, yes / no or a date), and "Clear value" where the column
// may be empty. Drawn by BulkDialog; the state lives in useBulkActions.
import { computed } from 'vue';
import type { BulkField, IndexDef } from '../index/indexConfig';
import { canClear, enumChoices, lower } from './bulkModel';
import type { BulkState } from './useBulkActions';

const props = defineProps<{ bulk: BulkState; def: IndexDef; field: BulkField }>();

const fieldName = computed(() => lower(props.field.label));
const selected = computed(() => {
	const choice = props.bulk.dialog?.choice;
	return choice && choice.value !== null ? String(choice.value) : '';
});
const cleared = computed(() => props.bulk.dialog?.choice?.value === null);
const loading = computed(() => props.field.kind === 'relation' && props.bulk.optionsState.loading);
const choices = computed(() => {
	const f = props.field;
	if (f.kind === 'bool') return [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }];
	if (f.kind === 'relation') return props.bulk.fieldOptions;
	return enumChoices(props.def, f);
});

function onSelect(e: Event): void {
	const value = (e.target as HTMLSelectElement).value;
	if (!value) return;
	if (props.field.kind === 'bool') props.bulk.choose(value === 'true');
	else props.bulk.choose(value, choices.value.find((c) => c.value === value)?.label);
}
function onDate(e: Event): void {
	const value = (e.target as HTMLInputElement).value;
	// An emptied date box is not a choice: clearing the field is the explicit "Clear value" button.
	if (value) props.bulk.choose(value);
}
</script>

<template>
	<div class="target">
		<label class="fld">
			<span>New {{ fieldName }}</span>
			<input v-if="field.kind === 'date'" type="date" :value="selected" :disabled="bulk.applying" @change="onDate" />
			<select v-else :value="selected" :disabled="bulk.applying || loading" @change="onSelect">
				<option value="" disabled>{{ loading ? 'Loading…' : 'Choose…' }}</option>
				<option v-for="c in choices" :key="c.value" :value="c.value">{{ c.label }}</option>
			</select>
		</label>
		<p v-if="canClear(field)" class="clear">
			<button type="button" class="link" :aria-pressed="cleared" :disabled="bulk.applying" @click="bulk.choose(null)">Clear {{ fieldName }} instead</button>
			<span v-if="cleared" class="hint">The {{ fieldName }} will be emptied on every record that can change.</span>
		</p>
	</div>
</template>

<style scoped>
.target { display: flex; flex-direction: column; gap: 12px; }
.fld { display: flex; flex-direction: column; gap: 4px; font-size: var(--fs-sm, 12px); font-weight: 600; color: var(--d1-dim); }
.fld select, .fld input {
	height: 34px; padding: 0 10px; border: 1px solid var(--d1-line); border-radius: 8px; background: var(--d1-surface); color: var(--theme--foreground);
	font: inherit; font-size: var(--fs-md, 13px); font-weight: 400;
}
.clear { margin: 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; }
.hint { font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
.link {
	border: 0; background: none; padding: 0; font: inherit; font-size: var(--fs-sm, 12px); font-weight: 600;
	color: var(--d1-accent, var(--theme--primary)); cursor: pointer; text-decoration: underline;
}
.link:disabled { opacity: 0.55; cursor: default; }
button:focus-visible, select:focus-visible, input:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 2px; }
</style>
