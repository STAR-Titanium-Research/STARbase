<template>
	<div class="d1-graph-container">
		<div class="d1-graph-toolbar">
			<v-input
				v-if="standalone"
				v-model="searchQuery"
				placeholder="Search any entity…"
				small
				class="d1-graph-search"
				@keydown.enter="handleSearch"
			/>
			<span v-if="focalLabel" class="d1-focal-label">{{ focalLabel }}</span>
			<div class="d1-graph-actions">
				<v-button small secondary icon @click="resetLayout">
					<v-icon name="center_focus_strong" />
				</v-button>
				<v-button small secondary icon @click="clearGraph">
					<v-icon name="clear" />
				</v-button>
			</div>
		</div>
		<div v-if="searchResults.length" class="d1-search-results">
			<div
				v-for="r in searchResults"
				:key="r.id"
				class="d1-search-result"
				@click="loadNeighbors(r.collection, r.id)"
			>
				<span class="d1-search-dot" :style="{ background: NODE_COLORS[r.collection] ?? '#888' }" />
				<span class="d1-search-label">{{ r.label }}</span>
				<span class="d1-search-collection">{{ r.collection }}</span>
			</div>
		</div>
		<div ref="graphEl" class="d1-graph-canvas" />
		<div v-if="loadError" class="d1-graph-error">{{ loadError }}</div>
		<div v-if="loading" class="d1-graph-loading">
			<v-progress-circular indeterminate />
		</div>
		<div v-if="empty" class="d1-graph-empty">Click any item in the dashboard to explore its connections</div>
	</div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed, watch } from 'vue';
import { useRoute } from 'vue-router';
import cytoscape from 'cytoscape';
import { useItems, useRequestGate, errorText } from '@d1/ui';

const props = defineProps<{ standalone?: boolean }>();
const emit = defineEmits<{ (e: 'select', payload: { collection: string; id: string }): void }>();

const { getItems, getItem } = useItems();
const route = useRoute();

const graphEl = ref<HTMLElement | null>(null);
const loading = ref(false);
const searchQuery = ref('');
const searchResults = ref<{ id: string; collection: string; label: string }[]>([]);
const focalLabel = ref('');
const empty = ref(true);
const loadError = ref('');
const loadGate = useRequestGate();
const searchGate = useRequestGate();

let cy: cytoscape.Core | null = null;

const NODE_COLORS: Record<string, string> = {
	physical_samples: '#9C27B0',
	manufacturing_operations: '#FF9800',
	test_sessions: '#00ACC1',
	equipment: '#607D8B',
	tools: '#795548',
	insert_edges: '#E91E63',
	cutting_inserts: '#F44336',
	tool_boxes: '#3F51B5',
	materials: '#4CAF50',
	projects: '#673AB7',
};

const COLLECTION_LABELS: Record<string, string> = {
	physical_samples: 'Sample',
	manufacturing_operations: 'Operation',
	test_sessions: 'Test',
	equipment: 'Equipment',
	tools: 'Tool',
	insert_edges: 'Edge',
	cutting_inserts: 'Insert',
	tool_boxes: 'Box',
	materials: 'Material',
	projects: 'Project',
};

