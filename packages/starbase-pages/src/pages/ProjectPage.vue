<script setup lang="ts">
import RecordActions from './RecordActions.vue';
import ExplorerView from '../ExplorerView.vue';
import { computed, ref, toRef } from 'vue';
import {
	AppLink, AccessDialog, RecordLink, EditDrawer, useCanUpdate, LIST_CAP, LoadState, NotVisible, PageShell, RecordLayout, RecordRail, RecordViewRail, Section, Sparkline, activityPeriod, dataStudioRoute,
	projectContents, projectRailFacts, projectStatusLabel, type ContentsEntry,
	pinTargetForRecord, providePagePin, provideRecordView,
	mapPath,
} from '@d1/ui';
import { useProjectData } from './projects/useProjectData';
import CampaignCards from './projects/CampaignCards.vue';
import UnassignedLists from './projects/UnassignedLists.vue';

// Project page: a rail (identity, actions, dates, people, totals, contents) beside the description,
// campaigns as cards, what is not in a campaign, activity and the equipment used. Design:
// docs/superpowers/specs/2026-10-06-explorer-pages-design.md ("Project"), laid out as a rail and
// panels by docs/superpowers/specs/2026-10-09-explorer-rail-layout-design.md.
// There is no "Report" action yet: d1-report has sample, operation and test reports only. Add one
// here when it grows a project report.
const props = defineProps<{ id: string }>();

// The View rail's settings (panels, table density, empty sections, activity range), one set for every project page on this device.
const view = provideRecordView('project');
const {
	project, loading, notVisible, error, investigators, counts, campaigns, looseSamples, looseOperations,
	looseTests, activity, equipment, reload,
} = useProjectData(toRef(props, 'id'), toRef(view, 'range'));

const editing = ref(false);
// "Who has access": the dialog of the record's owner list; a change can alter who may edit (a transfer), so it ends like a save.
const access = ref(false);
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

// The rail's key facts: the old header line and the totals the stat tiles showed. The counts follow
// the project rule (projectScope.ts), so they are text here, not links (see record/projectFacts.ts).
const railFacts = computed(() => projectRailFacts(project.value, investigators.value.data, counts.value.data, counts.value.loading));

// Operations and tests in the activity window: null while loading, 0 when there is nothing to draw
// (then the panel is its lid only, and the contents list dims it, like the other empty panels).
const activityCount = computed(() => {
	const a = activity.value;
	if (a.loading) return null;
	return a.data.data ? a.data.data.totalOps + a.data.data.totalTests : 0;
});

// "On this page": the panels in page order. A count is null while its read loads.
const rows = (s: { loading: boolean; data: unknown[] }) => (s.loading ? null : Math.min(s.data.length, LIST_CAP));
const contents = computed<ContentsEntry[]>(() => projectContents({
	hasDescription: !!project.value?.description,
	campaigns: rows(campaigns.value),
	samples: rows(looseSamples.value),
	operations: rows(looseOperations.value),
	tests: rows(looseTests.value),
	activity: activityCount.value,
	equipment: equipment.value.loading ? null : equipment.value.data.length,
}));

// The Process map, opened on this record.
const mapTo = computed(() => mapPath('projects', props.id));
const pin = computed(() => pinTargetForRecord('projects', props.id));
// The Pin button sits after the title, in the host frame (DESIGN.md "Pin on the title").
providePagePin(pin);
</script>

