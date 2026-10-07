<script setup lang="ts">
// Loading / error / empty with text, so no page ever shows a blank area. The default slot is the
// content, shown only when none of the three applies.
defineProps<{ loading?: boolean; error?: string; empty?: boolean; emptyText?: string; loadingText?: string }>();
</script>

<template>
	<div v-if="loading" class="d1-state"><v-progress-circular indeterminate small /> {{ loadingText ?? 'Loading…' }}</div>
	<div v-else-if="error" class="d1-state d1-state-error" role="alert">{{ error }}</div>
	<div v-else-if="empty" class="d1-state d1-state-empty">{{ emptyText ?? 'Nothing here yet.' }}</div>
	<slot v-else />
</template>

<style scoped>
.d1-state { display: flex; align-items: center; gap: 8px; padding: 8px 0; font-size: 13px; color: var(--theme--foreground-subdued); }
.d1-state-error { color: var(--theme--danger); }
.d1-state-empty { font-style: italic; }
</style>
