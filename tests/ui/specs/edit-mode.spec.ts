import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { D1, STAR, apiAs, getRetrying, listRecords, readRecord, signIn, stackAvailable } from '../starbase/localStack';

/**
 * Process map edit mode (`/map?edit=new`) in a REAL browser against the LOCAL STACK: STARbase's dev server, a real Directus 11 with the
 * repo's extensions (d1-build, d1-owner-default, d1-access-guard, ...) and a real Postgres with every migration. Not the fake build
 * server of packages/starbase-pages/src/pages/map/edit/fakeBuildServer.ts: this is where the edit-mode redesign (spec
 * docs/superpowers/specs/2026-10-18-process-map-edit-mode-redesign.md, plan docs/superpowers/plans/2026-10-18-process-map-edit-redesign.md)
 * is proven. Bring the stack up first and run with the local-stack config:
 *
 *   bash scripts/dev/local-stack.sh up
 *   cd tests/ui && npx playwright test -c playwright.local-stack.config.ts
 *
 * Known failures: each bug the 2026-10-18 audit found (spec §3, and R11) that this suite reproduces on the real stack today is a
 * `test.fail()` that names its spec item. The suite is green now; when a slice fixes one, Playwright reports "expected to fail but
 * passed" and that slice deletes the `test.fail` line (and nothing else). Do not weaken an assertion to make a slice pass.
 *
 * Every record the tests Create is removed afterwards through the admin API (they are planned, so deletable), and every draft the
 * accounts leave behind is deleted, so the suite can run again on the same stack. The seed family (scripts/dev/local-stack.seed.sql)
 * is only read.
 */

/**
 * Marks the running test as a known failure (`test.fail`): it must fail today, and Playwright flags it the day it starts to pass.
 * `D1_SHOW_KNOWN_FAILURES=1` turns the marks off, so each one shows its real assertion error: run that to check a mark still fails
 * for the reason it names, or to see what a slice has fixed.
 */
const known = (reason: string, fixed = false): void => test.fail(!fixed && process.env.D1_SHOW_KNOWN_FAILURES !== '1', reason);

type Ref = { collection: string; id: string };
interface Seeds {
	raw1: { id: string; code: string };
	raw2: { id: string; code: string };
	turning: { id: string };
	memberPersonId: string;
}

let admin: APIRequestContext;
let member: APIRequestContext;
let viewer: APIRequestContext;
let seeds: Seeds;
/** Everything the tests created, for the clean-up. */
const made: Ref[] = [];

const DRAFT_URL = /[?&]edit=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

test.beforeAll(async ({ playwright }) => {
	test.skip(!stackAvailable(), 'the local stack is not up: run `bash scripts/dev/local-stack.sh up`');
	admin = await apiAs(playwright, 'admin');
	member = await apiAs(playwright, 'member');
	viewer = await apiAs(playwright, 'viewer');
	const sample = async (code: string) => {
		const [row] = await listRecords<{ sample_id: string }>(admin, 'physical_samples', `filter[sample_code][_eq]=${code}&fields=sample_id`);
		expect(row, `the seed sample ${code} (bash scripts/dev/local-stack.sh seed)`).toBeTruthy();
		return { id: row.sample_id, code };
	};
	const me = await (await getRetrying(member, `${D1}/users/me?fields=id`)).json();
	const [person] = await listRecords<{ person_id: string }>(admin, 'people', `filter[user_id][_eq]=${me.data.id}&fields=person_id`);
	const [turning] = await listRecords<{ method_id: string }>(admin, 'manufacturing_methods', 'filter[method_code][_eq]=MC&fields=method_id');
	expect(person && turning, 'the Lab Member People row and the CNC Turning method').toBeTruthy();
	seeds = { raw1: await sample('LOCAL-RAW-1'), raw2: await sample('LOCAL-RAW-2'), turning: { id: turning.method_id }, memberPersonId: person.person_id };
});

