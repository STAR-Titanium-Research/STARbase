<script setup lang="ts">
import { AppLink, PageShell } from '@d1/ui';
import ExplorerView from '../ExplorerView.vue';
import InboxView from '../inbox/InboxView.vue';

// Inbox: the files found in the person's folder on the share (and their teams' folders), waiting to be linked. The read of the list, the
// links and the undo all go through the d1-inbox endpoint as the signed-in user (inbox/inboxApi.ts); this is only the frame.
</script>

<template>
	<ExplorerView title="Inbox">
		<PageShell>
			<nav class="d1-crumbs"><AppLink to="/home">Home</AppLink><span>›</span><span>Inbox</span></nav>
			<InboxView />
		</PageShell>
	</ExplorerView>
</template>
