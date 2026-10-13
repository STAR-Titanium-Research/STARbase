<script setup lang="ts">
import { computed } from 'vue';

// Stand-in for Directus's <v-icon>: a Material Symbols glyph by name. Clickable icons (copy a path,
// download) are buttons for the keyboard and screen readers; the page's @click falls through.
const props = defineProps<{ name?: string; xSmall?: boolean; small?: boolean; large?: boolean; xLarge?: boolean; left?: boolean; right?: boolean; clickable?: boolean }>();
const size = computed(() => (props.xSmall ? 14 : props.small ? 18 : props.large ? 32 : props.xLarge ? 40 : 24));
</script>

<template>
	<span
		class="material-symbols-rounded v-icon"
		:class="{ left, right, clickable }"
		:style="{ fontSize: size + 'px' }"
		:role="clickable ? 'button' : undefined"
		:tabindex="clickable ? 0 : undefined"
		:aria-hidden="clickable ? undefined : 'true'"
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
