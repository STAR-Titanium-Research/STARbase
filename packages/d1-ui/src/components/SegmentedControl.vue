<script setup lang="ts" generic="T extends string">
// A small one-of-N switch (Table | Cards, Compact | Normal | Roomy). It is a radio group: the chosen
// option is the one tab stop, the arrow keys (and Home/End) move the choice, and each option says
// whether it is checked. The caller owns the value; this only reports the new one.
import { ref } from 'vue';
import { nextRadioIndex } from '../index/listPrefs';

const props = defineProps<{
	modelValue: T;
	options: readonly { value: T; label: string; icon?: string }[];
	/** The group's accessible name. */
	label: string;
	/** Draw only each option's icon (its label is the tooltip and the accessible name). */
	iconOnly?: boolean;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: T] }>();

const buttons = ref<HTMLButtonElement[]>([]);

function onKey(e: KeyboardEvent, i: number): void {
	// Alt+arrow is the browser's Back/Forward, Ctrl/Cmd+arrow its own too: not ours to take.
	if (e.altKey || e.ctrlKey || e.metaKey) return;
	const to = nextRadioIndex(props.options.length, i, e.key);
	if (to === null) return;
	e.preventDefault();
	emit('update:modelValue', props.options[to].value);
	buttons.value[to]?.focus();
}
</script>

<template>
	<span class="seg" role="radiogroup" :aria-label="label">
		<button
			v-for="(o, i) in options"
			:key="o.value"
			:ref="(el) => { if (el) buttons[i] = el as HTMLButtonElement; }"
			type="button"
			role="radio"
			class="opt"
			:class="{ on: o.value === modelValue }"
			:aria-checked="o.value === modelValue"
			:aria-label="iconOnly ? o.label : undefined"
			:title="iconOnly ? o.label : undefined"
			:tabindex="o.value === modelValue ? 0 : -1"
			@click="emit('update:modelValue', o.value)"
			@keydown="onKey($event, i)"
		><span v-if="o.icon" class="ico" aria-hidden="true">{{ o.icon }}</span><template v-if="!iconOnly">{{ o.label }}</template></button>
	</span>
</template>

<style scoped>
.seg { display: inline-flex; border: 1px solid var(--d1-line); border-radius: 8px; overflow: hidden; background: var(--d1-surface); }
.opt {
	display: inline-flex; align-items: center; gap: 5px; height: 28px; padding: 0 10px;
	border: 0; border-right: 1px solid var(--d1-line); background: none; color: var(--d1-dim);
	font: inherit; font-size: var(--fs-sm, 12px); font-weight: 600; white-space: nowrap; cursor: pointer;
}
.opt:last-child { border-right: 0; }
.opt:hover:not(.on) { color: var(--theme--foreground); background: var(--d1-tile); }
.opt.on { background: var(--d1-accent, var(--theme--primary)); color: var(--d1-on-accent, #fff); }
.opt:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: -2px; }
</style>
