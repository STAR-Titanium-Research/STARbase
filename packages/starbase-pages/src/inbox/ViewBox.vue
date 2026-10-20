<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { AppLink, useExplorerHost } from '@d1/ui';
import type { FoundFile } from './inboxApi';
import { IMAGE_KINDS, hasThumbnail, kindIcon, nameOf } from './inboxModel';
import { CONTRAST_FILTER, actualWidthPx, boxScaleBar, type ZoomMode } from './viewBoxModel';
import { usePicture, type PictureState } from './usePicture';

// The stage of the view box page (spec 2026-10-20-inbox-file-viewer-design.md decisions 1, 4 and 8): the file's name, where it is in the list the person came
// from ("3 of 120", previous / next), Close back to that list, and the picture: the stored preview (about 1600 px; the original stays on the share), drawn
// to Fit the stage or at 1:1 of the original's pixels, with a scale bar when the file says its pixel size and an optional contrast stretch. A file with no
// picture says "No preview yet"; a picture that fails says so and offers Retry. It only reports what was asked (prev, next); the page does it.
const props = defineProps<{
	file: FoundFile;
	/** Where the file is in the list it came from, or null when that is not known (then there is no "n of m" and no prev/next: never a guess). */
	position: { text: string; hasPrev: boolean; hasNext: boolean } | null;
	/** The list, with the filters it was opened from. */
	closeTo: string;
	zoom: ZoomMode;
	scaleBar: boolean;
	contrast: boolean;
}>();
const emit = defineEmits<{
	(e: 'prev'): void;
	(e: 'next'): void;
	/** The preview's state, so the page's View rail knows whether there is a picture to adjust. */
	(e: 'state', s: PictureState): void;
}>();

const host = useExplorerHost();
const withPicture = computed(() => hasThumbnail(props.file));
const { state, url, retry } = usePicture(host.api, () => (withPicture.value ? props.file.candidate_id : null), 'preview', () => true, { priority: true });
watch(state, (s) => emit('state', s), { immediate: true });

const name = computed(() => nameOf(props.file.rel_path));
const icon = computed(() => kindIcon(props.file.kind));
const noPictureText = computed(() => (IMAGE_KINDS.includes(props.file.kind) ? 'The preview is not made yet.' : 'This kind of file has no preview.'));

// The preview's own width, known once it is in: 1:1 needs it when the file does not say how wide the original is.
const previewW = ref<number | null>(null);
watch(() => props.file.candidate_id, () => (previewW.value = null));
const drawnW = computed(() => (props.zoom === 'actual' ? actualWidthPx(props.file.extracted, previewW.value) : null));
const bar = computed(() => (props.scaleBar ? boxScaleBar(props.file.extracted, props.zoom, drawnW.value) : null));
const imgStyle = computed(() => ({
	...(drawnW.value ? { width: `${drawnW.value}px` } : {}),
	...(props.contrast ? { filter: CONTRAST_FILTER } : {}),
}));
</script>

