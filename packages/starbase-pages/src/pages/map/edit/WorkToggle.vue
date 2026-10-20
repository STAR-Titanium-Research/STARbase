<script setup lang="ts">
import type { WorkState } from './draft';

// Planned or Done for a NEW operation or test (R9): the toggle at the top of the container's section in the rail. Planned lays the work out
// (only its structure is needed); Done records work that has happened, with its date, and Create writes it done with its output samples
// active (ADR-0019). Presentational: the page changes the draft, as one undoable step.
defineProps<{
	state: WorkState;
	/** "operation" or "test", for the words. */
	what: 'operation' | 'test';
}>();
const emit = defineEmits<{ change: [state: WorkState] }>();

const OPTIONS: { value: WorkState; label: string }[] = [
	{ value: 'planned', label: 'Planned' },
	{ value: 'done', label: 'Done' },
];
</script>

<template>
	<div class="pm-work">
		<div class="seg" role="radiogroup" :aria-label="`This ${what} is`">
			<button
				v-for="o in OPTIONS"
				:key="o.value"
				type="button"
				role="radio"
				class="opt"
				:class="{ on: state === o.value }"
				:aria-checked="state === o.value"
				:data-state="o.value"
				@click="state !== o.value && emit('change', o.value)"
			>{{ o.label }}</button>
		</div>
		<p class="hint">
			<template v-if="state === 'done'">Create writes it as done: it needs the date it happened and the fields marked required, and the samples it makes become active.</template>
			<template v-else>Laid out for later: only its structure is needed. Mark it done when it has happened.</template>
		</p>
	</div>
</template>

<style scoped>
.pm-work { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; }
.seg { display: inline-flex; align-self: flex-start; border: 1px solid var(--d1-line); border-radius: 8px; overflow: hidden; }
.opt {
	padding: 4px 14px; border: 0; background: var(--d1-surface); color: inherit; font: inherit; font-size: var(--fs-sm, 12px); font-weight: 600; cursor: pointer;
}
.opt + .opt { border-left: 1px solid var(--d1-line); }
.opt:hover:not(.on), .opt:focus-visible { background: var(--d1-tile, var(--theme--background-subdued)); outline: none; }
.opt.on { background: var(--d1-accent, var(--theme--primary)); color: var(--d1-on-accent, #fff); }
.hint { margin: 0; font-size: var(--fs-xs, 11px); color: var(--d1-dim); }
</style>
