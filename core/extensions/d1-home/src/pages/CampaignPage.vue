<script setup lang="ts">
import { computed, ref, toRef } from 'vue';
import {
	CampaignWorkbench, EditDrawer, HiddenLink, useCanUpdate, LoadState, NotVisible, RecordHeader, RecordLink, StatusBadge,
	campaignTypeLabel, dataStudioRoute, formatDate,
} from '@d1/ui';
import { useCampaignRecord } from './campaign/useCampaignRecord';

// Campaign page: one screen for a campaign. A header, tiles and progress bars, the sample x step
// matrix (the main visual) and the sample / operation / test lists with their pickers. Design:
// docs/superpowers/specs/2026-10-06-explorer-pages-design.md, "Campaign".
const props = defineProps<{ id: string }>();

const { campaign, loading, notVisible, error, hidden, reload } = useCampaignRecord(toRef(props, 'id'));
const editing = ref(false);
// Edit is offered unless the server says this user may not change the record (an investigator
// or a reader through a sample may read it but not edit it).
const { canUpdate, refresh: refreshCanUpdate } = useCanUpdate('campaigns', toRef(props, 'id'));
// A save can change who may edit the record (the Owner field), so ask again.
function onSaved() {
	reload();
	refreshCanUpdate();
}

const code = computed(() => campaign.value?.campaign_code || campaign.value?.name || 'Campaign');
// The name is the subtitle only when the code is what the title shows.
const subtitle = computed(() => (campaign.value?.campaign_code ? campaign.value?.name : ''));
const studioTo = computed(() => dataStudioRoute('campaigns', props.id));
const dates = computed(() => {
	const start = formatDate(campaign.value?.start_date);
	const end = formatDate(campaign.value?.end_date);
	if (start && end) return `${start} to ${end}`;
	return start ? `From ${start}` : end ? `Until ${end}` : '';
});
</script>

<template>
	<private-view :title="code">
		<div class="campaign-page">
			<LoadState v-if="loading && !campaign" loading loading-text="Loading campaign…" />

			<NotVisible v-else-if="notVisible" what="campaign" />

			<LoadState v-else-if="error" :error="error" />

			<template v-else-if="campaign">
				<RecordHeader :code="code" :title="subtitle" :kind="campaignTypeLabel(campaign.campaign_type)" icon="folder_special">
					<template #crumbs>
						<router-link to="/home">Home</router-link>
						<template v-if="campaign.project_id">
							<span>›</span>
							<RecordLink collection="projects" :id="campaign.project_id.project_id">
								{{ campaign.project_id.project_code || campaign.project_id.project_name || 'Project' }}
							</RecordLink>
						</template>
						<template v-else-if="hidden.project_id">
							<span>›</span><HiddenLink label="Project" />
						</template>
					</template>
					<template #status>
						<StatusBadge kind="campaign" :value="campaign.status" />
					</template>
					<template #meta>
						<span v-if="campaign.project_id?.project_name">{{ campaign.project_id.project_name }}</span>
						<span v-if="campaign.owner_person_id">Owner: {{ campaign.owner_person_id.full_name }}</span>
						<span v-if="dates">{{ dates }}</span>
						<span v-if="campaign.default_equipment_id">Equipment: {{ campaign.default_equipment_id.equipment_name }}</span>
						<span v-if="campaign.default_material_id">Material: {{ campaign.default_material_id.common_name }}</span>
					</template>
					<template #actions>
						<v-button v-if="canUpdate !== false" small @click="editing = true"><v-icon name="edit" small left />Edit</v-button>
						<v-button small secondary :to="studioTo"><v-icon name="open_in_new" small left />Data Studio</v-button>
					</template>
				</RecordHeader>

				<p v-if="campaign.notes" class="notes">{{ campaign.notes }}</p>

				<CampaignWorkbench :campaign-id="id" :campaign-type="campaign.campaign_type" :can-update="canUpdate" />

				<EditDrawer
					v-model="editing"
					collection="campaigns"
					:primary-key="id"
					:title="`Edit ${code}`"
					:hidden-fields="['campaign_operations']"
					@saved="onSaved"
				/>
			</template>
		</div>
	</private-view>
</template>

<style scoped>
.campaign-page {
	max-width: 1280px;
	margin: 0 auto;
	padding: 24px 32px 64px;
	font-family: var(--theme--fonts--sans--font-family, -apple-system, 'Segoe UI', Roboto, sans-serif);
	color: var(--theme--foreground);
}
.campaign-page :deep(.crumbs a) { color: var(--theme--primary); text-decoration: none; font-weight: 600; }
.campaign-page :deep(.crumbs a:hover) { text-decoration: underline; }
.notes { margin: 14px 0 0; font-size: 13.5px; color: var(--theme--foreground-subdued); white-space: pre-wrap; }
.campaign-page :deep(.d1-progress-block) { margin-top: 22px; }
</style>
