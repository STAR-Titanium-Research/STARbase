<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import ChoiceInput from './inputs/ChoiceInput.vue';
import RecordPicker from './inputs/RecordPicker.vue';
import { displayText } from './fieldModel';
import type { FormField } from './fieldModel';
import { inputProblem, inputText, parseInput } from './inputValue';

// The input for one field, by its kind. The value is the stored value (number, text, key, boolean), `inherited`
// greys it, `disabled` is read-only (the form's, the field's, or a condition's). A field of kind 'external' is
// not drawn: it shows its value and "Open in Data Studio", which the form passes on as openExternal.
// `required` is the live state (a condition can make a field required), `invalid` marks it (aria-invalid) and
// `describedby` names the always-present message element that says why. A number box that holds something it
// cannot store (text, decimals in a whole-number field) keeps what was typed and reports it as `problem`.
const props = defineProps<{
	field: FormField;
	value: unknown;
	id: string;
	disabled?: boolean;
	inherited?: boolean;
	required?: boolean;
	invalid?: boolean;
	describedby?: string;
	/** Interface options a condition changed (a different list of choices, say); the field's own when null. */
	options?: Record<string, unknown> | null;
}>();
const emit = defineEmits<{
	(e: 'update:value', value: unknown): void;
	(e: 'blur'): void;
	(e: 'openExternal'): void;
	(e: 'problem', message: string | null): void;
}>();

// A number being typed ("1.", "-", "1e") is not yet the number it will be: keep the typed text while the box has
// focus, or the re-render from the emitted value would take the dot away. Text that cannot be stored stays too.
const draft = ref<string | null>(null);
const isNumber = computed(() => props.field.kind === 'number');
const text = computed(() => (draft.value !== null && isNumber.value ? draft.value : inputText(props.field, props.value)));
const HTML_TYPE: Record<string, string> = { text: 'text', number: 'number', date: 'date', datetime: 'datetime-local', time: 'time' };
const htmlType = computed(() => HTML_TYPE[props.field.kind] ?? 'text');
const step = computed(() => (props.field.step ?? (props.field.integer ? 1 : 'any')));
const external = computed(() => displayText(props.field, props.value));

// What is wrong with what the box holds (a typed draft, else the stored value).
const problem = computed(() => (isNumber.value ? inputProblem(props.field, draft.value ?? inputText(props.field, props.value)) : null));
watch(problem, (p) => emit('problem', p), { immediate: true });
const bad = computed(() => !!props.invalid || !!problem.value);

// The value changed from outside (undo, another tab's reload): a kept refused draft no longer describes it.
watch(
	() => props.value,
	(v) => {
		if (draft.value === null) return;
		const parsed = parseInput(props.field, draft.value);
		if (String(parsed ?? '') !== String(v ?? '')) draft.value = null;
	},
);

function onInput(e: Event): void {
	const typed = (e.target as HTMLInputElement | HTMLTextAreaElement).value;
	if (isNumber.value) draft.value = typed;
	emit('update:value', parseInput(props.field, typed));
}
function onBlur(): void {
	// Typed text that is not a storable number stays in the box, with its message, rather than vanishing.
	const refused = draft.value !== null && draft.value.trim() !== '' && parseInput(props.field, draft.value) === null;
	if (!refused) draft.value = null;
	emit('blur');
}
function onToggle(e: Event): void {
	emit('update:value', (e.target as HTMLInputElement).checked);
}
// A condition can replace the interface options, which for a choice field means another list.
const shown = computed<FormField>(() => {
	const choices = props.options?.choices;
	if (!Array.isArray(choices)) return props.field;
	return { ...props.field, choices: choices.filter((c) => c && c.value !== undefined && c.value !== null).map((c) => ({ text: String(c.text ?? c.value), value: c.value })) };
});
</script>

