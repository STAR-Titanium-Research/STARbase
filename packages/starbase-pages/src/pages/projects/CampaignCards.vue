<script setup lang="ts">
import { AppLink, CampaignCard, LIST_CAP, LoadState, Section, indexRoute, type SectionState } from '@d1/ui';
import { computed } from 'vue';

// The project's campaigns as cards (the kit's CampaignCard, drawn `raised` exactly as the campaigns list draws it):
// type, owner, status, dates, plain counts and one progress bar. The numbers are computed in
// useProjectData from the real collections; the Campaign page has its own roll-up.
const props = defineProps<{ campaigns: SectionState<any[]>; projectId?: string | null }>();
// The full list opens narrowed to this project (the Campaigns page has a Project filter).
const allCampaigns = computed(() => indexRoute('campaigns', props.projectId ? { query: { 'f.project_id': props.projectId } } : {}));

const rows = computed(() => props.campaigns.data.slice(0, LIST_CAP));
const capped = computed(() => props.campaigns.data.length > LIST_CAP);
</script>

<template>
	<Section
		id="campaigns"
		title="Campaigns"
		:count="campaigns.loading ? null : rows.length"
		:empty="!campaigns.loading && !campaigns.error && !rows.length"
		empty-text="No campaigns in this project."
	>
		<LoadState :loading="campaigns.loading" :error="campaigns.error">
			<div class="grid">
				<CampaignCard v-for="c in rows" :key="c.campaign_id" :campaign="c" :stats="c.stats" raised />
			</div>
			<p v-if="capped" class="d1-note cap">Showing the first {{ LIST_CAP }} campaigns. <AppLink :to="allCampaigns">{{ projectId ? "See all of this project's campaigns" : 'See the full list' }}</AppLink>.</p>
		</LoadState>
	</Section>
</template>

<style scoped>
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 8px; }
.cap { margin-top: 10px; }
</style>
