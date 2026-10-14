import { expect, type APIRequestContext, type BrowserContext, type Page, type PlaywrightWorkerArgs } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { D1_HOST, STAR_HOST } from './hosts';

// Where the STARbase end-to-end run points (spec §5):
//   ports (default): STARbase on http://127.0.0.1:5190 (vite preview), the preview Directus on
//     http://127.0.0.1:18057. One host, so the session cookie is same-site; not Secure (plain HTTP).
//   hosts (STARBASE_E2E_MODE=hosts): step 0's two hostnames over local HTTPS (hosts.ts), Secure cookie.
export type Mode = 'ports' | 'hosts';
export const MODE: Mode = process.env.STARBASE_E2E_MODE === 'hosts' ? 'hosts' : 'ports';
export const STAR_BASE = MODE === 'hosts' ? `https://${STAR_HOST}:5191` : 'http://127.0.0.1:5190';
export const D1_BASE = MODE === 'hosts' ? `https://${D1_HOST}:18443` : 'http://127.0.0.1:18057';
// The tests' own API calls (finding ids, checking and putting values back) go straight to the preview.
export const D1_LOCAL = 'http://127.0.0.1:18057';

const repo = join(__dirname, '..', '..', '..');

// The credentials file is read on first use, not on import: spec 13 imports this file too and names its own
// file (D1_ROUTES_CREDENTIALS); a plain Directus run of spec 13 must not need the STARbase one.
let credsCache: Record<string, string> | null = null;
function creds(): Record<string, string> {
	if (!credsCache) {
		const file =
			process.env.STARBASE_E2E_CREDENTIALS || process.env.D1_ROUTES_CREDENTIALS || join(repo, '.superpowers', 'preview-credentials-d1-starbase.txt');
		credsCache = Object.fromEntries(
			readFileSync(file, 'utf8').trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
		);
	}
	return credsCache;
}

// "<email> <password>", split on the first space only.
export function account(who: 'admin' | 'member'): [string, string] {
	const v = creds()[who];
	const i = v.indexOf(' ');
	return [v.slice(0, i), v.slice(i + 1)];
}

// Where STARbase and Directus are; the defaults are this run's layout. Spec 13 passes its own origins.
export interface Origins {
	star?: string;
	d1?: string;
}

// STARbase reads /config.json at boot; vite preview has none, so each browser context answers it.
export async function pointAtD1(context: BrowserContext, o: Origins = {}): Promise<void> {
	const star = o.star ?? STAR_BASE;
	await context.route(`${star}/config.json`, (r) => r.fulfill({ json: { directusUrl: o.d1 ?? D1_BASE } }));
}

export async function fillSignIn(page: Page, who: 'admin' | 'member'): Promise<void> {
	const [email, password] = account(who);
	await page.locator('input[type="email"]').fill(email);
	await page.locator('input[type="password"]').fill(password);
	await page.getByRole('button', { name: /^sign in$/i }).click();
}

export async function signInStarbase(page: Page, who: 'admin' | 'member', o: Origins = {}): Promise<void> {
	await pointAtD1(page.context(), o);
	await page.goto(`${o.star ?? STAR_BASE}/signin`, { waitUntil: 'domcontentloaded' });
	await fillSignIn(page, who);
	await page.waitForURL((u) => !u.pathname.startsWith('/signin'), { timeout: 30_000 });
}

export async function adminApi(playwright: PlaywrightWorkerArgs['playwright'], d1: string = D1_LOCAL): Promise<APIRequestContext> {
	const [email, password] = account('admin');
	const anon = await playwright.request.newContext();
	const login = await anon.post(`${d1}/auth/login`, { data: { email, password, mode: 'json' } });
	expect(login.ok(), 'admin API login').toBeTruthy();
	const token = (await login.json()).data.access_token as string;
	await anon.dispose();
	return playwright.request.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
}

// The first record's primary key (not every collection's key is `id`), or null when the collection or its
// rows can't be read with this session (a Lab Member's refused list).
export async function findFirstId(api: APIRequestContext, collection: string, d1: string = D1_LOCAL): Promise<string | null> {
	const f = await api.get(`${d1}/fields/${collection}`);
	if (!f.ok()) return null;
	const fields = (await f.json()).data as { field: string; schema?: { is_primary_key?: boolean } }[];
	const pk = fields.find((x) => x.schema?.is_primary_key)?.field;
	if (!pk) return null;
	const r = await api.get(`${d1}/items/${collection}?limit=1&fields=${encodeURIComponent(pk)}`);
	if (!r.ok()) return null;
	const rows = (await r.json()).data as Record<string, string>[];
	return rows[0]?.[pk] != null ? String(rows[0][pk]) : null;
}

// As findFirstId, but a missing record fails the test: the admin sees every record, so none means the lookup broke.
export async function firstId(api: APIRequestContext, collection: string, d1: string = D1_LOCAL): Promise<string> {
	const id = await findFirstId(api, collection, d1);
	expect(id, `${collection}: a record to use`).toBeTruthy();
	return id!;
}

// What means STARbase broke: page errors, 5xx, a CSP refusal or any other console error. "Failed to load resource" lines
// are 4xx reads the pages handle (a Lab Member's refused lists) and missing sidecars; `ignore` adds more patterns.
export function watchErrors(page: Page, ignore: RegExp[] = []): string[] {
	const errors: string[] = [];
	page.on('pageerror', (e) => errors.push(String(e)));
	page.on('response', (r) => {
		if (r.status() >= 500) errors.push(`${r.status()} ${r.url()}`);
	});
	page.on('console', (m) => {
		if (m.type() === 'error' && !/Failed to load resource|favicon/i.test(m.text()) && !ignore.some((r) => r.test(m.text()))) errors.push(m.text());
	});
	return errors;
}
