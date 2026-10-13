<script setup lang="ts">
import { fromInputValue, toInputValue } from './inputModel';

const props = defineProps<{ modelValue?: string | number | null; placeholder?: string; type?: string; disabled?: boolean; autofocus?: boolean; small?: boolean }>();
const emit = defineEmits<{ (e: 'update:modelValue', value: string | number | null): void }>();
const onInput = (e: Event) => emit('update:modelValue', fromInputValue((e.target as HTMLInputElement).value, props.type));
</script>

<template>
	<div class="v-input" :class="{ small, disabled }">
		<span v-if="$slots.prepend" class="prepend"><slot name="prepend" /></span>
		<input :type="type ?? 'text'" :value="toInputValue(modelValue)" :placeholder="placeholder" :disabled="disabled" :autofocus="autofocus" @input="onInput" />
	</div>
</template>

<style scoped>
.v-input {
	display: flex; align-items: center; gap: 6px; min-height: 36px; padding: 0 10px;
	border: 1px solid var(--theme--form--field--input--border-color); border-radius: var(--theme--border-radius, 8px);
	background: var(--theme--form--field--input--background); color: var(--theme--foreground);
}
.v-input.small { min-height: 30px; }
.v-input.disabled { opacity: 0.7; }
.v-input:focus-within { border-color: var(--theme--primary); }
input { flex: 1 1 auto; min-width: 0; border: 0; outline: 0; background: transparent; color: inherit; font: inherit; }
.prepend { display: inline-flex; color: var(--theme--foreground-subdued); }
</style>
