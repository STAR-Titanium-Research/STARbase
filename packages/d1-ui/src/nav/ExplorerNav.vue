<script setup lang="ts">
// The Explorer sidebar (explorer-sidebar-b2 spec): one dark sidebar with Find, Home, the person's
// Pinned list and the five sections as an accordion (SidebarExpanded). It sits in the host's
// navigation column (Directus) or in STARbase's shell, which decides the mode and listens to
// `request-mode`; this component only renders what it is given and asks for a change.
//
// Plain HTML and the kit's tokens, so it works unchanged in both hosts. The finder button only
// emits; the finder dialog is wired by the host page. The rail mode comes with SidebarRail.
import '../components/tokens.css';
import SidebarExpanded from './SidebarExpanded.vue';
import type { SectionId } from './sidebarModel';

// The brand block (name and tagline). Inside Directus the project header above the navigation
// slot already shows it, so DirectusFrame turns it off; STARbase's shell draws its own logo.
// `mode` is the layout asked for; `collapsible` shows the collapse button (STARbase only).
withDefaults(defineProps<{ showBrand?: boolean; mode?: 'expanded' | 'rail'; collapsible?: boolean }>(), {
	showBrand: true,
	mode: 'expanded',
	collapsible: false,
});

defineEmits<{
	(e: 'open-finder'): void;
	(e: 'request-mode', mode: 'expanded' | 'rail', sectionId?: SectionId): void;
}>();
</script>

<template>
	<nav class="d1-kit d1-nav" aria-label="STARbase">
		<div v-if="showBrand" class="brand">
			STARBase
			<small>A sisyphean pursuit</small>
		</div>

		<SidebarExpanded
			:collapsible="collapsible"
			@open-finder="$emit('open-finder')"
			@request-mode="(m, s) => $emit('request-mode', m, s)"
		/>
	</nav>
</template>

<style scoped>
.d1-nav {
	box-sizing: border-box;
	width: 100%;
	/* Fills a host column that gives it a height: set --d1-nav-offset to what sits above it. Unset, it is as tall as its content. */
	min-height: calc(100vh - var(--d1-nav-offset, 100vh));
	padding: 12px 8px 24px;
	background: var(--d1-side-ground);
	color: var(--d1-side-text);
	font-family: var(--theme--navigation--list--font-family, var(--theme--fonts--sans--font-family, inherit));
	font-size: var(--fs-md, 13px);
	line-height: 1.4;
}
.brand { padding: 4px 8px 10px; font-size: var(--fs-lg, 15px); font-weight: 700; color: #fff; }
.brand small { display: block; font-size: var(--fs-xs, 11px); font-weight: 400; color: var(--d1-side-dim); }
</style>
