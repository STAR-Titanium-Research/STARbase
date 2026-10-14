import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STAR_BASE, adminApi, signInStarbase, watchErrors } from '../starbase/target';

// The Process map (/map) end to end on the preview copy of live, as an admin and as a Lab Member: the map draws
// from a real family, a wire's tooltip and Ctrl+click, ＋ on a slot, hover / drag / ＋ leave the viewport alone,
// the rail, the Sample page's button, keyboard focus, the data thumbnail, a campaign's fan, the phone's bottom
// sheet. Data comes from admin API queries, so each scenario skips (with its reason) when the copy has none.
//   (cd tests/ui && D1_ROUTES_CREDENTIALS=<abs path of preview-credentials-<name>.txt> D1_ROUTES_STARBASE=http://127.0.0.1:5190 \
//      npx playwright test specs/17-process-map.spec.ts --retries=0)
// Needs the d1-starbase preview and STARbase under vite preview running (tests/ui/README.md, spec 14 section).
// Origins come from the credentials file (`url`) and D1_ROUTES_STARBASE, like spec 13, so a preview under another
// name or port works the same.

const repo = join(__dirname, '..', '..', '..');
const credsFile = process.env.D1_ROUTES_CREDENTIALS || process.env.STARBASE_E2E_CREDENTIALS || join(repo, '.superpowers', 'preview-credentials-d1-starbase.txt');
const creds = Object.fromEntries(
	readFileSync(credsFile, 'utf8').trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const SERVER = (process.env.D1_ROUTES_ADMIN_BASE || creds.url).replace(/\/+$/, '').replace(/\/admin$/, '');
const STARBASE = (process.env.D1_ROUTES_STARBASE || STAR_BASE).replace(/\/+$/, '');
// The shared helpers (tests/ui/starbase/target.ts) read the same credentials file.
process.env.STARBASE_E2E_CREDENTIALS ||= credsFile;
const ORIGINS = { star: STARBASE, d1: SERVER };

const SAMPLES = 'physical_samples';
// Chrome logs every 4xx resource as a console error: a Lab Member's refused reads (and the map's own d1-trace 404 for
// a sample it may not see) are handled by the pages, so only 5xx responses, page errors and other console errors count.
const IGNORED_CONSOLE = [/ResizeObserver loop/];
const CRASH = /Unexpected Error|no Explorer host|No such page/i;

type Json = Record<string, unknown>;
async function rows(api: APIRequestContext, path: string): Promise<Json[]> {
	const res = await api.get(`${SERVER}${path}`);
	return res.ok() ? (((await res.json()).data as Json[]) ?? []) : [];
}
const str = (v: unknown) => (typeof v === 'string' ? v : null);

/** Samples with operations on them, up to `max`: those whose operation has a machine and a tool (a slot with ＋) first. */
async function familySamples(api: APIRequestContext, readable?: APIRequestContext, max = 1): Promise<{ id: string; code: string }[]> {
	const found: { id: string; code: string }[] = [];
	const tries = [
		'/items/manufacturing_operations?limit=40&fields=sample_id&filter[sample_id][_nnull]=true&filter[equipment_id][_nnull]=true&filter[tool_id][_nnull]=true',
		'/items/manufacturing_operations?limit=40&fields=sample_id&filter[sample_id][_nnull]=true',
	];
	for (const q of tries) {
		const ids = [...new Set((await rows(api, q)).map((r) => str(r.sample_id)).filter((s): s is string => !!s))];
		for (const id of ids.slice(0, 20)) {
			// A Lab Member reads only some samples: the sample must be one this session can read.
			const sample = (await rows(readable ?? api, `/items/${SAMPLES}?limit=1&fields=sample_id,sample_code&filter[sample_id][_eq]=${id}`))[0];
			if (sample && str(sample.sample_code) && !found.some((f) => f.id === id)) found.push({ id, code: str(sample.sample_code)! });
			if (found.length >= max) return found;
		}
	}
	return found;
}
const familySample = async (api: APIRequestContext, readable?: APIRequestContext) => (await familySamples(api, readable))[0] ?? null;

const mapUrl = (collection: string, id: string) => `${STARBASE}/map?focus=${collection}:${encodeURIComponent(id)}`;
const nodes = (page: Page) => page.locator('.vue-flow__node');
const railCode = (page: Page) => page.locator('.d1-record-rail .code');
/** The viewport's own transform (pan and zoom): the same string means the canvas did not move. */
const viewport = (page: Page) => page.locator('.vue-flow__transformationpane').evaluate((e) => (e as HTMLElement).style.transform);

/** Open the map on a record and wait until it is drawn and settled (the first fit is instant, but layout is async). */
async function openMap(page: Page, collection: string, id: string): Promise<void> {
	await page.goto(mapUrl(collection, id), { waitUntil: 'networkidle' });
	await expect(page.locator('.pm-canvas:not(.pending)')).toBeVisible();
	await expect.poll(() => nodes(page).count(), { message: 'cards drawn' }).toBeGreaterThanOrEqual(2);
	await settled(page);
}
/** Wait for the viewport to stop moving (a fit or a glide). */
async function settled(page: Page): Promise<void> {
	let last = '';
	await expect
		.poll(async () => {
			const now = await viewport(page);
			const same = now === last;
			last = now;
			return same;
		}, { intervals: [250, 250, 250, 250, 500, 500] })
		.toBe(true);
}

/** A point on wire `i` that the wire's wide hit path really receives (a card or a control may cover its middle), else null. */
async function pointOnWire(page: Page, i: number): Promise<{ x: number; y: number } | null> {
	return page.locator('.vue-flow__edge path.hit').nth(i).evaluate((p) => {
		const path = p as unknown as SVGPathElement;
		const len = path.getTotalLength();
		const m = path.getScreenCTM();
		if (!m) return null;
		for (const t of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8]) {
			const pt = path.getPointAtLength(len * t);
			const x = m.a * pt.x + m.c * pt.y + m.e;
			const y = m.b * pt.x + m.d * pt.y + m.f;
			if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
			if (document.elementFromPoint(x, y) === path) return { x, y };
		}
		return null;
	});
}

