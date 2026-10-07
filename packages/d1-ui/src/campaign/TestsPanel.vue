<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useApi } from '@directus/extensions-sdk';
import { errorText, formatDate } from '../format';
import { useItems } from '../composables/useItems';
import { useRequestGate } from '../composables/useRequestGate';
import LoadState from '../components/LoadState.vue';
import RecordLink from '../components/RecordLink.vue';
import Section from '../components/Section.vue';
import StatusBadge from '../components/StatusBadge.vue';
import PickerBox from './PickerBox.vue';
import { campaignAssignPatch, inheritCampaignProject, lostRaceMessage } from './assign';
import { LIST_CAP, type SectionState } from '../composables/useSections';

// The campaign's test sessions and the picker that adds sessions that are in no campaign yet.
const props = defineProps<{ campaignId: string; rows: any[]; section: SectionState<any[]> }>();
const emit = defineEmits<{ (e: 'changed'): void }>();

const api = useApi();
const { getItems } = useItems();
const gate = useRequestGate();

const shown = computed(() => props.rows.slice(0, LIST_CAP));
const busy = ref<string | null>(null);
const actionError = ref('');

const search = ref('');
const results = ref<any[]>([]);
const searching = ref(false);
const searched = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;
watch(search, () => {
	clearTimeout(timer);
	timer = setTimeout(runSearch, 250);
});
onBeforeUnmount(() => {
	clearTimeout(timer);
	gate.cancel();
});

async function runSearch() {
	const token = gate.begin();
	const q = search.value.trim();
	if (!q) {
		results.value = [];
		searching.value = false;
		searched.value = false;
		return;
	}
	searching.value = true;
	try {
		const rows = await getItems('test_sessions', {
			// only sessions that are not in any campaign yet
			filter: {
				_and: [
					{ campaign_id: { _null: true } },
					{ _or: [{ test_type: { _icontains: q } }, { sample_id: { sample_code: { _icontains: q } } }] },
				],
			},
			fields: ['session_id', 'test_type', 'status', 'session_date', 'sample_id.sample_code'],
			sort: ['-session_date'],
			limit: 25,
		});
		if (!gate.isCurrent(token)) return;
		results.value = rows;
		searched.value = true;
	} catch (e) {
		if (!gate.isCurrent(token)) return;
		results.value = [];
		actionError.value = `Test search failed: ${errorText(e)}`;
	} finally {
		if (gate.isCurrent(token)) searching.value = false;
	}
}

// The change is conditional so two people (or two tabs) cannot take the same session: adding only
// touches a session that is still in no campaign, removing only one that is in this campaign
// (campaignAssignPatch). Directus answers a batch update with the rows it changed, so an empty
// answer means someone got there first.
async function setCampaign(id: string, campaign: string | null, label: string) {
	if (busy.value) return;
	busy.value = id;
	actionError.value = '';
	try {
		const res = await api.patch('/items/test_sessions', campaignAssignPatch('session_id', id, props.campaignId, campaign));
		actionError.value = lostRaceMessage(res.data?.data, !!campaign, label) ?? '';
		// A session added to a campaign also gets the campaign's project when it has none (never
		// overwriting one), so project-scoped counts do not depend on the fallback.
		if (campaign && !actionError.value) {
			actionError.value = await inheritCampaignProject(api, 'test_sessions', 'session_id', id, campaign, label);
		}
		results.value = results.value.filter((r) => r.session_id !== id);
	} catch (e) {
		actionError.value = `Could not ${campaign ? 'add' : 'remove'} ${label}: ${errorText(e)}`;
	} finally {
		busy.value = null;
	}
	emit('changed');
	runSearch();
}
</script>

<template>
	<Section title="Test sessions" :count="section.loading ? null : rows.length">
		<LoadState :loading="section.loading && !rows.length" :error="section.error">
			<p v-if="actionError" class="d1-cerr" role="alert">{{ actionError }}</p>
			<table v-if="shown.length" class="d1-ctable">
				<thead><tr><th>Test</th><th>Sample</th><th>Date</th><th>Status</th><th class="act" /></tr></thead>
				<tbody>
					<tr v-for="t in shown" :key="t.session_id">
						<td><RecordLink collection="test_sessions" :id="t.session_id">{{ t.test_type || 'Test' }}</RecordLink></td>
						<td><RecordLink collection="physical_samples" :id="t.sample_id" class="mono">{{ t.sample_code || '—' }}</RecordLink></td>
						<td>{{ formatDate(t.session_date, '—') }}</td>
						<td><StatusBadge kind="test" :value="t.status" /></td>
						<td class="act"><button class="x" title="Remove from the campaign" :disabled="!!busy" @click="setCampaign(t.session_id, null, t.test_type || 'the test session')"><v-icon name="close" x-small /></button></td>
					</tr>
				</tbody>
			</table>
			<p v-else class="d1-cempty">No test sessions yet.</p>
			<p v-if="rows.length > LIST_CAP" class="d1-ccap">Showing the first {{ LIST_CAP }} of {{ rows.length }} test sessions.</p>
		</LoadState>
		<PickerBox v-model="search" placeholder="Add test sessions by type or sample code…" filter-label="not in a campaign" :searching="searching" :no-results="searched && !results.length" empty-text="No unassigned test sessions match.">
			<button v-for="r in results" :key="r.session_id" type="button" class="pick" :disabled="!!busy" @click="setCampaign(r.session_id, campaignId, r.test_type || 'the test session')">
				<span class="code">{{ r.test_type || '—' }}</span>
				<span class="sub">{{ r.sample_id?.sample_code || '' }} · {{ formatDate(r.session_date, 'undated') }} · {{ r.status }}</span>
				<v-icon name="add_circle" x-small />
			</button>
		</PickerBox>
	</Section>
</template>
