<script setup lang="ts">
defineProps<{ modelValue?: string | null; placeholder?: string; disabled?: boolean }>();
const emit = defineEmits<{ (e: 'update:modelValue', value: string): void }>();
</script>

<template>
	<textarea class="v-textarea" :value="modelValue ?? ''" :placeholder="placeholder" :disabled="disabled" rows="4" @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)" />
</template>

<style scoped>
.v-textarea {
	width: 100%; box-sizing: border-box; padding: 8px 10px; font: inherit; color: var(--theme--foreground); resize: vertical;
	border: 1px solid var(--theme--form--field--input--border-color); border-radius: var(--theme--border-radius, 8px);
	background: var(--theme--form--field--input--background);
}
.v-textarea:focus { outline: 2px solid var(--theme--primary); outline-offset: 1px; }
</style>
