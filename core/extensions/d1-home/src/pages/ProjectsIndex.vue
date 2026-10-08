<script setup lang="ts">
import { computed, ref } from 'vue';
import { useStores } from '@directus/extensions-sdk';
import { LoadState, filterProjects, projectRole, type RoleFilter, type StatusFilter } from '@d1/ui';
import { PROJECT_CAP, useProjectsIndex } from './projects/useProjectsIndex';
import ProjectCard from './projects/ProjectCard.vue';

// Projects index: every project the signed-in user can read, as cards with the people, dates,
// counts and a sparkline of operations and tests per week. Design:
// docs/superpowers/specs/2026-10-06-explorer-pages-design.md ("Projects index").
const { useUserStore } = useStores();
const userId = computed<string | null>(() => (useUserStore().currentUser as any)?.id ?? null);

const { projects, loading, error, campaignCounts, sampleCounts, campaignCountsError, sampleCountsError, activity, activityError, truncated, rolesError } =
	useProjectsIndex();

const role = ref<RoleFilter>('all');
const status = ref<StatusFilter>('all');
const query = ref('');

const visible = computed(() =>
	filterProjects(projects.value, { role: role.value, status: status.value, query: query.value }, userId.value),
);
const countOrNull = (m: Map<string, number>, failed: string, id: string) => (failed ? null : (m.get(id) ?? 0));

const roleOptions: { value: RoleFilter; label: string }[] = [
	{ value: 'all', label: 'All projects I can see' },
	{ value: 'any', label: 'I am PI or investigator' },
	{ value: 'pi', label: 'I am PI' },
	{ value: 'investigator', label: 'I am investigator' },
];
const statusOptions: { value: StatusFilter; label: string }[] = [
	{ value: 'all', label: 'Any status' },
	{ value: 'active', label: 'Active' },
	{ value: 'inactive', label: 'Inactive' },
];
</script>

<template>
	<private-view title="Projects">
		<div class="projects-page">
			<nav class="crumbs"><router-link to="/home">Home</router-link><span>›</span><span>Projects</span></nav>

			<div class="filters">
				<label class="field search">
					<span>Search</span>
					<input v-model="query" type="search" placeholder="Code or name" aria-label="Search projects by code or name" />
				</label>
				<label class="field">
					<span>My role</span>
					<select v-model="role" aria-label="Filter by my role">
						<option v-for="o in roleOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
					</select>
				</label>
				<label class="field">
					<span>Status</span>
					<select v-model="status" aria-label="Filter by status">
						<option v-for="o in statusOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
					</select>
				</label>
				<v-button small secondary to="/content/projects/+"><v-icon name="add" small left />New project</v-button>
			</div>

			<LoadState v-if="loading && !projects.length" loading loading-text="Loading projects…" />
			<LoadState v-else-if="error" :error="error" />
			<LoadState
				v-else-if="!projects.length"
				empty
				empty-text="No projects visible to you yet. If you expected some, you may not have been added as PI or investigator."
			/>
			<template v-else>
				<p class="summary">
					Showing {{ visible.length }} of {{ projects.length }} projects you can see.
					<span v-if="projects.length >= PROJECT_CAP">Only the first {{ PROJECT_CAP }} are loaded.</span>
				</p>
				<p v-if="role !== 'all' && !userId" class="note">Your user could not be identified, so role filters match nothing.</p>
				<p v-if="campaignCountsError" class="note" role="alert">{{ campaignCountsError }}</p>
				<p v-if="sampleCountsError" class="note" role="alert">{{ sampleCountsError }}</p>
				<p v-if="activityError" class="note" role="alert">{{ activityError }}</p>
				<p v-if="rolesError" class="note" role="alert">{{ rolesError }}</p>
				<p v-if="truncated" class="note">The activity charts are based on the newest records only (the lab has more than the page loads).</p>
				<LoadState v-if="!visible.length" empty empty-text="No project matches these filters." />
				<div v-else class="grid">
					<ProjectCard
						v-for="p in visible"
						:key="p.project_id"
						:project="p"
						:role="projectRole(p, userId)"
						:campaigns="countOrNull(campaignCounts, campaignCountsError, p.project_id)"
						:samples="countOrNull(sampleCounts, sampleCountsError, p.project_id)"
						:activity="activity.get(p.project_id) ?? null"
					/>
				</div>
			</template>
		</div>
	</private-view>
</template>

<style scoped>
.projects-page {
	max-width: 1180px;
	margin: 0 auto;
	padding: 24px 32px 64px;
	font-family: var(--theme--fonts--sans--font-family, -apple-system, 'Segoe UI', Roboto, sans-serif);
	color: var(--theme--foreground);
}
.crumbs { display: flex; gap: 6px; font-size: 13px; color: var(--theme--foreground-subdued); margin-bottom: 14px; }
.crumbs a { color: var(--theme--primary); text-decoration: none; font-weight: 600; }
.filters { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 12px 16px; margin-bottom: 14px; }
.field { display: flex; flex-direction: column; gap: 3px; font-size: 11.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--theme--foreground-subdued); }
.field.search { flex: 1 1 220px; max-width: 360px; }
.field input, .field select {
	font: inherit; font-size: 14px; text-transform: none; letter-spacing: 0; font-weight: 400;
	height: 36px; padding: 0 10px; border-radius: 8px;
	border: 1px solid var(--theme--form--field--input--border-color, var(--theme--border-color));
	background: var(--theme--form--field--input--background, var(--theme--background));
	color: var(--theme--foreground);
}
.summary { margin: 0 0 8px; font-size: 13px; color: var(--theme--foreground-subdued); }
.note { margin: 0 0 8px; font-size: 12.5px; color: var(--theme--warning); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; margin-top: 8px; }
</style>
