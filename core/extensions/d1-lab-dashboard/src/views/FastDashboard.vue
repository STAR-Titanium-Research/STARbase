<template>
	<div class="d1-fast">
		<!-- Panel 1: FAST operations -->
		<div class="d1-panel">
			<div class="d1-panel-header">
				<v-icon name="local_fire_department" />
				<h3>FAST / Sinter Runs</h3>
				<span class="d1-count">{{ operations.length }}</span>
			</div>
			<div class="d1-filter-bar">
				<v-input v-model="search" placeholder="Search code or sample…" small @update:model-value="debouncedFetch" />
			</div>
			<div class="d1-list">
				<div v-if="loadingOps" class="d1-loading"><v-progress-circular indeterminate /></div>
				<template v-else>
					<div
						v-for="op in operations"
						:key="op.operation_id"
						class="d1-row"
						:class="{ active: selectedOp?.operation_id === op.operation_id }"
						@click="selectOp(op)"
					>
						<span class="d1-primary">{{ op.pass_code ?? '—' }}</span>
						<span class="d1-secondary">
							{{ op.sample_id?.sample_code ?? 'no sample' }}
							<template v-if="op.sintering_max_temp_celsius"> · {{ op.sintering_max_temp_celsius }}°C</template>
						</span>
						<span class="d1-date">{{ formatDate(op.operation_date) }}</span>
					</div>
					<div v-if="opsError" class="d1-error">{{ opsError }}</div>
					<div v-else-if="operations.length === 0" class="d1-empty">No FAST runs found</div>
				</template>
			</div>
		</div>

		<!-- Panel 2: Run detail -->
		<div class="d1-panel">
			<div class="d1-panel-header"><v-icon name="info" /><h3>Run Detail</h3></div>
			<div v-if="!selectedOp" class="d1-empty">Select a FAST run</div>
			<div v-else class="d1-detail">
				<div class="d1-detail-section">
					<router-link class="d1-open" :to="recordRoute('manufacturing_operations', selectedOp.operation_id)">
						<v-icon name="open_in_new" small />Open run
					</router-link>
					<router-link v-if="selectedOp.sample_id?.sample_id" class="d1-open" :to="recordRoute('physical_samples', selectedOp.sample_id.sample_id)">
						<v-icon name="open_in_new" small />Open sample
					</router-link>
				</div>
				<div class="d1-detail-section">
					<h4>Identity</h4>
					<div class="d1-kv">
						<span>Code</span><span>{{ selectedOp.pass_code ?? '—' }}</span>
						<span>Sample</span><span>{{ selectedOp.sample_id?.sample_code ?? '—' }}</span>
						<span>Machine</span><span>{{ selectedOp.equipment_id?.equipment_name ?? '—' }}</span>
						<span>Date</span><span>{{ formatDate(selectedOp.operation_date) }}</span>
					</div>
				</div>
				<div class="d1-detail-section">
					<h4>Sinter Cycle</h4>
					<div class="d1-kv">
						<span>Max temp</span><span>{{ fmt(selectedOp.sintering_max_temp_celsius, '°C') }}</span>
						<span>Max force</span><span>{{ fmt(selectedOp.sintering_max_force_kn, 'kN') }}</span>
						<span>Mould Ø</span><span>{{ fmt(selectedOp.sintering_mould_diameter_mm, 'mm') }}</span>
						<span>Atmosphere</span><span>{{ selectedOp.sintering_atmosphere ?? '—' }}</span>
						<span>Recipe</span><span>{{ selectedOp.sintering_recipe_number ?? '—' }}</span>
						<span>Batch</span><span>{{ selectedOp.sintering_batch_number ?? '—' }}</span>
					</div>
				</div>
				<div class="d1-detail-section">
					<h4>Notes</h4>
					<p class="d1-notes">{{ selectedOp.notes || '—' }}</p>
				</div>
			</div>
		</div>

		<!-- Panel 3: Node graph -->
		<div class="d1-panel d1-panel--graph">
			<div class="d1-panel-header"><v-icon name="hub" /><h3>Connections</h3></div>
			<NodeGraph ref="graphRef" class="d1-graph" />
		</div>
	</div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { useItems, useRequestGate, errorText, recordRoute } from '@d1/ui';
import NodeGraph from './NodeGraph.vue';

const { getItems } = useItems();

const operations = ref<any[]>([]);
const loadingOps = ref(false);
const opsError = ref('');
const opsGate = useRequestGate();
const search = ref('');
const selectedOp = ref<any | null>(null);
const graphRef = ref<InstanceType<typeof NodeGraph> | null>(null);

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedFetch() {
	if (debounceTimer) clearTimeout(debounceTimer);
	debounceTimer = setTimeout(fetchOps, 300);
}

