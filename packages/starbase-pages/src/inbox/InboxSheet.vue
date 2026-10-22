<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useExplorerHost } from '@d1/ui';
import { loadMeasurements, type FoundFile } from './inboxApi';
import { IMAGE_KINDS, extractedText, folderText, hasThumbnail, kindIcon, kindLabel, metaText, nameOf, ownerText, primaryAction, settingsOf, suggestionOf } from './inboxModel';
import ScaleBar from './ScaleBar.vue';
import SemSettingsList from './SemSettingsList.vue';
import { sheetScaleBar } from './sheetScale';
import { usePicture } from './usePicture';

// The sheet beside the Inbox list (spec 2026-10-20-inbox-file-viewer-design.md decision 2): the selected file's picture (the stored preview, with a scale bar
// over it when the file says its pixel size), what the crawler read, and Link to..., Dismiss and Open in view box. It only reports what was asked; the page
// does it. A file with no picture still shows its facts; a picture still loading shimmers, a failed one says so and offers Retry (decision 8).
const props = defineProps<{
	file: FoundFile;
	/** The page's tab: New and Older files offer Link to... and Dismiss; Dismissed offers Restore; Recently linked offers neither. */
	tab: 'new' | 'older' | 'linked' | 'dismissed';
	showOwner: boolean;
	busy: boolean;
}>();
const emit = defineEmits<{
	(e: 'close'): void;
	(e: 'link'): void;
	(e: 'dismiss'): void;
	(e: 'restore'): void;
	(e: 'open-box'): void;
}>();

const host = useExplorerHost();
const withPicture = computed(() => hasThumbnail(props.file));
const { state, url, retry } = usePicture(host.api, () => (withPicture.value ? props.file.candidate_id : null), 'preview', () => true, { priority: true });

// How many shapes were saved on the file in the view box (decision 6): the sheet only says the count, the shapes are the view box's. Read per file the sheet shows
// (the answer of an earlier file is dropped); a count that cannot be read is no count. A save in the view box (another tab or window) is picked up when this one
// is looked at again: the count is read anew on focus, keeping the old number on screen until the answer comes.
const saved = ref<number | null>(null);
let seq = 0;
const countFor = () => (withPicture.value ? props.file.candidate_id : null);
async function readCount(id: string | null, keep: boolean) {
	const mine = ++seq;
	if (!keep) saved.value = null;
	if (id === null) return;
	try {
		const got = await loadMeasurements(host.api, id);
		if (mine === seq) saved.value = got.measurements.length;
	} catch {
		/* no count */
	}
}
watch(countFor, (id) => void readCount(id, false), { immediate: true });
const looked = () => {
	if (typeof document === 'undefined' || document.visibilityState === 'hidden') return;
	void readCount(countFor(), true);
};
onMounted(() => {
	window.addEventListener('focus', looked);
	document.addEventListener('visibilitychange', looked);
});
onBeforeUnmount(() => {
	seq += 1;
	window.removeEventListener('focus', looked);
	document.removeEventListener('visibilitychange', looked);
});

const name = computed(() => nameOf(props.file.rel_path));
const folder = computed(() => folderText(props.file.rel_path));
const meta = computed(() => metaText(props.file));
const read = computed(() => extractedText(props.file.extracted));
const suggestion = computed(() => suggestionOf(props.file));
const settings = computed(() => settingsOf(props.file));
const bar = computed(() => sheetScaleBar(props.file.extracted));
const icon = computed(() => kindIcon(props.file.kind));
// What stands where the picture would be: an image whose thumbnail is not made yet says so; any other kind has no picture to wait for.
const noPictureText = computed(() => (IMAGE_KINDS.includes(props.file.kind) ? 'The preview is not made yet.' : 'This kind of file has no preview.'));
const openable = computed(() => withPicture.value && state.value !== 'failed');
const canAct = computed(() => props.tab === 'new' || props.tab === 'older');
// A surface scan has no link: its button is the row's own "Add a surface scan". Every other file opens the record picker, "Link to…".
const linkLabel = computed(() => {
	const a = primaryAction(props.file);
	return a.kind === 'scan' ? a.label : 'Link to…';
});
</script>

