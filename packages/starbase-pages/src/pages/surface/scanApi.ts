// The calls of the surface scan pages: the d1-surface-scan endpoint (meta, grid, thumbnail, render again) and the
// create of a scan row. All as the signed-in user through the host's API client, so Directus permissions decide.
// The browser never talks to MinIO (spec, "Derived data"). Pure apart from the client it is given.

import { errorText, forbiddenReason, type HostApi } from '@d1/ui';
import { decodeGrid, parseMeta, ScanDataError, type ScanMeta } from './viewer/gridData';
import { scanPath, type ScanCondition } from './scanModel';

export async function fetchMeta(api: HostApi, scanId: string): Promise<ScanMeta> {
	const res = await api.get(scanPath(scanId, 'meta'), { responseType: 'json' });
	return parseMeta(res.data);
}

export const OBJECT_MISSING_MESSAGE = 'The rendered data is missing; render the scan again.';

// A request made with responseType arraybuffer fails with the error body as bytes too; read it back as JSON so the
// code and the message of the endpoint's answer are there to see.
function readErrorBody(e: unknown): void {
	const r = (e as any)?.response;
	if (!r || !(r.data instanceof ArrayBuffer)) return;
	try {
		r.data = JSON.parse(new TextDecoder().decode(r.data));
	} catch {
		/* not JSON: leave it */
	}
}

/** The endpoint's own code for "this scan says done, but its files are gone from the object store" (404 OBJECT_MISSING). */
export function isObjectMissing(e: unknown): boolean {
	return (e as any)?.response?.status === 404 && (e as any)?.response?.data?.errors?.some?.((x: any) => x?.extensions?.code === 'OBJECT_MISSING') === true;
}

export async function fetchGrid(api: HostApi, scanId: string, meta: ScanMeta): Promise<Float32Array> {
	let res;
	try {
		res = await api.get(scanPath(scanId, 'grid'), { responseType: 'arraybuffer', timeout: 120_000 });
	} catch (e) {
		readErrorBody(e);
		throw e;
	}
	const body = res.data;
	if (!(body instanceof ArrayBuffer)) throw new ScanDataError('The grid did not arrive as binary data.');
	return decodeGrid(body, meta);
}

/** The thumbnail as a Blob (an <img> cannot send the session in every host, so the client reads it). */
export async function fetchThumb(api: HostApi, scanId: string): Promise<Blob> {
	const res = await api.get(scanPath(scanId, 'thumb'), { responseType: 'blob' });
	if (!(res.data instanceof Blob)) throw new ScanDataError('The thumbnail did not arrive as an image.');
	return res.data;
}

/** Sets the scan pending again; the worker picks it up. Needs update permission on the row. */
export async function renderAgain(api: HostApi, scanId: string): Promise<void> {
	await api.post(scanPath(scanId, 'render'));
}

/** What a failed meta/grid/thumb/render call says to the person. */
export function scanErrorText(e: unknown): string {
	if (e instanceof ScanDataError) return e.message;
	const status = (e as any)?.response?.status;
	if (isObjectMissing(e)) return OBJECT_MISSING_MESSAGE;
	if (status === 404) return 'This scan has not been rendered yet, or you cannot see it.';
	if (status === 403) return forbiddenReason(e) ?? 'You do not have permission to do that with this scan.';
	return errorText(e, 'The scan could not be loaded.');
}

export interface NewScan {
	insertId?: string | null;
	edgeId?: string | null;
	fileId: string;
	condition: ScanCondition;
	conditionNote?: string | null;
	scannedOn?: string | null;
	operationId?: string | null;
}

/** The body of the create: only what the person set. The worker fills the render columns. */
export function newScanBody(s: NewScan): Record<string, unknown> {
	const body: Record<string, unknown> = { directus_files_id: s.fileId, condition: s.condition };
	if (s.edgeId) body.edge_id = s.edgeId;
	else if (s.insertId) body.insert_id = s.insertId;
	const note = s.conditionNote?.trim();
	if (note) body.condition_note = note;
	if (s.scannedOn) body.scanned_on = s.scannedOn;
	if (s.operationId) body.operation_id = s.operationId;
	return body;
}

/** A plain Directus create on surface_scans, as the caller (permissions and hooks apply). Answers 204 when the creator cannot read the row back: still a success. */
export async function createScan(api: HostApi, s: NewScan): Promise<void> {
	await api.post('/items/surface_scans', newScanBody(s));
}

/** The messages of a refused create, in words for this form. */
export function createErrors(e: unknown): string[] {
	const status = (e as any)?.response?.status;
	const list: any[] = (e as any)?.response?.data?.errors ?? [];
	if (list.some((x) => x?.extensions?.code === 'RECORD_NOT_UNIQUE')) return ['This file is already a surface scan of this item.'];
	if (status === 403) return [forbiddenReason(e) ?? 'You may not add a surface scan here.'];
	const messages = list.map((x) => x?.message).filter(Boolean) as string[];
	return messages.length ? messages : [errorText(e, 'The surface scan could not be added.')];
}