async function fetchOps() {
	const token = opsGate.begin();
	loadingOps.value = true;
	opsError.value = '';
	try {
		const params: Record<string, unknown> = {
			'filter[process_category][_eq]': 'sintering',
			'fields[]': ['*', 'sample_id.sample_id', 'sample_id.sample_code', 'equipment_id.equipment_name'],
			'sort[]': '-operation_date',
			limit: 300,
		};
		if (search.value) {
			params['filter[_or][0][pass_code][_icontains]'] = search.value;
			params['filter[_or][1][sample_id][sample_code][_icontains]'] = search.value;
		}
		const rows = await getItems('manufacturing_operations', params);
		if (!opsGate.isCurrent(token)) return; // a newer search replaced this one
		operations.value = rows;
	} catch (e) {
		if (!opsGate.isCurrent(token)) return;
		opsError.value = `Could not load FAST runs: ${errorText(e)}`;
	} finally {
		if (opsGate.isCurrent(token)) loadingOps.value = false;
	}
}

function selectOp(op: any) {
	selectedOp.value = op;
	graphRef.value?.loadNeighbors('manufacturing_operations', op.operation_id);
}

function fmt(v: any, unit: string): string {
	return v === null || v === undefined || v === '' ? '—' : `${v} ${unit}`;
}
function formatDate(d: string | null): string {
	if (!d) return '—';
	return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

onMounted(fetchOps);

onBeforeUnmount(() => {
	if (debounceTimer) clearTimeout(debounceTimer);
	opsGate.cancel();
});
</script>

<style scoped>
.d1-error {
	padding: 10px 12px;
	font-size: 12px;
	color: var(--theme--danger, #c62828);
}

.d1-fast {
	display: grid;
	grid-template-columns: 280px 1fr 340px;
	gap: 14px;
	height: calc(100vh - 120px);
	padding: 14px;
	overflow: hidden;
}
.d1-panel {
	display: flex; flex-direction: column;
	background: var(--theme--background, #fff);
	border: 1px solid var(--theme--border-color-subdued, #eef1f5);
	border-radius: var(--theme--border-radius, 12px);
	box-shadow: 0 2px 10px rgba(15, 23, 42, .05);
	overflow: hidden;
}
.d1-panel-header {
	display: flex; align-items: center; gap: 8px; padding: 12px 14px;
	border-bottom: 1px solid var(--theme--border-color-subdued, #eef1f5);
	background: var(--theme--background-subdued, #f7f9fb); flex-shrink: 0;
}
.d1-panel-header h3 { margin: 0; font-size: 13px; font-weight: 700; flex: 1; }
.d1-filter-bar { padding: 8px; border-bottom: 1px solid var(--theme--border-color-subdued, #eef1f5); flex-shrink: 0; }
.d1-count {
	font-size: 11px; background: var(--theme--primary-background, #eef2ff); color: var(--theme--primary, #1d4ed8);
	padding: 2px 8px; border-radius: 99px; font-weight: 700;
}
.d1-list { overflow-y: auto; flex: 1; }
.d1-row {
	padding: 9px 14px; cursor: pointer; border-bottom: 1px solid var(--theme--border-color-subdued, #eef1f5);
	display: flex; flex-direction: column; gap: 2px; transition: background-color .15s ease;
}
.d1-row:hover { background: var(--theme--background-subdued, #f7f9fb); }
.d1-row.active { background: var(--theme--primary-background, #eef2ff); border-left: 3px solid var(--theme--primary, #1d4ed8); }
.d1-primary { font-size: 13px; font-weight: 600; font-family: "SF Mono", Menlo, Consolas, monospace; }
.d1-secondary { font-size: 11px; color: var(--theme--foreground-subdued, #64748b); }
.d1-date { font-size: 10px; color: var(--theme--foreground-subdued, #94a3b8); }
.d1-empty { padding: 24px; text-align: center; color: var(--theme--foreground-subdued, #64748b); font-size: 13px; }
.d1-loading { display: flex; justify-content: center; padding: 24px; }
.d1-detail { overflow-y: auto; flex: 1; padding: 14px; display: flex; flex-direction: column; gap: 14px; }
.d1-open {
	display: flex;
	align-items: center;
	gap: 4px;
	width: fit-content;
	font-size: 12px;
	color: var(--theme--primary, #2563eb);
	text-decoration: none;
}

.d1-open:hover {
	text-decoration: underline;
}

.d1-detail-section h4 {
	font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px;
	color: var(--theme--foreground-subdued, #64748b); margin: 0 0 6px;
}
.d1-kv { display: grid; grid-template-columns: 100px 1fr; gap: 5px 8px; font-size: 13px; }
.d1-kv span:nth-child(odd) { color: var(--theme--foreground-subdued, #64748b); }
.d1-kv span:nth-child(even) { font-weight: 600; }
.d1-notes { font-size: 13px; margin: 0; white-space: pre-wrap; }
.d1-graph { flex: 1; min-height: 0; }
</style>
