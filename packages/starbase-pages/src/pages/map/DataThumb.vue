<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { AppLink, assetThumbUrl } from '@d1/ui';
import ConformTrace from './ConformTrace.vue';
import type { DataPreview } from './model/dataPreview';

// The small data picture of a record (spec §6.6): for a machining operation with a finished force
// analysis, the Fz figure as the small image the index cards use (assetThumbUrl: Directus scales it; never the data file itself); for a FAST run
// with finished run data, the words "FAST run data" (there is no cheap picture of it) and a link to the
// plotter; for a Conform run with a log, "Conform run data" over a small trace of its window (wheel speed and Tooling 1, each on
// its own scale, as in the plotter's overview; or "Conform log not visible to you" / "Could not load the Conform log" when the log's file cannot be read), and a link to the Conform plotter. Nothing for a record with no data, or while the answer is still on its way. In the hover card
// the plotter link is plain text (the card takes no pointer).
const props = defineProps<{ preview?: DataPreview; link?: boolean }>();

// Square: the force figures are mostly round (a face of the part), so a square shows them at their size.
const src = computed(() => (props.preview?.kind === 'force' && props.preview.imageFileId ? assetThumbUrl(props.preview.imageFileId, 480, 480) : null));
// A figure that cannot be made (most force figures cannot be transformed yet) falls back to the words.
const failed = ref(false);
watch(src, () => void (failed.value = false));

const CAPTION = { fast: 'FAST run data', conform: 'Conform run data', force: 'Force data · Fz' } as const;
const ACTION = { fast: 'Open in FAST plotter', conform: 'Open in Conform plotter', force: 'Open in Force dashboard' } as const;
const caption = computed(() => CAPTION[props.preview?.kind === 'fast' || props.preview?.kind === 'conform' ? props.preview.kind : 'force']);
const action = computed(() => ACTION[props.preview?.kind === 'fast' || props.preview?.kind === 'conform' ? props.preview.kind : 'force']);
</script>

<template>
	<div v-if="preview && preview.kind !== 'none'" class="dthumb">
		<div class="cap">
			<span>{{ caption }}</span>
			<AppLink v-if="link && preview.plotterPath" :to="preview.plotterPath" class="open">{{ action }}</AppLink>
			<span v-else-if="preview.plotterPath" class="open">{{ action }}</span>
		</div>
		<ConformTrace v-if="preview.kind === 'conform' && preview.thumb" class="trace" :thumb="preview.thumb" />
		<p v-else-if="preview.kind === 'conform' && preview.thumbNote" class="note">{{ preview.thumbNote }}</p>
		<img v-if="src && !failed" :src="src" :alt="`${caption} figure`" loading="lazy" decoding="async" @error="failed = true" />
	</div>
</template>

<style scoped>
.dthumb { border-radius: 10px; background: var(--d1-tile); border: 1px solid var(--d1-line); padding: 6px 8px; min-width: 0; }
.cap { display: flex; justify-content: space-between; gap: 8px; font-size: var(--fs-xs, 11px); color: var(--d1-dim); }
.open { color: var(--d1-accent, var(--theme--primary)); text-decoration: none; font-weight: 600; white-space: nowrap; }
a.open:hover { text-decoration: underline; }
.trace { margin-top: 4px; }
.note { margin: 4px 0 0; font-size: var(--fs-xs, 11px); color: var(--d1-dim); }
img { display: block; width: 100%; max-width: 280px; aspect-ratio: 1; height: auto; margin: 4px auto 0; object-fit: contain; }
</style>
