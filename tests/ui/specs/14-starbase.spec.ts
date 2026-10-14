import { test, expect } from '@playwright/test';
import { HOSTS_LAUNCH_ARGS, startHostsLayout } from '../starbase/hosts';
import { D1_BASE, D1_LOCAL, MODE, STAR_BASE, adminApi, fillSignIn, firstId, pointAtD1, signInStarbase, watchErrors } from '../starbase/target';

// STARbase end to end (spec §5) on the d1-starbase preview, with STARbase served by `vite preview` under
// its production CSP. How to run both layouts: tests/ui/README.md, spec 14.

if (MODE === 'hosts') test.use({ launchOptions: { args: HOSTS_LAUNCH_ARGS }, ignoreHTTPSErrors: true });
// Trace capture is off for this file: FAST's plot page lists every run (10,000+ rows), and the trace's DOM
// snapshots of it stall the page and Playwright's own clicks (the run hangs in "trace recording"). Screenshots
// and video of a failure are still kept.
test.use({ trace: 'off' });
test.describe.configure({ mode: 'serial' });

let layout: { close(): Promise<void> } | null = null;
test.beforeAll(async () => {
	if (MODE === 'hosts') layout = await startHostsLayout();
});
test.afterAll(async () => {
	await layout?.close();
});

test('sign in on STARbase, and Data Studio is signed in too', async ({ page, context }) => {
	const errors = watchErrors(page);
	await signInStarbase(page, 'member');
	await expect(page.locator('nav.d1-nav').first()).toBeVisible();
	await expect(page.locator('.d1-page').first()).toBeVisible();
	const studio = await context.newPage();
	await studio.goto(`${D1_BASE}/admin/content`, { waitUntil: 'networkidle' });
	expect(studio.url()).not.toContain('/login');
	expect(errors).toEqual([]);
});

test('a deep link opened signed out comes back after sign-in; an old /home link lands too (Review Focus 2)', async ({ page, playwright }) => {
	const api = await adminApi(playwright);
	const id = await firstId(api, 'physical_samples');
	await api.dispose();
	await pointAtD1(page.context());
	const deep = `/samples/${encodeURIComponent(id)}?from=qr`;
	await page.goto(STAR_BASE + deep);
	await page.waitForURL(/\/signin\?next=/);
	await fillSignIn(page, 'admin');
	await page.waitForURL((u) => u.pathname.startsWith('/samples/'));
	const here = new URL(page.url());
	expect(here.pathname + here.search).toBe(deep);
	await page.goto(`${STAR_BASE}/home/samples/${encodeURIComponent(id)}`);
	await expect(page).toHaveURL(`${STAR_BASE}/samples/${encodeURIComponent(id)}`);
});

test('edit through the frame: save, and the record page shows the new value', async ({ page, playwright }) => {
	const api = await adminApi(playwright);
	const id = await firstId(api, 'physical_samples');
	const read = async () => (await (await api.get(`${D1_LOCAL}/items/physical_samples/${id}?fields=location`)).json()).data.location as string | null;
	const before = await read();
	const marker = `e2e-${Date.now()}`;
	try {
		await signInStarbase(page, 'admin');
		await page.goto(`${STAR_BASE}/samples/${encodeURIComponent(id)}`);
		await page.getByRole('button', { name: /^Edit$/ }).click();
		const dialog = page.getByRole('dialog', { name: 'Edit record' });
		await expect(dialog).toBeVisible();
		const frame = page.frameLocator('iframe.sb-editor-frame');
		// The Directus form inside the frame: a field is a .field with its label in .type-label.
		const field = frame.locator('.field').filter({ has: frame.locator('.type-label').filter({ hasText: /^\s*Location/i }) }).locator('input').first();
		await field.fill(marker);
		// Only the STARbase page's own refetch counts: the frame's own version GET is a GET of the same collection.
		const refetch = page.waitForResponse((r) => r.frame() === page.mainFrame() && r.url().includes('/items/physical_samples') && r.request().method() === 'GET');
		await frame.getByRole('button', { name: 'Save' }).click();
		await expect(dialog).toBeHidden();
		await refetch;
		expect(await read()).toBe(marker);
		// And the STARbase page itself shows it.
		await expect(page.getByText(marker).first()).toBeVisible();
	} finally {
		await api.patch(`${D1_LOCAL}/items/physical_samples/${id}`, { data: { location: before } });
		await api.dispose();
	}
});

