<script setup lang="ts">
import { LoadState, Section, StatusBadge, campaignTypeLabel, formatDate, humanise, projectStatusLabel, recordRoute } from '@d1/ui';
import { CARD_LIMIT, SAMPLE_LIMIT, useMyWork } from './useMyWork';

// Projects where I am PI or investigator, campaigns I own and my newest samples, as cards. Every card is a link to its
// Explorer page; the header of each group links to the full list.
const { projects, campaigns, samples, hasPerson, partialProjects, partialSamples } = useMyWork();
</script>

<template>
	<section class="my-work" aria-labelledby="my-work-h">
		<div class="section-head">
			<h2 id="my-work-h">My work</h2>
			<router-link to="/home/projects" class="link">All projects you can see →</router-link>
		</div>

		<p v-if="hasPerson === false" class="notice" role="note">
			Your login is not linked to a person record, so samples and campaigns you own cannot be found.
			Ask an admin to link it on the <router-link to="/home/people">People</router-link> page. Projects where you are an
			investigator, and samples you co-own, still show.
		</p>

		<p v-if="partialProjects" class="notice" role="note">{{ partialProjects }}</p>
		<Section
			title="My projects (PI or investigator)"
			:count="projects.loading ? null : projects.data.length"
			:empty="!projects.loading && !projects.error && !projects.data.length"
			empty-text="You are not PI or investigator on any project."
		>
			<LoadState :loading="projects.loading" :error="projects.error">
				<div class="cards">
					<router-link v-for="p in projects.data" :key="p.project_id" :to="recordRoute('projects', p.project_id)" class="card">
						<span class="c-top">
							<span class="c-code">{{ p.project_code }}</span>
							<span class="c-tag">{{ projectStatusLabel(p.is_active) }}</span>
						</span>
						<span class="c-name">{{ p.project_name }}</span>
						<span class="c-meta">PI: {{ p.principal_investigator_person?.full_name || 'not set' }}</span>
					</router-link>
				</div>
				<p v-if="projects.data.length >= CARD_LIMIT" class="cap"><router-link to="/home/projects">See every project</router-link></p>
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
					<router-link v-for="c in campaigns.data" :key="c.campaign_id" :to="recordRoute('campaigns', c.campaign_id)" class="card">
						<span class="c-top">
							<span class="c-code">{{ c.campaign_code || c.name }}</span>
							<span class="c-tag">{{ campaignTypeLabel(c.campaign_type) }}</span>
						</span>
						<span v-if="c.campaign_code" class="c-name">{{ c.name }}</span>
						<span class="c-meta">
							<template v-if="c.project_id?.project_code">{{ c.project_id.project_code }}</template>
							<template v-if="c.status"> · {{ humanise(c.status) }}</template>
						</span>
					</router-link>
				</div>
			</LoadState>
		</Section>

		<p v-if="partialSamples" class="notice" role="note">{{ partialSamples }}</p>
		<Section
			title="My latest samples"
			:count="samples.loading ? null : samples.data.length"
			:empty="!samples.loading && !samples.error && !samples.data.length"
			empty-text="No samples are owned by you or co-owned with you yet."
		>
			<template #actions><span class="cap-note">newest {{ SAMPLE_LIMIT }} by last update</span></template>
			<LoadState :loading="samples.loading" :error="samples.error">
				<div class="cards">
					<router-link v-for="s in samples.data" :key="s.sample_id" :to="recordRoute('physical_samples', s.sample_id)" class="card">
						<span class="c-top">
							<span class="c-code">{{ s.sample_code }}</span>
							<StatusBadge kind="sample" :value="s.current_status" />
						</span>
						<span class="c-name">{{ s.material_id?.common_name || s.form || '—' }}</span>
						<span class="c-meta">Updated {{ formatDate(s.updated_at, '—') }}</span>
					</router-link>
				</div>
			</LoadState>
		</Section>
	</section>
</template>

<style scoped>
.section-head { display: flex; align-items: baseline; justify-content: space-between; margin-top: 8px; }
.section-head h2 { margin: 0; font-size: 18px; font-weight: 750; }
.link { color: var(--theme--primary); font-weight: 600; font-size: 13px; text-decoration: none; }
.link:hover { text-decoration: underline; }
.notice {
	margin: 10px 0 0; padding: 10px 14px; border-radius: 10px; font-size: 13px;
	color: var(--theme--foreground); background: var(--theme--warning-background);
	border: 1px solid var(--theme--warning);
}
.notice a { color: var(--theme--primary); font-weight: 600; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
.card {
	display: flex; flex-direction: column; gap: 4px; padding: 13px 15px; min-width: 0;
	border: 1px solid var(--theme--border-color-subdued); border-radius: 14px;
	background: var(--theme--background); color: var(--theme--foreground); text-decoration: none;
	transition: border-color 0.14s ease, box-shadow 0.14s ease;
}
.card:hover { border-color: var(--theme--primary); box-shadow: 0 10px 22px -16px rgba(15, 23, 42, 0.4); }
.c-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.c-code { font-family: var(--theme--fonts--monospace--font-family, monospace); font-weight: 700; font-size: 14px; overflow-wrap: anywhere; }
.c-tag { font-size: 11px; font-weight: 650; padding: 1px 9px; border-radius: 99px; color: var(--theme--foreground-subdued); background: var(--theme--background-normal); white-space: nowrap; }
.c-name { font-size: 13.5px; font-weight: 600; overflow-wrap: anywhere; }
.c-meta { font-size: 12.5px; color: var(--theme--foreground-subdued); }
.cap { margin: 8px 0 0; font-size: 12.5px; }
.cap a { color: var(--theme--primary); }
.cap-note { font-size: 12px; color: var(--theme--foreground-subdued); }
</style>
