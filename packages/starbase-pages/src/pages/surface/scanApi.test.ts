import { describe, expect, it } from 'vitest';
import type { HostApi } from '@d1/ui';
import {
	createErrors, createScan, fetchGrid, fetchMeta, fetchScans, fetchThumb, FILE_LOCKED_MESSAGE, isFileLocked, isObjectMissing, newScanBody, OBJECT_MISSING_MESSAGE, renderAgain, scanErrorText,
} from './scanApi';
import { ScanDataError } from './viewer/gridData';

function fakeApi(handlers: Partial<Record<'get' | 'post', (path: string, ...rest: any[]) => any>>) {
	const calls: Array<{ method: string; path: string; body?: unknown; config?: any }> = [];
	const api = {
		get: async (path: string, config?: any) => { calls.push({ method: 'get', path, config }); return handlers.get!(path, config); },
		post: async (path: string, body?: unknown) => { calls.push({ method: 'post', path, body }); return handlers.post!(path, body); },
	} as unknown as HostApi;
	return { api, calls };
}
const httpError = (status: number, errors: unknown[] = []) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data: { errors } } });

describe('fetchMeta and fetchGrid', () => {
	it('reads /meta as JSON and checks it', async () => {
		const { api, calls } = fakeApi({ get: () => ({ data: { width: 2, height: 2, z_min_um: 0, z_max_um: 1 } }) });
		const meta = await fetchMeta(api, 's1');
		expect(meta.width).toBe(2);
		expect(calls[0].path).toBe('/d1-surface-scan/s1/meta');
	});
	it('reads /grid as binary and refuses a length that does not match', async () => {
		const meta = await fetchMeta(fakeApi({ get: () => ({ data: { width: 2, height: 2 } }) }).api, 's1');
		const good = fakeApi({ get: () => ({ data: new Float32Array([1, 2, 3, 4]).buffer }) });
		expect(Array.from(await fetchGrid(good.api, 's1', meta))).toEqual([1, 2, 3, 4]);
		expect(good.calls[0].config.responseType).toBe('arraybuffer');
		await expect(fetchGrid(fakeApi({ get: () => ({ data: new ArrayBuffer(8) }) }).api, 's1', meta)).rejects.toBeInstanceOf(ScanDataError);
		await expect(fetchGrid(fakeApi({ get: () => ({ data: 'text' }) }).api, 's1', meta)).rejects.toBeInstanceOf(ScanDataError);
	});
	it('reads /thumb as a blob', async () => {
		const blob = new Blob(['x'], { type: 'image/png' });
		expect(await fetchThumb(fakeApi({ get: () => ({ data: blob }) }).api, 's1')).toBe(blob);
		await expect(fetchThumb(fakeApi({ get: () => ({ data: 'no' }) }).api, 's1')).rejects.toBeInstanceOf(ScanDataError);
	});
});

describe('fetchScans', () => {
	const readable = { scan_id: 's1', insert_id: 'i1', edge_id: null, locked: false, condition: 'new', scanned_on: '2026-06-12', file: { id: 'f1', name: 'a.al3d' }, render_status: 'done', can_edit: true };
	const locked = { scan_id: 's2', insert_id: 'i1', edge_id: null, locked: true, condition: 'worn', scanned_on: '2026-07-01', operation: { id: 'o1', label: 'OP-1' } };
	it('reads /d1-surface-scan/scans with the ids it was given, not /items', async () => {
		const { api, calls } = fakeApi({ get: () => ({ data: { data: [readable, locked] } }) });
		const rows = await fetchScans(api, { insertId: 'i1', edgeId: 'e1' });
		expect(calls).toHaveLength(1);
		expect(calls[0].path).toBe('/d1-surface-scan/scans');
		expect(calls[0].config.params).toEqual({ insert_id: 'i1', edge_id: 'e1' });
		expect(rows.map((r) => [r.id, r.locked])).toEqual([['s1', false], ['s2', true]]);
		expect(rows[1].file).toBeNull();
	});
	it('asks with the insert only on an insert page, and skips the call when it has no id', async () => {
		const { api, calls } = fakeApi({ get: () => ({ data: { data: [] } }) });
		await fetchScans(api, { insertId: 'i1' });
		expect(calls[0].config.params).toEqual({ insert_id: 'i1' });
		expect(await fetchScans(api, {})).toEqual([]);
		expect(calls).toHaveLength(1);
	});
	it('tolerates a bare array and an odd body, and drops rows without an id', async () => {
		expect((await fetchScans(fakeApi({ get: () => ({ data: [readable] }) }).api, { insertId: 'i1' })).map((r) => r.id)).toEqual(['s1']);
		expect(await fetchScans(fakeApi({ get: () => ({ data: { data: [{ locked: true }] } }) }).api, { insertId: 'i1' })).toEqual([]);
		expect(await fetchScans(fakeApi({ get: () => ({ data: null }) }).api, { insertId: 'i1' })).toEqual([]);
	});
});

describe('renderAgain', () => {
	it('posts to /render', async () => {
		const { api, calls } = fakeApi({ post: () => ({ data: {} }) });
		await renderAgain(api, 's1');
		expect(calls[0]).toMatchObject({ method: 'post', path: '/d1-surface-scan/s1/render' });
	});
});

