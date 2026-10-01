// Stand-alone (workspace-independent) upload of a finished capture into the database. Used by
// LocalCaptureView to retry an upload from a cold page load, where the live RecordClient/workspace
// from the recording session no longer exists (navigating away from /record unmounts it), and by
// the capture metadata editor after correcting a capture that was never uploaded. Rebuilds the
// manufacturing_operations row purely from summary.json's echoed RecordConfig + extra_metadata —
// including the resolved Directus lookup selections (sample/operator/equipment/insert/edge/tool),
// which workspace.ts::metaObj() persists there under `link_*` keys specifically so this path can
// recover them. (That persistence is relatively new — a capture recorded before it existed will
// only have the free-text labels, not the resolved IDs, and won't link a sample here until its
// metadata is corrected through the editor, which re-resolves them via the same lookups.)
import { api } from '../directusClient';
import { resolveMachiningMethodId } from './directusLookups';
import { buildSeriesEnvelope, parseCache, type Cache } from '@d1/force-plotting';
import { OFFLINE_SESSION_UPLOAD_MESSAGE, hasServerSession, resolveOwnerPersonId, syncerFields } from '../recorder';

export interface ColdUploadInfo {
	captureId: string;
	matUrl: string;
	cacheUrl: string;
	cfg: Record<string, any>; // RecordConfig.model_dump(), as echoed in summary.json's "config"
	peaks?: { Fx: number; Fy: number; Fz: number } | null;
	cache?: Cache | null; // already-parsed live_cache, if the caller has it (avoids re-fetching)
	matWritten?: boolean; // summary.json's top-level mat_written; false for captures over MAT_MAX_BYTES, which never got a capture.mat written
}

// Directus surfaces validation/constraint failures as a JSON body with an `errors[]` array; a bare
// axios error.message is just "Request failed with status code 500". Pull the real reason out.
export function directusErrorMessage(e: any): string {
	const status = e?.response?.status;
	const detail = e?.response?.data?.errors?.[0]?.message;
	if (status && detail) return `${status}: ${detail}`;
	if (status) return `${status}: ${e?.message || 'request failed'}`;
	return e?.message || String(e);
}

// extra_metadata's machining-detail fields are stored as strings (they're plain <input> v-models);
// Directus wants numbers or null.
export function numOrNull(s: unknown): number | null {
	const str = String(s ?? '');
	return str !== '' && Number.isFinite(Number(str)) ? Number(str) : null;
}

export async function uploadFile(blob: Blob, filename: string): Promise<string> {
	const fd = new FormData();
	fd.append('file', blob, filename);
	try {
		const res = await api.post('/files', fd);
		return res.data.data.id;
	} catch (e: any) {
		throw new Error(`file upload (${filename}) failed - ${directusErrorMessage(e)}`);
	}
}

// A capture too large for the MAT5 format (see finalize.py's MAT_MAX_BYTES) never had a capture.mat
// written at all -- fetching it would 404 and abort the whole upload, so it comes back null instead.
// `signal` lets a caller that started this early cancel it (e.g. when the run insert it was
// racing fails), so a capture of hundreds of MB isn't downloaded for nothing.
export function fetchCaptureBlobs(matUrl: string, cacheUrl: string, matWritten: boolean, signal?: AbortSignal): Promise<[Blob | null, Blob]> {
	const get = (url: string, what: string) =>
		fetch(url, { signal }).then((r) => { if (!r.ok) throw new Error(`${what} fetch failed`); return r.blob(); });
	return Promise.all([
		matWritten ? get(matUrl, 'capture.mat') : Promise.resolve(null),
		get(cacheUrl, 'live_cache.bin'),
	]);
}

export function uploadCaptureFiles(captureId: string, matBlob: Blob | null, cacheBlob: Blob): Promise<[string | null, string]> {
	return Promise.all([
		matBlob ? uploadFile(matBlob, `${captureId}.mat`) : Promise.resolve(null),
		uploadFile(cacheBlob, `${captureId}_live_cache.bin`),
	]);
}

