<script setup lang="ts">
// The small buttons at the end of an operation's or sample's list row (and in a card's footer):
// Force opens the Force dashboard on the operation, FAST the FAST dashboard, and a sample's
// "Force (n)" the operations list narrowed to that sample's operations that have force data. A
// button is only drawn when the row has that data; a row without any shows nothing. A click on a
// button does not also open the row.
import { computed } from 'vue';
import { analysisLink } from '../process';
import { indexRoute } from '../recordRoute';
import type { RowPlots } from './plotData';

const props = defineProps<{
	collection: string;
	id: string;
	/** A sample's code: what the "Force (n)" link searches the operations list for. */
	code?: string;
	plots?: RowPlots | null;
	/** The row's own name (its code or label): in each button's accessible name, so a screen reader can tell the rows apart. */
	label?: string;
	/** `row`: a pill no taller than a table line (so a compact row does not grow); `card`: the full-size pill of a card's footer. */
	size?: 'row' | 'card';
}>();

const isSample = computed(() => props.collection === 'physical_samples');
const force = computed(() => (!isSample.value && props.plots?.force ? analysisLink(props.id, 'machining') : null));
const fast = computed(() => (!isSample.value && props.plots?.fast ? analysisLink(props.id, 'sintering') : null));
const who = computed(() => (props.label ? ` for ${props.label}` : ''));
const sample = computed(() => {
	const n = props.plots?.forceCount ?? 0;
	if (!isSample.value || n < 1 || !props.code) return null;
	return { label: `Force (${n})`, to: indexRoute('manufacturing_operations', { query: { q: props.code, 'f.has_force': 'true' } }) };
});
</script>

<template>
	<span v-if="force || fast || sample" class="plots" :class="size === 'card' ? 's-card' : 's-row'">
		<router-link v-if="force" :to="force.to" class="plot" title="Open in the Force dashboard" :aria-label="`Force dashboard${who}`" @click.stop>Force</router-link>
		<router-link v-if="fast" :to="fast.to" class="plot" title="Open in the FAST dashboard" :aria-label="`FAST dashboard${who}`" @click.stop>FAST</router-link>
		<router-link v-if="sample" :to="sample.to" class="plot" title="Operations of this sample with force data" :aria-label="`${sample.label}: operations with force data${who}`" @click.stop>{{ sample.label }}</router-link>
	</span>
</template>

<style scoped>
.plots { display: inline-flex; gap: 4px; justify-content: flex-end; }
.plot {
	display: inline-flex; align-items: center; box-sizing: border-box; height: 22px; padding: 0 9px; border-radius: 99px;
	border: 1px solid var(--d1-line); background: var(--d1-tile); color: var(--d1-accent, var(--theme--primary));
	font-size: var(--fs-xs, 11px); font-weight: 600; text-decoration: none; white-space: nowrap;
}
/* In a table row the pill is no taller than a compact line (12px text, 1.45), so the row does not
   grow when the buttons arrive. */
.s-row { display: flex; } /* block-level: no line box, so no strut height added to the cell */
.s-row .plot { height: 17px; padding: 0 8px; line-height: 1; }
.plot:hover { border-color: var(--d1-accent, var(--theme--primary)); }
.plot:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 2px; }
</style>