/** Drafts are the account's own and survive a test: delete them so the next test starts with an empty "My drafts". */
async function deleteDrafts(api: APIRequestContext): Promise<void> {
	const r = await getRetrying(api, `${D1}/d1-build/drafts`);
	if (!r.ok()) return;
	for (const d of (await r.json()).data as { id: string }[]) await api.delete(`${D1}/d1-build/drafts/${d.id}`);
}

// After every test (a failed one too: Playwright restarts the worker after a failure, so nothing is left for an afterAll).
test.afterEach(async () => {
	if (!stackAvailable() || !admin) return;
	await Promise.all([deleteDrafts(member), deleteDrafts(viewer)]);
	// Operations and tests first (they point at samples), then the samples. A failed delete is reported, not thrown: the seed family
	// is untouched either way, and a leftover planned record is only noise.
	for (const collection of ['manufacturing_operations', 'test_sessions', 'physical_samples']) {
		for (const ref of made.filter((m) => m.collection === collection)) {
			const r = await admin.delete(`${D1}/items/${collection}/${ref.id}`);
			if (!r.ok()) console.warn(`clean-up: DELETE ${collection}/${ref.id} answered ${r.status()}: ${await r.text()}`);
		}
	}
	made.length = 0;
});

// ---- what a person does on the page --------------------------------------------------------------------------------------------

const createButton = (page: Page): Locator => page.locator('.pm-create').getByRole('button');

async function openNewDraft(page: Page): Promise<void> {
	await page.goto(`${STAR}/map?edit=new`, { waitUntil: 'domcontentloaded' });
	await page.waitForURL(DRAFT_URL);
	await expect(page.getByRole('button', { name: /Pick samples/ })).toBeVisible();
}

/** The sample picker: tick one seeded sample in the Samples list and confirm. */
async function pickSample(page: Page, code: string): Promise<void> {
	await page.getByRole('button', { name: /Pick samples/ }).click();
	const dialog = page.getByRole('dialog', { name: 'Pick samples' });
	await dialog.getByRole('row', { name: new RegExp(code) }).getByRole('checkbox').check();
	await dialog.getByRole('button', { name: /^Add 1 sample$/ }).click();
	await expect(dialog).toBeHidden();
	await expect(page.getByRole('group', { name: new RegExp(`^${code}, Sample`) })).toBeVisible();
}

/**
 * Opens a socket's add menu from the keyboard (Enter on the socket: the same menu a click opens, and it needs no card to be inside
 * the viewport) and chooses one entry of it.
 */
async function chooseFromSocketMenu(page: Page, socket: Locator, entry: RegExp): Promise<void> {
	await socket.press('Enter');
	await page.locator('.pm-addsearch').getByRole('option', { name: entry }).click();
	await expect(page.locator('.pm-addsearch')).toBeHidden();
}

/** Picks LOCAL-RAW-1, adds a CNC Turning operation from its output socket and wires a new sample out of the operation. */
async function buildTurningWithNewSample(page: Page): Promise<void> {
	await openNewDraft(page);
	await pickSample(page, seeds.raw1.code);
	await chooseFromSocketMenu(page, page.locator(`[data-sock="sample|${seeds.raw1.id}|out"]`), /CNC Turning/);
	await chooseFromSocketMenu(page, page.locator('[data-sock^="row|draft:"][data-sock$="|out"]'), /^New sample/);
	await expect(createButton(page)).toHaveText('Create 1 operation, 1 sample');
	await expect(createButton(page)).toBeEnabled();
}

