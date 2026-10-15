import { test, expect, type Locator, type Page } from '@playwright/test';
import { STAR_BASE, watchErrors } from '../starbase/target';
import { STUB_TOOLING as T } from '../starbase/stubScans';
import { stubD1, type StubState } from '../starbase/stubD1';
// The app's own framing numbers, read to know where the camera starts (pure TypeScript, no WebGL).
import { parseMeta } from '../../../packages/starbase-pages/src/pages/surface/viewer/gridData';
import { defaultExaggeration, frameCamera, heightRange, scanLayout } from '../../../packages/starbase-pages/src/pages/surface/viewer/scanLayout';
import { SCAN_H, SCAN_W } from '../starbase/syntheticScan';

// Surface scans on inserts and edges (docs/superpowers/specs/2026-10-15-surface-scans-design.md), in a real browser:
// the Surface scans panel with its thumbnails, the 3D viewer drawn on the GPU from a made-up height grid (a software
// WebGL in headless Chromium), the exaggeration slider and colour-by-height changing the picture, an edge page that also
// lists its insert's scans, Render again on a failed render and on a done one whose files are gone (404 OBJECT_MISSING), the
// surface's orientation (the file's hole lands where the file puts it: not flipped, not mirrored), arrow keys and plus / minus, the Add a surface scan dialog with its lab-wide warning, and
// the page without WebGL. d1-server is the stand-in of tests/ui/starbase (stubD1.ts + stubScans.ts + syntheticScan.ts), so
// this needs only STARbase from `vite preview`, no Directus and no real scan.
// Run: npm run build -w starbase-web && STARBASE_D1_ORIGIN=http://127.0.0.1:18057 npm run preview -w starbase-web, then
//      cd tests/ui && npx playwright test specs/22-surface-scan.spec.ts
// Screenshots go to the test's output folder (test-results/), and are attached to the report.
test.use({ trace: 'off', launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] } });

async function start(browser: import('@playwright/test').Browser, path: string, opts: { noWebgl?: boolean } = {}): Promise<{ page: Page; state: StubState; errors: string[] }> {
	const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
	const page = await context.newPage();
	const errors = watchErrors(page);
	const state = await stubD1(context);
	if (opts.noWebgl) {
		await page.addInitScript(() => {
			const original = HTMLCanvasElement.prototype.getContext;
			HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
				if (/webgl/i.test(type)) return null;
				return (original as any).call(this, type, ...rest);
			} as typeof original;
		});
	}
	await page.goto(STAR_BASE + path);
	await expect(page.getByRole('heading', { name: 'Surface scans' })).toBeVisible({ timeout: 30_000 });
	return { page, state, errors };
}

// A height as the legend prints it (scanLayout.ts formatMicrometres).
function um(v: number): string {
	const a = Math.abs(v);
	return `${(a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2)).replace('-', '\u2212')} µm`;
}

const panel = (page: Page) => page.locator('#scans');
const row = (page: Page, text: string | RegExp) => panel(page).locator('.scan').filter({ hasText: text });

// How different two pictures are: the mean difference of their signatures, 0 (the same) to 255.
const apart = (a: number[], b: number[]) => a.reduce((n, v, i) => n + Math.abs(v - b[i]), 0) / a.length;

