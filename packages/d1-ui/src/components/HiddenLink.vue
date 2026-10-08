<script setup lang="ts">
// A related record that exists but that row-level visibility hides from the signed-in user:
// shown in place of its link (a breadcrumb, a row) so the page does not claim nothing is linked.
defineProps<{ label: string }>();
</script>

<template>
	<span class="d1-hidden-link" title="This record exists, but you do not have permission to see it.">
		{{ label }} (not visible to you)
	</span>
</template>

<style scoped>
.d1-hidden-link { font-style: italic; color: var(--theme--foreground-subdued); }
</style>
