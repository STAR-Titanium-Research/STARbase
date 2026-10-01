<script setup lang="ts">
// Searchable dropdown for picking a cut to replay — the same combobox interaction as LookupField
// (search input, absolute-positioned dropdown overlay, closes and collapses to the picked label on
// selection), applied to the Replay cut list. Previously an always-visible list of buttons under
// the search box, which cost real vertical space in the Recording panel whether or not you were
// actively picking a cut. Wired directly to the workspace's `replay`/`searchCuts`/`pickReplayCut`
// rather than taking props: the option shape (ppr/diameters alongside label/cacheId) is specific
// to this one picker, so there is nothing generic here worth sharing with LookupField.
import { onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import { useWorkspace, type ReplayOption } from '../workspace';
import { useListNav } from '../../ui/listNav';

const w = useWorkspace();
const open = ref(false);
// Whether the picker is actively searching for a DIFFERENT cut than the one currently loaded.
// Deliberately separate from w.replay.cacheId: clearing cacheId itself to show the search box
// (the previous approach) meant dismissing the dropdown WITHOUT picking — Escape, or a click
// outside — permanently lost the loaded cut's label and its parameter panel even though playback
// kept running that exact cut. reselecting only ever affects what this component shows.
const reselecting = ref(false);
const inputEl = ref<HTMLInputElement | null>(null);
const rootEl = ref<HTMLDivElement | null>(null);
const menuEl = ref<HTMLElement | null>(null);
const menuId = useId();
let t: any = null;

function onDocPointerDown(e: PointerEvent) {
	if (open.value && rootEl.value && e.target instanceof Node && !rootEl.value.contains(e.target)) {
		open.value = false;
	}
}
onMounted(() => document.addEventListener('pointerdown', onDocPointerDown, true));
onBeforeUnmount(() => { document.removeEventListener('pointerdown', onDocPointerDown, true); clearTimeout(t); });

function onInput() {
	open.value = true;
	clearTimeout(t);
	t = setTimeout(() => w.searchCuts(w.replay.query), 300);
}
function focus() { open.value = true; if (w.replay.options.length === 0) w.searchCuts(w.replay.query); }
function pick(o: ReplayOption) {
	w.pickReplayCut(o);
	close();
}
function close() {
	open.value = false;
	// Only revert to the collapsed view if there IS a loaded cut to revert to — dismissing before
	// ever picking one (first use) has nothing to fall back to, so the search box stays put.
	if (w.replay.cacheId) reselecting.value = false;
	inputEl.value?.blur();
}
function change() {
	reselecting.value = true;
	w.replay.query = '';
	// pickReplayCut auto-fills Sample/Machine/Operation-type from the loaded cut, and searchCuts
	// AND-narrows the list by all three (workspace.ts). Left set, they pin the reselect list to
	// (essentially) the very cut we're trying to move away from — so "change" would only ever offer
	// one option. Clearing them here (the explicit "find a different cut" action) restores the full
	// recent list; the forward flow, where the user fills Sample first to deliberately narrow, is
	// untouched since change() only fires on reselect. The replay metadata tiles read w.replay.*,
	// not these w.link.* fields, so nothing the user is reading gets wiped.
	w.link.sampleId = ''; w.link.sampleLabel = '';
	w.link.equipmentId = ''; w.link.equipmentLabel = '';
	w.meta.op_type = '';
	open.value = true;
	w.searchCuts('');
	requestAnimationFrame(() => inputEl.value?.focus());
}
function delayedBlurClose() { window.setTimeout(() => { open.value = false; }, 150); }
const { active, move, pickActive, reset: resetNav } = useListNav(() => w.replay.options, pick, menuEl);
watch(() => w.replay.options, resetNav);
function onArrow(delta: 1 | -1) { open.value = true; move(delta); }
</script>

<template>
	<div ref="rootEl" class="cutpicker">
		<span class="lbl">Find a cut <span class="sub">(narrowed by Sample/Operation type above, Machine below)</span></span>
		<!-- Collapsed: the picked cut's label, one line, with a button to search again. -->
		<div v-if="w.replay.cacheId && !reselecting" class="chosen">
			<span class="chosen-label">{{ w.replay.label }}</span>
			<button type="button" class="change" :disabled="w.locked.value" @click="change">
				<span class="material-symbols-rounded">search</span> change
			</button>
		</div>
		<!-- Expanded: search box + dropdown, exactly while actively picking. -->
		<div v-else class="box">
			<input ref="inputEl" v-model="w.replay.query" placeholder="e.g. 10-AA-MF" :disabled="w.locked.value"
				role="combobox" aria-autocomplete="list" :aria-expanded="open && !w.locked.value" :aria-controls="menuId"
				:aria-activedescendant="open && active >= 0 ? `${menuId}-${active}` : undefined"
				@input="onInput" @focus="focus" @keydown.esc.prevent="close"
				@keydown.enter.prevent="pickActive()" @keydown.down.prevent="onArrow(1)" @keydown.up.prevent="onArrow(-1)"
				@blur="delayedBlurClose" />
			<div v-if="open && !w.locked.value" :id="menuId" ref="menuEl" class="menu" role="listbox">
				<div v-if="w.replay.loading" class="mi hint">searching…</div>
				<button v-for="(o, i) in w.replay.options" :id="`${menuId}-${i}`" :key="o.cacheId" type="button" class="mi" :class="{ active: i === active }"
					role="option" :aria-selected="i === active" tabindex="-1" @mousedown.prevent="pick(o)" @mouseenter="active = i">
					{{ o.label }}
				</button>
				<div v-if="!w.replay.loading && w.replay.options.length === 0" class="mi hint">no matches</div>
			</div>
		</div>
	</div>
</template>

<style scoped>
.cutpicker { position: relative; margin-bottom: 8px; }
.lbl { display: block; font-size: var(--fs-sm); color: var(--text-dim); margin-bottom: 3px; }
.sub { font-weight: 400; }
.box { display: flex; align-items: center; background: var(--bg-3); border: 1px solid var(--border); border-radius: 7px; }
.box input { flex: 1; padding: 7px 9px; font-size: var(--fs-md); color: var(--text); background: transparent; border: none; outline: none; }
.box:focus-within { border-color: var(--accent); } /* the input sets outline:none; see LookupField */
.box input:disabled { opacity: 0.55; }
.menu { position: absolute; z-index: 30; left: 0; right: 0; top: 100%; margin-top: 2px; max-height: 200px; overflow: auto; background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px; box-shadow: 0 12px 30px rgba(0,0,0,0.45); }
.mi { display: block; width: 100%; text-align: left; padding: 7px 10px; font-size: var(--fs-md); font-family: var(--mono); color: var(--text); background: transparent; border: none; cursor: pointer; }
.mi:hover, .mi.active { background: var(--surface); }
.mi.hint { color: var(--text-dim); font-family: inherit; cursor: default; }
.chosen { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 7px 9px; background: color-mix(in srgb, var(--accent) 10%, transparent); border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent); border-radius: 7px; }
.chosen-label { font-size: var(--fs-md); font-family: var(--mono); color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.change { display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0; padding: 4px 8px; font-size: var(--fs-xs); color: var(--text-dim); background: transparent; border: 1px solid var(--border); border-radius: 6px; cursor: pointer; }
.change:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); }
.change:disabled { opacity: 0.5; cursor: not-allowed; }
.change .material-symbols-rounded { font-size: var(--icon-xs); }
</style>
