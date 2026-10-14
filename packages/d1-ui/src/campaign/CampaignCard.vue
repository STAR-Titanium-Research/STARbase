<script setup lang="ts">
// A campaign as a card, laid out like the Projects index's ProjectCard: code and name, the type as a
// tag and the status as a pill beside the code, then owner and dates, plain counts and one progress
// bar ("force analysed n / m" for a machining trial, "tests complete n / m" for a testing campaign)
// where the project card has its sparkline. The whole card is the link to the Campaign page. Used by
// the Project page's Campaigns panel (a tile inside the panel) and by the campaigns index in Cards
// view (`raised`, on the page ground like the project cards); the numbers come from campaignCardStats.
// A count not loaded yet, or not readable, shows a dash, never a misleading 0.
import { computed } from 'vue';
import { formatDate } from '../format';
import { recordRoute } from '../recordRoute';
import { campaignTypeLabel } from './campaignType';
import type { CampaignStats } from './campaignCardStats';
import ProgressBar from '../components/ProgressBar.vue';
import RecordCard from '../components/RecordCard.vue';
import StatusBadge from '../components/StatusBadge.vue';

const props = defineProps<{
	campaign: any;
	/** Null when the counts could not be read. */
	stats: CampaignStats | null;
	/** The counts are still on their way: show no verdict yet. */
	loading?: boolean;
	/** A card on the page ground (the campaigns index), not a tile inside a panel. */
	raised?: boolean;
}>();

const dates = computed(() => {
	const a = formatDate(props.campaign.start_date);
	const b = formatDate(props.campaign.end_date);
	return a && b ? `${a} to ${b}` : a ? `From ${a}` : b ? `Until ${b}` : 'No dates set';
});
const progress = computed(() => props.stats?.progress ?? null);
const show = (n: number | undefined) => (n === undefined ? '–' : n.toLocaleString('en-GB'));
</script>

<template>
	<RecordCard
		:to="recordRoute('campaigns', campaign.campaign_id)"
		:code="campaign.campaign_code || campaign.name"
		:name="campaign.campaign_code ? campaign.name : null"
		:raised="raised"
	>
		<template #tag>
			<span class="d1-tag">{{ campaignTypeLabel(campaign.campaign_type) }}</span>
			<StatusBadge kind="campaign" :value="campaign.status" />
		</template>
		<template #meta>
			<span>Owner: {{ campaign.owner_person_id?.full_name || 'not set' }}</span>
			<span>{{ dates }}</span>
		</template>
		<span class="d1-counts" title="Counts only what you can see">
			<span><b>{{ show(stats?.samples) }}</b> samples</span>
			<span><b>{{ show(stats?.operations) }}</b> operations</span>
			<span><b>{{ show(stats?.tests) }}</b> tests</span>
		</span>
		<span v-if="progress?.kind === 'bar' && progress.total" class="progress">
			<span class="p-label">{{ progress.label }}</span>
			<ProgressBar :value="progress.done" :max="progress.total" />
		</span>
		<span v-else-if="progress?.kind === 'unavailable'" class="no-progress">
			{{ progress.label }}: progress unavailable ({{ progress.reason === 'truncated' ? 'too many records' : 'no access to the data' }})
		</span>
		<span v-else-if="progress?.kind === 'bar'" class="no-progress">No {{ campaign.campaign_type === 'testing_campaign' ? 'tests' : 'machining operations' }} to track yet</span>
		<span v-else-if="!stats && loading" class="no-progress" aria-hidden="true">&nbsp;</span>
		<span v-else-if="!stats" class="no-progress">Counts unavailable</span>
	</RecordCard>
</template>

<style scoped>
.progress { display: flex; flex-direction: column; gap: 2px; margin-top: 2px; }
.p-label { font-size: var(--fs-xs, 11px); font-weight: 600; letter-spacing: 0.01em; color: var(--d1-dim); }
.no-progress { font-size: var(--fs-sm, 12px); color: var(--d1-dim); }
</style>
