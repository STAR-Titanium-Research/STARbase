import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { D1, STAR, apiAs, listRecords, readRecord, signIn, stackAvailable } from '../starbase/localStack';
import {
	DRAFT_URL, addFromLid, boxOf, buildTurningWithNewSample, canvasOf, card, cards, chooseFromSocketMenu, createButton, distinctRecords, draftIdOf, openNewDraft, pickSamples, pressCreate,
	readDraft, rowSock, sampleIdOf, savedDraft, selectCard, sockOf,
	type Ref,
} from '../starbase/mapEdit';

/**
 * Slice 2b of the process map edit mode redesign (R9 the Planned / Done toggle at Create, R12 the project / campaign chooser, and plain fixes
 * 9 to 12) in a REAL browser against the LOCAL STACK, as the seeded Lab Member. The plan: docs/superpowers/plans/2026-10-18-process-map-edit-redesign.md;
 * the rules: docs/superpowers/specs/2026-10-18-process-map-edit-mode-redesign.md. Run it with the other edit-mode specs:
 *
 *   bash scripts/dev/local-stack.sh up
 *   cd tests/ui && npx playwright test -c playwright.local-stack.config.ts
 *
 * Everything a test makes is removed afterwards through the admin API (a done operation or test is sent back to planned first, which an admin
 * may do), and the drafts the member leaves behind are deleted, so the suite can run again on the same stack. There are no sleeps: waits are for
 * something on the page or for what the server holds (`savedDraft` polls the saved draft).
 */

let admin: APIRequestContext;
let member: APIRequestContext;
/** The Lab Member's People row: who a record written done at Create says did it. */
let memberPerson: string;
const made: Ref[] = [];
const noteMade = (r: Ref): void => void (made.some((m) => m.id === r.id) || made.push(r));

test.beforeAll(async ({ playwright }) => {
	test.skip(!stackAvailable(), 'the local stack is not up: run `bash scripts/dev/local-stack.sh up`');
	admin = await apiAs(playwright, 'admin');
	member = await apiAs(playwright, 'member');
	const me = await (await member.get(`${D1}/users/me?fields=id`)).json();
	memberPerson = (await listRecords<{ person_id: string }>(admin, 'people', `filter[user_id][_eq]=${me.data.id}&fields=person_id`))[0].person_id;
});

async function deleteDrafts(api: APIRequestContext): Promise<void> {
	const r = await api.get(`${D1}/d1-build/drafts`);
	if (!r.ok()) return;
	for (const d of (await r.json()).data as { id: string }[]) await api.delete(`${D1}/d1-build/drafts/${d.id}`);
}

test.afterEach(async () => {
	if (!stackAvailable() || !admin) return;
	await deleteDrafts(member);
	for (const collection of ['manufacturing_operations', 'test_sessions', 'physical_samples']) {
		for (const ref of made.filter((m) => m.collection === collection)) {
			if (collection !== 'physical_samples') await admin.post(`${D1}/d1-build/mark-planned`, { data: { collection, ids: [ref.id] } });
			const r = await admin.delete(`${D1}/items/${collection}/${ref.id}`);
			if (!r.ok() && r.status() !== 404) console.warn(`clean-up: DELETE ${collection}/${ref.id} answered ${r.status()}: ${await r.text()}`);
		}
	}
	made.length = 0;
});

// ---- what the specs do on the page --------------------------------------------------------------------------------------------

