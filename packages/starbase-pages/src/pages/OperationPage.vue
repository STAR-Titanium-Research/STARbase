<script setup lang="ts">
import RecordActions from './RecordActions.vue';
import ExplorerView from '../ExplorerView.vue';
import { computed, ref, toRef } from 'vue';
import { useRouter } from 'vue-router';
import {
	AppLink, openLink, AccessDialog, EditDrawer, HiddenLink, useCanUpdate, LIST_CAP, LoadState, NotVisible, PageShell, RecordLayout, RecordLink, RecordRail, asRecord, dataStudioRoute,
	detailFacts, detailsCount, hasPassCode, operationDetailBase, operationHeading, operationKind, operationRailFacts, operationSampleCount, type ContentsEntry,
	pinTargetForRecord, providePagePin,
	mapPath,
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
const router = useRouter();

const { operation, loading, notVisible, error, params, force, fast, conform, files, shared, hidden, hiddenKnown, reload } = useOperationData(toRef(props, 'id'));

const editing = ref(false);
// "Who has access": the dialog of the record's owner list; a change can alter who may edit (a transfer), so it ends like a save.
const access = ref(false);
// Edit is offered unless the server says this user may not change the record (an investigator
// or a reader through a sample may read it but not edit it).
const { canUpdate, refresh: refreshCanUpdate } = useCanUpdate('manufacturing_operations', toRef(props, 'id'));
const accessParent = computed(() => {
	const s = asRecord(op.value?.sample_id);
	return s?.sample_id ? { collection: 'physical_samples', id: String(s.sample_id), label: s.sample_code ? `sample ${s.sample_code}` : 'the sample' } : null;
});
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
		{ id: 'details', title: 'Details', count: detailsCount(details.value.length, !!o.outcome_notes, params.value.loading, params.value.error) },
		{ id: 'samples', title: 'Samples in and out', count: operationSampleCount(o, hidden.value.data) },
	];
	if (o.process_category === 'machining') {
		entries.push({ id: 'force-analysis', title: 'Force analysis', count: force.value.loading ? null : Math.min(force.value.data.length, LIST_CAP) });
	}
	if (o.process_category === 'sintering') {
		entries.push({ id: 'fast-run', title: 'FAST run', count: fast.value.loading ? null : fast.value.data ? 1 : 0 });
	}
	if (o.process_category === 'conform') {
		entries.push({ id: 'conform-run', title: 'Conform run', count: conform.value.loading ? null : conform.value.data?.run ? 1 : 0 });
	}
	entries.push({ id: 'files', title: 'Files', count: files.value.loading || shared.value.loading ? null : allFiles.value.length });
	return entries;
});

const openReport = () => openLink(`/d1-report/operation/${encodeURIComponent(props.id)}`, router);

// The Process map, opened on this record.
const mapTo = computed(() => mapPath('manufacturing_operations', props.id));
const pin = computed(() => (op.value ? pinTargetForRecord('manufacturing_operations', props.id) : null));
// The Pin button sits after the title, in the host frame (DESIGN.md "Pin on the title"), once the record has loaded.
providePagePin(pin);
</script>

<template>
	<ExplorerView :title="pageTitle">
		<PageShell>
			<LoadState v-if="loading && !op" loading loading-text="Loading operation…" />

			<NotVisible v-else-if="notVisible" what="operation" />

			<LoadState v-else-if="error" :error="error" />

			<template v-else-if="op">
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
					</template>

					<template #rail>
						<RecordRail :kind="operationKind(op)" :code="code" :plain="!isCode" :facts="railFacts" :contents="contents">
							<template #kind-icon><v-icon name="precision_manufacturing" x-small /></template>
							<template #actions>
								<RecordActions :can-update="canUpdate" :studio-to="studioTo" @edit="editing = true" @access="access = true">
									<v-button icon small secondary :to="mapTo" title="Process map" aria-label="Process map"><v-icon name="account_tree" small /><span class="sr-only">Process map</span></v-button>
									<v-button icon small secondary @click="openReport" title="Report" aria-label="Report"><v-icon name="picture_as_pdf" small /><span class="sr-only">Report</span></v-button>
								</RecordActions>
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

					<OperationSamples
						id="samples"
						:input="op.sample_id"
						:output="op.output_sample_id"
						:input-hidden="!!hidden.data.sample_id"
						:output-hidden="!!hidden.data.output_sample_id"
					/>

					<!-- Full width, not beside the samples: the force table's file column needs the room. -->
					<OperationAnalysis
						:operation-id="id"
						:category="op.process_category"
						:force="force"
						:fast="fast"
						:conform="conform"
						:equipment-id="asRecord(op.equipment_id)?.equipment_id ?? null"
						:operation-date="op.operation_date ?? null"
						:can-edit="canUpdate !== false"
						@changed="reload"
					/>

					<SampleFiles
						id="files"
						:files="allFiles"
						:loading="files.loading || shared.loading"
						:error="files.error || shared.error"
						empty-text="No files linked to this operation."
					/>
				</RecordLayout>

				<AccessDialog v-model="access" collection="manufacturing_operations" :id="id" :title="pageTitle" :parent="accessParent" @changed="onSaved" />
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

<style scoped>
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; margin: -1px; padding: 0; border: 0; }
</style>