<template>
	<ExplorerView :title="project?.project_code ? `Project ${project.project_code}` : 'Project'">
		<PageShell>
			<LoadState v-if="loading && !project" loading loading-text="Loading project…" />

			<NotVisible v-else-if="notVisible" what="project" />

			<LoadState v-else-if="error" :error="error" />

			<template v-else-if="project">
				<!-- 70px: the Data Studio's header bar is 54px, plus a 16px gap. -->
				<RecordLayout style="--d1-sticky-top: var(--d1-header-offset, 70px)">
					<template #crumbs>
						<AppLink to="/home">Home</AppLink>
						<span>›</span>
						<AppLink to="/home/projects">Projects</AppLink>
					</template>

					<template #rail>
						<RecordRail kind="Project" :code="code" :title="project.project_name" :facts="railFacts" :contents="contents">
							<template #kind-icon><v-icon name="folder_open" x-small /></template>
							<template #status>
								<span class="status" :class="{ active }">{{ projectStatusLabel(project.is_active) }}</span>
								<span v-if="project.export_controlled" class="export">Export controlled</span>
							</template>
							<template #actions>
								<RecordActions :can-update="canUpdate" :studio-to="studioTo" @edit="editing = true" @access="access = true">
									<v-button icon small secondary :to="mapTo" title="Process map" aria-label="Process map"><v-icon name="account_tree" small /><span class="sr-only">Process map</span></v-button>
								</RecordActions>
							</template>
							<template #after-facts>
								<p class="d1-note">Counts of the records you can see in this project.</p>
								<p v-if="investigators.error" class="d1-note warn" role="alert">{{ investigators.error }}</p>
								<p v-if="counts.error" class="d1-note warn" role="alert">{{ counts.error }}</p>
							</template>
						</RecordRail>
					</template>

					<template #view><RecordViewRail kind="project" range /></template>

					<Section v-if="project.description" id="description" title="Description"><p class="description">{{ project.description }}</p></Section>

					<CampaignCards :campaigns="campaigns" :project-id="id" />
					<!-- Three short lists side by side: stacked, three empty ones took a third of the screen. -->
					<div class="d1-cols project-cols">
						<UnassignedLists :samples="looseSamples" :operations="looseOperations" :tests="looseTests" :project-id="id" />
					</div>

					<div class="d1-cols project-cols">
						<Section
							id="activity"
							title="Activity"
							:count="activityCount"
							:empty="!activity.loading && !activity.error && activityCount === 0"
							:empty-text="`No operations or tests${activityPeriod(view.range)}.`"
						>
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
							id="equipment"
							title="Equipment used"
							:count="equipment.loading ? null : equipment.data.length"
							:empty="!equipment.loading && !equipment.error && !equipment.data.length"
							empty-text="No equipment recorded on this project's operations."
						>
							<LoadState :loading="equipment.loading" :error="equipment.error">
								<ul class="equipment">
									<li v-for="e in equipment.data" :key="e.equipment_id">
										<RecordLink collection="equipment" :id="e.equipment_id" class="e-name">{{ e.name }}</RecordLink>
										<span class="e-count">{{ e.operations }} operation{{ e.operations === 1 ? '' : 's' }}</span>
									</li>
								</ul>
							</LoadState>
						</Section>
					</div>
				</RecordLayout>

				<AccessDialog v-model="access" collection="projects" :id="id" :title="`Project ${code}`" @changed="onSaved" />
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
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; margin: -1px; padding: 0; border: 0; }
/* Side by side while there is room, but a section with nothing in it is only its lid, so it takes the
   whole row (its one line of text does not wrap in half a column). Dense: the sections after it fill
   the gap it leaves in the row above. */
.project-cols { grid-auto-flow: row dense; }
.project-cols :deep(.d1-section.empty) { grid-column: 1 / -1; }
.status {
	font-size: var(--fs-xs); font-weight: 700; padding: 1px 8px; border-radius: 99px;
	color: var(--d1-dim); background: var(--theme--background-normal);
}
.status.active { color: var(--d1-ok); background: color-mix(in srgb, var(--theme--success) 18%, transparent); }
.export { color: var(--d1-bad); font-weight: 650; font-size: var(--fs-md); }
.warn { color: var(--d1-warn); }
.d1-note { margin: 0; }
.description { margin: 0; max-width: 90ch; font-size: var(--fs-md); line-height: 1.55; color: var(--d1-dim); white-space: pre-line; }
.equipment { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 8px; }
.equipment li {
	display: flex; flex-direction: column; padding: 7px 10px; border-radius: 8px;
	border: 1px solid var(--d1-line); background: var(--d1-surface);
}
.e-name { font-weight: 650; font-size: var(--fs-md); }
.e-count { font-size: var(--fs-xs); font-weight: 600; color: var(--d1-dim); }
</style>
