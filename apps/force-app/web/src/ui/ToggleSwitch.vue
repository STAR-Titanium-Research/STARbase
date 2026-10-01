<script setup lang="ts">
// A real sliding toggle switch — the shared replacement for the plain checkboxes that used to
// stand in for on/off recording-behaviour settings (Detect cut start, Drift compensation,
// Converging auto-range) despite each one materially changing what gets recorded. No styled
// switch existed anywhere in the app before this; built once here rather than per call site.
defineProps<{
	modelValue: boolean;
	disabled?: boolean;
	/** Accessible label when the switch has no visible text label of its own. */
	label?: string;
}>();
defineEmits<{ 'update:modelValue': [value: boolean] }>();
</script>

<template>
	<button
		type="button"
		role="switch"
		class="tswitch"
		:class="{ on: modelValue }"
		:aria-checked="modelValue"
		:aria-label="label"
		:disabled="disabled"
		@click="$emit('update:modelValue', !modelValue)"
	>
		<span class="knob"></span>
	</button>
</template>

<style scoped>
.tswitch { position: relative; flex-shrink: 0; width: 36px; height: 20px; padding: 2px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 999px; cursor: pointer; transition: background-color 0.15s ease, border-color 0.15s ease; }
.tswitch.on { background: var(--accent); border-color: var(--accent); }
.tswitch:disabled { opacity: 0.5; cursor: not-allowed; }
.tswitch:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.knob { display: block; width: 14px; height: 14px; background: #fff; border-radius: 50%; box-shadow: 0 1px 2px rgba(0,0,0,0.35); transition: transform 0.15s ease; }
.tswitch.on .knob { transform: translateX(16px); }
</style>
