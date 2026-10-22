<script setup lang="ts">
import type { SheetBar } from './sheetScale';

// The scale bar over a picture (the sheet, the view box and each Compare pane): a rule as wide as `bar.fraction` of the picture, with its length under it. It
// sits at the top right of the picture's own box, which must be position: relative. The bar is a border-box with 6px of padding each side, so its width
// carries those 12px on top of the fraction: the RULE inside it is then exactly the labelled share of the picture, never shorter.
defineProps<{ bar: SheetBar }>();
</script>

<template>
	<div class="bar" :style="{ width: `calc(${bar.fraction * 100}% + 12px)` }">
		<span class="rule" aria-hidden="true" data-test="scalebar-rule" />
		<span class="len">{{ bar.label }}</span>
	</div>
</template>

<style scoped>
.bar { position: absolute; right: 8px; top: 8px; display: flex; flex-direction: column; gap: 2px; box-sizing: border-box; padding: 3px 6px 2px; border-radius: 8px; background: color-mix(in srgb, var(--theme--background) 80%, transparent); pointer-events: none; }
.rule { display: block; height: 4px; border: 2px solid var(--theme--foreground); border-top: 0; }
.len { align-self: flex-end; font-size: var(--fs-xs, 11px); font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1.2; white-space: nowrap; }
</style>
