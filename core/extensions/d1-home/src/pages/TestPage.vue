<script setup lang="ts">
import { computed, ref, toRef } from 'vue';
import {
	EditDrawer, HiddenLink, useCanUpdate, KeyValueGrid, LoadState, NotVisible, RecordHeader, RecordLink, Section, StatusBadge, asRecord,
	dataStudioRoute, formatDate, formatQuantity, humanise, type KeyValue,
} from '@d1/ui';
import { useTestData } from './test/useTestData';
import TestSubjects from './test/TestSubjects.vue';
import TestResults from './test/TestResults.vue';
import SampleFiles from './sample/SampleFiles.vue';

// Test page: one test session with its parameters, what it was run on, the results the analysis
// workers wrote, and its files. Design: docs/superpowers/specs/2026-10-06-explorer-pages-design.md
// ("Test session").
const props = defineProps<{ id: string }>();

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
const typeText = computed(() => (t.value?.test_type ? humanise(t.value.test_type) : 'Test'));
const dateText = computed(() => formatDate(t.value?.session_date, 'Undated'));
const pageTitle = computed(() => `${typeText.value} · ${dateText.value}`);
const studioTo = computed(() => dataStudioRoute('test_sessions', props.id));
const project = computed(() => asRecord(t.value?.project_id));
const campaign = computed(() => asRecord(t.value?.campaign_id));
// The sample for the breadcrumb: the single-sample column, else the first sample subject.
const sample = computed(() => asRecord(t.value?.sample_id) ?? subjects.value.data.samples[0] ?? null);
const operatorText = computed(() => asRecord(t.value?.operator_person_id)?.full_name || t.value?.operator_name || '');

const overview = computed<KeyValue[]>(() => {
	const x = t.value;
	if (!x) return [];
	return [
		{ label: 'Test type', value: typeText.value },
		{ label: 'Category', value: x.test_category ? humanise(x.test_category) : '' },
		{ label: 'Capture software', value: x.capture_software },
		{ label: 'Capture frequency', value: formatQuantity(x.capture_frequency_khz), unit: 'kHz' },
		{ label: 'Raw file size', value: formatQuantity(x.file_size_gb), unit: 'GB' },
		{ label: 'Raw file', value: x.file_storage_pointer, mono: true },
	];
});

const openReport = () => window.open(`/d1-report/test/${encodeURIComponent(props.id)}`, '_blank', 'noopener');
</script>

<template>
	<private-view :title="pageTitle">
		<div class="test-page">
			<LoadState v-if="loading && !t" loading loading-text="Loading test…" />

			<NotVisible v-else-if="notVisible" what="test session" />

			<LoadState v-else-if="error" :error="error" />

			<template v-else-if="t">
				<RecordHeader :code="typeText" :title="dateText" kind="Test" icon="biotech">
					<template #crumbs>
						<router-link to="/home">Home</router-link>
						<template v-if="project">
							<span>›</span>
							<RecordLink collection="projects" :id="project.project_id">{{ project.project_code }}</RecordLink>
						</template>
						<template v-else-if="hidden.data.project_id">
							<span>›</span><HiddenLink label="Project" />
						</template>
						<template v-if="campaign">
							<span>›</span>
							<RecordLink collection="campaigns" :id="campaign.campaign_id">{{ campaign.campaign_code || campaign.name || 'Campaign' }}</RecordLink>
						</template>
						<template v-else-if="hidden.data.campaign_id">
							<span>›</span><HiddenLink label="Campaign" />
						</template>
						<template v-if="sample">
							<span>›</span>
							<RecordLink collection="physical_samples" :id="sample.sample_id">{{ sample.sample_code || 'Sample' }}</RecordLink>
						</template>
						<template v-else-if="hidden.data.sample_id || subjects.data.hidden">
							<span>›</span><HiddenLink label="Sample" />
						</template>
					</template>
					<template #status><StatusBadge kind="test" :value="t.status" /></template>
					<template #meta>
						<span v-if="t.test_category">{{ humanise(t.test_category) }} test</span>
						<span v-if="asRecord(t.owner_person_id)">Owner: {{ asRecord(t.owner_person_id)!.full_name }}</span>
						<span v-if="operatorText">Operator: {{ operatorText }}</span>
						<span v-if="asRecord(t.equipment_id)">Machine: {{ asRecord(t.equipment_id)!.equipment_name }}</span>
					</template>
					<template #actions>
						<v-button v-if="canUpdate !== false" small @click="editing = true"><v-icon name="edit" small left />Edit</v-button>
						<v-button small secondary @click="openReport"><v-icon name="picture_as_pdf" small left />Report</v-button>
						<v-button small secondary :to="studioTo"><v-icon name="open_in_new" small left />Data Studio</v-button>
					</template>
				</RecordHeader>

				<Section title="Overview">
					<KeyValueGrid :items="overview" />
					<p v-if="t.notes" class="notes">{{ t.notes }}</p>
				</Section>

				<Section
					title="Parameters"
					:count="params.loading ? null : params.data.length || null"
					:empty="!params.loading && !params.error && !params.data.length"
					:empty-text="t.test_type ? 'No parameters recorded for this test.' : 'This test has no type, so no parameter set applies.'"
				>
					<LoadState :loading="params.loading" :error="params.error">
						<KeyValueGrid :items="params.data.map((p) => ({ label: p.label, value: p.value, unit: p.unit }))" />
					</LoadState>
				</Section>

				<LoadState v-if="subjects.loading || subjects.error" :loading="subjects.loading" :error="subjects.error" />
				<TestSubjects v-else :sample="t.sample_id" :subjects="subjects.data" :sample-hidden="!!hidden.data.sample_id" />

				<TestResults :stats="t.summary_stats" :status="t.status" />

				<SampleFiles
					:files="files.data"
					:loading="files.loading"
					:error="files.error"
					empty-text="No files linked to this test."
				/>

				<EditDrawer
					v-model="editing"
					collection="test_sessions"
					:primary-key="id"
					:title="`Edit ${typeText}`"
					@saved="onSaved"
				/>
			</template>
		</div>
	</private-view>
</template>

<style scoped>
.test-page {
	max-width: 1180px;
	margin: 0 auto;
	padding: 24px 32px 64px;
	font-family: var(--theme--fonts--sans--font-family, -apple-system, 'Segoe UI', Roboto, sans-serif);
	color: var(--theme--foreground);
}
.test-page :deep(.crumbs a) { color: var(--theme--primary); text-decoration: none; font-weight: 600; }
.test-page :deep(.crumbs a:hover) { text-decoration: underline; }
.notes { margin: 14px 0 0; font-size: 13.5px; white-space: pre-wrap; color: var(--theme--foreground-subdued); }
</style>
