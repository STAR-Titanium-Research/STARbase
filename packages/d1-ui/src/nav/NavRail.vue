<script setup lang="ts">
// The icon rail of the Explorer sidebar (N1b decision 1): a narrow dark column with the finder
// button on top and one button per section. Clicking a section only picks what the panel shows
// (the parent decides); `selected` is the section whose panel is open (aria-pressed) and
// `current` the one holding the page you are on (aria-current), which differ while you browse.
// Glyphs are plain text, so nothing here needs a host icon component.
import type { RailSection, RailSectionId } from './railModel';

defineProps<{ sections: RailSection[]; selected: RailSectionId; current: RailSectionId | null }>();
defineEmits<{ (e: 'select', id: RailSectionId): void; (e: 'open-finder'): void }>();
</script>

<template>
	<div class="d1-rail" role="group" aria-label="Sections">
		<button type="button" class="btn find" aria-haspopup="dialog" aria-label="Find a record (Ctrl K)" title="Find a record (Ctrl K)" @click="$emit('open-finder')">
			<span class="glyph" aria-hidden="true">🔍</span>
			<span class="text">Find</span>
		</button>
		<button
			v-for="s in sections"
			:key="s.id"
			type="button"
			class="btn"
			:class="{ on: s.id === selected }"
			:aria-pressed="s.id === selected"
			:aria-current="s.id === current ? 'true' : undefined"
			@click="$emit('select', s.id)"
		>
			<span class="glyph" aria-hidden="true">{{ s.icon }}</span>
			<span class="text">{{ s.label }}</span>
		</button>
	</div>
</template>

<style scoped>
.d1-rail {
	display: flex; flex: none; flex-direction: column; align-items: center; gap: 6px;
	width: 60px; padding: 10px 0;
	background: #11181f; color: #b9c2cc;
	/* Fills the navigation column and stays put while a long panel scrolls past it. 100vh is a little
	   more than the column (the header sits above it); set --d1-nav-offset to the header's height to trim. */
	position: sticky; top: 0; align-self: flex-start;
	height: calc(100vh - var(--d1-nav-offset, 0px));
	overflow-y: auto;
}
.btn {
	position: relative;
	display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px;
	width: 54px; height: 46px; padding: 0;
	border: 0; border-radius: 10px; background: none; color: inherit;
	font: inherit; cursor: pointer;
}
.btn:hover { background: #1c2630; }
.btn.on { background: #2a3644; color: #fff; }
.glyph { font-size: 16px; line-height: 1; color: #fff; font-variant-emoji: text; }
.text { font-size: var(--fs-xs, 11px); line-height: 1.1; letter-spacing: -0.01em; white-space: nowrap; }
/* The page you are on: a thin bar on the rail's edge, so it still shows while another section's panel is open. */
.btn[aria-current='true']::before {
	content: ''; position: absolute; left: -5px; top: 10px; bottom: 10px; width: 3px; border-radius: 2px;
	background: #8ab4f8;
}
.find { margin-bottom: 6px; border: 1px solid #2a3644; }
.btn:focus-visible { outline: 2px solid #fff; outline-offset: 1px; }
</style>
