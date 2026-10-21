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
import { ref } from 'vue';
import { api } from '../directusClient';
import { resolveMachiningMethodId } from './directusLookups';
import { buildSeriesEnvelope, parseCache, type Cache } from '@d1/force-plotting';
import { OFFLINE_SESSION_UPLOAD_MESSAGE, hasServerSession, resolveOwnerPersonId, syncerFields } from '../recorder';
import { cropOverrideForUpload, type CropSummary } from './cropOverride';
import { adoptExistingAnalysis, analysisAlreadyLinked, ensureOperation, needsBlobs, uploadProgress, type UploadProgress } from './uploadResume';

export interface ColdUploadInfo {
	captureId: string;
	matUrl: string;
	cacheUrl: string;
	cfg: Record<string, any>; // RecordConfig.model_dump(), as echoed in summary.json's "config"
	peaks?: { Fx: number; Fy: number; Fz: number } | null;
	cache?: Cache | null; // already-parsed live_cache, if the caller has it (avoids re-fetching)
	matWritten?: boolean; // summary.json's top-level mat_written; false for captures over MAT_MAX_BYTES, which never got a capture.mat written
	// summary.json as the caller holds it: its crop_*_idx_override (written by PUT /captures/{id}/crop,
	// full-rate sample indices) go with the analysis row, so a retry keeps what the save dialog set.
	summary?: CropSummary | null;
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

// The error shown when the machining_force_analysis insert fails. A cut over the recorder's .mat size
// limit has no capture.mat, so only the live cache was uploaded: say so instead of "both files". A
// .mat that failed to upload (`matFailed`) is a third case: the cache is in, the .mat is kept locally.
export function analysisCreateFailure(e: any, opId: string, matWritten: boolean, matFailed = false): Error {
	const uploaded = matFailed
		? 'and the live cache uploaded (the .mat did not upload; it is kept locally)'
		: matWritten
			? 'and both files uploaded'
			: 'and the live cache uploaded (no capture.mat: the cut is over the recorder\'s .mat size limit, so it was skipped)';
	return new Error(`linking the capture failed - ${directusErrorMessage(e)} (the run was logged as operation ${opId}, ${uploaded}, but the analysis record could not be created)`);
}

// extra_metadata's machining-detail fields are stored as strings (they're plain <input> v-models);
// Directus wants numbers or null.
export function numOrNull(s: unknown): number | null {
	const str = String(s ?? '');
	return str !== '' && Number.isFinite(Number(str)) ? Number(str) : null;
}

// File uploads running right now. uploadFile() is the one leaf every capture upload goes through
// (the save dialog's, a retry from Local Captures, the cold start), so counting here sees them all.
// The rig-test request tells the recorder whether an upload is busy before it starts a run, and the
// queue's `syncStatus.syncing` only covers the small run-record writes, not these multi-GB files.
export const uploadsInFlight = ref(0);

export async function uploadFile(blob: Blob, filename: string): Promise<string> {
	const fd = new FormData();
	fd.append('file', blob, filename);
	uploadsInFlight.value++;
	try {
		const res = await api.post('/files', fd);
		return res.data.data.id;
	} catch (e: any) {
		throw new Error(`file upload (${filename}) failed - ${directusErrorMessage(e)}`);
	} finally {
		uploadsInFlight.value--;
	}
}

// The two local reads, settled independently: a multi-GB capture.mat failing to read (or to upload,
// see uploadCaptureFiles) must not take the small live cache down with it, or the cut never reaches
// the database. A file `progress` already holds, or a capture with no capture.mat (over MAT_MAX_BYTES,
// where fetching it would 404), is not fetched and resolves to null.
// `signal` lets a caller that started this early cancel it (e.g. when the run insert it was
// racing fails), so a capture of hundreds of MB isn't downloaded for nothing.
export interface CaptureBlobReads { mat: Promise<Blob | null>; cache: Promise<Blob | null> }
export function fetchCaptureBlobs(
	matUrl: string, cacheUrl: string, matWritten: boolean, signal?: AbortSignal, progress: UploadProgress = {},
): CaptureBlobReads {
	const get = (url: string, what: string) =>
		fetch(url, { signal }).then((r) => { if (!r.ok) throw new Error(`${what} fetch failed`); return r.blob(); });
	const reads: CaptureBlobReads = {
		mat: matWritten && progress.matFileId === undefined ? get(matUrl, 'capture.mat') : Promise.resolve(null),
		cache: progress.cacheFileId === undefined ? get(cacheUrl, 'live_cache.bin') : Promise.resolve(null),
	};
	// Each is awaited later (and its failure handled there), not left as an unhandled rejection here.
	reads.mat.catch(() => {});
	reads.cache.catch(() => {});
	return reads;
}

/** A .mat that could not be read or uploaded; `bytes` is its size when it was read. */
export interface MatFailure { reason: string; bytes: number | null }

function sizeText(bytes: number | null): string {
	if (bytes == null) return '';
	return bytes >= 1e9 ? ` (${(bytes / 1e9).toFixed(1)} GB)` : ` (${Math.max(1, Math.round(bytes / 1e6))} MB)`;
}

// The error thrown AFTER the run, the live cache and the analysis row are saved but the .mat is not.
// An error (not a success) so the save dialog / Local Captures keep offering Retry upload.
export function matNotUploadedError(f: MatFailure, opId: string): Error {
	return new Error(`the .mat${sizeText(f.bytes)} didn't upload - ${f.reason}. The run and the live cache are saved (operation ${opId}); the .mat is kept locally. Retry upload sends it.`);
}

// Uploads what `progress` does not already hold, recording each file's id as soon as it lands. The
// two are independent, and both are waited for (so whichever landed is remembered even if the other
// failed). The live cache failing throws (the analysis row is useless without it). The .mat failing
// to read or upload comes back as a MatFailure instead, so the caller can still create the analysis
// row (directus_files_id null) and report it honestly; a retry then uploads only the .mat and links
// it to that row.
export async function uploadCaptureFiles(
	captureId: string, reads: CaptureBlobReads, progress: UploadProgress, matWritten: boolean,
): Promise<MatFailure | null> {
	let bytes: number | null = null;
	const cache = async () => {
		if (progress.cacheFileId !== undefined) return;
		const blob = await reads.cache;
		if (!blob) throw new Error('live_cache.bin was not read');
		progress.cacheFileId = await uploadFile(blob, `${captureId}_live_cache.bin`);
	};
	const mat = async () => {
		if (progress.matFileId !== undefined) return;
		if (!matWritten) { progress.matFileId = null; return; }   // nothing to upload
		const blob = await reads.mat;
		if (!blob) throw new Error('capture.mat was not read');
		bytes = blob.size;
		progress.matFileId = await uploadFile(blob, `${captureId}.mat`);
	};
	const [c, m] = await Promise.allSettled([cache(), mat()]);
	if (c.status === 'rejected') throw c.reason;
	return m.status === 'rejected' ? { reason: m.reason?.message || String(m.reason), bytes } : null;
}

export async function uploadCaptureColdStart(info: ColdUploadInfo): Promise<string> {
	if (!hasServerSession()) throw new Error(OFFLINE_SESSION_UPLOAD_MESSAGE);
	const cfg = info.cfg || {};
	const extra: Record<string, any> = cfg.extra_metadata || {};
	// The rate the capture was actually recorded at: summary.fs, as the live-session upload path
	// sends (workspace.ts captureFs()). config.sample_rate is what was asked for, and a replayed cut
	// runs decimated below it, so the two differ there.
	const sampleRate: number | null = Number(info.summary?.fs) || cfg.sample_rate || null;
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
		capture_frequency_khz: sampleRate ? Number((sampleRate / 1000).toFixed(3)) : null,
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

	// Resume (review 2.2): what an earlier attempt for this capture already finished is not redone.
	const progress = uploadProgress(info.captureId);
	if (progress.analysisDone && progress.opId) return progress.opId;
	const matWritten = info.matWritten !== false;

	// Local blob reads don't depend on the Directus insert, so run them alongside it; uploads still
	// wait for it, so a failed insert never leaves orphaned files -- and cancels the reads.
	const blobReads = new AbortController();
	let blobs = needsBlobs(progress, matWritten)
		? fetchCaptureBlobs(info.matUrl, info.cacheUrl, matWritten, blobReads.signal, progress)
		: null;
	let opId: string;
	let existing: boolean;
	try {
		// Always look for an existing row first: this path runs for a capture that is not known to
		// be uploaded, which includes one whose earlier upload died after the insert.
		({ opId, existing } = await ensureOperation(info.captureId, progress, async () => {
			let res;
			try {
				res = await api.post('/items/manufacturing_operations', payload);
			} catch (e: any) {
				throw new Error(`logging the run failed - ${directusErrorMessage(e)}`);
			}
			const id = res.data?.data?.operation_id;
			if (!id) throw new Error('run was logged but the server did not return its operation_id - cannot link the capture');
			return id;
		}, true));
	} catch (e) {
		blobReads.abort();
		throw e;
	}
	// An existing analysis row may already link some files: don't upload those again.
	await adoptExistingAnalysis(progress, opId, existing);
	if (blobs && !needsBlobs(progress, matWritten)) { blobReads.abort(); blobs = null; }

	let cacheBlob: Blob | null = null;
	let matFailure: MatFailure | null = null;
	if (blobs) {
		try {
			matFailure = await uploadCaptureFiles(info.captureId, blobs, progress, matWritten);
		} finally {
			blobReads.abort();   // a failed cache upload must not leave the .mat download running
		}
		cacheBlob = await blobs.cache;
	}
	let linked: boolean;
	try {
		// Completes an existing but partial analysis row (PATCH of the missing links), else false.
		linked = await analysisAlreadyLinked(progress, matWritten);
	} catch (e: any) {
		throw new Error(`linking the capture failed - ${directusErrorMessage(e)} (the run was logged as operation ${opId}, but its existing analysis record could not be completed)`);
	}
	if (linked) {
		if (matFailure) throw matNotUploadedError(matFailure, opId);
		return opId;
	}
	const matFileId = progress.matFileId ?? null;
	const cacheFileId = progress.cacheFileId!;

	// Same fix as the live-session upload path (workspace.ts): the force/RPM charts on the Plot
	// page read from `series` (a JSONB min/max envelope), not from live_cache_file — without this
	// the row links up fine (peaks, FRM) but every chart renders "no data" forever.
	let series: ReturnType<typeof buildSeriesEnvelope> | null = null;
	try {
		// On a resume that skipped the file uploads there is no blob in hand: read the cache again.
		const blob = cacheBlob ?? (info.cache ? null : await (await fetch(info.cacheUrl)).blob());
		const cache = info.cache ?? parseCache(await blob!.arrayBuffer());
		series = buildSeriesEnvelope(cache);
	} catch { /* best-effort — a missing series just means blank charts, not a failed upload */ }

	const crop = cropOverrideForUpload(info.summary);   // #190: the operator's crop, if one was saved
	try {
		await api.post('/items/machining_force_analysis', {
			operation_id: opId,
			directus_files_id: matFileId,
			live_cache_file: cacheFileId,
			status: 'done',
			sample_rate: sampleRate,
			feed: cfg.feed ?? null,
			cut_diameter: cfg.diam ?? null,
			max_rpm: cfg.rpm ?? null,
			peak_fx: info.peaks?.Fx ?? null,
			peak_fy: info.peaks?.Fy ?? null,
			peak_fz: info.peaks?.Fz ?? null,
			series,
			...(crop ? { crop_start_idx_override: crop.start, crop_end_idx_override: crop.end } : {}),
			matlab_version: 'force-app-direct',
			processed_at: new Date().toISOString(),
		});
		progress.analysisDone = !matFailure;
	} catch (e: any) {
		throw analysisCreateFailure(e, opId, matWritten, !!matFailure);
	}
	if (matFailure) throw matNotUploadedError(matFailure, opId);
	return opId;
}
