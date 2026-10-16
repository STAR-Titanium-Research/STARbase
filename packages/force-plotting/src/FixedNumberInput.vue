<script setup lang="ts">
// Number field that shows a fixed number of decimals while idle (60 -> 60.00) and the full
// stored value while it has focus, so rounding for display never loses precision on edit.
// Emits like v-model.number: a number, or '' when cleared.
import { computed, ref } from 'vue';
import { fmtFixed } from './fixedNumber';

defineOptions({ inheritAttrs: false });
const props = withDefaults(defineProps<{ modelValue: number | string | null; digits?: number }>(), { digits: 2 });
const emit = defineEmits<{ 'update:modelValue': [value: number | string] }>();

const focused = ref(false);
const text = computed(() => (focused.value ? (props.modelValue ?? '') : fmtFixed(props.modelValue, props.digits)));
function onInput(e: Event) {
	const raw = (e.target as HTMLInputElement).value;
	const n = parseFloat(raw);
	emit('update:modelValue', Number.isNaN(n) ? '' : n);
}
</script>

<template>
	<input v-bind="$attrs" type="number" :value="text" @focus="focused = true" @blur="focused = false" @input="onInput" />
</template>
