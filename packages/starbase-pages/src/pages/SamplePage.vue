<script setup lang="ts">
import RecordActions from './RecordActions.vue';
import ExplorerView from '../ExplorerView.vue';
import { computed, ref, toRef } from 'vue';
import { useRouter } from 'vue-router';
import {
	AppLink, openLink, AccessDialog, EditDrawer, HIDDEN_CAMPAIGNS_LABEL, HiddenLink, useCanUpdate, LIST_CAP, LoadState, NotVisible, PageShell, RecordLayout, RecordLink, RecordRail, RecordViewRail, Section, StatusBadge,
	buildLife, dataStudioRoute, detailFacts, sampleCampaigns, sampleDetailBase, sampleDims, sampleKind, sampleRailFacts, truncatedNotes,
	type ContentsEntry,
	pinTargetForRecord, providePagePin, provideRecordView,
	mapPath,
} from '@d1/ui';
import { dimsText } from '../geometry';
import { useSampleData } from './sample/useSampleData';
import SampleGeometry from './sample/SampleGeometry.vue';
import SampleDetails from './sample/SampleDetails.vue';
import LifeStrip from './sample/LifeStrip.vue';
import SampleRecords from './sample/SampleRecords.vue';
import SampleFiles from './sample/SampleFiles.vue';

// Sample page: everything about one physical sample on one screen, with every related record a
// link to its own page. Design: docs/superpowers/specs/2026-10-06-explorer-pages-design.md, laid out
// as a rail (with the drawing in it) and panels by docs/superpowers/specs/2026-10-09-explorer-rail-layout-design.md.
const props = defineProps<{ id: string }>();
const router = useRouter();

const { sample, loading, notVisible, error, elements, campaigns, operations, tests, files, trace, hidden, reload } =
	useSampleData(toRef(props, 'id'));

const editing = ref(false);
// "Who has access": the dialog of the record's owner list; a change can alter who may edit (a transfer), so it ends like a save.
const access = ref(false);
// Edit is offered unless the server says this user may not change the record (an investigator
// or a reader through a sample may read it but not edit it).
const { canUpdate, refresh: refreshCanUpdate } = useCanUpdate('physical_samples', toRef(props, 'id'));
// A save can change who may edit the record (the Owner field), so ask again.
function onSaved() {
	reload();
	refreshCanUpdate();
}

const code = computed(() => sample.value?.sample_code ?? 'Sample');
// The header bar names the kind of record too: a bare code ("10") says nothing on its own.
const pageTitle = computed(() => (sample.value?.sample_code ? `Sample ${sample.value.sample_code}` : 'Sample'));
const studioTo = computed(() => dataStudioRoute('physical_samples', props.id));
const life = computed(() => (trace.value.data ? buildLife(trace.value.data) : []));
const notes = computed(() => (trace.value.data ? truncatedNotes(trace.value.data) : []));

const dims = computed(() => sampleDims(sample.value));
// The rail's key facts, and the details panel: the sample's remaining values, minus what the rail shows.
const railFacts = computed(() => sampleRailFacts(sample.value, dimsText(dims.value), campaigns.value.data, hidden.value.data));
const details = computed(() => detailFacts(sampleDetailBase(sample.value), [], railFacts.value));
// The breadcrumb: the project, then each campaign the user may read.
const project = computed(() => sample.value?.project_id);
const campaignRows = computed(() => sampleCampaigns(campaigns.value.data));

// "On this page": the panels this sample has, in page order. A count is null while it loads, and for
// panels with no count of their own (the material and the life strip).
const contents = computed<ContentsEntry[]>(() => [
	{ id: 'details', title: 'Material and details', count: null },
	{ id: 'life', title: 'Life of the sample', count: null },
	{ id: 'operations', title: 'Operations', count: operations.value.loading ? null : Math.min(operations.value.data.length, LIST_CAP) },
	{ id: 'tests', title: 'Tests', count: tests.value.loading ? null : Math.min(tests.value.data.length, LIST_CAP) },
	{ id: 'files', title: 'Files', count: files.value.loading ? null : files.value.data.length },
]);

// The report is an endpoint page (printable HTML), not an app route: open it in a new tab, same session.
// Print label is an app page: the labels page, with this sample preselected.
const labelsTo = computed(() => `/home/labels?ids=${encodeURIComponent(props.id)}`);
const openReportPage = () => openLink(`/d1-report/sample/${encodeURIComponent(props.id)}`, router);

