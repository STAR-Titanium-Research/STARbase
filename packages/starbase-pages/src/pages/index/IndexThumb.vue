<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { assetThumbUrl, choiceLabel, fileId, hasDrawableDims, imageField, sampleDims, thumbKind } from '@d1/ui';
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
		return form ? choiceLabel('geometry', form) : 'No drawing';
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
.d1-thumb { position: relative; box-sizing: border-box; width: 100%; height: 100%; min-width: 0; display: flex; align-items: center; justify-content: center; line-height: 1.15; }
img { display: block; width: 100%; height: 100%; object-fit: contain; }
.ph { padding: 3px; text-align: center; font-size: var(--fs-xs, 10px); color: var(--d1-dim); overflow-wrap: anywhere; }

/* The drawing keeps its own colours and proportions (SampleGeometry); here it only scales to fit the
   box, whole (contain), without the tile's own frame (the box already has one). The drawing's SVG has
   a viewBox but no size, so it is laid over the box (absolute, 100% x 100%) and the viewBox's own
   meet scaling does the fitting; sizing it by `height: 100%` of a content-sized parent does not work
   (the SVG then falls back to a default size and overflows the box). */
.d1-thumb .drawing { position: absolute; inset: 0; width: auto; height: auto; box-sizing: border-box; padding: 4px; border: 0; border-radius: 0; background: transparent; }
.drawing :deep(.canvas) { position: relative; width: 100%; height: 100%; }
.drawing :deep(.canvas svg) { position: absolute; inset: 0; width: 100%; height: 100%; max-width: none; margin: 0; }
.drawing :deep(.no-drawing) { font-size: var(--fs-xs, 10px); }
</style>
