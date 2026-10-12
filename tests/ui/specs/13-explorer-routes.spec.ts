import { test, expect, type APIRequestContext, type Page, type PlaywrightWorkerArgs } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Every page of the Home module (the future STARbase pages), as an admin and as a Lab Member, on
// the preview copy of live: each must draw its page and the Explorer nav with no console error.
// The route list is read from the nav config, so a page added there is checked without editing this.
//   (cd tests/ui && npx playwright test specs/13-explorer-routes.spec.ts)
// Needs: bash scripts/dev/explorer_preview.sh (from the repo root) running.

const repo = join(__dirname, '..', '..', '..');
const credsFile = process.env.D1_ROUTES_CREDENTIALS || join(repo, '.superpowers', 'preview-credentials.txt');
const CRASH = /Unexpected Error|no Explorer host/i;
const creds = Object.fromEntries(
	readFileSync(credsFile, 'utf8').trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const ADMIN_BASE = (process.env.D1_ROUTES_ADMIN_BASE || creds.url).replace(/\/+$/, ''); // …/admin
const SERVER = ADMIN_BASE.replace(/\/admin$/, '');

const navSource = readFileSync(join(repo, 'packages', 'd1-ui', 'src', 'nav', 'navConfig.ts'), 'utf8');
const NAV_ROUTES = [...new Set([...navSource.matchAll(/to: '(\/home[^'?]*)'/g)].map((m) => m[1]))];
const EXTRA_ROUTES = ['/home/register-sample', '/home/people', '/home/labels'];
const ROUTES = [...new Set([...NAV_ROUTES, ...EXTRA_ROUTES])];

const RECORDS: [string, string][] = [
	['physical_samples', '/home/samples/'],
	['manufacturing_operations', '/home/operations/'],
	['test_sessions', '/home/tests/'],
	['campaigns', '/home/campaigns/'],
	['projects', '/home/projects/'],
];

// Chrome logs every 4xx resource as a console error; a Lab Member's refused reads are handled by the
// pages, so those are ignored here and real breakage is caught as a 5xx response (see visit()).
const IGNORED_CONSOLE = [/favicon/i, /ResizeObserver loop/, /Failed to load resource/];

// "<email> <password>": split on the first space only, so a password may contain spaces.
function splitCreds(who: 'admin' | 'member'): [string, string] {
	const v = creds[who];
	const i = v.indexOf(' ');
	return [v.slice(0, i), v.slice(i + 1)];
}

async function signIn(page: Page, who: 'admin' | 'member') {
	const [email, password] = splitCreds(who);
	await page.goto(`${SERVER}/admin/login`, { waitUntil: 'domcontentloaded' });
	await page.locator('input[type="email"]').fill(email);
	await page.locator('input[type="password"]').fill(password);
	await page.getByRole('button', { name: /sign in/i }).click();
	await page.waitForURL((u) => !u.pathname.endsWith('/login'), { timeout: 30_000 });
}

// Not every collection's primary key is `id` (physical_samples uses `sample_id`), so ask for it.
// Record ids come from an admin API session, so both accounts visit the same pages.
async function firstId(api: APIRequestContext, collection: string): Promise<string | null> {
	const f = await api.get(`${SERVER}/fields/${collection}`);
	if (!f.ok()) return null;
	const fields = (await f.json()).data as { field: string; schema?: { is_primary_key?: boolean } }[];
	const pk = fields.find((x) => x.schema?.is_primary_key)?.field;
	if (!pk) return null;
	const r = await api.get(`${SERVER}/items/${collection}?limit=1&fields=${encodeURIComponent(pk)}`);
	if (!r.ok()) return null;
	const rows = (await r.json()).data as Record<string, string>[];
	return rows[0]?.[pk] ?? null;
}

async function adminApi(playwright: PlaywrightWorkerArgs['playwright']): Promise<APIRequestContext> {
	const [email, password] = splitCreds('admin');
	const anon = await playwright.request.newContext();
	const login = await anon.post(`${SERVER}/auth/login`, { data: { email, password, mode: 'json' } });
	expect(login.ok(), 'admin API login').toBeTruthy();
	const token = (await login.json()).data.access_token as string;
	await anon.dispose();
	return playwright.request.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
}

// Collects page errors, 5xx responses and unignored console errors into `errors`.
function collectErrors(page: Page, errors: string[]) {
	page.on('pageerror', (e) => errors.push(String(e)));
	page.on('response', (r) => {
		if (r.status() >= 500) errors.push(`${r.status()} ${r.url()}`);
	});
	page.on('console', (m) => {
		if (m.type() === 'error' && !IGNORED_CONSOLE.some((r) => r.test(m.text()))) errors.push(m.text());
	});
}

async function visit(page: Page, path: string, errors: string[]) {
	errors.length = 0;
	await page.goto(`${ADMIN_BASE}${path}`, { waitUntil: 'networkidle' });
	// A record the Lab Member may not read draws NotVisible, which sits inside PageShell (.d1-page): it counts as drawn.
	await expect(page.locator('.d1-page').first(), `${path}: page body`).toBeVisible();
	await expect(page.locator('nav.d1-nav').first(), `${path}: Explorer nav`).toBeVisible();
	await expect(page.locator('body'), `${path}: no crash text`).not.toContainText(CRASH);
	expect(errors, `${path}: console errors`).toEqual([]);
}

for (const who of ['admin', 'member'] as const) {
	test.describe(`Home module routes as ${who}`, () => {
		test.setTimeout(10 * 60_000);

		test('every page draws with no console error', async ({ page, playwright }) => {
			const errors: string[] = [];
			collectErrors(page, errors);
			const api = await adminApi(playwright);
			const records: string[] = [];
			for (const [collection, prefix] of RECORDS) {
				const id = await firstId(api, collection);
				// The admin sees every record, so a missing id means the lookup broke.
				expect(id, `${collection}: an id to visit`).not.toBeNull();
				records.push(prefix + encodeURIComponent(id!));
			}
			await api.dispose();
			await signIn(page, who);
			for (const path of ROUTES) await visit(page, path, errors);
			for (const path of records) await visit(page, path, errors);
			console.log(`${who}: ${ROUTES.length} routes and ${records.length} record pages visited`);
		});

		test('the other kit users still render', async ({ page, playwright }) => {
			const errors: string[] = [];
			collectErrors(page, errors);
			const api = await adminApi(playwright);
			const adminCampaign = await firstId(api, 'campaigns');
			await api.dispose();
			expect(adminCampaign, 'campaigns: an id to visit').not.toBeNull();
			await signIn(page, who);
			errors.length = 0;

			// A Lab Member may read only some campaigns, and Directus shows "Page Not Found" for one it may not
			// read, so the member opens a campaign it can read itself (its own session), if it has any.
			const campaign = who === 'admin' ? adminCampaign : await firstId(page.request, 'campaigns');
			if (campaign) {
				// d1-campaign-ops: the interface root (.co) sits inside the campaign form.
				await page.goto(`${ADMIN_BASE}/content/campaigns/${encodeURIComponent(campaign)}`, { waitUntil: 'networkidle' });
				await expect(page.locator('.v-form').first(), 'campaign form').toBeVisible();
				await expect(page.locator('.co').first(), 'campaign-ops panel').toBeVisible();
				await expect(page.locator('body'), 'campaign form: no crash text').not.toContainText(CRASH);
			} else {
				console.log('member: no readable campaign, campaign form not checked');
			}

			// d1-lab-dashboard: / redirects to the samples view, whose root is .d1-samples.
			await page.goto(`${ADMIN_BASE}/d1-lab-dashboard`, { waitUntil: 'networkidle' });
			const dash = page.locator('.d1-samples, .d1-machining').first();
			await expect(dash, 'lab dashboard root').toBeVisible();
			expect((await dash.innerText()).trim(), 'lab dashboard text').not.toBe('');
			await expect(page.locator('body'), 'lab dashboard: no crash text').not.toContainText(CRASH);

			expect(errors).toEqual([]);
		});
	});
}