interface CreateAnswer {
	status: number;
	body: { data?: { created: Record<string, Ref & { code: string }>; sampleIds: string[] }; errors?: { message: string; extensions: { code: string } }[] };
}
/** Presses Create and returns what d1-build answered; what it created is queued for the clean-up. */
async function pressCreate(page: Page): Promise<CreateAnswer> {
	const answered = page.waitForResponse((r) => /\/d1-build\/drafts\/[^/]+\/create$/.test(r.url()) && r.request().method() === 'POST');
	await createButton(page).click();
	const response = await answered;
	const body = (await response.json()) as CreateAnswer['body'];
	for (const ref of Object.values(body.data?.created ?? {})) if (!made.some((m) => m.id === ref.id)) made.push({ collection: ref.collection, id: ref.id });
	return { status: response.status(), body };
}

/** The distinct records a Create made (the map holds one entry per draft KEY, an operation under its item key and its row key). */
const distinctRecords = (created: Record<string, Ref>): Ref[] => [...new Map(Object.values(created).map((r) => [r.id, r])).values()];

// ---- the main run -------------------------------------------------------------------------------------------------------------

test.describe('as a Lab Member', () => {
	test.beforeEach(async ({ page }) => {
		await signIn(page, 'member');
	});

	test('picks a sample, adds an operation, wires an output sample, Creates, and the API reads the records back', async ({ page }) => {
		await buildTurningWithNewSample(page);
		const { status, body } = await pressCreate(page);
		expect(status, JSON.stringify(body)).toBe(200);
		const created = body.data!.created;

		// Create leaves the draft for the new sample's own map.
		const records = distinctRecords(created);
		const operationRef = records.find((r) => r.collection === 'manufacturing_operations')!;
		const sampleRef = records.find((r) => r.collection === 'physical_samples')!;
		expect(records, 'one operation and one sample').toHaveLength(2);
		await page.waitForURL(new RegExp(`/map\\?focus=physical_samples:${sampleRef.id}`));

		// What is stored, read back as the Lab Member through Directus's own REST API (their permissions, not the admin's).
		const operation = await readRecord<{
			method_id: string; sample_id: string; output_sample_id: string; work_state: string; owner_person_id: string; done_at: string | null; pass_code: string;
		}>(member, 'manufacturing_operations', operationRef.id, 'method_id,sample_id,output_sample_id,work_state,owner_person_id,done_at,pass_code');
		expect(operation.method_id, 'the method picked in the menu').toBe(seeds.turning.id);
		expect(operation.sample_id, 'its input sample').toBe(seeds.raw1.id);
		expect(operation.output_sample_id, 'its output sample').toBe(sampleRef.id);
		expect(operation.work_state, 'a new operation is planned').toBe('planned');
		expect(operation.done_at, 'planned work has no done date').toBeNull();
		expect(operation.owner_person_id, 'owned by the Lab Member who built it (d1-owner-default)').toBe(seeds.memberPersonId);
		expect(operation.pass_code, 'the database composed a code').toBeTruthy();

		const sample = await readRecord<{ current_status: string; owner_person_id: string; sample_code: string }>(
			member, 'physical_samples', sampleRef.id, 'current_status,owner_person_id,sample_code',
		);
		expect(sample.current_status, 'the output sample of a planned operation is planned').toBe('planned');
		expect(sample.owner_person_id, 'the new sample is the member\'s too').toBe(seeds.memberPersonId);
		expect(sample.sample_code).toBeTruthy();

		// Nothing else was touched: the input sample is the one the seed made.
		const input = await readRecord<{ current_status: string }>(member, 'physical_samples', seeds.raw1.id, 'current_status');
		expect(input.current_status).toBe('active');
	});

	test('the Create toast counts the records it created (spec §3 item 1)', async ({ page }) => {
		// Spec §3 item 1: the toast counts map KEYS, not records. This Create makes 2 records (an operation and a sample) under 3
		// keys (the operation is under its item key and its row key), and the toast says "Created 3 records".
		await buildTurningWithNewSample(page);
		const { status, body } = await pressCreate(page);
		expect(status, JSON.stringify(body)).toBe(200);
		expect(distinctRecords(body.data!.created)).toHaveLength(2);
		await expect(page.locator('.pm-toast strong')).toHaveText('Created 2 records');
	});

	test('Create is disabled while the draft only holds picked existing samples (spec §3 item 3)', async ({ page }) => {
		// Spec §3 item 3: an empty draft is disabled, and so is one that only holds a picked sample (fixed in slice 1: it used to be enabled and do nothing).
		await openNewDraft(page);
		await expect(createButton(page)).toBeDisabled();
		await pickSample(page, seeds.raw2.code);
		await expect(createButton(page)).toHaveText('Add an operation, test or new sample to create');
		await expect(createButton(page)).toBeDisabled();
	});

	test('a draft card has no Open record, Process map of, or Expand (spec §3 item 2)', async ({ page }) => {
		// Spec §3 item 2: a `draft:` id is not a record, yet the rail offers "Open record", "Process map of New sample" and
		// "Expand" for it, and the card shows its ＋ Expand button.
		await openNewDraft(page);
		await page.getByRole('button', { name: /^Add\b/ }).first().click();
		await page.locator('.pm-addsearch').getByRole('option', { name: /^Sample\b/ }).click();
		const card = page.getByRole('group', { name: 'New sample, Sample' });
		await card.focus();
		await card.press('Enter');
		await expect(page.getByText('New sample: key settings')).toBeVisible();
		await expect(page.getByRole('button', { name: 'Open record' }).or(page.getByRole('link', { name: 'Open record' }))).toHaveCount(0);
		await expect(page.getByRole('button', { name: /^Process map of/ }).or(page.getByRole('link', { name: /^Process map of/ }))).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Expand' })).toHaveCount(0);
	});

	test('a new sample no operation makes can be Created (spec §3 item 4)', async ({ page }) => {
		// Spec §3 item 4: `current_status` is required in Directus's field metadata but never drawn on the form, so a new sample
		// that no operation makes is stuck on "Fill in Status: a new sample needs it." and Create stays at "1 to fill in".
		await openNewDraft(page);
		await page.getByRole('button', { name: /^Add\b/ }).first().click();
		await page.locator('.pm-addsearch').getByRole('option', { name: /^Sample\b/ }).click();
		const card = page.getByRole('group', { name: 'New sample, Sample' });
		await card.focus();
		await card.press('Enter');
		// Everything the form draws: material, geometry and the manufacturing method (the three parts of the sample's code).
		// The card draws the same fields, so they are scoped to the rail form (`.pm-item`): unscoped each matches twice (strict mode).
		const rail = page.locator('.pm-item').first(); // the "key settings" section; "all fields" below it repeats them, collapsed
		await rail.getByPlaceholder(/Search materials/).fill('Ti-6Al');
		await rail.getByRole('option', { name: /Ti-6Al-4V Grade 5/ }).click();
		await rail.getByLabel(/^Geometry/).selectOption({ label: 'Cylinder' });
		await rail.getByPlaceholder(/Search manufacturing methods/).fill('Turning');
		await rail.getByRole('option', { name: /CNC Turning/ }).click();
		await expect(page.getByText('Fill in Status: a new sample needs it.')).toHaveCount(0);
		await expect(createButton(page)).toHaveText('Create 1 sample');
		await expect(createButton(page)).toBeEnabled();
		const { status, body } = await pressCreate(page);
		expect(status, JSON.stringify(body)).toBe(200);
		const [sampleRef] = distinctRecords(body.data!.created);
		const sample = await readRecord<{ current_status: string; owner_person_id: string }>(member, 'physical_samples', sampleRef.id, 'current_status,owner_person_id');
		expect(sample.current_status, 'active: no planned operation makes it (R9)').toBe('active');
		expect(sample.owner_person_id).toBe(seeds.memberPersonId);
	});
});

