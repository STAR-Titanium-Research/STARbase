<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { DraftListEntry } from '@d1/ui';

// The edit lid (spec §7.1, K12): the row under the map panel's head while editing, in three groups. Edit tools (undo, redo, Add
// (Shift+A), Pick samples, Tidy, Remove, Dissolve: the last two act on the selected card, so they stay with the tools); the draft
// (its name, renamed in place, its project and campaign, and Draft ▾: my drafts and whether this draft is kept); and, at the right
// in a place that does not move, the slot where the Create button goes. Presentational: the page owns the draft and answers the events.
const props = defineProps<{
	name: string;
	canUndo: boolean;
	canRedo: boolean;
	/** My drafts, for Draft ▾. */
	drafts: DraftListEntry[];
	/** The open draft's id (marked in the list, and left out of "Open"). */
	currentId?: string | null;
	/** A change is on its way to the server. */
	saving?: boolean;
	/** The last save failed: said instead of "Saved". */
	saveError?: string;
	/** Said once: "This draft changed in another tab; reloaded." */
	notice?: string;
	/** A card or a wire is selected: Remove is on (a done record says why it cannot go). */
	canRemove?: boolean;
	/** A container is selected: Dissolve is on. */
	canDissolve?: boolean;
	/** The draft has cards of its own on the canvas: Tidy is on. */
	canTidy?: boolean;
}>();
const emit = defineEmits<{
	undo: [];
	redo: [];
	add: [at: { x: number; y: number }];
	pick: [];
	remove: [];
	dissolve: [];
	tidy: [];
	rename: [name: string];
	open: [id: string];
	/** My drafts was opened: the page reads the list again (names and summaries move while a draft is edited). */
	menu: [];
	dismissNotice: [];
}>();

const text = ref(props.name);
watch(() => props.name, (n) => void (text.value = n));
function commitName(e?: Event) {
	const next = text.value.trim();
	if (!next) text.value = props.name;
	else if (next !== props.name) emit('rename', next);
	(e?.target as HTMLElement | undefined)?.blur?.();
}

const menu = ref(false);
const menuEl = ref<HTMLElement | null>(null);
const openBtn = ref<HTMLElement | null>(null);
async function toggleMenu() {
	menu.value = !menu.value;
	if (menu.value) {
		emit('menu');
		await nextTick();
		menuEl.value?.querySelector<HTMLElement>('button')?.focus();
	}
}
function closeMenu(refocus = false) {
	menu.value = false;
	if (refocus) openBtn.value?.focus();
}
function onMenuKey(e: KeyboardEvent) {
	if (e.key === 'Escape') {
		e.stopPropagation();
		closeMenu(true);
		return;
	}
	if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
	e.preventDefault();
	const items = [...(menuEl.value?.querySelectorAll<HTMLElement>('button') ?? [])];
	const at = items.indexOf(document.activeElement as HTMLElement);
	items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
}
function openOne(id: string) {
	closeMenu();
	emit('open', id);
}
/** The Add button opens its menu at the button, below it. */
function add(e: MouseEvent) {
	const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
	emit('add', { x: r.left, y: r.bottom + 4 });
}
const saveText = computed(() => props.saveError || (props.saving ? 'Saving…' : 'Draft kept'));
const when = (iso: string): string => {
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};
</script>

<template>
	<div class="pm-lid" role="toolbar" aria-label="Edit mode">
		<span class="grp tools" role="group" aria-label="Edit tools">
			<button type="button" class="ib" :disabled="!canUndo" title="Undo (Ctrl/⌘+Z)" aria-label="Undo" @click="emit('undo')"><v-icon name="undo" small /></button>
			<button type="button" class="ib" :disabled="!canRedo" title="Redo (Ctrl/⌘+Shift+Z)" aria-label="Redo" @click="emit('redo')"><v-icon name="redo" small /></button>
			<v-button small secondary title="Add a container or a sample (Shift+A)" @click="add"><v-icon name="add" small left />Add<kbd>Shift+A</kbd></v-button>
			<v-button small secondary @click="emit('pick')"><v-icon name="playlist_add" small left />Pick samples</v-button>
			<v-button small secondary :disabled="!canTidy" title="Tidy: lay out the cards of this draft again, as one step you can undo. Nothing that is not part of the draft moves." @click="emit('tidy')"><v-icon name="auto_fix_high" small left />Tidy</v-button>
			<button type="button" class="ib" :disabled="!canRemove" title="Remove the selected card or wire (Delete)" aria-label="Remove" @click="emit('remove')"><v-icon name="delete" small /></button>
			<button type="button" class="ib" :disabled="!canDissolve" title="Dissolve: remove the selected container and wire its input to its output (Ctrl/⌘+Delete)" aria-label="Dissolve" @click="emit('dissolve')"><v-icon name="call_merge" small /></button>
		</span>
		<span class="grp draft" role="group" aria-label="Draft">
			<label class="nm">
				<span class="sr">Draft name</span>
				<input v-model="text" type="text" class="name" maxlength="120" aria-label="Draft name" @keydown.enter.prevent="commitName" @keydown.esc="text = name" @blur="commitName()" />
			</label>
			<slot name="scope" />
			<span class="open" @focusout="(e) => !(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null) && closeMenu()">
				<button ref="openBtn" type="button" class="ob" :class="{ bad: !!saveError }" :title="saveError || undefined" :aria-expanded="menu" aria-haspopup="menu" @click="toggleMenu">Draft<v-icon name="arrow_drop_down" small /></button>
				<!-- The popup holds the save status and a heading as well as the menu; only the drafts are menu items. -->
				<div v-if="menu" ref="menuEl" class="pop" @keydown="onMenuKey">
					<p class="save" :class="{ bad: !!saveError }" role="status">{{ saveText }}</p>
					<p class="mh" aria-hidden="true">My drafts</p>
					<p v-if="!drafts.length" class="none">No drafts yet.</p>
					<div role="menu" aria-label="My drafts">
						<button v-for="d in drafts" :key="d.id" type="button" role="menuitem" class="di" :class="{ cur: d.id === currentId }" :aria-current="d.id === currentId || undefined" @click="openOne(d.id)">
							<span class="dn">{{ d.name }}</span>
							<span class="ds">{{ [d.summary, when(d.updated_at)].filter(Boolean).join(' · ') }}</span>
						</button>
					</div>
				</div>
			</span>
			<!-- A failed save is said where it is seen even while the menu is shut. -->
			<span v-if="saveError" class="sr" role="alert">{{ saveError }}</span>
		</span>
		<span class="grp make" role="group" aria-label="Create">
			<slot name="create" />
		</span>
		<div v-if="notice" class="note" role="status">
			<span>{{ notice }}</span>
			<button type="button" class="ib" aria-label="Dismiss" @click="emit('dismissNotice')"><v-icon name="close" x-small /></button>
		</div>
	</div>