export async function uploadCaptureColdStart(info: ColdUploadInfo): Promise<string> {
	if (!hasServerSession()) throw new Error(OFFLINE_SESSION_UPLOAD_MESSAGE);
	const cfg = info.cfg || {};
	const extra: Record<string, any> = cfg.extra_metadata || {};
	const surface = Math.PI * (Number(cfg.diam) || 0) * (Number(cfg.rpm) || 0) / 1000;
	const payload: Record<string, any> = {
		// Resolved lookups, if this recording persisted them (see workspace.ts::metaObj — a real gap
		// until it was fixed alongside this: these used to only ever reach Directus via
		// buildRunPayload()'s immediate-upload path, so a cold-started upload could never link a
		// sample or any other lookup at all, only free-text labels). `|| null`, not left absent: an
		// absent key lets manufacturing_operations_has_sample fall through to NULL/NULL/NULL and the
		// insert fails the CHECK constraint with a raw, unhelpful database error.
		sample_id: extra.link_sample_id || null,
		operator_person_id: extra.link_operator_id || null,
		equipment_id: extra.link_equipment_id || null,
		insert_edge_id: extra.link_edge_id || null,
		tool_id: extra.link_tool_id || null,
		// Recorded-at and recorded-by come from the capture itself, NOT from now / whoever is signed in:
		// this path runs when a capture that sat on disk (often recorded offline) is uploaded later,
		// possibly by someone else. Captures from before this existed carry neither and fall back to
		// the old behaviour (upload time; the server defaults the owner to the uploader).
		owner_person_id: await resolveOwnerPersonId(extra),
		operation_date: String(extra.recorded_at || new Date().toISOString()),
		process_category: 'machining',
		machining_operation_subtype: extra.op_type || null,
		machining_spindle_speed_rpm: cfg.rpm ?? null,
		machining_feed_mm_per_rev: cfg.feed ?? null,
		machining_workpiece_diameter_mm: cfg.diam ?? null,
		machining_cutting_speed_m_per_min: Number.isFinite(surface) ? Number(surface.toFixed(2)) : null,
		machining_force_captured: true,
		machining_tacho_used: true,
		machining_coolant_used: !!(extra.coolant && String(extra.coolant).trim()),
		capture_software: 'force-app',
		capture_frequency_khz: cfg.sample_rate ? Number((cfg.sample_rate / 1000).toFixed(3)) : null,
		outcome_notes: extra.notes || null,
		// Machining details (folded Directus form section) — same fields buildRunPayload() sends,
		// previously missing here for the identical reason the relational IDs were.
		machining_axial_depth_of_cut_mm: numOrNull(extra.axial_doc),
		machining_radial_depth_of_cut_mm: numOrNull(extra.radial_doc),
		machining_cutting_length_mm: numOrNull(extra.cutting_length),
		machining_coolant_pressure_bar: numOrNull(extra.coolant_pressure),
		operation_sequence: numOrNull(extra.operation_sequence),
		machining_new_edge: !!extra.new_edge,
		machining_chips_collected: !!extra.chips_collected,
		machining_chips_ref_code: extra.chips_ref || null,
		recorded_metadata: { ...extra, ...syncerFields(), capture_id: info.captureId, peaks: info.peaks, source: cfg.source, uploaded_via: 'local-capture-retry' },
	};
	payload.method_id = await resolveMachiningMethodId(extra.op_type).catch(() => null);

	// Local blob reads don't depend on the Directus insert, so run them alongside it; uploads still
	// wait for it, so a failed insert never leaves orphaned files -- and cancels the reads.
	const blobReads = new AbortController();
	const blobs = fetchCaptureBlobs(info.matUrl, info.cacheUrl, info.matWritten !== false, blobReads.signal);
	blobs.catch(() => {});   // surfaced by the await below, not as an unhandled rejection
	let opId: string;
	try {
		let res;
		try {
			res = await api.post('/items/manufacturing_operations', payload);
		} catch (e: any) {
			throw new Error(`logging the run failed - ${directusErrorMessage(e)}`);
		}
		opId = res.data?.data?.operation_id;
		if (!opId) throw new Error('run was logged but the server did not return its operation_id - cannot link the capture');
	} catch (e) {
		blobReads.abort();
		throw e;
	}

	const [matBlob, cacheBlob] = await blobs;
	const [matFileId, cacheFileId] = await uploadCaptureFiles(info.captureId, matBlob, cacheBlob);

	// Same fix as the live-session upload path (workspace.ts): the force/RPM charts on the Plot
	// page read from `series` (a JSONB min/max envelope), not from live_cache_file — without this
	// the row links up fine (peaks, FRM) but every chart renders "no data" forever.
	let series: ReturnType<typeof buildSeriesEnvelope> | null = null;
	try {
		const cache = info.cache ?? parseCache(await cacheBlob.arrayBuffer());
		series = buildSeriesEnvelope(cache);
	} catch { /* best-effort — a missing series just means blank charts, not a failed upload */ }

	try {
		await api.post('/items/machining_force_analysis', {
			operation_id: opId,
			directus_files_id: matFileId,
			live_cache_file: cacheFileId,
			status: 'done',
			sample_rate: cfg.sample_rate ?? null,
			feed: cfg.feed ?? null,
			cut_diameter: cfg.diam ?? null,
			max_rpm: cfg.rpm ?? null,
			peak_fx: info.peaks?.Fx ?? null,
			peak_fy: info.peaks?.Fy ?? null,
			peak_fz: info.peaks?.Fz ?? null,
			series,
			matlab_version: 'force-app-direct',
			processed_at: new Date().toISOString(),
		});
	} catch (e: any) {
		throw new Error(`linking the capture failed - ${directusErrorMessage(e)} (the run was logged as operation ${opId}, and both files uploaded, but the analysis record could not be created)`);
	}
	return opId;
}
