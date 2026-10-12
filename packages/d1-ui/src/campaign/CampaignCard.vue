<script setup lang="ts">
// A campaign as a card: code and name, the type as a tag, status, owner, dates, plain counts and one
// progress bar ("force analysed n / m" for a machining trial, "tests complete n / m" for a testing
// campaign). The whole card is the link to the Campaign page. Used by the Project page's Campaigns
// panel and by the campaigns index in Cards view; the numbers come from campaignCardStats.
import { computed } from 'vue';
import { formatDate } from '../format';
import { humanise } from '../status';
import { recordRoute } from '../recordRoute';
import { campaignTypeLabel } from './campaignType';
import type { CampaignStats } from './campaignCardStats';
import ProgressBar from '../components/ProgressBar.vue';
import RecordCard from '../components/RecordCard.vue';

const props = defineProps<{
	campaign: any;
	/** Null when the counts could not be read. */
	stats: CampaignStats | null;
	/** The counts are still on their way: show no verdict yet. */
	loading?: boolean;
}>();

const dates = computed(() => {
	const a = formatDate(props.campaign.start_date);
	const b = formatDate(props.campaign.end_date);
	return a && b ? `${a} to ${b}` : a ? `From ${a}` : b ? `Until ${b}` : '';
});
const progress = computed(() => props.stats?.progress ?? null);
</script>

<template>
	<RecordCard
		:to="recordRoute('campaigns', campaign.campaign_id)"
		:code="campaign.campaign_code || campaign.name"
		:name="campaign.campaign_code ? campaign.name : null"
	>
		<template #tag><span class="d1-tag">{{ campaignTypeLabel(campaign.campaign_type) }}</span></template>
		<template #meta>
			<span v-if="campaign.status">{{ humanise(campaign.status) }}</span>
			<span v-if="campaign.owner_person_id?.full_name">Owner: {{ campaign.owner_person_id.full_name }}</span>
			<span v-if="dates">{{ dates }}</span>
		</template>
		<template v-if="stats">
			<span class="d1-counts">
				<span><b>{{ stats.samples }}</b> samples</span>
				<span><b>{{ stats.operations }}</b> operations</span>
				<span><b>{{ stats.tests }}</b> tests</span>
			</span>
			<span v-if="progress?.kind === 'bar' && progress.total" class="progress">
				<span class="p-label">{{ progress.label }}</span>
				<ProgressBar :value="progress.done" :max="progress.total" />
			</span>
			<span v-else-if="progress?.kind === 'unavailable'" class="no-progress">
				{{ progress.label }}: progress unavailable ({{ progress.reason === 'truncated' ? 'too many records' : 'no access to the data' }})
			</span>
			<span v-else-if="progress?.kind === 'bar'" class="no-progress">No {{ campaign.campaign_type === 'testing_campaign' ? 'tests' : 'machining operations' }} to track yet</span>
		</template>
		<span v-else-if="loading" class="no-progress" aria-hidden="true">&nbsp;</span>
		<span v-else class="no-progress">Counts unavailable</span>
	</RecordCard>
</template>

<style scoped>
.progress { display: flex; flex-direction: column; gap: 2px; margin-top: 2px; }
.p-label { font-size: var(--fs-xs, 11px); font-weight: 600; letter-spacing: 0.01em; color: var(--d1-dim); }
.no-progress { font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
</style>
