import { test, expect } from '@playwright/test';
import { D1_BASE, STAR_BASE, adminApi, firstId, signInStarbase } from '../starbase/target';

// STARbase polish follow-ups (plan 2 final review), in a real browser against the d1-starbase preview:
// the phone menu's backdrop, dialog Esc and focus return, and a failed plot download. Layout: ports
// (default), same setup as spec 14 (tests/ui/README.md). Run: npx playwright test specs/15-starbase-polish.spec.ts
test.use({ trace: 'off' });

test('phone menu: a drag from the sheet that ends on the backdrop keeps it open; a tap on the backdrop closes it', async ({ browser }) => {
	const context = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
	const page = await context.newPage();
	try {
		await signInStarbase(page, 'admin');
		const sheet = page.getByRole('dialog', { name: 'Pages' });
		const open = async () => {
			await page.getByRole('button', { name: 'Menu', exact: true }).click();
			await expect(sheet).toBeVisible();
		};
		await open();
		const box = (await sheet.boundingBox())!;
		expect(box.width, 'the sheet leaves a backdrop strip at 375 px').toBeLessThan(360);
		const inside = { x: box.x + box.width / 2, y: 500 };
		const backdrop = { x: box.x + box.width + 20, y: 500 };
		// Press inside the sheet, release on the backdrop: the click lands on the backdrop, but the press did not start there.
		await page.mouse.move(inside.x, inside.y);
		await page.mouse.down();
		await page.mouse.move(backdrop.x, backdrop.y, { steps: 6 });
		await page.mouse.up();
		await expect(sheet).toBeVisible();
		// A real tap on the backdrop closes it.
		await page.touchscreen.tap(backdrop.x, backdrop.y);
		await expect(sheet).toBeHidden();
		// And again with the mouse (press and release both on the backdrop).
		await open();
		await page.mouse.click(backdrop.x, backdrop.y);
		await expect(sheet).toBeHidden();
	} finally {
		await context.close();
	}
});

test('a dialog on the People page: Esc closes it and focus returns to the Add person button', async ({ page }) => {
	await signInStarbase(page, 'admin');
	await page.goto(`${STAR_BASE}/people`);
	const add = page.getByRole('button', { name: /add person/i }).first();
	await add.focus();
	await add.click();
	const dialog = page.getByRole('dialog', { name: /add a person/i }).or(page.locator('.v-dialog[role="dialog"]'));
	await expect(dialog.first()).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(dialog.first()).toBeHidden();
	await expect(add).toBeFocused();
	// Closing it with the backdrop returns focus the same way.
	await add.click();
	await expect(dialog.first()).toBeVisible();
	await page.mouse.click(5, 5);
	await expect(dialog.first()).toBeHidden();
	await expect(add).toBeFocused();
});

test('a failed asset download leaves the plot page where it is, and says so under the FRM image', async ({ page }) => {
	await signInStarbase(page, 'admin');
	await page.goto(`${STAR_BASE}/operations`);
	const href = await page.locator('a[href*="/plot/force?operation="]').first().getAttribute('href');
	test.skip(!href, 'no Force operation in the preview');
	// The preview's operations have no stored FRM figure, so give the opened one a (fake) file id; every
	// d1-server asset request is then answered 404, as for a deleted file.
	await page.route(`${D1_BASE}/items/machining_force_analysis/*`, async (r) => {
		const res = await r.fetch();
		const body = await res.json();
		body.data = { ...body.data, frm_fx: 'gone-file', frm_fy: 'gone-file', frm_fz: 'gone-file', octree_status: null, live_cache_file: null };
		await r.fulfill({ response: res, json: body });
	});
	let hit = false;
	await page.route(`${D1_BASE}/assets/**`, (r) => {
		hit = true;
		return r.fulfill({ status: 404, contentType: 'application/json', headers: { 'access-control-allow-origin': STAR_BASE, 'access-control-allow-credentials': 'true' }, body: '{"errors":[{"message":"gone"}]}' });
	});
	await page.goto(STAR_BASE + href!);
	await expect(page.locator('.fd').first()).toBeVisible({ timeout: 30_000 });
	const dl = page.getByTitle('Download this FRM image');
	await expect(dl).toBeVisible({ timeout: 30_000 });
	// A marker on window survives anything but a real navigation or reload of the tab.
	await page.evaluate(() => ((window as unknown as { __stay: number }).__stay = 1));
	hit = false;
	await dl.click();
	await expect.poll(() => hit).toBe(true);
	await expect(page.getByText('That file is no longer available.')).toBeVisible();
	expect(await page.evaluate(() => (window as unknown as { __stay?: number }).__stay), 'the tab did not navigate').toBe(1);
	expect(new URL(page.url()).pathname).toBe('/plot/force');
	await expect(page.locator('.fd').first()).toBeVisible();
});

test('a download that works saves the file from memory under the server name, without leaving the page', async ({ page }) => {
	await signInStarbase(page, 'admin');
	await page.goto(`${STAR_BASE}/operations`);
	const href = await page.locator('a[href*="/plot/force?operation="]').first().getAttribute('href');
	test.skip(!href, 'no Force operation in the preview');
	await page.route(`${D1_BASE}/items/machining_force_analysis/*`, async (r) => {
		const res = await r.fetch();
		const body = await res.json();
		body.data = { ...body.data, frm_fx: 'good-file', frm_fy: 'good-file', frm_fz: 'good-file', octree_status: null, live_cache_file: null };
		await r.fulfill({ response: res, json: body });
	});
	const cors = { 'access-control-allow-origin': STAR_BASE, 'access-control-allow-credentials': 'true', 'access-control-expose-headers': 'Content-Disposition' };
	await page.route(`${D1_BASE}/assets/**`, (r) =>
		r.fulfill({ status: 200, contentType: 'image/png', headers: { ...cors, 'content-disposition': 'attachment; filename="FRM op7 Fx.png"' }, body: Buffer.from('not really a png') }),
	);
	await page.goto(STAR_BASE + href!);
	const dl = page.getByTitle('Download this FRM image');
	await expect(dl).toBeVisible({ timeout: 30_000 });
	await page.evaluate(() => ((window as unknown as { __stay: number }).__stay = 1));
	const [download] = await Promise.all([page.waitForEvent('download'), dl.click()]);
	expect(download.suggestedFilename()).toBe('FRM op7 Fx.png');
	expect(await page.evaluate(() => (window as unknown as { __stay?: number }).__stay)).toBe(1);
});

test('the edit dialog: closing it puts focus back on the Edit button', async ({ page, playwright }) => {
	const api = await adminApi(playwright);
	const id = await firstId(api, 'physical_samples');
	await api.dispose();
	await signInStarbase(page, 'admin');
	await page.goto(`${STAR_BASE}/samples/${encodeURIComponent(id)}`);
	const edit = page.getByRole('button', { name: /^Edit$/ });
	await edit.focus();
	await edit.click();
	const dialog = page.getByRole('dialog', { name: 'Edit record' });
	await expect(dialog).toBeVisible();
	await page.getByRole('button', { name: 'Close the form' }).click();
	// Once the form has shown, closing asks first; before that it just closes.
	const sure = page.getByRole('button', { name: 'Close', exact: true });
	if (await sure.isVisible()) await sure.click();
	await expect(dialog).toBeHidden();
	await expect(edit).toBeFocused();
});