// What the canvas shows, read back from a screenshot of it: pixels that differ from the stage's own background, the
// number of distinct colours (quantised), and how many are strongly coloured (a grey surface has none).
async function look(canvas: Locator) {
	const png = (await canvas.screenshot()).toString('base64');
	return canvas.page().evaluate(async (b64) => {
		const img = new Image();
		img.src = `data:image/png;base64,${b64}`;
		await img.decode();
		const c = document.createElement('canvas');
		c.width = img.width;
		c.height = img.height;
		const ctx = c.getContext('2d')!;
		ctx.drawImage(img, 0, 0);
		const d = ctx.getImageData(0, 0, c.width, c.height).data;
		const bg = [d[0], d[1], d[2]];
		const seen = new Set<number>();
		let ink = 0;
		let colourful = 0;
		const cells = 8;
		const sig = new Array(cells * cells).fill(0); // mean brightness per cell of an 8 x 8 grid: a picture's signature
		for (let i = 0; i < d.length; i += 4) {
			const dr = Math.abs(d[i] - bg[0]);
			const dg = Math.abs(d[i + 1] - bg[1]);
			const db = Math.abs(d[i + 2] - bg[2]);
			if (dr + dg + db > 24) {
				ink++;
				seen.add(((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4));
				if (Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]) > 60) colourful++;
			}
			const px = i / 4;
			const cx = Math.min(cells - 1, Math.floor(((px % c.width) / c.width) * cells));
			const cy = Math.min(cells - 1, Math.floor((Math.floor(px / c.width) / c.height) * cells));
			sig[cy * cells + cx] += (d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11) / ((c.width / cells) * (c.height / cells));
		}
		return { ink, colours: seen.size, colourful, sig, area: c.width * c.height };
	}, png);
}

// The synthetic scan's hole (a disc at x = 120, y = 40 of the 192 x 128 grid, y counted from the TOP row), found in a
// screenshot of the canvas: background-coloured pixels that the background outside the surface cannot reach. The legend's
// box is left out. Returns the hole's centre in canvas pixels, or null.
async function findHole(canvas: Locator, legend: Locator): Promise<{ x: number; y: number; size: number } | null> {
	const cb = (await canvas.boundingBox())!;
	const lb = (await legend.boundingBox())!;
	const skip = { x: lb.x - cb.x - 2, y: lb.y - cb.y - 2, w: lb.width + 4, h: lb.height + 4 };
	const png = (await canvas.screenshot()).toString('base64');
	return canvas.page().evaluate(async ({ b64, skip }) => {
		const img = new Image();
		img.src = `data:image/png;base64,${b64}`;
		await img.decode();
		const c = document.createElement('canvas');
		c.width = img.width;
		c.height = img.height;
		const ctx = c.getContext('2d')!;
		ctx.drawImage(img, 0, 0);
		const d = ctx.getImageData(0, 0, c.width, c.height).data;
		const W = c.width;
		const H = c.height;
		const o = (20 * W + 20) * 4; // inside the stage's rounded border (its corner pixel is the border, not the background)
		const bg = [d[o], d[o + 1], d[o + 2]];
		const isBg = (i: number) => Math.abs(d[i * 4] - bg[0]) + Math.abs(d[i * 4 + 1] - bg[1]) + Math.abs(d[i * 4 + 2] - bg[2]) <= 24;
		const inSkip = (x: number, y: number) => x >= skip.x && x <= skip.x + skip.w && y >= skip.y && y <= skip.y + skip.h;
		const outside = new Uint8Array(W * H);
		const stack: number[] = [];
		const push = (x: number, y: number) => {
			const i = y * W + x;
			if (x < 0 || y < 0 || x >= W || y >= H || outside[i] || !(isBg(i) || inSkip(x, y))) return;
			outside[i] = 1;
			stack.push(i);
		};
		const RIM = 5; // the stage's border and rounded corners: start the sweep from a frame just inside it
		for (let x = 0; x < W; x++) { for (let k = RIM; k < RIM + 2; k++) { push(x, k); push(x, H - 1 - k); } }
		for (let y = 0; y < H; y++) { for (let k = RIM; k < RIM + 2; k++) { push(k, y); push(W - 1 - k, y); } }
		while (stack.length) {
			const i = stack.pop()!;
			const x = i % W;
			const y = (i - x) / W;
			push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
		}
		let n = 0;
		let sx = 0;
		let sy = 0;
		for (let y = 0; y < H; y++) {
			for (let x = 0; x < W; x++) {
				const i = y * W + x;
				if (!outside[i] && isBg(i) && !inSkip(x, y)) { n++; sx += x; sy += y; }
			}
		}
		return n >= 40 ? { x: sx / n, y: sy / n, size: n } : null;
	}, { b64: png, skip });
}

