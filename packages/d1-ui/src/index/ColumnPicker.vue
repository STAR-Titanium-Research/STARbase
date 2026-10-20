<script setup lang="ts">
// The View rail's Columns control: a dropdown button ("9 of 13 shown ▾") whose popover has a search field, the
// shown columns (drag a row, or Alt+↑ ↓ on its grip, to reorder; the first column, the code, is always on and
// first) and the hidden ones as checkboxes, then Reset and Done. The caller owns the value (the shown columns'
// fields in order, null = all in the def's order); this only reports the new one. The logic is columnPicker.ts.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { columnsSummary, hiddenColumns, isFixedColumn, matchColumns, moveColumn, shownColumns, toggleColumn } from './columnPicker';
import type { IndexDef } from './indexConfig';

const props = defineProps<{ def: IndexDef; modelValue: string[] | null }>();
const emit = defineEmits<{ 'update:modelValue': [value: string[] | null] }>();

const root = ref<HTMLElement | null>(null);
const searchBox = ref<HTMLInputElement | null>(null);
const open = ref(false);
const search = ref('');

const shown = computed(() => shownColumns(props.def, props.modelValue));
const hidden = computed(() => hiddenColumns(props.def, props.modelValue));
const shownMatches = computed(() => matchColumns(shown.value, search.value));
const hiddenMatches = computed(() => matchColumns(hidden.value, search.value));

async function toggleOpen(): Promise<void> {
	open.value = !open.value;
	if (open.value) {
		search.value = '';
		await nextTick();
		searchBox.value?.focus();
	}
}
const close = () => (open.value = false);
function onDocumentClick(e: MouseEvent): void {
	if (open.value && root.value && !root.value.contains(e.target as Node)) close();
}
onMounted(() => document.addEventListener('click', onDocumentClick));
onBeforeUnmount(() => document.removeEventListener('click', onDocumentClick));
watch(() => props.def.slug, close);

const set = (value: string[] | null) => emit('update:modelValue', value);
const toggle = (field: string) => set(toggleColumn(props.def, props.modelValue, field));
const moveTo = (field: string, index: number) => set(moveColumn(props.def, props.modelValue, field, index));
function onGripKey(e: KeyboardEvent, field: string): void {
	if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
	e.preventDefault();
	const at = shown.value.findIndex((c) => c.field === field);
	moveTo(field, at + (e.key === 'ArrowUp' ? -1 : 1));
	// The row is re-rendered in its new place: the grip keeps the keyboard.
	void nextTick(() => (root.value?.querySelector(`[data-grip="${field}"]`) as HTMLElement | null)?.focus());
}

// Dragging a row: dropped on another shown row it takes that row's place.
const dragging = ref<string | null>(null);
const over = ref<string | null>(null);
function onDrop(target: string): void {
	const from = dragging.value;
	dragging.value = over.value = null;
	if (from && from !== target) moveTo(from, shown.value.findIndex((c) => c.field === target));
}
</script>

<template>
	<div ref="root" class="d1-columns">
		<button type="button" class="trigger" aria-haspopup="dialog" :aria-expanded="open" @click="toggleOpen">
			<span>{{ columnsSummary(def, modelValue) }}</span><span class="caret" aria-hidden="true">▾</span>
		</button>
		<div v-if="open" class="pop" role="dialog" aria-label="Columns" @keydown.esc.stop="close">
			<input ref="searchBox" v-model="search" type="search" class="find" placeholder="Find a column" aria-label="Find a column" />
			<div class="scroll">
				<template v-if="shownMatches.length">
					<p class="grp">Shown · drag to reorder</p>
					<ul>
						<li
							v-for="c in shownMatches"
							:key="c.field"
							:class="{ over: over === c.field && dragging !== c.field }"
							:draggable="!isFixedColumn(def, c.field)"
							@dragstart="dragging = c.field"
							@dragend="dragging = over = null"
							@dragover.prevent="!isFixedColumn(def, c.field) && (over = c.field)"
							@drop.prevent="!isFixedColumn(def, c.field) && onDrop(c.field)"
						>
							<label>
								<input type="checkbox" checked :disabled="isFixedColumn(def, c.field)" :aria-label="`Show ${c.label}`" @change="toggle(c.field)" />
								<span>{{ c.label }}</span>
								<em v-if="isFixedColumn(def, c.field)">always</em>
							</label>
							<button
								v-if="!isFixedColumn(def, c.field)"
								type="button"
								class="grip"
								:data-grip="c.field"
								:aria-label="`Move ${c.label}`"
								title="Drag to reorder, or Alt+↑ ↓"
								@keydown="onGripKey($event, c.field)"
							>⠿</button>
						</li>
					</ul>
				</template>
				<template v-if="hiddenMatches.length">
					<p class="grp">Hidden</p>
					<ul>
						<li v-for="c in hiddenMatches" :key="c.field">
							<label>
								<input type="checkbox" :aria-label="`Show ${c.label}`" @change="toggle(c.field)" />
								<span>{{ c.label }}</span>
							</label>
						</li>
					</ul>
				</template>
				<p v-if="!shownMatches.length && !hiddenMatches.length" class="none">No column matches.</p>
			</div>
			<div class="foot">
				<button type="button" class="btn" @click="set(null)">Reset</button>
				<button type="button" class="btn pri" @click="close">Done</button>
			</div>
		</div>
	</div>
