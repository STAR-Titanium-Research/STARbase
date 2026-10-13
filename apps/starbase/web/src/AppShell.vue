<script setup lang="ts">
import { useRouter } from 'vue-router';
import { ExplorerNav, Finder, useFinderShortcut } from '@d1/ui';
import { openScan } from '@d1/starbase-pages';
import BrandLogo from './BrandLogo.vue';
import { getConfig } from './config';
import { useApp } from './context';

// STARbase's chrome around every signed-in page (spec §3.3): the brand, the Explorer sidebar (its rail and
// panel, from @d1/ui) and the finder (Ctrl/Cmd+K and the sidebar's box), then the page. Data Studio
// opens in a new tab. The phone layout is added in Task 9.
const { session } = useApp();
const router = useRouter();
const { finderOpen, openFinder, closeFinder } = useFinderShortcut();
const scanFromFinder = () => {
	closeFinder();
	openScan();
};
const studioHref = `${getConfig().directusUrl}/admin`;

async function signOut() {
	await session.signOut();
	await router.replace('/signin');
}
</script>

<template>
	<div class="sb-shell">
		<aside class="sb-side" aria-label="STARbase">
			<router-link to="/" class="sb-brand" aria-label="STARbase Home"><BrandLogo /></router-link>
			<ExplorerNav :show-brand="false" style="--d1-nav-offset: 64px" @open-finder="openFinder" />
			<div class="sb-foot">
				<a :href="studioHref" target="_blank" rel="noopener" class="sb-foot-link"><v-icon name="open_in_new" x-small left />Data Studio</a>
				<span class="sb-user">{{ session.user.value?.first_name ?? '' }}</span>
				<button type="button" class="sb-signout" @click="signOut"><v-icon name="logout" x-small left />Sign out</button>
			</div>
		</aside>
		<main class="sb-content"><router-view /></main>
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
.sb-foot {
	margin-top: auto; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 12px 16px;
	border-top: 1px solid var(--theme--border-color-subdued); font-size: var(--fs-sm, 12px);
}
.sb-foot-link { color: var(--theme--foreground-subdued); text-decoration: none; }
.sb-user { margin-left: auto; color: var(--theme--foreground-subdued); }
.sb-signout { border: 0; background: none; padding: 4px; font: inherit; color: var(--theme--foreground); cursor: pointer; }
.sb-content { min-width: 0; height: 100dvh; overflow-y: auto; }
</style>
