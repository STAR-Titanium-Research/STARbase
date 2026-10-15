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

/** A small inbox: two exact short-ID images, an unflagged image, a surface scan, a document and one older file that names a record. */
export const sampleFiles = () => [
	exactMatch({ rel_path: 'Users/ab1cd/sem/3fa9c1d2_A1.tif' }, '3fa9c1d2', 'S-0042'),
	exactMatch({ rel_path: 'Users/ab1cd/sem/9ab3c4d5_B2.tif', extracted: { kv: 15, magnification: 5000, scale_bar: '2 µm', instrument: 'JEOL' } }, '9ab3c4d5', 'S-0043'),
	foundFile({ rel_path: 'Users/ab1cd/misc/plain.tif' }),
	foundFile({ kind: 'surface_scan', rel_path: 'Users/ab1cd/scans/edge1.al3d' }),
	foundFile({ kind: 'document', rel_path: 'Users/ab1cd/notes.pdf' }),
	exactMatch({ origin: 'backlog', rel_path: 'Users/ab1cd/old/77aa88bb_old.tif' }, '77aa88bb', 'S-0010'),
];

export async function stubInbox(context: BrowserContext, opts: FakeInboxOptions = {}): Promise<InboxStub> {
	const fake = createFakeInbox({ files: sampleFiles(), ...opts });
	await context.route(`${D1_BASE}/d1-inbox/**`, async (route) => {
		const req = route.request();
		const url = new URL(req.url());
		const method = req.method().toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
		if (method === ('options' as string)) return route.fulfill({ status: 204, headers: cors });
		const params = Object.fromEntries(url.searchParams.entries());
		const body = req.postData() ? req.postDataJSON() : undefined;
		try {
			const res = await (fake.api[method] as any)(url.pathname, ...(method === 'get' || method === 'delete' ? [{ params }] : [body]));
			return route.fulfill({ status: 200, headers: cors, json: res.data });
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
	// Archive files are pointer rows with no bytes in Directus, so the asset route cannot draw them: answer like Directus does.
	await context.route(`${D1_BASE}/assets/**`, (route) => route.fulfill({ status: 404, headers: cors, json: { errors: [{ message: 'File not found' }] } }));
	return fake;
}
