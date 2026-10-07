// Resumable upload of one capture (stream-2 review 2.2). The save is three steps: the
// manufacturing_operations row, the capture's files (/files), then the machining_force_analysis
// row. A failure in step 2 or 3 used to be retried from step 1, inserting a second operation row
// and uploading the files again. Each step now records what it finished, keyed by capture id, so a
// retry (from the save dialog or from Settings > Local Captures) continues where it stopped.
//
// A response can also be lost after the server committed (a timeout), so before inserting again
// the operation is looked up by the capture id both upload paths stamp into
// recorded_metadata.capture_id. Directus cannot filter on a key inside that JSON field
// (captureUploadState.ts), so candidate rows are fetched by created_at and matched here.
import { api } from '../directusClient';
import { matchUploaded, uploadedRowsSince } from '../settings/captureUploadState';

export interface UploadProgress {
	/** manufacturing_operations row for this capture, once created (or found). */
	opId?: string;
	/** An insert has been sent: its response may have been lost, so look before sending another. */
	insertAttempted?: boolean;
	/** undefined = not uploaded yet; null = nothing to upload (no capture.mat was written). */
	matFileId?: string | null;
	cacheFileId?: string;
	/** The machining_force_analysis row exists AND carries every file this capture has. */
	analysisDone?: boolean;
	/** An analysis row found for the operation (an earlier attempt, or a lost reply), possibly
	 * lacking a file link: completed with a PATCH instead of a second row. */
	analysisRow?: AnalysisLink;
}

/** The link fields of an existing machining_force_analysis row. */
export interface AnalysisLink {
	id: string;
	live_cache_file?: string | null;
	directus_files_id?: string | null;
}

const progressByCapture = new Map<string, UploadProgress>();

export function uploadProgress(captureId: string): UploadProgress {
	let p = progressByCapture.get(captureId);
	if (!p) { p = {}; progressByCapture.set(captureId, p); }
	return p;
}
export function clearUploadProgress(captureId?: string): void {
	if (captureId) progressByCapture.delete(captureId); else progressByCapture.clear();
}

/** The operation id already stamped with this capture id, or null. Throws when the lookup fails. */
export async function findOperationForCapture(captureId: string): Promise<string | null> {
	const since = uploadedRowsSince([captureId]);
	const res = await api.get('/items/manufacturing_operations', {
		params: {
			filter: { recorded_metadata: { _nnull: true }, ...(since ? { created_at: { _gte: since } } : {}) },
			fields: ['operation_id', 'recorded_metadata'], sort: '-created_at', limit: -1,
		},
	});
	return matchUploaded(res.data?.data ?? [], [captureId]).opIds[captureId] ?? null;
}

/** The analysis row linked to this operation, or null. Throws when the lookup fails. */
export async function findAnalysisRow(opId: string): Promise<AnalysisLink | null> {
	// operation_id is not UNIQUE, so an older race can have left two rows: take the one that
	// already links the most files rather than whichever the database returns first.
	const res = await api.get('/items/machining_force_analysis', {
		params: {
			filter: { operation_id: { _eq: opId } },
			fields: ['id', 'live_cache_file', 'directus_files_id'], limit: 10,
		},
	});
	const rows = (res.data?.data ?? []) as AnalysisLink[];
	const links = (r: AnalysisLink) => Number(!!r.live_cache_file) + Number(!!r.directus_files_id);
	return rows.reduce<AnalysisLink | null>((best, r) => (!best || links(r) > links(best) ? r : best), null);
}

/**
 * The operation row for this capture: the one remembered from an earlier attempt, one found by
 * capture id (when an earlier insert may have been committed without us seeing the reply, or
 * `alwaysLookup`), or a freshly inserted one. `existing` is true unless `insert` ran now.
 */
export async function ensureOperation(
	captureId: string, p: UploadProgress, insert: () => Promise<string>, alwaysLookup = false,
): Promise<{ opId: string; existing: boolean }> {
	if (p.opId) return { opId: p.opId, existing: true };
	if (p.insertAttempted || alwaysLookup) {
		// Best effort: if the lookup itself fails the insert below will most likely fail too, and
		// a failed lookup must not block an upload that would have worked.
		const found = await findOperationForCapture(captureId).catch(() => null);
		if (found) { p.opId = found; return { opId: found, existing: true }; }
	}
	p.insertAttempted = true;
	const opId = await insert();
	p.opId = opId;
	return { opId, existing: false };
}

/** Whether any file of this capture still has to be uploaded (so its blobs need fetching). */
export function needsBlobs(p: UploadProgress, matWritten: boolean): boolean {
	return p.cacheFileId === undefined || (matWritten && p.matFileId === undefined);
}

/**
 * Call after the operation is known and BEFORE any file is uploaded. When the operation already
 * existed (an earlier attempt, or a reply that was lost) its analysis row may too, with only some
 * of its files linked. What the row already links is adopted as progress, so those files are not
 * uploaded again (they would be orphans), and the row is remembered for analysisAlreadyLinked().
 * An unknown answer (the lookup failed) stops the upload: carrying on would post a second analysis
 * row next to an existing one (operation_id is not UNIQUE). Trying again is safe.
 */
export async function adoptExistingAnalysis(p: UploadProgress, opId: string, existing: boolean): Promise<void> {
	if (p.analysisDone || !existing) return;
	let row: AnalysisLink | null;
	try { row = await findAnalysisRow(opId); } catch (e: any) {
		throw new Error(`could not check the existing database record for this capture (${e?.message || e}); try again`);
	}
	if (!row) return;
	p.analysisRow = row;
	if (row.live_cache_file) p.cacheFileId = row.live_cache_file;
	if (row.directus_files_id) p.matFileId = row.directus_files_id;
}

/**
 * Call after the files are uploaded. True when the analysis row must not be posted: it already
 * exists (`analysisRow`, found by adoptExistingAnalysis) or an earlier attempt created it. An
 * existing row that lacks a file link is completed here by PATCHing only the missing fields (a
 * link that is already present is never overwritten); this throws if that PATCH fails.
 */
export async function analysisAlreadyLinked(p: UploadProgress): Promise<boolean> {
	if (p.analysisDone) return true;
	const row = p.analysisRow;
	if (!row) return false;
	const patch: Record<string, string> = {};
	if (!row.live_cache_file && p.cacheFileId) patch.live_cache_file = p.cacheFileId;
	if (!row.directus_files_id && p.matFileId) patch.directus_files_id = p.matFileId;
	if (Object.keys(patch).length) await api.patch(`/items/machining_force_analysis/${row.id}`, patch);
	p.analysisDone = true;
	return true;
}
