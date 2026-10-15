<script setup lang="ts">
import { computed, useId } from 'vue';
import { missingLabel } from './createText';

// The Create button of the map panel lid (spec E4, §7.1) and its error line. The primary button says what it will make
// ("Create 2 operations, 4 samples": `summary` is summaryText(body)); while blocking checks exist it is disabled and says
// "N things missing" instead (the Checks section lists them); while creating it shows a spinner and cannot be pressed twice.
// A failed Create leaves the draft untouched and puts the reason in `error`.
const props = defineProps<{
	/** What Create will make, in words (summary.ts `summaryText`). */
	summary: string;
	/** Blocking checks. */
	missing: number;
	creating: boolean;
	error?: string | null;
	/** Nothing in the draft to create: disabled, still saying `summary`. */
	empty?: boolean;
}>();
const emit = defineEmits<{ create: [] }>();

const errorId = useId();
const blocked = computed(() => props.missing > 0);
const label = computed(() => (props.creating ? 'Creating…' : blocked.value ? missingLabel(props.missing) : props.summary));
const disabled = computed(() => props.creating || blocked.value || !!props.empty);
function press(): void {
	if (!disabled.value) emit('create');
}
</script>

<template>
	<div class="d1-kit pm-create" :class="{ blocked }">
		<button
			type="button"
			class="go"
			:disabled="disabled"
			:aria-busy="creating ? 'true' : undefined"
			:aria-describedby="error ? errorId : undefined"
			:title="blocked ? `${summary}: fix what Checks lists first` : summary"
			@click="press"
		>
			<span v-if="creating" class="spin" aria-hidden="true"></span>
			<span class="t">{{ label }}</span>
		</button>
		<p v-if="error" :id="errorId" class="err" role="alert">{{ error }}</p>
	</div>
</template>

<style scoped>
.pm-create { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; min-width: 0; max-width: 100%; }
.go {
	display: inline-flex; align-items: center; gap: 8px; max-width: 100%; padding: 6px 14px; border: 1px solid var(--d1-accent, var(--theme--primary)); border-radius: 8px;
	background: var(--d1-accent, var(--theme--primary)); color: var(--d1-on-accent, #fff); font: inherit; font-size: var(--fs-md, 13px); font-weight: 650; cursor: pointer;
}
.go:hover:not(:disabled) { filter: brightness(1.08); }
.go:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 2px; }
.go:disabled { cursor: default; }
/* Waiting on checks: a quiet button (not a faded primary), so "3 things missing" reads as a state rather than an action. */
.blocked .go:disabled { background: var(--d1-tile); border-color: var(--d1-line); color: var(--d1-bad); }
.pm-create:not(.blocked) .go:disabled { opacity: 0.7; }
.t { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.spin { width: 12px; height: 12px; flex: none; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: pm-create-spin 0.8s linear infinite; }
@keyframes pm-create-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spin { animation-duration: 2.4s; } }
.err { margin: 0; max-width: 36ch; font-size: var(--fs-sm, 12px); color: var(--d1-bad); overflow-wrap: anywhere; }
</style>
