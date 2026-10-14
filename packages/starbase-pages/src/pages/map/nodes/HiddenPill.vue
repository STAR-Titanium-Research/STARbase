<script setup lang="ts">
// "Some records hidden" (spec D21): records the person may not read are a marker only, no placeholder
// card and no count. The pill sits on the card's edge on the side where they would join (before it above,
// after it below) whether or not the card has a socket there: a root sample has no input socket and can
// still have hidden ancestors.
defineProps<{ side: 'in' | 'out' }>();
</script>

<template>
	<span class="hid nodrag nopan" :class="side" role="note" :title="side === 'in' ? 'Some earlier records are not visible to you' : 'Some later records are not visible to you'">some records hidden</span>
</template>

<style scoped>
.hid {
	position: absolute;
	z-index: 2;
	padding: 1px 8px;
	border-radius: 99px;
	border: 1px dashed var(--d1-line);
	background: var(--d1-tile);
	color: var(--d1-dim);
	font-size: var(--fs-xs, 11px);
	font-weight: 600;
	line-height: 1.6;
	white-space: nowrap;
	cursor: default;
}
.hid.in { left: 12px; top: 0; transform: translateY(-50%); }
.hid.out { right: 12px; bottom: 0; transform: translateY(50%); }
</style>
