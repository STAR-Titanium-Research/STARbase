<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useApi } from '@directus/extensions-sdk';
import { errorText } from '../format';
import { processLabel } from '../process';
import { useItems } from '../composables/useItems';
import { useRequestGate } from '../composables/useRequestGate';
import LoadState from '../components/LoadState.vue';
import RecordLink from '../components/RecordLink.vue';
import Section from '../components/Section.vue';
import StatusBadge from '../components/StatusBadge.vue';
import PickerBox from './PickerBox.vue';
import { campaignAssignPatch, inheritCampaignProject, lostRaceMessage } from './assign';
import { operationCategoryFor } from './campaignType';
import { LIST_CAP, type SectionState } from '../composables/useSections';

// The campaign's operations with their force-analysis and diagnostics state, and the picker that
// assigns operations (sets manufacturing_operations.campaign_id). The picker's search is
// pre-filtered by the campaign type: a Machining trial only offers machining operations.
const props = defineProps<{
	campaignId: string;
	campaignType?: string | null;
	/** `overview.opRows` */
	rows: any[];
	section: SectionState<any[]>;
	/** The role may not read the force-analysis table: show a dash instead of "not analysed". */
	forceHidden?: boolean;
}>();
const emit = defineEmits<{ (e: 'changed'): void }>();

const api = useApi();
const { getItems } = useItems();
const gate = useRequestGate();

const shown = computed(() => props.rows.slice(0, LIST_CAP));
const category = computed(() => operationCategoryFor(props.campaignType));
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
watch(category, runSearch);
onMounted(runSearch);
onBeforeUnmount(() => {
	clearTimeout(timer);
	gate.cancel();
});

async function runSearch() {
	const token = gate.begin();
	searching.value = true;
	try {
		const filter: any = { _and: [{ campaign_id: { _null: true } }] };
		if (category.value) filter._and.push({ process_category: { _eq: category.value } });
		if (search.value.trim()) filter._and.push({ pass_code: { _icontains: search.value.trim() } });
		const rows = await getItems('manufacturing_operations', {
			filter,
			fields: ['operation_id', 'pass_code', 'process_category', 'sample_id.sample_code'],
			sort: ['pass_code'],
			limit: 25,
		});
		if (!gate.isCurrent(token)) return;
		results.value = rows;
		searched.value = true;
	} catch (e) {
		if (!gate.isCurrent(token)) return;
		results.value = [];
		actionError.value = `Search failed: ${errorText(e)}`;
	} finally {
		if (gate.isCurrent(token)) searching.value = false;
	}
}

// The change is conditional so two people (or two tabs) cannot take the same operation: adding
// only touches an operation that is still in no campaign, removing only one that is in this
// campaign (campaignAssignPatch). Directus answers a batch update with the rows it changed, so an
// empty answer means someone got there first. A failed add/remove is shown and leaves the lists as
// the server has them (we reload either way), instead of an unhandled rejection.
async function setCampaign(id: string, passCode: string | null, campaign: string | null) {
	if (busy.value) return;
	busy.value = id;
	actionError.value = '';
	const label = passCode || 'the operation';
	try {
		const res = await api.patch('/items/manufacturing_operations', campaignAssignPatch('operation_id', id, props.campaignId, campaign));
		actionError.value = lostRaceMessage(res.data?.data, !!campaign, label) ?? '';
		// An operation added to a campaign also gets the campaign's project when it has none
		// (never overwriting one), so project-scoped counts do not depend on the fallback.
		if (campaign && !actionError.value) {
			actionError.value = await inheritCampaignProject(api, 'manufacturing_operations', 'operation_id', id, campaign, label);
		}
		results.value = results.value.filter((r) => r.operation_id !== id);
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
	<Section title="Operations and force analysis" :count="section.loading ? null : rows.length">
		<LoadState :loading="section.loading && !rows.length" :error="section.error">
			<p v-if="actionError" class="d1-cerr" role="alert">{{ actionError }}</p>
			<table v-if="shown.length" class="d1-ctable">
				<thead><tr><th>Operation</th><th>Process</th><th>Sample</th><th>Force analysis</th><th>Diagnostics</th><th class="act" /></tr></thead>
				<tbody>
					<tr v-for="o in shown" :key="o.operation_id">
						<td><RecordLink collection="manufacturing_operations" :id="o.operation_id" class="mono">{{ o.pass_code || '—' }}</RecordLink></td>
						<td>{{ processLabel(o.process_category) }}</td>
						<td><RecordLink collection="physical_samples" :id="o.sample_id" class="mono">{{ o.sample_code || '—' }}</RecordLink></td>
						<td>
							<span v-if="forceHidden" class="dim">—</span>
							<span v-else-if="o.analysis === 'none'" class="dim">not analysed</span>
							<span v-else :title="o.analysis_error || ''"><StatusBadge kind="force" :value="o.analysis" /></span>
						</td>
						<td>
							<span v-if="forceHidden || o.diag === 'none'" class="dim">—</span>
							<span v-else :title="o.diag_error || ''"><StatusBadge kind="diag" :value="o.diag" /></span>
						</td>
						<td class="act"><button class="x" title="Remove from the campaign" :disabled="!!busy" @click="setCampaign(o.operation_id, o.pass_code, null)"><v-icon name="close" x-small /></button></td>
					</tr>
				</tbody>
			</table>
			<p v-else class="d1-cempty">No operations yet. Add them below.</p>
			<p v-if="rows.length > LIST_CAP" class="d1-ccap">Showing the first {{ LIST_CAP }} of {{ rows.length }} operations. The matrix above has them all.</p>
		</LoadState>
		<PickerBox
			v-model="search"
			:placeholder="category ? `Add ${category} operations…` : 'Add operations…'"
			:filter-label="category ? `filtered: ${category}` : undefined"
			:searching="searching"
			:no-results="searched && !results.length"
			:empty-text="`No unassigned ${category || ''} operations match.`"
		>
			<button v-for="op in results" :key="op.operation_id" type="button" class="pick" :disabled="!!busy" @click="setCampaign(op.operation_id, op.pass_code, campaignId)">
				<span class="code">{{ op.pass_code || '—' }}</span>
				<span class="sub">{{ op.sample_id?.sample_code || processLabel(op.process_category) }}</span>
				<v-icon name="add_circle" x-small />
			</button>
		</PickerBox>
	</Section>
</template>
