// Which local captures already have a database row.
//
// Both upload paths (workspace.ts's end-of-cut save and uploadCapture.ts's retry) stamp the
// capture id into manufacturing_operations.recorded_metadata.capture_id. That is a key inside a
// JSON field, and Directus cannot filter on one: it rejects `recorded_metadata.capture_id` as an
// unknown field (403), even for an administrator. So the candidate rows are fetched and matched
// here instead. The fetch is bounded by created_at, because a row is always created after its
// capture was recorded and a capture id starts with its recording time.
//
// A matching operation row alone does NOT mean "uploaded". The upload order is operation row ->
// files -> analysis row (record/uploadCapture.ts), so an upload that died after the first step
// leaves an orphan operation row and nothing else. "Uploaded" (the state that lets Free up space
// and bulk delete treat the local copy as redundant) therefore also needs a
// machining_force_analysis row for that operation with its live cache file set, plus the .mat
// file when the capture wrote one. An operation row without those is a partial upload: the
// capture stays uploadable (ensureOperation resumes on the existing row) and counts as the only copy.

export interface UploadedRow {
	operation_id?: string | null;
	recorded_metadata?: { capture_id?: unknown } | null;
}

const ID_TIME = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/;
// Capture ids carry the recording PC's local time; two days of slack absorbs any clock or
// time-zone difference against the database's created_at.
const SLACK_MS = 2 * 24 * 3600 * 1000;

/** ISO lower bound on created_at for rows that could belong to these captures, or null for no
 * bound (no captures, or an id that doesn't start with a timestamp: never narrow on a guess). */
export function uploadedRowsSince(captureIds: string[]): string | null {
	let earliest = Infinity;
	for (const id of captureIds) {
		const m = ID_TIME.exec(id);
		if (!m) return null;
		const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
		if (Number.isNaN(t)) return null;
		earliest = Math.min(earliest, t);
	}
	return Number.isFinite(earliest) ? new Date(earliest - SLACK_MS).toISOString() : null;
}

/** Match fetched rows back to the local capture ids. */
export function matchUploaded(rows: UploadedRow[], captureIds: string[]): {
	/** The capture has at least one operation row. NOT the same as fully uploaded. */
	uploaded: Record<string, boolean>;
	opIds: Record<string, string>;
	/** Every operation row found per capture (a retried upload can leave more than one). */
	allOpIds: Record<string, string[]>;
} {
	const wanted = new Set(captureIds);
	const uploaded: Record<string, boolean> = {};
	const opIds: Record<string, string> = {};
	const allOpIds: Record<string, string[]> = {};
	for (const row of rows) {
		const cid = row?.recorded_metadata?.capture_id;
		if (typeof cid !== 'string' || !wanted.has(cid)) continue;
		uploaded[cid] = true;
		if (row.operation_id) {
			opIds[cid] = row.operation_id;
			(allOpIds[cid] ??= []).push(row.operation_id);
		}
	}
	return { uploaded, opIds, allOpIds };
}

export interface AnalysisRow {
	operation_id?: string | null;
	live_cache_file?: string | null;
	directus_files_id?: string | null;
}

/** Whether these analysis rows (for one capture's operation rows) prove the upload finished: the
 * live cache is attached, and so is the .mat when the capture wrote one. */
export function analysisComplete(rows: AnalysisRow[], matExpected: boolean): boolean {
	return rows.some((r) => !!r?.live_cache_file && (!matExpected || !!r?.directus_files_id));
}

/** Directus reader: rows of one collection for the given query params. Throws when it can't ask. */
export type RowGetter = (collection: string, params: Record<string, unknown>) => Promise<unknown[]>;

const ID_CHUNK = 80;   // keeps the `_in` filter well inside URL length limits (36-char uuids)

/** analysis rows for these operation ids, with only the fields completeness needs. */
export async function fetchAnalysisRows(opIds: string[], get: RowGetter): Promise<AnalysisRow[]> {
	const out: AnalysisRow[] = [];
	for (let i = 0; i < opIds.length; i += ID_CHUNK) {
		const rows = await get('machining_force_analysis', {
			filter: { operation_id: { _in: opIds.slice(i, i + ID_CHUNK) } },
			fields: ['operation_id', 'live_cache_file', 'directus_files_id'],
			limit: -1,
		});
		out.push(...(rows as AnalysisRow[]));
	}
	return out;
}

export interface UploadStateResult {
	/** Operation row AND analysis row with its files: safe to treat the local copy as redundant. */
	uploaded: Record<string, boolean>;
	/** Operation row exists but the upload never finished: still the only copy, still uploadable. */
	partial: Record<string, boolean>;
	/** The operation row to use: for an uploaded capture the one whose analysis row is complete. */
	opIds: Record<string, string>;
}

/** Whether this one operation's upload is complete right now. A single small query: the fresh
 * check made right before a delete. Throws when Directus can't be asked. */
export async function recheckUploaded(opId: string, hasMat: boolean, get: RowGetter): Promise<boolean> {
	return analysisComplete(await fetchAnalysisRows([opId], get), hasMat);
}

/**
 * The state to show right after an upload finished, from a fresh look at the database rather than
 * from "the upload call returned": 'uploaded' when the operation's analysis row is complete,
 * 'partial' when the row is still missing a file link, 'unknown' when Directus can't be asked (the
 * capture then stays the only known copy).
 */
export async function confirmUploadState(opId: string, hasMat: boolean, get: RowGetter): Promise<'uploaded' | 'partial' | 'unknown'> {
	try { return (await recheckUploaded(opId, hasMat, get)) ? 'uploaded' : 'partial'; } catch { return 'unknown'; }
}

/** Which of `captures` are fully uploaded, partially uploaded or not at all. Throws on a failed
 * lookup (callers treat that as "unknown", never as "not uploaded"). */
export async function lookupUploadState(
	captures: { id: string; hasMat: boolean }[], get: RowGetter,
): Promise<UploadStateResult> {
	const ids = captures.map((c) => c.id);
	if (!ids.length) return { uploaded: {}, partial: {}, opIds: {} };
	const since = uploadedRowsSince(ids);
	const opRows = await get('manufacturing_operations', {
		filter: { recorded_metadata: { _nnull: true }, ...(since ? { created_at: { _gte: since } } : {}) },
		fields: ['operation_id', 'recorded_metadata'], limit: -1,
	});
	const linked = matchUploaded(opRows as UploadedRow[], ids);
	const allOps = Object.values(linked.allOpIds).flat();
	const analysis = allOps.length ? await fetchAnalysisRows(allOps, get) : [];
	const byOp = new Map<string, AnalysisRow[]>();
	for (const a of analysis) if (a.operation_id) byOp.set(a.operation_id, [...(byOp.get(a.operation_id) ?? []), a]);
	const uploaded: Record<string, boolean> = {};
	const partial: Record<string, boolean> = {};
	const opIds = { ...linked.opIds };
	for (const c of captures) {
		if (!linked.uploaded[c.id]) continue;
		const done = (linked.allOpIds[c.id] ?? []).find((op) => analysisComplete(byOp.get(op) ?? [], c.hasMat));
		if (done) { uploaded[c.id] = true; opIds[c.id] = done; } else partial[c.id] = true;
	}
	return { uploaded, partial, opIds };
}
