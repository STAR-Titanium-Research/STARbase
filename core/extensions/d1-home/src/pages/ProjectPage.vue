<script setup lang="ts">
import ExplorerView from '../ExplorerView.vue';
import { computed, ref, toRef } from 'vue';
import {
	EditDrawer, useCanUpdate, LoadState, NotVisible, PageShell, RecordHeader, Section, Sparkline, StatTile, dataStudioRoute, formatDate, projectStatusLabel,
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
// Edit is offered unless the server says this user may not change the record (an investigator
// or a reader through a sample may read it but not edit it).
const { canUpdate, refresh: refreshCanUpdate } = useCanUpdate('projects', toRef(props, 'id'));
// A save can change who may edit the record (the Owner field), so ask again.
function onSaved() {
	reload();
	refreshCanUpdate();
}
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
	<ExplorerView :title="project?.project_code ? `Project ${project.project_code}` : 'Project'">
		<PageShell>
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
						<v-button v-if="canUpdate !== false" small @click="editing = true"><v-icon name="edit" small left />Edit</v-button>
						<v-button small secondary :to="studioTo"><v-icon name="open_in_new" small left />Data Studio</v-button>
					</template>
				</RecordHeader>

				<Section v-if="project.description" title="Description"><p class="description">{{ project.description }}</p></Section>

				<div class="totals">
					<div class="tiles" :aria-busy="tilesDisabled">
						<StatTile label="Samples" :value="num(counts.data.samples)" icon="science" />
						<StatTile label="Operations" :value="num(counts.data.operations)" icon="precision_manufacturing" />
						<StatTile label="Tests" :value="num(counts.data.tests)" icon="biotech" />
						<StatTile label="Campaigns" :value="num(counts.data.campaigns)" icon="flag" />
					</div>
					<p class="d1-note">Counts of the records you can see in this project.</p>
					<p v-if="counts.error" class="d1-note warn" role="alert">{{ counts.error }}</p>
				</div>

				<CampaignCards :campaigns="campaigns" :project-id="id" />
				<!-- Three short lists side by side: stacked, three empty ones took a third of the screen. -->
				<div class="d1-cols">
					<UnassignedLists :samples="looseSamples" :operations="looseOperations" :tests="looseTests" :project-id="id" />
				</div>

				<div class="d1-cols">
					<Section title="Activity">
						<LoadState :loading="activity.loading" :error="activity.error">
							<Sparkline
								v-if="activity.data.data"
								:ops="activity.data.data.ops"
								:tests="activity.data.data.tests"
								:weeks="activity.data.data.weeks"
								:width="640"
								:height="80"
							/>
							<p v-if="activity.data.truncated" class="d1-note warn">Based on the newest records only: the project has more than the page loads.</p>
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
				</div>

				<EditDrawer
					v-model="editing"
					collection="projects"
					:primary-key="id"
					:title="`Edit ${code}`"
					@saved="onSaved"
				/>
			</template>
		</PageShell>
	</ExplorerView>
</template>

<style scoped>
.status {
	font-size: var(--fs-xs); font-weight: 700; padding: 1px 8px; border-radius: 99px;
	color: var(--d1-dim); background: var(--theme--background-normal);
}
.status.active { color: var(--d1-ok); background: color-mix(in srgb, var(--theme--success) 18%, transparent); }
.export { color: var(--d1-bad); font-weight: 650; }
.warn { color: var(--d1-warn); }
.description { margin: 0; max-width: 90ch; font-size: var(--fs-md); line-height: 1.55; color: var(--d1-dim); white-space: pre-line; }
.totals { display: flex; flex-direction: column; gap: 6px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; }
.equipment { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 8px; }
.equipment li {
	display: flex; flex-direction: column; padding: 7px 10px; border-radius: 8px;
	border: 1px solid var(--d1-line); background: var(--d1-tile);
}
.e-name { font-weight: 650; font-size: var(--fs-md); }
.e-count { font-size: var(--fs-xs); font-weight: 600; color: var(--d1-dim); }
</style>
