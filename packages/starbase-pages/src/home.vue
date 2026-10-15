<script setup lang="ts">
import ExplorerView from './ExplorerView.vue';
import { computed } from 'vue';
import { PageShell, useExplorerHost } from '@d1/ui';
import QuickActions from './home/QuickActions.vue';
import NeedsAttention from './home/NeedsAttention.vue';
import MyWork from './home/MyWork.vue';
import MyTeams from './home/MyTeams.vue';
import WaitingForYou from './home/WaitingForYou.vue';
import LabStats from './home/LabStats.vue';
import RecentActivity from './home/RecentActivity.vue';
import AdminPanels from './home/AdminPanels.vue';
import FrequentlyUsed from './home/FrequentlyUsed.vue';

// Home is "my work" (docs/superpowers/specs/2026-10-06-explorer-pages-design.md, "Home"), laid out
// calmly (N1b, decision 5): a greeting with the quick actions in it, the frequently-used card (two
// short lists in one panel), one stats band, then a row of
// two equal-height panels (what needs attention, your work), my teams' latest records (only for someone in a team) and the admin panels (admins
// only). The recent activity is a side rail beside them (for everyone), under them when the page is narrow. Every block is its own component in ./home/ and loads on its own, so one
// forbidden collection never blanks Home, and none of them draws an empty box.
const host = useExplorerHost();

const firstName = computed(() => host.user.value?.first_name || 'there');
const greeting = computed(() => {
	const h = new Date().getHours();
	return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
});
const today = computed(() =>
	new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }),
);
// The server's own answer (GET /policies/me/globals), read once for the whole Explorer by the host.
const { isAdmin, adminKnown } = host;
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

			<div class="home-wrap">
				<div class="home-grid">
					<div class="home-main">
						<WaitingForYou />
						<FrequentlyUsed />
						<LabStats />
						<div class="row">
							<NeedsAttention :is-admin="isAdmin" />
							<MyWork />
						</div>
						<MyTeams />
						<AdminPanels :is-admin="adminConfirmed" />
					</div>
					<aside class="home-rail" aria-label="Recent activity"><RecentActivity /></aside>
				</div>
			</div>
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
/* Main column plus a recent-activity rail. The wrapper is the size container (an element cannot query
   itself, so the grid's own @container rule below only works because the container is its parent), so
   "narrow" is the width the page has (not the window's: the sidebar and the Data Studio's own chrome
   take some). The rail sticks under the host's header bar (--d1-header-offset: STARbase's PlainFrame
   sets it, the Data Studio's 70px is the fallback) and scrolls inside itself; it is not position:
   fixed, which would cover the shell's sticky bars. */
.home-wrap { container-type: inline-size; }
.home-grid { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 16px; align-items: start; }
.home-main { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.home-rail {
	position: sticky;
	top: var(--d1-header-offset, 70px);
	max-height: calc(100vh - var(--d1-header-offset, 70px) - 16px);
	max-height: calc(100dvh - var(--d1-header-offset, 70px) - 16px);
	overflow: auto;
	min-width: 0;
	/* overflow: auto clips what is drawn outside the box: room for the panel's shadow and focus outlines. */
	padding: 2px 4px 8px;
}
/* Under ~1100px of page the rail goes back inline at the bottom of the main column. */
@container (max-width: 1100px) {
	.home-grid { grid-template-columns: minmax(0, 1fr); }
	.home-rail { position: static; max-height: none; overflow: visible; padding: 0; }
}
/* Two panels of equal height: the grid stretches its items (the page's .d1-cols is align-items:start). */
.row { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 16px; align-items: stretch; }
.hero h1 { margin: 0; font-size: var(--fs-xl, 18px); font-weight: 700; letter-spacing: -0.01em; line-height: 1.3; }
.hero-sub { font-size: var(--fs-sm, 12px); font-weight: 600; opacity: 0.9; }
</style>
