<script setup lang="ts">
import { computed, ref, toRef } from 'vue';
import {
	EditDrawer, LoadState, NotVisible, RecordHeader, Section, Sparkline, StatTile, dataStudioRoute, formatDate, projectStatusLabel,
} from '@d1/ui';
import { useProjectData } from './projects/useProjectData';
import CampaignCards from './projects/CampaignCards.vue';
import UnassignedLists from './projects/UnassignedLists.vue';

// Project page: header, totals, campaigns as cards, what is not in a campaign, activity and the
// equipment used. Design: docs/superpowers/specs/2026-10-06-explorer-pages-design.md ("Project").
// There is no "Report" action yet: d1-report has sample, operation and test reports only. Add one
// here when it grows a project report.
const props = defineProps<{ id: string }>();

const {
	project, loading, notVisible, error, investigators, counts, campaigns, looseSamples, looseOperations,
	looseTests, activity, equipment, reload,
} = useProjectData(toRef(props, 'id'));

const editing = ref(false);
const code = computed(() => project.value?.project_code ?? 'Project');
const studioTo = computed(() => dataStudioRoute('projects', props.id));
const active = computed(() => project.value?.is_active !== false);
const dates = computed(() => {
	const a = formatDate(project.value?.start_date);
	const b = formatDate(project.value?.end_date);
	return a && b ? `${a} to ${b}` : a ? `From ${a}` : b ? `Until ${b}` : '';
});
const num = (n: number | null | undefined) => (n === null || n === undefined ? '–' : n.toLocaleString('en-GB'));
const tilesDisabled = computed(() => counts.value.loading);
</script>

<template>
	<private-view :title="code">
		<div class="project-page">
			<LoadState v-if="loading && !project" loading loading-text="Loading project…" />

			<NotVisible v-else-if="notVisible" what="project" />

			<LoadState v-else-if="error" :error="error" />

			<template v-else-if="project">
				<RecordHeader :code="code" :title="project.project_name" kind="Project" icon="folder_open">
					<template #crumbs>
						<router-link to="/home">Home</router-link>
						<span>›</span>
						<router-link to="/home/projects">Projects</router-link>
					</template>
					<template #status>
						<span class="status" :class="{ active }">{{ projectStatusLabel(project.is_active) }}</span>
					</template>
					<template #meta>
						<span v-if="dates">{{ dates }}</span>
						<span>PI: {{ project.principal_investigator_person?.full_name || 'not set' }}</span>
						<span v-if="investigators.data.length">Investigators: {{ investigators.data.join(', ') }}</span>
						<span v-else-if="investigators.error" class="warn">{{ investigators.error }}</span>
						<span v-if="project.document_number">Document: {{ project.document_number }}</span>
						<span v-if="project.export_controlled" class="export">Export controlled</span>
					</template>
					<template #actions>
						<v-button small @click="editing = true"><v-icon name="edit" small left />Edit</v-button>
						<v-button small secondary :to="studioTo"><v-icon name="open_in_new" small left />Data Studio</v-button>
					</template>
				</RecordHeader>

				<p v-if="project.description" class="description">{{ project.description }}</p>

				<div class="tiles" :aria-busy="tilesDisabled">
					<StatTile label="Samples" :value="num(counts.data.samples)" icon="science" />
					<StatTile label="Operations" :value="num(counts.data.operations)" icon="precision_manufacturing" />
					<StatTile label="Tests" :value="num(counts.data.tests)" icon="biotech" />
					<StatTile label="Campaigns" :value="num(counts.data.campaigns)" icon="flag" />
				</div>
				<p v-if="counts.error" class="warn" role="alert">{{ counts.error }}</p>

				<CampaignCards :campaigns="campaigns" />
				<UnassignedLists :samples="looseSamples" :operations="looseOperations" :tests="looseTests" />

				<Section title="Activity">
					<LoadState :loading="activity.loading" :error="activity.error">
						<Sparkline
							v-if="activity.data.data"
							:ops="activity.data.data.ops"
							:tests="activity.data.data.tests"
							:weeks="activity.data.data.weeks"
							:width="900"
							:height="70"
						/>
						<p v-if="activity.data.truncated" class="warn">Based on the newest records only: the project has more than the page loads.</p>
					</LoadState>
				</Section>

				<Section
					title="Equipment used"
					:count="equipment.loading ? null : equipment.data.length"
					:empty="!equipment.loading && !equipment.error && !equipment.data.length"
					empty-text="No equipment recorded on this project's operations."
				>
					<LoadState :loading="equipment.loading" :error="equipment.error">
						<ul class="equipment">
							<li v-for="e in equipment.data" :key="e.equipment_id">
								<span class="e-name">{{ e.name }}</span>
								<span class="e-count">{{ e.operations }} operation{{ e.operations === 1 ? '' : 's' }}</span>
							</li>
						</ul>
					</LoadState>
				</Section>

				<EditDrawer
					v-model="editing"
					collection="projects"
					:primary-key="id"
					:title="`Edit ${code}`"
					@saved="reload()"
				/>
			</template>
		</div>
	</private-view>
</template>

<style scoped>
.project-page {
	max-width: 1180px;
	margin: 0 auto;
	padding: 24px 32px 64px;
	font-family: var(--theme--fonts--sans--font-family, -apple-system, 'Segoe UI', Roboto, sans-serif);
	color: var(--theme--foreground);
}
.project-page :deep(.crumbs a) { color: var(--theme--primary); text-decoration: none; font-weight: 600; }
.project-page :deep(.crumbs a:hover) { text-decoration: underline; }
.status {
	font-size: 11.5px; font-weight: 650; padding: 1px 10px; border-radius: 99px;
	color: var(--theme--foreground-subdued); background: var(--theme--background-normal);
}
.status.active { color: var(--theme--success); background: var(--theme--success-background); }
.export { color: var(--theme--danger); font-weight: 650; }
.warn { color: var(--theme--warning); font-size: 12.5px; margin: 8px 0 0; }
.description { margin: 14px 0 0; font-size: 14px; color: var(--theme--foreground-subdued); white-space: pre-line; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 14px; margin-top: 20px; }
.equipment { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 8px; }
.equipment li {
	display: flex; flex-direction: column; padding: 8px 14px; border-radius: 12px;
	border: 1px solid var(--theme--border-color-subdued); background: var(--theme--background);
}
.e-name { font-weight: 650; font-size: 13.5px; }
.e-count { font-size: 12px; color: var(--theme--foreground-subdued); }
</style>
