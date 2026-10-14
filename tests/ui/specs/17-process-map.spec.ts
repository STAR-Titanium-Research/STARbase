import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STAR_BASE, adminApi, signInStarbase } from '../starbase/target';

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
const IGNORED_CONSOLE = [/favicon/i, /ResizeObserver loop/, /Failed to load resource/];
const CRASH = /Unexpected Error|no Explorer host|No such page/i;

function watchErrors(page: Page): string[] {
	const errors: string[] = [];
	page.on('pageerror', (e) => errors.push(String(e)));
	page.on('response', (r) => {
		if (r.status() >= 500) errors.push(`${r.status()} ${r.url()}`);
	});
	page.on('console', (m) => {
		if (m.type() === 'error' && !IGNORED_CONSOLE.some((r) => r.test(m.text()))) errors.push(m.text());
	});
	return errors;
}

type Json = Record<string, unknown>;
async function rows(api: APIRequestContext, path: string): Promise<Json[]> {
	const res = await api.get(`${SERVER}${path}`);
	return res.ok() ? (((await res.json()).data as Json[]) ?? []) : [];
}
const str = (v: unknown) => (typeof v === 'string' ? v : null);

/** A sample with a few operations on it: one whose operation has a machine and a tool (a slot with ＋), when there is one. */
async function familySample(api: APIRequestContext, readable?: APIRequestContext): Promise<{ id: string; code: string } | null> {
	const tries = [
		'/items/manufacturing_operations?limit=40&fields=sample_id&filter[sample_id][_nnull]=true&filter[equipment_id][_nnull]=true&filter[tool_id][_nnull]=true',
		'/items/manufacturing_operations?limit=40&fields=sample_id&filter[sample_id][_nnull]=true',
	];
	for (const q of tries) {
		const ids = [...new Set((await rows(api, q)).map((r) => str(r.sample_id)).filter((s): s is string => !!s))];
		for (const id of ids.slice(0, 20)) {
			// A Lab Member reads only some samples: the sample must be one this session can read.
			const sample = (await rows(readable ?? api, `/items/${SAMPLES}?limit=1&fields=sample_id,sample_code&filter[sample_id][_eq]=${id}`))[0];
			if (sample && str(sample.sample_code)) return { id, code: str(sample.sample_code)! };
		}
	}
	return null;
}

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

		test('a sample\'s map draws; a wire\'s tooltip names its sample; Ctrl+click goes to the wire\'s origin', async ({ page }) => {
			const errors = watchErrors(page);
			await signInStarbase(page, who, ORIGINS);
			if (!(await ensureSample(page))) {
				// Nothing this account may map: the page must say so, not crash. (The admin always has a sample.)
				expect(who, 'the admin copy has samples with operations').toBe('member');
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

			// Hover every wire the pointer can reach, and read the tooltip it raises.
			const wires = await page.locator('.vue-flow__edge path.hit').count();
			expect(wires, 'the map has wires').toBeGreaterThan(0);
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
			expect(tips.length, 'a wire raised its tooltip').toBeGreaterThan(0);
			expect(tips.some((t) => t.text.includes(sample!.code)), `a tooltip names ${sample!.code}`).toBe(true);

			// Ctrl+click a wire that comes from somewhere other than the selected record: the rail moves to that origin.
			const before = (await railCode(page).innerText()).trim();
			const far = tips
				.map((t) => ({ ...t, from: /^from (.+)$/m.exec(t.text)?.[1] ?? null }))
				.find((t) => t.from && t.from !== before);
			if (far) {
				await page.mouse.move(far.at.x, far.at.y);
				await page.keyboard.down('Control');
				await page.mouse.click(far.at.x, far.at.y);
				await page.keyboard.up('Control');
				await expect(railCode(page), 'the rail shows the wire\'s origin').toHaveText(far.from!);
			} else {
				console.log(`${who}: every wire comes from ${before}; Ctrl+click not exercised`);
			}

			await expect(page.locator('body')).not.toContainText(/lineage graph/i);
			await expect(page.locator('body')).not.toContainText(CRASH);
			expect(errors).toEqual([]);
		});

		test('＋ on a slot adds cards; hover, a card drag and ＋ do not pan the canvas', async ({ page }) => {
			const errors = watchErrors(page);
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
			const errors = watchErrors(page);
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
			const errors = watchErrors(page);
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
		const errors = watchErrors(page);
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
		const errors = watchErrors(page);
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
		const errors = watchErrors(page);
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

	test('the collapsed sheet sits under the map, not over its zoom controls, once the page is scrolled to the end', async ({ page, playwright }) => {
		const errors = watchErrors(page);
		const admin = await adminApi(playwright, SERVER);
		const sample = await familySample(admin);
		await admin.dispose();
		test.skip(!sample, 'the copy has no sample with operations');
		await signInStarbase(page, 'admin', ORIGINS);
		await page.goto(mapUrl(SAMPLES, sample!.id), { waitUntil: 'networkidle' });
		await expect(page.locator('.pm-canvas:not(.pending)')).toBeVisible();
		await expect(page.locator('.pm-sheet')).toBeVisible();
		await expect(page.locator('.vue-flow__minimap'), 'no minimap on a phone').toHaveCount(0);
		// Scroll every scrolling ancestor of the map to its end: the controls sit at the canvas's bottom edge.
		await page.evaluate(() => {
			for (const e of document.querySelectorAll<HTMLElement>('*')) {
				if (e.scrollHeight > e.clientHeight + 5 && /(auto|scroll)/.test(getComputedStyle(e).overflowY)) e.scrollTop = e.scrollHeight;
			}
			window.scrollTo(0, document.body.scrollHeight);
		});
		const controls = (await page.locator('.vue-flow__controls').boundingBox())!;
		const sheet = (await page.locator('.pm-sheet').boundingBox())!;
		expect(controls.y, 'the controls are on screen').toBeGreaterThanOrEqual(0);
		expect(controls.y + controls.height, 'the sheet does not cover the controls').toBeLessThanOrEqual(sheet.y);

		// Opening the sheet shows the rail; closing it again gives the map back.
		await page.locator('.pm-sheet > .head').click();
		await expect(page.locator('.pm-sheet .d1-record-rail .code')).toHaveText(sample!.code);
		await page.locator('.pm-sheet > .head').click();
		await expect(page.locator('.pm-sheet .d1-record-rail')).toBeHidden();
		await expect(page.locator('body')).not.toContainText(/lineage graph/i);
		expect(errors).toEqual([]);
	});
});
