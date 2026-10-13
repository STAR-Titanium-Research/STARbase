<script setup lang="ts">
// The Explorer sidebar (N1b decision 1): an icon rail that picks a section, and a panel beside it
// with that section's lists and each collection's saved views nested under it. It sits in the
// host's navigation column; the host supplies the ExplorerHost (STARbase's ExplorerView) and this
// component only reads it.
//
// The panel follows the page (the section holding the current link is shown), and the rail can
// switch it without navigating; on Home that pick is remembered in this browser.
//
// Plain HTML, the kit's tokens and the host's navigation theme variables, so it can move to the
// standalone app unchanged. The finder button only emits; the finder dialog is wired by the host
// page.
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import '../components/tokens.css';
import { useExplorerHost } from '../host';
import { canonicalPath } from '../links';
import NavPanel from './NavPanel.vue';
import NavRail from './NavRail.vue';
import { readSection, writeSection } from './navState';
import { activeSection, followPage, railSections, restoreSection, startSection } from './railModel';
import type { RailSectionId } from './railModel';
import { useExplorerNav } from './useExplorerNav';

defineEmits<{ (e: 'open-finder'): void }>();

// The brand block (name and tagline). Inside Directus the project header above the navigation
// slot already shows it, so DirectusFrame turns it off; the standalone app leaves it on.
withDefaults(defineProps<{ showBrand?: boolean }>(), { showBrand: true });

const host = useExplorerHost();
const { nav, loading, error, refresh } = useExplorerNav(host);

const route = useRoute();

// Home is '/home' in the Directus form whatever this host calls it (STARbase: '/').
const onHome = () => canonicalPath(route.path) === '/home';

const sections = computed(() => railSections(nav.value));

// The section holding the page you are on (marked on the rail; none for a page outside every
// section), and the one whose panel is open.
const current = computed<RailSectionId | null>(() => activeSection(sections.value, route.path, route.query));
// The section remembered from the last visit to Home is restored when the sidebar mounts on Home:
// at once when the lists are already loaded (you came back to Home from another page; the nav state
// outlives the page), else (`pending`) when they arrive after the first paint. A rail click or a page
// change cancels it. After that the panel just follows the user.
const start = startSection(sections.value, route.path, route.query, onHome() ? readSection() : null);
const selected = ref<RailSectionId>(start.selected);
let pending: string | null = start.pending;
// True once the user has picked a section on this page: loading more sections then leaves it alone.
let picked = false;

const follow = () => {
	selected.value = followPage(sections.value, route.path, route.query);
};

watch(
	() => route.fullPath,
	() => {
		pending = null;
		picked = false;
		follow();
	},
);

watch(
	() => sections.value.map((s) => s.id).join(),
	() => {
		const restored = pending ? restoreSection(sections.value, pending) : null;
		if (restored) {
			selected.value = restored;
			pending = null;
		} else if (!sections.value.some((s) => s.id === selected.value) || (!picked && !pending)) {
			follow();
		}
	},
);

function select(id: RailSectionId) {
	selected.value = id;
	picked = true;
	pending = null;
	// Remembered only from Home (where the panel is free to wander); elsewhere the panel goes back to
	// following the page on the next navigation.
	if (onHome()) writeSection(id);
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
	width: 100%;
	align-items: flex-start;
	font-family: var(--theme--navigation--list--font-family, var(--theme--fonts--sans--font-family, inherit));
	font-size: var(--fs-md, 13px);
	line-height: 1.4;
	color: var(--nav-fg);
}
/* The panel takes everything beside the 60px rail. The host's navigation column is narrow (about 200px in
   Directus, less its scrollbar), so the padding is small and long labels wrap (NavPanel). */
.body { flex: 1 1 0; min-width: 0; padding: 12px 4px 24px 4px; }
.brand { padding: 4px 8px 10px; font-size: var(--fs-lg, 15px); font-weight: 700; }
.brand small { display: block; font-size: var(--fs-xs, 11px); font-weight: 400; color: var(--nav-dim); }

.note { margin: 14px 8px 0; font-size: var(--fs-sm, 12px); color: var(--nav-dim); }
.retry {
	margin-left: 4px; padding: 0; border: 0; background: none; cursor: pointer;
	font: inherit; font-weight: 600; color: var(--d1-accent, var(--theme--primary)); text-decoration: underline;
}
.retry:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 1px; }
</style>
