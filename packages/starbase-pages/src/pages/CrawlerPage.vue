<script setup lang="ts">
import { computed } from 'vue';
import { AppLink, PageShell, useExplorerHost } from '@d1/ui';
import ExplorerView from '../ExplorerView.vue';
import CrawlerPanel from '../crawler/CrawlerPanel.vue';
import { crawlerAccess } from '../crawler/crawlerModel';

// Force Crawler (admins only). The gate waits for the host to say whether this person is an admin, so a hard
// reload as an admin is not bounced on the starting guess; the panel (and its polling) is only mounted once
// they are allowed, so a non-admin makes no requests. The server enforces the same rule: the crawler tables
// are not writable by anyone else.
const host = useExplorerHost();
const access = computed(() => crawlerAccess(host.adminKnown.value, host.isAdmin.value));
</script>

<template>
	<ExplorerView title="Force Crawler">
		<PageShell>
			<nav class="d1-crumbs"><AppLink to="/home">Home</AppLink><span>›</span><span>Force Crawler</span></nav>
			<p v-if="access === 'checking'" class="d1-note" role="status">Checking your access…</p>
			<p v-else-if="access === 'denied'" class="d1-note warn" role="alert" data-test="crawler-admins-only">
				Admins only. The Force Crawler controls the host's .mat processing queue; ask an administrator if you need something changed.
			</p>
			<CrawlerPanel v-else />
		</PageShell>
	</ExplorerView>
</template>