</template>

<style scoped>
.d1-columns { position: relative; }
.trigger {
	display: flex; align-items: center; justify-content: space-between; gap: 6px; box-sizing: border-box; width: 100%; height: 30px; padding: 0 8px 0 10px;
	border: 1px solid var(--theme--border-color); border-radius: 8px; background: var(--d1-surface); color: var(--theme--foreground);
	font: inherit; font-size: var(--fs-md, 13px); cursor: pointer;
}
.trigger:hover { border-color: var(--d1-accent, var(--theme--primary)); }
.caret { font-size: var(--fs-xs, 11px); color: var(--d1-dim); }
/* The popover hangs to the left of the rail, over the table, as wide as it needs. */
.pop {
	position: absolute; right: 0; top: calc(100% + 4px); z-index: 20; box-sizing: border-box; width: 260px; max-width: calc(100vw - 32px);
	display: flex; flex-direction: column; background: var(--d1-surface); border: 1px solid var(--d1-line); border-radius: var(--d1-radius, 12px);
	box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
}
.find {
	box-sizing: border-box; margin: 10px 10px 4px; height: 30px; padding: 0 10px; border: 1px solid var(--theme--border-color); border-radius: 8px;
	background: var(--theme--form--field--input--background, var(--theme--background)); color: var(--theme--foreground); font: inherit; font-size: var(--fs-md, 13px);
}
.scroll { max-height: 320px; overflow-y: auto; padding: 0 6px; }
.grp { margin: 10px 6px 2px; font-size: var(--fs-xs, 11px); font-weight: 650; text-transform: uppercase; letter-spacing: 0.04em; color: var(--d1-dim); }
ul { list-style: none; margin: 0; padding: 0; }
li { display: flex; align-items: center; border-radius: 6px; }
li:hover { background: var(--d1-tile); }
li.over { box-shadow: inset 0 2px 0 var(--d1-accent, var(--theme--primary)); }
li label { flex: 1; display: flex; align-items: center; gap: 8px; min-width: 0; padding: 5px 6px; font-size: var(--fs-md, 13px); cursor: pointer; }
li em { font-style: normal; font-size: var(--fs-xs, 11px); color: var(--d1-dim); }
.grip { border: 0; background: none; padding: 2px 6px; color: var(--d1-dim); font-size: var(--fs-lg, 15px); line-height: 1; cursor: grab; border-radius: 4px; }
.none { margin: 10px 6px; font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
.foot { display: flex; justify-content: space-between; padding: 8px 10px; border-top: 1px solid var(--d1-line); }
.btn {
	display: inline-flex; align-items: center; height: 28px; padding: 0 12px; border: 1px solid var(--d1-line); border-radius: 8px;
	background: var(--d1-tile); color: var(--theme--foreground); font: inherit; font-size: var(--fs-sm, 12px); font-weight: 600; cursor: pointer;
}
.btn:hover { border-color: var(--d1-accent, var(--theme--primary)); }
.btn.pri { background: var(--d1-accent, var(--theme--primary)); border-color: var(--d1-accent, var(--theme--primary)); color: var(--d1-on-accent, #fff); }
.trigger:focus-visible, .btn:focus-visible, .grip:focus-visible, .find:focus-visible, li input:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 1px; }
</style>
