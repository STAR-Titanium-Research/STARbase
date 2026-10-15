<script setup lang="ts">
import { computed } from 'vue';
import { AppLink, RecordCard, Section, StatusBadge, campaignTypeLabel, choiceLabel, collectionRoute, formatDate, humanise, projectStatusLabel, recordRoute } from '@d1/ui';
import { CARD_LIMIT, SAMPLE_LIMIT, useMyWork } from './useMyWork';

// "Your work": the projects where I am PI or investigator, the campaigns I own and my newest
// samples, as cards in one panel. A group with nothing in it is left out (not shown as an empty
// box), so a researcher with only samples sees only samples. Every card is a link to its Explorer
// page. Each group shows its first few cards (GROUP_SHOWN) and a "See all" link to the list, so a
// busy researcher's panel stays about as tall as its neighbour. The campaigns and samples include those a team I belong to owns. The three reads still load and fail
// on their own (useMyWork).
const GROUP_SHOWN = 5;
const shown = <T,>(rows: T[]) => rows.slice(0, GROUP_SHOWN);
// The reads are capped (CARD_LIMIT / SAMPLE_LIMIT), so a count at the cap is "at least".
const more = (n: number, cap: number) => `See all (${n}${n >= cap ? '+' : ''})`;
const { projects, campaigns, samples, hasPerson, partialProjects, partialSamples, partialTeams } = useMyWork();

const loading = computed(() => projects.value.loading || campaigns.value.loading || samples.value.loading);
const errors = computed(() => [projects.value.error, campaigns.value.error, samples.value.error].filter(Boolean));
const anything = computed(() => projects.value.data.length + campaigns.value.data.length + samples.value.data.length > 0);
</script>

<template>
	<Section title="Your work">
		<p v-if="hasPerson === false" class="notice" role="note">
			Your login is not linked to a person record, so samples and campaigns you own cannot be found.
			Ask an admin to link it on the <AppLink to="/home/people">People</AppLink> page. Projects where you are an
			investigator, and samples you co-own, still show.
		</p>
		<p v-if="partialProjects" class="notice" role="note">{{ partialProjects }}</p>
		<p v-if="partialSamples" class="notice" role="note">{{ partialSamples }}</p>
		<p v-if="partialTeams" class="notice" role="note">{{ partialTeams }}</p>
		<p v-for="e in errors" :key="e" class="d1-note bad" role="alert">{{ e }}</p>

		<p v-if="loading && !anything" class="d1-note">Loading…</p>
		<p v-else-if="!loading && !anything && !errors.length" class="d1-note">
			Nothing of yours yet: no project, campaign or sample is yours or shared with you.
		</p>

		<section v-if="projects.data.length" class="group" aria-label="My projects">
			<header>
				<h3>My projects <span class="n">{{ projects.data.length }}</span></h3>
				<AppLink v-if="projects.data.length > GROUP_SHOWN" to="/home/projects" class="link" title="All projects you can see">{{ more(projects.data.length, CARD_LIMIT) }} →</AppLink>
			</header>
			<div class="cards">
				<RecordCard
					v-for="p in shown(projects.data)"
					:key="p.project_id"
					:to="recordRoute('projects', p.project_id)"
					:code="p.project_code"
					:name="p.project_name"
				>
					<template #tag><span class="d1-tag">{{ projectStatusLabel(p.is_active) }}</span></template>
					<template #meta>PI: {{ p.principal_investigator_person?.full_name || 'not set' }}</template>
				</RecordCard>
			</div>
		</section>

		<section v-if="campaigns.data.length" class="group" aria-label="Campaigns I own">
			<header>
				<h3>Campaigns I own <span class="n">{{ campaigns.data.length }}</span></h3>
				<AppLink v-if="campaigns.data.length > GROUP_SHOWN" :to="collectionRoute('campaigns')" class="link" title="All campaigns you can see">{{ more(campaigns.data.length, CARD_LIMIT) }} →</AppLink>
			</header>
			<div class="cards">
				<RecordCard
					v-for="c in shown(campaigns.data)"
					:key="c.campaign_id"
					:to="recordRoute('campaigns', c.campaign_id)"
					:code="c.campaign_code || c.name"
					:name="c.campaign_code ? c.name : null"
				>
					<template #tag><span class="d1-tag">{{ campaignTypeLabel(c.campaign_type) }}</span></template>
					<template #meta>
						<span v-if="c.project_id?.project_code">Project {{ c.project_id.project_code }}</span>
						<span v-if="c.status">{{ humanise(c.status) }}</span>
					</template>
				</RecordCard>
			</div>
		</section>

		<section v-if="samples.data.length" class="group" aria-label="My latest samples">
			<header>
				<h3>My latest samples <span class="n">{{ samples.data.length }}</span></h3>
				<AppLink v-if="samples.data.length > GROUP_SHOWN" :to="collectionRoute('physical_samples')" class="link" :title="`Your newest ${SAMPLE_LIMIT} by last update; all samples you can see`">{{ more(samples.data.length, SAMPLE_LIMIT) }} →</AppLink>
				<span v-else class="cap-note">newest first</span>
			</header>
			<div class="cards">
				<RecordCard
					v-for="s in shown(samples.data)"
					:key="s.sample_id"
					:to="recordRoute('physical_samples', s.sample_id)"
					:code="s.sample_code"
					:name="s.material_id?.common_name || choiceLabel('geometry', s.form) || '—'"
				>
					<template #tag><StatusBadge kind="sample" :value="s.current_status" /></template>
					<template #meta>Updated {{ formatDate(s.updated_at, '—') }}</template>
				</RecordCard>
			</div>
		</section>
	</Section>
</template>

<style scoped>
.link { color: var(--d1-accent, var(--theme--primary)); font-weight: 600; font-size: var(--fs-sm); text-decoration: none; white-space: nowrap; }
.link:hover { text-decoration: underline; }
.notice {
	margin: 0 0 10px; padding: 8px 12px; border-radius: 10px; font-size: var(--fs-sm);
	color: var(--theme--foreground);
	background: color-mix(in srgb, var(--theme--warning) 14%, var(--d1-surface));
	border: 1px solid var(--theme--warning);
}
.notice a { color: var(--d1-accent, var(--theme--primary)); font-weight: 600; }
.group + .group { margin-top: 14px; }
.group header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 6px; }
.group h3 { margin: 0; font-size: var(--fs-sm); font-weight: 650; color: var(--d1-dim); text-transform: uppercase; letter-spacing: 0.04em; }
.n { margin-left: 4px; font-variant-numeric: tabular-nums; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px; }
.cap-note { font-size: var(--fs-xs); color: var(--d1-dim); white-space: nowrap; }
</style>
