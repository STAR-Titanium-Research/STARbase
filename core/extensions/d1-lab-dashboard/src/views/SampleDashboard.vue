<template>
	<div class="d1-samples">
		<!-- Panel 1: Sample list -->
		<div class="d1-panel">
			<div class="d1-panel-header">
				<v-icon name="science" />
				<h3>Samples</h3>
			</div>
			<div class="d1-filter-bar">
				<v-input v-model="sampleSearch" placeholder="Search code or nickname…" small @update:model-value="debouncedFetch" />
				<v-select
					v-model="statusFilter"
					:items="statusOptions"
					placeholder="Any status"
					small
					allow-none
					@update:model-value="fetchSamples"
				/>
			</div>
			<div class="d1-list">
				<div
					v-for="s in samples"
					:key="s.sample_id"
					class="d1-row"
					:class="{ active: selectedSampleId === s.sample_id }"
					@click="selectSample(s)"
				>
					<span class="d1-primary">
						{{ s.sample_code }}
						<span v-if="s.current_status" class="d1-badge" :class="`status--${s.current_status}`">
							{{ s.current_status }}
						</span>
					</span>
					<span class="d1-secondary">
						{{ s.nickname ?? '' }}{{ s.nickname && s.material_id?.common_name ? ' · ' : '' }}{{ s.material_id?.common_name ?? '' }}
					</span>
					<span class="d1-secondary">{{ s.project_id?.project_code ?? '' }}</span>
				</div>
				<div v-if="samples.length === 0 && !loadingSamples" class="d1-empty">No samples found</div>
				<div v-if="loadingSamples" class="d1-loading"><v-progress-circular indeterminate /></div>
			</div>
		</div>

		<!-- Panel 2: Sample detail + operations -->
		<div class="d1-panel">
			<div class="d1-panel-header">
				<v-icon name="info" />
				<h3>Sample Detail</h3>
			</div>
			<div v-if="!selectedSample" class="d1-empty">Select a sample</div>
			<div v-else class="d1-detail">
				<div class="d1-detail-section">
					<h4>Identity</h4>
					<div class="d1-kv">
						<span>Code</span><span>{{ selectedSample.sample_code }}</span>
						<span>Nickname</span><span>{{ selectedSample.nickname ?? '—' }}</span>
						<span>Material</span><span>{{ selectedSample.material_id?.common_name ?? '—' }}</span>
						<span>Project</span><span>{{ selectedSample.project_id?.project_code ?? '—' }}</span>
						<span>Status</span><span>{{ selectedSample.current_status ?? '—' }}</span>
						<span>Form</span><span>{{ selectedSample.form ?? '—' }}</span>
						<span>Location</span><span>{{ selectedSample.location ?? '—' }}</span>
					</div>
				</div>

				<div class="d1-detail-section">
					<h4>Dimensions</h4>
					<div class="d1-kv">
						<span>Mass (g)</span><span>{{ selectedSample.mass_grams ?? '—' }}</span>
						<span>Ø (mm)</span><span>{{ selectedSample.diameter_mm ?? '—' }}</span>
						<span>W × L × T (mm)</span>
						<span>
							{{ selectedSample.width_mm ?? '?' }} × {{ selectedSample.length_mm ?? '?' }} × {{ selectedSample.thickness_mm ?? '?' }}
						</span>
					</div>
				</div>

				<div class="d1-detail-section">
					<h4>Manufacturing Operations ({{ operations.length }})</h4>
					<div v-if="loadingOps" class="d1-loading"><v-progress-circular indeterminate small /></div>
					<div v-else-if="operations.length === 0" class="d1-empty-inline">None recorded</div>
					<table v-else class="d1-table">
						<thead>
							<tr>
								<th>Date</th>
								<th>Method</th>
								<th>Machine</th>
								<th>Edge</th>
								<th>Outcome</th>
							</tr>
						</thead>
						<tbody>
							<tr
								v-for="op in operations"
								:key="op.operation_id"
								class="d1-table-row"
								@click="selectOp(op)"
							>
								<td>{{ formatDate(op.operation_date) }}</td>
								<td>{{ op.method_id?.method_name ?? '—' }}</td>
								<td>{{ op.equipment_id?.equipment_name ?? '—' }}</td>
								<td>{{ op.insert_edge_id?.edge_code ?? '—' }}</td>
								<td>{{ op.outcome ?? '—' }}</td>
							</tr>
						</tbody>
					</table>
				</div>
			</div>
		</div>

		<!-- Panel 3: Test sessions -->
		<div class="d1-panel">
			<div class="d1-panel-header">
				<v-icon name="biotech" />
				<h3>Test Sessions</h3>
				<span v-if="selectedSampleId" class="d1-count">{{ testSessions.length }}</span>
			</div>
			<div v-if="!selectedSampleId" class="d1-empty">Select a sample</div>
			<div v-else-if="loadingTests" class="d1-loading"><v-progress-circular indeterminate /></div>
			<div v-else class="d1-list">
				<div
					v-for="ts in testSessions"
					:key="ts.session_id"
					class="d1-row"
					:class="{ active: selectedTestId === ts.session_id }"
					@click="selectTest(ts)"
				>
					<span class="d1-primary">
						{{ ts.test_type ?? '—' }}
						<span class="d1-badge" :class="`status--${ts.status}`">{{ ts.status }}</span>
					</span>
					<span class="d1-secondary">{{ ts.equipment_id?.equipment_name ?? '—' }}</span>
					<span class="d1-date">{{ formatDate(ts.session_date) }}</span>
				</div>
				<div v-if="testSessions.length === 0" class="d1-empty">No test sessions</div>
			</div>
		</div>

		<!-- Panel 4: Node Graph -->
		<div class="d1-panel d1-panel--graph">
			<div class="d1-panel-header">
				<v-icon name="hub" />
				<h3>Connections</h3>
			</div>
			<NodeGraph ref="graphRef" class="d1-graph" />
		</div>
	</div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useD1Items } from '../composables/useD1Items';
