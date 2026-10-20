<script setup lang="ts">
// "With N selected ▾": the one button of an index page's ticked rows (spec section 1). It reads "With selected" and does nothing with
// no row ticked; with rows ticked it opens a menu of the entries the page offers (bulkEntries). The menu appears without animation.
// Keyboard: Enter, Space or the down arrow opens it on the first entry; the arrows, Home and End move; Escape closes it and returns
// focus to the button; Tab closes it. A disabled button stays focusable (aria-disabled), so focus can come back to it after an action
// has cleared the ticks.
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { menuLabel } from './bulkModel';
import type { BulkEntry } from './bulkModel';

const props = defineProps<{
	entries: BulkEntry[];
	/** How many rows are ticked. */
	count: number;
}>();
const emit = defineEmits<{ choose: [entry: BulkEntry] }>();

const uid = `d1-bulk-menu-${Math.random().toString(36).slice(2, 8)}`;
const root = ref<HTMLElement | null>(null);
const button = ref<HTMLButtonElement | null>(null);
const open = ref(false);
const active = ref(0);

const items = (): HTMLElement[] => Array.from(root.value?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
const enabled = () => props.count > 0;

async function openMenu(at = 0): Promise<void> {
	if (!enabled() || !props.entries.length) return;
	open.value = true;
	active.value = at;
	await nextTick();
	items()[at]?.focus();
}
function closeMenu(refocus: boolean): void {
	open.value = false;
	if (refocus) void nextTick(() => button.value?.focus());
}
function toggle(): void {
	if (open.value) closeMenu(false);
	else void openMenu();
}
function pick(entry: BulkEntry): void {
	closeMenu(false);
	emit('choose', entry);
}
function onButtonKey(e: KeyboardEvent): void {
	if (e.key === 'ArrowDown') {
		e.preventDefault();
		void openMenu(0);
	} else if (e.key === 'ArrowUp') {
		e.preventDefault();
		void openMenu(props.entries.length - 1);
	}
}
function move(to: number): void {
	const list = items();
	if (!list.length) return;
	active.value = (to + list.length) % list.length;
	list[active.value].focus();
}
function onMenuKey(e: KeyboardEvent): void {
	if (e.key === 'ArrowDown') {
		e.preventDefault();
		move(active.value + 1);
	} else if (e.key === 'ArrowUp') {
		e.preventDefault();
		move(active.value - 1);
	} else if (e.key === 'Home') {
		e.preventDefault();
		move(0);
	} else if (e.key === 'End') {
		e.preventDefault();
		move(items().length - 1);
	} else if (e.key === 'Escape') {
		e.preventDefault();
		e.stopPropagation();
		closeMenu(true);
	} else if (e.key === 'Tab') {
		closeMenu(false);
	}
}

// A click anywhere else closes it; so does ticking everything off while it is open.
function onOutside(e: MouseEvent): void {
	if (open.value && !root.value?.contains(e.target as Node)) closeMenu(false);
}
watch(open, (v) => {
	if (v) document.addEventListener('mousedown', onOutside);
	else document.removeEventListener('mousedown', onOutside);
});
watch(() => props.count, (n) => {
	if (n === 0) open.value = false;
});
onBeforeUnmount(() => document.removeEventListener('mousedown', onOutside));

defineExpose({ focus: () => button.value?.focus() });
</script>

<template>
	<div ref="root" class="bulk-menu">
		<button
			ref="button"
			type="button"
			class="btn"
			aria-haspopup="menu"
			:aria-expanded="open"
			:aria-controls="open ? `${uid}-list` : undefined"
			:aria-disabled="!count"
			@click="toggle"
			@keydown="onButtonKey"
		>{{ menuLabel(count) }} <span class="caret" aria-hidden="true">▾</span></button>
		<ul v-if="open" :id="`${uid}-list`" class="menu" role="menu" :aria-label="menuLabel(count)" @keydown="onMenuKey">
			<li v-for="(entry, i) in entries" :key="entry.id" role="none">
				<button type="button" role="menuitem" class="item" :tabindex="i === active ? 0 : -1" @click="pick(entry)" @mousemove="active = i">{{ entry.label }}</button>
			</li>
		</ul>
	</div>
</template>

<style scoped>
.bulk-menu { position: relative; display: inline-block; }
.btn {
	display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 12px;
	border: 1px solid var(--d1-line); border-radius: 8px;
	background: var(--d1-tile); color: var(--theme--foreground);
	font: inherit; font-size: var(--fs-sm, 12px); font-weight: 600; white-space: nowrap; cursor: pointer;
}
.btn:hover:not([aria-disabled='true']) { border-color: var(--d1-accent, var(--theme--primary)); }
.btn[aria-disabled='true'] { opacity: 0.45; cursor: default; }
.caret { font-size: var(--fs-xs, 11px); }
.menu {
	position: absolute; z-index: 50; top: 100%; left: 0; margin: 4px 0 0; padding: 4px; list-style: none; min-width: 200px;
	border: 1px solid var(--d1-line); border-radius: 8px; background: var(--d1-surface); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
}
.item {
	display: block; width: 100%; padding: 7px 10px; border: 0; border-radius: 6px; background: none; color: var(--theme--foreground);
	font: inherit; font-size: var(--fs-md, 13px); text-align: left; white-space: nowrap; cursor: pointer;
}
.item:hover, .item:focus-visible { background: var(--d1-tile); }
button:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 2px; }
</style>
