import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STAR_BASE, adminApi, findFirstId, firstId, signInStarbase } from '../starbase/target';

// Every STARbase page (the nav config's routes plus a first record of each kind), as an admin and as a Lab Member,
// on the preview copy of live: each must draw its page and the Explorer nav with no console error. The other kit
// users (the campaign form, the lab dashboard) are Data Studio pages and are checked on Directus.
// The route list is read from the nav config, so a page added there is checked without editing this.
//   (cd tests/ui && npx playwright test specs/13-explorer-routes.spec.ts)
// Needs: the d1-starbase preview and STARbase under vite preview (tests/ui/README.md, spec 14 section) running.

const repo = join(__dirname, '..', '..', '..');
const credsFile = process.env.D1_ROUTES_CREDENTIALS || join(repo, '.superpowers', 'preview-credentials.txt');
// "No such page" is STARbase's frame for an unknown route: a nav link with no STARbase page must fail.
const CRASH = /Unexpected Error|no Explorer host|No such page/i;
const creds = Object.fromEntries(
	readFileSync(credsFile, 'utf8').trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const ADMIN_BASE = (process.env.D1_ROUTES_ADMIN_BASE || creds.url).replace(/\/+$/, ''); // …/admin
const SERVER = ADMIN_BASE.replace(/\/admin$/, '');
// The pages are STARbase's (paths without /home, its own sign-in page); D1_ROUTES_STARBASE names another origin.
const STARBASE = (process.env.D1_ROUTES_STARBASE || STAR_BASE).replace(/\/+$/, '');
const appUrl = (path: string) => STARBASE + (path.replace(/^\/home(?=\/|$)/, '') || '/');
// The shared helpers (tests/ui/starbase/target.ts) read the same credentials file as this spec.
process.env.STARBASE_E2E_CREDENTIALS ||= credsFile;

const navSource = readFileSync(join(repo, 'packages', 'd1-ui', 'src', 'nav', 'navConfig.ts'), 'utf8');
const NAV_ROUTES = [...new Set([...navSource.matchAll(/to: '(\/home[^'?]*)'/g)].map((m) => m[1]))];
const EXTRA_ROUTES = ['/home/register-sample', '/home/people', '/home/labels', '/map'];
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
// /home/labels previews the label document in a deliberately script-free sandboxed iframe (srcdoc, sandbox="allow-same-origin"; the
// label HTML itself contains no script), so Chrome logs that the sandbox blocked a script (not from the label document; likely the host page or test browser injecting into every frame). Benign.
const IGNORED_CONSOLE = [/favicon/i, /ResizeObserver loop/, /Failed to load resource/, /Blocked script execution in 'about:srcdoc'/];

// "<email> <password>": split on the first space only, so a password may contain spaces.
function splitCreds(who: 'admin' | 'member'): [string, string] {
	const v = creds[who];
	const i = v.indexOf(' ');
	return [v.slice(0, i), v.slice(i + 1)];
}

async function signIn(page: Page, who: 'admin' | 'member') {
	await signInStarbase(page, who, { star: STARBASE, d1: SERVER });
}

// Data Studio's own sign-in, for the pages that are still Directus pages.
async function signInDirectus(page: Page, who: 'admin' | 'member') {
	const [email, password] = splitCreds(who);
	await page.goto(`${SERVER}/admin/login`, { waitUntil: 'domcontentloaded' });
	await page.locator('input[type="email"]').fill(email);
	await page.locator('input[type="password"]').fill(password);
	await page.getByRole('button', { name: /sign in/i }).click();
	await page.waitForURL((u) => !u.pathname.endsWith('/login'), { timeout: 30_000 });
}

// Record ids come from an admin API session (the shared helpers in tests/ui/starbase/target.ts), so both accounts visit the same pages.

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
	await page.goto(appUrl(path), { waitUntil: 'networkidle' });
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
			const api = await adminApi(playwright, SERVER);
			const records: string[] = [];
			for (const [collection, prefix] of RECORDS) {
				// The admin sees every record, so a missing id fails inside firstId.
				const id = await firstId(api, collection, SERVER);
				records.push(prefix + encodeURIComponent(id));
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
			const api = await adminApi(playwright, SERVER);
			const adminCampaign = await findFirstId(api, 'campaigns', SERVER);
			await api.dispose();
			expect(adminCampaign, 'campaigns: an id to visit').not.toBeNull();
			await signInDirectus(page, who);
			errors.length = 0;

			// A Lab Member may read only some campaigns, and Directus shows "Page Not Found" for one it may not
			// read, so the member opens a campaign it can read itself (its own session), if it has any.
			const campaign = who === 'admin' ? adminCampaign : await findFirstId(page.request, 'campaigns', SERVER);
			if (campaign) {
				// d1-campaign-ops: the interface root (.co) sits inside the campaign form.
				await page.goto(`${ADMIN_BASE}/content/campaigns/${encodeURIComponent(campaign)}`, { waitUntil: 'networkidle' });
				await expect(page.locator('.v-form').first(), 'campaign form').toBeVisible();
				// Migration 174 put the interface in the collapsed "Related records" group: open it to render .co.
				await page.locator('.v-form .v-detail.group-detail', { hasText: 'Related records' }).locator('.v-divider').first().click();
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