onMounted(() => {
	if (!graphEl.value) return;
	cy = cytoscape({
		container: graphEl.value,
		style: [
			{
				selector: 'node',
				style: {
					'background-color': 'data(color)',
					'background-opacity': 0.92,
					label: 'data(label)',
					'font-size': '10px',
					'font-family': '-apple-system, "Segoe UI", Roboto, sans-serif',
					'font-weight': 600,
					color: '#fff',
					'text-valign': 'center',
					'text-halign': 'center',
					'text-wrap': 'wrap',
					'text-max-width': '78px',
					'text-outline-width': 1.5,
					'text-outline-color': 'data(color)',
					'text-outline-opacity': 0.6,
					width: 'data(size)',
					height: 'data(size)',
					'border-width': 2.5,
					'border-color': '#ffffff',
					'border-opacity': 0.9,
					'transition-property': 'width height border-width',
					'transition-duration': 0.15,
				},
			},
			{
				selector: 'node.focal',
				style: {
					'border-width': 4,
					'border-color': '#1d4ed8',
					'border-opacity': 1,
				},
			},
			{
				selector: 'edge',
				style: {
					width: 1.6,
					'line-color': '#cbd5e1',
					'target-arrow-color': '#cbd5e1',
					'target-arrow-shape': 'triangle',
					'arrow-scale': 0.9,
					'curve-style': 'bezier',
					'font-size': '8.5px',
					'font-family': '-apple-system, "Segoe UI", Roboto, sans-serif',
					label: 'data(label)',
					color: '#64748b',
					'text-background-color': '#ffffff',
					'text-background-opacity': 0.85,
					'text-background-padding': '2px',
					'text-background-shape': 'roundrectangle',
				},
			},
		],
		elements: [],
	});

	cy.on('tap', 'node', (evt) => {
		const { collection, id } = evt.target.data() as { collection: string; id: string };
		loadNeighbors(collection, id);
		emit('select', { collection, id });
	});

	openLinkedSample();
});

// Deep link from the Sample page ("Open lineage graph"): /d1-lab-dashboard/graph?sample=<sample_id>
// opens the graph on that sample. Only the standalone graph reads it; the copy embedded in the
// sample dashboard is driven by clicks there.
function openLinkedSample() {
	const sample = route.query.sample;
	if (props.standalone && typeof sample === 'string' && sample) loadNeighbors('physical_samples', sample);
}
watch(() => route.query.sample, () => openLinkedSample());

onBeforeUnmount(() => {
	loadGate.cancel();
	searchGate.cancel();
	cy?.destroy();
	cy = null;
});

// Operations are labelled by their method ("CNC Turning", "FAST/SPS Sintering"): short enough for
// a graph node, unlike the full operation code, which only the focal node shows.
function opLabel(op: any): string {
	return op.method_id?.method_name ?? 'op';
}

