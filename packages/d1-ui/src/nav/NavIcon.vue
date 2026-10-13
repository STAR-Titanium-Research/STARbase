<script setup lang="ts">
import { NAV_ICONS } from './navIcons';
import type { NavIconName } from './navIcons';

// One sidebar icon: Lucide path data drawn as an inline SVG in the current text colour, so it
// follows the item's muted or white state and needs no host icon component.
withDefaults(defineProps<{ name: NavIconName; size?: number }>(), { size: 16 });
</script>

<template>
	<svg
		aria-hidden="true"
		:width="size"
		:height="size"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="1.75"
		stroke-linecap="round"
		stroke-linejoin="round"
		class="d1-nav-icon"
	>
		<component :is="n.tag" v-for="(n, i) in NAV_ICONS[name]" :key="i" v-bind="n.attrs" />
	</svg>
</template>

<style scoped>
.d1-nav-icon {
	flex: none;
}
</style>
