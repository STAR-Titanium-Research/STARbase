<script setup lang="ts">
import { ref } from 'vue';

// The rail on a phone (spec D24): a panel fixed to the bottom of the window, collapsed to its header
// (the selected record's code and a handle), opened and closed by tapping the header. Its body is the
// rail. It sits beside the page layout, not inside it: RecordLayout is a size container, which would
// make `position: fixed` relative to the layout instead of the window. Carries its own `.d1-kit` and
// `.d1-process-map` so the tokens and kind colours reach the rail drawn in it.
defineProps<{ title: string }>();
const open = ref(false);
</script>

<template>
	<section class="pm-sheet d1-kit d1-process-map" :class="{ open }" aria-label="Selected record">
		<button type="button" class="head" :aria-expanded="open" aria-controls="pm-sheet-body" @click="open = !open">
			<span class="grip" aria-hidden="true"></span>
			<span class="title">{{ title }}</span>
			<v-icon :name="open ? 'expand_more' : 'expand_less'" small />
		</button>
		<div v-show="open" id="pm-sheet-body" class="body"><slot /></div>
	</section>
</template>

<style scoped>
.pm-sheet {
	position: fixed;
	left: 0;
	right: 0;
	bottom: 0;
	z-index: 40;
	background: var(--d1-surface, var(--theme--background));
	color: var(--theme--foreground);
	border-top: 1px solid var(--d1-line, var(--theme--border-color-subdued));
	border-radius: 14px 14px 0 0;
	box-shadow: var(--d1-shadow-lg, 0 -4px 16px rgb(0 0 0 / 0.14));
	padding-bottom: env(safe-area-inset-bottom, 0px);
}
.head {
	position: relative;
	display: flex;
	align-items: center;
	gap: 10px;
	width: 100%;
	min-height: 48px;
	padding: 12px 16px 8px;
	border: 0;
	border-radius: 14px 14px 0 0;
	background: none;
	color: inherit;
	font: inherit;
	text-align: left;
	cursor: pointer;
}
.head:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: -2px; }
.grip { position: absolute; top: 6px; left: 50%; width: 36px; height: 4px; transform: translateX(-50%); border-radius: 2px; background: var(--d1-line, var(--theme--border-color)); }
.title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--theme--fonts--monospace--font-family, monospace); font-weight: 700; }
.body { max-height: min(60vh, 520px); max-height: min(60dvh, 520px); overflow: auto; padding: 4px 16px 16px; }
</style>