// ---- a Lab Viewer (R11) -------------------------------------------------------------------------------------------------------

test.describe('as a Lab Viewer', () => {
	const draftBody = { v: 1, items: [], wires: [], positions: {}, projectId: null, campaignId: null };
	// R11's server half (slice 1a, `d1-build` answers 403 to an account that may not create operations) is a separate change from this
	// harness. Without it GET /d1-build/drafts answers 200 to a Lab Viewer and POST /d1-build/drafts 201, and the viewer is let all the way
	// to Create, where Directus refuses the write with 403 WRITE_FAILED ("You are not allowed to write that record."). Probed once here,
	// so the suite is green on a checkout with or without it: the two server tests below are a known failure (and say so) until it lands.
	let serverRefusesViewers = false;
	test.beforeAll(async () => {
		if (!stackAvailable()) return;
		serverRefusesViewers =(await getRetrying(viewer, `${D1}/d1-build/drafts`)).status() === 403;
	});

	test('d1-build refuses an account that may not create operations, with a 403 (R11)', async () => {
		known(serverRefusesViewers ? '' : 'R11 server half (slice 1a): d1-build still answers 200/201 to a Lab Viewer', serverRefusesViewers);
		const list = await getRetrying(viewer, `${D1}/d1-build/drafts`);
		expect(list.status(), 'GET /d1-build/drafts as a Lab Viewer').toBe(403);
		expect((await list.json()).errors[0].extensions.code).toBe('FORBIDDEN');
		const post = await viewer.post(`${D1}/d1-build/drafts`, { data: { body: draftBody } });
		expect(post.status(), 'POST /d1-build/drafts as a Lab Viewer').toBe(403);
	});

	test('the page tells a Lab Viewer who opens edit mode that they may not build, and nothing is written (R11)', async ({ page }) => {
		known(serverRefusesViewers ? '' : 'R11 server half (slice 1a): without the 403 the page builds a draft for a Lab Viewer', serverRefusesViewers);
		const count = async () => (await listRecords<{ count: { operation_id: string } }>(admin, 'manufacturing_operations', 'aggregate[count]=operation_id'))[0].count.operation_id;
		const before = await count();
		await signIn(page, 'viewer');
		await page.goto(`${STAR}/map?edit=new`, { waitUntil: 'domcontentloaded' });
		await expect(page.getByText('Your account may not build processes.')).toBeVisible();
		await expect(page).not.toHaveURL(DRAFT_URL);
		expect(await count(), 'nothing was written').toBe(before);
	});

	test('the page hides edit mode for an account that may not build (R11)', async ({ page }) => {
		// R11: "the page hides edit mode for it" (`useMyDrafts` hides it on the 403). Today the page only says so after the click: the
		// sidebar still offers "Build a process" to a Lab Viewer.
		known('R11 page half: STARbase still offers Build a process to a Lab Viewer');
		await signIn(page, 'viewer');
		await page.goto(`${STAR}/map`, { waitUntil: 'domcontentloaded' });
		await expect(page.getByRole('link', { name: 'Process map' }).first()).toBeVisible();
		await expect(page.getByRole('link', { name: 'Build a process' })).toHaveCount(0);
	});

	test('without the server half, a Lab Viewer\'s Create reaches d1-build and Directus refuses the write; nothing is written (current state)', async ({ page }) => {
		test.skip(serverRefusesViewers, 'slice 1a is in: d1-build refuses the viewer before Create (the tests above)');
		const count = async () => (await listRecords<{ count: { operation_id: string } }>(admin, 'manufacturing_operations', 'aggregate[count]=operation_id'))[0].count.operation_id;
		const before = await count();
		await signIn(page, 'viewer');
		await buildTurningWithNewSample(page);
		const { status, body } = await pressCreate(page);
		expect(status).toBe(403);
		expect(body.errors?.[0]?.extensions.code).toBe('WRITE_FAILED');
		await expect(page.locator('.pm-create .err')).toHaveText('You are not allowed to write that record.');
		expect(Object.keys(body.data?.created ?? {})).toHaveLength(0);
		expect(await count(), 'the refused Create wrote nothing').toBe(before);
	});
});
