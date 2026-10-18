<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import type { DraftListEntry } from '@d1/ui';

// The edit lid (spec §7.1): the row under the map panel's head while editing. Undo and redo, Add (Shift+A), Pick
// samples, the draft's name (renamed in place), Open ▾ (my drafts) and, at the right, the slot where the Create button goes.
// Presentational: the page owns the draft and answers the events.
const props = defineProps<{
	name: string;
	canUndo: boolean;
	canRedo: boolean;
	/** My drafts, for Open ▾. */
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
}>();
const emit = defineEmits<{
	undo: [];
	redo: [];
	add: [at: { x: number; y: number }];
	pick: [];
	remove: [];
	dissolve: [];
	rename: [name: string];
	open: [id: string];
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
const when = (iso: string): string => {
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};
</script>

<template>
	<div class="pm-lid" role="toolbar" aria-label="Edit mode">
		<span class="grp">
			<button type="button" class="ib" :disabled="!canUndo" title="Undo (Ctrl/⌘+Z)" aria-label="Undo" @click="emit('undo')"><v-icon name="undo" small /></button>
			<button type="button" class="ib" :disabled="!canRedo" title="Redo (Ctrl/⌘+Shift+Z)" aria-label="Redo" @click="emit('redo')"><v-icon name="redo" small /></button>
		</span>
		<v-button small secondary title="Add a container or a sample (Shift+A)" @click="add"><v-icon name="add" small left />Add<kbd>Shift+A</kbd></v-button>
		<v-button small secondary @click="emit('pick')"><v-icon name="playlist_add" small left />Pick samples</v-button>
		<span class="grp">
			<button type="button" class="ib" :disabled="!canRemove" title="Remove the selected card or wire (Delete)" aria-label="Remove" @click="emit('remove')"><v-icon name="delete" small /></button>
			<button type="button" class="ib" :disabled="!canDissolve" title="Dissolve: remove the selected container and wire its input to its output (Ctrl/⌘+Delete)" aria-label="Dissolve" @click="emit('dissolve')"><v-icon name="call_merge" small /></button>
		</span>
		<label class="nm">
			<span class="sr">Draft name</span>
			<input v-model="text" type="text" class="name" maxlength="120" aria-label="Draft name" @keydown.enter.prevent="commitName" @keydown.esc="text = name" @blur="commitName()" />
		</label>
		<span class="open" @focusout="(e) => !(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null) && closeMenu()">
			<button ref="openBtn" type="button" class="ob" :aria-expanded="menu" aria-haspopup="menu" @click="toggleMenu">My drafts<v-icon name="arrow_drop_down" small /></button>
			<div v-if="menu" ref="menuEl" class="pop" role="menu" @keydown="onMenuKey">
				<p v-if="!drafts.length" class="none">No drafts yet.</p>
				<button v-for="d in drafts" :key="d.id" type="button" role="menuitem" class="di" :class="{ cur: d.id === currentId }" :aria-current="d.id === currentId || undefined" @click="openOne(d.id)">
					<span class="dn">{{ d.name }}</span>
					<span class="ds">{{ [d.summary, when(d.updated_at)].filter(Boolean).join(' · ') }}</span>
				</button>
			</div>
		</span>
		<span class="save" :class="{ bad: !!saveError }" role="status">{{ saveError || (saving ? 'Saving…' : 'Draft kept') }}</span>
		<span class="spacer"></span>
		<slot name="create" />
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
.spacer { flex: 1; min-width: 0; }
.grp { display: inline-flex; gap: 2px; }
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
.save { color: var(--d1-dim); font-size: var(--fs-xs, 11px); white-space: nowrap; }
.save.bad { color: var(--d1-bad, var(--theme--danger)); white-space: normal; }
.note { flex-basis: 100%; display: flex; align-items: center; gap: 8px; padding: 4px 8px; border-radius: 8px; background: var(--d1-tile); color: var(--d1-dim); }
.note span { flex: 1; }
</style>