</template>

<style scoped>
.pm-lid {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 6px 8px;
	padding: 6px 12px;
	background: color-mix(in srgb, var(--d1-accent, var(--theme--primary)) 7%, var(--d1-surface, var(--theme--background)));
	border-bottom: 1px solid var(--d1-line, var(--theme--border-color-subdued));
	font-size: var(--fs-sm, 12px);
}
.grp { display: inline-flex; align-items: center; gap: 6px; }
.tools { gap: 2px 6px; flex-wrap: wrap; }
.draft { flex-wrap: wrap; padding-left: 10px; border-left: 1px solid var(--d1-line, var(--theme--border-color-subdued)); }
/* Create keeps its place at the right edge: its label is `Create` while anything is missing, so the button does not move as the draft fills in. */
.make { margin-left: auto; padding-left: 10px; border-left: 1px solid var(--d1-line, var(--theme--border-color-subdued)); }
.ib {
	display: inline-grid; place-items: center; width: 28px; height: 28px; padding: 0; border: 1px solid transparent; border-radius: 8px;
	background: none; color: var(--theme--foreground); cursor: pointer;
}
.ib:hover:not(:disabled), .ib:focus-visible { background: var(--d1-tile, var(--theme--background-subdued)); border-color: var(--d1-line); outline: none; }
.ib:disabled { opacity: 0.4; cursor: default; }
kbd {
	margin-left: 8px; padding: 0 5px; border: 1px solid var(--d1-line); border-radius: 4px; background: var(--d1-surface);
	font: inherit; font-size: var(--fs-xs, 11px); color: var(--d1-dim); line-height: 1.5;
}
.nm { display: inline-flex; min-width: 140px; max-width: 280px; flex: 0 1 240px; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.name {
	width: 100%; min-width: 0; padding: 4px 8px; border: 1px solid transparent; border-radius: 8px; background: transparent;
	color: var(--theme--foreground); font: inherit; font-size: var(--fs-md, 13px); font-weight: 600; text-overflow: ellipsis;
}
.name:hover { border-color: var(--d1-line); }
.name:focus { outline: none; border-color: var(--d1-accent, var(--theme--primary)); background: var(--d1-surface); }
.open { position: relative; }
.ob {
	display: inline-flex; align-items: center; gap: 2px; padding: 4px 6px 4px 10px; border: 1px solid var(--d1-line); border-radius: 8px;
	background: var(--d1-surface); color: inherit; font: inherit; cursor: pointer;
}
.ob:hover, .ob:focus-visible { border-color: var(--d1-accent, var(--theme--primary)); outline: none; }
.ob.bad { border-color: var(--d1-bad, var(--theme--danger)); color: var(--d1-bad, var(--theme--danger)); }
.pop {
	position: absolute; z-index: 30; top: calc(100% + 4px); left: 0; width: 300px; max-height: 320px; overflow: auto; padding: 4px;
	background: var(--d1-surface); border: 1px solid var(--d1-line); border-radius: 10px; box-shadow: var(--d1-shadow-lg, 0 8px 24px rgb(0 0 0 / 0.18));
}
.di { display: flex; flex-direction: column; align-items: flex-start; gap: 1px; width: 100%; padding: 6px 10px; border: 0; border-radius: 8px; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.di:hover, .di:focus-visible { background: var(--d1-tile, var(--theme--background-subdued)); outline: none; }
.di.cur { box-shadow: inset 3px 0 0 var(--d1-accent, var(--theme--primary)); }
.dn { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.ds { color: var(--d1-dim); font-size: var(--fs-xs, 11px); }
.none { margin: 0; padding: 8px 10px; color: var(--d1-dim); }
.mh { margin: 4px 10px 2px; color: var(--d1-dim); font-size: var(--fs-xs, 11px); font-weight: 650; }
.save { margin: 0; padding: 4px 10px 6px; border-bottom: 1px solid var(--d1-line); color: var(--d1-dim); font-size: var(--fs-xs, 11px); }
.save.bad { color: var(--d1-bad, var(--theme--danger)); }
.note { flex-basis: 100%; display: flex; align-items: center; gap: 8px; padding: 4px 8px; border-radius: 8px; background: var(--d1-tile); color: var(--d1-dim); }
.note span { flex: 1; }
</style>
