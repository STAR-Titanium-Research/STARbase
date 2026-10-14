<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';

// "Export ▾" (spec D26): a button with a two-item menu, PNG or PDF. Closes on a pick, on Escape and on a press elsewhere.
defineProps<{ busy: boolean; disabled: boolean }>();
const emit = defineEmits<{ pick: [format: 'png' | 'pdf'] }>();

const open = ref(false);
const root = ref<HTMLElement | null>(null);
const away = (e: Event) => {
	if (root.value && !root.value.contains(e.target as Node)) open.value = false;
};
const onKey = (e: KeyboardEvent) => {
	if (e.key === 'Escape') open.value = false;
};
const listen = (on: boolean) => {
	const toggle = on ? document.addEventListener.bind(document) : document.removeEventListener.bind(document);
	toggle('pointerdown', away);
	toggle('keydown', onKey as EventListener);
};
watch(open, listen);
onBeforeUnmount(() => listen(false));
const pick = (format: 'png' | 'pdf') => {
	open.value = false;
	emit('pick', format);
};
</script>

<template>
	<div ref="root" class="pm-export">
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
