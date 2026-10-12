import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Every page of the Home module (the future STARbase pages), as an admin and as a Lab Member, on
// the preview copy of live: each must draw its page and the Explorer nav with no console error.
// The route list is read from the nav config, so a page added there is checked without editing this.
//   (cd tests/ui && npx playwright test specs/13-explorer-routes.spec.ts)
// Needs: bash scripts/dev/explorer_preview.sh (from the repo root) running.

const repo = join(__dirname, '..', '..', '..');
const credsFile = process.env.D1_ROUTES_CREDENTIALS || join(repo, '.superpowers', 'preview-credentials.txt');
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

async function signIn(page: Page, who: 'admin' | 'member') {
	const [email, password] = creds[who].split(' ');
	await page.goto(`${SERVER}/admin/login`, { waitUntil: 'domcontentloaded' });
	await page.locator('input[type="email"]').fill(email);
	await page.locator('input[type="password"]').fill(password);
	await page.getByRole('button', { name: /sign in/i }).click();
	await page.waitForURL((u) => !u.pathname.endsWith('/login'), { timeout: 30_000 });
}

// Not every collection's primary key is `id` (physical_samples uses `sample_id`), so ask for it.
async function firstId(page: Page, collection: string): Promise<string | null> {
	const f = await page.request.get(`${SERVER}/fields/${collection}`);
	if (!f.ok()) return null;
	const fields = (await f.json()).data as { field: string; schema?: { is_primary_key?: boolean } }[];
	const pk = fields.find((x) => x.schema?.is_primary_key)?.field;
	if (!pk) return null;
	const r = await page.request.get(`${SERVER}/items/${collection}?limit=1&fields=${encodeURIComponent(pk)}`);
	if (!r.ok()) return null;
	const rows = (await r.json()).data as Record<string, string>[];
	return rows[0]?.[pk] ?? null;
}

async function visit(page: Page, path: string, errors: string[]) {
	errors.length = 0;
	await page.goto(`${ADMIN_BASE}${path}`, { waitUntil: 'networkidle' });
	await expect(page.locator('.d1-page').first(), `${path}: page body`).toBeVisible();
	await expect(page.locator('nav.d1-nav').first(), `${path}: Explorer nav`).toBeVisible();
	await expect(page.locator('body'), `${path}: no crash text`).not.toContainText(/Unexpected Error|no Explorer host/i);
	expect(errors, `${path}: console errors`).toEqual([]);
}

for (const who of ['admin', 'member'] as const) {
	test.describe(`Home module routes as ${who}`, () => {
		test.setTimeout(10 * 60_000);

		test('every page draws with no console error', async ({ page }) => {
			const errors: string[] = [];
			page.on('pageerror', (e) => errors.push(String(e)));
			page.on('response', (r) => {
				if (r.status() >= 500) errors.push(`${r.status()} ${r.url()}`);
			});
			page.on('console', (m) => {
				if (m.type() === 'error' && !IGNORED_CONSOLE.some((r) => r.test(m.text()))) errors.push(m.text());
			});
			await signIn(page, who);
			for (const path of ROUTES) await visit(page, path, errors);
			for (const [collection, prefix] of RECORDS) {
				const id = await firstId(page, collection);
				// The admin sees every record, so a missing id means the lookup broke, not a permission.
				if (who === 'admin') expect(id, `${collection}: an id to visit`).not.toBeNull();
				if (id) await visit(page, prefix + encodeURIComponent(id), errors);
			}
		});

		test('the other kit users still render', async ({ page }) => {
			const errors: string[] = [];
			page.on('pageerror', (e) => errors.push(String(e)));
			await signIn(page, who);
			const campaign = await firstId(page, 'campaigns');
			if (campaign) {
				await page.goto(`${ADMIN_BASE}/content/campaigns/${campaign}`, { waitUntil: 'networkidle' });
				await expect(page.locator('body')).not.toContainText(/no Explorer host/i);
			}
			await page.goto(`${ADMIN_BASE}/d1-lab-dashboard`, { waitUntil: 'networkidle' });
			await expect(page.locator('body')).not.toContainText(/no Explorer host/i);
			expect(errors).toEqual([]);
		});
	});
}
