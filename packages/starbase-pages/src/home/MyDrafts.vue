<script setup lang="ts">
import { AppLink, Section, formatDate } from '@d1/ui';
import { draftPath, useMyDrafts } from './useMyDrafts';

// "My drafts" (spec E3): the processes the person has started on the Process map and not created yet, each a link that
// reopens it in edit mode. It draws nothing when there are none, or when this server has no d1-build yet, and fails on its
// own line like the other Home blocks (see useMyDrafts).
const { shown, more, drafts, error, visible } = useMyDrafts();
</script>

<template>
	<Section v-if="visible" title="My drafts" :count="drafts.length">
		<p v-if="error" class="d1-note bad" role="alert">{{ error }}</p>
		<ul v-if="shown.length" class="drafts">
			<li v-for="d in shown" :key="d.id">
				<AppLink :to="draftPath(d.id)" class="draft">
					<span class="name">{{ d.name }}</span>
					<span v-if="d.summary" class="sum">{{ d.summary }}</span>
					<span v-if="d.updated_at" class="when">Updated {{ formatDate(d.updated_at, '—') }}</span>
				</AppLink>
			</li>
		</ul>
		<p v-if="more" class="d1-note more">and {{ more }} more, in the Open menu of the Process map</p>
	</Section>
</template>

<style scoped>
.drafts { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 2px; }
.draft {
	display: flex; align-items: baseline; flex-wrap: wrap; gap: 2px 12px; margin: 0 -8px; padding: 6px 8px; border-radius: 8px;
	color: inherit; text-decoration: none;
}
.draft:hover, .draft:focus-visible { background: var(--d1-tile); }
.draft:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: -2px; }
.name { font-size: var(--fs-md, 13px); font-weight: 650; color: var(--d1-accent, var(--theme--primary)); overflow-wrap: anywhere; }
.sum { min-width: 0; font-size: var(--fs-sm, 12px); color: var(--theme--foreground); overflow-wrap: anywhere; }
.when { margin-left: auto; font-size: var(--fs-xs, 11px); color: var(--d1-dim); white-space: nowrap; }
.more { margin-top: 6px; }
</style>
