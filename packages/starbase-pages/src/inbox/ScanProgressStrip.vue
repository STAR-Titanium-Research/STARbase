<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue';
import { useExplorerHost } from '@d1/ui';
import type { ProgressFolder } from './inboxApi';
import ScanBar from './ScanBar.vue';
import { FOLDERS_KNOWN_HELP, OVERALL_HELP, barTone, isComplete, measuresOf, overallPct, stripName, stripParts } from './progressModel';
import { readOpenScanFolders, writeOpenScanFolders } from './useViewSettings';

// Scan progress on the Inbox page: one line per folder of the person's (their own and their teams'), e.g. "mtp21dp  100% · 2,222 images read · 11 SEM · updated 16:38".
// The percentage is the LOWEST of the four bars, so 100% means really done (its tooltip says so). The arrow opens that folder's four labelled bars. Closed by
// default; which folders are open is remembered per person in this browser. Always there when the person has a folder (100% is a reassurance); the page leaves
// it out when they have none. The counts come from the server, the percentages are worked out here (progressModel.ts).
const props = defineProps<{
	folders: ProgressFolder[];
	/** When the last full scan ended; null before the first one. */
	updatedAt: string | null;
}>();
const host = useExplorerHost();
const personId = computed(() => host.user.value?.id ?? null);
const open = ref<string[]>([]);
// The signed-in person can arrive after the page is made: read their choice whenever it is known.
watch(personId, (id) => (open.value = readOpenScanFolders(id)), { immediate: true });
function toggle(id: string) {
	open.value = open.value.includes(id) ? open.value.filter((x) => x !== id) : [...open.value, id];
	writeOpenScanFolders(personId.value, open.value);
}
const uid = useId();
const scanFinished = computed(() => props.updatedAt !== null);
const rows = computed(() =>
	props.folders.map((f) => ({
		folder: f,
		id: f.owner.id,
		name: stripName(f),
		parts: stripParts(f, props.updatedAt),
		tone: barTone(overallPct(f), scanFinished.value),
		measures: measuresOf(f),
		complete: isComplete(f),
		isOpen: open.value.includes(f.owner.id),
	})),
);
</script>

<template>
	<section v-if="folders.length" class="strip" aria-label="Scan progress" data-test="scan-progress">
		<div v-for="r in rows" :key="r.id" class="item" :data-complete="r.complete" data-test="scan-folder">
			<button type="button" class="line" :aria-expanded="r.isOpen" :aria-controls="`${uid}-${r.id}`" data-test="scan-toggle" @click="toggle(r.id)">
				<span class="name">{{ r.name }}</span>{{ ' ' }}
				<span class="meta">
					<template v-for="(p, i) in r.parts" :key="i">
						<template v-if="i > 0">{{ ' ' }}<span class="sep" aria-hidden="true">·</span>{{ ' ' }}</template>
						<span v-if="i === 0 && r.parts.length > 1" class="pct" :class="`tone-${r.tone}`" :title="OVERALL_HELP" data-test="scan-overall">{{ p }}</span>
						<span v-else>{{ p }}</span>
					</template>
				</span>
				<v-icon :name="r.isOpen ? 'expand_less' : 'expand_more'" small class="chev" />
			</button>
			<div v-if="r.isOpen" :id="`${uid}-${r.id}`" class="detail" data-test="scan-detail">
				<p class="where"><span class="root" :title="r.folder.owner.root">{{ r.folder.owner.root }}</span></p>
				<div class="measures">
					<ScanBar v-for="m in r.measures" :key="m.key" :measure="m" :scan-finished="scanFinished" />
				</div>
				<p class="d1-note" data-test="scan-help">{{ FOLDERS_KNOWN_HELP }}</p>
			</div>
		</div>
	</section>
</template>

<style scoped>
.strip { min-width: 0; background: var(--d1-surface, var(--theme--background)); border: 1px solid var(--d1-line, var(--theme--border-color-subdued)); border-radius: var(--d1-radius, 12px); box-shadow: var(--d1-shadow, none); overflow: hidden; }
.item + .item { border-top: 1px solid var(--d1-line, var(--theme--border-color-subdued)); }
.line {
	display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 12px; width: 100%; min-height: 36px; box-sizing: border-box; padding: 8px 14px; text-align: left;
	font: inherit; font-size: var(--fs-md, 13px); color: var(--theme--foreground); background: transparent; border: 0; cursor: pointer;
}
.line:hover { background: var(--d1-tile, var(--theme--background-subdued)); }
.line:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: -2px; }
.name { font-family: var(--theme--fonts--monospace--font-family, monospace); font-weight: 700; }
.meta { display: inline-flex; flex-wrap: wrap; gap: 0 6px; flex: 1; min-width: 0; font-size: var(--fs-sm, 12px); color: var(--d1-dim); font-variant-numeric: tabular-nums; }
.pct { font-weight: 600; color: var(--theme--foreground); }
.pct.tone-ok { color: var(--d1-ok); }
.pct.tone-warn { color: var(--d1-warn); }
.chev { align-self: center; margin-left: auto; color: var(--d1-dim); }
.detail { padding: 4px 14px 12px; border-top: 1px solid var(--d1-line, var(--theme--border-color-subdued)); }
.where { margin: 8px 0 0; }
.root { font-family: var(--theme--fonts--monospace--font-family, monospace); font-size: var(--fs-sm, 12px); color: var(--d1-dim); overflow-wrap: anywhere; }
.measures { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(200px, 100%), 1fr)); gap: 10px 28px; padding: 8px 0 10px; }
@media (pointer: coarse) { .line { min-height: 44px; } }
</style>
