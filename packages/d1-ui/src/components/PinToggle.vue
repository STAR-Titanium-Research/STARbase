<script setup lang="ts">
import { computed } from 'vue';
import NavIcon from '../nav/NavIcon.vue';
import type { PinRef } from '../nav/sidebarModel';
import { usePins } from '../nav/usePins';
import './tokens.css';

// The Pin / Pinned button in the header of an index page, a saved view and a record page. It shares
// usePins() with the sidebar, so the sidebar's Pinned list and this button always agree: pinning here
// adds the row there at once, and unpinning there resets this button. Disabled (not hidden) until the
// pins have loaded, so a pinned page never flashes "Pin". Silent on failure: usePins puts the notice
// in the sidebar. `label` names what is pinned, for screen readers ("Pin Samples").
const props = defineProps<{ target: PinRef; label: string }>();

const pins = usePins();
const pinned = computed(() => pins.isPinned(props.target));
</script>

<template>
	<button
		type="button"
		class="d1-pin-toggle"
		:class="{ on: pinned }"
		:aria-pressed="pinned"
		:disabled="!pins.loaded.value"
		:title="pinned ? 'Unpin from the sidebar' : 'Pin to the sidebar'"
		@click="pins.toggle(target)"
	>
		<NavIcon name="pin" :size="14" />
		<span>{{ pinned ? 'Pinned' : 'Pin' }}</span>
		<span class="sr-only"> {{ label }}</span>
	</button>
</template>

<style scoped>
.d1-pin-toggle {
	display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 12px;
	border: 1px solid var(--d1-line, var(--theme--border-color-subdued)); border-radius: 8px;
	background: var(--d1-tile, var(--theme--background-subdued)); color: var(--theme--foreground);
	font: inherit; font-size: var(--fs-sm, 12px); font-weight: 600; white-space: nowrap; cursor: pointer;
}
.d1-pin-toggle:hover:not(:disabled) { border-color: var(--d1-accent, var(--theme--primary)); }
.d1-pin-toggle:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 1px; }
.d1-pin-toggle:disabled { opacity: 0.45; cursor: default; }
/* Pinned: the accent colour and a filled pin. */
.d1-pin-toggle.on { color: var(--d1-accent, var(--theme--primary)); border-color: var(--d1-accent, var(--theme--primary)); }
.d1-pin-toggle.on :deep(.d1-nav-icon) { fill: currentColor; }
.sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
</style>