describe('newScanBody and createScan', () => {
	it('sends only what was set, for an edge', () => {
		expect(newScanBody({ edgeId: 'e1', insertId: 'i1', fileId: 'f1', condition: 'worn', conditionNote: '  ', scannedOn: '', operationId: null }))
			.toEqual({ directus_files_id: 'f1', condition: 'worn', edge_id: 'e1' });
	});
	it('sets the insert only when there is no edge, and every optional column when given', () => {
		expect(newScanBody({ insertId: 'i1', fileId: 'f1', condition: 'other', conditionNote: ' glued ', scannedOn: '2026-10-01', operationId: 'o1' }))
			.toEqual({ directus_files_id: 'f1', condition: 'other', insert_id: 'i1', condition_note: 'glued', scanned_on: '2026-10-01', operation_id: 'o1' });
	});
	it('is one plain create on surface_scans', async () => {
		const { api, calls } = fakeApi({ post: () => ({ data: null }) }); // 204: nothing comes back, and that is a success
		await createScan(api, { insertId: 'i1', fileId: 'f1', condition: 'new' });
		expect(calls[0]).toMatchObject({ method: 'post', path: '/items/surface_scans', body: { insert_id: 'i1', directus_files_id: 'f1', condition: 'new' } });
	});
});

describe('error texts', () => {
	it('says a duplicate file in words', () => {
		expect(createErrors(httpError(400, [{ message: 'Value has to be unique', extensions: { code: 'RECORD_NOT_UNIQUE' } }]))).toEqual(['This file is already a surface scan of this item.']);
	});
	it('gives every message of a refused create, a permission text for 403, and a fallback for no body', () => {
		expect(createErrors(httpError(400, [{ message: 'A' }, { message: 'B' }]))).toEqual(['A', 'B']);
		expect(createErrors(httpError(403, [{ message: "You don't have permission", extensions: { code: 'FORBIDDEN' } }]))[0]).toMatch(/may not add a surface scan/);
		expect(createErrors(new Error('Network Error'))).toEqual(['Network Error']);
		expect(createErrors({})).toEqual(['The surface scan could not be added.']);
	});
	it('names OBJECT_MISSING (a done scan whose files are gone) and offers the way out, also when the body came as bytes', async () => {
		const missing = httpError(404, [{ message: OBJECT_MISSING_MESSAGE, extensions: { code: 'OBJECT_MISSING' } }]);
		expect(isObjectMissing(missing)).toBe(true);
		expect(isObjectMissing(httpError(404, [{ extensions: { code: 'NOT_RENDERED' } }]))).toBe(false);
		expect(isObjectMissing(httpError(500, [{ extensions: { code: 'OBJECT_MISSING' } }]))).toBe(false);
		expect(scanErrorText(missing)).toBe('The rendered data is missing; render the scan again.');
		// /grid is read as an arraybuffer: its error body is bytes until fetchGrid decodes it
		const bytes = httpError(404);
		(bytes as any).response.data = new TextEncoder().encode(JSON.stringify({ errors: [{ message: OBJECT_MISSING_MESSAGE, extensions: { code: 'OBJECT_MISSING' } }] })).buffer;
		const meta = await fetchMeta(fakeApi({ get: () => ({ data: { width: 2, height: 2 } }) }).api, 's1');
		const err = await fetchGrid(fakeApi({ get: () => { throw bytes; } }).api, 's1', meta).catch((e) => e);
		expect(isObjectMissing(err)).toBe(true);
		expect(scanErrorText(err)).toBe(OBJECT_MISSING_MESSAGE);
	});
	it('says in words that a scan’s file belongs to someone else (403 FILE_LOCKED), and keeps other 403s as they were', async () => {
		const locked = httpError(403, [{ message: 'locked', extensions: { code: 'FILE_LOCKED' } }]);
		expect(isFileLocked(locked)).toBe(true);
		expect(isFileLocked(httpError(404, [{ extensions: { code: 'FILE_LOCKED' } }]))).toBe(false);
		expect(isFileLocked(httpError(403, [{ extensions: { code: 'FORBIDDEN' } }]))).toBe(false);
		expect(FILE_LOCKED_MESSAGE).toBe("This scan's file belongs to someone else, so it cannot be shown.");
		expect(scanErrorText(locked)).toBe(FILE_LOCKED_MESSAGE);
		expect(scanErrorText(httpError(403, [{ extensions: { code: 'FORBIDDEN' } }]))).toMatch(/do not have permission/);
		// /grid is read as an arraybuffer: its 403 body is bytes until fetchGrid decodes it
		const bytes = httpError(403);
		(bytes as any).response.data = new TextEncoder().encode(JSON.stringify({ errors: [{ message: 'locked', extensions: { code: 'FILE_LOCKED' } }] })).buffer;
		const meta = await fetchMeta(fakeApi({ get: () => ({ data: { width: 2, height: 2 } }) }).api, 's1');
		const err = await fetchGrid(fakeApi({ get: () => { throw bytes; } }).api, 's1', meta).catch((e) => e);
		expect(scanErrorText(err)).toBe(FILE_LOCKED_MESSAGE);
	});
	it('shows the d1-access-guard’s reason when it refuses a scan of a file the person cannot read', () => {
		const reason = 'You can only add a surface scan of a file you can see.';
		const guard = httpError(403, [{ message: reason, extensions: { code: 'FORBIDDEN', reason, source: 'd1-access-guard', kind: 'junction', collection: 'surface_scans', parent: 'directus_files' } }]);
		expect(createErrors(guard)).toEqual([reason]);
	});
	it('explains a 404 from the endpoint as not rendered yet', () => {
		expect(scanErrorText(httpError(404))).toMatch(/not been rendered/);
		expect(scanErrorText(new ScanDataError('bad grid'))).toBe('bad grid');
		expect(scanErrorText(httpError(500, [{ message: 'boom' }]))).toBe('boom');
	});
});
