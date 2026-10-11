<script setup lang="ts">
import './tokens.css';

// A record page with a side rail: a breadcrumb line, then the rail (300px, left, sticky) beside the
// main column. Slots: `crumbs`, `rail` (a RecordRail, or anything), and the default slot (the panels).
//
// Sticky offset: the rail sticks at `top: var(--d1-sticky-top, 0px)` and its height is capped to the
// window under it. The default is 0px (no bar above). The page inside the Data Studio sets the height
// of the Directus header bar on its own root (`style="--d1-sticky-top: 60px"`, with a unit), because
// only the host knows it. Sections scroll to the same offset (Section's scroll-margin-top).
// Sticky also needs every ancestor up to the scroll container to leave `overflow` at visible.
//
// Narrow: the layout root is a size container, and under 1000px of its own width (not the width of
// the viewport, so it also holds with the Data Studio sidebar open) the rail stacks above the main
// column, stops sticking, lays its facts out in columns and drops "On this page".
</script>

<template>
	<div class="d1-record-layout d1-kit">
		<nav v-if="$slots.crumbs" class="d1-crumbs"><slot name="crumbs" /></nav>
		<div class="grid">
			<aside class="rail"><slot name="rail" /></aside>
			<div class="main"><slot /></div>
		</div>
	</div>
</template>

<style scoped>
.d1-record-layout { display: flex; flex-direction: column; gap: 16px; min-width: 0; container-type: inline-size; }
.grid { display: grid; grid-template-columns: 300px minmax(0, 1fr); gap: 16px; align-items: start; }
.rail {
	position: sticky;
	top: var(--d1-sticky-top, 0px);
	max-height: calc(100vh - var(--d1-sticky-top, 0px) - 16px);
	max-height: calc(100dvh - var(--d1-sticky-top, 0px) - 16px);
	overflow: auto;
	min-width: 0;
	/* overflow: auto clips what is drawn outside the box: room for the rail's shadow and focus outlines. */
	padding: 2px 4px 8px;
}
/* The panels stack with the page frame's 16px gap. */
.main { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
@container (max-width: 1000px) {
	.grid { grid-template-columns: minmax(0, 1fr); }
	.rail { position: static; max-height: none; overflow: visible; padding: 0; --d1-fact-grid: repeat(auto-fill, minmax(280px, 1fr)); }
	.rail :deep(.d1-page-contents) { display: none; }
}
</style>