const toggle = (page: Page, what: 'operation' | 'test' = 'operation'): Locator => page.getByRole('radiogroup', { name: `This ${what} is` });
const radio = (page: Page, state: 'Planned' | 'Done', what: 'operation' | 'test' = 'operation'): Locator => toggle(page, what).getByRole('radio', { name: state, exact: true });
const setWork = async (page: Page, state: 'Planned' | 'Done', what: 'operation' | 'test' = 'operation'): Promise<void> => {
	await radio(page, state, what).click();
	await expect(radio(page, state, what)).toHaveAttribute('aria-checked', 'true');
};
const checks = (page: Page): Locator => page.locator('.pm-checks');
const field = (page: Page, name: string): Locator => page.locator(`[data-field="${name}"]`).locator('input, select, textarea').first();
const lid = (page: Page): Locator => page.getByRole('toolbar', { name: 'Edit mode' });
const undoButton = (page: Page): Locator => lid(page).getByRole('button', { name: 'Undo', exact: true });
const redoButton = (page: Page): Locator => lid(page).getByRole('button', { name: 'Redo', exact: true });
const chipOf = (c: Locator): Locator => c.locator('button[data-work]');
const projectSelect = (page: Page): Locator => page.getByRole('combobox', { name: 'Project', exact: true });
const campaignSelect = (page: Page): Locator => page.getByRole('combobox', { name: 'Campaign', exact: true });
const optionTexts = async (sel: Locator): Promise<string[]> => (await sel.locator('option').allInnerTexts()).map((t) => t.trim());
/** The border style of the drawn card: dashed is ghosted (planned), solid is done. */
const borderOf = (c: Locator): Promise<string> => c.locator('.node').first().evaluate((el) => getComputedStyle(el).borderTopStyle);
const draftIds = async (): Promise<string[]> => ((await (await member.get(`${D1}/d1-build/drafts`)).json()).data as { id: string }[]).map((d) => d.id);
const panelButton = (page: Page, name: string): Locator => page.locator('.pm-panel').getByRole('button', { name, exact: true });

/** The server's own answer to "what blocks Create" for a saved draft (it reads the draft as the page saved it). */
async function serverChecks(api: APIRequestContext, id: string): Promise<{ key: string; level: string; field?: string; code?: string; text: string }[]> {
	const r = await api.post(`${D1}/d1-build/drafts/${id}/check`, { data: {} });
	expect(r.ok(), `POST check: ${r.status()} ${await r.text()}`).toBeTruthy();
	return (await r.json()).data.checks;
}

