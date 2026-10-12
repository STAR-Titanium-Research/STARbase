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
}>();

const isSample = computed(() => props.collection === 'physical_samples');
const force = computed(() => (!isSample.value && props.plots?.force ? analysisLink(props.id, 'machining') : null));
const fast = computed(() => (!isSample.value && props.plots?.fast ? analysisLink(props.id, 'sintering') : null));
const sample = computed(() => {
	const n = props.plots?.forceCount ?? 0;
	if (!isSample.value || n < 1 || !props.code) return null;
	return { label: `Force (${n})`, to: indexRoute('manufacturing_operations', { query: { q: props.code, 'f.has_force': 'true' } }) };
});
</script>

<template>
	<span v-if="force || fast || sample" class="plots">
		<router-link v-if="force" :to="force.to" class="plot" title="Open in the Force dashboard" @click.stop>Force</router-link>
		<router-link v-if="fast" :to="fast.to" class="plot" title="Open in the FAST dashboard" @click.stop>FAST</router-link>
		<router-link v-if="sample" :to="sample.to" class="plot" title="Operations of this sample with force data" @click.stop>{{ sample.label }}</router-link>
	</span>
</template>

<style scoped>
.plots { display: inline-flex; gap: 4px; justify-content: flex-end; }
.plot {
	display: inline-flex; align-items: center; height: 22px; padding: 0 9px; border-radius: 99px;
	border: 1px solid var(--d1-line); background: var(--d1-tile); color: var(--d1-accent, var(--theme--primary));
	font-size: var(--fs-xs, 11px); font-weight: 600; text-decoration: none; white-space: nowrap;
}
.plot:hover { border-color: var(--d1-accent, var(--theme--primary)); }
.plot:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 2px; }
</style>
