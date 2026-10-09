<script setup lang="ts">
// The frame of every Explorer page, inside <private-view>: one left edge (the Data Studio's own
// content padding, so a page starts where the header bar's content starts and does not jump
// sideways from one page to the next), one width, one type scale and one gap between blocks.
// `narrow` is for a form or a list read top to bottom.
import './tokens.css';

defineProps<{ narrow?: boolean }>();
</script>

<template>
	<div class="d1-page" :class="{ narrow }"><slot /></div>
</template>

<style scoped>
.d1-page {
	max-width: 1440px;
	margin: 0;
	padding: 20px var(--content-padding, 32px) 64px;
	display: flex;
	flex-direction: column;
	gap: 16px;
	font-family: var(--theme--fonts--sans--font-family, -apple-system, 'Segoe UI', Roboto, sans-serif);
	font-size: var(--fs-md, 13px);
	line-height: 1.45;
	color: var(--theme--foreground);
}
.d1-page.narrow { max-width: 920px; }

/* Blocks side by side while there is room, stacked when there is not. They share one height, so
   a row of panels ends on one line. */
.d1-page :deep(.d1-cols) {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
	gap: 16px;
	align-items: stretch;
}
/* A line of text between blocks: a note, a description, a cap on a list. */
.d1-page :deep(.d1-note) { margin: 0; font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
.d1-page :deep(.d1-note.warn) { color: var(--d1-warn); }
.d1-page :deep(.d1-note.bad) { color: var(--d1-bad); }
.d1-page :deep(.d1-note a),
.d1-page :deep(.d1-crumbs a) { color: var(--theme--primary); font-weight: 600; text-decoration: none; }
.d1-page :deep(.d1-note a:hover),
.d1-page :deep(.d1-crumbs a:hover) { text-decoration: underline; }
.d1-page :deep(.d1-crumbs) {
	display: flex;
	align-items: center;
	flex-wrap: wrap;
	gap: 6px;
	font-size: var(--fs-sm, 12px);
	color: var(--d1-dim);
}
</style>
