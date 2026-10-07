import { test, expect } from '../fixtures';

/**
 * The d1-force-dashboard module: a home-styled force-analysis explorer.
 * Layout: Samples (top-left) + Operations (bottom-left), bidirectionally linked;
 * selected sample info + operation info on the right; three stacked signal charts
 * with a Force/FFT toggle beside the per-axis (Fx/Fy/Fz) FRM fingerprint.
 *
 * Requires at least one processed machining_force_analysis row (status='done').
 * Populate with: scripts/force_orchestrator.py --discover --run.
 */
test('force dashboard: drill sample → operation → charts + FRM, with toggles', async ({ page }, testInfo) => {
	await page.goto('/admin/d1-force-dashboard', { waitUntil: 'domcontentloaded' });

	// Hero renders (compact badge banner). Generous timeout: this is usually the first test
	// to hit Directus after a restart, and cold extension bundling can take >30s.
	await expect(page.locator('.hero .hero-badge')).toHaveText(/Force Analysis/i, { timeout: 90_000 });

	// Samples + Operations panels populated.
	const samples = page.locator('.panel-samples .rowcard');
	const ops = page.locator('.panel-ops .rowcard');
	await expect(samples.first()).toBeVisible({ timeout: 20_000 });
	await expect(ops.first()).toBeVisible();

	const sampleCount = await samples.count();
	const opsBefore = await ops.count();
	expect(sampleCount).toBeGreaterThan(0);
	expect(opsBefore).toBeGreaterThan(0);

	// Selecting a sample marks it active and filters the operations list to exactly that
	// sample's operations. The sample card's pill says how many it has ("3 ops"), so the
	// filtered list must show exactly that many, the Operations chip must agree, and the
	// "all" button that clears the filter must appear. (A bare "<= before" check also passes
	// when nothing was filtered, or when the list was emptied.)
	const pill = (await samples.first().locator('.pill').innerText()).trim();
	const sampleOps = Number.parseInt(pill, 10);
	expect(Number.isNaN(sampleOps), `unexpected op-count pill: "${pill}"`).toBe(false);
	await samples.first().click();
	await expect(samples.first()).toHaveClass(/active/);
	await expect(ops).toHaveCount(sampleOps);
	await expect(page.locator('.panel-ops .panel-head .chip')).toHaveText(String(sampleOps));
	await expect(page.locator('.panel-ops .clearbtn')).toBeVisible();
	expect(sampleOps).toBeLessThanOrEqual(opsBefore);

	// Selecting an operation loads its detail (stat tiles) + charts + FRM.
	await ops.first().click();
	await expect(page.locator('.panel-ops .rowcard.active')).toBeVisible();

	// This test exercises the STATIC view (force-metric stat tiles + FRM image + axis
	// toggle). The connection-speed default or the large-map auto-route can open Lite/Full;
	// the segmented selector's "Figure" is the prerendered PNG we want here.
	const figureBtn = page.locator('.frm-col .segmode .segbtn', { hasText: 'Figure' });
	await expect(figureBtn).toBeVisible({ timeout: 20_000 });
	await figureBtn.click();

	// Operation info tiles.
	await expect(page.locator('.card.info .stat').first()).toBeVisible({ timeout: 20_000 });
	expect(await page.locator('.card.info .stat').count()).toBeGreaterThanOrEqual(6);

	// Three stacked signal charts (Force mode by default) each render an SVG.
	const charts = page.locator('.charts-col .chart svg');
	await expect(charts).toHaveCount(3, { timeout: 20_000 });

	// FRM fingerprint image loads (blob URL, natural size > 0).
	const frm = page.locator('.frm-img img');
	await expect(frm).toBeVisible({ timeout: 20_000 });
	await expect.poll(async () => frm.evaluate((el: HTMLImageElement) => el.naturalWidth), { timeout: 20_000 })
		.toBeGreaterThan(0);
	const fxSrc = await frm.getAttribute('src');

	// Toggle Force → FFT: charts re-render (still three SVGs), FFT button active.
	await page.getByRole('button', { name: 'FFT', exact: true }).click();
	await page.waitForTimeout(400);
	await expect(page.locator('.graphs-head .tbtn', { hasText: 'FFT' })).toHaveClass(/on/);
	await expect(charts).toHaveCount(3);

	// Toggle FRM axis Fz → Fx: image reloads (different blob src).
	await page.locator('.frm-col .toggle .tbtn', { hasText: 'Fx' }).click();
	await expect.poll(async () => frm.getAttribute('src'), { timeout: 20_000 }).not.toBe(fxSrc);
	await expect.poll(async () => frm.evaluate((el: HTMLImageElement) => el.naturalWidth), { timeout: 20_000 })
		.toBeGreaterThan(0);

	await testInfo.attach('force-dashboard', {
		body: await page.screenshot({ fullPage: true }),
		contentType: 'image/png',
	});
});

