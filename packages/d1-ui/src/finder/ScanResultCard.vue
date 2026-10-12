<script setup lang="ts">
// What a scan says when it did not open a sample: a D1 label whose sample could not be opened (the
// decoded label and the reason), or text that is not a D1 label (as scanned). Used by the Finder
// (USB scanners, paste) and by the camera dialog. Everything is shown as plain text: a scanned
// "link" is never made clickable.
import { computed } from 'vue';
import '../components/tokens.css';
import { displayText } from './scan';
import type { ScanOutcome } from './scan';

const props = defineProps<{ outcome: Exclude<ScanOutcome, { kind: 'open' }> }>();

const title = computed(() => {
	const o = props.outcome;
	if (o.kind === 'failed') return 'Label read, but its sample could not be opened';
	return o.looksLikeD1 ? 'This looks like a D1 label but could not be read' : 'Not a D1 sample label';
});
</script>

<template>
	<div class="d1-scan-card" role="status" aria-live="polite">
		<p class="title">{{ title }}</p>
		<template v-if="outcome.kind === 'failed'">
			<p class="reason">{{ outcome.message }}</p>
			<dl class="label">
				<dt>Code</dt>
				<dd>{{ displayText(outcome.code) }}</dd>
				<dt>Short ID</dt>
				<dd>{{ displayText(outcome.shortId) }}</dd>
			</dl>
			<pre v-if="outcome.lines.length" class="text">{{ displayText(outcome.lines.join('\n')) }}</pre>
		</template>
		<pre v-else class="text">{{ displayText(outcome.text) }}</pre>
	</div>
</template>

<style scoped>
.d1-scan-card {
	margin: 8px; padding: 10px 12px; border: 1px solid var(--d1-line); border-radius: var(--d1-radius);
	border-left: 4px solid var(--theme--warning, var(--d1-accent, var(--theme--primary)));
	background: var(--d1-tile); font-size: var(--fs-md, 13px); color: var(--theme--foreground);
}
.title { margin: 0 0 4px; font-weight: 700; }
.reason { margin: 0 0 8px; color: var(--d1-dim); }
.label { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 0 0 8px; }
.label dt { color: var(--d1-dim); }
.label dd { margin: 0; font-weight: 600; overflow-wrap: anywhere; }
.text {
	margin: 0; padding: 8px; max-height: 30vh; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere;
	border-radius: 6px; background: var(--d1-surface); font: inherit; font-size: var(--fs-sm, 12px);
}
</style>
