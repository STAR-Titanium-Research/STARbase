<script setup lang="ts">
import { computed, ref } from 'vue';
import type { FormField } from '../fieldModel';
import { isEmptyValue } from '../fieldModel';
import { isOtherValue } from '../inputValue';

// A field with a fixed list of choices: a drop-down (select), or radio buttons. A drop-down that allows "other"
// (Surface Finish) adds an Other option with a text box for a value that is none of the choices.
const props = defineProps<{
	field: FormField;
	value: unknown;
	id: string;
	disabled?: boolean;
	inherited?: boolean;
	/** The live required state (a condition can change it) and the aria hooks the form passes (see FieldInput). */
	required?: boolean;
	invalid?: boolean;
	describedby?: string;
}>();
const emit = defineEmits<{ (e: 'update:value', value: unknown): void; (e: 'blur'): void }>();

const OTHER = '__other__';
const otherPicked = ref(false);
const showOther = computed(() => props.field.allowOther && (otherPicked.value || isOtherValue(props.field, props.value)));
const selected = computed(() => (showOther.value ? OTHER : isEmptyValue(props.value) ? '' : String(props.value)));
const radio = computed(() => props.field.kind === 'radio');

function choose(e: Event): void {
	const text = (e.target as HTMLSelectElement).value;
	if (text === OTHER) {
		otherPicked.value = true;
		emit('update:value', null);
		return;
	}
	otherPicked.value = false;
	pick(text);
}
// The choice whose text form is `text`: its own type (a number choice stays a number), null for the blank option.
function pick(text: string): void {
	if (text === '') return void emit('update:value', null);
	const hit = props.field.choices.find((c) => String(c.value) === text);
	emit('update:value', hit ? hit.value : text);
}
function typeOther(e: Event): void {
	const text = (e.target as HTMLInputElement).value;
	emit('update:value', text.trim() === '' ? null : text);
}
</script>

<template>
	<div class="d1-choice" :class="{ inherited }">
		<div v-if="radio" :id="id" class="radios" role="radiogroup" :aria-label="field.label" :aria-required="required || undefined" :aria-invalid="invalid || undefined" :aria-describedby="describedby">
			<label v-for="c in field.choices" :key="String(c.value)" class="radio">
				<input type="radio" :name="id" :value="String(c.value)" :checked="selected === String(c.value)" :disabled="disabled" @change="pick(String(c.value))" @blur="emit('blur')" />
				<span>{{ c.text }}</span>
			</label>
			<button v-if="!required && selected !== '' && !disabled" type="button" class="link" @click="pick('')">Clear</button>
		</div>
		<template v-else>
			<select :id="id" class="sel" :value="selected" :disabled="disabled" :aria-required="required || undefined" :aria-invalid="invalid || undefined" :aria-describedby="describedby" @change="choose" @blur="emit('blur')">
				<option value="">{{ required ? 'Choose…' : 'Not set' }}</option>
				<option v-for="c in field.choices" :key="String(c.value)" :value="String(c.value)">{{ c.text }}</option>
				<option v-if="field.allowOther" :value="OTHER">Other…</option>
			</select>
			<input
				v-if="showOther"
				type="text"
				class="other"
				:value="isOtherValue(field, value) ? String(value) : ''"
				:disabled="disabled"
				:aria-label="`${field.label}: other value`"
				placeholder="Other value"
				@input="typeOther"
				@blur="emit('blur')"
			/>
		</template>
	</div>
</template>

<style scoped>
.d1-choice { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.sel, .other {
	width: 100%; box-sizing: border-box; height: 34px; padding: 0 10px;
	border: 1px solid var(--d1-line); border-radius: 8px; background: var(--d1-surface); color: inherit;
	font: inherit; font-size: var(--fs-md, 13px);
}
.sel[aria-invalid='true'], .other[aria-invalid='true'] { border-color: var(--d1-bad); }
.sel:focus, .other:focus { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: -1px; }
.sel:disabled, .other:disabled { opacity: 0.7; }
.inherited .sel, .inherited .other { color: var(--d1-dim); font-style: italic; }
.radios { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; padding: 6px 0; }
.radio { display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-md, 13px); cursor: pointer; }
.inherited .radio { color: var(--d1-dim); font-style: italic; }
.link { border: 0; background: none; padding: 0; font: inherit; font-size: var(--fs-sm, 12px); color: var(--d1-accent, var(--theme--primary)); cursor: pointer; }
</style>