test('force dashboard: F11 op — switch Figure ⇄ Lite back and forth without TDZ/render errors', async ({ page }) => {
	// Regression for the "Cannot access 'X' before initialization" TDZ errors that hit
	// when transitioning between the static Figure (PNG) and the Lite point cloud (and back).
	// The Full (octree) view needs the same-origin Caddy mount, so it is covered by the
	// host-side verification, not here; this guards the Figure⇄Lite path in-app.
	const OP = '1e380d8b-bb31-5668-9fb9-30ba5058f68f'; // 122-AA-MM-2025-6-5-F11 (has a live cache)

	const errors: string[] = [];
	page.on('pageerror', (e) => errors.push(String(e.stack || e.message)));
	page.on('console', (m) => {
		// Catch TDZ/reference errors at ANY level: Vue's app error handler swallows setup-time
		// ReferenceErrors and re-logs them as WARNINGS, so an `error`-only filter misses a real
		// "Cannot access X before initialization" that half-wires Lite reactivity.
		if (/before initialization|is not defined|Cannot access|ReferenceError/i.test(m.text()))
			errors.push(`[${m.type()}] ${m.text()}`);
	});

	await page.goto(`/admin/d1-force-dashboard?operation=${OP}`, { waitUntil: 'domcontentloaded' });

	const seg = (label: string) => page.locator('.frm-col .segmode .segbtn', { hasText: label });
	const figureBtn = seg('Figure'), liteBtn = seg('Lite');
	await expect(liteBtn).toBeVisible({ timeout: 30_000 });
	test.skip(await liteBtn.isDisabled(), 'op has no live cache in this environment');

	const img = page.locator('.frm-img img');        // static Figure (PNG)
	const cloud = page.locator('.frm-cloud');        // Lite point-cloud renderer (mounts in Lite)
	const cloudError = page.locator('.frm-cloud .error'); // FrmCloud's error overlay (load() catch)

	// Enter Lite once so its cache is in the module LRU — that's what makes the *next* entry
	// take load()'s synchronous precached path, where the "Cannot access 'viewActive' before
	// initialization" TDZ used to fire (caught into the overlay, so assert on the overlay).
	await liteBtn.click();
	await expect(cloud).toHaveCount(1, { timeout: 20_000 });
	await expect(cloudError).toHaveCount(0, { timeout: 20_000 });

	// Known starting point: Figure. Then flip Figure⇄Lite 3×.
	await figureBtn.click();
	await expect(img).toBeVisible({ timeout: 20_000 });

	for (let i = 0; i < 3; i++) {
		await liteBtn.click();  // Figure -> Lite (precached path): render without the TDZ overlay
		await expect(cloud).toHaveCount(1, { timeout: 20_000 });
		await expect(cloudError).toHaveCount(0, { timeout: 20_000 });
		await expect(img).toHaveCount(0);
		await figureBtn.click(); // Lite -> Figure
		await expect(img).toBeVisible({ timeout: 20_000 });
		await expect(cloud).toHaveCount(0);
	}

	expect(errors, `no TDZ/reference errors during mode switching:\n${errors.join('\n')}`).toEqual([]);
});

