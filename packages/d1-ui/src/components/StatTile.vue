<script setup lang="ts">
// A number with a label; a link when `to` is given.
defineProps<{ label: string; value: string | number; icon?: string; to?: string; hint?: string }>();
</script>

<template>
	<component :is="to ? 'router-link' : 'div'" :to="to" class="d1-tile" :class="{ link: !!to }" :title="hint">
		<v-icon v-if="icon" :name="icon" class="icon" />
		<span class="value">{{ value }}</span>
		<span class="label">{{ label }}</span>
	</component>
</template>

<style scoped>
.d1-tile {
	display: flex;
	flex-direction: column;
	align-items: flex-start;
	gap: 2px;
	padding: 14px 18px;
	border: 1px solid var(--theme--border-color-subdued);
	border-radius: 14px;
	background: var(--theme--background);
	color: var(--theme--foreground);
	text-decoration: none;
}
.link { cursor: pointer; transition: border-color 0.14s ease, box-shadow 0.14s ease; }
.link:hover { border-color: var(--theme--primary); box-shadow: 0 8px 20px -14px rgba(15, 23, 42, 0.4); }
.icon { --v-icon-color: var(--theme--primary); margin-bottom: 4px; }
.value { font-size: 24px; font-weight: 750; letter-spacing: -0.02em; }
.label {
	font-size: 11.5px;
	text-transform: uppercase;
	letter-spacing: 0.06em;
	font-weight: 600;
	color: var(--theme--foreground-subdued);
}
</style>