<template>
	<div class="d1-input" :class="{ inherited, [`k-${field.kind}`]: true }">
		<ChoiceInput
			v-if="field.kind === 'select' || field.kind === 'radio'"
			:field="shown"
			:value="value"
			:id="id"
			:disabled="disabled"
			:inherited="inherited"
			:required="required"
			:invalid="bad"
			:describedby="describedby"
			@update:value="emit('update:value', $event)"
			@blur="emit('blur')"
		/>
		<RecordPicker
			v-else-if="field.kind === 'record' || field.kind === 'person'"
			:field="field"
			:value="value === null || value === undefined || value === '' ? null : String(value)"
			:id="id"
			:disabled="disabled"
			:inherited="inherited"
			:required="required"
			:invalid="bad"
			:describedby="describedby"
			@update:value="emit('update:value', $event)"
			@blur="emit('blur')"
		/>
		<label v-else-if="field.kind === 'toggle'" class="toggle">
			<input :id="id" type="checkbox" role="switch" :checked="value === true || value === 'true'" :disabled="disabled" :aria-describedby="describedby" @change="onToggle" @blur="emit('blur')" />
			<span>{{ value === true || value === 'true' ? 'Yes' : 'No' }}</span>
		</label>
		<textarea
			v-else-if="field.kind === 'textarea'"
			:id="id"
			class="ctl area"
			rows="3"
			:value="text"
			:disabled="disabled"
			:placeholder="field.placeholder ?? undefined"
			:aria-required="required || undefined"
			:aria-invalid="bad || undefined"
			:aria-describedby="describedby"
			@input="onInput"
			@blur="onBlur"
		/>
		<div v-else-if="field.kind === 'external'" class="external">
			<span class="val" :class="{ none: !external }">{{ external || 'Not set' }}</span>
			<button type="button" class="link" @click="emit('openExternal')">Open in Data Studio</button>
		</div>
		<div v-else class="unit-wrap">
			<input
				:id="id"
				class="ctl"
				:type="htmlType"
				:value="text"
				:step="field.kind === 'number' || field.kind === 'time' ? step : undefined"
				:min="field.kind === 'number' && field.min !== null ? field.min : undefined"
				:max="field.kind === 'number' && field.max !== null ? field.max : undefined"
				:inputmode="field.kind === 'number' ? 'decimal' : undefined"
				:disabled="disabled"
				:placeholder="field.placeholder ?? undefined"
				:aria-required="required || undefined"
				:aria-invalid="bad || undefined"
				:aria-describedby="describedby"
				autocomplete="off"
				@input="onInput"
				@blur="onBlur"
			/>
			<span v-if="field.suffix && field.kind === 'number'" class="unit">{{ field.suffix }}</span>
		</div>
	</div>
</template>

<style scoped>
.d1-input { min-width: 0; }
.unit-wrap { display: flex; align-items: center; gap: 8px; }
.ctl {
	width: 100%; box-sizing: border-box; height: 34px; padding: 0 10px; min-width: 0;
	border: 1px solid var(--d1-line); border-radius: 8px; background: var(--d1-surface); color: inherit;
	font: inherit; font-size: var(--fs-md, 13px);
}
.area { height: auto; padding: 8px 10px; resize: vertical; line-height: 1.4; }
.ctl:focus { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: -1px; }
.ctl:disabled { opacity: 0.7; }
.ctl[aria-invalid='true'] { border-color: var(--d1-bad); }
.inherited .ctl { color: var(--d1-dim); font-style: italic; }
.unit { flex: none; font-size: var(--fs-sm, 12px); color: var(--d1-dim); white-space: nowrap; }
.toggle { display: inline-flex; align-items: center; gap: 8px; min-height: 34px; font-size: var(--fs-md, 13px); cursor: pointer; }
.inherited .toggle { color: var(--d1-dim); font-style: italic; }
.external { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 12px; min-height: 34px; }
.val { min-width: 0; overflow-wrap: anywhere; font-size: var(--fs-md, 13px); }
.val.none { color: var(--d1-dim); }
.link { border: 0; background: none; padding: 0; font: inherit; font-size: var(--fs-sm, 12px); font-weight: 600; color: var(--d1-accent, var(--theme--primary)); cursor: pointer; }
.link:hover { text-decoration: underline; }
</style>
