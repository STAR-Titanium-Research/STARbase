<script setup lang="ts">
import ExplorerView from '../ExplorerView.vue';
import { computed, ref, toRef } from 'vue';
import { useRouter } from 'vue-router';
import {
	AppLink, openLink, EditDrawer, HiddenLink, useCanUpdate, LoadState, NotVisible, PageShell, RecordLayout, RecordLink, RecordRail, StatusBadge, asRecord,
	dataStudioRoute, detailFacts, detailsCount, formatDate, summaryCount, summaryGroups, testDetailBase, testRailFacts, testSample, testSubjectCount, testTypeText,
	type ContentsEntry,
} from '@d1/ui';
import { useTestData } from './test/useTestData';
import TestSubjects from './test/TestSubjects.vue';
import TestResults from './test/TestResults.vue';
import RecordDetails from './record/RecordDetails.vue';
import SampleFiles from './sample/SampleFiles.vue';

// Test page: one test session with its parameters, what it was run on, the results the analysis
// workers wrote, and its files. Design: docs/superpowers/specs/2026-10-06-explorer-pages-design.md
// ("Test session"), laid out as a rail and panels by
// docs/superpowers/specs/2026-10-09-explorer-rail-layout-design.md.
const props = defineProps<{ id: string }>();
const router = useRouter();

const { test, loading, notVisible, error, params, subjects, files, hidden, reload } = useTestData(toRef(props, 'id'));

const editing = ref(false);
// Edit is offered unless the server says this user may not change the record (an investigator
// or a reader through a sample may read it but not edit it).
const { canUpdate, refresh: refreshCanUpdate } = useCanUpdate('test_sessions', toRef(props, 'id'));
// A save can change who may edit the record (the Owner field), so ask again.
function onSaved() {
	reload();
	refreshCanUpdate();
}

const t = computed(() => test.value);
const typeText = computed(() => testTypeText(t.value));
const pageTitle = computed(() => `${typeText.value} · ${formatDate(t.value?.session_date, 'Undated')}`);
const studioTo = computed(() => dataStudioRoute('test_sessions', props.id));
const project = computed(() => asRecord(t.value?.project_id));
const campaign = computed(() => asRecord(t.value?.campaign_id));
// The sample for the breadcrumb: the single-sample column, else the first sample subject.
const sample = computed(() => testSample(t.value, subjects.value.data));

// The rail's key facts, and the Details panel: the test's own values and its parameters, minus what
// the rail already shows.
const railFacts = computed(() => testRailFacts(t.value, subjects.value.data, hidden.value.data));
const details = computed(() => detailFacts(testDetailBase(t.value), params.value.data, railFacts.value));

// "On this page": the panels this test has, in page order. A count is null while it loads.
const contents = computed<ContentsEntry[]>(() => {
	const x = t.value;
	if (!x) return [];
	const groups = summaryGroups(x.summary_stats);
	return [
		{ id: 'details', title: 'Details', count: detailsCount(details.value.length, !!x.notes, params.value.loading, params.value.error) },
		{
			id: 'subject',
			title: 'Subject',
			count: subjects.value.loading || subjects.value.error ? null : testSubjectCount(x.sample_id, subjects.value.data, !!hidden.value.data.sample_id),
		},
		{ id: 'results', title: 'Results', count: groups.length ? summaryCount(groups) || null : 0 },
		{ id: 'files', title: 'Files', count: files.value.loading ? null : files.value.data.length },
	];
});

const openReport = () => openLink(`/d1-report/test/${encodeURIComponent(props.id)}`, router);
</script>

<template>
	<ExplorerView :title="pageTitle">
		<PageShell>
			<LoadState v-if="loading && !t" loading loading-text="Loading test…" />

			<NotVisible v-else-if="notVisible" what="test session" />

			<LoadState v-else-if="error" :error="error" />

			<template v-else-if="t">
				<!-- 70px: the Data Studio's header bar is 54px, plus a 16px gap. -->
				<RecordLayout style="--d1-sticky-top: var(--d1-header-offset, 70px)">
					<template #crumbs>
						<AppLink to="/home">Home</AppLink>
						<template v-if="project">
							<span>›</span>
							<RecordLink collection="projects" :id="project.project_id">Project {{ project.project_code }}</RecordLink>
						</template>
						<template v-else-if="hidden.data.project_id">
							<span>›</span><HiddenLink label="Project" />
						</template>
						<template v-if="campaign">
							<span>›</span>
							<RecordLink collection="campaigns" :id="campaign.campaign_id">{{ campaign.campaign_code ? `Campaign ${campaign.campaign_code}` : campaign.name || 'Campaign' }}</RecordLink>
						</template>
						<template v-else-if="hidden.data.campaign_id">
							<span>›</span><HiddenLink label="Campaign" />
						</template>
						<template v-if="sample">
							<span>›</span>
							<RecordLink collection="physical_samples" :id="sample.sample_id">{{ sample.sample_code ? `Sample ${sample.sample_code}` : 'Sample' }}</RecordLink>
						</template>
						<template v-else-if="hidden.data.sample_id || subjects.data.hidden">
							<span>›</span><HiddenLink label="Sample" />
						</template>
					</template>

					<template #rail>
						<RecordRail kind="Test" :code="typeText" :facts="railFacts" :contents="contents">
							<template #kind-icon><v-icon name="biotech" x-small /></template>
							<template #status><StatusBadge kind="test" :value="t.status" /></template>
							<template #actions>
								<v-button v-if="canUpdate !== false" small @click="editing = true"><v-icon name="edit" small left />Edit</v-button>
								<v-button small secondary @click="openReport"><v-icon name="picture_as_pdf" small left />Report</v-button>
								<v-button small secondary :to="studioTo"><v-icon name="open_in_new" small left />Data Studio</v-button>
							</template>
						</RecordRail>
					</template>

					<RecordDetails
						:facts="details"
						:notes="t.notes"
						:params-loading="params.loading"
						:params-error="params.error"
						:empty-text="t.test_type ? 'No details or parameters recorded for this test.' : 'No details recorded, and no test type, so no parameter set applies.'"
					/>

					<!-- The wrapper carries the id, so "On this page" has a target while the subjects load or fail. -->
					<div id="subject" class="subject-slot">
						<LoadState v-if="subjects.loading || subjects.error" :loading="subjects.loading" :error="subjects.error" />
						<TestSubjects v-else :sample="t.sample_id" :subjects="subjects.data" :sample-hidden="!!hidden.data.sample_id" />
					</div>

					<TestResults id="results" :stats="t.summary_stats" :status="t.status" />

					<SampleFiles
						id="files"
						:files="files.data"
						:loading="files.loading"
						:error="files.error"
						empty-text="No files linked to this test."
					/>
				</RecordLayout>

				<EditDrawer
					v-model="editing"
					collection="test_sessions"
					:primary-key="id"
					:title="`Edit ${typeText}`"
					@saved="onSaved"
				/>
			</template>
		</PageShell>
	</ExplorerView>
</template>

<style scoped>
/* Scroll under the page's sticky offset, like a Section (the wrapper is the target while loading). */
.subject-slot { min-width: 0; scroll-margin-top: calc(var(--d1-sticky-top, 0px) + 8px); }
</style>
