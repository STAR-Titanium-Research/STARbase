<script setup lang="ts">
import {
	LIST_CAP, LoadState, ProgressBar, RecordCard, Section, campaignTypeLabel, collectionRoute, formatDate, humanise, recordRoute,
	type SectionState,
} from '@d1/ui';
import { computed } from 'vue';

// The project's campaigns as cards: type, owner, status, dates, plain counts and one progress bar
// ("force analysed n / m" for a machining trial, "tests complete n / m" for a testing campaign).
// The numbers are computed here from the real collections; the Campaign page has its own roll-up.
const props = defineProps<{ campaigns: SectionState<any[]> }>();

const rows = computed(() => props.campaigns.data.slice(0, LIST_CAP));
const capped = computed(() => props.campaigns.data.length > LIST_CAP);
const dates = (c: any) => {
	const a = formatDate(c.start_date);
	const b = formatDate(c.end_date);
	return a && b ? `${a} to ${b}` : a ? `From ${a}` : b ? `Until ${b}` : '';
};
</script>

<template>
	<Section
		title="Campaigns"
		:count="campaigns.loading ? null : rows.length"
		:empty="!campaigns.loading && !campaigns.error && !rows.length"
		empty-text="No campaigns in this project."
	>
		<LoadState :loading="campaigns.loading" :error="campaigns.error">
			<div class="grid">
				<RecordCard
					v-for="c in rows"
					:key="c.campaign_id"
					:to="recordRoute('campaigns', c.campaign_id)"
					:code="c.campaign_code || c.name"
					:name="c.campaign_code ? c.name : null"
				>
					<template #tag><span class="d1-tag">{{ campaignTypeLabel(c.campaign_type) }}</span></template>
					<template #meta>
						<span v-if="c.status">{{ humanise(c.status) }}</span>
						<span v-if="c.owner_person_id?.full_name">Owner: {{ c.owner_person_id.full_name }}</span>
						<span v-if="dates(c)">{{ dates(c) }}</span>
					</template>
					<template v-if="c.stats">
						<span class="d1-counts">
							<span><b>{{ c.stats.samples }}</b> samples</span>
							<span><b>{{ c.stats.operations }}</b> operations</span>
							<span><b>{{ c.stats.tests }}</b> tests</span>
						</span>
						<span v-if="c.stats.progress.kind === 'bar' && c.stats.progress.total" class="progress">
							<span class="p-label">{{ c.stats.progress.label }}</span>
							<ProgressBar :value="c.stats.progress.done" :max="c.stats.progress.total" />
						</span>
						<span v-else-if="c.stats.progress.kind === 'unavailable'" class="no-progress">
							{{ c.stats.progress.label }}: progress unavailable ({{ c.stats.progress.reason === 'truncated' ? 'too many records' : 'no access to the data' }})
						</span>
						<span v-else-if="c.stats.progress.kind === 'bar'" class="no-progress">No {{ c.campaign_type === 'testing_campaign' ? 'tests' : 'machining operations' }} to track yet</span>
					</template>
					<span v-else class="no-progress">Counts unavailable</span>
				</RecordCard>
			</div>
			<p v-if="capped" class="d1-note cap">Showing the first {{ LIST_CAP }} campaigns. <router-link :to="collectionRoute('campaigns')">Open the collection in the Data Studio (unfiltered)</router-link> for the rest.</p>
		</LoadState>
	</Section>
</template>

<style scoped>
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 8px; }
.progress { display: flex; flex-direction: column; gap: 2px; margin-top: 2px; }
.p-label { font-size: var(--fs-xs); font-weight: 600; letter-spacing: 0.01em; color: var(--d1-dim); }
.no-progress { font-size: var(--fs-sm); color: var(--d1-dim); }
.cap { margin-top: 10px; }
</style>
