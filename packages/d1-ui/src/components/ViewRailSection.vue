<script setup lang="ts">
// One section of the View rail (ViewRail.vue): a small label over its control, with a hairline
// between sections. Radio groups (SegmentedControl) and selects inside it fill the rail's width.
// A section without a label is a footnote ("Saved for every sample page on this device.").
defineProps<{ label?: string }>();
</script>

<template>
	<div class="d1-view-section">
		<div v-if="label" class="label">{{ label }}</div>
		<slot />
	</div>
</template>

<style scoped>
.d1-view-section { padding: 10px 12px; border-bottom: 1px solid var(--d1-line, var(--theme--border-color-subdued)); }
.d1-view-section:last-child { border-bottom: 0; }
.label { margin-bottom: 6px; font-size: var(--fs-xs, 11px); font-weight: 650; color: var(--d1-dim, var(--theme--foreground-subdued)); }
.d1-view-section :deep(.seg) { display: flex; width: 100%; }
.d1-view-section :deep(.opt) { flex: 1; justify-content: center; padding: 0 6px; }
.d1-view-section :deep(select) { width: 100%; }
</style>
