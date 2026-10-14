<script setup lang="ts">
import { FactList, LoadState, Section, type Fact } from '@d1/ui';

// The "Details" panel of a tool box, an insert or an edge: the remaining facts, then the notes. A
// `warning` (an edge marked fresh that tests used) leads the panel, where the eye lands.
defineProps<{ facts: Fact[]; notes?: string | null; loading?: boolean; warning?: string }>();
</script>

<template>
	<Section id="details" title="Details">
		<LoadState :loading="loading" loading-text="Loading details…">
			<p v-if="warning" class="d1-note warn warning" role="status">{{ warning }}</p>
			<FactList :facts="facts" />
			<div v-if="notes" class="notes-block">
				<span class="label">Notes</span>
				<p class="notes">{{ notes }}</p>
			</div>
		</LoadState>
	</Section>
</template>

<style scoped>
.warning { margin-bottom: 10px; font-weight: 600; }
.notes-block { display: flex; flex-direction: column; gap: 2px; margin-top: 12px; }
.label { font-size: var(--fs-xs); font-weight: 600; letter-spacing: 0.01em; color: var(--d1-dim); }
.notes { margin: 0; font-size: var(--fs-md); line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