/** Hover every wire the pointer can reach and read the tooltip it raises. */
async function hoverWires(page: Page): Promise<{ i: number; text: string; at: { x: number; y: number } }[]> {
	const wires = await page.locator('.vue-flow__edge path.hit').count();
	const tips: { i: number; text: string; at: { x: number; y: number } }[] = [];
	for (let i = 0; i < wires; i++) {
		const at = await pointOnWire(page, i);
		if (!at) continue;
		await page.mouse.move(at.x, at.y);
		const tip = page.locator('.wire-tip.show');
		try {
			await tip.waitFor({ state: 'visible', timeout: 1500 });
			tips.push({ i, text: await tip.innerText(), at });
		} catch {
			/* a wire with no drawn ends raises no tooltip */
		}
		await page.mouse.move(2, 2);
		await expect(page.locator('.wire-tip.show')).toHaveCount(0);
	}
	return tips;
}

for (const who of ['admin', 'member'] as const) {
	test.describe(`Process map as ${who}`, () => {
		test.setTimeout(120_000);
		test.use({ viewport: { width: 1400, height: 900 } });

		let admin: APIRequestContext;
		let sample: { id: string; code: string } | null = null;
		test.beforeAll(async ({ playwright }) => {
			admin = await adminApi(playwright, SERVER);
			// The admin reads every sample; the Lab Member's own sample is found in its own session in the first test.
			if (who === 'admin') sample = await familySample(admin);
		});
		test.afterAll(async () => {
			await admin.dispose();
		});

		// A member reads only some samples (on a fresh copy it may read none): look through its own session.
		async function ensureSample(page: Page): Promise<boolean> {
			if (who === 'member' && !sample) sample = await familySample(admin, page.request);
			return !!sample;
		}

		test('a sample\'s map draws, and a wire\'s tooltip names its sample', async ({ page }) => {
			const errors = watchErrors(page, IGNORED_CONSOLE);
			await signInStarbase(page, who, ORIGINS);
			if (!(await ensureSample(page))) {
				test.skip(who === 'admin', 'the copy has no sample with operations');
				// Nothing this account may map: the page must say so, not crash.
				const any = await familySample(admin);
				test.skip(!any, 'the copy has no sample with operations');
				await page.goto(mapUrl(SAMPLES, any!.id), { waitUntil: 'networkidle' });
				await expect(page.locator('.d1-page').first()).toContainText(/not visible to you|do not have permission/i);
				await expect(page.locator('body')).not.toContainText(CRASH);
				expect(errors).toEqual([]);
				test.skip(true, 'the Lab Member can read no sample with operations on this copy; the not-visible page was checked instead');
			}
			await openMap(page, SAMPLES, sample!.id);
			expect(await nodes(page).count()).toBeGreaterThanOrEqual(2);
			await expect(page.locator('.vue-flow__node-container').first(), 'an operation card').toBeVisible();
			await expect(railCode(page), 'the rail names the focus').toHaveText(sample!.code);

			const tips = await hoverWires(page);
			expect(tips.length, 'a wire raised its tooltip').toBeGreaterThan(0);
			expect(tips.some((t) => t.text.includes(sample!.code)), `a tooltip names ${sample!.code}`).toBe(true);
			await expect(page.locator('body')).not.toContainText(/lineage graph/i);
			await expect(page.locator('body')).not.toContainText(CRASH);
			expect(errors).toEqual([]);
		});

		test('Ctrl+click on a wire goes to the wire\'s origin', async ({ page }) => {
			const errors = watchErrors(page, IGNORED_CONSOLE);
			await signInStarbase(page, who, ORIGINS);
			test.skip(!(await ensureSample(page)), `the ${who} can read no sample with operations on this copy`);
			// A sample whose map has a wire that comes from a record other than the selected one (an operation's output,
			// a material's wire): look through a few samples; never pass without clicking.
			const candidates = await familySamples(admin, who === 'member' ? page.request : undefined, 8);
			let clicked: string | null = null;
			for (const c of candidates) {
				await openMap(page, SAMPLES, c.id);
				const before = (await railCode(page).innerText()).trim();
				const far = (await hoverWires(page))
					.map((t) => ({ ...t, from: /^from (.+)$/m.exec(t.text)?.[1] ?? null }))
					.find((t) => t.from && t.from !== before);
				if (!far) continue;
				await page.mouse.move(far.at.x, far.at.y);
				await page.keyboard.down('Control');
				await page.mouse.click(far.at.x, far.at.y);
				await page.keyboard.up('Control');
				await expect(railCode(page), 'the rail shows the wire\'s origin').toHaveText(far.from!);
				clicked = far.from;
				break;
			}
			expect(errors).toEqual([]);
			test.skip(!clicked, `none of ${candidates.length} samples the ${who} can map has a wire from a record other than the selected one`);
		});

		test('＋ on a slot adds cards; hover, a card drag and ＋ do not pan the canvas', async ({ page }) => {
			const errors = watchErrors(page, IGNORED_CONSOLE);
			await signInStarbase(page, who, ORIGINS);
			test.skip(!(await ensureSample(page)), `the ${who} can read no sample with operations on this copy`);
			await openMap(page, SAMPLES, sample!.id);
			const still = await viewport(page);

			// Hover: a card, a slot's record, a wire.
			const card = page.locator('.vue-flow__node-container').first();
			await card.locator('.ohead').hover();
			await page.waitForTimeout(500); // the hover card shows after a 250 ms rest
			const slotRecord = card.locator('.slot .sc[data-map-id]').first();
			if (await slotRecord.count()) await slotRecord.hover();
			const at = await pointOnWire(page, 0);
			if (at) await page.mouse.move(at.x, at.y);
			await page.mouse.move(2, 2);
			expect(await viewport(page), 'hover did not pan').toBe(still);

			// Drag: a card moves itself, not the canvas; a slot (nodrag) moves nothing.
			const nodeBox = async () => (await card.boundingBox())!;
			const head = (await card.locator('.ohead').boundingBox())!;
			const b0 = await nodeBox();
			await page.mouse.move(head.x + head.width / 2, head.y + head.height / 2);
			await page.mouse.down();
			await page.mouse.move(head.x + head.width / 2 + 40, head.y + head.height / 2 + 30, { steps: 6 });
			await page.mouse.up();
			const b1 = await nodeBox();
			expect(Math.abs(b1.x - b0.x) + Math.abs(b1.y - b0.y), 'dragging the header moved the card').toBeGreaterThan(10);
			expect(await viewport(page), 'a card drag did not pan').toBe(still);
			const slot = card.locator('.slot .sr').first();
			if (await slot.count()) {
				const s = (await slot.boundingBox())!;
				await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
				await page.mouse.down();
				await page.mouse.move(s.x + s.width / 2 + 60, s.y + s.height / 2 + 40, { steps: 6 });
				await page.mouse.up();
				const b2 = await nodeBox();
				expect(Math.abs(b2.x - b1.x) + Math.abs(b2.y - b1.y), 'a slot drag moved no card').toBeLessThan(2);
				expect(await viewport(page), 'a slot drag did not pan').toBe(still);
			}

			// ＋ on a slot's record: what else used it joins the map, and the view stays.
			const plus = page.getByRole('button', { name: /Show what else used/ }).first();
			test.skip(!(await plus.count()), 'no operation on this sample has a machine or tool slot');
			const n0 = await nodes(page).count();
			await plus.click();
			if (who === 'admin') {
				await expect.poll(() => nodes(page).count(), { message: 'the fan\'s cards joined' }).toBeGreaterThan(n0);
			} else {
				// A Lab Member sees only the records it may read: the cards join, or the page says nothing else is there.
				const none = page.locator('.pm-banner').getByText(/Nothing else in the map used/);
				await expect.poll(async () => (await nodes(page).count()) > n0 || (await none.count()) > 0, { message: 'the fan\'s cards joined, or the banner says there are none' }).toBe(true);
			}
			expect(await viewport(page), '＋ did not pan').toBe(still);
			expect(errors).toEqual([]);
		});

		test('Open record in the rail leads to the record page; the Sample page\'s Process map button leads back', async ({ page }) => {
			const errors = watchErrors(page, IGNORED_CONSOLE);
			await signInStarbase(page, who, ORIGINS);
			test.skip(!(await ensureSample(page)), `the ${who} can read no sample with operations on this copy`);
			await openMap(page, SAMPLES, sample!.id);
			await page.locator('.d1-record-rail').getByRole('link', { name: /Open record/ }).click();
			await page.waitForURL((u) => u.pathname === `/samples/${sample!.id}`);
			await expect(page.locator('.d1-page').first()).toBeVisible();

			// The button on the Sample page (the nav's own "Process map" link is not in the page body).
			await page.locator('.d1-page').locator('[aria-label="Process map"]').first().click();
			await page.waitForURL((u) => u.pathname === '/map');
			const url = new URL(page.url());
			expect(url.searchParams.get('focus')).toBe(`${SAMPLES}:${sample!.id}`);
			await expect(nodes(page).first()).toBeVisible();
			await expect(page.locator('body')).not.toContainText(/lineage graph/i);
			expect(errors).toEqual([]);
		});

		test('an operation the account may read opens its map, or says the sample is what it may not see', async ({ page }) => {
			const errors = watchErrors(page, IGNORED_CONSOLE);
			await signInStarbase(page, who, ORIGINS);
			const op = (await rows(page.request, '/items/manufacturing_operations?limit=1&fields=operation_id&filter[sample_id][_nnull]=true'))[0];
			test.skip(!op, `the ${who} can read no operation with a sample on this copy`);
			await page.goto(mapUrl('manufacturing_operations', String(op.operation_id)), { waitUntil: 'networkidle' });
			await expect(page.locator('.d1-page').first()).toBeVisible();
			// Found by this spec: a readable operation on a hidden sample used to say "this operation does not exist".
			await expect(page.locator('body')).not.toContainText(/this operation does not exist/i);
			await expect(page.locator('body')).not.toContainText(CRASH);
			// Either the sample is readable and the map draws, or the page says what is hidden.
			const hidden = page.locator('.d1-page').getByText(/can read this operation, but not the sample/i);
			await expect(nodes(page).first().or(hidden)).toBeVisible({ timeout: 20_000 });
			expect(errors).toEqual([]);
		});
	});
}

