<script setup lang="ts">
import { computed, ref, toRef } from 'vue';
import {
	EditDrawer, KeyValueGrid, LoadState, NotVisible, RecordHeader, RecordLink, Section, asRecord, dataStudioRoute,
	formatDate, formatQuantity, processLabel, type KeyValue,
} from '@d1/ui';
import { useOperationData } from './operation/useOperationData';
import OperationSamples from './operation/OperationSamples.vue';
import OperationAnalysis from './operation/OperationAnalysis.vue';
import SampleFiles from './sample/SampleFiles.vue';

// Operation page: one manufacturing step with its parameters, samples in and out, analysis state
// and files. Design: docs/superpowers/specs/2026-10-06-explorer-pages-design.md ("Operation").
const props = defineProps<{ id: string }>();

const { operation, loading, notVisible, error, params, force, fast, files, shared, reload } = useOperationData(toRef(props, 'id'));

const editing = ref(false);

const op = computed(() => operation.value);
const code = computed(() => op.value?.pass_code || 'Operation');
const studioTo = computed(() => dataStudioRoute('manufacturing_operations', props.id));
const project = computed(() => asRecord(op.value?.project_id));
const campaign = computed(() => asRecord(op.value?.campaign_id));
const sample = computed(() => asRecord(op.value?.sample_id) ?? asRecord(op.value?.output_sample_id));
const operatorText = computed(() => asRecord(op.value?.operator_person_id)?.full_name || op.value?.operator_name || '');

const overview = computed<KeyValue[]>(() => {
	const o = op.value;
	if (!o) return [];
	// Samples and machine are in the header and the samples section, so not repeated here.
	return [
		{ label: 'Method', value: asRecord(o.method_id)?.method_name },
		{ label: 'Step', value: o.operation_sequence },
		{ label: 'Capture software', value: o.capture_software },
		{ label: 'Capture frequency', value: formatQuantity(o.capture_frequency_khz), unit: 'kHz' },
		{ label: 'Force file ID', value: o.force_file_id, mono: true },
		{ label: 'Imported from', value: o.source_system },
	];
});

// Linked Directus files and legacy network-share paths read as one list.
const allFiles = computed(() => [...files.value.data, ...shared.value.data]);

const openReport = () => window.open(`/d1-report/operation/${encodeURIComponent(props.id)}`, '_blank', 'noopener');
</script>

<template>
	<private-view :title="code">
		<div class="op-page">
			<LoadState v-if="loading && !op" loading loading-text="Loading operation…" />

			<NotVisible v-else-if="notVisible" what="operation" />

			<LoadState v-else-if="error" :error="error" />

			<template v-else-if="op">
				<RecordHeader :code="code" :title="processLabel(op.process_category)" kind="Operation" icon="precision_manufacturing">
					<template #crumbs>
						<router-link to="/home">Home</router-link>
						<template v-if="project">
							<span>›</span>
							<RecordLink collection="projects" :id="project.project_id">{{ project.project_code }}</RecordLink>
						</template>
						<template v-if="campaign">
							<span>›</span>
							<RecordLink collection="campaigns" :id="campaign.campaign_id">{{ campaign.campaign_code || campaign.name || 'Campaign' }}</RecordLink>
						</template>
						<template v-if="sample">
							<span>›</span>
							<RecordLink collection="physical_samples" :id="sample.sample_id">{{ sample.sample_code || 'Sample' }}</RecordLink>
						</template>
					</template>
					<template #meta>
						<span>{{ formatDate(op.operation_date, 'Undated') }}</span>
						<span v-if="asRecord(op.owner_person_id)">Owner: {{ asRecord(op.owner_person_id)!.full_name }}</span>
						<span v-if="operatorText">Operator: {{ operatorText }}</span>
						<span v-if="asRecord(op.equipment_id)">Machine: {{ asRecord(op.equipment_id)!.equipment_name }}</span>
					</template>
					<template #actions>
						<v-button small @click="editing = true"><v-icon name="edit" small left />Edit</v-button>
						<v-button small secondary @click="openReport"><v-icon name="picture_as_pdf" small left />Report</v-button>
						<v-button small secondary :to="studioTo"><v-icon name="open_in_new" small left />Data Studio</v-button>
					</template>
				</RecordHeader>

				<Section title="Overview">
					<KeyValueGrid :items="overview" />
					<p v-if="op.outcome_notes" class="notes">{{ op.outcome_notes }}</p>
				</Section>

				<Section
					title="Parameters"
					:count="params.loading ? null : params.data.length || null"
					:empty="!params.loading && !params.error && !params.data.length"
					:empty-text="op.process_category ? 'No parameters recorded for this operation.' : 'This operation has no process category, so no parameter set applies.'"
				>
					<LoadState :loading="params.loading" :error="params.error">
						<KeyValueGrid :items="params.data.map((p) => ({ label: p.label, value: p.value, unit: p.unit }))" />
					</LoadState>
				</Section>

				<OperationSamples :input="op.sample_id" :output="op.output_sample_id" />

				<OperationAnalysis :operation-id="id" :category="op.process_category" :force="force" :fast="fast" />

				<SampleFiles
					:files="allFiles"
					:loading="files.loading || shared.loading"
					:error="files.error || shared.error"
					empty-text="No files linked to this operation."
				/>

				<EditDrawer
					v-model="editing"
					collection="manufacturing_operations"
					:primary-key="id"
					:title="`Edit ${code}`"
					@saved="reload()"
				/>
			</template>
		</div>
	</private-view>
</template>

<style scoped>
.op-page {
	max-width: 1180px;
	margin: 0 auto;
	padding: 24px 32px 64px;
	font-family: var(--theme--fonts--sans--font-family, -apple-system, 'Segoe UI', Roboto, sans-serif);
	color: var(--theme--foreground);
}
.op-page :deep(.crumbs a) { color: var(--theme--primary); text-decoration: none; font-weight: 600; }
.op-page :deep(.crumbs a:hover) { text-decoration: underline; }
.notes { margin: 14px 0 0; font-size: 13.5px; white-space: pre-wrap; color: var(--theme--foreground-subdued); }
</style>
