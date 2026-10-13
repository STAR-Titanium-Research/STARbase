import { onBeforeUnmount, ref, watch, type Ref } from 'vue';
import { errorText, isNotVisible, readHiddenLinks, useItems, useRequestGate } from '@d1/ui';

// The campaign record itself, read as the signed-in user. It decides between "page" and "Not found
// or not visible to you"; the lists, matrix and progress load on their own inside the kit's
// CampaignWorkbench, so one forbidden list does not blank the page.

const CAMPAIGN_FIELDS = [
	'campaign_id', 'campaign_code', 'name', 'campaign_type', 'status', 'start_date', 'end_date', 'notes',
	'created_at', 'updated_at', 'version',
	'project_id.project_id', 'project_id.project_code', 'project_id.project_name',
	'owner_person_id.person_id', 'owner_person_id.full_name',
	'default_equipment_id.equipment_id', 'default_equipment_id.equipment_name',
	'default_material_id.material_id', 'default_material_id.common_name',
];

export function useCampaignRecord(id: Ref<string>) {
	const { getItem } = useItems();
	const gate = useRequestGate();

	const campaign = ref<any | null>(null);
	// Links that read as "none" because the target is hidden by row-level visibility (ADR-0011).
	const hidden = ref<Record<string, boolean>>({});
	const loading = ref(false);
	const notVisible = ref(false);
	const error = ref('');

	async function load() {
		const token = gate.begin();
		const campaignId = id.value;
		notVisible.value = false;
		error.value = '';
		// Reloading the same campaign (after an edit) keeps what is on screen until the new data
		// arrives; moving to another campaign starts from a clean page.
		if (campaign.value?.campaign_id !== campaignId) {
			campaign.value = null;
			hidden.value = {};
		}
		if (!campaignId) return;
		loading.value = true;
		try {
			const row = await getItem('campaigns', campaignId, { fields: CAMPAIGN_FIELDS });
			if (!gate.isCurrent(token)) return;
			campaign.value = row;
			const links = await readHiddenLinks(getItem, 'campaigns', campaignId, row, ['project_id']);
			if (gate.isCurrent(token)) hidden.value = links;
		} catch (e: any) {
			if (!gate.isCurrent(token)) return;
			if (isNotVisible(e)) notVisible.value = true;
			else error.value = `Could not load this campaign: ${errorText(e)}`;
		} finally {
			if (gate.isCurrent(token)) loading.value = false;
		}
	}

	watch(id, load, { immediate: true });
	onBeforeUnmount(() => gate.cancel());

	return { campaign, loading, notVisible, error, hidden, reload: load };
}
