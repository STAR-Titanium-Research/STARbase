<script setup lang="ts">
import ExplorerView from '../ExplorerView.vue';
import { computed, ref, toRef } from 'vue';
import {
	EditDrawer, HiddenLink, useCanUpdate, LIST_CAP, LoadState, NotVisible, PageShell, RecordLayout, RecordLink, RecordRail, asRecord, dataStudioRoute,
	detailFacts, hasPassCode, operationDetailBase, operationHeading, operationKind, operationRailFacts, operationSampleCount, type ContentsEntry,
} from '@d1/ui';
import { useOperationData } from './operation/useOperationData';
import OperationSamples from './operation/OperationSamples.vue';
import OperationAnalysis from './operation/OperationAnalysis.vue';
import RecordDetails from './record/RecordDetails.vue';
import SampleFiles from './sample/SampleFiles.vue';

// Operation page: one manufacturing step with its parameters, samples in and out, analysis state
// and files. Design: docs/superpowers/specs/2026-10-06-explorer-pages-design.md ("Operation"), laid
// out as a rail and panels by docs/superpowers/specs/2026-10-09-explorer-rail-layout-design.md.
const props = defineProps<{ id: string }>();

const { operation, loading, notVisible, error, params, force, fast, files, shared, hidden, hiddenKnown, reload } = useOperationData(toRef(props, 'id'));

const editing = ref(false);
// Edit is offered unless the server says this user may not change the record (an investigator
// or a reader through a sample may read it but not edit it).
const { canUpdate, refresh: refreshCanUpdate } = useCanUpdate('manufacturing_operations', toRef(props, 'id'));
// A save can change who may edit the record (the Owner field), so ask again.
function onSaved() {
	reload();
	refreshCanUpdate();
}

const op = computed(() => operation.value);
const studioTo = computed(() => dataStudioRoute('manufacturing_operations', props.id));
const project = computed(() => asRecord(op.value?.project_id));
const campaign = computed(() => asRecord(op.value?.campaign_id));
const sample = computed(() => asRecord(op.value?.sample_id) ?? asRecord(op.value?.output_sample_id));
// The pass code, else what the lists call it (input sample and step). The output sample names it
// only when no input is linked at all, and then without a step: the step belongs to the input
// sample. Until the hidden-link read has answered for this operation, a null input may still be a
// hidden one; after that its last answer holds while a reload runs, so a save does not flip the heading.
const code = computed(() => operationHeading(
	op.value, asRecord(op.value?.output_sample_id)?.sample_code, !hiddenKnown.value || !!hidden.value.data.sample_id,
));
const isCode = computed(() => hasPassCode(op.value));
const pageTitle = computed(() => {
	if (!op.value) return 'Operation';
	return isCode.value ? `Operation ${code.value}` : code.value;
});

// The rail's key facts, and the Details panel: the operation's own values and its parameters, minus
// what the rail already shows.
const railFacts = computed(() => operationRailFacts(op.value, hidden.value.data));
const details = computed(() => detailFacts(operationDetailBase(op.value), params.value.data, railFacts.value));

// Linked Directus files and legacy network-share paths read as one list.
const allFiles = computed(() => [...files.value.data, ...shared.value.data]);

// "On this page": the panels this operation has, in page order. A count is null while it loads.
const contents = computed<ContentsEntry[]>(() => {
	const o = op.value;
	if (!o) return [];
	const entries: ContentsEntry[] = [
		{ id: 'details', title: 'Details', count: params.value.loading ? null : details.value.length || null },
		{ id: 'samples', title: 'Samples in and out', count: operationSampleCount(o, hidden.value.data) },
	];
	if (o.process_category === 'machining') {
		entries.push({ id: 'force-analysis', title: 'Force analysis', count: force.value.loading ? null : Math.min(force.value.data.length, LIST_CAP) });
	}
	if (o.process_category === 'sintering') {
		entries.push({ id: 'fast-run', title: 'FAST run', count: fast.value.loading ? null : fast.value.data ? 1 : 0 });
	}
	entries.push({ id: 'files', title: 'Files', count: files.value.loading || shared.value.loading ? null : allFiles.value.length });
	return entries;
});

const openReport = () => window.open(`/d1-report/operation/${encodeURIComponent(props.id)}`, '_blank', 'noopener');
</script>

<template>
	<ExplorerView :title="pageTitle">
		<PageShell>
			<LoadState v-if="loading && !op" loading loading-text="Loading operation…" />

			<NotVisible v-else-if="notVisible" what="operation" />

			<LoadState v-else-if="error" :error="error" />

			<template v-else-if="op">
				<!-- 70px: the Data Studio's header bar is 54px, plus a 16px gap. -->
				<RecordLayout style="--d1-sticky-top: 70px">
					<template #crumbs>
						<router-link to="/home">Home</router-link>
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
					</template>

					<template #rail>
						<RecordRail :kind="operationKind(op)" :code="code" :plain="!isCode" :facts="railFacts" :contents="contents">
							<template #kind-icon><v-icon name="precision_manufacturing" x-small /></template>
							<template #actions>
								<v-button v-if="canUpdate !== false" small @click="editing = true"><v-icon name="edit" small left />Edit</v-button>
								<v-button small secondary @click="openReport"><v-icon name="picture_as_pdf" small left />Report</v-button>
								<v-button small secondary :to="studioTo"><v-icon name="open_in_new" small left />Data Studio</v-button>
							</template>
						</RecordRail>
					</template>

					<RecordDetails
						:facts="details"
						:notes="op.outcome_notes"
						:params-loading="params.loading"
						:params-error="params.error"
						:empty-text="op.process_category ? 'No details or parameters recorded for this operation.' : 'No details recorded, and no process category, so no parameter set applies.'"
					/>

					<div class="d1-cols">
						<OperationSamples
							id="samples"
							:input="op.sample_id"
							:output="op.output_sample_id"
							:input-hidden="!!hidden.data.sample_id"
							:output-hidden="!!hidden.data.output_sample_id"
						/>

						<OperationAnalysis :operation-id="id" :category="op.process_category" :force="force" :fast="fast" />
					</div>

					<SampleFiles
						id="files"
						:files="allFiles"
						:loading="files.loading || shared.loading"
						:error="files.error || shared.error"
						empty-text="No files linked to this operation."
					/>
				</RecordLayout>

				<EditDrawer
					v-model="editing"
					collection="manufacturing_operations"
					:primary-key="id"
					:title="`Edit ${code}`"
					@saved="onSaved"
				/>
			</template>
		</PageShell>
	</ExplorerView>
</template>
