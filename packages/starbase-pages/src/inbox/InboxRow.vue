<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { AppLink, formatDate, recordRoute, useExplorerHost } from '@d1/ui';
import type { FoundFile } from './inboxApi';
import {
	DOCUMENT_NOTICE, STRENGTH_LABEL, canChange, duplicateText, extractedText, folderOf, hasThumbnail, kindLabel, nameOf, needsReadNotice, ownerText,
	primaryAction, sizeText, suggestionOf,
} from './inboxModel';
import { BATCH_KIND_TEXT } from './inboxBulk';
import { ignoreTarget } from './ignoredFolders';
import { ADDED_SCAN_LEAD, SCAN_ROW_NOTICE, isAddedScan, scanTarget } from './inboxScan';
import PreviewDialog from './PreviewDialog.vue';
import { useInView, usePicture } from './usePicture';

// One found file: its picture (when the crawler stored one: a button that opens the full view) or the icon of its kind, its name and folder, what the crawler read and what it thinks the file belongs to
// (and why), and the buttons. The row only reports what was asked; the page does it (useInbox).
const props = defineProps<{
	file: FoundFile;
	busy: boolean;
	/** The page's tab: New and Older files offer Link, Change and Dismiss; Dismissed offers Restore; Recently linked says where it went. */
	tab: 'new' | 'older' | 'linked' | 'dismissed';
	/** Show whose Inbox it is (the person has a team folder too). */
	showOwner: boolean;
	/** Offer "Ignore this folder" beside the folder (the server has the route and the person may change rules). */
	canIgnore?: boolean;
}>();
const emit = defineEmits<{
	(e: 'link'): void;
	(e: 'pick'): void;
	(e: 'scan'): void;
	(e: 'change'): void;
	(e: 'dismiss'): void;
	(e: 'restore'): void;
	/** The button that was pressed, so the page can give focus back to it when the confirm is cancelled. */
	(e: 'ignore', opener: HTMLElement): void;
}>();

const name = computed(() => nameOf(props.file.rel_path));
const folder = computed(() => folderOf(props.file.rel_path));
const suggestion = computed(() => suggestionOf(props.file));
const action = computed(() => primaryAction(props.file));
const read = computed(() => extractedText(props.file.extracted));
const copy = computed(() => duplicateText(props.file));
const meta = computed(() => [sizeText(props.file.size_bytes), formatDate(props.file.source_mtime ?? props.file.first_seen_at)].filter(Boolean).join(' · '));
const reads = computed(() => needsReadNotice(props.file.kind));
// "Ignore this folder": only on an open file whose folder sits below its owner's root (the root itself cannot be ignored)
const ignorable = computed(() => !!props.canIgnore && (props.tab === 'new' || props.tab === 'older') && ignoreTarget(props.file) !== null);

// The icon of its kind is what a row shows when it has no picture, while none is wanted yet, and when the picture fails to load.
const icon = computed(() => ({ sem_image: 'image', image: 'image', surface_scan: 'view_in_ar', document: 'description', other: 'draft' })[props.file.kind]);

const linkedTo = computed(() => (props.file.linked_collection && props.file.linked_record_id ? recordRoute(props.file.linked_collection, props.file.linked_record_id) : null));
const suggestedTo = computed(() => (props.file.suggested_collection && props.file.suggested_record_id ? recordRoute(props.file.suggested_collection, props.file.suggested_record_id) : null));
// A file added as a surface scan has no record page of its own: it routes to the insert or edge it was added to.
const addedScan = computed(() => isAddedScan(props.file));
const scanTo = computed(() => {
	const t = scanTarget(props.file);
	return t ? recordRoute(t.collection, t.id) : null;
});