// Where a scene point lands on the canvas from the opening camera (azimuth 28 deg, polar 52 deg, FOV 35 deg), in pixels.
function project(point: [number, number, number], cam: { distance: number; polarDeg: number; azimuthDeg: number }, w: number, h: number, fovDeg = 35): [number, number] {
	const phi = (cam.polarDeg * Math.PI) / 180;
	const theta = (cam.azimuthDeg * Math.PI) / 180;
	const eye = [cam.distance * Math.sin(phi) * Math.sin(theta), cam.distance * Math.cos(phi), cam.distance * Math.sin(phi) * Math.cos(theta)];
	const f = eye.map((v) => -v / cam.distance); // looking at the origin
	const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
	const norm = (a: number[]) => a.map((v) => v / Math.hypot(a[0], a[1], a[2]));
	const right = norm(cross(f, [0, 1, 0]));
	const up = cross(right, f);
	const v = point.map((p, i) => p - eye[i]);
	const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
	const t = Math.tan((fovDeg * Math.PI) / 360);
	const ndcX = dot(v, right) / (dot(v, f) * t * (w / h));
	const ndcY = dot(v, up) / (dot(v, f) * t);
	return [((ndcX + 1) / 2) * w, ((1 - ndcY) / 2) * h];
}

async function openViewer(page: Page, rowText: string | RegExp) {
	await row(page, rowText).getByRole('button', { name: /Open .* in 3D/ }).click();
	const viewer = page.getByTestId('surface-scan-viewer');
	await expect(viewer).toHaveAttribute('data-phase', 'ready', { timeout: 30_000 });
	const canvas = viewer.locator('canvas');
	await expect(canvas).toBeVisible();
	await expect(viewer.getByText('Preparing the 3D view')).toHaveCount(0, { timeout: 30_000 });
	return { viewer, canvas };
}

