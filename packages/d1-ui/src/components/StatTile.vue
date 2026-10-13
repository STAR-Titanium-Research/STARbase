<script setup lang="ts">
import AppLink from './AppLink.vue';
// A count with a label, as the force app's stat tile; a link when `to` is given.
defineProps<{ label: string; value: string | number; icon?: string; to?: string; hint?: string }>();
</script>

<template>
	<component :is="to ? AppLink : 'div'" :to="to" class="d1-tile" :class="{ link: !!to }" :title="hint">
		<span v-if="icon" class="icon"><v-icon :name="icon" small /></span>
		<span class="text">
			<span class="value">{{ value }}</span>
			<span class="label">{{ label }}</span>
		</span>
	</component>
</template>

<style scoped>
.d1-tile {
	display: flex;
	align-items: center;
	gap: 12px;
	min-width: 0;
	padding: 10px 14px;
	border: 1px solid var(--d1-line, var(--theme--border-color-subdued));
	border-radius: 10px;
	background: var(--d1-surface, var(--theme--background));
	box-shadow: var(--d1-shadow, none);
	color: var(--theme--foreground);
	text-decoration: none;
}
.link { cursor: pointer; transition: border-color 0.12s ease; }
.link:hover { border-color: var(--d1-accent, var(--theme--primary)); }
.icon {
	flex: none;
	display: grid;
	place-items: center;
	width: 32px;
	height: 32px;
	border-radius: 8px;
	background: var(--d1-tint, var(--theme--primary-background));
	--v-icon-color: var(--d1-accent, var(--theme--primary));
}
.text { display: flex; flex-direction: column; min-width: 0; }
.value { font-size: var(--fs-2xl, 22px); font-weight: 700; letter-spacing: -0.01em; line-height: 1.15; font-variant-numeric: tabular-nums; }
.label { font-size: var(--fs-sm, 12px); font-weight: 600; letter-spacing: 0.01em; color: var(--d1-dim, var(--theme--foreground-subdued)); }
</style>
