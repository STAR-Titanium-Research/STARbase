// Which local captures already have a database row.
//
// Both upload paths (workspace.ts's end-of-cut save and uploadCapture.ts's retry) stamp the
// capture id into manufacturing_operations.recorded_metadata.capture_id. That is a key inside a
// JSON field, and Directus cannot filter on one: it rejects `recorded_metadata.capture_id` as an
// unknown field (403), even for an administrator. So the candidate rows are fetched and matched
// here instead. The fetch is bounded by created_at, because a row is always created after its
// capture was recorded and a capture id starts with its recording time.

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
	uploaded: Record<string, boolean>;
	opIds: Record<string, string>;
} {
	const wanted = new Set(captureIds);
	const uploaded: Record<string, boolean> = {};
	const opIds: Record<string, string> = {};
	for (const row of rows) {
		const cid = row?.recorded_metadata?.capture_id;
		if (typeof cid !== 'string' || !wanted.has(cid)) continue;
		uploaded[cid] = true;
		if (row.operation_id) opIds[cid] = row.operation_id;
	}
	return { uploaded, opIds };
}
