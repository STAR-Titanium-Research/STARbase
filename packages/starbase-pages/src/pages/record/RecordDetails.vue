<script setup lang="ts">
import { computed } from 'vue';
import { FactList, LoadState, Section, detailsCount, type Fact } from '@d1/ui';

// The "Details" panel of the Operation and Test pages: the record's own values and its process
// parameters as one many-column list (the old Overview and Parameters panels, minus the facts now in
// the rail), then the free-text notes. The parameters load on their own, so the record's values show
// at once and the parameters follow; a failed parameter read says so under the list.
const props = defineProps<{
	facts: Fact[];
	notes?: string | null;
	paramsLoading?: boolean;
	paramsError?: string;
	emptyText: string;
}>();

const settled = computed(() => !props.paramsLoading && !props.paramsError);
const empty = computed(() => settled.value && !props.facts.length && !props.notes);
const count = computed(() => detailsCount(props.facts.length, !!props.notes, !!props.paramsLoading, props.paramsError));
</script>

<template>
	<Section id="details" title="Details" :count="count" :empty="empty" :empty-text="emptyText">
		<FactList :facts="facts" />
		<p v-if="notes" class="notes">{{ notes }}</p>
		<LoadState v-if="paramsLoading || paramsError" class="params-state" :loading="paramsLoading" :error="paramsError" loading-text="Loading parameters…" />
	</Section>
</template>

<style scoped>
.notes { margin: 10px 0 0; font-size: var(--fs-md); line-height: 1.55; white-space: pre-wrap; color: var(--d1-dim); }
.params-state { margin-top: 8px; }
</style>
