<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { AppLink, assetThumbUrl } from '@d1/ui';
import type { DataPreview } from './model/dataPreview';

// The small data picture of a record (spec §6.6): for a machining operation with a finished force
// analysis, the Fz figure as the small image the index cards use (assetThumbUrl: Directus scales it; never the data file itself); for a FAST run
// with finished run data, the words "FAST run data" (there is no cheap picture of it) and a link to the
// plotter. Nothing for a record with no data, or while the answer is still on its way. In the hover card
// the plotter link is plain text (the card takes no pointer).
const props = defineProps<{ preview?: DataPreview; link?: boolean }>();

const src = computed(() => (props.preview?.kind === 'force' && props.preview.imageFileId ? assetThumbUrl(props.preview.imageFileId) : null));
// A figure that cannot be made (most force figures cannot be transformed yet) falls back to the words.
const failed = ref(false);
watch(src, () => void (failed.value = false));

const caption = computed(() => (props.preview?.kind === 'fast' ? 'FAST run data' : 'Force data · Fz'));
const action = computed(() => (props.preview?.kind === 'fast' ? 'Open in FAST plotter' : 'Open in Force dashboard'));
</script>

<template>
	<div v-if="preview && preview.kind !== 'none'" class="dthumb">
		<div class="cap">
			<span>{{ caption }}</span>
			<AppLink v-if="link && preview.plotterPath" :to="preview.plotterPath" class="open">{{ action }}</AppLink>
			<span v-else-if="preview.plotterPath" class="open">{{ action }}</span>
		</div>
		<img v-if="src && !failed" :src="src" :alt="`${caption} figure`" loading="lazy" decoding="async" @error="failed = true" />
	</div>
</template>

<style scoped>
.dthumb { border-radius: 10px; background: var(--d1-tile); border: 1px solid var(--d1-line); padding: 6px 8px; min-width: 0; }
.cap { display: flex; justify-content: space-between; gap: 8px; font-size: var(--fs-xs, 11px); color: var(--d1-dim); }
.open { color: var(--d1-accent, var(--theme--primary)); text-decoration: none; font-weight: 600; white-space: nowrap; }
a.open:hover { text-decoration: underline; }
img { display: block; width: 100%; height: 64px; margin-top: 4px; object-fit: contain; }
</style>
