<script setup lang="ts">
import { computed } from 'vue';
import { DESELECT, optionKey, valueFor, type SelectItem } from './selectModel';

const props = defineProps<{ modelValue?: unknown; items: SelectItem[]; placeholder?: string; showDeselect?: boolean; disabled?: boolean }>();
const emit = defineEmits<{ (e: 'update:modelValue', value: unknown): void }>();
const selected = computed(() => optionKey(props.items, props.modelValue));
const onChange = (e: Event) => emit('update:modelValue', valueFor(props.items, (e.target as HTMLSelectElement).value));
</script>

<template>
	<select class="v-select" :value="selected" :disabled="disabled" @change="onChange">
		<option value="" disabled :selected="selected === ''">{{ placeholder ?? 'Choose…' }}</option>
		<option v-if="showDeselect && selected !== ''" :value="DESELECT">— None —</option>
		<option v-for="(item, i) in items" :key="i" :value="String(i)" :selected="selected === String(i)">{{ item.text }}</option>
	</select>
</template>

<style scoped>
.v-select {
	width: 100%; min-height: 36px; padding: 0 10px; font: inherit; color: var(--theme--foreground);
	border: 1px solid var(--theme--form--field--input--border-color); border-radius: var(--theme--border-radius, 8px);
	background: var(--theme--form--field--input--background);
}
.v-select:focus { outline: 2px solid var(--theme--primary); outline-offset: 1px; }
</style>
