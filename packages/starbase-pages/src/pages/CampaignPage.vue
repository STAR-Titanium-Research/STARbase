<script setup lang="ts">
import ExplorerView from '../ExplorerView.vue';
import { computed, ref, toRef } from 'vue';
import {
	AppLink, CampaignProgressBars, CampaignWorkbench, EditDrawer, HiddenLink, useCampaignData, useCanUpdate, LoadState, NotVisible, PageShell, RecordLayout,
	RecordLink, RecordRail, Section, StatusBadge, campaignCode, campaignContents, campaignRailFacts, dataStudioRoute, type ContentsEntry,
} from '@d1/ui';
import { useCampaignRecord } from './campaign/useCampaignRecord';

// Campaign page: a rail (identity, actions, type, dates, defaults, project, counts that link to the
// filtered lists, progress bars, contents) beside the notes, the sample x step matrix (the main
// visual) and the sample / operation / test lists with their pickers. Design:
// docs/superpowers/specs/2026-10-06-explorer-pages-design.md, "Campaign", laid out as a rail and
// panels by docs/superpowers/specs/2026-10-09-explorer-rail-layout-design.md.
const props = defineProps<{ id: string }>();

const { campaign, loading, notVisible, error, hidden, reload } = useCampaignRecord(toRef(props, 'id'));
// The lists, matrix and progress are read once here: the rail shows their counts and bars, the
// workbench (given `data`) draws the panels from the same reads.
// An invisible or failed campaign reads nothing: an empty id makes the composable's load() return early.
const data = useCampaignData(computed(() => (notVisible.value || error.value ? '' : props.id)));
const editing = ref(false);
// Edit is offered unless the server says this user may not change the record (an investigator
// or a reader through a sample may read it but not edit it).
const { canUpdate, refresh: refreshCanUpdate } = useCanUpdate('campaigns', toRef(props, 'id'));
// A save can change who may edit the record (the Owner field), so ask again.
function onSaved() {
	reload();
	refreshCanUpdate();
}

const code = computed(() => campaignCode(campaign.value));
// The name is the subtitle only when the code is what the title shows.
const subtitle = computed(() => (campaign.value?.campaign_code ? campaign.value?.name : ''));
const studioTo = computed(() => dataStudioRoute('campaigns', props.id));

// The counts wait for the three reads behind them (null: the rail leaves them out until then).
const settled = computed(() => !data.junction.value.loading && !data.operations.value.loading && !data.tests.value.loading);
const railFacts = computed(() => {
	const c = data.overview.value.counts;
	const counts = settled.value
		? { samples: c.samples, hiddenSamples: c.hiddenSamples, operations: c.operations, tests: c.tests }
		: null;
	// A count behind a failed read is a dash, not a wrong 0 (samples are built from all three lists).
	const o = data.operations.value.error;
	const t = data.tests.value.error;
	const failed = { samples: !!(data.junction.value.error || o || t), operations: !!o, tests: !!t };
	return campaignRailFacts(campaign.value, hidden.value, counts, failed);
});

// "On this page": the panels in page order. A count is null while its read loads or after it
// failed (never a wrong 0, and never the previous load's rows after a failed reload).
const unknown = (s: { loading: boolean; error?: unknown }) => s.loading || !!s.error;
const contents = computed<ContentsEntry[]>(() => {
	const o = data.overview.value;
	const [j, ops, tests] = [data.junction.value, data.operations.value, data.tests.value];
	return campaignContents({
		hasNotes: !!campaign.value?.notes,
		matrix: unknown(j) || unknown(ops) || unknown(tests) ? null : data.matrix.value.rows.length,
		samples: unknown(j) ? null : o.sampleRows.length,
		tests: unknown(tests) ? null : o.testRows.length,
		operations: unknown(ops) ? null : o.opRows.length,
	});
});
</script>

<template>
	<ExplorerView :title="campaign?.campaign_code ? `Campaign ${campaign.campaign_code}` : code">
		<PageShell>
			<LoadState v-if="loading && !campaign" loading loading-text="Loading campaign…" />

			<NotVisible v-else-if="notVisible" what="campaign" />

			<LoadState v-else-if="error" :error="error" />

			<template v-else-if="campaign">
				<!-- 70px: the Data Studio's header bar is 54px, plus a 16px gap. -->
				<RecordLayout style="--d1-sticky-top: var(--d1-header-offset, 70px)">
					<template #crumbs>
						<AppLink to="/home">Home</AppLink>
						<template v-if="campaign.project_id">
							<span>›</span>
							<RecordLink collection="projects" :id="campaign.project_id.project_id">
								{{ campaign.project_id.project_code ? `Project ${campaign.project_id.project_code}` : campaign.project_id.project_name || 'Project' }}
							</RecordLink>
						</template>
						<template v-else-if="hidden.project_id">
							<span>›</span><HiddenLink label="Project" />
						</template>
					</template>

					<template #rail>
						<RecordRail kind="Campaign" :code="code" :title="subtitle" :facts="railFacts" :contents="contents">
							<template #kind-icon><v-icon name="folder_special" x-small /></template>
							<template #status><StatusBadge kind="campaign" :value="campaign.status" /></template>
							<template #actions>
								<v-button v-if="canUpdate !== false" small @click="editing = true"><v-icon name="edit" small left />Edit</v-button>
								<v-button small secondary :to="studioTo"><v-icon name="open_in_new" small left />Data Studio</v-button>
							</template>
							<template #after-facts>
								<CampaignProgressBars rail :overview="data.overview.value" :force-hidden="data.analysisUnavailable.value" :force-failed="!!data.analyses.value.error" />
							</template>
						</RecordRail>
					</template>

					<Section v-if="campaign.notes" id="notes" title="Notes"><p class="notes">{{ campaign.notes }}</p></Section>

					<CampaignWorkbench
						:campaign-id="id"
						:campaign-type="campaign.campaign_type"
						:can-update="canUpdate"
						:data="data"
						:show-progress="false"
						section-ids
					/>
				</RecordLayout>

				<EditDrawer
					v-model="editing"
					collection="campaigns"
					:primary-key="id"
					:title="`Edit ${code}`"
					:hidden-fields="['campaign_operations']"
					@saved="onSaved"
				/>
			</template>
		</PageShell>
	</ExplorerView>
</template>

<style scoped>
.notes { margin: 0; max-width: 90ch; font-size: var(--fs-md); line-height: 1.55; color: var(--d1-dim); white-space: pre-wrap; }
</style>
