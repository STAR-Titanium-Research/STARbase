<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useApi } from '@directus/extensions-sdk';
import { errorText, isDuplicate } from '../format';
import { useItems } from '../composables/useItems';
import { useRequestGate } from '../composables/useRequestGate';
import LoadState from '../components/LoadState.vue';
import RecordLink from '../components/RecordLink.vue';
import Section from '../components/Section.vue';
import PickerBox from './PickerBox.vue';
import { forbiddenWriteMessage, inheritCampaignProject } from './assign';
import { LIST_CAP, type SectionState } from '../composables/useSections';

// The campaign's samples (the `campaign_samples` junction, plus samples that only appear through an
// operation or test, flagged) and the picker that adds samples to the junction. Removing deletes
// the junction row; a sample outside the list can be added with one click.
const props = defineProps<{
	campaignId: string;
	/** `overview.sampleRows` */
	rows: any[];
	/** The junction rows (their own ids are needed to remove a sample). */
	junction: SectionState<any[]>;
	/** The user does not own this campaign: no picker and no add button. Removing stays (the sample's own owner may remove it). */
	cannotAdd?: boolean;
	/** Sample-list entries whose sample the user may not see (`overview.counts.hiddenSamples`). */
	hiddenCount?: number;
}>();
const emit = defineEmits<{ (e: 'changed'): void }>();

const api = useApi();
const { getItems } = useItems();
const gate = useRequestGate();

const shown = computed(() => props.rows.slice(0, LIST_CAP));
const junctionIdBySample = computed(() => {
	const m = new Map<string, string>();
	for (const j of props.junction.data) {
		const sid = j.sample_id?.sample_id ?? j.sample_id;
		if (sid) m.set(sid, j.id);
	}
	return m;
});

const busy = ref<string | null>(null);
const actionError = ref('');

// ---- search ----
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
		const rows = await getItems('physical_samples', {
			filter: { _or: [{ sample_code: { _icontains: q } }, { nickname: { _icontains: q } }] },
			fields: ['sample_id', 'sample_code', 'nickname', 'material_id.common_name'],
			sort: ['sample_code'],
			limit: 40,
		});
		if (!gate.isCurrent(token)) return;
		// Samples already in this campaign's list are not offered again.
		results.value = rows.filter((r) => !junctionIdBySample.value.has(r.sample_id)).slice(0, 25);
		searched.value = true;
	} catch (e) {
		if (!gate.isCurrent(token)) return;
		results.value = [];
		actionError.value = `Sample search failed: ${errorText(e)}`;
	} finally {
		if (gate.isCurrent(token)) searching.value = false;
	}
}

async function add(id: string, code?: string | null) {
	if (busy.value) return;
	busy.value = id;
	actionError.value = '';
	try {
		await api.post('/items/campaign_samples', { campaign_id: props.campaignId, sample_id: id });
		// A sample added to a campaign also gets the campaign's project when it has none (never
		// overwriting one).
		actionError.value = await inheritCampaignProject(api, 'physical_samples', 'sample_id', id, props.campaignId, code || 'The sample');
		results.value = results.value.filter((r) => r.sample_id !== id);
	} catch (e) {
		// Already linked (another tab, or a stale list): not an error, the reload shows it.
		if (isDuplicate(e)) results.value = results.value.filter((r) => r.sample_id !== id);
		else actionError.value = forbiddenWriteMessage(e, true, 'campaign_samples') ?? `Could not add ${code || 'the sample'}: ${errorText(e)}`;
	} finally {
		busy.value = null;
	}
	emit('changed');
}

async function remove(id: string, code?: string | null) {
	const jid = junctionIdBySample.value.get(id);
	if (busy.value || !jid) return;
	busy.value = id;
	actionError.value = '';
	try {
		await api.delete(`/items/campaign_samples/${jid}`);
	} catch (e) {
		actionError.value = forbiddenWriteMessage(e, false, 'campaign_samples') ?? `Could not remove ${code || 'the sample'}: ${errorText(e)}`;
	} finally {
		busy.value = null;
	}
	emit('changed');
	runSearch();
}
</script>

<template>
	<Section title="Samples" :count="junction.loading ? null : rows.length">
		<LoadState :loading="junction.loading && !rows.length" :error="junction.error">
			<p v-if="actionError" class="d1-cerr" role="alert">{{ actionError }}</p>
			<table v-if="shown.length" class="d1-ctable">
				<thead><tr><th>Sample</th><th class="n">Operations</th><th class="n">Tests</th><th class="act" /></tr></thead>
				<tbody>
					<tr v-for="s in shown" :key="s.sample_id">
						<td>
							<RecordLink collection="physical_samples" :id="s.sample_id" class="mono">{{ s.sample_code || '—' }}</RecordLink>
							<span v-if="!s.member" class="note" title="Has an operation or test in this campaign but is not in its sample list">not in list</span>
						</td>
						<td class="n">{{ s.operations }}</td>
						<td class="n">{{ s.tests }}</td>
						<td class="act">
							<button v-if="s.member" class="x" title="Remove from the campaign's sample list" :disabled="!!busy" @click="remove(s.sample_id, s.sample_code)"><v-icon name="close" x-small /></button>
							<button v-else-if="!cannotAdd" class="x add" title="Add to the campaign's sample list" :disabled="!!busy" @click="add(s.sample_id, s.sample_code)"><v-icon name="add" x-small /></button>
						</td>
					</tr>
				</tbody>
			</table>
			<p v-else-if="!hiddenCount" class="d1-cempty">No samples yet.</p>
			<p v-if="hiddenCount" class="d1-cempty">
				{{ hiddenCount }} {{ hiddenCount === 1 ? 'sample' : 'samples' }} not visible to you.
			</p>
			<p v-if="rows.length > LIST_CAP" class="d1-ccap">Showing the first {{ LIST_CAP }} of {{ rows.length }} samples. The matrix above has them all.</p>
		</LoadState>
		<PickerBox v-if="!cannotAdd" v-model="search" placeholder="Add samples by code or nickname…" :searching="searching" :no-results="searched && !results.length" empty-text="No other samples match.">
			<button v-for="r in results" :key="r.sample_id" type="button" class="pick" :disabled="!!busy" @click="add(r.sample_id, r.sample_code)">
				<span class="code">{{ r.sample_code }}</span>
				<span class="sub">{{ r.nickname || r.material_id?.common_name || '' }}</span>
				<v-icon name="add_circle" x-small />
			</button>
		</PickerBox>
	</Section>
</template>
