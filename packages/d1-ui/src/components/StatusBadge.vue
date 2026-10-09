<script setup lang="ts">
import { computed } from 'vue';
import { statusStyle, type StatusKind } from '../status';

// A status as a coloured pill. Renders nothing for a missing value.
const props = defineProps<{ kind: StatusKind; value: string | null | undefined }>();
const style = computed(() => statusStyle(props.kind, props.value));
</script>

<template>
	<span v-if="style" class="d1-badge" :class="`tone--${style.tone}`">{{ style.label }}</span>
</template>

<style scoped>
.d1-badge {
	display: inline-block;
	padding: 1px 8px;
	border-radius: 99px;
	font-size: var(--fs-xs, 11px);
	font-weight: 700;
	line-height: 1.6;
	white-space: nowrap;
	color: var(--d1-tone-fg);
	background: var(--d1-tone-bg);
}
/* The theme's status colours are fills. As text on their own tint they are under 2:1 (the mint
   "Active" on pale mint), so the ink is the colour mixed toward the text colour: darker on a light
   theme, lighter on a dark one. */
.tone--neutral { --d1-tone-fg: var(--d1-dim, var(--theme--foreground-subdued)); --d1-tone-bg: var(--theme--background-normal); }
.tone--info { --d1-tone-fg: var(--theme--primary); --d1-tone-bg: color-mix(in srgb, var(--theme--primary) 12%, transparent); }
.tone--progress, .tone--warning {
	--d1-tone-fg: color-mix(in srgb, var(--theme--warning) 50%, var(--theme--foreground));
	--d1-tone-bg: color-mix(in srgb, var(--theme--warning) 18%, transparent);
}
.tone--success {
	--d1-tone-fg: color-mix(in srgb, var(--theme--success) 50%, var(--theme--foreground));
	--d1-tone-bg: color-mix(in srgb, var(--theme--success) 18%, transparent);
}
.tone--danger {
	--d1-tone-fg: color-mix(in srgb, var(--theme--danger) 60%, var(--theme--foreground));
	--d1-tone-bg: color-mix(in srgb, var(--theme--danger) 14%, transparent);
}
</style>
