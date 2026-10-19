<script setup lang="ts">
// What a blank canvas says while the draft has nothing on it (spec 2026-10-18 §3, item 11): what to do first. Drawn over the middle
// of the canvas and out of the pointer's way (a right click or a drop on the canvas still reaches it). The Add menu is the only way to
// add an operation or a test today; the palette (R1) will say so here too.
</script>

<template>
	<div class="pm-empty" role="status">
		<strong>Nothing here yet</strong>
		<span>Pick samples, or press <kbd>Shift+A</kbd> to add an operation or test.</span>
	</div>
</template>

<style scoped>
.pm-empty {
	position: absolute;
	inset: 0;
	z-index: 2;
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	gap: 6px;
	padding: 0 24px 60px;
	text-align: center;
	color: var(--d1-dim, var(--theme--foreground-subdued));
	font-size: var(--fs-md, 13px);
	pointer-events: none;
}
.pm-empty strong { font-size: var(--fs-lg, 15px); color: var(--theme--foreground); }
kbd {
	padding: 0 5px;
	border: 1px solid var(--d1-line);
	border-radius: 4px;
	background: var(--d1-surface);
	font: inherit;
	font-size: var(--fs-xs, 11px);
	line-height: 1.5;
}
</style>
