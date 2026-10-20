<script setup lang="ts">
import { computed, ref } from 'vue';
import { AppLink } from '@d1/ui';
import type { FoundFile } from './inboxApi';
import { hasThumbnail, nameOf } from './inboxModel';
import type { MeasureLine } from './measure';
import ViewPane from './ViewPane.vue';
import type { ZoomMode } from './viewBoxModel';
import type { PictureState } from './usePicture';

// The stage of the view box page (spec 2026-10-20-inbox-file-viewer-design.md decisions 1, 4 and 8): the file's name, where it is in the list the person came
// from ("3 of 120", previous / next), Close back to that list, and the picture (ViewPane): the stored preview (about 1600 px; the original stays on the share),
// drawn to Fit the stage or at 1:1 of the original's pixels, with a scale bar when the file says its pixel size, an optional contrast stretch and, with Measure
// on, a line to drag. In Compare the page fills the stage with the two panes instead (the `stage` slot); the header stays the open file's. It only reports what
// was asked (prev, next); the page does it.
const props = defineProps<{
	file: FoundFile;
	/** Where the file is in the list it came from, or null when that is not known (then there is no "n of m" and no prev/next: never a guess). */
	position: { text: string; hasPrev: boolean; hasNext: boolean } | null;
	/** The list, with the filters it was opened from. */
	closeTo: string;
	zoom: ZoomMode;
	scaleBar: boolean;
	contrast: boolean;
	/** Measure is on, and the line drawn so far. */
	measureOn?: boolean;
	line?: MeasureLine | null;
	/** Compare is showing: the `stage` slot replaces the single picture. */
	compare?: boolean;
}>();
const emit = defineEmits<{
	(e: 'prev'): void;
	(e: 'next'): void;
	/** The preview's state, so the page's View rail knows whether there is a picture to adjust. */
	(e: 'state', s: PictureState): void;
	(e: 'measure', line: MeasureLine | null): void;
}>();

const withPicture = computed(() => hasThumbnail(props.file));
const state = ref<PictureState>('idle');
function onState(s: PictureState) {
	state.value = s;
	emit('state', s);
}
const name = computed(() => nameOf(props.file.rel_path));
</script>

<template>
	<div class="box" data-test="view-box" :data-state="state" :data-zoom="zoom" :data-compare="compare ? 'true' : 'false'">
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
			<slot v-if="compare" name="stage" />
			<ViewPane
				v-else
				:file="file"
				:zoom="zoom"
				:scale-bar="scaleBar"
				:contrast="contrast"
				:measure-on="measureOn"
				:line="line"
				side="box"
				@state="onState"
				@measure="emit('measure', $event)"
			/>
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
.note { margin: 0; font-size: var(--fs-xs, 11px); color: var(--d1-dim); }
</style>