import NodeGraph from './NodeGraph.vue';

const { getItems } = useD1Items();

const samples = ref<any[]>([]);
const sampleSearch = ref('');
const statusFilter = ref<string | null>(null);
const loadingSamples = ref(false);

const selectedSampleId = ref<string | null>(null);
const selectedSample = ref<any | null>(null);

const operations = ref<any[]>([]);
const loadingOps = ref(false);

const testSessions = ref<any[]>([]);
const loadingTests = ref(false);
const selectedTestId = ref<string | null>(null);

const graphRef = ref<InstanceType<typeof NodeGraph> | null>(null);

const statusOptions = [
	{ text: 'Active', value: 'active' },
	{ text: 'Consumed', value: 'consumed' },
	{ text: 'Archived', value: 'archived' },
	{ text: 'Lost', value: 'lost' },
];

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function debouncedFetch() {
	if (debounceTimer) clearTimeout(debounceTimer);
	debounceTimer = setTimeout(fetchSamples, 300);
}

async function fetchSamples() {
	loadingSamples.value = true;
	try {
		const params: Record<string, unknown> = {
			'fields[]': [
				'sample_id',
				'sample_code',
				'nickname',
				'current_status',
				'form',
				'location',
				'mass_grams',
				'diameter_mm',
				'width_mm',
				'length_mm',
				'thickness_mm',
				'material_id.common_name',
				'project_id.project_code',
			],
			'sort[]': 'sample_code',
			limit: 300,
		};
		if (sampleSearch.value) {
			// case-insensitive so "9-aa" matches "9-AA-…"
			params['filter[_or][0][sample_code][_icontains]'] = sampleSearch.value;
			params['filter[_or][1][nickname][_icontains]'] = sampleSearch.value;
		}
		if (statusFilter.value) {
			params['filter[current_status][_eq]'] = statusFilter.value;
		}
		samples.value = await getItems('physical_samples', params);
	} finally {
		loadingSamples.value = false;
	}
}

async function selectSample(s: any) {
	selectedSampleId.value = s.sample_id;
	selectedSample.value = s;
	selectedTestId.value = null;
	loadingOps.value = true;
	loadingTests.value = true;

	try {
		[operations.value, testSessions.value] = await Promise.all([
			getItems('manufacturing_operations', {
				'filter[sample_id][_eq]': s.sample_id,
				'fields[]': [
					'*',
					'equipment_id.equipment_name',
					'tool_id.tool_code',
					'insert_edge_id.edge_code',
					'method_id.method_name',
				],
				'sort[]': '-operation_date',
				limit: 200,
			}),
			getItems('test_sessions', {
				'filter[sample_id][_eq]': s.sample_id,
				'fields[]': ['*', 'equipment_id.equipment_name'],
				'sort[]': '-session_date',
				limit: 100,
			}),
		]);
	} finally {
		loadingOps.value = false;
		loadingTests.value = false;
	}

	graphRef.value?.loadNeighbors('physical_samples', s.sample_id);
}

function selectOp(op: any) {
	graphRef.value?.loadNeighbors('manufacturing_operations', op.operation_id);
}

function selectTest(ts: any) {
	selectedTestId.value = ts.session_id;
	graphRef.value?.loadNeighbors('test_sessions', ts.session_id);
}

