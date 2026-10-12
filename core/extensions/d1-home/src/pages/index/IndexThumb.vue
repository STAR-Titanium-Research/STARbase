<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { assetThumbUrl, fileId, hasDrawableDims, humanise, imageField, sampleDims, thumbKind } from '@d1/ui';
import type { IndexDef, RowPlots } from '@d1/ui';
import SampleGeometry from '../sample/SampleGeometry.vue';

// The picture of one list row, in a card's picture area or a roomy row's box (both fixed-size, so
// nothing jumps while pictures load). It fills the box it is put in.
//   samples: the isometric drawing at the sample's real dimensions, the very component the Sample
//            page's rail uses, so the thumbnail looks exactly like that drawing. A form the engine
//            does not draw ('other', none) or a sample with no dimensions shows the form's name instead.
//   equipment, tools, insert types, manufacturers: the photo or logo, a small cropped WebP from
//            Directus; no file (or one that fails to load) shows "No picture".
//   operations: the Fz force figure of a machining operation. The list page's plots request finds it
//            (the `plots` prop, from useIndexPage); until then, and when the image cannot be made (most
//            force figures cannot be transformed yet), it shows "No force figure yet". A sintering run
//            has no force figure, so it gets the ordinary "No picture".
const props = defineProps<{ def: IndexDef; row: Record<string, unknown>; plots?: RowPlots | null }>();

const kind = computed(() => thumbKind(props.def.collection));
const dims = computed(() => sampleDims(props.row));
const drawable = computed(() => kind.value === 'geometry' && hasDrawableDims(props.row));

const src = computed<string | null>(() => {
	if (kind.value === 'image') {
		const field = imageField(props.def.collection);
		const id = field ? fileId(props.row[field]) : null;
		return id ? assetThumbUrl(id) : null;
	}
	if (kind.value === 'force') {
		const id = fileId(props.plots?.frmFz);
		return id ? assetThumbUrl(id) : null;
	}
	return null;
});

// A picture that fails to load falls back to the placeholder; a different file gets another try.
const failed = ref(false);
watch(src, () => { failed.value = false; });

const placeholder = computed(() => {
	if (kind.value === 'geometry') {
		const form = typeof props.row.form === 'string' ? props.row.form.trim() : '';
		return form ? humanise(form) : 'No drawing';
	}
	if (kind.value === 'force' && props.row.process_category !== 'sintering') return 'No force figure yet';
	return props.def.collection === 'manufacturers' ? 'No logo' : 'No picture';
});
</script>

<template>
	<div v-if="kind" class="d1-thumb" :class="{ geometry: drawable }">
		<SampleGeometry v-if="drawable" :dims="dims" class="drawing" aria-hidden="true" />
		<img v-else-if="src && !failed" :src="src" alt="" loading="lazy" decoding="async" @error="failed = true" />
		<span v-else class="ph" aria-hidden="true">{{ placeholder }}</span>
	</div>
</template>

<style scoped>
.d1-thumb { box-sizing: border-box; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; line-height: 1.15; }
img { display: block; width: 100%; height: 100%; object-fit: cover; }
.ph { padding: 3px; text-align: center; font-size: var(--fs-xs, 10px); color: var(--d1-dim); overflow-wrap: anywhere; }

/* The drawing keeps its own colours and proportions (SampleGeometry); here it only shrinks to the
   box, without the tile's own frame (the box already has one). */
.d1-thumb .drawing { width: 100%; height: 100%; box-sizing: border-box; padding: 4px; border: 0; border-radius: 0; background: transparent; }
.drawing :deep(.canvas) { height: 100%; }
.drawing :deep(.canvas svg) { width: auto; height: 100%; max-width: 100%; }
</style>
