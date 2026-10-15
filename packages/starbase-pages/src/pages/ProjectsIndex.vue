<script setup lang="ts">
import ExplorerView from '../ExplorerView.vue';
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { AppLink, LoadState, useExplorerHost, PageShell, PinToggle, canonicalPath, filterProjects, useTeamRecordFilter, pinTargetForIndex, projectRole, type RoleFilter, type StatusFilter } from '@d1/ui';
import { PROJECT_CAP, useProjectsIndex } from './projects/useProjectsIndex';
import ProjectCard from './projects/ProjectCard.vue';

// Projects index: every project the signed-in user can read, as cards with the people, dates,
// counts and a sparkline of operations and tests per week. Design:
// docs/superpowers/specs/2026-10-06-explorer-pages-design.md ("Projects index").
const host = useExplorerHost();
const route = useRoute();
const router = useRouter();
// The header's Pin toggle: this page (a bespoke page, not IndexPage, so it asks for its own).
const pinTarget = computed(() => pinTargetForIndex(canonicalPath(route.path), null));
const userId = computed<string | null>(() => host.user.value?.id ?? null);

const { projects, loading, error, campaignCounts, sampleCounts, campaignCountsError, sampleCountsError, activity, activityError, truncated, rolesError } =
	useProjectsIndex();

const role = ref<RoleFilter>('all');
const status = ref<StatusFilter>('all');
const query = ref('');
// Team: the projects a team has a grant on, that you can read (a project is never owned by a team). In the URL as f.team.
const teamFilter = useTeamRecordFilter(host, 'projects', route, router);

const visible = computed(() =>
	filterProjects(projects.value, { role: role.value, status: status.value, query: query.value, teamIds: teamFilter.team.value ? teamFilter.ids.value : null }, userId.value),
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
	<ExplorerView title="Projects">
		<PageShell>
			<nav class="d1-crumbs"><AppLink to="/home">Home</AppLink><span>›</span><span>Projects</span></nav>

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
				<label class="field">
					<span>Team</span>
					<select :value="teamFilter.team.value" aria-label="Filter by team" @change="teamFilter.setTeam(($event.target as HTMLSelectElement).value)">
						<option value="">Any team</option>
						<option v-for="t in teamFilter.teams.value" :key="t.value" :value="t.value">{{ t.label }}</option>
					</select>
				</label>
				<span class="spacer" />
				<PinToggle v-if="pinTarget" :target="pinTarget" label="Projects" />
				<v-button v-if="!host.canViewAllAccess?.value" small secondary to="/content/projects/+"><v-icon name="add" small left />New project</v-button>
			</div>

			<LoadState v-if="loading && !projects.length" loading loading-text="Loading projects…" />
			<LoadState v-else-if="error" :error="error" />
			<LoadState
				v-else-if="!projects.length"
				empty
				empty-text="No projects visible to you yet. If you expected some, you may not have been added as PI or investigator."
			/>
			<template v-else>
				<p v-if="!teamFilter.loading.value" class="d1-note">
					Showing {{ visible.length }} of {{ projects.length }} projects you can see.
					<span v-if="projects.length >= PROJECT_CAP">Only the first {{ PROJECT_CAP }} are loaded.</span>
				</p>
				<p v-if="teamFilter.note.value" class="d1-note" role="status">{{ teamFilter.note.value }}</p>
				<p v-if="teamFilter.error.value" class="d1-note warn" role="alert">{{ teamFilter.error.value }}</p>
				<p v-if="role !== 'all' && !userId" class="d1-note warn">Your user could not be identified, so role filters match nothing.</p>
				<p v-if="campaignCountsError" class="d1-note warn" role="alert">{{ campaignCountsError }}</p>
				<p v-if="sampleCountsError" class="d1-note warn" role="alert">{{ sampleCountsError }}</p>
				<p v-if="activityError" class="d1-note warn" role="alert">{{ activityError }}</p>
				<p v-if="rolesError" class="d1-note warn" role="alert">{{ rolesError }}</p>
				<p v-if="truncated" class="d1-note warn">The activity charts are based on the newest records only (the lab has more than the page loads).</p>
				<!-- A chosen team's ids are still loading: nothing is known to match yet, so say loading, not "no match". -->
				<LoadState v-if="teamFilter.loading.value" loading loading-text="Loading this team's projects…" />
				<!-- A failed ids call already shows its alert above: no "No project matches" and no cards beside it. -->
				<LoadState v-else-if="!visible.length && !teamFilter.error.value" empty empty-text="No project matches these filters." />
				<div v-else-if="visible.length" class="grid">
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
		</PageShell>
	</ExplorerView>
</template>

<style scoped>
/* The filter bar is a panel of its own: the controls belong together and sit apart from the cards. */
.filters {
	display: flex; flex-wrap: wrap; align-items: flex-end; gap: 10px 14px; padding: 10px 14px;
	background: var(--d1-surface); border: 1px solid var(--d1-line); border-radius: var(--d1-radius); box-shadow: var(--d1-shadow);
}
.field { display: flex; flex-direction: column; gap: 3px; font-size: var(--fs-xs); font-weight: 600; letter-spacing: 0.01em; color: var(--d1-dim); }
.field.search { flex: 1 1 220px; max-width: 360px; }
.field input, .field select {
	font: inherit; font-size: var(--fs-md); letter-spacing: 0; font-weight: 400;
	height: 34px; padding: 0 10px; border-radius: 8px;
	border: 1px solid var(--theme--form--field--input--border-color, var(--theme--border-color));
	background: var(--theme--form--field--input--background, var(--theme--background));
	color: var(--theme--foreground);
}
.field input:focus, .field select:focus { outline: none; border-color: var(--d1-accent, var(--theme--primary)); }
.spacer { flex: 1; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }
</style>