test.describe('Process map: keyboard, data thumbnail, campaign fan (admin)', () => {
	test.setTimeout(180_000);
	test.use({ viewport: { width: 1400, height: 900 } });

	let admin: APIRequestContext;
	test.beforeAll(async ({ playwright }) => {
		admin = await adminApi(playwright, SERVER);
	});
	test.afterAll(async () => {
		await admin.dispose();
	});

	test('Tab reaches cards and sockets, and a socket names what it connects', async ({ page }) => {
		const errors = watchErrors(page, IGNORED_CONSOLE);
		const sample = await familySample(admin);
		test.skip(!sample, 'the copy has no sample with operations');
		await signInStarbase(page, 'admin', ORIGINS);
		await openMap(page, SAMPLES, sample!.id);
		await page.getByRole('button', { name: 'Clear' }).focus();
		let card = false;
		let socket: string | null = null;
		for (let i = 0; i < 40 && !(card && socket); i++) {
			await page.keyboard.press('Tab');
			const at = await page.evaluate(() => {
				const a = document.activeElement as HTMLElement;
				return { card: a.classList.contains('vue-flow__node'), socket: a.classList.contains('vue-flow__handle') ? a.getAttribute('aria-label') : null };
			});
			card ||= at.card;
			socket ||= at.socket;
		}
		expect(card, 'Tab reached a card').toBe(true);
		expect(socket, 'Tab reached a socket').toMatch(/^(Input|Output): /);
		expect(errors).toEqual([]);
	});

	test('a campaign\'s fan loads (its sample sort is accepted) and draws its samples', async ({ page }) => {
		const errors = watchErrors(page, IGNORED_CONSOLE);
		const link = (await rows(admin, '/items/campaign_samples?limit=1&fields=campaign_id'))[0];
		test.skip(!link, 'the copy has no campaign with samples');
		await signInStarbase(page, 'admin', ORIGINS);
		const read = page.waitForResponse((r) => /\/items\/campaign_samples\?/.test(r.url()) && r.request().method() === 'GET');
		await page.goto(mapUrl('campaigns', String(link.campaign_id)), { waitUntil: 'networkidle' });
		const res = await read;
		expect(decodeURIComponent(res.url()), 'the fan sorts by the sample code').toContain('sample_id.sample_code');
		expect(res.status(), 'Directus accepts the fan\'s sort').toBe(200);
		await expect.poll(() => nodes(page).count()).toBeGreaterThanOrEqual(2);
		await expect(page.locator('body')).not.toContainText(/lineage graph/i);
		expect(errors).toEqual([]);
	});

	test('the Fz figure of an operation with force data draws, or the card falls back to its words', async ({ page }) => {
		const errors = watchErrors(page, IGNORED_CONSOLE);
		const withFz = await rows(admin, '/items/machining_force_analysis?limit=12&fields=operation_id&filter[frm_fz][_nnull]=true&filter[status][_eq]=done');
		test.skip(!withFz.length, 'the copy has no force analysis with a figure');
		await signInStarbase(page, 'admin', ORIGINS);
		let found = false;
		for (const r of withFz) {
			await page.goto(mapUrl('manufacturing_operations', String(r.operation_id)), { waitUntil: 'networkidle' });
			await expect(page.locator('.pm-canvas:not(.pending)')).toBeVisible();
			// The rail's data block: caption and plotter link, then the picture when the file can be shown.
			const thumb = page.locator('.d1-record-rail .dthumb');
			try {
				await thumb.waitFor({ state: 'visible', timeout: 4000 });
			} catch {
				continue; // a batch whose representative operation has no figure
			}
			found = true;
			await expect(thumb.locator('.cap')).toContainText('Force data');
			await expect(thumb.getByRole('link', { name: /Open in Force dashboard/ })).toBeVisible();
			await page.waitForTimeout(1500); // the image loads, or fails and is removed
			const broken = await thumb.locator('img').evaluateAll((imgs) => imgs.filter((i) => !(i as HTMLImageElement).naturalWidth).length);
			expect(broken, 'no broken picture is left behind').toBe(0);
			break;
		}
		test.skip(!found, 'no figure-bearing operation of this copy opens with a data block');
		expect(errors).toEqual([]);
	});
});