<template>
	<div class="box" data-test="view-box" :data-state="state" :data-zoom="zoom">
		<header class="top">
			<h2 class="title" :title="file.rel_path" data-test="box-name">{{ name }}</h2>
			<template v-if="position">
				<span class="pos" data-test="box-position">{{ position.text }}</span>
				<button type="button" class="icon-btn edge" aria-label="Previous file" title="Previous file (left arrow)" :disabled="!position.hasPrev" data-test="box-prev" @click="emit('prev')"><v-icon name="chevron_left" small /></button>
				<button type="button" class="icon-btn edge" aria-label="Next file" title="Next file (right arrow)" :disabled="!position.hasNext" data-test="box-next" @click="emit('next')"><v-icon name="chevron_right" small /></button>
			</template>
			<AppLink :to="closeTo" class="close" title="Back to the list (Esc)" data-test="box-close"><v-icon name="close" small /><span>Close</span></AppLink>
		</header>

		<div class="stage" data-test="box-stage">
			<template v-if="withPicture">
				<div v-if="state === 'ready' && url" class="scroll" data-test="box-scroll">
					<div class="pic">
						<img :src="url" :alt="`Preview of ${name}`" :style="imgStyle" draggable="false" data-test="box-image" @load="previewW = ($event.target as HTMLImageElement).naturalWidth || null" />
						<div v-if="bar" class="bar" :style="{ width: `${bar.fraction * 100}%` }" data-test="box-scalebar">
							<span class="rule" aria-hidden="true" />
							<span class="len">{{ bar.label }}</span>
						</div>
					</div>
				</div>
				<div v-else-if="state === 'failed'" class="blank err" role="alert" data-test="box-error">
					<span>The preview could not be loaded.</span>
					<v-button small secondary data-test="box-retry" @click="retry()">Retry</v-button>
				</div>
				<div v-else class="blank" aria-busy="true" data-test="box-loading"><span class="shimmer" aria-hidden="true" /></div>
			</template>
			<div v-else class="blank" data-test="box-nopicture">
				<v-icon :name="icon" />
				<strong>No preview yet</strong>
				<span>{{ noPictureText }}</span>
			</div>
		</div>
		<p v-if="withPicture" class="note" data-test="box-note">Reduced-size preview. The original stays on the share.</p>
	</div>
</template>

<style scoped src="./inboxShared.css"></style>
<style scoped>
.box { display: flex; flex-direction: column; gap: 10px; min-width: 0; padding: 12px 14px; border: 1px solid var(--d1-line); border-radius: var(--d1-radius, 12px); background: var(--d1-surface, var(--theme--background)); box-shadow: var(--d1-shadow); }
.top { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; min-width: 0; }
.title { flex: 1 1 200px; min-width: 0; margin: 0; font-family: var(--theme--fonts--monospace--font-family, monospace); font-size: var(--fs-md, 13px); font-weight: 650; line-height: 1.3; overflow-wrap: anywhere; } /* file names are mono (DESIGN.md section 3) */
.pos { font-size: var(--fs-sm, 12px); color: var(--d1-dim); font-variant-numeric: tabular-nums; white-space: nowrap; }
.edge { border: 1px solid var(--d1-line); }
.edge:disabled { opacity: 0.4; cursor: default; background: none; color: var(--d1-dim); }
.close {
	display: inline-flex; align-items: center; gap: 4px; height: 28px; padding: 0 10px 0 6px; border: 1px solid var(--d1-line); border-radius: 8px;
	font-size: var(--fs-sm, 12px); font-weight: 600; color: var(--theme--foreground); text-decoration: none;
}
.close:hover { background: var(--d1-tile); }
.close:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 2px; }
.stage { border-radius: 8px; overflow: hidden; background: var(--d1-tile, var(--theme--background-subdued)); }
.scroll { display: flex; height: min(72dvh, 820px); min-height: 320px; overflow: auto; }
.pic { position: relative; margin: auto; flex: none; max-width: 100%; }
.pic img { display: block; max-width: 100%; max-height: min(72dvh, 820px); width: auto; height: auto; }
.box[data-zoom="actual"] .pic { max-width: none; }
.box[data-zoom="actual"] .pic img { max-width: none; max-height: none; }
.bar { position: absolute; left: 8px; bottom: 8px; display: flex; flex-direction: column; gap: 2px; box-sizing: border-box; padding: 3px 6px 2px; border-radius: 8px; background: color-mix(in srgb, var(--theme--background) 80%, transparent); }
.bar .rule { display: block; height: 4px; border: 2px solid var(--theme--foreground); border-top: 0; }
.bar .len { font-size: var(--fs-xs, 11px); font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1.2; white-space: nowrap; }
.blank { min-height: 320px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 16px; font-size: var(--fs-sm, 12px); color: var(--d1-dim); text-align: center; }
.blank strong { font-size: var(--fs-md, 13px); color: var(--theme--foreground); }
.blank.err { color: var(--theme--foreground); }
.blank .shimmer { height: 320px; }
.note { margin: 0; font-size: var(--fs-xs, 11px); color: var(--d1-dim); }
</style>