test('an insert page lists its scan with a thumbnail, and the viewer draws the surface on the GPU', async ({ browser }, testInfo) => {
	const { page, state, errors } = await start(browser, `/inserts/${T.insertId}`);
	await expect(panel(page).locator('.scan')).toHaveCount(1);
	const r = row(page, 'CNMG12-1-new.al3d');
	await expect(r).toContainText('New');
	await expect(r).toContainText('12 Jun 2026');
	await expect(r).toContainText('Ready');
	await expect(r.locator('.thumb img')).toBeVisible();
	await expect.poll(() => r.locator('.thumb img').evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0); // a real PNG came through the blob URL
	expect(state.scans.endpoint).toContain('GET /d1-surface-scan/scan-insert-new/thumb');
	await expect(r.getByRole('button', { name: 'Render again' })).toBeVisible(); // a finished render can be rendered again too (its files may be gone)

	const { viewer, canvas } = await openViewer(page, 'CNMG12-1-new.al3d');
	expect(state.scans.endpoint).toEqual(expect.arrayContaining(['GET /d1-surface-scan/scan-insert-new/meta', 'GET /d1-surface-scan/scan-insert-new/grid']));

	// The surface is on screen: lit, coloured by height, with its legend.
	await expect.poll(async () => (await look(canvas)).ink, { timeout: 20_000 }).toBeGreaterThan(8000);
	const coloured = await look(canvas);
	expect(coloured.colours).toBeGreaterThan(40);
	expect(coloured.colourful).toBeGreaterThan(5000);
	const legend = page.getByTestId('surface-scan-legend');
	await expect(legend).toContainText('µm');
	await expect(legend).toContainText(um(state.scans.scan.zMax)); // the highest and the lowest point, in micrometres, with a true minus
	await expect(legend).toContainText(um(state.scans.scan.zMin));
	await expect(viewer).toContainText('192 × 128 cells');
	await expect(viewer).toContainText('4 µm'); // the pixel pitch
	await expect(viewer).toContainText('No data'); // the hole and the dead strip are named, not hidden
	await canvas.screenshot({ path: testInfo.outputPath('surface-scan-colour.png') });
	await testInfo.attach('surface-scan-colour', { path: testInfo.outputPath('surface-scan-colour.png'), contentType: 'image/png' });

	// The exaggeration slider is a uniform: moving it redraws a different surface, and back again restores it.
	const slider = viewer.getByRole('slider', { name: 'Vertical exaggeration' });
	const startValue = await slider.inputValue();
	await slider.fill('900');
	await expect(viewer.locator('.num')).toContainText('×');
	await expect.poll(async () => apart((await look(canvas)).sig, coloured.sig), { timeout: 10_000 }).toBeGreaterThan(2);
	const tall = await look(canvas);
	await canvas.screenshot({ path: testInfo.outputPath('surface-scan-exaggerated.png') });
	await slider.fill(startValue);
	await expect.poll(async () => apart((await look(canvas)).sig, coloured.sig), { timeout: 10_000 }).toBeLessThan(1.5);
	expect(apart(tall.sig, coloured.sig)).toBeGreaterThan(2);

	// Colour by height off: a plain grey surface (no strongly coloured pixel left, the surface still drawn).
	await viewer.getByLabel('Colour by height').uncheck();
	await expect.poll(async () => (await look(canvas)).colourful, { timeout: 10_000 }).toBeLessThan(coloured.colourful / 20);
	expect((await look(canvas)).ink).toBeGreaterThan(8000);
	await canvas.screenshot({ path: testInfo.outputPath('surface-scan-grey.png') });
	await viewer.getByLabel('Colour by height').check();

	// Orbit and zoom only: a drag turns the surface, a wheel zooms, and nothing else (no pan) changes the picture's centre.
	const before = await look(canvas);
	const box = (await canvas.boundingBox())!;
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 30, { steps: 8 });
	await page.mouse.up();
	await expect.poll(async () => apart((await look(canvas)).sig, before.sig), { timeout: 10_000 }).toBeGreaterThan(2);
	const turned = await look(canvas);
	await page.mouse.wheel(0, -400);
	await expect.poll(async () => apart((await look(canvas)).sig, turned.sig), { timeout: 10_000 }).toBeGreaterThan(2);
	await viewer.getByRole('button', { name: 'Reset view' }).click();
	await expect.poll(async () => apart((await look(canvas)).sig, coloured.sig), { timeout: 10_000 }).toBeLessThan(1.5);

	// Not flipped, not mirrored: the file's hole (x = 120, y = 40 from the top row of 192 x 128) lands where the file says it is.
	// The scene is x to the right, the top row of the file far away, so the hole is right of centre and in the far half.
	const meta = parseMeta(state.scans.scan.meta);
	const layout = scanLayout(meta);
	const range = heightRange(meta, { min: state.scans.scan.zMin, max: state.scans.scan.zMax, valid: 1, missing: 0 });
	const size = (await canvas.boundingBox())!;
	const cam = frameCamera(layout, range, defaultExaggeration(layout, range), size.width / size.height);
	const at = (col: number, rowFromTop: number): [number, number] =>
		project([(col / (SCAN_W - 1) - 0.5) * layout.sizeX, 0, (rowFromTop / (SCAN_H - 1) - 0.5) * layout.sizeZ], cam, size.width, size.height);
	const hole = await findHole(canvas, legend);
	expect(hole, 'the hole in the surface is on screen').not.toBeNull();
	const [ex, ey] = at(120, 40);
	const dist = (p: [number, number]) => Math.hypot(hole!.x - p[0], hole!.y - p[1]);
	expect(dist([ex, ey])).toBeLessThan(0.08 * size.width); // where the file puts it (the heights are ignored, hence the room)
	for (const [mirrored, name] of [[at(SCAN_W - 1 - 120, 40), 'mirrored left to right'], [at(120, SCAN_H - 1 - 40), 'flipped top to bottom'], [at(SCAN_W - 1 - 120, SCAN_H - 1 - 40), 'turned half way round']] as const) {
		expect(dist(mirrored), `not ${name}`).toBeGreaterThan(dist([ex, ey]) + 0.05 * size.width);
	}

	// The keyboard turns and zooms it too (OrbitControls' own keys only pan): focus the canvas, press keys, the picture changes.
	await canvas.focus();
	const keyed = await look(canvas);
	for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
	await expect.poll(async () => apart((await look(canvas)).sig, keyed.sig), { timeout: 10_000 }).toBeGreaterThan(2);
	const turnedByKey = await look(canvas);
	for (let i = 0; i < 3; i++) await page.keyboard.press('+');
	await expect.poll(async () => apart((await look(canvas)).sig, turnedByKey.sig), { timeout: 10_000 }).toBeGreaterThan(2);
	await viewer.getByRole('button', { name: 'Reset view' }).click();
	await expect.poll(async () => apart((await look(canvas)).sig, coloured.sig), { timeout: 10_000 }).toBeLessThan(1.5);

	await page.screenshot({ path: testInfo.outputPath('insert-page-viewer.png'), fullPage: false });
	await testInfo.attach('insert-page-viewer', { path: testInfo.outputPath('insert-page-viewer.png'), contentType: 'image/png' });

	await panel(page).getByRole('button', { name: 'Close' }).click();
	await expect(page.getByTestId('surface-scan-viewer')).toHaveCount(0);
	expect(errors).toEqual([]);
	await page.context().close();
});

