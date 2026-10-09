<script setup lang="ts">
// The one table of the Explorer pages. The caller writes the rows (<thead>, <tbody>) in the slot;
// the look comes from here, so every list on every page has the same head, row height and hover.
// Cell classes: `num` (right-aligned figures), `mono` (codes), `dim`, `actions` (right-aligned,
// no wrap) and `fit` (a column only as wide as its content).
defineProps<{ /** Rows 6px high instead of 7px: for long figure tables. */ dense?: boolean }>();
</script>

<template>
	<div class="d1-table-wrap">
		<table class="d1-table" :class="{ dense }"><slot /></table>
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
.d1-table :deep(tbody tr:last-child td) { border-bottom: 0; }
.d1-table :deep(tbody tr:hover td) { background: var(--d1-tile, var(--theme--background-subdued)); }
.d1-table :deep(.num) { text-align: right; font-variant-numeric: tabular-nums; }
.d1-table :deep(.mono) { font-family: var(--theme--fonts--monospace--font-family, monospace); font-weight: 600; }
.d1-table :deep(.dim) { color: var(--d1-dim, var(--theme--foreground-subdued)); }
.d1-table :deep(.fit) { width: 1%; white-space: nowrap; }
.d1-table :deep(.actions) { text-align: right; white-space: nowrap; }
</style>
