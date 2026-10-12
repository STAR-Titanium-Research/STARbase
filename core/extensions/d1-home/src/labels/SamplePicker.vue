<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { DataTable, LoadState, MAX_COPIES, Section, parseCodes, type LabelSample } from '@d1/ui';
import { PICKER_LIMIT, type useLabelSamples } from './useLabelSamples';
import './form.css';

// The left column: find samples (search, project, campaign), tick them, paste codes, say how many copies of
// each. The ticked samples are kept apart from the results, so searching again never drops a pick.
const props = defineProps<{ data: ReturnType<typeof useLabelSamples> }>();
const copies = defineModel<number>('copies', { required: true });

const d = props.data;
const pasted = ref('');
const pasteNote = ref('');
const pasteBusy = ref(false);

const selectedIds = computed(() => new Set(d.selected.value.map((s) => s.id)));
const allShown = computed(() => d.results.value.length > 0 && d.results.value.every((s) => selectedIds.value.has(s.id)));
const campaignOptions = computed(() => d.campaigns.value.filter((c) => !d.projectId.value || c.projectId === d.projectId.value));
const filtered = computed(() => !!(d.search.value.trim() || d.projectId.value || d.campaignId.value));

function toggle(s: LabelSample): void {
	if (selectedIds.value.has(s.id)) d.remove(s.id);
	else d.add([s]);
}
function toggleAll(): void {
	if (allShown.value) for (const s of d.results.value) d.remove(s.id);
	else d.add(d.results.value);
}
function clearFilters(): void {
	d.search.value = '';
	d.projectId.value = '';
	d.campaignId.value = '';
}

// Typing waits a moment; the selects search at once. A campaign of another project is dropped when the project changes.
let timer: ReturnType<typeof setTimeout> | undefined;
watch(d.search, () => {
	clearTimeout(timer);
	timer = setTimeout(() => void d.runSearch(), 250);
});
watch(d.projectId, () => {
	if (d.campaignId.value && !campaignOptions.value.some((c) => c.value === d.campaignId.value)) d.campaignId.value = '';
	void d.runSearch();
});
watch(d.campaignId, () => void d.runSearch());
onBeforeUnmount(() => clearTimeout(timer));

async function addPasted(): Promise<void> {
	const codes = parseCodes(pasted.value);
	if (!codes.length) return;
	pasteBusy.value = true;
	pasteNote.value = '';
	try {
		const { added, missing } = await d.resolve([], codes);
		pasteNote.value = `${added} added.${missing.length ? ` Not found, or not visible to you: ${missing.join(', ')}.` : ''}`;
		// What was found leaves the box; what was not stays, to correct.
		pasted.value = missing.join('\n');
	} catch {
		pasteNote.value = 'Could not look those codes up. Try again.';
	} finally {
		pasteBusy.value = false;
	}
}

const rangeText = computed(() => {
	const n = d.results.value.length;
	const t = d.total.value;
	return t !== null && t > n ? `Showing the first ${n} of ${t}. Narrow the search to see the rest.` : `${n} sample${n === 1 ? '' : 's'}`;
});
</script>

<template>
	<Section title="Samples" :count="d.selected.value.length">
		<template #actions>
			<button v-if="d.selected.value.length" type="button" class="lf-link" @click="d.clear()">Clear selection</button>
		</template>

		<div class="filters">
			<label class="lf-field grow">Search
				<input v-model="d.search.value" type="search" placeholder="Code, nickname or short ID" aria-label="Search samples" />
			</label>
			<label class="lf-field">Project
				<select v-model="d.projectId.value" aria-label="Filter by project">
					<option value="">Any project</option>
					<option v-for="p in d.projects.value" :key="p.value" :value="p.value">{{ p.label }}</option>
				</select>
			</label>
			<label class="lf-field">Campaign
				<select v-model="d.campaignId.value" aria-label="Filter by campaign">
					<option value="">Any campaign</option>
					<option v-for="c in campaignOptions" :key="c.value" :value="c.value">{{ c.label }}</option>
				</select>
			</label>
			<button v-if="filtered" type="button" class="lf-link clear" @click="clearFilters">Clear filters</button>
		</div>
		<p v-if="d.optionsError.value" class="d1-note warn">{{ d.optionsError.value }}</p>

		<LoadState v-if="d.error.value" :error="d.error.value" />
		<div v-else class="results" :class="{ busy: d.loading.value }" :aria-busy="d.loading.value">
			<DataTable v-if="d.results.value.length" dense>
				<thead>
					<tr>
						<th class="fit"><input type="checkbox" :checked="allShown" aria-label="Tick every sample shown" @change="toggleAll" /></th>
						<th>Code</th>
						<th>Nickname</th>
						<th>Material</th>
					</tr>
				</thead>
				<tbody>
					<tr v-for="s in d.results.value" :key="s.id" class="row" @click="toggle(s)">
						<td class="fit"><input type="checkbox" :checked="selectedIds.has(s.id)" :aria-label="`Print a label for ${s.code}`" @click.stop @change="toggle(s)" /></td>
						<td class="mono">{{ s.code }}</td>
						<td>{{ s.nickname ?? '' }}</td>
						<td class="dim">{{ s.material ?? '' }}</td>
					</tr>
				</tbody>
			</DataTable>
			<LoadState v-else-if="d.loading.value" loading loading-text="Loading samples…" />
			<LoadState v-else empty :empty-text="filtered ? 'No samples match.' : 'No samples to show.'" />
			<p v-if="d.results.value.length" class="d1-note range">{{ rangeText }} (the list is capped at {{ PICKER_LIMIT }}).</p>
		</div>

		<div v-if="d.selected.value.length" class="picked" aria-label="Selected samples">
			<span v-for="s in d.selected.value" :key="s.id" class="pill">
				<span class="mono">{{ s.code || s.shortId }}</span>
				<button type="button" :aria-label="`Remove ${s.code} from the selection`" @click="d.remove(s.id)">×</button>
			</span>
		</div>

		<div class="paste">
			<label class="lf-field">Paste sample codes
				<textarea v-model="pasted" rows="3" placeholder="One per line, or separated by commas" />
			</label>
			<div class="lf-row">
				<button type="button" class="lf-btn" :disabled="pasteBusy || !pasted.trim()" @click="addPasted">Add these samples</button>
				<span v-if="pasteNote" class="d1-note" role="status">{{ pasteNote }}</span>
			</div>
		</div>

		<label class="lf-field copies">Copies of each sample
			<input v-model.number="copies" type="number" min="1" :max="MAX_COPIES" step="1" />
		</label>
	</Section>
</template>

<style scoped>
.filters { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; margin-bottom: 10px; }
.grow { flex: 1 1 180px; }
.clear { align-self: center; margin-top: 16px; }
.results { max-height: 360px; overflow: auto; }
.results.busy { opacity: 0.6; }
.row { cursor: pointer; }
.range { margin-top: 6px; }
.picked { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; max-height: 110px; overflow: auto; }
.pill {
	display: inline-flex; align-items: center; gap: 4px; padding: 2px 4px 2px 10px; border-radius: 99px;
	border: 1px solid var(--d1-line); background: var(--d1-tile); font-size: var(--fs-sm, 12px);
}
.pill button { border: 0; background: none; color: var(--d1-dim); font: inherit; font-size: var(--fs-lg, 15px); line-height: 1; padding: 0 6px; cursor: pointer; }
.pill button:hover { color: var(--d1-bad); }
.paste { display: flex; flex-direction: column; gap: 6px; margin-top: 14px; }
.paste textarea { width: 100%; }
.copies { margin-top: 14px; width: 160px; }
</style>
