<script setup lang="ts">
// Debounced Directus typeahead. Emits the selected id (v-model) and a `select` event with the full
// item (for auto-fill, e.g. sample diameter). Shows the chosen label; a clear button resets it.
import { computed, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import type { LookupItem } from '../directusLookups';
import { useListNav } from '../../ui/listNav';
import { pickRows } from '../../ui/pickList';

const props = defineProps<{
	modelValue: string;
	label: string;
	search: (q: string) => Promise<LookupItem[]>;
	placeholder?: string;
	disabled?: boolean;
	displayLabel?: string;
	/** Material Symbols Rounded ligature name, shown leading the input box. */
	icon?: string;
	/** Ids already picked into a multi-pick selection this field feeds (#99, see pickList.ts). */
	selectedIds?: readonly string[];
	/** Hide `selectedIds` from the results instead of showing them disabled. */
	hideSelected?: boolean;
}>();
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void; (e: 'select', item: LookupItem): void }>();

const text = ref(props.displayLabel || '');
const open = ref(false);
const items = ref<LookupItem[]>([]);
const loading = ref(false);
const inputEl = ref<HTMLInputElement | null>(null);
const rootEl = ref<HTMLLabelElement | null>(null);
const menuEl = ref<HTMLElement | null>(null);
const menuId = useId();
let t: any = null;

// Click-away close: blur+timeout (below) mostly covers this, but is timing-sensitive (a click
// landing between two LookupFields, or anything that doesn't cleanly shift focus, could leave the
// menu stuck open with no way to dismiss it except Escape). A capture-phase document listener is
// the standard robust pattern for "close on click outside" and doesn't depend on focus/blur at
// all — it just checks whether the click happened inside this component's own DOM.
function onDocPointerDown(e: PointerEvent) {
	if (open.value && rootEl.value && e.target instanceof Node && !rootEl.value.contains(e.target)) {
		open.value = false;
	}
}
onMounted(() => document.addEventListener('pointerdown', onDocPointerDown, true));
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocPointerDown, true));

watch(() => props.displayLabel, (v) => { if (v !== undefined) text.value = v; });

function onInput() {
	emit('update:modelValue', ''); // typing invalidates the current selection
	open.value = true;
	clearTimeout(t);
	t = setTimeout(runSearch, 250);
}
async function runSearch() {
	loading.value = true;
	try { items.value = await props.search(text.value); } catch { items.value = []; } finally { loading.value = false; }
	resetNav();
}
function focus() { open.value = true; if (items.value.length === 0) runSearch(); }
function pick(it: LookupItem) {
	emit('update:modelValue', it.id);
	emit('select', it);
	text.value = it.label;
	close();
}
// Close and drop focus so the menu can't linger/re-open after a pick or Escape.
function close() { open.value = false; inputEl.value?.blur(); }
function clear() { emit('update:modelValue', ''); text.value = ''; items.value = []; }
// The current value is marked (check + aria-selected); already-picked ids are hidden or disabled.
const rows = computed(() => pickRows(items.value, (it) => it.id,
	{ currentId: props.modelValue, selectedIds: props.selectedIds, hideSelected: props.hideSelected }));
const { active, move, pickActive, reset: resetNav } = useListNav(() => rows.value, (r) => pick(r.item), menuEl, (r) => r.picked);
function onArrow(delta: 1 | -1) { open.value = true; move(delta); }
// A bare `setTimeout` inside an inline template handler resolves against the component instance
// (_ctx.setTimeout), not window — Vue templates don't fall through to globals for function calls.
// Delay the blur-close here instead, where `setTimeout` correctly resolves to the real global.
function delayedBlurClose() { window.setTimeout(() => { open.value = false; }, 150); }
</script>

