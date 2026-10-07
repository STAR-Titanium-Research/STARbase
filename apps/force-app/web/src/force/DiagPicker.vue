<script setup lang="ts">
// Operation picker for the Diagnostics page: a searchable list grouped by sample (or campaign),
// with Needs build / Built / Error chips, per-row Open in Plot / Open in Directus links and
// tick boxes for "Apply recipe to selected". Filtering, grouping and windowing are the pure
// functions in @d1/force-plotting's diagPicker.ts; this component only renders them. Long lists
// show PAGE rows at a time with "Show more".
import { computed, ref, watch } from 'vue';
import {
	BUCKETS, BUCKET_LABEL, bucketOf, countByBucket, filterRows, groupRows, useForceHost, windowGroups,
	type GroupBy, type PickerBucket, type PickerRow,
} from '@d1/force-plotting';

const PAGE = 100;
const props = defineProps<{
	rows: PickerRow[];
	selectedId: string | null;
	checked: string[];
	loading?: boolean;
	disabled?: boolean;
	/** Campaign names are readable by this role; false hides the Campaign grouping. */
	byCampaign?: boolean;
}>();
const emit = defineEmits<{
	(e: 'select', id: string): void;
	(e: 'update:checked', ids: string[]): void;
}>();

const query = ref('');
const buckets = ref<Set<PickerBucket>>(new Set());
const by = ref<GroupBy>('sample');
// Without campaign records there is nothing to group by; fall back to sample.
const campaignsOk = computed(() => props.byCampaign !== false);
watch(campaignsOk, (ok) => { if (!ok) by.value = 'sample'; });
const limit = ref(PAGE);

const counts = computed(() => countByBucket(props.rows));
const filtered = computed(() => filterRows(props.rows, query.value, buckets.value));
const shown = computed(() => windowGroups(groupRows(filtered.value, by.value), limit.value));
const checkedSet = computed(() => new Set(props.checked));

// A new search or chip starts from the first page again.
watch([query, buckets, by], () => { limit.value = PAGE; }, { deep: true });

function toggleBucket(b: PickerBucket) {
	const next = new Set(buckets.value);
	if (next.has(b)) next.delete(b); else next.add(b);
	buckets.value = next;
}
function toggleOne(id: string) { toggleGroup([id], !checkedSet.value.has(id)); }
function toggleGroup(ids: string[], on: boolean) {
	const next = new Set(props.checked);
	for (const id of ids) { if (on) next.add(id); else next.delete(id); }
	emit('update:checked', [...next]);
}
function selectAllFiltered() { toggleGroup(filtered.value.map((r) => r.id), true); }
function clearChecked() { emit('update:checked', []); }
function groupAllChecked(ids: string[]) { return ids.length > 0 && ids.every((i) => checkedSet.value.has(i)); }

function tag(r: PickerRow): string {
	const b = bucketOf(r);
	if (b === 'built') return '✓';
	if (b === 'error') return '✗';
	return r.diag_status === 'pending' || r.diag_status === 'processing' ? '…' : '·';
}
function openInDirectus(id: string) { useForceHost().openRecord('machining_force_analysis', id); }
</script>

