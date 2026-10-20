<script setup lang="ts">
import { nextTick, ref } from 'vue';
import { Section, forgetListPrefs, useExplorerHost } from '@d1/ui';

// Settings → Index pages and Frequently used: two one-button sections that forget things.
// "Forget my list views" clears this browser's View rail choices on lists and record pages (they are per browser,
// so nothing is sent). "Clear my history" is Home's own clear (POST /d1-usage/clear zeroes the usage
// scores and leaves the pins), and asks first with Home's words, inline: the safe choice (Cancel) gets
// the focus, and the button gets it back afterwards.
const api = useExplorerHost().api;

const viewsForgotten = ref(false);
function forgetViews(): void {
	forgetListPrefs();
	viewsForgotten.value = true;
}

const confirming = ref(false);
const clearBtn = ref<HTMLButtonElement | null>(null);
const cancelBtn = ref<HTMLButtonElement | null>(null);
async function askClear(): Promise<void> {
	confirming.value = true;
	cleared.value = false;
	clearFailed.value = false;
	await nextTick();
	cancelBtn.value?.focus();
}
async function cancelClear(): Promise<void> {
	confirming.value = false;
	await nextTick();
	clearBtn.value?.focus();
}
async function confirmClear(): Promise<void> {
	confirming.value = false;
	await nextTick();
	clearBtn.value?.focus();
	await clearHistory();
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
				<p class="st-hint">How each list is shown (layout, density, columns, rows per page, grouping) and each record page's View rail are remembered in this browser.</p>
			</div>
			<button type="button" class="st-btn" @click="forgetViews">Forget my list views</button>
			<span v-if="viewsForgotten" class="st-status" role="status">Done. Every list and record page starts from the default.</span>
		</div>
	</Section>

	<Section title="Frequently used">
		<div class="st-row">
			<div class="grow">
				<p class="st-title">History</p>
				<p class="st-hint">Home's Frequently used is built from what you open. Clearing it keeps your pins.</p>
			</div>
			<template v-if="confirming">
				<span class="st-title" role="alert">Clear your history? Pinned items stay.</span>
				<button type="button" class="st-btn danger" @click="confirmClear">Clear</button>
				<button ref="cancelBtn" type="button" class="st-btn" @click="cancelClear">Cancel</button>
			</template>
			<button v-else ref="clearBtn" type="button" class="st-btn" :disabled="clearing" @click="askClear">Clear my history</button>
			<span v-if="cleared" class="st-status" role="status">History cleared.</span>
			<span v-if="clearFailed" class="st-failed" role="alert">
				Couldn't clear.
				<button type="button" class="st-link" @click="clearHistory">Retry</button>
			</span>
		</div>
	</Section>
</template>
