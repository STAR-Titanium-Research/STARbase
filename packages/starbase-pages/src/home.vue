<script setup lang="ts">
import ExplorerView from './ExplorerView.vue';
import { computed } from 'vue';
import { useStores } from '@directus/extensions-sdk';
import { PageShell, useExplorerHost } from '@d1/ui';
import QuickActions from './home/QuickActions.vue';
import NeedsAttention from './home/NeedsAttention.vue';
import MyWork from './home/MyWork.vue';
import LabStats from './home/LabStats.vue';
import RecentActivity from './home/RecentActivity.vue';
import AdminPanels from './home/AdminPanels.vue';
import FrequentlyUsed from './home/FrequentlyUsed.vue';

// Home is "my work" (docs/superpowers/specs/2026-10-06-explorer-pages-design.md, "Home"), laid out
// calmly (N1b, decision 5): a greeting with the quick actions in it, the frequently-used card (two
// short lists in one panel), one stats band, then a row of
// two equal-height panels (what needs attention, your work), the admin panels (admins only) and the
// recent activity. Every block is its own component in ./home/ and loads on its own, so one
// forbidden collection never blanks Home, and none of them draws an empty box.
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
// The server's own answer (GET /policies/me/globals), read once for the whole Explorer by the host.
const { isAdmin, adminKnown } = useExplorerHost();
// The admin panels call an admin-only endpoint, so they wait for the server's answer instead of the guess.
const adminConfirmed = computed(() => isAdmin.value && adminKnown.value);
</script>

<template>
	<ExplorerView title="Home">
		<PageShell>
			<!-- The thin banner of the Force dashboard (packages/force-plotting ForceDashboard.vue). -->
			<section class="hero">
				<div class="hero-text">
					<h1>{{ greeting }}, {{ firstName }}</h1>
					<span class="hero-sub">{{ today }} · STARbase Lab</span>
				</div>
				<QuickActions />
			</section>

			<FrequentlyUsed />
			<LabStats />
			<div class="row">
				<NeedsAttention :is-admin="isAdmin" />
				<MyWork />
			</div>
			<AdminPanels :is-admin="adminConfirmed" />
			<RecentActivity />
		</PageShell>
	</ExplorerView>
</template>

<style scoped>
.hero {
	display: flex;
	align-items: center;
	justify-content: space-between;
	flex-wrap: wrap;
	gap: 10px 24px;
	padding: 14px 18px;
	border-radius: 12px;
	color: #fff;
	background: linear-gradient(120deg, var(--theme--primary, #1d4ed8), #0d9488);
	box-shadow: 0 8px 20px -12px rgba(29, 78, 216, 0.5);
}
.hero-text { display: flex; align-items: baseline; flex-wrap: wrap; gap: 2px 14px; min-width: 0; }
/* Two panels of equal height: the grid stretches its items (the page's .d1-cols is align-items:start). */
.row { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 16px; align-items: stretch; }
.hero h1 { margin: 0; font-size: var(--fs-xl, 18px); font-weight: 700; letter-spacing: -0.01em; line-height: 1.3; }
.hero-sub { font-size: var(--fs-sm, 12px); font-weight: 600; opacity: 0.9; }
</style>