<template>
	<label ref="rootEl" class="lookup">
		<span class="lbl">{{ label }}</span>
		<div class="box" :class="{ set: !!modelValue }">
			<span v-if="icon" class="material-symbols-rounded lead">{{ icon }}</span>
			<input ref="inputEl" v-model="text" :placeholder="placeholder" :disabled="disabled"
				role="combobox" aria-autocomplete="list" :aria-expanded="open && !disabled" :aria-controls="menuId"
				:aria-activedescendant="open && active >= 0 ? `${menuId}-${active}` : undefined"
				@input="onInput" @focus="focus" @keydown.esc.prevent="close" @keydown.enter.prevent="pickActive()"
				@keydown.down.prevent="onArrow(1)" @keydown.up.prevent="onArrow(-1)"
				@blur="delayedBlurClose" />
			<button v-if="modelValue" class="x" type="button" :disabled="disabled" :title="`Clear ${label}`" :aria-label="`Clear ${label}`" @mousedown.prevent="clear">
				<span class="material-symbols-rounded">close</span>
			</button>
			<slot name="badge" />
		</div>
		<div v-if="open && !disabled" :id="menuId" ref="menuEl" class="menu" role="listbox">
			<div v-if="loading" class="mi hint">searching…</div>
			<button v-for="(r, i) in rows" :id="`${menuId}-${i}`" :key="r.item.id" type="button" class="mi"
				:class="{ active: i === active, current: r.current, picked: r.picked }" :data-active="i === active"
				role="option" :aria-selected="r.current || r.picked" :aria-disabled="r.picked || undefined" tabindex="-1"
				:title="r.picked ? 'Already added' : r.current ? 'Current value' : undefined"
				@mousedown.prevent="!r.picked && pick(r.item)" @mouseenter="!r.picked && (active = i)">
				<span class="mi-label">{{ r.item.label }}</span>
				<span v-if="r.item.sublabel" class="mi-sub">{{ r.item.sublabel }}</span>
				<span v-if="r.current || r.picked" class="material-symbols-rounded mi-check" aria-hidden="true">check</span>
			</button>
			<div v-if="!loading && rows.length === 0" class="mi hint">{{ items.length ? 'all matches already added' : 'no matches' }}</div>
		</div>
	</label>
</template>

<style scoped>
.lookup { display: block; position: relative; margin-bottom: 8px; }
.lbl { display: block; font-size: var(--fs-sm); color: var(--text-dim); margin-bottom: 3px; }
.box { display: flex; align-items: center; background: var(--bg-3); border: 1px solid var(--border); border-radius: 7px; }
.box.set { border-color: color-mix(in srgb, var(--accent) 50%, transparent); }
/* The input inside sets outline:none, and nothing replaced it: a keyboard user had no sign of
   which of the Record page's lookups had focus. */
.box:focus-within { border-color: var(--accent); }
.box .lead { flex: 0 0 auto; font-size: var(--fs-lg); color: var(--text-dim); margin-left: 9px; }
.box:has(.lead) input { padding-left: 6px; }
.box input { flex: 1; min-width: 0; padding: 7px 9px; font-size: var(--fs-md); color: var(--text); background: transparent; border: none; outline: none; }
.box input:disabled { opacity: 0.55; }
.x { display: inline-flex; align-items: center; padding: 0 6px; background: transparent; border: none; color: var(--text-dim); cursor: pointer; }
.x .material-symbols-rounded { font-size: var(--icon-sm); }
.menu { position: absolute; z-index: 30; left: 0; right: 0; top: 100%; margin-top: 2px; max-height: 200px; overflow: auto; background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px; box-shadow: 0 12px 30px rgba(0,0,0,0.45); }
.mi { display: block; width: 100%; text-align: left; padding: 7px 10px; font-size: var(--fs-md); font-family: var(--mono); color: var(--text); background: transparent; border: none; cursor: pointer; }
.mi:hover, .mi.active { background: var(--surface); }
/* #99: the current value carries a check; an already-added item is dimmed and not pickable. */
.mi { position: relative; }
.mi.current, .mi.picked { padding-right: 30px; }
.mi.current .mi-label { color: var(--accent); }
.mi.picked { opacity: 0.5; cursor: default; }
.mi.picked:hover { background: transparent; }
.mi-check { position: absolute; right: 9px; top: 50%; transform: translateY(-50%); font-size: var(--icon-sm); color: var(--accent); }
.mi.hint { color: var(--text-dim); font-family: inherit; cursor: default; }
.mi-label { display: block; }
.mi-sub { display: block; margin-top: 1px; font-family: inherit; font-size: var(--fs-xs); color: var(--text-dim); }
</style>
