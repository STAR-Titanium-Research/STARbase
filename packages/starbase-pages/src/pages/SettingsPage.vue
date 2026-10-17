<script setup lang="ts">
import { AppLink, PageShell } from '@d1/ui';
import ExplorerView from '../ExplorerView.vue';
import AppearanceSection from '../settings/AppearanceSection.vue';
import PinnedSection from '../settings/PinnedSection.vue';
import SidebarSection from '../settings/SidebarSection.vue';
import UsageSections from '../settings/UsageSections.vue';
import AutoLinkSection from '../inbox/AutoLinkSection.vue';
import { useSaves } from '../settings/useSaves';
import '../settings/settings.css';

// Settings (explorer-sidebar-b2 spec, decision 9): Appearance, Sidebar, Pinned, Inbox (automatic linking), Index pages, Frequently
// used. Each setting saves as it changes; a failed save says so beside the control, with Retry.
const saves = useSaves();
</script>

<template>
	<ExplorerView title="Settings">
		<PageShell narrow>
			<nav class="d1-crumbs"><AppLink to="/home">Home</AppLink><span>›</span><span>Settings</span></nav>
			<AppearanceSection :saves="saves" />
			<SidebarSection :saves="saves" />
			<PinnedSection :saves="saves" />
			<AutoLinkSection />
			<UsageSections />
		</PageShell>
	</ExplorerView>
</template>
