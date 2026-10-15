<script setup lang="ts">
import { computed } from 'vue';
import { AppLink } from '@d1/ui';
import { createdText, labelsPath, printLabelsText } from './createText';

// After Create (spec E19): "Created N records" and, when new samples were made, a link to print their labels. The link is
// the labels page with those samples preselected, an AppLink like every other link a page makes. The page shows it, closes
// it on `close` (and may time it out); it does not open the labels itself.
const props = defineProps<{
	/** The new samples' ids (the response's `sampleIds`). */
	sampleIds: string[];
	/** How many records were created in all. */
	count: number;
}>();
const emit = defineEmits<{ close: [] }>();

const to = computed(() => labelsPath(props.sampleIds));
const unique = computed(() => new Set(props.sampleIds.filter(Boolean)).size);
</script>

<template>
	<div class="d1-kit pm-toast" role="status" aria-live="polite">
		<div class="msg">
			<strong>{{ createdText(count) }}</strong>
			<AppLink v-if="to" :to="to" class="labels">{{ printLabelsText(unique) }}</AppLink>
		</div>
		<button type="button" class="x" aria-label="Dismiss" @click="emit('close')">&times;</button>
	</div>
</template>

<style scoped>
.pm-toast {
	display: flex; align-items: flex-start; gap: 12px; max-width: min(420px, calc(100vw - 32px)); padding: 10px 12px 10px 14px;
	border: 1px solid var(--d1-line); border-left: 4px solid var(--d1-ok); border-radius: var(--d1-radius, 12px);
	background: var(--d1-surface); color: var(--theme--foreground); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25); font-size: var(--fs-md, 13px);
}
.msg { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.labels { color: var(--d1-accent, var(--theme--primary)); font-weight: 650; text-decoration: none; }
.labels:hover { text-decoration: underline; }
.labels:focus-visible, .x:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 2px; border-radius: 4px; }
.x { flex: none; border: 0; background: transparent; color: inherit; font-size: 20px; line-height: 1; padding: 0 4px; cursor: pointer; border-radius: 6px; }
.x:hover { background: var(--d1-tile); }
</style>
