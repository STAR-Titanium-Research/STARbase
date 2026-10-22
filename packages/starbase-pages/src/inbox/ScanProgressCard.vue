<script setup lang="ts">
import { computed } from 'vue';
import { Section } from '@d1/ui';
import { whenText } from './adminView';
import type { ProgressFolder } from './inboxApi';
import ScanBar from './ScanBar.vue';
import { FOLDERS_KNOWN_HELP, allComplete, isComplete, measuresOf } from './progressModel';

// "Scan progress" on the Inbox page: how far the crawler has come in the person's own folder and their teams' folders, one row per folder with four thin
// bars. Closed when everything is at 100% (nothing to watch), open otherwise; the page leaves it out when the person has no folder. The counts come from the
// server, the percentages are worked out here (progressModel.ts).
const props = defineProps<{
	folders: ProgressFolder[];
	/** When the last full scan ended; null before the first one. */
	updatedAt: string | null;
}>();
const rows = computed(() => props.folders.map((f) => ({ folder: f, measures: measuresOf(f), complete: isComplete(f) })));
const scanFinished = computed(() => props.updatedAt !== null);
const updated = computed(() => (props.updatedAt ? `Updated ${whenText(props.updatedAt)}` : 'No scan has finished yet'));
</script>

<template>
	<!-- the Section reads `collapsed` once, when it is made: the page makes the card after the answer has come -->
	<Section title="Scan progress" :count="folders.length" collapsible :collapsed="allComplete(folders)" class="progress" data-test="scan-progress">
		<template #actions>
			<span class="updated" data-test="scan-updated">{{ updated }}</span>
		</template>
		<p class="d1-note" data-test="scan-help">How far the crawler has read your folders. {{ FOLDERS_KNOWN_HELP }}</p>
		<ul class="folders">
			<li v-for="r in rows" :key="r.folder.owner.id" class="folder" :data-complete="r.complete" data-test="scan-folder">
				<div class="name">
					<strong>{{ r.folder.owner.kind === 'team' ? `${r.folder.owner.name} team folder` : 'My folder' }}</strong>
					<span class="root" :title="r.folder.owner.root">{{ r.folder.owner.root }}</span>
					<span v-if="r.folder.folders_known === 0" class="wait">Not scanned yet</span>
				</div>
				<div class="measures">
					<ScanBar v-for="m in r.measures" :key="m.key" :measure="m" :scan-finished="scanFinished" />
				</div>
			</li>
		</ul>
	</Section>
</template>

<style scoped>
.updated { font-size: var(--fs-sm, 12px); color: var(--d1-dim); white-space: nowrap; }
.folders { margin: 8px 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 14px; }
.folder { min-width: 0; }
.name { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 10px; padding-bottom: 6px; border-bottom: 1px solid var(--d1-line, var(--theme--border-color-subdued)); }
.name strong { font-size: var(--fs-md, 13px); font-weight: 650; }
.root { font-family: var(--theme--fonts--monospace--font-family, monospace); font-size: var(--fs-sm, 12px); color: var(--d1-dim); overflow-wrap: anywhere; }
.wait { font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
.measures { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(200px, 100%), 1fr)); gap: 10px 28px; padding-top: 8px; }
</style>
