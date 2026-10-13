<script setup lang="ts">
import { computed } from 'vue';
import { activateOnKey } from './clickableKey';

// Stand-in for Directus's <v-icon>: a Material Symbols glyph by name. Clickable icons (copy a path,
// download) are buttons for the keyboard and screen readers: Enter and Space click them, and the
// page's @click falls through. A `title` names the icon for screen readers (role="img" when it is not clickable);
// without one a plain icon is decorative and hidden from them.
const props = defineProps<{ name?: string; xSmall?: boolean; small?: boolean; large?: boolean; xLarge?: boolean; left?: boolean; right?: boolean; clickable?: boolean; title?: string }>();
const size = computed(() => (props.xSmall ? 14 : props.small ? 18 : props.large ? 32 : props.xLarge ? 40 : 24));
</script>

<template>
	<span
		class="material-symbols-rounded v-icon"
		:class="{ left, right, clickable }"
		:style="{ fontSize: size + 'px' }"
		:title="title"
		:role="clickable ? 'button' : title ? 'img' : undefined"
		:aria-label="title || undefined"
		:tabindex="clickable ? 0 : undefined"
		:aria-hidden="clickable || title ? undefined : 'true'"
		@keydown="clickable ? activateOnKey($event) : undefined"
		>{{ name }}</span
	>
</template>

<style scoped>
.v-icon {
	display: inline-flex; align-items: center; justify-content: center; line-height: 1; vertical-align: middle;
	user-select: none; font-variation-settings: 'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 24;
}
.left { margin-right: 4px; }
.right { margin-left: 4px; }
.clickable { cursor: pointer; border-radius: 4px; }
.clickable:focus-visible { outline: 2px solid var(--theme--primary); outline-offset: 1px; }
</style>
