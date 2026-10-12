<script setup lang="ts">
// The Explorer sidebar (N1b decision 1): an icon rail that picks a section, and a panel beside it
// with that section's lists and each collection's saved views nested under it. It sits in the
// host's navigation column; the host supplies the ExplorerHost (ExplorerView in d1-home) and this
// component only reads it.
//
// The panel follows the page (the section holding the current link is shown), and the rail can
// switch it without navigating; on Home that pick is remembered in this browser.
//
// Plain HTML, the kit's tokens and the host's navigation theme variables, so it can move to the
// standalone app unchanged. The finder button only emits; the finder dialog is wired by the host
// page.
import { computed, inject, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import '../components/tokens.css';
import { EXPLORER_HOST } from '../host';
import NavPanel from './NavPanel.vue';
import NavRail from './NavRail.vue';
import { readSection, writeSection } from './navState';
import { activeSection, railSections, resolveSection } from './railModel';
import type { RailSectionId } from './railModel';
import { useExplorerNav } from './useExplorerNav';

defineEmits<{ (e: 'open-finder'): void }>();

// The brand block (name and tagline). Inside Directus the project header above the navigation
// slot already shows it, so ExplorerView turns it off; the standalone app leaves it on.
withDefaults(defineProps<{ showBrand?: boolean }>(), { showBrand: true });

const host = inject(EXPLORER_HOST);
if (!host) throw new Error('ExplorerNav needs an ExplorerHost: render it inside ExplorerView');
const { nav, loading, error, refresh } = useExplorerNav(host);

const route = useRoute();

const sections = computed(() => railSections(nav.value));

// The section holding the page you are on (marked on the rail), and the one whose panel is open.
const current = computed<RailSectionId>(() => activeSection(sections.value, route.path, route.query));
const selected = ref<RailSectionId>(resolveSection(sections.value, route.path, route.query, readSection()));

// Re-pick when the page changes and when the set of sections does (the lists load after the first
// paint), not when only a saved view is added; so a section you picked on a page stays until you
// move on.
watch(
	() => `${route.fullPath}|${sections.value.map((s) => s.id).join()}`,
	() => {
		selected.value = resolveSection(sections.value, route.path, route.query, readSection());
	},
);

function select(id: RailSectionId) {
	selected.value = id;
	// Only Home lets the rail wander; anywhere else the panel goes back to following the page.
	if (route.path === '/home') writeSection(id);
}

const section = computed(() => sections.value.find((s) => s.id === selected.value) ?? sections.value[0]);
</script>

<template>
	<nav class="d1-kit d1-nav" aria-label="Explorer">
		<NavRail :sections="sections" :selected="selected" :current="current" @select="select" @open-finder="$emit('open-finder')" />

		<div class="body">
			<div v-if="showBrand" class="brand">
				STARBase
				<small>A sisyphean pursuit</small>
			</div>

			<NavPanel v-if="section" :section="section" />

			<p v-if="loading" class="note" role="status">Loading pages…</p>
			<p v-else-if="error" class="note" role="status">
				Couldn't load the list of pages.
				<button type="button" class="retry" @click="refresh">Retry</button>
			</p>
		</div>
	</nav>
</template>

<style scoped>
.d1-nav {
	--nav-fg: var(--theme--navigation--list--foreground, var(--theme--foreground));
	--nav-dim: color-mix(in srgb, var(--nav-fg) 62%, transparent);
	--nav-hover: var(--theme--navigation--list--background-hover, var(--d1-tint));
	--nav-on: var(--theme--navigation--list--background-active, var(--d1-tint));
	display: flex;
	align-items: stretch;
	min-height: 100%;
	font-family: var(--theme--navigation--list--font-family, var(--theme--fonts--sans--font-family, inherit));
	font-size: var(--fs-md, 13px);
	line-height: 1.4;
	color: var(--nav-fg);
}
.body { flex: 1; min-width: 0; padding: 12px 8px 24px 6px; }
.brand { padding: 4px 10px 10px; font-size: var(--fs-lg, 15px); font-weight: 700; }
.brand small { display: block; font-size: var(--fs-xs, 11px); font-weight: 400; color: var(--nav-dim); }

.note { margin: 14px 10px 0; font-size: var(--fs-sm, 12px); color: var(--nav-dim); }
.retry {
	margin-left: 4px; padding: 0; border: 0; background: none; cursor: pointer;
	font: inherit; font-weight: 600; color: var(--d1-accent, var(--theme--primary)); text-decoration: underline;
}
.retry:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 1px; }
</style>
