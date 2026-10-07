// Links for the rows of the project items view (d1-project-items).
//
// `project_rollup` rows carry a hashed row_id, a kind and a display code, but not the id of the
// record they describe, so there is nothing to link to. The project's operations do know them:
// each operation names its sample, machine, tool, edge, insert and material. Reading those
// (as the signed-in user, so only what they may see) gives the ids, and the row_id is
// recomputed here exactly as the database does (migration 20261002000116, v_project_rollup):
//
//   operation       md5('operation:' || operation_id)
//   <other kinds>   md5('<prefix>:' || project_id || ':' || id)   prefix: tool, edge, insert,
//                                                                 sample, material, equipment
//
// Matching by row_id and not by display code matters because a code can be shared
// (manufacturing_operations.pass_code is neither unique nor required), and a code-keyed map would
// link a row to whichever operation was read last. A rollup row whose record is not in the result
// simply stays plain text.

import { asRecord } from './format';
import { md5 } from './md5';
import { projectScopeFilter } from './projectScope';

// project_rollup.kind -> the collection the record lives in (recordRoute() then decides the page).
export const ROLLUP_COLLECTION: Record<string, string> = {
	operation: 'manufacturing_operations',
	sample: 'physical_samples',
	equipment: 'equipment',
	tool: 'tools',
	insert_edge: 'insert_edges',
	cutting_insert: 'cutting_inserts',
	material: 'materials',
};

// kind -> the prefix v_project_rollup hashes into row_id.
export const ROLLUP_ROW_PREFIX: Record<string, string> = {
	operation: 'operation',
	tool: 'tool',
	insert_edge: 'edge',
	cutting_insert: 'insert',
	sample: 'sample',
	material: 'material',
	equipment: 'equipment',
};

// What to read from the project's operations to resolve every kind above: ids only.
export const ROLLUP_OPERATION_FIELDS = [
	'operation_id',
	'sample_id.sample_id',
	'equipment_id.equipment_id',
	'tool_id.tool_id',
	'insert_edge_id.edge_id',
	'insert_edge_id.insert_id.insert_id',
	'material_id.material_id',
];

export interface RollupTarget {
	collection: string;
	id: string;
}

// The project_rollup.row_id of the row for record `id` of `kind` in project `projectId`.
export function rollupRowId(kind: string, projectId: string | number, id: string | number): string {
	const prefix = ROLLUP_ROW_PREFIX[kind];
	return md5(kind === 'operation' ? `${prefix}:${id}` : `${prefix}:${projectId}:${id}`);
}

// The operations whose rollup rows belong to project `projectId`: its own, and those that only
// reach it through their campaign (the view uses COALESCE(o.project_id, c.project_id)). This is the
// kit-wide "belongs to project" rule, see projectScope.ts.
export const rollupOperationsFilter = projectScopeFilter;

// row_id -> record, for every kind the operations can resolve. `ops` are the rows read with
// ROLLUP_OPERATION_FIELDS and rollupOperationsFilter, `projectId` the project being viewed.
export function rollupTargets(ops: any[] | null | undefined, projectId: string | number): Map<string, RollupTarget> {
	const out = new Map<string, RollupTarget>();
	const add = (kind: string, id: unknown) => {
		if (typeof id !== 'string' && typeof id !== 'number') return;
		out.set(rollupRowId(kind, projectId, id), { collection: ROLLUP_COLLECTION[kind], id: String(id) });
	};
	for (const op of ops ?? []) {
		add('operation', op?.operation_id);
		add('sample', asRecord(op?.sample_id)?.sample_id);
		add('equipment', asRecord(op?.equipment_id)?.equipment_id);
		add('tool', asRecord(op?.tool_id)?.tool_id);
		const edge = asRecord(op?.insert_edge_id);
		add('insert_edge', edge?.edge_id);
		add('cutting_insert', asRecord(edge?.insert_id)?.insert_id);
		add('material', asRecord(op?.material_id)?.material_id);
	}
	return out;
}