<template>
	<aside class="dp" aria-label="Operations">
		<div class="dp-top">
			<input
				v-model="query" class="dp-search" type="search" :placeholder="campaignsOk ? 'Search code, sample, campaign…' : 'Search code, sample…'"
				aria-label="Search operations" :disabled="disabled"
			>
			<div class="dp-chips" role="group" aria-label="Filter by diagnostics state">
				<button
					v-for="b in BUCKETS" :key="b" type="button" class="dp-chip" :class="{ on: buckets.has(b) }"
					:aria-pressed="buckets.has(b)" @click="toggleBucket(b)"
				>{{ BUCKET_LABEL[b] }} <span class="dp-n">{{ counts[b] }}</span></button>
			</div>
			<div class="dp-tools">
				<label>Group by
					<select v-model="by" aria-label="Group by">
						<option value="sample">Sample</option>
						<option v-if="campaignsOk" value="campaign">Campaign</option>
					</select>
				</label>
				<button type="button" class="dp-link" :disabled="disabled || !filtered.length" @click="selectAllFiltered">Tick all {{ filtered.length }}</button>
				<button type="button" class="dp-link" :disabled="!checked.length" @click="clearChecked">Clear ({{ checked.length }})</button>
			</div>
		</div>

		<div class="dp-list">
			<p v-if="loading && !rows.length" class="dp-empty">Loading…</p>
			<p v-else-if="!rows.length" class="dp-empty">No analysed operations</p>
			<p v-else-if="!filtered.length" class="dp-empty">Nothing matches.</p>
			<section v-for="g in shown.groups" :key="g.key || '__none'" class="dp-group">
				<header>
					<input
						type="checkbox" :checked="groupAllChecked(g.rows.map((r) => r.id))" :disabled="disabled"
						:aria-label="`Tick every operation in ${g.label}`"
						@change="toggleGroup(g.rows.map((r) => r.id), ($event.target as HTMLInputElement).checked)"
					>
					<strong>{{ g.label }}</strong>
					<span v-if="g.sub" class="dp-sub">{{ g.sub }}</span>
				</header>
				<div v-for="r in g.rows" :key="r.id" class="dp-row" :class="{ sel: r.id === selectedId }">
					<input
						type="checkbox" :checked="checkedSet.has(r.id)" :disabled="disabled"
						:aria-label="`Tick ${r.code}`" @change="toggleOne(r.id)"
					>
					<button
						type="button" class="dp-pick" :disabled="disabled" :aria-current="r.id === selectedId ? 'true' : undefined"
						@click="emit('select', r.id)"
					>
						<span class="dp-tag" :class="bucketOf(r)">{{ tag(r) }}</span> {{ r.code }}
					</button>
					<router-link
						v-if="r.operation_id" class="dp-link" :to="{ path: '/plot', query: { operation: r.operation_id } }"
						title="Open this operation in Plot"
					>Plot</router-link>
					<button type="button" class="dp-link" title="Open the analysis record in Directus" @click="openInDirectus(r.id)">Directus</button>
				</div>
			</section>
			<button v-if="shown.hidden > 0" type="button" class="dp-more" @click="limit += PAGE">
				Show more ({{ shown.hidden }} hidden)
			</button>
		</div>
	</aside>
</template>

<style scoped>
.dp { width: 300px; flex: none !important; display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--border); font-size: var(--fs-sm); }
.dp-top { padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; border-bottom: 1px solid var(--border); }
.dp-search { font: inherit; padding: 5px 8px; background: var(--bg-2); color: var(--text, #e5e7eb); border: 1px solid var(--border); border-radius: 6px; }
.dp-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.dp-chip { font: inherit; font-size: var(--fs-xs); padding: 2px 8px; border-radius: 10px; cursor: pointer; background: var(--bg-2); color: var(--text, #e5e7eb); border: 1px solid var(--border); }
.dp-chip.on { border-color: var(--accent, #38bdf8); color: var(--accent, #38bdf8); }
.dp-n { color: var(--text-dim); font-variant-numeric: tabular-nums; }
.dp-tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; color: var(--text-dim); font-size: var(--fs-xs); }
.dp-tools select { font: inherit; background: var(--bg-2); color: var(--text, #e5e7eb); border: 1px solid var(--border); border-radius: 5px; }
.dp-list { flex: 1; min-height: 0; overflow: auto; }
.dp-empty { margin: 0; padding: 12px; color: var(--text-dim); }
.dp-group > header { position: sticky; top: 0; display: flex; align-items: baseline; gap: 6px; padding: 5px 10px; background: var(--bg-1, var(--bg-2)); border-bottom: 1px solid var(--border); }
.dp-sub { color: var(--text-dim); font-size: var(--fs-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dp-row { display: flex; align-items: center; gap: 6px; padding: 2px 10px; }
.dp-row.sel { background: color-mix(in srgb, var(--accent, #38bdf8) 16%, transparent); }
.dp-pick { flex: 1; min-width: 0; text-align: left; font: inherit; padding: 3px 4px; background: transparent; color: inherit; border: 0; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dp-tag { display: inline-block; width: 1.2em; text-align: center; }
.dp-tag.built { color: var(--ok, #4ade80); }
.dp-tag.error { color: var(--danger, #fca5a5); }
.dp-link { font: inherit; font-size: var(--fs-xs); padding: 0; background: transparent; border: 0; color: var(--accent, #38bdf8); cursor: pointer; text-decoration: underline; }
.dp-link:disabled { opacity: 0.45; cursor: not-allowed; }
.dp-more { margin: 8px 10px; font: inherit; padding: 4px 10px; cursor: pointer; background: var(--bg-2); color: var(--text, #e5e7eb); border: 1px solid var(--border); border-radius: 6px; }
button:focus-visible, input:focus-visible, select:focus-visible, a:focus-visible { outline: 2px solid color-mix(in srgb, var(--accent, #38bdf8) 55%, transparent); }
</style>
