<script setup lang="ts">
import { computed, ref } from 'vue';
import type { FoundFile } from './inboxApi';
import { folderOf, nameOf } from './inboxModel';

// The second-file picker of Compare (spec 2026-10-20-inbox-file-viewer-design.md decision 5), in the view box's right rail. It offers only files already in the list
// the person came from (the open file is never offered), the files in the open file's own folder first, then the rest of the list; the search narrows both by name
// or path. A partner the person may not see is shown as the lock pattern ("A file from another person's folder": no name) and can only be cleared.
const props = defineProps<{
	/** The files in the list, without the open one. */
	candidates: FoundFile[];
	/** The open file's folder (folderOf its rel_path): files in it come first. */
	folder: string;
	/** The partner now chosen, when it is a file the person can see. */
	selected: FoundFile | null;
	/** The partner named in the address is one the person may not see. */
	locked: boolean;
	/** The list goes on beyond the files read so far. */
	more: boolean;
	moreBusy: boolean;
}>();
const emit = defineEmits<{
	(e: 'pick', candidateId: string): void;
	(e: 'clear'): void;
	(e: 'more'): void;
}>();

const SHOWN = 30;
const query = ref('');
const needle = computed(() => query.value.trim().toLowerCase());
const matching = computed(() => (needle.value ? props.candidates.filter((f) => f.rel_path.toLowerCase().includes(needle.value)) : props.candidates));
const sameFolder = computed(() => matching.value.filter((f) => folderOf(f.rel_path) === props.folder));
const elsewhere = computed(() => matching.value.filter((f) => folderOf(f.rel_path) !== props.folder));
const groups = computed(() => [
	{ id: 'same', title: 'Same folder', rows: sameFolder.value.slice(0, SHOWN), total: sameFolder.value.length },
	{ id: 'rest', title: 'Rest of the list', rows: elsewhere.value.slice(0, SHOWN), total: elsewhere.value.length },
].filter((g) => g.total > 0));
</script>

<template>
	<div class="picker" data-test="compare-picker">
		<div v-if="locked" class="chosen locked" data-test="picker-locked">
			<v-icon name="lock" small />
			<span class="txt">A file from another person's folder</span>
			<button type="button" class="icon-btn" aria-label="Clear the second file" data-test="picker-clear" @click="emit('clear')"><v-icon name="close" small /></button>
		</div>
		<div v-else-if="selected" class="chosen" data-test="picker-selected">
			<span class="txt mono" :title="selected.rel_path">{{ nameOf(selected.rel_path) }}</span>
			<button type="button" class="icon-btn" aria-label="Clear the second file" data-test="picker-clear" @click="emit('clear')"><v-icon name="close" small /></button>
		</div>
		<input v-model="query" type="search" class="search" placeholder="Find a file in this list" aria-label="Find a second file in this list" data-test="picker-search" />
		<p v-if="!groups.length" class="hint" data-test="picker-none">{{ needle ? 'No file in this list matches.' : 'There is no other picture in this list.' }}</p>
		<template v-for="g in groups" :key="g.id">
			<h4 class="grp">{{ g.title }}<span class="cnt">{{ g.total }}</span></h4>
			<ul class="opts" role="listbox" :aria-label="g.title">
				<li v-for="f in g.rows" :key="f.candidate_id" role="presentation">
					<button type="button" role="option" class="opt" :aria-selected="selected?.candidate_id === f.candidate_id" :title="f.rel_path" :data-id="f.candidate_id" data-test="picker-option" @click="emit('pick', f.candidate_id)">
						<span class="nm">{{ nameOf(f.rel_path) }}</span>
						<span v-if="g.id === 'rest'" class="fd">{{ folderOf(f.rel_path) || 'Share root' }}</span>
					</button>
				</li>
			</ul>
			<p v-if="g.total > g.rows.length" class="hint">Showing {{ g.rows.length }} of {{ g.total }}. Search to narrow it.</p>
		</template>
		<button v-if="more" type="button" class="lf-link" :disabled="moreBusy" data-test="picker-more" @click="emit('more')">{{ moreBusy ? 'Loading…' : 'Load more files from the list' }}</button>
	</div>
</template>

<style scoped src="./inboxShared.css"></style>
<style scoped>
.picker { display: flex; flex-direction: column; align-items: stretch; gap: 6px; width: 100%; min-width: 0; }
.chosen { display: flex; align-items: center; gap: 6px; min-width: 0; padding: 2px 2px 2px 8px; border: 1px solid var(--d1-line); border-radius: 8px; background: var(--d1-tile); font-size: var(--fs-sm, 12px); }
.chosen.locked { color: var(--d1-dim); font-style: italic; }
.txt { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.mono { font-family: var(--theme--fonts--monospace--font-family, monospace); font-weight: 650; }
.search {
	box-sizing: border-box; width: 100%; height: 28px; padding: 0 8px; font: inherit; font-size: var(--fs-sm, 12px); color: var(--theme--foreground);
	background: var(--theme--background); border: 1px solid var(--d1-line); border-radius: 8px;
}
.search:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 2px; }
.grp { display: flex; justify-content: space-between; margin: 4px 0 0; font-size: var(--fs-xs, 11px); font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: var(--d1-dim); }
.cnt { font-weight: 600; font-variant-numeric: tabular-nums; }
.opts { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; max-height: 180px; overflow: auto; border: 1px solid var(--d1-line); border-radius: 8px; }
.opt { display: flex; flex-direction: column; align-items: flex-start; gap: 0; width: 100%; padding: 4px 8px; border: 0; background: none; color: var(--theme--foreground); text-align: left; font: inherit; cursor: pointer; }
.opt + .opt, li + li .opt { border-top: 1px solid var(--d1-line); }
.opt:hover { background: var(--d1-tile); }
.opt:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: -2px; }
.opt[aria-selected="true"] { background: var(--d1-tint); }
.nm { max-width: 100%; font-family: var(--theme--fonts--monospace--font-family, monospace); font-size: var(--fs-sm, 12px); font-weight: 650; overflow-wrap: anywhere; }
.fd { max-width: 100%; font-size: var(--fs-xs, 11px); color: var(--d1-dim); overflow-wrap: anywhere; }
.hint { margin: 0; font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
</style>
