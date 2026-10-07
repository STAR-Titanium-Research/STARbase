<script setup lang="ts">
import {
	LIST_CAP, LoadState, ProgressBar, Section, campaignTypeLabel, collectionRoute, formatDate, humanise, recordRoute,
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
				<router-link v-for="c in rows" :key="c.campaign_id" :to="recordRoute('campaigns', c.campaign_id)" class="card">
					<div class="top">
						<span class="code">{{ c.campaign_code || c.name }}</span>
						<span class="type">{{ campaignTypeLabel(c.campaign_type) }}</span>
					</div>
					<div v-if="c.campaign_code" class="name">{{ c.name }}</div>
					<div class="meta">
						<span v-if="c.status">{{ humanise(c.status) }}</span>
						<span v-if="c.owner_person_id?.full_name">Owner: {{ c.owner_person_id.full_name }}</span>
						<span v-if="dates(c)">{{ dates(c) }}</span>
					</div>
					<template v-if="c.stats">
						<div class="counts">
							<span><b>{{ c.stats.samples }}</b> samples</span>
							<span><b>{{ c.stats.operations }}</b> operations</span>
							<span><b>{{ c.stats.tests }}</b> tests</span>
						</div>
						<div v-if="c.stats.progress.kind === 'bar' && c.stats.progress.total" class="progress">
							<span class="p-label">{{ c.stats.progress.label }}</span>
							<ProgressBar :value="c.stats.progress.done" :max="c.stats.progress.total" />
						</div>
						<div v-else-if="c.stats.progress.kind === 'unavailable'" class="no-progress">
							{{ c.stats.progress.label }}: progress unavailable ({{ c.stats.progress.reason === 'truncated' ? 'too many records' : 'no access to the data' }})
						</div>
						<div v-else-if="c.stats.progress.kind === 'bar'" class="no-progress">No {{ c.campaign_type === 'testing_campaign' ? 'tests' : 'machining operations' }} to track yet</div>
					</template>
					<div v-else class="no-progress">Counts unavailable</div>
				</router-link>
			</div>
			<p v-if="capped" class="cap">Showing the first {{ LIST_CAP }} campaigns. <router-link :to="collectionRoute('campaigns')">Open the collection in the Data Studio (unfiltered)</router-link> for the rest.</p>
		</LoadState>
	</Section>
</template>

<style scoped>
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; }
.card {
	display: flex; flex-direction: column; gap: 7px; padding: 14px 16px; min-width: 0;
	border: 1px solid var(--theme--border-color-subdued); border-radius: 14px;
	background: var(--theme--background); color: var(--theme--foreground); text-decoration: none;
	transition: border-color 0.14s ease, box-shadow 0.14s ease;
}
.card:hover { border-color: var(--theme--primary); box-shadow: 0 10px 22px -16px rgba(15, 23, 42, 0.4); }
.top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.code { font-family: var(--theme--fonts--monospace--font-family, monospace); font-weight: 750; font-size: 15px; overflow-wrap: anywhere; }
.type {
	margin-left: auto; font-size: 11px; font-weight: 650; padding: 1px 9px; border-radius: 99px;
	color: var(--theme--primary); background: var(--theme--primary-background);
}
.name { font-size: 13.5px; font-weight: 600; }
.meta { display: flex; flex-wrap: wrap; gap: 2px 14px; font-size: 12.5px; color: var(--theme--foreground-subdued); }
.counts { display: flex; gap: 14px; font-size: 12.5px; color: var(--theme--foreground-subdued); }
.counts b { color: var(--theme--foreground); font-size: 14px; }
.p-label { font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; color: var(--theme--foreground-subdued); }
.no-progress { font-size: 12px; font-style: italic; color: var(--theme--foreground-subdued); }
.cap { margin: 10px 0 0; font-size: 12.5px; color: var(--theme--foreground-subdued); }
</style>
