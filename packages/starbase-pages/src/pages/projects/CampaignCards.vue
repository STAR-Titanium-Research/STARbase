<script setup lang="ts">
import { AppLink, CampaignCard, LIST_CAP, LoadState, indexRoute, splitCampaigns, type SectionState } from '@d1/ui';
import { computed, ref, useId } from 'vue';

// The project's campaigns on the page ground: a heading with a count chip, then the kit's CampaignCard drawn `raised`, exactly as the
// campaigns list draws it (type, owner, status, dates, plain counts, one progress bar). Planned, active and on hold come first; the
// complete ones sit behind "Show n complete campaigns". The numbers are computed in useProjectData from the real collections; the
// Campaign page has its own roll-up. Not a Section: the cards are the page's blocks, not the contents of a panel.
const props = defineProps<{ campaigns: SectionState<any[]>; projectId?: string | null }>();
// The full list opens narrowed to this project (the Campaigns page has a Project filter).
const allCampaigns = computed(() => indexRoute('campaigns', props.projectId ? { query: { 'f.project_id': props.projectId } } : {}));

const rows = computed(() => props.campaigns.data.slice(0, LIST_CAP));
const capped = computed(() => props.campaigns.data.length > LIST_CAP);
const groups = computed(() => splitCampaigns(rows.value));
const showComplete = ref(false);
const headingId = useId();
const foldId = useId();
</script>

<template>
	<section id="campaigns" class="camps" :aria-labelledby="headingId">
		<h2 :id="headingId">Campaigns<span v-if="!campaigns.loading" class="count">{{ rows.length }}</span></h2>
		<LoadState :loading="campaigns.loading" :error="campaigns.error">
			<p v-if="!rows.length" class="d1-note">No campaigns in this project.</p>
			<template v-else>
				<div v-if="groups.open.length" class="grid">
					<CampaignCard v-for="c in groups.open" :key="c.campaign_id" :campaign="c" :stats="c.stats" raised />
				</div>
				<p v-else class="d1-note">No open campaigns.</p>
				<div v-if="groups.complete.length">
					<button type="button" class="fold" :aria-expanded="showComplete" :aria-controls="foldId" @click="showComplete = !showComplete">
						<v-icon :name="showComplete ? 'expand_less' : 'expand_more'" small />{{ showComplete ? 'Hide' : 'Show' }} {{ groups.complete.length }} complete campaign{{ groups.complete.length === 1 ? '' : 's' }}
					</button>
				</div>
				<div v-if="showComplete" :id="foldId" class="grid">
					<CampaignCard v-for="c in groups.complete" :key="c.campaign_id" :campaign="c" :stats="c.stats" raised />
				</div>
			</template>
			<p v-if="capped" class="d1-note">Showing the first {{ LIST_CAP }} campaigns. <AppLink :to="allCampaigns">{{ projectId ? "See all of this project's campaigns" : 'See the full list' }}</AppLink>.</p>
		</LoadState>
	</section>
</template>

<style scoped>
.camps { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
h2 { margin: 0; display: inline-flex; align-items: center; gap: 8px; font-size: var(--fs-md, 13px); font-weight: 650; line-height: 1.3; }
.count {
	font-size: var(--fs-xs, 11px); font-weight: 700; font-variant-numeric: tabular-nums; padding: 1px 7px; border-radius: 99px;
	color: var(--d1-accent, var(--theme--primary)); background: color-mix(in srgb, var(--d1-accent, var(--theme--primary)) 12%, transparent);
}
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }
.fold {
	display: inline-flex; align-items: center; gap: 4px; padding: 2px 0; border: 0; background: none; font: inherit; font-size: var(--fs-sm, 12px);
	font-weight: 600; color: var(--d1-accent, var(--theme--primary)); cursor: pointer;
}
.fold:hover { text-decoration: underline; }
.fold:focus-visible { outline: 2px solid var(--d1-accent, var(--theme--primary)); outline-offset: 2px; border-radius: 2px; }
</style>
