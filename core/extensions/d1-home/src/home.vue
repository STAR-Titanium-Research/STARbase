<script setup lang="ts">
import { computed } from 'vue';
import { useStores } from '@directus/extensions-sdk';
import QuickActions from './home/QuickActions.vue';
import NeedsAttention from './home/NeedsAttention.vue';
import MyWork from './home/MyWork.vue';
import LabStats from './home/LabStats.vue';
import RecentActivity from './home/RecentActivity.vue';

// Home is "my work" (docs/superpowers/specs/2026-10-06-explorer-pages-design.md, "Home"): a
// greeting, the few things a researcher does every day, what needs attention, my projects,
// campaigns and samples, then the lab-wide strip and recent activity. Each block is its own
// component in ./home/ and loads on its own, so one forbidden collection never blanks Home.
const { useUserStore } = useStores();
const userStore = useUserStore() as any;

const firstName = computed(() => userStore.currentUser?.first_name || 'there');
const greeting = computed(() => {
	const h = new Date().getHours();
	return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
});
const today = computed(() =>
	new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }),
);
// Directus keeps the admin flag in different places across versions; any of them being true is
// enough, and a non-admin who is wrongly treated as one only sees a tile that counts what they
// may read anyway.
const isAdmin = computed(() => {
	const u = userStore.currentUser;
	return Boolean(userStore.isAdmin ?? u?.admin_access ?? u?.role?.admin_access);
});
</script>

<template>
	<private-view title="Home">
		<div class="home">
			<section class="hero">
				<div class="hero-text">
					<h1>{{ greeting }}, {{ firstName }}</h1>
					<p>{{ today }} · STARbase Lab</p>
				</div>
			</section>

			<QuickActions />
			<NeedsAttention :is-admin="isAdmin" />
			<MyWork />
			<LabStats />
			<RecentActivity />
		</div>
	</private-view>
</template>

<style scoped>
.home {
	max-width: 1080px;
	margin: 0 auto;
	padding: 24px 32px 56px;
	display: flex;
	flex-direction: column;
	gap: 32px;
	font-family: var(--theme--fonts--sans--font-family, -apple-system, 'Segoe UI', Roboto, sans-serif);
	color: var(--theme--foreground);
}
.hero {
	border-radius: 20px;
	padding: 34px 36px;
	color: #fff;
	background:
		radial-gradient(120% 140% at 100% 0%, rgba(255, 255, 255, 0.18), transparent 55%),
		linear-gradient(120deg, var(--theme--primary, #1d4ed8), #0d9488);
	box-shadow: 0 12px 30px -12px rgba(29, 78, 216, 0.5);
}
.hero h1 { margin: 0; font-size: 30px; font-weight: 750; letter-spacing: -0.01em; }
.hero p { margin: 6px 0 0; font-size: 14px; opacity: 0.9; }
</style>