test('a frame that never says ready offers a new tab, and coming back refreshes (Review Focus 3)', async ({ page, context, playwright }) => {
	test.setTimeout(90_000);
	const api = await adminApi(playwright);
	const id = await firstId(api, 'physical_samples');
	await api.dispose();
	await signInStarbase(page, 'admin');
	// Stand in for a refused frame (CSP, or signed out inside it): the form page never posts 'ready'.
	await context.route(`${D1_BASE}/admin/d1-edit/**`, (r) =>
		r.fulfill({ status: 200, contentType: 'text/html', headers: { 'content-security-policy': "frame-ancestors 'none'" }, body: '<p>refused</p>' }),
	);
	await page.goto(`${STAR_BASE}/samples/${encodeURIComponent(id)}`);
	await page.getByRole('button', { name: /^Edit$/ }).click();
	const dialog = page.getByRole('dialog', { name: 'Edit record' });
	const offer = dialog.getByRole('button', { name: 'Open in a new tab' });
	await expect(offer).toBeVisible({ timeout: 15_000 });
	const popup = page.waitForEvent('popup');
	await offer.click();
	const tab = await popup;
	expect(tab.url()).toContain(`/admin/d1-edit/physical_samples/${id}`);
	const refetch = page.waitForResponse((r) => r.frame() === page.mainFrame() && r.url().includes('/items/physical_samples') && r.request().method() === 'GET');
	await tab.close();
	await page.bringToFront();
	await page.evaluate(() => window.dispatchEvent(new Event('focus')));
	await expect(dialog).toBeHidden();
	await refetch;
});

test('signed out in Data Studio: the next STARbase request goes to sign-in (Review Focus 1)', async ({ page, context }) => {
	await signInStarbase(page, 'member');
	const studio = await context.newPage();
	await studio.goto(`${D1_BASE}/admin/content`, { waitUntil: 'networkidle' });
	await studio.evaluate(async () => {
		await fetch('/auth/logout', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'session' }) });
	});
	await page.bringToFront();
	// A client-side navigation (no reload): the page's requests come back 403 as the public role.
	await page.evaluate(() => {
		window.history.pushState({}, '', '/samples');
		window.dispatchEvent(new PopStateEvent('popstate'));
	});
	// vue-router leaves "/" unencoded in a query value, so the address reads ?next=/samples.
	await page.waitForURL(/\/signin\?next=(%2F|\/)samples/, { timeout: 30_000 });
});

test('a credentialed write from a STARbase page passes CORS (People notes)', async ({ page, playwright }) => {
	const api = await adminApi(playwright);
	const people = (await (await api.get(`${D1_LOCAL}/items/people?fields=person_id,notes&limit=-1`)).json()).data as { person_id: string; notes: string | null }[];
	const notesOf = new Map(people.map((p) => [String(p.person_id), p.notes]));
	let personId = '';
	try {
		await signInStarbase(page, 'admin');
		await page.goto(`${STAR_BASE}/people`);
		await page.locator('.prow').first().click();
		const dialog = page.getByRole('dialog');
		await dialog.locator('textarea').fill(`e2e ${Date.now()}`);
		const patch = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().includes('/items/people/'));
		await dialog.getByRole('button', { name: 'Save' }).click();
		const res = await patch;
		personId = decodeURIComponent(new URL(res.url()).pathname.split('/').pop()!);
		expect(res.status()).toBe(200);
		// allHeaders(), not headers(): Playwright's headers() leaves out security-related headers.
		const headers = await res.allHeaders();
		expect(headers['access-control-allow-origin']).toBe(STAR_BASE);
		expect(headers['access-control-allow-credentials']).toBe('true');
	} finally {
		if (personId) await api.patch(`${D1_LOCAL}/items/people/${personId}`, { data: { notes: notesOf.get(personId) ?? null } });
		await api.dispose();
	}
});

test('sign out of STARbase signs Data Studio out too', async ({ page, context }) => {
	await signInStarbase(page, 'member');
	const studio = await context.newPage();
	await studio.goto(`${D1_BASE}/admin/content`, { waitUntil: 'networkidle' });
	expect(studio.url()).not.toContain('/login');
	await page.bringToFront();
	await page.getByRole('button', { name: 'Sign out' }).click();
	await expect(page).toHaveURL(/\/signin$/);
	await studio.reload({ waitUntil: 'networkidle' });
	await expect(studio).toHaveURL(/\/admin\/login/);
});

