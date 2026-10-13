<script setup lang="ts">
// The Explorer sidebar (explorer-sidebar-b2 spec): one dark sidebar with Find, Home, the person's
// Pinned list and the five sections as an accordion (SidebarExpanded). It sits in STARbase's shell,
// which decides the mode and listens to `request-mode`; this component only renders what it is given and asks for a change.
//
// Plain HTML and the kit's tokens, so it works unchanged in both hosts. The finder button only
// emits; the finder dialog is wired by the host page. In `rail` mode it is a 60px column of icons
// with hover menus (SidebarRail); the host's mark goes in the `#mark` slot there.
import '../components/tokens.css';
import SidebarExpanded from './SidebarExpanded.vue';
import SidebarRail from './SidebarRail.vue';
import type { SectionId } from './sidebarModel';

// The brand block (name and tagline). Inside Directus the project header above the navigation
// slot already shows it, so DirectusFrame turns it off; STARbase's shell draws its own logo.
// `mode` is the layout asked for; `collapsible` shows the collapse button (STARbase only).
// `openSection` is the accordion section to open when the expanded sidebar appears (the shell
// passes the one a rail hover menu's header asked for); unset, the current page's section opens.
withDefaults(defineProps<{ showBrand?: boolean; mode?: 'expanded' | 'rail'; collapsible?: boolean; openSection?: SectionId | null }>(), {
	showBrand: true,
	mode: 'expanded',
	collapsible: false,
	openSection: null,
});

defineEmits<{
	(e: 'open-finder'): void;
	(e: 'request-mode', mode: 'expanded' | 'rail', sectionId?: SectionId): void;
}>();
</script>

<template>
	<nav class="d1-kit d1-nav" :class="{ rail: mode === 'rail' }" aria-label="STARbase">
		<SidebarRail
			v-if="mode === 'rail'"
			:collapsible="collapsible"
			@open-finder="$emit('open-finder')"
			@request-mode="(m, s) => $emit('request-mode', m, s)"
		>
			<template v-if="$slots.mark" #mark><slot name="mark" /></template>
		</SidebarRail>

		<template v-else>
			<div v-if="showBrand" class="brand">
				STARBase
				<small>A sisyphean pursuit</small>
			</div>

			<SidebarExpanded
				:collapsible="collapsible"
				:open-section="openSection"
				@open-finder="$emit('open-finder')"
				@request-mode="(m, s) => $emit('request-mode', m, s)"
			/>
		</template>
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
/* The rail is its own 60px: icons centred in it, no side padding. */
.d1-nav.rail { display: flex; flex-direction: column; width: 60px; padding: 8px 0 12px; }
.brand { padding: 4px 8px 10px; font-size: var(--fs-lg, 15px); font-weight: 700; color: #fff; }
.brand small { display: block; font-size: var(--fs-xs, 11px); font-weight: 400; color: var(--d1-side-dim); }
</style>
