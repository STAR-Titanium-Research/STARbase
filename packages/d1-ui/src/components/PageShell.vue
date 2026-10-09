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

/* The helper classes of the page (.d1-cols, .d1-note, .d1-crumbs) are in tokens.css, unscoped and
   at the lowest weight, so that a page's own scoped rule for them (a margin) wins. */
</style>
