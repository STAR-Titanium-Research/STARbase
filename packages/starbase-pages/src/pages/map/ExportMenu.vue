<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { focusLeftMenu, focusLost, menuKey } from './menuKeys';

// "Export ▾" (spec D26): a button with a two-item menu, PNG or PDF. Opening moves focus into the menu, the arrow keys move between
// the items, Escape closes it and puts focus back on the button; a pick, a press elsewhere or Tab out of the menu closes it too.
// The button is disabled while an export runs, which drops focus to <body>: when the export is done, focus goes back to the button.
const props = defineProps<{ busy: boolean; disabled: boolean }>();
const emit = defineEmits<{ pick: [format: 'png' | 'pdf'] }>();

const open = ref(false);
const root = ref<HTMLElement | null>(null);
const away = (e: Event) => {
	if (root.value && !root.value.contains(e.target as Node)) open.value = false;
};
const items = () => [...(root.value?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
const trigger = () => root.value?.querySelector<HTMLElement>('button');
const closeToTrigger = () => {
	open.value = false;
	trigger()?.focus();
};
/** Keys inside the menu, and Escape anywhere while it is open. */
const onKey = (e: KeyboardEvent) => {
	if (e.key !== 'Escape' && !root.value?.contains(document.activeElement)) return; // arrows belong to the menu only while focus is in it
	const list = items();
	const result = menuKey(e.key, list.indexOf(document.activeElement as HTMLElement), list.length);
	if (!result) return;
	e.preventDefault();
	if ('close' in result) closeToTrigger();
	else list[result.focus]?.focus();
};
const listen = (on: boolean) => {
	const toggle = on ? document.addEventListener.bind(document) : document.removeEventListener.bind(document);
	toggle('pointerdown', away);
	toggle('keydown', onKey as EventListener);
};
watch(open, (now) => {
	listen(now);
	if (now) void nextTick(() => items()[0]?.focus());
});
onBeforeUnmount(() => listen(false));
const onFocusOut = (e: FocusEvent) => {
	if (open.value && root.value && focusLeftMenu(e.relatedTarget, root.value)) open.value = false;
};
watch(
	() => props.busy,
	(now, was) => {
		if (was && !now && focusLost(document.activeElement, document.body)) trigger()?.focus();
	},
	{ flush: 'post' }, // after the button is enabled again
);
const pick = (format: 'png' | 'pdf') => {
	closeToTrigger();
	emit('pick', format);
};
</script>

<template>
	<div ref="root" class="pm-export" @focusout="onFocusOut">
		<v-button small secondary :loading="busy" :disabled="disabled" aria-haspopup="menu" :aria-expanded="open ? 'true' : 'false'" @click="open = !open">
			<v-icon name="download" small /> Export <v-icon name="expand_more" small />
		</v-button>
		<ul v-if="open" class="pm-export-menu" role="menu">
			<li role="none"><button type="button" role="menuitem" @click="pick('png')">PNG image</button></li>
			<li role="none"><button type="button" role="menuitem" @click="pick('pdf')">PDF, one page</button></li>
		</ul>
	</div>
</template>

<style scoped>
.pm-export { position: relative; display: inline-block; }
.pm-export-menu {
	position: absolute; right: 0; top: calc(100% + 4px); z-index: 20; min-width: 160px; margin: 0; padding: 4px; list-style: none;
	background: var(--d1-surface, var(--theme--background)); border: 1px solid var(--d1-line, var(--theme--border-color-subdued));
	border-radius: 8px; box-shadow: var(--d1-shadow, 0 2px 6px rgba(0, 0, 0, 0.1));
}
.pm-export-menu button {
	display: block; width: 100%; padding: 7px 10px; border: 0; border-radius: 6px; background: none; text-align: left;
	font: inherit; font-size: var(--fs-sm, 12px); color: var(--theme--foreground); cursor: pointer;
}
.pm-export-menu button:hover, .pm-export-menu button:focus-visible { background: var(--d1-tile, var(--theme--background-subdued)); outline: none; }
</style>
