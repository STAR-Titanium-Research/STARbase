<script setup lang="ts">
import { computed, ref } from 'vue';
import { AppLink, assetUrl, formatDate, recordRoute } from '@d1/ui';
import type { FoundFile } from './inboxApi';
import {
	DOCUMENT_NOTICE, STRENGTH_LABEL, canChange, duplicateText, extractedText, folderOf, hasThumbnail, kindLabel, nameOf, needsReadNotice, ownerText,
	primaryAction, sizeText, suggestionOf,
} from './inboxModel';
import { BATCH_KIND_TEXT } from './inboxBulk';

// One found file: a thumbnail (picture kinds only), its name and folder, what the crawler read and what it thinks the file belongs to
// (and why), and the buttons. The row only reports what was asked; the page does it (useInbox).
const props = defineProps<{
	file: FoundFile;
	busy: boolean;
	/** The page's tab: New and Older files offer Link, Change and Dismiss; Dismissed offers Restore; Recently linked says where it went. */
	tab: 'new' | 'older' | 'linked' | 'dismissed';
	/** Show whose Inbox it is (the person has a team folder too). */
	showOwner: boolean;
}>();
const emit = defineEmits<{
	(e: 'link'): void;
	(e: 'pick'): void;
	(e: 'change'): void;
	(e: 'dismiss'): void;
	(e: 'restore'): void;
}>();

const name = computed(() => nameOf(props.file.rel_path));
const folder = computed(() => folderOf(props.file.rel_path));
const suggestion = computed(() => suggestionOf(props.file));
const action = computed(() => primaryAction(props.file));
const read = computed(() => extractedText(props.file.extracted));
const copy = computed(() => duplicateText(props.file));
const meta = computed(() => [sizeText(props.file.size_bytes), formatDate(props.file.source_mtime ?? props.file.first_seen_at)].filter(Boolean).join(' · '));
const reads = computed(() => needsReadNotice(props.file.kind));

// A thumbnail is asked of the asset route for the picture kinds only; a file it cannot draw (the route needs the bytes, which stay on the
// share) falls back to the kind's icon instead of a broken image.
const broken = ref(false);
const thumb = computed(() => (hasThumbnail(props.file.kind) && props.file.directus_files_id && !broken.value ? assetUrl(props.file.directus_files_id, { width: 128, height: 128, fit: 'cover', format: 'webp' }) : null));
const icon = computed(() => ({ sem_image: 'image', image: 'image', surface_scan: 'view_in_ar', document: 'description', other: 'draft' })[props.file.kind]);

const linkedTo = computed(() => (props.file.linked_collection && props.file.linked_record_id ? recordRoute(props.file.linked_collection, props.file.linked_record_id) : null));
const suggestedTo = computed(() => (props.file.suggested_collection && props.file.suggested_record_id ? recordRoute(props.file.suggested_collection, props.file.suggested_record_id) : null));
const how = computed(() => (props.file.link_kind ? BATCH_KIND_TEXT[props.file.link_kind] : 'Linked'));
</script>

<template>
	<li class="row" :class="{ busy, weak: suggestion?.weak }" :data-state="file.state" data-test="inbox-row">
		<span class="thumb" aria-hidden="true">
			<img v-if="thumb" :src="thumb" alt="" loading="lazy" width="64" height="64" @error="broken = true" />
			<v-icon v-else :name="icon" />
		</span>

		<div class="main">
			<div class="line">
				<span class="name" :title="file.rel_path">{{ name }}</span>
				<span class="tag" :class="`kind-${file.kind}`">{{ kindLabel(file.kind) }}</span>
				<span v-if="file.match_strength !== 'none' && suggestion" class="tag strength" :class="{ weak: suggestion.weak }">{{ STRENGTH_LABEL[file.match_strength] }}</span>
			</div>
			<div class="sub">
				<span class="folder" :title="folder">{{ folder || 'Share root' }}</span>
				<span v-if="meta" class="meta">{{ meta }}</span>
				<span v-if="showOwner" class="meta">{{ ownerText(file) }}</span>
			</div>
			<div v-if="read" class="read">{{ read }}</div>
			<div v-if="copy" class="copy">{{ copy }}</div>

			<div v-if="tab === 'linked'" class="why" data-test="linked-to">
				{{ how }}<template v-if="file.linked_label"> to <AppLink v-if="linkedTo" :to="linkedTo" class="rec">{{ file.linked_label }}</AppLink><template v-else>{{ file.linked_label }}</template></template><template v-if="file.decided_at"> on {{ formatDate(file.decided_at) }}</template>
			</div>
			<div v-else-if="suggestion" class="why" data-test="suggestion">
				Looks like <AppLink v-if="suggestedTo" :to="suggestedTo" class="rec">{{ suggestion.record }}</AppLink><template v-else>{{ suggestion.record }}</template>:
				<span class="reason">{{ suggestion.text }}</span>
			</div>
			<div v-if="tab !== 'linked' && tab !== 'dismissed' && file.kind === 'surface_scan'" class="note" data-test="scan-notice">{{ action.kind === 'disabled' ? action.reason : '' }}</div>
			<div v-else-if="tab !== 'linked' && tab !== 'dismissed' && reads" class="note">{{ DOCUMENT_NOTICE }}</div>
		</div>

		<div class="buttons">
			<template v-if="tab === 'new' || tab === 'older'">
				<v-button v-if="action.kind === 'disabled'" small disabled :title="action.reason">{{ action.label }}</v-button>
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
.thumb img { width: 64px; height: 64px; object-fit: cover; display: block; }
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