// ---- the picture (spec section 14): loaded as a blob with the signed-in session once the row is near the screen, a few at a time ----
const host = useExplorerHost();
const withPicture = computed(() => hasThumbnail(props.file));
const thumbButton = ref<HTMLElement | null>(null);
const seen = useInView(thumbButton);
const { state: thumbState, url: thumbUrl } = usePicture(host.api, () => (withPicture.value ? props.file.candidate_id : null), 'thumb', () => seen.value);
const previewOpen = ref(false);
// A picture that failed to load is not mentioned: the row shows its icon, as if it had none. While its preview is open the button stays (focus returns
// to it on close, and it cannot vanish under a person who clicked it while it still shimmered).
const showButton = computed(() => withPicture.value && (thumbState.value !== 'failed' || previewOpen.value));
const rowEl = ref<HTMLElement | null>(null);
/** Where focus goes when the thumbnail button is gone (its picture failed): the row's first action button, if it has one. */
function focusFallback() {
	rowEl.value?.querySelector<HTMLElement>('.buttons button:not([disabled])')?.focus();
}
async function closePreview() {
	previewOpen.value = false;
	await nextTick();
	if (thumbButton.value) thumbButton.value.focus();
	else focusFallback();
}
// A thumbnail that has focus (tabbed to while it shimmered) and then fails is removed: hand the focus on rather than let it fall to <body>.
watch(
	thumbState,
	async (s) => {
		if (s !== 'failed' || previewOpen.value || !thumbButton.value || document.activeElement !== thumbButton.value) return;
		await nextTick();
		if (!thumbButton.value) focusFallback();
	},
	{ flush: 'pre' },
);

const how = computed(() => (props.file.link_kind ? BATCH_KIND_TEXT[props.file.link_kind] : 'Linked'));
</script>

<template>
	<li ref="rowEl" class="row" :class="{ busy, weak: suggestion?.weak }" :data-state="file.state" :data-row-id="file.candidate_id" data-test="inbox-row">
		<button
			v-if="showButton"
			ref="thumbButton"
			type="button"
			class="thumb pic"
			:aria-label="`View ${name}`"
			:aria-busy="thumbState === 'loading'"
			:data-state="thumbState"
			data-test="thumb"
			@click="previewOpen = true"
		>
			<img v-if="thumbUrl" :src="thumbUrl" alt="" draggable="false" />
			<v-icon v-else-if="thumbState === 'failed'" :name="icon" />
			<span v-else class="shimmer" aria-hidden="true" />
		</button>
		<span v-else class="thumb" aria-hidden="true"><v-icon :name="icon" /></span>
		<PreviewDialog v-if="previewOpen" :file="file" :thumb-url="thumbUrl" @close="closePreview" />

		<div class="main">
			<div class="line">
				<span class="name" :title="file.rel_path">{{ name }}</span>
				<span class="tag" :class="`kind-${file.kind}`">{{ kindLabel(file.kind) }}</span>
				<span v-if="file.match_strength !== 'none' && suggestion" class="tag strength" :class="{ weak: suggestion.weak }">{{ STRENGTH_LABEL[file.match_strength] }}</span>
			</div>
			<div class="sub">
				<span class="folder" :title="folder">{{ folder || 'Share root' }}</span>
				<button v-if="ignorable" type="button" class="lf-link quiet" :disabled="busy" data-test="ignore-folder" :aria-label="`Ignore the folder ${folder}`" @click="emit('ignore', $event.currentTarget as HTMLElement)">Ignore this folder</button>
				<span v-if="meta" class="meta">{{ meta }}</span>
				<span v-if="showOwner" class="meta">{{ ownerText(file) }}</span>
			</div>
			<div v-if="read" class="read">{{ read }}</div>
			<div v-if="copy" class="copy">{{ copy }}</div>

			<div v-if="tab === 'linked' && addedScan" class="why" data-test="linked-to">
				{{ ADDED_SCAN_LEAD }}<template v-if="file.linked_label"> of <AppLink v-if="scanTo" :to="scanTo" class="rec">{{ file.linked_label }}</AppLink><template v-else>{{ file.linked_label }}</template></template><template v-if="file.decided_at"> on {{ formatDate(file.decided_at) }}</template>
			</div>
			<div v-else-if="tab === 'linked'" class="why" data-test="linked-to">
				{{ how }}<template v-if="file.linked_label"> to <AppLink v-if="linkedTo" :to="linkedTo" class="rec">{{ file.linked_label }}</AppLink><template v-else>{{ file.linked_label }}</template></template><template v-if="file.decided_at"> on {{ formatDate(file.decided_at) }}</template>
			</div>
			<div v-else-if="suggestion" class="why" data-test="suggestion">
				Looks like <AppLink v-if="suggestedTo" :to="suggestedTo" class="rec">{{ suggestion.record }}</AppLink><template v-else>{{ suggestion.record }}</template>:
				<span class="reason">{{ suggestion.text }}</span>
			</div>
			<div v-if="tab !== 'linked' && tab !== 'dismissed' && file.kind === 'surface_scan'" class="note" data-test="scan-notice">{{ SCAN_ROW_NOTICE }}</div>
			<div v-else-if="tab !== 'linked' && tab !== 'dismissed' && reads" class="note">{{ DOCUMENT_NOTICE }}</div>
		</div>

		<div class="buttons">
			<template v-if="tab === 'new' || tab === 'older'">
				<v-button v-if="action.kind === 'scan'" small :disabled="busy" data-test="add-scan" @click="emit('scan')">{{ action.label }}</v-button>
				<v-button v-else-if="action.kind === 'link'" small :disabled="busy" @click="reads ? emit('pick') : emit('link')">{{ action.label }}</v-button>
				<v-button v-else small :disabled="busy" @click="emit('pick')">{{ action.label }}</v-button>
				<v-button v-if="canChange(file)" small secondary :disabled="busy" @click="emit('change')">Change</v-button>
				<v-button small secondary :disabled="busy" @click="emit('dismiss')">Dismiss</v-button>
			</template>
			<v-button v-else-if="tab === 'dismissed'" small secondary :disabled="busy" @click="emit('restore')">Restore</v-button>
		</div>
	</li>
