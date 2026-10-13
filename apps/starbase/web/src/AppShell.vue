<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ExplorerNav, Finder, useFinderShortcut } from '@d1/ui';
import { openScan } from '@d1/starbase-pages';
import BrandLogo from './BrandLogo.vue';
import ShellFoot from './ShellFoot.vue';
import { useNarrow } from './narrow';

// STARbase's chrome around every signed-in page (spec §3.3). Desktop: the brand, the Explorer sidebar
// (rail and panel, from @d1/ui) and its foot beside the page. Phone (< 768 px): a top bar with a menu
// button that opens the same sidebar as a full-height sheet (an aria-modal dialog, so Ctrl+K stays shut
// while it is open), and a find button. The finder is shared by both.
const narrow = useNarrow();
const sheetOpen = ref(false);
const route = useRoute();
const { finderOpen, openFinder, closeFinder } = useFinderShortcut();

const scanFromFinder = () => {
	closeFinder();
	openScan();
};
const findFromSheet = () => {
	sheetOpen.value = false;
	openFinder();
};

// The sheet closes when a page is chosen, when the window grows past phone width, and on Esc.
watch(() => route.fullPath, () => (sheetOpen.value = false));
watch(narrow, (isNarrow) => {
	if (!isNarrow) sheetOpen.value = false;
});
const onKey = (e: KeyboardEvent) => {
	if (e.key === 'Escape' && sheetOpen.value) sheetOpen.value = false;
};
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
	<div class="sb-shell" :class="{ phone: narrow }">
		<aside v-if="!narrow" class="sb-side" aria-label="STARbase">
			<router-link to="/" class="sb-brand" aria-label="STARbase Home"><BrandLogo /></router-link>
			<ExplorerNav :show-brand="false" style="--d1-nav-offset: 64px" @open-finder="openFinder" />
			<ShellFoot />
		</aside>
		<header v-else class="sb-topbar">
			<button type="button" class="sb-icon-btn" aria-label="Menu" :aria-expanded="sheetOpen" @click="sheetOpen = true"><v-icon name="menu" /></button>
			<router-link to="/" class="sb-brand" aria-label="STARbase Home"><BrandLogo compact /></router-link>
			<button type="button" class="sb-icon-btn" aria-label="Find a record" @click="openFinder"><v-icon name="search" /></button>
		</header>

		<main class="sb-content"><router-view /></main>

		<div v-if="narrow && sheetOpen" class="sb-sheet-backdrop" @mousedown.self="sheetOpen = false">
			<div class="sb-sheet" role="dialog" aria-modal="true" aria-label="Pages">
				<div class="sb-sheet-head">
					<BrandLogo />
					<button type="button" class="sb-icon-btn" aria-label="Close the menu" @click="sheetOpen = false"><v-icon name="close" /></button>
				</div>
				<ExplorerNav :show-brand="false" style="--d1-nav-offset: 56px" @open-finder="findFromSheet" />
				<ShellFoot />
			</div>
		</div>

		<Finder v-if="finderOpen" can-scan @close="closeFinder" @scan="scanFromFinder" />
	</div>
</template>

<style scoped>
.sb-shell { display: grid; grid-template-columns: 272px minmax(0, 1fr); height: 100dvh; }
.sb-side {
	display: flex; flex-direction: column; min-height: 0; overflow-y: auto;
	background: var(--theme--background-subdued); border-right: 1px solid var(--theme--border-color-subdued);
}
.sb-brand { display: flex; align-items: center; height: 64px; padding: 0 16px; flex: none; text-decoration: none; }
.sb-content { min-width: 0; height: 100dvh; overflow-y: auto; overflow-x: hidden; }

.sb-shell.phone { grid-template-columns: minmax(0, 1fr); grid-template-rows: 56px minmax(0, 1fr); }
.sb-shell.phone .sb-content { height: calc(100dvh - 56px); }
.sb-topbar {
	display: flex; align-items: center; justify-content: space-between; height: 56px; padding: 0 8px;
	background: var(--theme--background-subdued); border-bottom: 1px solid var(--theme--border-color-subdued);
}
.sb-topbar .sb-brand { height: 56px; padding: 0 8px; }
.sb-icon-btn {
	display: inline-grid; place-items: center; width: 44px; height: 44px; border: 0; border-radius: 10px;
	background: none; color: var(--theme--foreground); cursor: pointer;
}
.sb-icon-btn:focus-visible { outline: 2px solid var(--theme--primary); }
.sb-sheet-backdrop { position: fixed; inset: 0; z-index: 80; background: rgba(0, 0, 0, 0.4); }
.sb-sheet {
	display: flex; flex-direction: column; width: min(340px, 88vw); height: 100dvh; overflow-y: auto;
	background: var(--theme--background-subdued); box-shadow: 4px 0 24px rgba(0, 0, 0, 0.3);
}
.sb-sheet-head { display: flex; align-items: center; justify-content: space-between; height: 56px; padding: 0 8px 0 16px; flex: none; }
</style>