test("an edge page lists its own scans and its insert's, and Render again moves a failed scan to Ready", async ({ browser }) => {
	const { page, state, errors } = await start(browser, `/edges/${T.edgeId}`);
	await expect(panel(page).locator('.scan')).toHaveCount(3);
	await expect(row(page, 'CNMG12-1-new.al3d').locator('.tag')).toHaveText('Insert');
	await expect(row(page, 'CNMG12-1-A-worn.al3d').locator('.tag')).toHaveCount(0);
	await expect(row(page, 'CNMG12-1-A-worn.al3d')).toContainText('OP-TURN-7');
	await expect(row(page, 'CNMG12-1-A-worn.al3d')).toContainText('Flank wear land');

	const failed = row(page, 'CNMG12-1-A-cleaned.al3d');
	await expect(failed).toContainText('Render failed');
	await expect(failed).toContainText('could not read this file');
	await expect(failed.getByRole('button', { name: /Open .* in 3D/ })).toHaveCount(0);
	await expect(failed.getByRole('button', { name: 'Render again' })).toBeVisible();
	await expect(row(page, 'CNMG12-1-A-worn.al3d').getByRole('button', { name: /Open .* in 3D/ })).toBeVisible();
	await failed.getByRole('button', { name: 'Render again' }).click();
	await expect.poll(() => state.scans.renders).toEqual(['scan-edge-bad']);
	await expect(failed).toContainText(/Waiting to render|Rendering/);
	await expect(failed).toContainText('Ready', { timeout: 25_000 }); // the panel polls while a render is queued
	await expect(failed.locator('.thumb img')).toBeVisible();
	await expect(failed.getByRole('button', { name: /Open .* in 3D/ })).toBeVisible();
	expect(errors).toEqual([]);
	await page.context().close();
});

test('a done scan whose rendered files are gone says so in the viewer, and Render again brings it back', async ({ browser }) => {
	const { page, state, errors } = await start(browser, `/edges/${T.edgeId}`);
	state.scans.objectMissing = ['scan-edge-worn']; // the object store lost it after the panel loaded
	const worn = row(page, 'CNMG12-1-A-worn.al3d');
	await worn.getByRole('button', { name: /Open .* in 3D/ }).click();
	const viewer = page.getByTestId('surface-scan-viewer');
	await expect(viewer).toHaveAttribute('data-phase', 'error');
	await expect(viewer).toContainText('The rendered data is missing; render the scan again.');
	await viewer.getByRole('button', { name: 'Render again' }).click();
	await expect.poll(() => state.scans.renders).toEqual(['scan-edge-worn']);
	await expect(page.getByTestId('surface-scan-viewer')).toHaveCount(0); // the view closes: the scan is not done any more
	await expect(worn).toContainText(/Waiting to render|Rendering/);
	await expect(worn).toContainText('Ready', { timeout: 25_000 });
	await worn.getByRole('button', { name: /Open .* in 3D/ }).click();
	await expect(page.getByTestId('surface-scan-viewer')).toHaveAttribute('data-phase', 'ready', { timeout: 30_000 });
	expect(errors).toEqual([]);
	await page.context().close();
});

