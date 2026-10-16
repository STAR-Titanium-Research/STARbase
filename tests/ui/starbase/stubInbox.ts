import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext } from '@playwright/test';
import { D1_BASE, STAR_BASE } from './target';
import { STUB_SAMPLE } from './stubD1';
// The Inbox page's own in-memory d1-inbox (the routes of spec 2026-10-15-found-files-inbox-design.md section 9): the same fake the vitest
// page tests run against, answered through Playwright routes so STARbase runs from `vite preview` under its production CSP. Register it AFTER
// stubD1 (a later route is tried first; what it does not handle falls through to stubD1's answers).
import { createFakeInbox, exactMatch, foundFile, type FakeInboxOptions } from '../../../packages/starbase-pages/src/inbox/fakeInboxServer';

export { exactMatch, foundFile };

const cors = {
	'access-control-allow-origin': STAR_BASE,
	'access-control-allow-credentials': 'true',
	'access-control-allow-headers': 'content-type, authorization',
	'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
};

export type InboxStub = ReturnType<typeof createFakeInbox>;

// The imaging settings routes (GET /d1-inbox/sem-settings, PATCH /d1-inbox/sem-settings/<id>) are the fake's own; the stand-in knows two files from the
// d1-inbox contract fixtures: one the signed-in person owns (values, sources, a "check this", can_edit) and one that is locked.
const contract = (name: string) => JSON.parse(readFileSync(join(__dirname, '..', '..', 'fixtures', 'd1-inbox', `${name}.json`), 'utf8'));
export const STUB_SEM_OWNER_FILE: string = contract('sem_settings_owner').request.query.file;
export const STUB_SEM_LOCKED_FILE = '00000000-0000-4000-8000-000000003002';
const stubSem = () => ({ [STUB_SEM_OWNER_FILE]: contract('sem_settings_owner').body.data, [STUB_SEM_LOCKED_FILE]: contract('sem_settings_locked').body.data });

/**
 * A small inbox: two exact short-ID images (both with a picture, as the crawler stores one for an SEM image), an unflagged image, an exact surface scan
 * (Accept all leaves it), a document and one older file that names a record.
 */
export const sampleFiles = () => [
	exactMatch({ rel_path: 'Users/ab1cd/sem/3fa9c1d2_A1.tif', has_thumbnail: true }, '3fa9c1d2', 'S-0042'),
	exactMatch({ rel_path: 'Users/ab1cd/sem/9ab3c4d5_B2.tif', has_thumbnail: true, extracted: { kv: 15, magnification: 5000, scale_bar: '2 µm', instrument: 'JEOL' } }, '9ab3c4d5', 'S-0043'),
	foundFile({ rel_path: 'Users/ab1cd/misc/plain.tif' }),
	exactMatch({ kind: 'surface_scan', rel_path: 'Users/ab1cd/scans/edge1.al3d' }, '77aa88bb', 'S-9'),
	foundFile({ kind: 'document', rel_path: 'Users/ab1cd/notes.pdf' }),
	exactMatch({ origin: 'backlog', rel_path: 'Users/ab1cd/old/55ee66ff_old.tif' }, '55ee66ff', 'S-0010'),
];

export async function stubInbox(context: BrowserContext, opts: FakeInboxOptions = {}): Promise<InboxStub> {
	const fake = createFakeInbox({ files: sampleFiles(), sem: stubSem(), ...opts });
	await context.route(`${D1_BASE}/d1-inbox/**`, async (route) => {
		const req = route.request();
		const url = new URL(req.url());
		const method = req.method().toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
		if (method === ('options' as string)) return route.fulfill({ status: 204, headers: cors });
		const params = Object.fromEntries(url.searchParams.entries());
		const body = req.postData() ? req.postDataJSON() : undefined;
		try {
			const res = await (fake.api[method] as any)(url.pathname, ...(method === 'get' || method === 'delete' ? [{ params, responseType: 'blob' }] : [body]));
			// a picture is the image itself, not JSON
			if (res.data instanceof Blob) return route.fulfill({ status: 200, headers: { ...cors, 'cache-control': 'private, no-cache' }, contentType: res.data.type, body: Buffer.from(await res.data.arrayBuffer()) });
			// adding an ignored folder answers 201, as the endpoint does
			return route.fulfill({ status: method === 'post' && url.pathname === '/d1-inbox/ignored-folders' ? 201 : 200, headers: cors, json: res.data });
		} catch (e: any) {
			return route.fulfill({ status: e?.response?.status ?? 500, headers: cors, json: e?.response?.data ?? { errors: [{ message: String(e?.message ?? e) }] } });
		}
	});
	// The record picker's search: the stand-in's one sample (code S-0042) is found by its code.
	await context.route(`${D1_BASE}/items/physical_samples*`, async (route) => {
		const url = new URL(route.request().url());
		const filter = url.searchParams.get('filter') ?? '';
		if (route.request().method() === 'GET' && !url.pathname.endsWith(STUB_SAMPLE.sample_id) && filter.includes('S-0042')) {
			return route.fulfill({ status: 200, headers: cors, json: { data: [STUB_SAMPLE] } });
		}
		return route.fallback();
	});
	// The Add a surface scan dialog's operation picker: one operation of the stand-in's edge, with a real id (stubScans.ts's own operation has a
	// made-up one, which the endpoint, and so the fake, refuses as an id).
	await context.route(`${D1_BASE}/items/manufacturing_operations*`, async (route) => {
		if (route.request().method() === 'GET' && !route.request().url().includes('aggregate')) {
			return route.fulfill({ status: 200, headers: cors, json: { data: [STUB_SCAN_OPERATION] } });
		}
		return route.fallback();
	});
	return fake;
}

/** The operation the stand-in offers for a surface scan (a UUID, as the endpoint requires). */
export const STUB_SCAN_OPERATION = {
	operation_id: '00000000-0000-4000-8000-0000000000c1',
	pass_code: 'OP-TURN-7',
	operation_sequence: 1,
	operation_date: '2026-09-29',
	process_category: 'machining',
	sample_id: { sample_code: 'S-0042' },
};