test.describe('as a Lab Member', () => {
	test.beforeEach(async ({ page }) => {
		await signIn(page, 'member');
	});

	// ---- R9: planned or done at Create -----------------------------------------------------------------------------------------------
	test('a new operation has a Planned / Done toggle (default Planned): Done asks for its date, the card turns solid, and Create writes it done with its output active, who and when (R9)', async ({ page }) => {
		const { sampleId } = await buildTurningWithNewSample(page, member, 'LOCAL-RAW-1');
		const operation = card(page, 'CNC Turning, Operation');
		await selectCard(page, operation);
		// Default Planned: no date it happened, the card is ghosted (dashed) and its chip says Planned.
		await expect(radio(page, 'Planned')).toHaveAttribute('aria-checked', 'true');
		await expect(page.locator('[data-field="operation_date"]')).toHaveCount(0);
		await expect(chipOf(operation)).toHaveText('Planned');
		expect(await borderOf(operation)).toBe('dashed');

		await setWork(page, 'Done');
		const date = field(page, 'operation_date');
		await expect(date, 'Done asks for the date it happened').toBeVisible();
		await expect(date, 'default today').toHaveValue(new RegExp(`^${new Date().getFullYear()}-`));
		await expect(chipOf(operation)).toHaveText('Done');
		expect(await borderOf(operation)).toBe('solid');
		await date.fill('2026-10-12T09:30');
		const body = await savedDraft(page, member, (b) => b.items.some((i) => i.kind === 'operation' && i.workState === 'done' && String(i.values.operation_date ?? '').startsWith('2026-10-12')), 'the operation saved as done with the date');
		expect(body.items.find((i) => i.kind === 'operation')!.values.operation_date).toMatch(/^2026-10-12T/);
		await expect(createButton(page)).toBeEnabled();

		const { status, body: answer } = await pressCreate(page, noteMade);
		expect(status, JSON.stringify(answer)).toBe(200);
		const records = distinctRecords(answer.data!.created);
		const operationRef = records.find((r) => r.collection === 'manufacturing_operations')!;
		const sampleRef = records.find((r) => r.collection === 'physical_samples')!;
		const op = await readRecord<{ work_state: string; operation_date: string; done_by_person_id: string; done_at: string; sample_id: string; output_sample_id: string }>(
			member, 'manufacturing_operations', operationRef.id, 'work_state,operation_date,done_by_person_id,done_at,sample_id,output_sample_id',
		);
		expect(op.work_state).toBe('done');
		expect(op.operation_date).toMatch(/^2026-10-12T/);
		expect(op.done_by_person_id, 'who: the caller\'s researcher row').toBe(memberPerson);
		expect(op.done_at, 'when').toBeTruthy();
		expect(op.sample_id).toBe(sampleId);
		expect(op.output_sample_id).toBe(sampleRef.id);
		expect((await readRecord<{ current_status: string }>(member, 'physical_samples', sampleRef.id, 'current_status')).current_status, 'a done operation makes its output active').toBe('active');
	});

	test('the planned and the done mix in one draft: a done operation and a planned test each come out as they were set (R9)', async ({ page }) => {
		const rawId = await sampleIdOf(admin, 'LOCAL-RAW-1');
		await openNewDraft(page);
		await pickSamples(page, ['LOCAL-RAW-1']);
		await chooseFromSocketMenu(page, sockOf(page, `sample|${rawId}|out`).first(), /CNC Turning/);
		await chooseFromSocketMenu(page, rowSock(page, 'out').first(), /^New sample/);
		await chooseFromSocketMenu(page, sockOf(page, `sample|${rawId}|out`).first(), /Tensile/i);
		await expect(createButton(page)).toHaveText('Create 1 operation, 1 test, 1 sample');
		await selectCard(page, card(page, 'CNC Turning, Operation'));
		await setWork(page, 'Done');
		await field(page, 'operation_date').fill('2026-10-12T09:30');
		await savedDraft(page, member, (b) => b.items.some((i) => i.kind === 'operation' && i.workState === 'done') && b.items.some((i) => i.kind === 'test' && i.workState === 'planned'), 'one done operation and one planned test');
		await expect(createButton(page)).toBeEnabled();
		const { status, body } = await pressCreate(page, noteMade);
		expect(status, JSON.stringify(body)).toBe(200);
		const records = distinctRecords(body.data!.created);
		const op = await readRecord<{ work_state: string; done_at: string | null }>(member, 'manufacturing_operations', records.find((r) => r.collection === 'manufacturing_operations')!.id, 'work_state,done_at');
		const t = await readRecord<{ work_state: string; session_date: string | null; done_by_person_id: string | null; done_at: string | null }>(
			member, 'test_sessions', records.find((r) => r.collection === 'test_sessions')!.id, 'work_state,session_date,done_by_person_id,done_at',
		);
		expect([op.work_state, !!op.done_at]).toEqual(['done', true]);
		expect(t, 'a planned test has no date, nobody who did it and no done time').toEqual({ work_state: 'planned', session_date: null, done_by_person_id: null, done_at: null });
	});

	test('a new test made Done shows the required-for-done fields as Checks exactly as the server asks for them, and Create writes it done (R9, client and server agree)', async ({ page }) => {
		const rawId = await sampleIdOf(admin, 'LOCAL-RAW-2');
		await openNewDraft(page);
		await pickSamples(page, ['LOCAL-RAW-2']);
		await chooseFromSocketMenu(page, sockOf(page, `sample|${rawId}|out`).first(), /Tensile/i);
		const test_ = cards(page).filter({ hasText: /Tensile/i }).first();
		await selectCard(page, test_);
		await expect(createButton(page)).toBeEnabled();
		await setWork(page, 'Done', 'test');
		await expect(chipOf(test_)).toHaveText('Done');
		// What d1-build says blocks the same saved draft, and what the page's Checks say.
		const id = draftIdOf(page);
		await savedDraft(page, member, (b) => b.items.some((i) => i.kind === 'test' && i.workState === 'done'), 'the test saved as done');
		const server = (await serverChecks(member, id)).filter((c) => c.level === 'block');
		const serverFields = server.map((c) => c.field as string).sort();
		expect(serverFields.length, 'a done test is asked for something the planned one is not (the forms mark Status required on a test session)').toBeGreaterThan(0);
		const clientText = (await checks(page).innerText()).toLowerCase();
		for (const f of serverFields) expect(clientText, `the page's Checks ask for ${f} as the server does`).toContain(`fill in ${f.replace(/_/g, ' ')}`);
		expect((clientText.match(/fill in /g) ?? []).length, 'the page asks for neither more nor fewer fields than the server').toBe(serverFields.length);
		await expect(createButton(page)).toBeDisabled();
		await expect(createButton(page)).toContainText(/things? missing/);
		// The same fields sit in the rail's key settings; filling them satisfies the page and the server.
		for (const f of serverFields) {
			const input = field(page, f);
			await expect(input, `${f} is in the key settings`).toBeVisible();
			if ((await input.evaluate((el) => el.tagName)) === 'SELECT') await input.selectOption({ index: 1 });
			else await input.fill('x');
		}
		await expect(createButton(page)).toBeEnabled();
		const { status, body } = await pressCreate(page, noteMade);
		expect(status, JSON.stringify(body)).toBe(200);
		const ref = distinctRecords(body.data!.created).find((r) => r.collection === 'test_sessions')!;
		const t = await readRecord<{ work_state: string; session_date: string; done_by_person_id: string; done_at: string }>(member, 'test_sessions', ref.id, 'work_state,session_date,done_by_person_id,done_at');
		expect(t.work_state).toBe('done');
		expect(t.session_date, 'the date defaulted to today').toMatch(new RegExp(`^${new Date().getFullYear()}-`));
		expect(t.done_by_person_id).toBe(memberPerson);
		expect(t.done_at).toBeTruthy();
	});

	test('a Done operation whose input sample is still planned shows the server\'s reason in Checks, Create is blocked, and the server agrees (R9, SAMPLE_PLANNED)', async ({ page }) => {
		await buildTurningWithNewSample(page, member, 'LOCAL-RAW-1');
		// A second operation on the new sample, which the first one makes: it is planned until that one is done.
		await selectCard(page, card(page, 'New sample, Sample'));
		await chooseFromSocketMenu(page, page.locator('.free[data-sock^="sample|draft:"][data-sock$="|out"]').first(), /CNC Turning/);
		await expect(createButton(page)).toHaveText('Create 2 operations, 1 sample');
		await selectCard(page, cards(page).filter({ hasText: 'CNC Turning' }).last());
		await setWork(page, 'Done');
		const REASON = 'Its sample is still planned; mark the operation that makes it done first.';
		await expect(checks(page)).toContainText(REASON);
		await expect(createButton(page)).toBeDisabled();
		await expect(createButton(page)).toContainText(/thing/);
		const id = draftIdOf(page);
		await savedDraft(page, member, (b) => b.items.filter((i) => i.kind === 'operation' && i.workState === 'done').length === 1, 'the second operation saved as done');
		expect((await serverChecks(member, id)).filter((c) => c.level === 'block').map((c) => c.text), 'd1-build gives the same reason').toContain(REASON);
		// One undo of the toggle lifts it.
		await undoButton(page).click();
		await expect(checks(page)).not.toContainText(REASON);
		await expect(createButton(page)).toBeEnabled();
	});

	test('the toggle is one undo step, from the rail and from the card\'s chip, and Redo does it again (R9)', async ({ page }) => {
		await buildTurningWithNewSample(page, member, 'LOCAL-RAW-1');
		const operation = card(page, 'CNC Turning, Operation');
		await selectCard(page, operation);
		// from the rail
		await setWork(page, 'Done');
		await savedDraft(page, member, (b) => b.items.some((i) => i.kind === 'operation' && i.workState === 'done' && !!i.values.operation_date), 'done, with a date');
		await undoButton(page).click();
		await expect(radio(page, 'Planned')).toHaveAttribute('aria-checked', 'true');
		await expect(page.locator('[data-field="operation_date"]')).toHaveCount(0);
		await savedDraft(page, member, (b) => b.items.some((i) => i.kind === 'operation' && i.workState === 'planned' && !('operation_date' in i.values)), 'one undo put the state and the date back');
		await redoButton(page).click();
		await expect(radio(page, 'Done')).toHaveAttribute('aria-checked', 'true');
		await expect(field(page, 'operation_date')).toBeVisible();
		await undoButton(page).click();
		await expect(radio(page, 'Planned')).toHaveAttribute('aria-checked', 'true');
		// from the chip
		await chipOf(operation).click();
		await expect(chipOf(operation)).toHaveText('Done');
		await expect(radio(page, 'Done')).toHaveAttribute('aria-checked', 'true');
		await savedDraft(page, member, (b) => b.items.some((i) => i.kind === 'operation' && i.workState === 'done'), 'the chip made it done');
		await undoButton(page).click();
		await expect(chipOf(operation)).toHaveText('Planned');
		await savedDraft(page, member, (b) => b.items.every((i) => i.kind !== 'operation' || i.workState === 'planned'), 'one undo made it planned again');
	});

	// ---- R12: project and campaign in the top bar ------------------------------------------------------------------------------------
	test('the top bar\'s project is pre-filled from the first sample, its campaign list is limited to it, changing the project clears a campaign that is not in it, and all of it is saved in the draft (R12)', async ({ page }) => {
		const [projA] = await listRecords<{ project_id: string }>(admin, 'projects', 'filter[project_code][_eq]=LOCAL-PROJ&fields=project_id');
		const [projB] = await listRecords<{ project_id: string }>(admin, 'projects', 'filter[project_code][_eq]=LOCAL-PROJ-B&fields=project_id');
		const [campA] = await listRecords<{ campaign_id: string }>(admin, 'campaigns', 'filter[campaign_code][_eq]=LOCAL-CAMP-A&fields=campaign_id');
		expect(projA && projB && campA, 'the seed has two projects and a campaign in the first (scripts/dev/local-stack.seed.sql)').toBeTruthy();
		await openNewDraft(page);
		await expect(projectSelect(page)).toHaveValue('');
		await pickSamples(page, ['LOCAL-RAW-1']);
		// Pre-filled from the first sample (the existing behaviour).
		await expect(projectSelect(page)).toHaveValue(projA.project_id);
		const first = await savedDraft(page, member, (b) => b.projectId === projA.project_id, 'the draft took the sample\'s project');
		expect(first.campaignId).toBeNull();
		// Only the campaigns of that project.
		const offered = await optionTexts(campaignSelect(page));
		expect(offered[0]).toBe('None');
		expect(offered.some((t) => t.startsWith('LOCAL-CAMP-A'))).toBe(true);
		expect(offered.some((t) => t.startsWith('LOCAL-CAMP-B')), 'the other project\'s campaign is not offered').toBe(false);
		await campaignSelect(page).selectOption(campA.campaign_id);
		await savedDraft(page, member, (b) => b.campaignId === campA.campaign_id, 'the campaign saved in the draft');
		// Changing the project clears the campaign that does not belong to it, in one step.
		await projectSelect(page).selectOption(projB.project_id);
		await expect(campaignSelect(page)).toHaveValue('');
		await savedDraft(page, member, (b) => b.projectId === projB.project_id && b.campaignId === null, 'project B and no campaign saved');
		const offeredB = await optionTexts(campaignSelect(page));
		expect(offeredB.some((t) => t.startsWith('LOCAL-CAMP-B'))).toBe(true);
		expect(offeredB.some((t) => t.startsWith('LOCAL-CAMP-A'))).toBe(false);
		await undoButton(page).click();
		await expect(projectSelect(page)).toHaveValue(projA.project_id);
		await expect(campaignSelect(page)).toHaveValue(campA.campaign_id);
		await savedDraft(page, member, (b) => b.projectId === projA.project_id && b.campaignId === campA.campaign_id, 'one undo put the project and the campaign back');
		// A reload shows the same choice.
		await page.reload({ waitUntil: 'domcontentloaded' });
		await expect(projectSelect(page)).toHaveValue(projA.project_id);
		await expect(campaignSelect(page)).toHaveValue(campA.campaign_id);
		// With no project, every campaign is offered and choosing one brings its project.
		await projectSelect(page).selectOption('');
		await expect(campaignSelect(page)).toHaveValue('');
		const all = await optionTexts(campaignSelect(page));
		await campaignSelect(page).selectOption({ label: all.find((t) => t.startsWith('LOCAL-CAMP-B'))! });
		await expect(projectSelect(page)).toHaveValue(projB.project_id);
	});

	test('the chosen project and campaign are applied to every new record at Create (R12)', async ({ page }) => {
		const [projB] = await listRecords<{ project_id: string }>(admin, 'projects', 'filter[project_code][_eq]=LOCAL-PROJ-B&fields=project_id');
		const [campB] = await listRecords<{ campaign_id: string }>(admin, 'campaigns', 'filter[campaign_code][_eq]=LOCAL-CAMP-B&fields=campaign_id');
		const rawId = await sampleIdOf(admin, 'LOCAL-RAW-1');
		await openNewDraft(page);
		await pickSamples(page, ['LOCAL-RAW-1']);
		await chooseFromSocketMenu(page, sockOf(page, `sample|${rawId}|out`).first(), /CNC Turning/);
		await chooseFromSocketMenu(page, rowSock(page, 'out').first(), /^New sample/);
		await chooseFromSocketMenu(page, sockOf(page, `sample|${rawId}|out`).first(), /Tensile/i);
		// The sample's own project (LOCAL-PROJ) was taken; the person picks the other one and its campaign.
		await projectSelect(page).selectOption(projB.project_id);
		await campaignSelect(page).selectOption(campB.campaign_id);
		await savedDraft(page, member, (b) => b.projectId === projB.project_id && b.campaignId === campB.campaign_id, 'project B and its campaign saved');
		const { status, body } = await pressCreate(page, noteMade);
		expect(status, JSON.stringify(body)).toBe(200);
		const records = distinctRecords(body.data!.created);
		const op = await readRecord<{ project_id: string; campaign_id: string }>(member, 'manufacturing_operations', records.find((r) => r.collection === 'manufacturing_operations')!.id, 'project_id,campaign_id');
		const t = await readRecord<{ project_id: string; campaign_id: string }>(member, 'test_sessions', records.find((r) => r.collection === 'test_sessions')!.id, 'project_id,campaign_id');
		const sample = records.find((r) => r.collection === 'physical_samples')!;
		const s = await readRecord<{ project_id: string }>(member, 'physical_samples', sample.id, 'project_id');
		expect([op.project_id, op.campaign_id]).toEqual([projB.project_id, campB.campaign_id]);
		expect([t.project_id, t.campaign_id]).toEqual([projB.project_id, campB.campaign_id]);
		expect(s.project_id).toBe(projB.project_id);
		const joined = await listRecords<{ campaign_id: string }>(admin, 'campaign_samples', `filter[sample_id][_eq]=${sample.id}&fields=campaign_id`);
		expect(joined.map((m) => m.campaign_id), 'the new sample is in the campaign').toEqual([campB.campaign_id]);
	});

	// ---- plain fixes 9 to 12 ------------------------------------------------------------------------------------------------------
	test('a newly started draft is in My drafts at once, even when the list cannot be read again (fix 9)', async ({ page }) => {
		// The page reads the list of drafts when it opens; from then on the server does not answer it, so the entry can only be the page's own.
		const listed = page.waitForResponse((r) => /\/d1-build\/drafts$/.test(r.url()) && r.request().method() === 'GET');
		await page.goto(`${STAR}/map`, { waitUntil: 'domcontentloaded' });
		const link = page.getByRole('link', { name: 'Build a process' });
		await expect(link).toBeVisible();
		await listed;
		await page.route(/\/d1-build\/drafts$/, (route) => (route.request().method() === 'GET' ? route.abort() : route.fallback()));
		await link.click();
		await page.waitForURL(DRAFT_URL);
		await expect(page.getByRole('button', { name: /Pick samples/ })).toBeVisible();
		await page.getByRole('button', { name: /^My drafts/ }).click();
		const items = page.getByRole('menuitem');
		await expect(items).toHaveCount(1);
		await expect(items.first()).toHaveAttribute('aria-current', 'true');
		await expect(items.first()).toContainText('New process');
	});

	test('Build a process while an empty draft is open reuses it: one draft on the server, the same address; one with something in it keeps its draft and starts another (fix 9)', async ({ page }) => {
		const id = await openNewDraft(page);
		expect(await draftIds()).toEqual([id]);
		for (let i = 0; i < 2; i++) {
			await page.getByRole('link', { name: 'Build a process' }).click();
			await expect(page.getByRole('button', { name: /Pick samples/ })).toBeVisible();
			expect(draftIdOf(page), 'the empty draft is still the open one').toBe(id);
		}
		expect(await draftIds(), 'no second draft was left on the server').toEqual([id]);
		await pickSamples(page, ['LOCAL-RAW-1']);
		await savedDraft(page, member, (b) => b.items.length === 1, 'a sample picked');
		await page.getByRole('link', { name: 'Build a process' }).click();
		await expect.poll(async () => (await draftIds()).length, { message: 'a second draft' }).toBe(2);
		await expect.poll(() => DRAFT_URL.exec(page.url())?.[1] ?? id, { message: 'the page opened the new draft' }).not.toBe(id);
		expect((await readDraft(member, id)).items, 'the first draft is kept as it was').toHaveLength(1);
	});

	test('undo does not merge edits to different fields of one card: speed, feed, speed again are three steps, and typing in one field is one (fix 10)', async ({ page }) => {
		await buildTurningWithNewSample(page, member, 'LOCAL-RAW-1');
		await selectCard(page, card(page, 'CNC Turning, Operation'));
		const speed = field(page, 'machining_cutting_speed_m_per_min');
		const feed = field(page, 'machining_feed_mm_per_rev');
		const values = async (): Promise<[unknown, unknown]> => {
			const op = (await readDraft(member, draftIdOf(page))).items.find((i) => i.kind === 'operation')!;
			return [op.values.machining_cutting_speed_m_per_min, op.values.machining_feed_mm_per_rev];
		};
		const saved = async (want: [unknown, unknown], what: string) => {
			await expect.poll(values, { message: what, timeout: 15_000 }).toEqual(want);
		};
		// Three edits within the merge window (1.5 s): different fields are different steps.
		await speed.fill('100');
		await feed.fill('0.2');
		await speed.fill('120');
		await saved([120, 0.2], 'all three edits saved');
		await undoButton(page).click();
		await expect(speed).toHaveValue('100');
		await expect(feed).toHaveValue('0.2');
		await saved([100, 0.2], 'one undo took back the last speed only');
		await undoButton(page).click();
		await expect(feed).toHaveValue('');
		await expect(speed).toHaveValue('100');
		await saved([100, undefined], 'the second undo took back the feed');
		await undoButton(page).click();
		await expect(speed).toHaveValue('');
		await saved([undefined, undefined], 'the third undo took back the first speed');
		// Typing in one field is still one step.
		await feed.pressSequentially('0.25');
		await saved([undefined, 0.25], 'typed');
		await undoButton(page).click();
		await expect(feed).toHaveValue('');
		await saved([undefined, undefined], 'one undo took back everything typed in the field');
	});

	test('a blank canvas says what to do first and hides Find, Reset and Clear while the draft is empty; they come back with the first sample (fix 11)', async ({ page }) => {
		await openNewDraft(page);
		await expect(page.getByText('Nothing here yet')).toBeVisible();
		await expect(page.getByText(/Pick samples, or press Shift\+A to add an operation or test/)).toBeVisible();
		// In the middle of the canvas (the page's own `.pm-empty` style once pulled it to the left: a class name two components shared).
		const [hint, canvas] = [await boxOf(page.locator('.pm-canvas').getByRole('status').filter({ hasText: 'Nothing here yet' })), await boxOf(canvasOf(page))];
		expect(Math.abs(hint.x + hint.width / 2 - (canvas.x + canvas.width / 2)), 'the hint is centred on the canvas').toBeLessThan(60);
		for (const name of ['Find a record', 'Reset', 'Clear']) await expect(panelButton(page, name), `${name} is hidden while the draft is empty`).toHaveCount(0);
		await expect(panelButton(page, 'Fit')).toBeVisible();
		await expect(panelButton(page, 'Re-layout')).toBeVisible();
		await pickSamples(page, ['LOCAL-RAW-1']);
		await expect(page.getByText('Nothing here yet')).toHaveCount(0);
		for (const name of ['Find a record', 'Reset', 'Clear']) await expect(panelButton(page, name), `${name} is back`).toBeVisible();
		// Taking the sample off again brings the hint back.
		await selectCard(page, card(page, /^LOCAL-RAW-1, Sample/));
		await page.keyboard.press('Delete');
		await expect(page.getByText('Nothing here yet')).toBeVisible();
		await expect(panelButton(page, 'Reset')).toHaveCount(0);
	});

	test('"Open in Data Studio" on a new item\'s field says it opens after Create instead of raising a banner; a record that exists keeps the link (fix 12)', async ({ page }) => {
		await openNewDraft(page);
		await addFromLid(page, /^New sample/);
		await selectCard(page, card(page, 'New sample, Sample'));
		await page.getByRole('heading', { name: 'New sample: all fields' }).click();
		const rail = page.locator('section.pm-item').filter({ hasText: 'New sample: all fields' });
		const later = rail.getByText('Opens in Data Studio after Create');
		await expect(later.first(), 'a field the form cannot draw says when it opens').toBeVisible();
		await expect(rail.getByRole('button', { name: 'Open in Data Studio' }), 'a new item has no record to open: no button').toHaveCount(0);
		await later.first().click();
		await expect(page.locator('[role="alert"]'), 'nothing is raised').toHaveCount(0);
		// A record that exists still has the link.
		await openNewDraft(page);
		await pickSamples(page, ['LOCAL-RAW-1']);
		await selectCard(page, card(page, /^LOCAL-RAW-1, Sample/));
		await page.getByRole('heading', { name: /Sample: all fields/ }).click();
		await expect(page.locator('section.pm-item').getByRole('button', { name: 'Open in Data Studio' }).first()).toBeVisible();
	});
});