test.describe('Process map on a phone (admin)', () => {
	test.setTimeout(120_000);
	test.use({ viewport: { width: 375, height: 812 } });

	test('first paint: the zoom controls are on screen and the collapsed sheet does not cover them', async ({ page, playwright }) => {
		const errors = watchErrors(page, IGNORED_CONSOLE);
		const admin = await adminApi(playwright, SERVER);
		const sample = await familySample(admin);
		await admin.dispose();
		test.skip(!sample, 'the copy has no sample with operations');
		await signInStarbase(page, 'admin', ORIGINS);
		await page.goto(mapUrl(SAMPLES, sample!.id), { waitUntil: 'networkidle' });
		await expect(page.locator('.pm-canvas:not(.pending)')).toBeVisible();
		await expect(page.locator('.pm-sheet')).toBeVisible();
		await expect(page.locator('.vue-flow__minimap'), 'no minimap on a phone').toHaveCount(0);
		// No scrolling: the state the person lands in.
		const controls = (await page.locator('.vue-flow__controls').boundingBox())!;
		const sheet = (await page.locator('.pm-sheet').boundingBox())!;
		const view = page.viewportSize()!;
		expect(controls.y, 'the controls start on screen').toBeGreaterThanOrEqual(0);
		expect(controls.y + controls.height, 'the controls end inside the window').toBeLessThanOrEqual(view.height);
		expect(controls.y + controls.height, 'the sheet does not cover the controls').toBeLessThanOrEqual(sheet.y);
		// Every button of the controls receives the pointer (nothing on top of it).
		for (const b of await page.locator('.vue-flow__controls-button').all()) {
			const box = (await b.boundingBox())!;
			const hit = await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('.vue-flow__controls-button'), [box.x + box.width / 2, box.y + box.height / 2]);
			expect(hit, 'a control button receives the pointer').toBe(true);
		}

		// Opening the sheet shows the rail; closing it again gives the map back.
		await page.locator('.pm-sheet > .head').click();
		await expect(page.locator('.pm-sheet .d1-record-rail .code')).toHaveText(sample!.code);
		await page.locator('.pm-sheet > .head').click();
		await expect(page.locator('.pm-sheet .d1-record-rail')).toBeHidden();
		await expect(page.locator('body')).not.toContainText(/lineage graph/i);
		expect(errors).toEqual([]);
	});
});