</template>

<style scoped>
.row { display: flex; align-items: flex-start; gap: 12px; padding: 10px 12px; border: 1px solid var(--d1-line); border-radius: 10px; background: var(--d1-tile); list-style: none; }
.row.busy { opacity: 0.6; }
.thumb { flex: none; display: grid; place-items: center; width: 64px; height: 64px; border-radius: 8px; overflow: hidden; background: var(--d1-surface, var(--theme--background)); border: 1px solid var(--d1-line); color: var(--d1-dim); }
.thumb.pic { padding: 0; font: inherit; cursor: zoom-in; position: relative; }
.thumb.pic:hover { border-color: var(--d1-accent, var(--theme--primary)); }
.thumb.pic:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 2px; }
.thumb img { display: block; width: 100%; height: 100%; object-fit: cover; }
.shimmer {
	display: block; width: 100%; height: 100%;
	background: linear-gradient(90deg, var(--d1-line) 25%, color-mix(in srgb, var(--d1-line) 35%, var(--d1-tile)) 50%, var(--d1-line) 75%); background-size: 200% 100%;
	animation: shimmer 1.4s linear infinite;
}
@keyframes shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
@media (prefers-reduced-motion: reduce) { .shimmer { animation: none; } }
.main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.line { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 8px; min-width: 0; }
.name { font-size: var(--fs-md, 13px); font-weight: 650; overflow-wrap: anywhere; }
.tag {
	padding: 0 7px; border-radius: 99px; font-size: var(--fs-xs, 11px); font-weight: 650; line-height: 1.6; white-space: nowrap;
	color: var(--d1-dim); background: color-mix(in srgb, var(--d1-dim) 14%, transparent);
}
.tag.strength { color: var(--d1-ok); background: color-mix(in srgb, var(--d1-ok) 14%, transparent); }
.tag.strength.weak { color: var(--d1-warn); background: color-mix(in srgb, var(--d1-warn) 14%, transparent); }
.sub { display: flex; flex-wrap: wrap; gap: 0 12px; min-width: 0; font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
.folder { min-width: 0; overflow-wrap: anywhere; }
.quiet { font-size: var(--fs-sm, 12px); font-weight: 400; color: var(--d1-dim); white-space: nowrap; }
.quiet:hover:not(:disabled), .quiet:focus-visible { color: var(--d1-accent, var(--theme--primary)); }
.meta { white-space: nowrap; }
.read { font-size: var(--fs-sm, 12px); color: var(--theme--foreground); }
.copy { font-size: var(--fs-sm, 12px); color: var(--d1-dim); font-style: italic; }
.why { font-size: var(--fs-sm, 12px); color: var(--theme--foreground); }
.row.weak .why { color: var(--d1-dim); }
.reason { color: var(--d1-dim); }
.rec { color: var(--d1-accent, var(--theme--primary)); font-weight: 650; text-decoration: none; }
.rec:hover { text-decoration: underline; }
.note { font-size: var(--fs-xs, 11px); color: var(--d1-dim); }
.buttons { flex: none; display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
@media (max-width: 640px) {
	.row { flex-wrap: wrap; }
	.main { flex-basis: calc(100% - 80px); }
	.buttons { flex-basis: 100%; justify-content: flex-start; }
}
</style>
