<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { escHandler, popDialog, pushDialog } from './dialogStack';
import { useFocusReturn } from './focusReturn';

// Stand-in for Directus's <v-dialog v-model @esc>. It renders NOTHING while closed: an always-mounted
// aria-modal box would make the finder think a dialog is open, and Ctrl+K would never open it again
// (@d1/ui finderNav.ts, MODAL_SELECTOR). Open: a backdrop and a role="dialog" aria-modal="true" box in
// <body>. Esc and a click on the backdrop emit `esc`; the page decides (close, or ask first). With
// dialogs on top of dialogs only the topmost one answers Esc (dialogStack.ts), and closing a dialog, by
// any route, puts focus back on what opened it.
const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ (e: 'update:modelValue', open: boolean): void; (e: 'esc'): void }>();
const box = ref<HTMLElement | null>(null);
const id = Symbol('v-dialog');

const onKey = escHandler(id, () => emit('esc'));

const leave = () => {
	document.removeEventListener('keydown', onKey);
	popDialog(id);
};

useFocusReturn(() => props.modelValue);
watch(
	() => props.modelValue,
	async (open) => {
		if (typeof document === 'undefined') return;
		if (!open) return leave();
		pushDialog(id);
		document.addEventListener('keydown', onKey);
		await nextTick();
		box.value?.querySelector<HTMLElement>('[autofocus], input, select, textarea, button')?.focus();
	},
	{ immediate: true },
);
onBeforeUnmount(() => {
	if (typeof document !== 'undefined') leave();
});
</script>

<template>
	<Teleport to="body">
		<div v-if="modelValue" class="v-dialog-backdrop" @mousedown.self.prevent="emit('esc')">
			<div ref="box" class="v-dialog" role="dialog" aria-modal="true"><slot /></div>
		</div>
	</Teleport>
</template>

<style scoped>
.v-dialog-backdrop { position: fixed; inset: 0; z-index: 100; display: grid; place-items: center; padding: 16px; background: rgba(0, 0, 0, 0.45); }
/* The box scrolls when the card is taller than the window; its padding (pulled back by the negative margin,
   so the card keeps its size) gives the card's shadow room, which `overflow: auto` would otherwise clip. */
.v-dialog { box-sizing: content-box; width: min(560px, 100%); max-height: calc(100dvh - 32px); margin: -24px; padding: 24px; overflow: auto; }
</style>
