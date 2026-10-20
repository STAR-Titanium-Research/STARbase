<script setup lang="ts">
import { useRecordView } from '../composables/useRecordView';
import './tokens.css';

// A record page with a side rail: a breadcrumb line, then the rail (left, sticky) beside the
// main column. The rail is 300px wide; a page that needs more sets `--d1-rail-width` on this component's root
// (the tooling pages use 360px for their tall stage). Slots: `crumbs`, `title-actions` (buttons at the right of the breadcrumb line), `rail` (a RecordRail, or anything), `view` (a RecordViewRail,
// a third column on the right) and the default slot (the panels).
//
// View rail: with a `view` slot the grid has a third column as wide as the rail's own card (220px open,
// 36px collapsed). The View settings the page provided (useRecordView) set the panels to one stack or two
// independent stacks side by side (CSS columns, so a short panel stays short and nothing stretches to a
// row), each at least 360px wide. Under 1100px of the layout's own width the rail is a "View" button
// (ViewRail turns itself into one) on a row of its own above the record rail.
//
// Sticky offset: the rail sticks at `top: var(--d1-sticky-top, 0px)` and its height is capped to the
// window under it. The default is 0px (no bar above). The page inside the Data Studio sets the height
// of the host's header bar plus a gap on its own root (`style="--d1-sticky-top: var(--d1-header-offset, 70px)"`:
// the Data Studio header is 70px with its gap, and STARbase's PlainFrame sets --d1-header-offset), because
// only the host knows it. Sections scroll to the same offset (Section's scroll-margin-top).
// Sticky also needs every ancestor up to the scroll container to leave `overflow` at visible.
//
// Narrow: the layout root is a size container, and under 1000px of its own width (not the width of
// the viewport, so it also holds with the Data Studio sidebar open) the rail stacks above the main
// column, stops sticking, lays its facts out in columns and drops "On this page". `late-stack` moves that
// point down to 840px, for a page whose rail carries something that should stay beside the panels on a
// laptop with the sidebar open (the tooling pages' tall 3D stage).
defineProps<{ lateStack?: boolean }>();
const view = useRecordView();
</script>

<template>
	<div class="d1-record-layout d1-kit" :class="{ 'late-stack': lateStack }">
		<div v-if="$slots.crumbs || $slots['title-actions']" class="top">
			<nav v-if="$slots.crumbs" class="d1-crumbs" aria-label="Breadcrumb"><slot name="crumbs" /></nav>
			<div v-if="$slots['title-actions']" class="title-actions"><slot name="title-actions" /></div>
		</div>
		<div class="grid" :class="{ 'has-view': $slots.view }">
			<aside class="rail" aria-label="Record"><slot name="rail" /></aside>
			<div class="main" :class="{ 'two-stacks': view?.panels === 2 }"><slot /></div>
			<slot name="view" />
		</div>
	</div>
</template>

<style scoped>
.d1-record-layout { display: flex; flex-direction: column; gap: 16px; min-width: 0; container-type: inline-size; }
.top { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px 12px; min-width: 0; }
.title-actions { display: flex; align-items: center; gap: 6px; margin-left: auto; }
.grid { display: grid; grid-template-columns: var(--d1-rail-width, 300px) minmax(0, 1fr); gap: 16px; align-items: start; }
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
/* A wrapper whose panels are all hidden (empty sections) is an empty element: it takes no gap. */
.main > :empty { display: none; }
.has-view { grid-template-columns: var(--d1-rail-width, 300px) minmax(0, 1fr) auto; }
/* Two stacks: columns of at most two, each at least 360px, filled top to bottom. A panel never splits. */
.main.two-stacks { display: block; columns: 2 360px; column-gap: 16px; }
.main.two-stacks > :deep(*) { break-inside: avoid; margin-bottom: 16px; }
/* The View rail is a button here: a row of its own at the right, above the rail and the panels. */
@container (max-width: 1099px) {
	.has-view { grid-template-columns: var(--d1-rail-width, 300px) minmax(0, 1fr); }
	.has-view > :deep(.d1-view-rail) { order: -1; grid-column: 1 / -1; }
}
@container (max-width: 1000px) {
	.d1-record-layout:not(.late-stack) .grid { grid-template-columns: minmax(0, 1fr); }
	.d1-record-layout:not(.late-stack) .rail { position: static; max-height: none; overflow: visible; padding: 0; --d1-fact-grid: repeat(auto-fill, minmax(280px, 1fr)); }
	.d1-record-layout:not(.late-stack) .rail :deep(.d1-page-contents) { display: none; }
}
@container (max-width: 840px) {
	.late-stack .grid { grid-template-columns: minmax(0, 1fr); }
	.late-stack .rail { position: static; max-height: none; overflow: visible; padding: 0; --d1-fact-grid: repeat(auto-fill, minmax(280px, 1fr)); }
	.late-stack .rail :deep(.d1-page-contents) { display: none; }
}
</style>
