import { expect, type APIRequestContext, type Page, type PlaywrightWorkerArgs } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Where the LOCAL STACK of scripts/dev/local-stack.sh answers: STARbase's vite dev server and the real Directus (with the repo's
// extensions) on a real Postgres. The ports are the script's own defaults (override with the same variables on both sides).
// The test logins are in the credentials file the script writes (the format of target.ts: `admin=<email> <password>`, plus `viewer=`).
export const STACK_DIR = process.env.D1_STACK_DIR ?? '/tmp/d1-local-stack';
export const D1 = `http://127.0.0.1:${process.env.D1_STACK_DIRECTUS_PORT ?? 18057}`;
export const STAR = `http://127.0.0.1:${process.env.D1_STACK_STARBASE_PORT ?? 5190}`;
export const CREDENTIALS_FILE = process.env.D1_STACK_CREDENTIALS ?? join(STACK_DIR, 'credentials.txt');

export type Who = 'admin' | 'member' | 'viewer';

export const stackAvailable = (): boolean => existsSync(CREDENTIALS_FILE);

let creds: Record<string, string> | null = null;
export function account(who: Who): [string, string] {
	creds ??= Object.fromEntries(
		readFileSync(CREDENTIALS_FILE, 'utf8').trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
	);
	const v = creds[who];
	if (!v) throw new Error(`no ${who} login in ${CREDENTIALS_FILE}: run \`bash scripts/dev/local-stack.sh up\``);
	const i = v.indexOf(' ');
	return [v.slice(0, i), v.slice(i + 1)];
}

/** Signs a browser page in to STARbase as one of the three seeded accounts (the same form a person fills in). */
export async function signIn(page: Page, who: Who): Promise<void> {
	const [email, password] = account(who);
	await page.goto(`${STAR}/signin`, { waitUntil: 'domcontentloaded' });
	await page.locator('input[type="email"]').fill(email);
	await page.locator('input[type="password"]').fill(password);
	await page.getByRole('button', { name: /^sign in$/i }).click();
	await page.waitForURL((u) => !u.pathname.startsWith('/signin'), { timeout: 30_000 });
}

/** An API context that talks to Directus as one of the seeded accounts (a Bearer token from /auth/login). */
export async function apiAs(playwright: PlaywrightWorkerArgs['playwright'], who: Who): Promise<APIRequestContext> {
	const [email, password] = account(who);
	const anon = await playwright.request.newContext();
	const login = await anon.post(`${D1}/auth/login`, { data: { email, password, mode: 'json' } });
	expect(login.ok(), `${who} API login`).toBeTruthy();
	const token = (await login.json()).data.access_token as string;
	await anon.dispose();
	return playwright.request.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
}

/** One record through the REST API, as whoever `api` is; a failed read fails the test with the server's answer. */
export async function readRecord<T extends Record<string, unknown>>(api: APIRequestContext, collection: string, id: string, fields: string): Promise<T> {
	const r = await api.get(`${D1}/items/${collection}/${id}?fields=${encodeURIComponent(fields)}`);
	expect(r.ok(), `GET ${collection}/${id}: ${r.status()} ${await r.text()}`).toBeTruthy();
	return (await r.json()).data as T;
}

/** The rows of a list query (an admin's: sees every record). */
export async function listRecords<T extends Record<string, unknown>>(api: APIRequestContext, collection: string, query: string): Promise<T[]> {
	const r = await api.get(`${D1}/items/${collection}?${query}`);
	expect(r.ok(), `GET ${collection}?${query}: ${r.status()} ${await r.text()}`).toBeTruthy();
	return (await r.json()).data as T[];
}