async function loadNeighbors(collection: string, id: string) {
	if (!cy) return;
	const token = loadGate.begin();
	let pendingFocal = '';
	loading.value = true;
	empty.value = false;
	loadError.value = '';
	searchResults.value = [];

	try {
		const nodes: cytoscape.ElementDefinition[] = [];
		const edges: cytoscape.ElementDefinition[] = [];

		function addNode(col: string, nodeId: string, label: string, isFocal = false) {
			const existing = cy!.getElementById(`${col}:${nodeId}`);
			if (existing.length) return;
			nodes.push({
				data: {
					id: `${col}:${nodeId}`,
					collection: col,
					label: `${COLLECTION_LABELS[col] ?? col}\n${label}`,
					color: NODE_COLORS[col] ?? '#888',
					size: isFocal ? 60 : 44,
				},
				classes: isFocal ? 'focal' : '',
			});
		}

		function addEdge(sourceCol: string, sourceId: string, targetCol: string, targetId: string, rel: string) {
			const edgeId = `${sourceCol}:${sourceId}--${rel}--${targetCol}:${targetId}`;
			if (cy!.getElementById(edgeId).length) return;
			edges.push({ data: { id: edgeId, source: `${sourceCol}:${sourceId}`, target: `${targetCol}:${targetId}`, label: rel } });
		}

		if (collection === 'physical_samples') {
			const [sample, ops, tests, genealogy] = await Promise.all([
				getItem('physical_samples', id, { 'fields[]': ['sample_code', 'nickname', 'material_id.material_id', 'material_id.common_name', 'project_id.project_id', 'project_id.project_code'] }),
				getItems('manufacturing_operations', { 'filter[sample_id][_eq]': id, 'fields[]': ['operation_id', 'method_id.method_name', 'equipment_id.equipment_name'], limit: 20 }),
				getItems('test_sessions', { 'filter[sample_id][_eq]': id, 'fields[]': ['session_id', 'test_type', 'status'], limit: 20 }),
				getItems('sample_genealogy', { 'filter[child_sample_id][_eq]': id, 'fields[]': ['parent_sample_id.sample_code', 'parent_sample_id.sample_id'], limit: 10 }),
			]);
			const label = sample.nickname ? `${sample.sample_code} (${sample.nickname})` : sample.sample_code;
			pendingFocal = label;
			addNode(collection, id, label, true);
			if (sample.material_id?.common_name && sample.material_id?.material_id) {
				addNode('materials', sample.material_id.material_id, sample.material_id.common_name);
				addEdge(collection, id, 'materials', sample.material_id.material_id, 'material');
			}
			if (sample.project_id?.project_code && sample.project_id?.project_id) {
				addNode('projects', sample.project_id.project_id, sample.project_id.project_code);
				addEdge(collection, id, 'projects', sample.project_id.project_id, 'project');
			}
			for (const op of ops) {
				addNode('manufacturing_operations', op.operation_id, opLabel(op));
				addEdge(collection, id, 'manufacturing_operations', op.operation_id, 'machined');
			}
			for (const ts of tests) {
				addNode('test_sessions', ts.session_id, ts.test_type ?? ts.status);
				addEdge(collection, id, 'test_sessions', ts.session_id, 'tested');
			}
			for (const g of genealogy) {
				if (g.parent_sample_id?.sample_id) {
					addNode('physical_samples', g.parent_sample_id.sample_id, g.parent_sample_id.sample_code);
					addEdge('physical_samples', g.parent_sample_id.sample_id, collection, id, 'parent→child');
				}
			}
		} else if (collection === 'manufacturing_operations') {
			const op = await getItem('manufacturing_operations', id, {
				'fields[]': ['*', 'sample_id.sample_code', 'sample_id.sample_id', 'equipment_id.equipment_name', 'equipment_id.equipment_id', 'tool_id.tool_code', 'tool_id.tool_id', 'insert_edge_id.edge_code', 'insert_edge_id.edge_id', 'method_id.method_name', 'method_id.method_id'],
			});
			const label = op.pass_code || opLabel(op);
			pendingFocal = `Operation: ${label}`;
			addNode(collection, id, label, true);
			if (op.sample_id?.sample_id) {
				addNode('physical_samples', op.sample_id.sample_id, op.sample_id.sample_code);
				addEdge('physical_samples', op.sample_id.sample_id, collection, id, 'machined');
			}
			if (op.equipment_id?.equipment_id) {
				addNode('equipment', op.equipment_id.equipment_id, op.equipment_id.equipment_name);
				addEdge(collection, id, 'equipment', op.equipment_id.equipment_id, 'machine');
			}
			if (op.tool_id?.tool_id) {
				addNode('tools', op.tool_id.tool_id, op.tool_id.tool_code);
				addEdge(collection, id, 'tools', op.tool_id.tool_id, 'tool');
			}
			if (op.insert_edge_id?.edge_id) {
				addNode('insert_edges', op.insert_edge_id.edge_id, op.insert_edge_id.edge_code);
				addEdge(collection, id, 'insert_edges', op.insert_edge_id.edge_id, 'edge');
			}
		} else if (collection === 'equipment') {
			const [eq, ops] = await Promise.all([
				getItem('equipment', id, { 'fields[]': ['equipment_name', 'equipment_type', 'project_id.project_id', 'project_id.project_code'] }),
				getItems('manufacturing_operations', { 'filter[equipment_id][_eq]': id, 'fields[]': ['operation_id', 'method_id.method_name', 'sample_id.sample_code', 'sample_id.sample_id', 'project_id.project_id', 'project_id.project_code'], limit: 20 }),
			]);
			pendingFocal = eq.equipment_name;
			addNode(collection, id, `${eq.equipment_name}`, true);
			// Primary project assignment
			if (eq.project_id?.project_id) {
				addNode('projects', eq.project_id.project_id, eq.project_id.project_code);
				addEdge(collection, id, 'projects', eq.project_id.project_id, 'assigned to');
			}
			const samplesSeen = new Set<string>();
			const projectsSeen = new Set<string>(eq.project_id?.project_id ? [eq.project_id.project_id] : []);
			for (const op of ops) {
				addNode('manufacturing_operations', op.operation_id, opLabel(op));
				addEdge(collection, id, 'manufacturing_operations', op.operation_id, 'ran');
				if (op.sample_id?.sample_id && !samplesSeen.has(op.sample_id.sample_id)) {
					samplesSeen.add(op.sample_id.sample_id);
					addNode('physical_samples', op.sample_id.sample_id, op.sample_id.sample_code);
					addEdge('manufacturing_operations', op.operation_id, 'physical_samples', op.sample_id.sample_id, 'on');
				}
				// Bubble up project nodes found via operations
				if (op.project_id?.project_id && !projectsSeen.has(op.project_id.project_id)) {
					projectsSeen.add(op.project_id.project_id);
					addNode('projects', op.project_id.project_id, op.project_id.project_code);
					addEdge('manufacturing_operations', op.operation_id, 'projects', op.project_id.project_id, 'in project');
				}
			}
		} else if (collection === 'insert_edges') {
			const [edge, ops] = await Promise.all([
				getItem('insert_edges', id, { 'fields[]': ['edge_code', 'insert_id.insert_code', 'insert_id.insert_id'] }),
				getItems('manufacturing_operations', { 'filter[insert_edge_id][_eq]': id, 'fields[]': ['operation_id', 'method_id.method_name', 'sample_id.sample_code', 'sample_id.sample_id', 'project_id.project_id', 'project_id.project_code'], limit: 15 }),
			]);
			pendingFocal = edge.edge_code;
			addNode(collection, id, edge.edge_code, true);
			if (edge.insert_id?.insert_id) {
				addNode('cutting_inserts', edge.insert_id.insert_id, edge.insert_id.insert_code);
				addEdge('cutting_inserts', edge.insert_id.insert_id, collection, id, 'edge');
			}
			const projectsSeen = new Set<string>();
			for (const op of ops) {
				addNode('manufacturing_operations', op.operation_id, opLabel(op));
				addEdge(collection, id, 'manufacturing_operations', op.operation_id, 'used in');
				if (op.sample_id?.sample_id) {
					addNode('physical_samples', op.sample_id.sample_id, op.sample_id.sample_code);
					addEdge('manufacturing_operations', op.operation_id, 'physical_samples', op.sample_id.sample_id, 'on');
				}
				if (op.project_id?.project_id && !projectsSeen.has(op.project_id.project_id)) {
					projectsSeen.add(op.project_id.project_id);
					addNode('projects', op.project_id.project_id, op.project_id.project_code);
					addEdge('manufacturing_operations', op.operation_id, 'projects', op.project_id.project_id, 'in project');
				}
			}
		} else if (collection === 'cutting_inserts') {
			const insert = await getItem('cutting_inserts', id, { 'fields[]': ['insert_code', 'tool_box_id.tool_box_code', 'tool_box_id.tool_box_id', 'insert_type_id.type_code', 'insert_type_id.insert_type_id'] });
			pendingFocal = insert.insert_code;
			addNode(collection, id, insert.insert_code, true);
			if (insert.tool_box_id?.tool_box_id) {
				addNode('tool_boxes', insert.tool_box_id.tool_box_id, insert.tool_box_id.tool_box_code);
				addEdge('tool_boxes', insert.tool_box_id.tool_box_id, collection, id, 'contains');
			}
			const edges = await getItems('insert_edges', { 'filter[insert_id][_eq]': id, 'fields[]': ['edge_id', 'edge_code', 'is_used'], limit: 20 });
			for (const e of edges) {
				addNode('insert_edges', e.edge_id, `${e.edge_code}${e.is_used ? ' ✓' : ''}`);
				addEdge(collection, id, 'insert_edges', e.edge_id, 'edge');
			}
		} else if (collection === 'tool_boxes') {
			const [box, inserts] = await Promise.all([
				getItem('tool_boxes', id, { 'fields[]': ['tool_box_code', 'insert_type_id.type_code', 'project_id.project_id', 'project_id.project_code'] }),
				getItems('cutting_inserts', { 'filter[tool_box_id][_eq]': id, 'fields[]': ['insert_id', 'insert_code'], limit: 20 }),
			]);
			pendingFocal = box.tool_box_code;
			addNode(collection, id, box.tool_box_code, true);
			if (box.project_id?.project_id) {
				addNode('projects', box.project_id.project_id, box.project_id.project_code);
				addEdge(collection, id, 'projects', box.project_id.project_id, 'assigned to');
			}
			for (const ins of inserts) {
				addNode('cutting_inserts', ins.insert_id, ins.insert_code);
				addEdge(collection, id, 'cutting_inserts', ins.insert_id, 'contains');
			}
		} else if (collection === 'test_sessions') {
			const ts = await getItem('test_sessions', id, { 'fields[]': ['test_type', 'status', 'sample_id.sample_code', 'sample_id.sample_id', 'equipment_id.equipment_name', 'equipment_id.equipment_id', 'project_id.project_id', 'project_id.project_code'] });
			pendingFocal = `Test: ${ts.test_type ?? ts.status}`;
			addNode(collection, id, `${ts.test_type ?? 'test'}\n${ts.status}`, true);
			if (ts.sample_id?.sample_id) {
				addNode('physical_samples', ts.sample_id.sample_id, ts.sample_id.sample_code);
				addEdge('physical_samples', ts.sample_id.sample_id, collection, id, 'tested');
			}
			if (ts.equipment_id?.equipment_id) {
				addNode('equipment', ts.equipment_id.equipment_id, ts.equipment_id.equipment_name);
				addEdge(collection, id, 'equipment', ts.equipment_id.equipment_id, 'machine');
			}
			if (ts.project_id?.project_id) {
				addNode('projects', ts.project_id.project_id, ts.project_id.project_code);
				addEdge(collection, id, 'projects', ts.project_id.project_id, 'in project');
			}
		} else {
			// Generic fallback: just show the focal node
			addNode(collection, id, id, true);
			pendingFocal = `${COLLECTION_LABELS[collection] ?? collection}: ${id}`;
		}

		// A newer click (or unmount) superseded this load: drop its result.
		if (!loadGate.isCurrent(token) || !cy) return;
		focalLabel.value = pendingFocal;
		cy.add([...nodes, ...edges]);
		runLayout();
	} catch (err) {
		console.error('[NodeGraph] loadNeighbors error', err);
		if (loadGate.isCurrent(token)) loadError.value = `Could not load connections: ${errorText(err)}`;
	} finally {
		if (loadGate.isCurrent(token)) loading.value = false;
	}
}