function formatDate(d: string | null): string {
	if (!d) return '—';
	return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

onMounted(fetchSamples);
</script>

<style scoped>
.d1-samples {
	display: grid;
	grid-template-columns: 240px minmax(300px, 1.3fr) 240px 340px; min-width: 0;
	gap: 12px;
	height: calc(100vh - 120px);
	padding: 12px;
	overflow: hidden;
}

.d1-panel {
	display: flex;
	flex-direction: column;
	background: var(--theme--background, #ffffff);
	border: 1px solid var(--theme--border-color, #e2e8f0);
	border-radius: var(--theme--border-radius, 10px);
	overflow: hidden;
}

.d1-panel--graph {
	overflow: hidden;
}

.d1-panel-header {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 10px 12px;
	border-bottom: 1px solid var(--theme--border-color, #e2e8f0);
	background: var(--theme--background-subdued, #f7f9fb);
	flex-shrink: 0;
}

.d1-panel-header h3 {
	margin: 0;
	font-size: 13px;
	font-weight: 600;
	flex: 1;
}

.d1-filter-bar {
	padding: 8px;
	display: flex;
	flex-direction: column;
	gap: 4px;
	border-bottom: 1px solid var(--theme--border-color-subdued, #eef1f5);
	flex-shrink: 0;
}

.d1-count {
	font-size: 11px;
	background: var(--theme--primary-background, #eef2ff);
	color: var(--theme--primary, #1d4ed8);
	padding: 2px 6px;
	border-radius: 10px;
	font-weight: 600;
}

.d1-list {
	overflow-y: auto;
	flex: 1;
}

.d1-row {
	padding: 8px 12px;
	cursor: pointer;
	border-bottom: 1px solid var(--theme--border-color-subdued, #eef1f5);
	display: flex;
	flex-direction: column;
	gap: 2px;
	transition: background-color .15s ease;
}

.d1-row:hover {
	background: var(--theme--background-accent, #eef2f7);
}

.d1-row.active {
	background: var(--theme--primary-background, #eef2ff);
	border-left: 3px solid var(--theme--primary, #1d4ed8);
}

.d1-primary {
	font-size: 13px;
	font-weight: 500;
	display: flex;
	align-items: center;
	gap: 6px;
}

.d1-secondary {
	font-size: 11px;
	color: var(--theme--foreground-subdued, #64748b);
}

.d1-date {
	font-size: 10px;
	color: var(--theme--foreground-subdued, #64748b);
}

.d1-badge {
	font-size: 10px;
	background: var(--theme--background-accent, #eef2f7);
	padding: 1px 5px;
	border-radius: 4px;
	font-weight: 400;
}

.status--active { background: #e8f5e9; color: #2e7d32; }
.status--consumed { background: #fff3e0; color: #e65100; }
.status--archived { background: #eeeeee; color: #616161; }
.status--lost { background: #fce4ec; color: #c62828; }
.status--completed { background: #e8f5e9; color: #2e7d32; }
.status--in_progress { background: #e3f2fd; color: #1565c0; }
.status--planned { background: #f3e5f5; color: #6a1b9a; }
.status--failed { background: #fce4ec; color: #c62828; }

.d1-empty {
	padding: 24px;
	text-align: center;
	color: var(--theme--foreground-subdued, #64748b);
	font-size: 13px;
}

.d1-empty-inline {
	font-size: 12px;
	color: var(--theme--foreground-subdued, #64748b);
	padding: 4px 0;
}

.d1-loading {
	display: flex;
	justify-content: center;
	padding: 24px;
}

.d1-detail {
	overflow-y: auto;
	flex: 1;
	padding: 12px;
	display: flex;
	flex-direction: column;
	gap: 14px;
}

.d1-detail-section h4 {
	font-size: 11px;
	font-weight: 700;
	text-transform: uppercase;
	letter-spacing: 0.5px;
	color: var(--theme--foreground-subdued, #64748b);
	margin: 0 0 6px;
}

.d1-kv {
	display: grid;
	grid-template-columns: 110px 1fr;
	gap: 4px 8px;
	font-size: 13px;
}

.d1-kv span:nth-child(odd) {
	color: var(--theme--foreground-subdued, #64748b);
}

.d1-kv span:nth-child(even) {
	font-weight: 500;
}

.d1-table {
	width: 100%;
	border-collapse: collapse;
	font-size: 12px;
}

.d1-table th {
	text-align: left;
	padding: 4px 6px;
	border-bottom: 1px solid var(--theme--border-color, #e2e8f0);
	color: var(--theme--foreground-subdued, #64748b);
	font-weight: 600;
	font-size: 11px;
}

.d1-table-row {
	cursor: pointer;
}

.d1-table-row:hover td {
	background: var(--theme--background-accent, #eef2f7);
}

.d1-table td {
	padding: 5px 6px;
	border-bottom: 1px solid var(--theme--border-color-subdued, #eef1f5);
}

.d1-graph {
	flex: 1;
	min-height: 0;
}
</style>
