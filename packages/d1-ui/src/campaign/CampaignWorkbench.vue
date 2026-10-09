<script setup lang="ts">
import { computed, toRef } from 'vue';
// The kit's tokens, for when the workbench renders outside a PageShell (the Data Studio form).
import '../components/tokens.css';
import LoadState from '../components/LoadState.vue';
import Section from '../components/Section.vue';
import CampaignMatrix from './CampaignMatrix.vue';
import CampaignProgress from './CampaignProgress.vue';
import OperationsPanel from './OperationsPanel.vue';
import SamplesPanel from './SamplesPanel.vue';
import TestsPanel from './TestsPanel.vue';
import { useCampaignData } from './useCampaignData';
import { useCanUpdate } from '../composables/useCanUpdate';

// Everything below a campaign's header: counts and progress, the sample x step matrix, the sample,
// operation and test lists and their pickers. Used by the Campaign page and, without the matrix, by
// the d1-campaign-ops interface on the Data Studio campaign form. Every read is the signed-in
// user's, and each list loads and fails on its own.
// `canUpdate` is passed by a host that already asked about this campaign (the Campaign page, so one
// request serves the Edit button and the panels); without it (undefined) the workbench asks itself.
const props = withDefaults(
	defineProps<{ campaignId: string; campaignType?: string | null; showMatrix?: boolean; canUpdate?: boolean | null }>(),
	{ showMatrix: true, canUpdate: undefined },
);

const data = useCampaignData(toRef(props, 'campaignId'));
const { junction, operations, tests, analyses, analysisUnavailable, overview, matrix, reload } = data;

// Rights are per row, not per campaign (ADR-0011): putting an operation or test in or out of a
// campaign is an update of that operation or test (its owner, or the owner or a co-owner of its
// sample), so those panels always offer the picker and remove buttons and the server refuses what
// the user may not move, in words. Adding a sample needs the campaign's owner, so only the sample
// picker and add button depend on owning the campaign (unknown, null, keeps them). Removing a sample
// needs the campaign's owner or the sample's own owner, so it stays.
const askId = computed(() => (props.canUpdate === undefined ? props.campaignId : null));
const own = useCanUpdate('campaigns', askId);
const cannotAdd = computed(() => (props.canUpdate === undefined ? own.canUpdate.value : props.canUpdate) === false);

defineExpose({ reload });
</script>

<template>
	<div class="d1-campaign d1-kit">
		<CampaignProgress
			:overview="overview"
			:force-hidden="analysisUnavailable"
			:force-failed="!!analyses.error"
		/>
		<p v-if="analyses.error" class="d1-cerr" role="alert">{{ analyses.error }}</p>

		<Section v-if="showMatrix" title="Samples and steps" :count="matrix.rows.length">
			<LoadState
				:loading="(junction.loading || operations.loading || tests.loading) && !matrix.rows.length"
				:empty="!matrix.rows.length"
				:empty-text="overview.counts.hiddenSamples ? 'No samples, operations or tests you can see in this campaign yet.' : 'No samples, operations or tests in this campaign yet.'"
			>
				<CampaignMatrix :matrix="matrix" :force-hidden="analysisUnavailable" />
			</LoadState>
		</Section>

		<p v-if="cannotAdd" class="d1-cnote">Only the campaign's owner can add samples here. Operations and tests are moved by their own owner.</p>

		<!-- The two short lists share a row while there is room (on the Campaign page); in the form
		     they stack. A three-column list across the whole page put its figures a screen away
		     from the code they belong to. -->
		<div class="d1-ccols">
			<SamplesPanel :campaign-id="campaignId" :rows="overview.sampleRows" :junction="junction" :cannot-add="cannotAdd" :hidden-count="overview.counts.hiddenSamples" @changed="reload" />
			<TestsPanel :campaign-id="campaignId" :rows="overview.testRows" :section="tests" @changed="reload" />
		</div>
		<OperationsPanel
			:campaign-id="campaignId"
			:campaign-type="campaignType"
			:rows="overview.opRows"
			:section="operations"
			:force-hidden="analysisUnavailable || !!analyses.error"
			@changed="reload"
		/>
	</div>
</template>

<style scoped>
.d1-campaign { display: flex; flex-direction: column; gap: 16px; font-size: var(--fs-md, 13px); }
.d1-ccols { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 16px; align-items: stretch; }
.d1-campaign :deep(.d1-cerr) { margin: 0 0 8px; font-size: var(--fs-sm, 12px); color: var(--d1-bad, var(--theme--danger)); }
.d1-campaign .d1-cnote { margin: 0; font-size: var(--fs-sm, 12px); color: var(--d1-dim, var(--theme--foreground-subdued)); }
.d1-campaign :deep(.d1-cempty) { margin: 0; font-size: var(--fs-sm, 12px); color: var(--d1-dim, var(--theme--foreground-subdued)); }
.d1-campaign :deep(.d1-ccap) { margin: 8px 0 0; font-size: var(--fs-sm, 12px); color: var(--d1-dim, var(--theme--foreground-subdued)); }
/* The look of the kit's DataTable (components/DataTable.vue): keep the two in step. */
.d1-campaign :deep(.d1-ctable) { width: 100%; border-collapse: collapse; font-size: var(--fs-md, 13px); }
.d1-campaign :deep(.d1-ctable th) {
	text-align: left;
	padding: 4px 12px 6px 0;
	font-size: var(--fs-xs, 11px);
	font-weight: 600;
	letter-spacing: 0.01em;
	white-space: nowrap;
	color: var(--d1-dim, var(--theme--foreground-subdued));
	border-bottom: 1px solid var(--theme--border-color);
}
.d1-campaign :deep(.d1-ctable td) { padding: 7px 12px 7px 0; border-bottom: 1px solid var(--d1-line, var(--theme--border-color-subdued)); vertical-align: middle; }
.d1-campaign :deep(.d1-ctable tbody tr:last-child td) { border-bottom: 0; }
.d1-campaign :deep(.d1-ctable tbody tr:hover) { background: var(--d1-tile, var(--theme--background-subdued)); }
.d1-campaign :deep(.d1-ctable .n) { text-align: right; font-variant-numeric: tabular-nums; width: 90px; }
.d1-campaign :deep(.d1-ctable .act) { width: 28px; text-align: right; padding-right: 0; }
.d1-campaign :deep(.d1-ctable .mono) { font-family: var(--theme--fonts--monospace--font-family, monospace); font-weight: 600; }
.d1-campaign :deep(.d1-ctable .dim) { color: var(--d1-dim, var(--theme--foreground-subdued)); font-size: var(--fs-sm, 12px); }
.d1-campaign :deep(.d1-ctable .note) {
	margin-left: 8px;
	font-size: var(--fs-xs, 11px);
	font-weight: 700;
	padding: 1px 7px;
	border-radius: 99px;
	color: var(--d1-warn, var(--theme--warning));
	background: color-mix(in srgb, var(--theme--warning) 18%, transparent);
}
.d1-campaign :deep(.d1-ctable .x) {
	border: 0;
	background: transparent;
	cursor: pointer;
	color: var(--d1-dim, var(--theme--foreground-subdued));
	border-radius: 5px;
	display: inline-flex;
	padding: 2px;
}
.d1-campaign :deep(.d1-ctable .x:hover:not(:disabled)) { color: var(--theme--danger); background: var(--theme--danger-background); }
.d1-campaign :deep(.d1-ctable .x.add:hover:not(:disabled)) { color: var(--d1-accent, var(--theme--primary)); background: var(--theme--primary-background); }
</style>
