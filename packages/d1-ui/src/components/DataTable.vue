<script setup lang="ts">
import { computed } from 'vue';
import { useRecordView } from '../composables/useRecordView';

// The one table of the Explorer pages. The caller writes the rows (<thead>, <tbody>) in the slot;
// the look comes from here, so every list on every page has the same head, row height and hover.
// Cell classes: `num` (right-aligned figures), `mono` (codes), `dim`, `actions` (right-aligned,
// no wrap), `fit` (a column only as wide as its content) and `thumb` (a small picture column).
// Density: the `density` prop when given (a list's own preference), else the one the record page's View rail
// chose for every table in its panels (useRecordView), else normal.
const props = defineProps<{
	/** Rows 6px high instead of 7px: for long figure tables. */
	dense?: boolean;
	/** The table is only as wide as its content instead of the whole panel: a few narrow columns would otherwise sit far apart. */
	fitContent?: boolean;
	/** A table of figures: the first column (the row's name) left-aligned, the others right-aligned, heads included. */
	figures?: boolean;
	/** Row height and text size, the per-list preference: compact (3px rows, 12px text), normal (today), roomy (11px rows). */
	density?: 'compact' | 'normal' | 'roomy';
}>();
const pageDensity = useRecordView();
const chosen = computed(() => props.density ?? pageDensity?.density);
</script>

<template>
	<div class="d1-table-wrap">
		<table class="d1-table" :class="[{ dense, 'fit-content': fitContent, figures }, chosen && chosen !== 'normal' ? chosen : '']"><slot /></table>
	</div>
</template>

<style scoped>
/* Pulled 8px into the panel's padding on each side, so the first column's text lines up with the
   panel title while the row hover still has room around the text. */
.d1-table-wrap { margin-inline: -8px; overflow-x: auto; }
.d1-table { width: 100%; border-collapse: collapse; font-size: var(--fs-md, 13px); }
.d1-table :deep(th) {
	text-align: left;
	padding: 4px 8px 6px;
	font-size: var(--fs-xs, 11px);
	font-weight: 600;
	letter-spacing: 0.01em;
	white-space: nowrap;
	color: var(--d1-dim, var(--theme--foreground-subdued));
	border-bottom: 1px solid var(--theme--border-color);
}
.d1-table :deep(td) {
	padding: 7px 8px;
	vertical-align: middle;
	border-bottom: 1px solid var(--d1-line, var(--theme--border-color-subdued));
}
.d1-table.dense :deep(td) { padding-block: 5px; }
/* After .dense, so a chosen density wins over it. */
.d1-table.compact { font-size: 12px; }
.d1-table.compact :deep(td) { padding-block: 3px; }
.d1-table.roomy :deep(td) { padding-block: 11px; }
.d1-table :deep(.thumb) { width: 1%; padding-right: 2px; line-height: 0; }
.d1-table.fit-content { width: auto; }
/* Written as `.d1-table.figures` so these beat the th/td rules above (same elements, one class
   more); an override from the caller's own scope lost that tie. */
.d1-table.figures :deep(th), .d1-table.figures :deep(td) { text-align: right; font-variant-numeric: tabular-nums; }
.d1-table.figures :deep(th:first-child), .d1-table.figures :deep(td:first-child) { text-align: left; }
.d1-table :deep(tbody tr:last-child td) { border-bottom: 0; }
.d1-table :deep(tbody tr:hover td) { background: var(--d1-tile, var(--theme--background-subdued)); }
.d1-table :deep(.num) { text-align: right; font-variant-numeric: tabular-nums; }
.d1-table :deep(.mono) { font-family: var(--theme--fonts--monospace--font-family, monospace); font-weight: 600; }
.d1-table :deep(.dim) { color: var(--d1-dim, var(--theme--foreground-subdued)); }
.d1-table :deep(.fit) { width: 1%; white-space: nowrap; }
.d1-table :deep(.actions) { text-align: right; white-space: nowrap; }
</style>
