<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { AppLink, PageShell, useExplorerHost } from '@d1/ui';
import ExplorerView from '../ExplorerView.vue';
import CrawlerPanel from '../crawler/CrawlerPanel.vue';
import { crawlerAccess } from '../crawler/crawlerModel';
import InboxCrawlerPanel from '../inbox/InboxCrawlerPanel.vue';

// Crawlers (admins only): the Force Crawler and, on a second tab (?tab=inbox), the Inbox crawler. The gate waits for the host to say whether this
// person is an admin, so a hard reload as an admin is not bounced on the starting guess; the panels (and their polling) are only mounted once
// they are allowed, and only the one on the open tab, so a non-admin makes no requests. This is a UI gate, not the permission: the daemon's
// force_crawler_state is read-only for Lab Members on the server, but machining_force_analysis is updatable by a Lab Member for operations they
// can edit (status included), so Retry / Recrawl are not server-restricted to admins. The Inbox crawler's route (d1-inbox admin) refuses a
// non-admin itself.
const host = useExplorerHost();
const route = useRoute();
const router = useRouter();
const access = computed(() => crawlerAccess(host.adminKnown.value, host.isAdmin.value));

const TABS = [
	{ id: 'force', label: 'Force crawler' },
	{ id: 'inbox', label: 'Inbox crawler' },
] as const;
type TabId = (typeof TABS)[number]['id'];
const tab = computed<TabId>(() => (route.query.tab === 'inbox' ? 'inbox' : 'force'));
const title = computed(() => (tab.value === 'inbox' ? 'Inbox crawler' : 'Force Crawler'));
const setTab = (id: TabId) => void router.replace({ path: route.path, query: id === 'force' ? {} : { tab: id } });
</script>

<template>
	<ExplorerView :title="title">
		<PageShell>
			<nav class="d1-crumbs"><AppLink to="/home">Home</AppLink><span>›</span><span>{{ title }}</span></nav>
			<p v-if="access === 'checking'" class="d1-note" role="status">Checking your access…</p>
			<p v-else-if="access === 'denied'" class="d1-note warn" role="alert" data-test="crawler-admins-only">
				Admins only. The Force Crawler controls the host's .mat processing queue; ask an administrator if you need something changed.
			</p>
			<template v-else>
				<div class="tabs" role="tablist" aria-label="Crawlers">
					<button
						v-for="t in TABS"
						:key="t.id"
						type="button"
						role="tab"
						class="tab"
						:class="{ on: tab === t.id }"
						:aria-selected="tab === t.id"
						:data-test="`crawler-tab-${t.id}`"
						@click="setTab(t.id)"
					>{{ t.label }}</button>
				</div>
				<InboxCrawlerPanel v-if="tab === 'inbox'" />
				<CrawlerPanel v-else />
			</template>
		</PageShell>
	</ExplorerView>
</template>

<style scoped>
.tabs { display: flex; flex-wrap: wrap; gap: 4px; border-bottom: 1px solid var(--d1-line); }
.tab {
	display: inline-flex; align-items: center; height: 34px; padding: 0 12px; border: 0; border-bottom: 2px solid transparent; margin-bottom: -1px;
	background: none; color: var(--d1-dim); font: inherit; font-size: var(--fs-md, 13px); font-weight: 600; cursor: pointer;
}
.tab:hover { color: var(--theme--foreground); }
.tab.on { color: var(--theme--foreground); border-bottom-color: var(--d1-accent, var(--theme--primary)); }
.tab:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: -2px; }
</style>