// The Process map, opened on this record.
const mapTo = computed(() => mapPath('physical_samples', props.id));
const pin = computed(() => pinTargetForRecord('physical_samples', props.id));
// The Pin button sits after the title, in the host frame (DESIGN.md "Pin on the title").
providePagePin(pin);
// The View rail's settings (panels, table density, empty sections), one set for every sample page on this device.
provideRecordView('sample');
</script>

<template>
	<ExplorerView :title="pageTitle">
		<PageShell>
			<LoadState v-if="loading && !sample" loading loading-text="Loading sample…" />

			<NotVisible v-else-if="notVisible" what="sample" />

			<LoadState v-else-if="error" :error="error" />

			<template v-else-if="sample">
				<!-- 70px: the Data Studio's header bar is 54px, plus a 16px gap. -->
				<RecordLayout style="--d1-sticky-top: var(--d1-header-offset, 70px)">
					<template #crumbs>
						<AppLink to="/home">Home</AppLink>
						<template v-if="project?.project_id">
							<span>›</span>
							<RecordLink collection="projects" :id="project.project_id">Project {{ project.project_code }}</RecordLink>
						</template>
						<template v-else-if="hidden.data.project_id">
							<span>›</span><HiddenLink label="Project" />
						</template>
						<template v-for="c in campaignRows.campaigns" :key="c.campaign_id">
							<span>›</span>
							<RecordLink collection="campaigns" :id="c.campaign_id">{{ c.campaign_code ? `Campaign ${c.campaign_code}` : c.name || 'Campaign' }}</RecordLink>
						</template>
						<template v-if="campaignRows.hidden > 0">
							<span>›</span><HiddenLink :label="HIDDEN_CAMPAIGNS_LABEL" />
						</template>
					</template>

					<template #rail>
						<RecordRail :kind="sampleKind(sample)" :code="code" :title="sample.nickname" :facts="railFacts" :contents="contents">
							<template #kind-icon><v-icon name="science" x-small /></template>
							<template #status>
								<StatusBadge kind="sample" :value="sample.current_status" />
								<span v-if="sample.export_controlled" class="export">Export controlled</span>
							</template>
							<template #actions>
								<RecordActions :can-update="canUpdate" :studio-to="studioTo" @edit="editing = true" @access="access = true">
									<v-button icon small secondary :to="labelsTo" title="Print label" aria-label="Print label"><v-icon name="label" small /><span class="sr-only">Print label</span></v-button>
									<v-button icon small secondary :to="mapTo" title="Process map" aria-label="Process map"><v-icon name="account_tree" small /><span class="sr-only">Process map</span></v-button>
									<v-button icon small secondary @click="openReportPage" title="Report" aria-label="Report"><v-icon name="picture_as_pdf" small /><span class="sr-only">Report</span></v-button>
								</RecordActions>
							</template>
							<template #extra><SampleGeometry :dims="dims" /></template>
						</RecordRail>
					</template>

					<template #view><RecordViewRail kind="sample" /></template>

					<SampleDetails
						:sample="sample"
						:facts="details"
						:elements="elements.data"
						:elements-loading="elements.loading"
						:elements-error="elements.error"
					/>

					<Section id="life" title="Life of the sample">
						<LoadState :loading="trace.loading" :error="trace.error">
							<LifeStrip :items="life" />
							<p v-for="n in notes" :key="n" class="d1-note warn note">{{ n }}</p>
						</LoadState>
					</Section>

					<SampleRecords :operations="operations" :tests="tests" :sample-code="sample.sample_code" />
					<SampleFiles id="files" :files="files.data" :loading="files.loading" :error="files.error" />
				</RecordLayout>

				<AccessDialog v-model="access" collection="physical_samples" :id="id" :title="pageTitle" @changed="onSaved" />
				<EditDrawer
					v-model="editing"
					collection="physical_samples"
					:primary-key="id"
					:title="`Edit ${code}`"
					@saved="onSaved"
				/>
			</template>
		</PageShell>
	</ExplorerView>
</template>

<style scoped>
.export { color: var(--d1-bad); font-weight: 650; font-size: var(--fs-md); }
.note { margin-top: 8px; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; margin: -1px; padding: 0; border: 0; }
</style>
