<script setup lang="ts">
import { LoadState, RecordCard, Section, StatusBadge, campaignTypeLabel, formatDate, humanise, projectStatusLabel, recordRoute } from '@d1/ui';
import { CARD_LIMIT, SAMPLE_LIMIT, useMyWork } from './useMyWork';

// Projects where I am PI or investigator, campaigns I own and my newest samples, as cards. Every card is a link to its
// Explorer page; the header of each group links to the full list. The three groups sit side by
// side while there is room, so three empty groups are one row, not three.
const { projects, campaigns, samples, hasPerson, partialProjects, partialSamples } = useMyWork();
</script>

<template>
	<div class="my-work">
		<p v-if="hasPerson === false" class="notice" role="note">
			Your login is not linked to a person record, so samples and campaigns you own cannot be found.
			Ask an admin to link it on the <router-link to="/home/people">People</router-link> page. Projects where you are an
			investigator, and samples you co-own, still show.
		</p>
		<p v-if="partialProjects" class="notice" role="note">{{ partialProjects }}</p>
		<p v-if="partialSamples" class="notice" role="note">{{ partialSamples }}</p>

		<div class="d1-cols">
			<Section
				title="My projects (PI or investigator)"
				:count="projects.loading ? null : projects.data.length"
				:empty="!projects.loading && !projects.error && !projects.data.length"
				empty-text="You are not PI or investigator on any project."
			>
				<template #actions><router-link to="/home/projects" class="link" title="All projects you can see">All visible projects →</router-link></template>
				<LoadState :loading="projects.loading" :error="projects.error">
					<div class="cards">
						<RecordCard
							v-for="p in projects.data"
							:key="p.project_id"
							:to="recordRoute('projects', p.project_id)"
							:code="p.project_code"
							:name="p.project_name"
						>
							<template #tag><span class="d1-tag">{{ projectStatusLabel(p.is_active) }}</span></template>
							<template #meta>PI: {{ p.principal_investigator_person?.full_name || 'not set' }}</template>
						</RecordCard>
					</div>
					<p v-if="projects.data.length >= CARD_LIMIT" class="d1-note cap"><router-link to="/home/projects">See every project</router-link></p>
				</LoadState>
			</Section>

			<Section
				title="Campaigns I own"
				:count="campaigns.loading ? null : campaigns.data.length"
				:empty="!campaigns.loading && !campaigns.error && !campaigns.data.length"
				empty-text="You do not own any campaign."
			>
				<LoadState :loading="campaigns.loading" :error="campaigns.error">
					<div class="cards">
						<RecordCard
							v-for="c in campaigns.data"
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
				</LoadState>
			</Section>

			<Section
				title="My latest samples"
				:count="samples.loading ? null : samples.data.length"
				:empty="!samples.loading && !samples.error && !samples.data.length"
				empty-text="No samples are owned by you or co-owned with you yet."
			>
				<template #actions><span class="cap-note">newest {{ SAMPLE_LIMIT }} by last update</span></template>
				<LoadState :loading="samples.loading" :error="samples.error">
					<div class="cards">
						<RecordCard
							v-for="s in samples.data"
							:key="s.sample_id"
							:to="recordRoute('physical_samples', s.sample_id)"
							:code="s.sample_code"
							:name="s.material_id?.common_name || s.form || '—'"
						>
							<template #tag><StatusBadge kind="sample" :value="s.current_status" /></template>
							<template #meta>Updated {{ formatDate(s.updated_at, '—') }}</template>
						</RecordCard>
					</div>
				</LoadState>
			</Section>
		</div>
	</div>
</template>

<style scoped>
.my-work { display: flex; flex-direction: column; gap: 10px; }
.link { color: var(--d1-accent, var(--theme--primary)); font-weight: 600; font-size: var(--fs-sm); text-decoration: none; white-space: nowrap; }
.link:hover { text-decoration: underline; }
.notice {
	margin: 0; padding: 8px 12px; border-radius: 10px; font-size: var(--fs-sm);
	color: var(--theme--foreground);
	background: color-mix(in srgb, var(--theme--warning) 14%, var(--d1-surface));
	border: 1px solid var(--theme--warning);
}
.notice a { color: var(--d1-accent, var(--theme--primary)); font-weight: 600; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px; }
.cap { margin-top: 8px; }
.cap-note { font-size: var(--fs-xs); color: var(--d1-dim); white-space: nowrap; }
</style>
