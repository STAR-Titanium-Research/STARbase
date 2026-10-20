<script setup lang="ts">
import { computed } from 'vue';
import { NavIcon, usePins, type PinRef } from '@d1/ui';

// The pin button beside the page title (PlainFrame draws it when the page provided a target). It shares
// usePins() with the sidebar, so pinning here adds the row there at once and unpinning there resets this
// button. Disabled until the pins have loaded, so a pinned page never flashes "Pin". Silent on failure:
// usePins puts the notice in the sidebar. It is hidden until the title is hovered or the button has focus
// (PlainFrame's rule), and filled when the page is pinned.
const props = defineProps<{ target: PinRef }>();
const pins = usePins();
const pinned = computed(() => pins.isPinned(props.target));
</script>

<template>
	<button
		type="button"
		class="sb-pin"
		:class="{ on: pinned }"
		:aria-pressed="pinned"
		aria-label="Pin to the sidebar"
		:title="pinned ? 'Unpin from the sidebar' : 'Pin to the sidebar'"
		:disabled="!pins.loaded.value"
		@click="pins.toggle(target)"
	>
		<NavIcon name="pin" :size="14" />
	</button>
</template>

<style scoped>
.sb-pin {
	flex: none; display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; padding: 0;
	border: 0; border-radius: 6px; background: none; color: var(--d1-dim, var(--theme--foreground-subdued)); cursor: pointer;
	opacity: 0;
}
/* Shown by the title's hover or focus (PlainFrame), and always where there is no hover (a phone). */
@media (hover: none) { .sb-pin { opacity: 1; } }
.sb-pin:hover:not(:disabled) { background: var(--d1-tile, var(--theme--background-subdued)); color: var(--theme--foreground); }
.sb-pin:focus-visible { opacity: 1; outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 1px; }
.sb-pin:disabled { cursor: default; }
.sb-pin.on { color: var(--d1-accent, var(--theme--primary)); }
.sb-pin.on :deep(.d1-nav-icon) { fill: currentColor; }
</style>