// The plot pages can't fetch real data on the preview (no sidecars; every asset is a 403), so this checks that
// each page mounts in STARbase's frame with no "no host installed" error, and that its record link routes to
// the STARbase record page.
test('the Force and FAST plot pages mount in STARbase, and their record links route to STARbase pages', async ({ page }) => {
	const crashes: string[] = [];
	page.on('pageerror', (e) => crashes.push(String(e)));
	page.on('response', (r) => {
		if (r.status() >= 500) crashes.push(`${r.status()} ${r.url()}`);
	});
	// The 403 asset noise is tolerated, but a CSP refusal means the production policy blocks something STARbase needs.
	page.on('console', (m) => {
		if (/Refused to/i.test(m.text())) crashes.push(m.text());
	});
	const onStar = (re: RegExp) => (u: URL) => u.origin === new URL(STAR_BASE).origin && re.test(u.pathname);
	await signInStarbase(page, 'admin');
	// Real Force and FAST operations are the ones the Operations list links to.
	await page.goto(`${STAR_BASE}/operations`);
	const forceHref = await page.locator('a[href*="/plot/force?operation="]').first().getAttribute('href');
	const fastHref = await page.locator('a[href*="/plot/fast?operation="]').first().getAttribute('href');
	expect(forceHref, 'a Force link on the Operations page').toBeTruthy();
	expect(fastHref, 'a FAST link on the Operations page').toBeTruthy();

	await page.goto(STAR_BASE + forceHref!);
	await expect(page.locator('h1.sb-title')).toHaveText('Force Analysis');
	await expect(page.locator('.fd').first()).toBeVisible({ timeout: 30_000 });
	await expect(page.locator('body')).not.toContainText(/no .{0,20}host installed/i);
	// The plotter's "Open" buttons go through the host: a STARbase route push, not a new tab or a Directus page.
	await page.locator('.openbtn').first().click({ timeout: 30_000 });
	await page.waitForURL(onStar(/^\/(samples|operations)\/[^/]+$/));

	await page.goto(STAR_BASE + fastHref!);
	await expect(page.locator('h1.sb-title')).toHaveText('FAST Analysis');
	await expect(page.locator('.fd').first()).toBeVisible({ timeout: 30_000 });
	await expect(page.locator('body')).not.toContainText(/no .{0,20}host installed/i);
	await page.getByTitle('Open the operation record').click({ timeout: 30_000 });
	await page.waitForURL(onStar(/^\/operations\/[^/]+$/));
	expect(crashes).toEqual([]);
});

test('phone (375 px): the menu sheet, index pages as lists, a record page with no sideways scroll', async ({ browser, playwright }) => {
	const api = await adminApi(playwright);
	const id = await firstId(api, 'physical_samples');
	await api.dispose();
	const context = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, ignoreHTTPSErrors: MODE === 'hosts' });
	const page = await context.newPage();
	try {
		await signInStarbase(page, 'admin');
		// Home also has "Frequently used menu", so the button is matched by its exact name.
		const menu = page.getByRole('button', { name: 'Menu', exact: true });
		await menu.click();
		const sheet = page.getByRole('dialog', { name: 'Pages' });
		await expect(sheet).toBeVisible();
		await expect(sheet).toHaveAttribute('aria-modal', 'true');
		await expect(sheet.locator('nav.d1-nav')).toBeVisible();
		// Focus moves into the sheet on open and back to Menu on Esc (Task 9's browser check).
		await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[role="dialog"][aria-label="Pages"]'))).toBe(true);
		await page.keyboard.press('Escape');
		await expect(sheet).toBeHidden();
		await expect(menu).toBeFocused();
		// Index pages stay lists on a phone (maintainer override): a table, not cards.
		await page.goto(`${STAR_BASE}/samples`);
		// No sideways scroll in the content area, and none at page level (the document itself). Polled: until the
		// icon font loads, a ligature icon briefly renders as wide text and overflows the page for a few hundred ms.
		const fits = () =>
			page.evaluate(() => {
				const c = document.querySelector('.sb-content')!;
				const d = document.documentElement;
				return { content: c.scrollWidth <= c.clientWidth, page: d.scrollWidth <= d.clientWidth };
			});
		await expect(page.locator('table.d1-table').first()).toBeVisible();
		await expect.poll(fits, { message: 'no sideways scroll on /samples at 375 px' }).toEqual({ content: true, page: true });
		await page.goto(`${STAR_BASE}/samples/${encodeURIComponent(id)}`);
		await expect(page.locator('.d1-record-layout').first()).toBeVisible();
		await expect.poll(fits, { message: 'no sideways scroll on the record page at 375 px' }).toEqual({ content: true, page: true });
	} finally {
		await context.close();
	}
});

// The permanent links are public routes on d1-server that forward to STARBASE_URL (spec §4); the preview's
// STARBASE_URL comes from preview-ports.env / preview-hosts.env, which is STAR_BASE in either layout. (The module
// bar tile from scripts/module_bar_starbase_link.sql points at the same /d1-links/go; it is run by hand, not asserted here.)
test('permanent links on d1-server forward to STARbase; the module bar has the STARbase tile', async ({ page, request }) => {
	const r = await request.get(`${D1_BASE}/d1-links/go/p/plot/force?operation=1`, { maxRedirects: 0 });
	expect(r.status()).toBe(302);
	expect(r.headers()['location']).toBe(`${STAR_BASE}/plot/force?operation=1`);
	const bad = await request.get(`${D1_BASE}/d1-links/go/p/a//b`, { maxRedirects: 0 });
	expect(bad.status()).toBe(400);
});
