<script setup lang="ts">
import ExplorerView from '../ExplorerView.vue';
import { computed, ref, toRef, watch } from 'vue';
import {
	AppLink, AccessDialog, RecordLink, EditDrawer, useCanUpdate, LoadState, NotVisible, PageShell, Section, dataStudioRoute,
	TIMELINE_RANGE_KEY, parseTimelineRange, pinTargetForRecord, mapPath, type TimelineRange,
} from '@d1/ui';
import { useProjectData } from './projects/useProjectData';
import ProjectHero from './projects/ProjectHero.vue';
import CampaignCards from './projects/CampaignCards.vue';
import UnassignedLists from './projects/UnassignedLists.vue';

// Project page: a hero (what the project is, who is on it, how far it has got: head, people, timeline, about, totals), then the
// campaigns as raised cards on the ground, then what is not in a campaign and the equipment used. It has no record rail: the hero
// takes its place. Design: docs/superpowers/specs/2026-10-20-project-page-hero-design.md (it supersedes the Project row of
// 2026-10-09-explorer-rail-layout-design.md); the read-only facts behind it are 2026-10-06-explorer-pages-design.md ("Project").
// There is no "Report" action yet: d1-report has sample, operation and test reports only. Add one
// here when it grows a project report.
const props = defineProps<{ id: string }>();

const {
	project, loading, notVisible, error, counts, campaigns, looseSamples, looseOperations,
	looseTests, activity, planned, equipment, access, reloadProject, reloadAccess,
} = useProjectData(toRef(props, 'id'));

const editing = ref(false);
// "Who has access": the dialog of the record's owner list, opened from the hero's people row.
const accessOpen = ref(false);
// Edit is offered unless the server says this user may not change the record (an investigator
// or a reader through a sample may read it but not edit it).
const { canUpdate, refresh: refreshCanUpdate } = useCanUpdate('projects', toRef(props, 'id'));
// A save changes the project row, and can change who may edit the record (the Owner field) and who has access, so ask again.
// The other sections read other records and do not depend on the edit.
function onSaved() {
	reloadProject();
	reloadAccess();
	refreshCanUpdate();
}
// A change in the dialog (someone added or removed, a transfer) changes the people row and may change who may edit; nothing else on the page.
function onAccessChanged() {
	reloadAccess();
	refreshCanUpdate();
}
const code = computed(() => project.value?.project_code ?? 'Project');
const studioTo = computed(() => dataStudioRoute('projects', props.id));

// The timeline's range is remembered per device. Storage can be missing or throw (a private window, blocked site data): then it is "All" and not saved.
function storedRange(): TimelineRange {
	try {
		return parseTimelineRange(localStorage.getItem(TIMELINE_RANGE_KEY));
	} catch {
		return 'all';
	}
}
const range = ref<TimelineRange>(storedRange());
watch(range, (value) => {
	try {
		localStorage.setItem(TIMELINE_RANGE_KEY, value);
	} catch {
		// Not remembered: the page works the same.
	}
});

// The Process map, opened on this record.
const mapTo = computed(() => mapPath('projects', props.id));
const pin = computed(() => pinTargetForRecord('projects', props.id));
</script>

<template>
	<ExplorerView :title="project?.project_code ? `Project ${project.project_code}` : 'Project'">
		<template #headline>
			<AppLink to="/home">Home</AppLink>
			<span>›</span>
			<AppLink to="/home/projects">Projects</AppLink>
		</template>

		<PageShell wide>
			<LoadState v-if="loading && !project" loading loading-text="Loading project…" />

			<NotVisible v-else-if="notVisible" what="project" />

			<LoadState v-else-if="error" :error="error" />

			<template v-else-if="project">
				<!-- The `page` container: the hero's layout follows this width, not the window's (the Data Studio sidebar takes some of it). -->
				<div class="project-page">
					<ProjectHero
						v-model:range="range"
						:project="project"
						:can-update="canUpdate"
						:studio-to="studioTo"
						:map-to="mapTo"
						:pin="pin"
						:access="access"
						:counts="counts"
						:campaigns="campaigns"
						:activity="activity"
						:planned="planned"
						@edit="editing = true"
						@access="accessOpen = true"
					/>

					<CampaignCards :campaigns="campaigns" :project-id="id" />

					<!-- Short lists side by side: stacked, three empty ones took a third of the screen. -->
					<div class="d1-cols project-cols">
						<UnassignedLists :samples="looseSamples" :operations="looseOperations" :tests="looseTests" :project-id="id" />

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
				</div>

				<AccessDialog v-model="accessOpen" collection="projects" :id="id" :title="`Project ${code}`" @changed="onAccessChanged" />
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
.project-page { container: page / inline-size; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
/* Side by side while there is room, but a section with nothing in it is only its lid, so it takes the
   whole row (its one line of text does not wrap in half a column). Dense: the sections after it fill
   the gap it leaves in the row above. */
.project-cols { grid-auto-flow: row dense; }
.project-cols :deep(.d1-section.empty) { grid-column: 1 / -1; }
.equipment { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 8px; }
/* A card inside a panel is a tile (DESIGN.md section 2). */
.equipment li { display: flex; flex-direction: column; padding: 7px 10px; border-radius: 8px; background: var(--d1-tile); }
.e-name { font-weight: 650; font-size: var(--fs-md, 13px); }
.e-count { font-size: var(--fs-xs, 11px); font-weight: 600; color: var(--d1-dim); }
</style>
