<script setup lang="ts">
import { ref } from 'vue';
import { Section, forgetListPrefs, useExplorerHost } from '@d1/ui';

// Settings → Index pages and Frequently used: two one-button sections that forget things.
// "Forget my list views" clears this browser's Table/Cards and density choices (they are per browser,
// so nothing is sent). "Clear my history" is Home's own clear: POST /d1-usage/clear zeroes the usage
// scores and leaves the pins.
const api = useExplorerHost().api;

const viewsForgotten = ref(false);
function forgetViews(): void {
	forgetListPrefs();
	viewsForgotten.value = true;
}

const clearing = ref(false);
const cleared = ref(false);
const clearFailed = ref(false);
async function clearHistory(): Promise<void> {
	clearing.value = true;
	cleared.value = false;
	clearFailed.value = false;
	try {
		await api.post('/d1-usage/clear');
		cleared.value = true;
	} catch {
		clearFailed.value = true;
	} finally {
		clearing.value = false;
	}
}
</script>

<template>
	<Section title="Index pages">
		<div class="st-row">
			<div class="grow">
				<p class="st-title">List views</p>
				<p class="st-hint">Whether each list shows a table or cards, and how dense it is, is remembered in this browser.</p>
			</div>
			<button type="button" class="st-btn" @click="forgetViews">Forget my list views</button>
			<span v-if="viewsForgotten" class="st-status" role="status">Done. Every list starts from the default.</span>
		</div>
	</Section>

	<Section title="Frequently used">
		<div class="st-row">
			<div class="grow">
				<p class="st-title">History</p>
				<p class="st-hint">Home's Frequently used is built from what you open. Clearing it keeps your pins.</p>
			</div>
			<button type="button" class="st-btn" :disabled="clearing" @click="clearHistory">Clear my history</button>
			<span v-if="cleared" class="st-status" role="status">History cleared.</span>
			<span v-if="clearFailed" class="st-failed" role="alert">
				Couldn't clear.
				<button type="button" class="st-link" @click="clearHistory">Retry</button>
			</span>
		</div>
	</Section>
</template>
