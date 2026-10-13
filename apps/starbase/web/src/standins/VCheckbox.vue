<script setup lang="ts">
defineProps<{ modelValue?: boolean | null; disabled?: boolean }>();
const emit = defineEmits<{ (e: 'update:modelValue', value: boolean): void }>();
</script>

<template>
	<input type="checkbox" class="v-checkbox" :checked="!!modelValue" :disabled="disabled" @change="emit('update:modelValue', ($event.target as HTMLInputElement).checked)" />
</template>

<style scoped>
.v-checkbox { width: 18px; height: 18px; accent-color: var(--theme--primary); vertical-align: middle; }
</style>
