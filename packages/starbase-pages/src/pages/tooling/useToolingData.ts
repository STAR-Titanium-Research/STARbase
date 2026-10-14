import { computed, onBeforeUnmount, ref, shallowRef, watch, type Ref } from 'vue';
import {
	LIST_CAP, buildToolingModel, chunkIds, countsByKey, edgeJunctionCountParams, edgeTestsFilter, errorText, findEdge, findInsert, focusFromRoute,
	focusKindOf, isNotVisible, junctionCountsByEdge, mergeEdgeCounts, nextFreshEdge, useItems, useRequestGate, useSections,
	type FocusKind, type ToolingModel,
} from '@d1/ui';

// Everything the tooling record page reads, as the signed-in user (so Directus permissions apply).
// One page serves tool boxes, cutting inserts and insert edges, so this composable keeps two things apart:
//   - the focused record (the route's box, insert or edge): it alone decides between "page" and
//     "Not found or not visible to you", and it reloads on every route change;
//   - the model of the whole box (box, insert type, inserts, edges): it reloads only when the box id
//     changes (or on reload()), so moving between records of one box never reloads it, and the 3D
//     stage never has to remount.
// An edge's history, and the per-edge history counts of the box, are sections that fail on their own.

const TYPE_FIELDS = [
	'insert_type_id.insert_type_id', 'insert_type_id.type_code', 'insert_type_id.iso_designation', 'insert_type_id.manufacturer',
	'insert_type_id.manufacturer_id.name', 'insert_type_id.coating', 'insert_type_id.substrate', 'insert_type_id.material_class',
	'insert_type_id.inserts_per_box', 'insert_type_id.edge_count', 'insert_type_id.nose_radius_mm', 'insert_type_id.cutting_edge_length_mm',
	'insert_type_id.included_angle_deg', 'insert_type_id.fixing_hole_diameter_mm',
];
const BOX_FIELDS = [
	'tool_box_id', 'tool_box_code', 'description', 'location', 'package_quantity', 'notes', 'created_at', 'updated_at', 'version',
	'project_id.project_id', 'project_id.project_code', 'owner_person_id.person_id', 'owner_person_id.full_name',
	...TYPE_FIELDS,
];
const INSERT_FIELDS = ['insert_id', 'insert_code', 'tool_box_id', 'insert_number', 'is_depleted', 'location', 'notes', 'created_at', 'updated_at', 'version'];
const EDGE_FIELDS = [
	'edge_id', 'edge_code', 'edge_identifier', 'is_used', 'notes', 'created_at', 'updated_at', 'version',
	'insert_id.insert_id', 'insert_id.insert_code', 'insert_id.tool_box_id',
];
// What the model needs of every insert and edge of the box.
const MODEL_INSERT_FIELDS = ['insert_id', 'insert_code', 'tool_box_id', 'insert_number', 'is_depleted'];
const MODEL_EDGE_FIELDS = ['edge_id', 'edge_code', 'insert_id', 'edge_identifier', 'is_used', 'notes'];

// A box holds a few dozen inserts; these caps are far above that and well below a runaway read.
const MAX_INSERTS = 500;
const MAX_EDGES = 4000;