<template>
	<aside class="sheet" :aria-label="`Details of ${name}`" data-test="inbox-sheet" :data-row-id="file.candidate_id" :data-state="state">
		<header class="top">
			<h2 class="title" :title="file.rel_path" data-test="sheet-name">{{ name }}</h2>
			<button type="button" class="icon-btn x" aria-label="Close the sheet" data-test="sheet-close" @click="emit('close')"><v-icon name="close" small /></button>
		</header>

		<div class="stage" data-test="sheet-stage">
			<template v-if="withPicture">
				<div v-if="state === 'ready' && url" class="pic">
					<img :src="url" :alt="`Preview of ${name}`" draggable="false" data-test="sheet-image" />
					<ScaleBar v-if="bar" :bar="bar" data-test="sheet-scalebar" />
				</div>
				<div v-else-if="state === 'failed'" class="blank err" role="alert" data-test="sheet-error">
					<span>The preview could not be loaded.</span>
					<v-button small secondary data-test="sheet-retry" @click="retry()">Retry</v-button>
				</div>
				<div v-else class="blank" aria-busy="true" data-test="sheet-loading"><span class="shimmer" aria-hidden="true" /></div>
			</template>
			<div v-else class="blank" data-test="sheet-nopicture">
				<v-icon :name="icon" />
				<span>{{ noPictureText }}</span>
			</div>
		</div>

		<div class="about">
			<span class="tag">{{ kindLabel(file.kind) }}</span>
			<span class="folder" :title="file.rel_path">{{ folder }}</span>
			<span v-if="meta" class="meta">{{ meta }}</span>
			<span v-if="showOwner" class="meta">{{ ownerText(file) }}</span>
		</div>

		<SemSettingsList v-if="settings.length" :rows="settings" />
		<p v-else-if="read" class="read" data-test="sheet-read">{{ read }}</p>
		<p v-if="saved" class="read" data-test="sheet-measurements">{{ saved }} saved {{ saved === 1 ? 'measurement' : 'measurements' }}</p>
		<p v-if="suggestion" class="why" data-test="sheet-suggestion">Looks like <strong class="rec">{{ suggestion.record }}</strong>: <span class="reason">{{ suggestion.text }}</span></p>

		<div class="actions">
			<v-button v-if="canAct" small :disabled="busy" data-test="sheet-link" @click="emit('link')">{{ linkLabel }}</v-button>
			<v-button v-if="canAct" small secondary :disabled="busy" data-test="sheet-dismiss" @click="emit('dismiss')">Dismiss</v-button>
			<v-button v-if="tab === 'dismissed'" small secondary :disabled="busy" data-test="sheet-restore" @click="emit('restore')">Restore</v-button>
			<v-button v-if="openable" small secondary data-test="sheet-open-box" @click="emit('open-box')">Open in view box</v-button>
		</div>
		<p v-if="withPicture" class="note">Reduced-size preview. The original stays on the share.</p>
	</aside>
</template>

<style scoped src="./inboxShared.css"></style>
<style scoped>
.sheet {
	box-sizing: border-box; flex: none; width: 340px; max-width: 100%; display: flex; flex-direction: column; gap: 10px; padding: 12px 14px;
	border: 1px solid var(--d1-line); border-radius: var(--d1-radius, 12px); background: var(--d1-surface, var(--theme--background)); box-shadow: var(--d1-shadow);
	position: sticky; top: var(--d1-header-offset, 52px); max-height: calc(100dvh - var(--d1-header-offset, 52px) - 16px); overflow: auto; color: var(--theme--foreground);
}
.top { display: flex; align-items: flex-start; gap: 8px; }
.title { flex: 1 1 auto; min-width: 0; margin: 0; font-family: var(--theme--fonts--monospace--font-family, monospace); font-size: var(--fs-md, 13px); font-weight: 650; line-height: 1.3; overflow-wrap: anywhere; } /* file names are mono (DESIGN.md section 3) */
.x { border: 1px solid var(--d1-line); }
.stage { --blank-h: 160px; border-radius: 8px; overflow: hidden; background: var(--d1-tile, var(--theme--background-subdued)); }
.pic { position: relative; }
.pic img { display: block; width: 100%; height: auto; }
.about { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 10px; font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
.tag { padding: 0 7px; border-radius: 99px; font-size: var(--fs-xs, 11px); font-weight: 650; line-height: 1.6; white-space: nowrap; color: var(--d1-dim); background: color-mix(in srgb, var(--d1-dim) 14%, transparent); }
.folder { min-width: 0; overflow-wrap: anywhere; }
.meta { white-space: nowrap; }
.read, .why { margin: 0; font-size: var(--fs-sm, 12px); }
.reason { color: var(--d1-dim); }
.rec { color: var(--d1-accent, var(--theme--primary)); font-weight: 650; }
.actions { display: flex; flex-wrap: wrap; gap: 6px; }
.note { margin: 0; font-size: var(--fs-xs, 11px); color: var(--d1-dim); }
/* Under 700px of page the sheet is a block under the list, as wide as the page. */
@container inbox-frame (max-width: 700px) {
	.sheet { width: 100%; position: static; max-height: none; }
}
</style>
