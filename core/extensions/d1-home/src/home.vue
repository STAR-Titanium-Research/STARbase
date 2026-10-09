<script setup lang="ts">
import { computed } from 'vue';
import { useStores } from '@directus/extensions-sdk';
import { PageShell } from '@d1/ui';
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
		<PageShell>
			<!-- The thin banner of the Force dashboard (packages/force-plotting ForceDashboard.vue). -->
			<section class="hero">
				<h1>{{ greeting }}, {{ firstName }}</h1>
				<span class="hero-sub">{{ today }} · STARbase Lab</span>
			</section>

			<QuickActions />
			<div class="d1-cols">
				<NeedsAttention :is-admin="isAdmin" />
				<LabStats />
			</div>
			<MyWork />
			<RecentActivity />
		</PageShell>
	</private-view>
</template>

<style scoped>
.hero {
	display: flex;
	align-items: baseline;
	flex-wrap: wrap;
	gap: 2px 14px;
	padding: 12px 16px;
	border-radius: 12px;
	color: #fff;
	background: linear-gradient(120deg, var(--theme--primary, #1d4ed8), #0d9488);
	box-shadow: 0 8px 20px -12px rgba(29, 78, 216, 0.5);
}
.hero h1 { margin: 0; font-size: var(--fs-xl, 18px); font-weight: 700; letter-spacing: -0.01em; line-height: 1.3; }
.hero-sub { font-size: var(--fs-sm, 12px); font-weight: 600; opacity: 0.9; }
</style>