export function useToolingData(segment: Ref<string>, id: Ref<string>) {
	const { getItem, getItems } = useItems();
	const gate = useRequestGate(); // the focused record and its sections
	const modelGate = useRequestGate(); // the box's model and its history counts
	const { section, fill } = useSections(gate);
	const { section: modelSection, fill: modelFill } = useSections(modelGate);

	const kind = computed<FocusKind | null>(() => focusKindOf(segment.value));

	// The focused record's own row (box, insert or edge), and the route it was read for.
	const record = ref<any | null>(null);
	const recordKey = ref('');
	const loading = ref(false);
	const notVisible = ref(false);
	const error = ref('');

	// The box row (with its insert type and project) and the model built from it.
	const box = shallowRef<any | null>(null);
	const model = shallowRef<ToolingModel | null>(null);
	const modelLoading = ref(false);
	const modelError = ref('');

	const tests = section<any[]>([]);
	const operations = section<any[]>([]);
	// History rows (tests plus operations) per edge id, for the whole box.
	const edgeCounts = modelSection<Map<string, number>>(new Map());

	let pendingBox: string | null = null;
	let boxCache: { id: string; row: any } | null = null;

	const readBox = (boxId: string) => getItem('tool_boxes', boxId, { fields: BOX_FIELDS });
	const readFocus = (k: FocusKind, rid: string) => {
		if (k === 'box') return readBox(rid);
		if (k === 'insert') return getItem('cutting_inserts', rid, { fields: INSERT_FIELDS });
		return getItem('insert_edges', rid, { fields: EDGE_FIELDS });
	};
	// The box a record belongs to. An insert or edge whose parent the user may not read comes back
	// with a bare id (or null) instead of the expanded row.
	const boxIdOf = (k: FocusKind, row: any): string | null => {
		const raw = k === 'box' ? row?.tool_box_id : k === 'insert' ? row?.tool_box_id : row?.insert_id?.tool_box_id;
		return typeof raw === 'string' && raw ? raw : null;
	};

	async function loadModel(boxId: string, force: boolean) {
		if (!force && (model.value?.boxId === boxId || pendingBox === boxId)) return;
		if (model.value && model.value.boxId !== boxId) {
			model.value = null;
			box.value = null;
			edgeCounts.value = { data: new Map(), loading: false, error: '' };
		}
		const token = modelGate.begin();
		pendingBox = boxId;
		modelLoading.value = true;
		modelError.value = '';
		let built: ToolingModel;
		try {
			const cached = boxCache?.id === boxId ? boxCache.row : null;
			boxCache = null;
			const [boxRow, inserts, edges] = await Promise.all([
				cached ?? readBox(boxId),
				getItems('cutting_inserts', { filter: { tool_box_id: { _eq: boxId } }, fields: MODEL_INSERT_FIELDS, sort: ['insert_number'], limit: MAX_INSERTS }),
				getItems('insert_edges', { filter: { insert_id: { tool_box_id: { _eq: boxId } } }, fields: MODEL_EDGE_FIELDS, limit: MAX_EDGES }),
			]);
			if (!modelGate.isCurrent(token)) return;
			box.value = boxRow;
			built = buildToolingModel(boxRow, boxRow.insert_type_id ?? null, inserts, edges);
			model.value = built;
		} catch (e) {
			if (!modelGate.isCurrent(token)) return;
			if (isNotVisible(e)) notVisible.value = true;
			else modelError.value = `Could not load this tool box: ${errorText(e)}`;
			return;
		} finally {
			if (modelGate.isCurrent(token)) {
				modelLoading.value = false;
				pendingBox = null;
			}
		}
		const edgeIds = built.inserts.flatMap((i) => i.edges.map((e) => e.id));
		await modelFill(edgeCounts, token, 'the usage history of the edges', async () => {
			// An edge is "used" when `is_used` says so; these counts only back the "marked fresh, but used" warnings.
			const grouped = (collection: string) =>
				getItems(collection, {
					aggregate: { count: '*' },
					groupBy: ['insert_edge_id'],
					filter: { insert_edge_id: { insert_id: { tool_box_id: { _eq: boxId } } } },
					limit: -1,
				});
			// Tests: from the junction test_sessions_subject, since insert_edge_id holds only a test's FIRST edge
			// (migration 139). A role that may not read the junction falls back to that column.
			const testCounts = async () => {
				try {
					const parts = await Promise.all(chunkIds(edgeIds).map((ids) => getItems('test_sessions_subject', edgeJunctionCountParams(ids))));
					return junctionCountsByEdge(parts.flat());
				} catch (e) {
					if (!isNotVisible(e)) throw e;
					return countsByKey(await grouped('test_sessions'), 'insert_edge_id');
				}
			};
			const [t, o] = await Promise.all([testCounts(), grouped('manufacturing_operations')]);
			return mergeEdgeCounts(t, countsByKey(o, 'insert_edge_id'));
		});
	}

	async function load(force = false) {
		const token = gate.begin();
		const k = kind.value;
		const rid = id.value;
		const key = `${segment.value}/${rid}`;
		notVisible.value = false;
		error.value = '';
		if (!k || !rid) {
			notVisible.value = true;
			return;
		}
		// Moving to another record starts its own panels from a clean state. The model stays while the
		// record is one of its own; a record it does not contain belongs to another box, so the model goes.
		if (recordKey.value !== key) {
			record.value = null;
			tests.value = { data: [], loading: false, error: '' };
			operations.value = { data: [], loading: false, error: '' };
		}
		const inModel = k === 'box' ? model.value?.boxId === rid : k === 'insert' ? !!findInsert(model.value, rid) : !!findEdge(model.value, rid);
		if (model.value && !inModel) {
			model.value = null;
			box.value = null;
		}

		loading.value = true;
		let row: any;
		try {
			row = await readFocus(k, rid);
			if (!gate.isCurrent(token)) return;
		} catch (e: any) {
			if (!gate.isCurrent(token)) return;
			if (isNotVisible(e)) notVisible.value = true;
			else error.value = `Could not load this ${k === 'box' ? 'tool box' : k === 'insert' ? 'cutting insert' : 'insert edge'}: ${errorText(e)}`;
			return;
		} finally {
			if (gate.isCurrent(token)) loading.value = false;
		}
		if (!row) {
			notVisible.value = true;
			return;
		}
		record.value = row;
		recordKey.value = key;

		const boxId = boxIdOf(k, row);
		if (!boxId) {
			notVisible.value = true;
			return;
		}
		if (k === 'box') boxCache = { id: boxId, row };

		await Promise.all([
			loadModel(boxId, force),
			k === 'edge'
				? fill(tests, token, 'tests', async () => {
						const read = (filter: Record<string, unknown>) =>
							getItems('test_sessions', {
								filter,
								fields: ['session_id', 'test_type', 'session_date', 'status', 'sample_id.sample_code'],
								sort: ['-session_date'],
								limit: LIST_CAP + 1,
							});
						// insert_edge_id is only the test's FIRST edge (migration 139); a test with several edges lists the
						// others in the subject junction. One read with an _or covers both.
						try {
							return await read(edgeTestsFilter(rid));
						} catch (e) {
							// A role that may not read the junction cannot filter on it: fall back to the column.
							if (!isNotVisible(e)) throw e;
							return read({ insert_edge_id: { _eq: rid } });
						}
					})
				: Promise.resolve(),
			k === 'edge'
				? fill(operations, token, 'operations', () =>
						getItems('manufacturing_operations', {
							filter: { insert_edge_id: { _eq: rid } },
							fields: ['operation_id', 'pass_code', 'operation_sequence', 'operation_date', 'process_category', 'sample_id.sample_code'],
							sort: ['-operation_date'],
							limit: LIST_CAP + 1,
						}),
					)
				: Promise.resolve(),
		]);
	}

	watch([segment, id], () => load(), { immediate: true });
	onBeforeUnmount(() => {
		gate.cancel();
		modelGate.cancel();
	});

	// The edge's own insert, for an edge route: from the model once it is loaded, else from the edge record.
	const edgeInsertId = computed(() => (kind.value === 'edge' && recordKey.value === `${segment.value}/${id.value}` ? (record.value?.insert_id?.insert_id ?? null) : null));
	const focus = computed(() => focusFromRoute(segment.value, id.value, model.value, edgeInsertId.value));
	const nextFresh = computed(() => (model.value ? nextFreshEdge(model.value) : null));
	// The focused record's row, only once it has been read for the current route.
	const current = computed(() => (recordKey.value === `${segment.value}/${id.value}` ? record.value : null));
	const history = computed(() => ({ tests: tests.value, operations: operations.value }));

	const state = computed<'loading' | 'notVisible' | 'error' | 'ready'>(() => {
		if (notVisible.value) return 'notVisible';
		if (error.value || modelError.value) return 'error';
		return model.value && focus.value ? 'ready' : 'loading';
	});

	return {
		kind, state, loading, modelLoading, error: computed(() => error.value || modelError.value),
		record: current, box, model, focus, nextFresh, history, tests, operations, edgeCounts,
		reload: () => load(true),
	};
}