test('force dashboard: selecting an operation highlights its sample without filtering the operations list', async ({ page }) => {
	await page.goto('/admin/d1-force-dashboard', { waitUntil: 'domcontentloaded' });

	const samples = page.locator('.panel-samples .rowcard');
	const ops = page.locator('.panel-ops .rowcard');
	await expect(ops.first()).toBeVisible({ timeout: 20_000 });

	const opsBefore = await ops.count();
	test.skip(opsBefore < 2, 'need at least 2 unfiltered operations to prove nothing gets hidden');

	// No sample filter active yet: nothing in the samples list is highlighted.
	await expect(page.locator('.panel-samples .rowcard.active')).toHaveCount(0);

	// Click an operation directly (without ever clicking a sample first).
	await ops.first().click();
	await expect(page.locator('.panel-ops .rowcard.active')).toBeVisible();

	// The operations list must be UNCHANGED — selecting an op is not a filter.
	expect(await ops.count()).toBe(opsBefore);

	// Exactly one sample is now highlighted (the selected op's parent sample),
	// but the "show all" clear button must NOT appear — there is no active filter.
	await expect(page.locator('.panel-samples .rowcard.active')).toHaveCount(1);
	await expect(page.locator('.panel-ops .clearbtn')).toHaveCount(0);

	// Explicitly clicking a sample DOES activate filtering (the clear button appears).
	await samples.first().click();
	await expect(page.locator('.panel-ops .clearbtn')).toBeVisible();
});

test('force dashboard: Gridded in Full-res loads the interpolated-grid octree with a fidelity chip', async ({ page }) => {
	// The grid octree fixture is built on the host (MATLAB + PotreeConverter), so this only
	// runs where that build exists — same convention as the other octree host checks.
	test.skip(!process.env.FORCE_HOST_TESTS, 'needs a host-built grid octree (FORCE_HOST_TESTS)');
	const OP = '9fa1f0e9-373c-5de6-af48-57f1b4df87bb'; // has octree_status='done' + grid_octree_status='done'

	const errors: string[] = [];
	page.on('pageerror', (e) => errors.push(String(e.stack || e.message)));

	await page.goto(`/admin/d1-force-dashboard?operation=${OP}`, { waitUntil: 'domcontentloaded' });

	// Enter Full (octree) via the segmented selector. Available once the raw octree is built.
	const fullBtn = page.locator('.frm-col .segmode .segbtn', { hasText: 'Full' });
	await expect(fullBtn).toBeVisible({ timeout: 30_000 });
	await fullBtn.click();
	await expect(page.locator('.frm-octree')).toHaveCount(1, { timeout: 20_000 });

	// Turn on the Gridded sub-toggle (header, Full-only) -> the FRM swaps to the grid octree.
	await page.locator('.frm-col .toggle .tbtn', { hasText: 'Gridded' }).click();

	// The fidelity chip renders (gridActive is data-driven, so this does not depend on WebGL).
	const fid = page.locator('.frm-fid');
	await expect(fid).toBeVisible({ timeout: 20_000 });
	await expect(fid).toHaveText(/fidelity ~\d+%|fidelity n\/a/);

	// No octree load/error overlay after the swap.
	await expect(page.locator('.frm-octree .error')).toHaveCount(0);
	expect(errors, `no page errors during Gridded swap:\n${errors.join('\n')}`).toEqual([]);
});

test('force crawler: grid density setting round-trips', async ({ page }) => {
	await page.goto('/admin/d1-force-crawler', { waitUntil: 'domcontentloaded' });

	const dens = page.locator('label:has-text("Grid density") input');
	await expect(dens).toBeVisible({ timeout: 30_000 });
	const original = await dens.inputValue();

	await dens.fill('3072');
	await page.locator('.savebtn').click();
	await page.waitForTimeout(600);
	await page.reload({ waitUntil: 'domcontentloaded' });
	await expect(dens).toHaveValue('3072', { timeout: 20_000 });

	// restore the original so the test leaves no side effect
	await dens.fill(original || '2048');
	await page.locator('.savebtn').click();
	await page.waitForTimeout(600);
});