async function handleSearch() {
	const q = searchQuery.value.trim();
	const token = searchGate.begin();
	if (!q) { searchResults.value = []; return; }
	const results: typeof searchResults.value = [];
	loadError.value = '';

	let samples: any[], ops: any[], tests: any[], equipment: any[], inserts: any[], edges: any[], boxes: any[];
	try {
		[samples, ops, tests, equipment, inserts, edges, boxes] = await Promise.all([
			getItems('physical_samples', { 'filter[sample_code][_icontains]': q, 'fields[]': ['sample_id', 'sample_code'], limit: 5 }),
			getItems('manufacturing_operations', { 'filter[pass_code][_icontains]': q, 'fields[]': ['operation_id', 'pass_code'], limit: 5 }),
			getItems('test_sessions', { 'filter[test_type][_icontains]': q, 'fields[]': ['session_id', 'test_type'], limit: 5 }),
			getItems('equipment', { 'filter[equipment_name][_icontains]': q, 'fields[]': ['equipment_id', 'equipment_name'], limit: 5 }),
			getItems('cutting_inserts', { 'filter[insert_code][_icontains]': q, 'fields[]': ['insert_id', 'insert_code'], limit: 5 }),
			getItems('insert_edges', { 'filter[edge_code][_icontains]': q, 'fields[]': ['edge_id', 'edge_code'], limit: 5 }),
			getItems('tool_boxes', { 'filter[tool_box_code][_icontains]': q, 'fields[]': ['tool_box_id', 'tool_box_code'], limit: 5 }),
		]);
	} catch (err) {
		if (searchGate.isCurrent(token)) loadError.value = `Search failed: ${errorText(err)}`;
		return;
	}
	if (!searchGate.isCurrent(token)) return; // a newer search replaced this one

	for (const s of samples) results.push({ id: s.sample_id, collection: 'physical_samples', label: s.sample_code });
	for (const o of ops) results.push({ id: o.operation_id, collection: 'manufacturing_operations', label: o.pass_code });
	for (const t of tests) results.push({ id: t.session_id, collection: 'test_sessions', label: t.test_type });
	for (const e of equipment) results.push({ id: e.equipment_id, collection: 'equipment', label: e.equipment_name });
	for (const i of inserts) results.push({ id: i.insert_id, collection: 'cutting_inserts', label: i.insert_code });
	for (const e of edges) results.push({ id: e.edge_id, collection: 'insert_edges', label: e.edge_code });
	for (const b of boxes) results.push({ id: b.tool_box_id, collection: 'tool_boxes', label: b.tool_box_code });

	searchResults.value = results;
}

