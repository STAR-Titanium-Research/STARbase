<script setup lang="ts">
import { computed } from 'vue';
import { renderStatusStyle, type RenderStatus } from './scanModel';

// A scan's render status as a coloured pill, drawn like the kit's StatusBadge (which only knows the kit's own
// vocabularies): a tone mapped to theme variables, so light and dark both read.
const props = defineProps<{ status: RenderStatus | null }>();
const style = computed(() => renderStatusStyle(props.status));
</script>

<template>
	<span class="badge" :class="`tone--${style.tone}`">{{ style.label }}</span>
</template>

<style scoped>
.badge { display: inline-block; padding: 1px 8px; border-radius: 99px; font-size: var(--fs-xs, 11px); font-weight: 700; line-height: 1.6; white-space: nowrap; color: var(--tone-fg); background: var(--tone-bg); }
.tone--neutral { --tone-fg: var(--d1-dim, var(--theme--foreground-subdued)); --tone-bg: var(--theme--background-normal); }
.tone--info { --tone-fg: var(--d1-accent, var(--theme--primary)); --tone-bg: color-mix(in srgb, var(--d1-accent, var(--theme--primary)) 12%, transparent); }
.tone--progress { --tone-fg: color-mix(in srgb, var(--theme--warning) 50%, var(--theme--foreground)); --tone-bg: color-mix(in srgb, var(--theme--warning) 18%, transparent); }
.tone--success { --tone-fg: color-mix(in srgb, var(--theme--success) 50%, var(--theme--foreground)); --tone-bg: color-mix(in srgb, var(--theme--success) 18%, transparent); }
.tone--danger { --tone-fg: color-mix(in srgb, var(--theme--danger) 60%, var(--theme--foreground)); --tone-bg: color-mix(in srgb, var(--theme--danger) 14%, transparent); }
</style>
