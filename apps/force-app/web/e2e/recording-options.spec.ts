import { test, expect, type Page } from '@playwright/test';

// Exercises the Recording & Metadata panel restructure end to end against the REAL app: a real
// Directus login (the dev .env's local stack), no route stubbing. See playwright.config.ts for
// why the dev server must be on :5180 specifically.
const DIRECTUS_URL = 'http://localhost';
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'change_me_admin';

test.beforeEach(async ({ page, request }) => {
	// A real login (not the fake-token localStorage trick) — a fake token gets a real 401 back
	// from the real Directus behind this dev server and the app's own interceptor clears the
	// session, bouncing to /login. Fetched via the `request` fixture (Node-side, not the page's
	// own XHR) specifically to sidestep CORS on this call; the page's OWN subsequent API calls
	// still go through normal browser CORS, which is why this must run against :5180.
	const res = await request.post(`${DIRECTUS_URL}/auth/login`, { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, mode: 'json' } });
	expect(res.ok(), `Directus login failed (${res.status()}) — is the local stack running on :80?`).toBeTruthy();
	const body = await res.json();
	const auth = {
		accessToken: body.data.access_token,
		refreshToken: body.data.refresh_token,
		expiresAt: Date.now() + (Number(body.data.expires) || 0),
		user: null,
	};
	// localStorage is origin-scoped — land on the app's origin before writing it.
	await page.goto('/login');
	await page.evaluate((a) => localStorage.setItem('force-app.auth', JSON.stringify(a)), auth);
	await page.goto('/record');
	// The Recording & Metadata panel's own root — proves the app got past the login guard.
	await expect(page.locator('.opts')).toBeVisible();
});

async function toolingCard(page: Page) {
	return page.locator('.card', { has: page.locator('.card-head', { hasText: 'Tooling' }) });
}
async function machineCard(page: Page) {
	return page.locator('.card', { has: page.locator('.card-head', { hasText: 'Machine' }) });
}
async function postCutCard(page: Page) {
	return page.locator('.card', { has: page.locator('.card-head', { hasText: 'Post-cut' }) });
}

test('Machine, Operator, and Operation type share one subpanel', async ({ page }) => {
	const card = await machineCard(page);
	const body = card.locator('.card-body');
	if (!(await body.isVisible())) await card.locator('.card-head').click();
	const panel = card.locator('.machine-op');
	await expect(panel.getByText('Machine', { exact: true })).toBeVisible();
	await expect(panel.getByText('Operator', { exact: true })).toBeVisible();
	// Not getByText(exact) here: the <label> wraps a <select>, whose full text content is the
	// label plus every <option>'s text, so an exact-match on "Operation type" alone never matches.
	await expect(panel.locator('.op-type')).toContainText('Operation type');
	await expect(panel.locator('.op-type select')).toBeVisible();
});

test('Duration field is gone from the stat grid', async ({ page }) => {
	const grid = page.locator('.stat-grid').first();
	await expect(grid).toBeVisible();
	await expect(grid.getByText('Duration', { exact: true })).toHaveCount(0);
	await expect(grid.getByText('Planned duration', { exact: true })).toHaveCount(0);
});

test('Diameter starts as one tile and splits/merges on double-click, same footprint', async ({ page }) => {
	const grid = page.locator('.stat-grid').first();
	const diamTile = grid.locator('.stat-tile', { has: page.locator('.label', { hasText: 'Diameter' }) });
	await expect(diamTile).toBeVisible();
	await expect(grid.locator('.label', { hasText: 'Outer' })).toHaveCount(0);
	await expect(grid.locator('.label', { hasText: 'Inner' })).toHaveCount(0);

	await diamTile.dblclick();

	const outerTile = grid.locator('.stat-tile', { has: page.locator('.label', { hasText: 'Outer Ø' }) });
	const innerTile = grid.locator('.stat-tile', { has: page.locator('.label', { hasText: 'Inner Ø' }) });
	await expect(outerTile).toBeVisible();
	await expect(innerTile).toBeVisible();
	await expect(grid.locator('.label', { hasText: 'Diameter', exact: true })).toHaveCount(0);
	// Split view lands in the same footprint the single tile had — same row, side by side, not a
	// new taller block appended elsewhere. (Comparing to the pre-split box would be scroll-frame-
	// fragile — Playwright auto-scrolls the target before dblclick — so this checks the split
	// tiles against EACH OTHER instead of against a coordinate captured before the action.)
	const outerBox = await outerTile.boundingBox();
	const innerBox = await innerTile.boundingBox();
	expect(outerBox && innerBox).toBeTruthy();
	if (outerBox && innerBox) {
		expect(Math.round(outerBox.y)).toBe(Math.round(innerBox.y));
		expect(outerBox.x).toBeLessThan(innerBox.x);
	}

	// Merge back.
	await outerTile.dblclick();
	await expect(diamTile).toBeVisible();
	await expect(grid.locator('.label', { hasText: 'Outer' })).toHaveCount(0);
	await expect(grid.locator('.label', { hasText: 'Inner' })).toHaveCount(0);
});

