// What a list row can open in the analysis pages: the Force dashboard for a machining operation with
// a finished force analysis, the FAST dashboard for a sintering run with finished run data, and for a
// sample the operations that have force. The list page asks for it in a second, separate request
// per kind after the rows arrive: machining_force_analysis and fast_run_data are hidden collections
// (not in the readable list the page already holds), a role may be refused them, and a Directus
// o2m filter is no good for counting, so each request names the ids on screen with `_in`
// and a failed one only means no buttons of that kind. Pure: no Vue, no network.
import { fileId } from './thumbs';

export interface RowPlots {
	force: boolean;
	fast: boolean;
	/** The file id of the Fz force figure (operations only). */
	frmFz: string | null;
	/** Samples only: how many of the sample's operations have a finished force analysis. */
	forceCount?: number;
}

export type PlotKey = 'force' | 'fast' | 'sampleForce';
export interface PlotRequest {
	path: string;
	params: Record<string, unknown>;
	key: PlotKey;
}

const OPERATIONS = 'manufacturing_operations';
const SAMPLES = 'physical_samples';

/** Which lists have a "Plots" column. */
export function plotKind(collection: string): 'operations' | 'samples' | null {
	if (collection === OPERATIONS) return 'operations';
	if (collection === SAMPLES) return 'samples';
	return null;
}

const done = { status: { _eq: 'done' } };

export function plotRequests(collection: string, ids: string[]): PlotRequest[] {
	const kind = plotKind(collection);
	if (!kind || !ids.length) return [];
	if (kind === 'operations') {
		const filter = JSON.stringify({ _and: [{ operation_id: { _in: ids } }, done] });
		return [
			{ key: 'force', path: '/items/machining_force_analysis', params: { filter, fields: ['operation_id', 'frm_fz'], limit: -1 } },
			{ key: 'fast', path: '/items/fast_run_data', params: { filter, fields: ['operation_id'], limit: -1 } },
		];
	}
	return [{
		key: 'sampleForce',
		path: '/items/machining_force_analysis',
		params: {
			filter: JSON.stringify({ _and: [done, { operation_id: { sample_id: { _in: ids } } }] }),
			fields: ['operation_id.operation_id', 'operation_id.sample_id'],
			limit: -1,
		},
	}];
}

type Result = unknown[] | null | undefined;
const asRows = (r: Result): Record<string, unknown>[] => (Array.isArray(r) ? (r.filter((x) => typeof x === 'object' && x !== null) as Record<string, unknown>[]) : []);

// `results` holds each request's rows, or null when it failed (no buttons of that kind). Every id
// gets an entry, so a row without data simply has no buttons.
export function mergePlots(
	collection: string,
	ids: string[],
	results: Partial<Record<PlotKey, Result>>,
): Record<string, RowPlots> {
	const out: Record<string, RowPlots> = {};
	if (plotKind(collection) === 'samples') {
		const ops = new Map<string, Set<string>>();
		for (const row of asRows(results.sampleForce)) {
			const op = row.operation_id as { operation_id?: unknown; sample_id?: unknown } | null;
			if (!op || typeof op !== 'object' || op.sample_id == null || op.operation_id == null) continue;
			const sample = String(op.sample_id);
			if (!ops.has(sample)) ops.set(sample, new Set());
			ops.get(sample)!.add(String(op.operation_id));
		}
		for (const id of ids) {
			const forceCount = ops.get(id)?.size ?? 0;
			out[id] = { force: forceCount > 0, fast: false, frmFz: null, forceCount };
		}
		return out;
	}
	const force = new Set<string>();
	const figure = new Map<string, string>();
	for (const row of asRows(results.force)) {
		if (row.operation_id == null) continue;
		const op = String(row.operation_id);
		force.add(op);
		const fz = fileId(row.frm_fz);
		if (fz && !figure.has(op)) figure.set(op, fz);
	}
	const fast = new Set(asRows(results.fast).filter((r) => r.operation_id != null).map((r) => String(r.operation_id)));
	for (const id of ids) out[id] = { force: force.has(id), fast: fast.has(id), frmFz: figure.get(id) ?? null };
	return out;
}
