<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';

// Stand-in for Directus's <v-dialog v-model @esc>. It renders NOTHING while closed: an always-mounted
// aria-modal box would make the finder think a dialog is open, and Ctrl+K would never open it again
// (@d1/ui finderNav.ts, MODAL_SELECTOR). Open: a backdrop and a role="dialog" aria-modal="true" box in
// <body>. Esc and a click on the backdrop emit `esc`; the page decides (close, or ask first).
const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ (e: 'update:modelValue', open: boolean): void; (e: 'esc'): void }>();
const box = ref<HTMLElement | null>(null);

const onKey = (e: KeyboardEvent) => {
	if (e.key !== 'Escape') return;
	e.stopPropagation();
	emit('esc');
};

watch(
	() => props.modelValue,
	async (open) => {
		if (typeof document === 'undefined') return;
		if (!open) {
			document.removeEventListener('keydown', onKey);
			return;
		}
		document.addEventListener('keydown', onKey);
		await nextTick();
		box.value?.querySelector<HTMLElement>('[autofocus], input, select, textarea, button')?.focus();
	},
	{ immediate: true },
);
onBeforeUnmount(() => {
	if (typeof document !== 'undefined') document.removeEventListener('keydown', onKey);
});
</script>

<template>
	<Teleport to="body">
		<div v-if="modelValue" class="v-dialog-backdrop" @mousedown.self="emit('esc')">
			<div ref="box" class="v-dialog" role="dialog" aria-modal="true"><slot /></div>
		</div>
	</Teleport>
</template>

<style scoped>
.v-dialog-backdrop { position: fixed; inset: 0; z-index: 100; display: grid; place-items: center; padding: 16px; background: rgba(0, 0, 0, 0.45); }
.v-dialog { width: min(560px, 100%); max-height: calc(100dvh - 32px); overflow: auto; }
</style>