// Stable, deterministic radial layout: focal node centred, its neighbours ringed
// around it — far calmer than the jittery force-directed `cose`.
function runLayout() {
	if (!cy) return;
	cy.layout({
		name: 'concentric',
		concentric: (node: any) => (node.hasClass('focal') ? 10 : 1),
		levelWidth: () => 1,
		minNodeSpacing: 46,
		spacingFactor: 1.05,
		animate: true,
		animationDuration: 350,
		fit: true,
		padding: 44,
	}).run();
}

function resetLayout() {
	runLayout();
}

function clearGraph() {
	cy?.elements().remove();
	focalLabel.value = '';
	searchResults.value = [];
	empty.value = true;
}

defineExpose({ loadNeighbors });
</script>

<style scoped>
.d1-graph-container {
	display: flex;
	flex-direction: column;
	height: 100%;
	position: relative;
}

.d1-graph-toolbar {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 6px 10px;
	border-bottom: 1px solid var(--theme--border-color-subdued, #eef1f5);
	flex-shrink: 0;
}

.d1-graph-search {
	flex: 1;
}

.d1-focal-label {
	font-size: 11px;
	color: var(--theme--foreground-subdued, #64748b);
	flex: 1;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.d1-graph-actions {
	display: flex;
	gap: 4px;
	flex-shrink: 0;
}

.d1-search-results {
	position: absolute;
	top: 40px;
	left: 10px;
	right: 10px;
	background: var(--theme--background, #ffffff);
	border: 1px solid var(--theme--border-color, #e2e8f0);
	border-radius: var(--theme--border-radius, 10px);
	z-index: 10;
	max-height: 200px;
	overflow-y: auto;
	box-shadow: 0 4px 16px rgba(15,23,42,.10);
}

.d1-search-result {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 6px 10px;
	cursor: pointer;
	font-size: 12px;
}

.d1-search-result:hover {
	background: var(--theme--background-accent, #eef2f7);
}

.d1-search-dot {
	width: 10px;
	height: 10px;
	border-radius: 50%;
	flex-shrink: 0;
}

.d1-search-label {
	flex: 1;
	font-weight: 500;
}

.d1-search-collection {
	color: var(--theme--foreground-subdued, #64748b);
	font-size: 10px;
}

.d1-graph-canvas {
	flex: 1;
	min-height: 0;
}

.d1-graph-loading {
	position: absolute;
	inset: 0;
	display: flex;
	align-items: center;
	justify-content: center;
	background: rgba(255,255,255,.75);
}

.d1-graph-error {
	position: absolute;
	left: 8px;
	right: 8px;
	bottom: 8px;
	padding: 6px 10px;
	font-size: 12px;
	color: var(--theme--danger, #c62828);
	background: var(--theme--background, #ffffff);
	border: 1px solid var(--theme--danger, #c62828);
	border-radius: 6px;
}

.d1-graph-empty {
	position: absolute;
	inset: 0;
	display: flex;
	align-items: center;
	justify-content: center;
	color: var(--theme--foreground-subdued, #64748b);
	font-size: 13px;
	text-align: center;
	padding: 24px;
	pointer-events: none;
}
</style>