test('Add a surface scan: the lab-wide warning, a file from the library, and a plain create that ends as a rendered scan', async ({ browser }, testInfo) => {
	const { page, state, errors } = await start(browser, `/edges/${T.edgeId}`);
	await panel(page).getByRole('button', { name: 'Add a surface scan' }).click();
	const dialog = page.getByRole('dialog');
	await expect(dialog).toContainText('Add a surface scan to Edge');
	await expect(dialog.getByTestId('visibility-warning')).toContainText('visible to every lab member');
	await expect(dialog).not.toContainText(/attach/i);
	const submit = dialog.getByRole('button', { name: 'Add surface scan' });
	await expect(submit).toBeDisabled();

	// The library lists topography files; a file this edge already has is not offered.
	await expect(dialog.locator('.hit')).toHaveCount(2);
	await dialog.locator('.hit').filter({ hasText: 'after-12min' }).click();
	await expect(dialog.locator('.chosen')).toContainText('Alicona-edgeA-after-12min.al3d');
	await expect(submit).toBeDisabled(); // no condition yet
	await dialog.locator('select').first().selectOption({ label: 'Other' });
	await expect(dialog).toContainText('Say in the note what the condition is.');
	await expect(submit).toBeDisabled();
	await dialog.locator('textarea').fill('Built-up edge after 12 min');
	await dialog.locator('input[type="date"]').fill('2026-10-14');
	await dialog.locator('select').nth(1).selectOption({ index: 1 }); // the operation that wore it
	await expect(submit).toBeEnabled();
	await testInfo.attach('add-dialog', { body: await page.screenshot(), contentType: 'image/png' });
	await page.screenshot({ path: testInfo.outputPath('add-dialog.png') });
	await submit.click();

	await expect(dialog).toHaveCount(0);
	expect(state.scans.created).toEqual([
		{ directus_files_id: 'file-new-1', condition: 'other', edge_id: T.edgeId, condition_note: 'Built-up edge after 12 min', scanned_on: '2026-10-14', operation_id: 'op-1' },
	]);
	const added = row(page, 'Alicona-edgeA-after-12min.al3d');
	await expect(added).toContainText('Other');
	await expect(added).toContainText('14 Oct 2026');
	await expect(added).toContainText('Built-up edge after 12 min');
	await expect(added).toContainText(/Waiting to render|Rendering|Ready/);
	await expect(added).toContainText('Ready', { timeout: 25_000 });
	await expect(added.locator('.thumb img')).toBeVisible();

	// A file this edge already has is not offered again; a refused create is shown and the dialog stays open.
	await panel(page).getByRole('button', { name: 'Add a surface scan' }).click();
	await expect(dialog.locator('.hit').filter({ hasText: 'after-12min' })).toBeDisabled(); // already this edge's scan: not offered
	await dialog.locator('.hit').filter({ hasText: 'cleaned' }).click();
	await dialog.locator('select').first().selectOption({ label: 'Cleaned' });
	state.scans.refuseCreate = 'You do not have permission to access this.';
	await dialog.getByRole('button', { name: 'Add surface scan' }).click();
	await expect(dialog.locator('.err')).toContainText('You may not add a surface scan here.'); // a refusal is shown, not swallowed
	await expect(dialog).toBeVisible();
	await dialog.getByRole('button', { name: 'Cancel' }).click();
	await expect(dialog).toHaveCount(0);
	expect(errors).toEqual([]);
	await page.context().close();
});

test('without WebGL the viewer says so and still shows the facts of the scan', async ({ browser }) => {
	const { page, errors } = await start(browser, `/inserts/${T.insertId}`, { noWebgl: true });
	await row(page, 'CNMG12-1-new.al3d').getByRole('button', { name: /Open .* in 3D/ }).click();
	const viewer = page.getByTestId('surface-scan-viewer');
	await expect(viewer).toHaveAttribute('data-phase', 'no-webgl');
	await expect(viewer).toContainText('cannot draw the 3D view');
	await expect(viewer).toContainText('192 × 128 cells');
	await expect(viewer.locator('canvas')).toHaveCount(0);
	expect(errors).toEqual([]);
	await page.context().close();
});