// A recorded batch (spec §9, ADR-0017): a batch row created through the API with two operations of one family
// attached to it draws as ONE container titled "Batch B-…" holding both rows. The batch and the batch_id values
// are put back afterwards (a batch is deleted last; batch_id is ON DELETE SET NULL anyway). Needs the batches
// migration (the preview applies it) and a sample with two unbatched operations.
test.describe('Process map recorded batch (admin)', () => {
	test.setTimeout(120_000);
	test.use({ viewport: { width: 1400, height: 900 } });

	test('two operations of one family in a recorded batch draw as one "Batch B-…" container', async ({ page, playwright }) => {
		const errors = watchErrors(page, IGNORED_CONSOLE);
		const admin = await adminApi(playwright, SERVER);
		let batchId: string | null = null;
		const attached: string[] = [];
		try {
			const batchField = await admin.get(`${SERVER}/fields/manufacturing_operations/batch_id`);
			test.skip(!batchField.ok(), 'the copy has no batch_id on operations (the batches migration is not applied)');
			const ops = await rows(admin, '/items/manufacturing_operations?limit=-1&fields=operation_id,sample_id&filter[sample_id][_nnull]=true&filter[batch_id][_null]=true');
			const bySample = new Map<string, string[]>();
			for (const o of ops) {
				const s = str(o.sample_id);
				if (s) bySample.set(s, [...(bySample.get(s) ?? []), String(o.operation_id)]);
			}
			const pick = [...bySample].find(([, ids]) => ids.length >= 2);
			test.skip(!pick, 'the copy has no sample with two unbatched operations');
			const [sampleId, opIds] = pick!;

			const made = await admin.post(`${SERVER}/items/batches`, { data: { notes: 'E2E process map scenario' } });
			expect(made.ok(), 'create a batch with the code left out').toBeTruthy();
			const batch = (await made.json()).data as { batch_id: string; code: string };
			batchId = batch.batch_id;
			expect(batch.code).toMatch(/^B-\d{4,}$/);
			for (const id of opIds.slice(0, 2)) {
				const r = await admin.patch(`${SERVER}/items/manufacturing_operations/${id}`, { data: { batch_id: batchId } });
				expect(r.ok(), `attach operation ${id} to the batch`).toBeTruthy();
				attached.push(id);
			}

			await signInStarbase(page, 'admin', ORIGINS);
			await openMap(page, SAMPLES, sampleId);
			const container = page.locator('.vue-flow__node-container').filter({ has: page.locator('.ohead .m', { hasText: `Batch ${batch.code}` }) });
			await expect(container, 'one container for the recorded batch').toHaveCount(1);
			await expect(container.locator('.orow:not(.fold):not(.bundle)'), 'one row per operation').toHaveCount(2);
			await expect(page.locator('body')).not.toContainText(/lineage graph/i);
			expect(errors).toEqual([]);
		} finally {
			// Back to how the copy was: batch_id cleared first, then the batch (the delete would also null them).
			for (const id of attached) await admin.patch(`${SERVER}/items/manufacturing_operations/${id}`, { data: { batch_id: null } });
			if (batchId) await admin.delete(`${SERVER}/items/batches/${batchId}`);
			await admin.dispose();
		}
	});
});
