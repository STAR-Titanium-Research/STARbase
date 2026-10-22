<script setup lang="ts">
import { computed } from 'vue';
import { RecordRail, formatDate, type ContentsEntry, type Fact } from '@d1/ui';
import type { FoundFile } from './inboxApi';
import { extractedText, folderText, kindIcon, kindLabel, nameOf, ownerText, primaryAction, settingsOf, sizeText } from './inboxModel';
import LinkCard from './LinkCard.vue';
import LinkedSiblings from './LinkedSiblings.vue';
import SemSettingsList from './SemSettingsList.vue';

// The left detail panel of the view box page (spec 2026-10-20-inbox-file-viewer-design.md decision 4), in the look of the record pages' RecordRail: the kind
// pill and the "Found file" tag, the file's name in mono, its folder, the icon actions (link, dismiss or restore, copy the path), the few facts and the
// imaging settings the crawler read, and "On this page". It only reports what was asked; the page does it, through the same actions the Inbox row uses (so a
// refusal, an administrator who may read but not change, is the endpoint's own and shows in the page's notice). A linked file shows its Link card and the strip
// of the other pictures on its record under the actions, above the facts.
const props = defineProps<{
	file: FoundFile;
	/** The list's tab: New and Older files offer Link and Dismiss; Dismissed offers Restore; Recently linked offers neither. */
	tab: 'new' | 'older' | 'linked' | 'dismissed';
	showOwner: boolean;
	busy: boolean;
	/** The path was just copied: the button says so for a moment. */
	copied: boolean;
	contents: ContentsEntry[];
	/** The other pictures on the file's record and how many there are in all (the page reads them, it needs them for Compare too). */
	siblings: readonly FoundFile[];
	siblingsTotal: number;
	/** An Undo is running (the page's one at a time). */
	undoing: boolean;
}>();
const emit = defineEmits<{
	(e: 'link'): void;
	(e: 'dismiss'): void;
	(e: 'restore'): void;
	(e: 'copy'): void;
	/** The Link card: Open the record's page, Change… (the Link dialog), Undo link; the strip: open a picture of the same record, or compare with one. */
	(e: 'open-record', route: string): void;
	(e: 'change'): void;
	(e: 'undo'): void;
	(e: 'open-sibling', candidateId: string): void;
	(e: 'compare-sibling', candidateId: string): void;
}>();

const name = computed(() => nameOf(props.file.rel_path));
const folder = computed(() => folderText(props.file.rel_path));
const action = computed(() => primaryAction(props.file));
const canAct = computed(() => props.tab === 'new' || props.tab === 'older');
const settings = computed(() => settingsOf(props.file));
const read = computed(() => extractedText(props.file.extracted));
const facts = computed<Fact[]>(() => [
	{ label: 'Size', value: sizeText(props.file.size_bytes) },
	{ label: 'Last changed', value: formatDate(props.file.source_mtime ?? props.file.first_seen_at) },
	...(props.showOwner ? [{ label: 'Whose', value: ownerText(props.file) }] : []),
]);
</script>

<template>
	<RecordRail :kind="kindLabel(file.kind)" :code="name" :title="folder" :facts="facts" :contents="contents" data-test="file-rail">
		<template #kind-icon><v-icon :name="kindIcon(file.kind)" x-small /></template>
		<template #status><span class="found" data-test="rail-found">Found file</span></template>
		<template #actions>
			<v-button v-if="canAct" icon small :disabled="busy" :title="action.label" :aria-label="action.label" data-test="rail-link" @click="emit('link')"><v-icon name="link" small /><span class="sr-only">{{ action.label }}</span></v-button>
			<v-button v-if="canAct" icon small secondary :disabled="busy" title="Dismiss" aria-label="Dismiss" data-test="rail-dismiss" @click="emit('dismiss')"><v-icon name="block" small /><span class="sr-only">Dismiss</span></v-button>
			<v-button v-if="tab === 'dismissed'" icon small secondary :disabled="busy" title="Restore" aria-label="Restore" data-test="rail-restore" @click="emit('restore')"><v-icon name="restore" small /><span class="sr-only">Restore</span></v-button>
			<v-button icon small secondary :title="copied ? 'Path copied' : 'Copy path'" :aria-label="copied ? 'Path copied' : 'Copy path'" data-test="rail-copy" @click="emit('copy')"><v-icon :name="copied ? 'check' : 'content_copy'" small /><span class="sr-only">{{ copied ? 'Path copied' : 'Copy path' }}</span></v-button>
		</template>
		<template v-if="file.state === 'linked'" #extra>
			<div id="linked" class="linked" data-test="rail-linked">
				<LinkCard :file="file" :busy="busy || undoing" @open="emit('open-record', $event)" @change="emit('change')" @undo="emit('undo')" />
				<LinkedSiblings :file="file" :rows="siblings" :total="siblingsTotal" @open="emit('open-sibling', $event)" @compare="emit('compare-sibling', $event)" />
			</div>
		</template>
		<template #after-facts>
			<div v-if="settings.length || read" id="imaging" class="imaging" data-test="rail-imaging">
				<SemSettingsList v-if="settings.length" :rows="settings" />
				<p v-else class="read">{{ read }}</p>
			</div>
		</template>
	</RecordRail>
</template>

<style scoped>
.found { font-size: var(--fs-sm, 12px); font-weight: 650; color: var(--d1-dim); }
.imaging { min-width: 0; }
.linked { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.read { margin: 0; font-size: var(--fs-sm, 12px); }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; margin: -1px; padding: 0; border: 0; }
</style>