test('card order: Machine before Tooling before Post-cut, no Acquisition card', async ({ page }) => {
	const heads = page.locator('.opts .card-head');
	await expect(heads).toHaveCount(3);
	await expect(heads.nth(0)).toContainText('Machine');
	await expect(heads.nth(1)).toContainText('Tooling');
	await expect(heads.nth(2)).toContainText('Post-cut');
	await expect(page.getByText('Acquisition', { exact: true })).toHaveCount(0);
});

test('Machine card folds, and shows what is set while folded', async ({ page }) => {
	const card = await machineCard(page);
	const head = card.locator('.card-head');
	const body = card.locator('.card-body');
	if (!(await body.isVisible())) await head.click();
	await card.locator('.op-type select').selectOption('MT-F');
	await head.click();
	await expect(body).toBeHidden();
	await expect(head.locator('.card-summary')).toContainText('MT-F');
	await head.click();
	await expect(body).toBeVisible();
});

test('Tooling card expands and collapses', async ({ page }) => {
	const card = await toolingCard(page);
	const head = card.locator('.card-head');
	const body = card.locator('.card-body');
	if (!(await body.isVisible())) await head.click();
	await expect(body).toBeVisible();
	await expect(card.getByText('Insert', { exact: true })).toBeVisible();
	await expect(card.getByText('Tool', { exact: true })).toBeVisible();
	await head.click();
	await expect(body).toBeHidden();
});

test('Post-cut card actually expands to its fields (not empty)', async ({ page }) => {
	const card = await postCutCard(page);
	const head = card.locator('.card-head');
	const body = card.locator('.card-body');
	if (!(await body.isVisible())) await head.click();
	await expect(body).toBeVisible();
	await expect(card.getByText('Chips ref code', { exact: true })).toBeVisible();
	await expect(card.getByText('Chips collected', { exact: true })).toBeVisible();
	await head.click();
	await expect(body).toBeHidden();
});

test('Acquisition toggles live in the footer, left of Start (above it when the column is narrow)', async ({ page }) => {
	const segproc = page.locator('.segproc');
	await expect(segproc).toBeVisible();
	await expect(segproc.getByText('Cut start')).toBeVisible();
	await expect(segproc.getByText('Drift')).toBeVisible();
	await expect(segproc.getByText('Converge')).toBeVisible();
	const startBtn = page.locator('.btn.start');
	await expect(startBtn).toBeVisible();
	const labelsClipped = () => segproc.locator('button').evaluateAll((bs) => bs.some((b) => b.scrollWidth > b.clientWidth + 1));

	// Wide window: one row, the toggles to the left of Start.
	await page.setViewportSize({ width: 1920, height: 1080 });
	await expect.poll(async () => {
		const [seg, start] = [await segproc.boundingBox(), await startBtn.boundingBox()];
		return !!seg && !!start && seg.x + seg.width <= start.x && seg.y < start.y + start.height && start.y < seg.y + seg.height;
	}).toBe(true);
	expect(await labelsClipped()).toBe(false);

	// Narrow column: Start wraps onto its own row below rather than squeezing the labels until they clip.
	await page.setViewportSize({ width: 1366, height: 768 });
	await expect.poll(async () => {
		const [seg, start] = [await segproc.boundingBox(), await startBtn.boundingBox()];
		return !!seg && !!start && seg.y + seg.height <= start.y;
	}).toBe(true);
	expect(await labelsClipped()).toBe(false);

	// Toggle one and confirm it's a real, working control.
	const cutStartBtn = segproc.getByRole('button', { name: /Cut start/ });
	const wasOn = (await cutStartBtn.getAttribute('class'))?.includes('on') ?? false;
	await cutStartBtn.click();
	const nowOn = (await cutStartBtn.getAttribute('class'))?.includes('on') ?? false;
	expect(nowOn).toBe(!wasOn);
});
