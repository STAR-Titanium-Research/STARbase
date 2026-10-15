<script setup lang="ts">
import { computed } from 'vue';
import { AppLink, Section, useExplorerHost, useInboxSummary } from '@d1/ui';
import { inboxLines, inboxPanelCount, showInboxPanel } from './inboxPanel';

// "Inbox" on Home (spec section 10, follows the admin attention-panel pattern): how many found files wait in the person's folder (and in
// their teams' folders) and how many older files already match a record, each a link into the Inbox. It shares the sidebar badge's poll
// (useInboxSummary), draws nothing when there is nothing to say or the server has no d1-inbox yet, and never an empty box.
const { summary, absent } = useInboxSummary(useExplorerHost());
const lines = computed(() => inboxLines(summary.value));
const visible = computed(() => !absent.value && showInboxPanel(summary.value));
const count = computed(() => inboxPanelCount(summary.value));
</script>

<template>
	<Section v-if="visible" title="Inbox" :count="count">
		<template #actions><AppLink to="/inbox" class="link">Open Inbox →</AppLink></template>
		<ul class="lines" data-test="home-inbox">
			<li v-for="l in lines" :key="l.key">
				<AppLink :to="l.to" class="line">
					<span class="text">{{ l.text }}</span>
					<span v-if="l.scope" class="scope">{{ l.scope }} team folder</span>
					<span class="go" aria-hidden="true">→</span>
				</AppLink>
			</li>
		</ul>
	</Section>
</template>

<style scoped>
.link { color: var(--d1-accent, var(--theme--primary)); font-weight: 600; font-size: var(--fs-sm); text-decoration: none; white-space: nowrap; }
.link:hover { text-decoration: underline; }
.lines { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 6px; }
.line {
	display: flex; align-items: baseline; gap: 12px; padding: 7px 12px; text-decoration: none; color: var(--theme--foreground);
	border: 1px solid var(--d1-line); border-radius: 10px; background: var(--d1-tile); transition: border-color 0.12s ease;
}
.line:hover, .line:focus-visible { border-color: var(--d1-accent, var(--theme--primary)); }
.text { font-size: var(--fs-md, 13px); font-weight: 650; }
.scope { min-width: 0; font-size: var(--fs-sm, 12px); color: var(--d1-dim); overflow-wrap: anywhere; }
.go { margin-left: auto; color: var(--d1-dim); }
</style>
