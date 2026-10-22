import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { D1, STAR, apiAs, getRetrying, listRecords, readRecord, signIn, stackAvailable } from '../starbase/localStack';
import {
	DRAFT_URL, addSearch, canvasOf, cards, createButton, distinctRecords, draftIdOf, openNewDraft, openAddSearch, paletteEntry, paletteKind, pickSamples, pressCreate, readDraft, sampleIdOf, savedDraft, secondMember, selectCard,
	sockOf, startEditingMapOf, clickWire, wireBetween, boxOf, canvasMiddle, dragEntryTo, fit,
	type Ref,
} from '../starbase/mapEdit';

/**
 * Slice 3 of the process map edit mode redesign: attach from the database (R8, as scoped by the maintainer on 2026-10-19), in a REAL browser
 * against the LOCAL STACK. "From database…" lists the recorded operations that have NO input sample (planned or done) and attaches the chosen
 * one to the sample whose output socket the add search was opened on. Create then writes ONE thing: `operation.sample_id` (the genealogy trigger
 * writes the lineage). The plan: docs/superpowers/plans/2026-10-18-process-map-edit-redesign.md.
 *
 *   bash scripts/dev/local-stack.sh up
 *   cd tests/ui && npx playwright test -c playwright.local-stack.config.ts specs/edit-mode-slice3.spec.ts
 *
 * Orphan operations (an operation needs an input or an output sample, so one with no input has made a sample) are made through the REST API as the
 * Lab Member, who owns them; everything a test makes is removed afterwards through the admin API (a done operation is sent back to planned first), and
 * the drafts the member leaves behind are deleted, so the suite can run again on the same stack.
 */

let admin: APIRequestContext;
let member: APIRequestContext;
let memberPerson: string;
const made: Ref[] = [];
const users: { userId: string; personId: string | null }[] = [];
const noteMade = (r: Ref): void => void (made.some((m) => m.id === r.id) || made.push(r));
const noteUser = (u: { userId: string; personId: string | null }): void => void users.push(u);

test.beforeAll(async ({ playwright }) => {
	test.skip(!stackAvailable(), 'the local stack is not up: run `bash scripts/dev/local-stack.sh up`');
	admin = await apiAs(playwright, 'admin');
	member = await apiAs(playwright, 'member');
	const me = await (await getRetrying(member, `${D1}/users/me?fields=id`)).json();
	memberPerson = (await listRecords<{ person_id: string }>(admin, 'people', `filter[user_id][_eq]=${me.data.id}&fields=person_id`))[0].person_id;
});

async function deleteDrafts(api: APIRequestContext): Promise<void> {
	const r = await getRetrying(api, `${D1}/d1-build/drafts`);
	if (!r.ok()) return;
	for (const d of (await r.json()).data as { id: string }[]) await api.delete(`${D1}/d1-build/drafts/${d.id}`);
}

test.afterEach(async () => {
	if (!stackAvailable() || !admin) return;
	await deleteDrafts(member);
	for (const collection of ['manufacturing_operations', 'physical_samples']) {
		for (const ref of made.filter((m) => m.collection === collection)) {
			if (collection === 'manufacturing_operations') await admin.post(`${D1}/d1-build/mark-planned`, { data: { collection, ids: [ref.id] } });
			const r = await admin.delete(`${D1}/items/${collection}/${ref.id}`);
			if (!r.ok() && r.status() !== 404) console.warn(`clean-up: DELETE ${collection}/${ref.id} answered ${r.status()}: ${await r.text()}`);
		}
	}
	made.length = 0;
	for (const u of users.splice(0)) {
		if (u.personId) await admin.delete(`${D1}/items/people/${u.personId}`);
		await admin.delete(`${D1}/users/${u.userId}`);
	}
});

// ---- records made through the API ------------------------------------------------------------------------------------------

interface Orphan { operationId: string; sampleId: string; sampleCode: string }
let counter = 0;
/**
 * An operation with NO input sample (CNC Turning, machining), made by `api`'s account, which owns it, and the sample it made. A planned one
 * makes a planned sample; a done one an active sample and says who did it and when.
 */
async function makeOrphan(state: 'planned' | 'done', api: APIRequestContext = member, person: string = memberPerson, projectId?: string): Promise<Orphan> {
	const [input] = await listRecords<{ material_id: string; project_id: string }>(admin, 'physical_samples', 'filter[sample_code][_eq]=LOCAL-RAW-1&fields=material_id,project_id');
	const [method] = await listRecords<{ method_id: string }>(admin, 'manufacturing_methods', 'filter[method_code][_eq]=MC&fields=method_id');
	const sampleCode = `LOCAL-ORPH-${Date.now().toString(36)}${(counter += 1)}`.toUpperCase();
	const sample = await api.post(`${D1}/items/physical_samples`, {
		data: { sample_code: sampleCode, current_status: state === 'planned' ? 'planned' : 'active', material_id: input.material_id, form: 'cylinder', primary_method_id: method.method_id },
	});
	expect(sample.ok(), `the orphan's output sample: ${await sample.text()}`).toBeTruthy();
	const sampleId = JSON.parse(await sample.text()).data.sample_id as string;
	noteMade({ collection: 'physical_samples', id: sampleId });
	const op = await api.post(`${D1}/items/manufacturing_operations`, {
		data: {
			output_sample_id: sampleId, method_id: method.method_id, work_state: state, process_category: 'machining', ...(projectId ? { project_id: projectId } : {}),
			...(state === 'done' ? { operation_date: '2026-09-01', done_by_person_id: person, done_at: '2026-09-01T10:00:00Z' } : { planned_date: '2026-11-01' }),
		},
	});
	expect(op.ok(), `the orphan operation: ${await op.text()}`).toBeTruthy();
	const operationId = JSON.parse(await op.text()).data.operation_id as string;
	noteMade({ collection: 'manufacturing_operations', id: operationId });
	return { operationId, sampleId, sampleCode };
}

const OP_FIELDS = '*';
type Row = Record<string, unknown>;
const operationRow = (api: APIRequestContext, id: string): Promise<Row> => readRecord<Row>(api, 'manufacturing_operations', id, OP_FIELDS);
const sampleRow = (api: APIRequestContext, id: string): Promise<Row> => readRecord<Row>(api, 'physical_samples', id, OP_FIELDS);
const lineageOf = (api: APIRequestContext, sampleId: string): Promise<Row[]> =>
	listRecords<Row>(api, 'sample_genealogy', `filter[_or][0][child_sample_id][_eq]=${sampleId}&filter[_or][1][parent_sample_id][_eq]=${sampleId}&fields=child_sample_id,parent_sample_id,relationship_type&sort=child_sample_id`);
const sampleCount = async (api: APIRequestContext): Promise<number> => (await listRecords<Row>(api, 'physical_samples', 'aggregate[count]=*'))[0].count as unknown as number;
const changed = (before: Row, after: Row): string[] => [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])).sort();

// ---- what the specs do on the page --------------------------------------------------------------------------------------------

const picker = (page: Page): Locator => page.getByRole('dialog', { name: 'From database' });
const opCard = (page: Page, id: string): Locator => canvasOf(page).locator(`.vue-flow__node[data-id="op:${id}"]`);
const sampleCard = (page: Page, id: string): Locator => canvasOf(page).locator(`.vue-flow__node[data-id="s:${id}"]`);
const option = (page: Page, operationId: string): Locator => picker(page).locator(`[data-operation="${operationId}"]`);
/** The border style of a drawn card: dashed is ghosted (planned), solid is done. */
const borderOf = (c: Locator): Promise<string> => c.locator('.node').first().evaluate((el) => getComputedStyle(el).borderTopStyle);
const checks = (page: Page): Locator => page.locator('.pm-checks');
/** `SLICE3_SHOTS=<dir>` saves a screenshot at the moments a person would look (the report names them). */
const shot = async (page: Page, name: string): Promise<void> => {
	if (process.env.SLICE3_SHOTS) await page.screenshot({ path: `${process.env.SLICE3_SHOTS}/${name}.png` });
};
const rowSockOut = (page: Page): Locator => canvasOf(page).locator('[data-sock^="row|draft:"][data-sock$="|out"]');

/** The card that holds keyboard focus (its data-id), else the focused element's tag. */
const focusedCard = (page: Page): Promise<string> =>
	page.evaluate(() => {
		const el = document.activeElement as HTMLElement | null;
		return el?.closest<HTMLElement>('.vue-flow__node')?.dataset.id ?? `<${el?.tagName.toLowerCase() ?? 'nothing'}>`;
	});

/** Opens the add search on a sample's output socket (the keyboard: Enter on the socket) and chooses From database…. */
async function openFromDatabase(page: Page, sampleId: string): Promise<void> {
	await sockOf(page, `sample|${sampleId}|out`).first().press('Enter');
	await addSearch(page).getByRole('option', { name: /From database/ }).click();
	await expect(picker(page)).toBeVisible();
}
/** Types what the picker searches by (here always the code of the sample the operation made: unique per test) and waits for the row. */
async function find(page: Page, orphan: Orphan): Promise<Locator> {
	await picker(page).getByRole('combobox').fill(orphan.sampleCode);
	// The search narrows to it (the code is unique to the test), so nothing that was listed before the typing is left to be clicked by mistake.
	await expect(picker(page).getByRole('option')).toHaveCount(1);
	await expect(option(page, orphan.operationId)).toBeVisible();
	return option(page, orphan.operationId);
}
/** A draft of one picked seed sample with the orphan attached to its output. */
async function attachTo(page: Page, sampleCode: string, orphan: Orphan): Promise<string> {
	const sampleId = await sampleIdOf(admin, sampleCode);
	await openNewDraft(page);
	await pickSamples(page, [sampleCode]);
	await openFromDatabase(page, sampleId);
	await shot(page, 'picker-listing');
	await (await find(page, orphan)).click();
	await expect(picker(page)).toBeHidden();
	await expect(opCard(page, orphan.operationId)).toBeVisible();
	// The picker is gone and so is the add search it came from: focus is back on the card the person started on, not on the page body.
	await expect.poll(() => focusedCard(page), { message: 'focus after the picker closes' }).toBe(`s:${sampleId}`);
	return sampleId;
}

test.describe('as a Lab Member', () => {
	test.beforeEach(async ({ page }) => {
		await signIn(page, 'member');
	});

	test('a planned orphan operation is attached from the sample\'s output socket: it shows wired and ghosted with the sample it made, and Create writes only sample_id', async ({ page }) => {
		const orphan = await makeOrphan('planned');
		const rawId = await attachTo(page, 'LOCAL-RAW-1', orphan);

		// On the canvas: the sample it made is drawn (no second sample is made), the wire runs from the picked sample into it.
		await expect(sampleCard(page, orphan.sampleId)).toBeVisible();
		await expect(wireBetween(page, `s:${rawId}:out`, `op:${orphan.operationId}:in`)).toHaveCount(1);
		expect(await borderOf(opCard(page, orphan.operationId)), 'planned is ghosted').toBe('dashed');
		await expect(opCard(page, orphan.operationId).locator('.apill')).toHaveText('Attach');
		await expect(createButton(page)).toBeEnabled();
		await expect(createButton(page)).toHaveText('Attach 1 operation');
		await shot(page, 'planned-attached-on-canvas');

		const before = await operationRow(member, orphan.operationId);
		const madeBefore = await sampleRow(member, orphan.sampleId);
		const samples = await sampleCount(admin);
		const draftId = draftIdOf(page);
		const { status, body } = await pressCreate(page, noteMade);
		expect(status, JSON.stringify(body)).toBe(200);
		expect(distinctRecords(body.data!.created), 'an attached operation is not a created record').toEqual([]);

		const after = await operationRow(member, orphan.operationId);
		expect(after.sample_id).toBe(rawId);
		expect(Number(after.version), 'the version moved on').toBe(Number(before.version) + 1);
		// The database renumbers an operation whose sample changes (the code trigger of migration 157): its step number and its code follow the new
		// sample. Those, and the version, are the only other columns that move; the work state, the dates, the method and the owner stay.
		expect(changed(before, after).filter((k) => !['updated_at', 'date_updated'].includes(k)), 'nothing but the input, the version and the code the database derives from it changed').toEqual(
			['code_sort', 'operation_sequence', 'pass_code', 'sample_id', 'version'],
		);
		expect(String(after.pass_code), 'its code now starts with the sample it was given').toContain('LOCAL-RAW-1');
		// (`child_samples` is the alias that lists its genealogy rows: the one the trigger added is what it now shows.)
		expect(changed(madeBefore, await sampleRow(member, orphan.sampleId)), 'the sample it made is untouched').toEqual(['child_samples']);
		expect(await sampleCount(admin), 'no sample was made').toBe(samples);
		expect(await lineageOf(member, orphan.sampleId)).toEqual([{ child_sample_id: orphan.sampleId, parent_sample_id: rawId, relationship_type: 'cut_from' }]);
		expect((await getRetrying(member, `${D1}/d1-build/drafts/${draftId}`)).status(), 'the draft is gone').toBe(404);
	});

	test('a done orphan operation is attached solid, and stays done: Create writes the input and the code the database derives, never the work state or the sample it made', async ({ page }) => {
		const orphan = await makeOrphan('done');
		const rawId = await attachTo(page, 'LOCAL-RAW-2', orphan);
		expect(await borderOf(opCard(page, orphan.operationId)), 'done is solid').toBe('solid');
		await expect(sampleCard(page, orphan.sampleId)).toBeVisible();
		await expect(createButton(page)).toHaveText('Attach 1 operation');

		const before = await operationRow(member, orphan.operationId);
		const madeBefore = await sampleRow(member, orphan.sampleId);
		const { status, body } = await pressCreate(page, noteMade);
		expect(status, JSON.stringify(body)).toBe(200);
		const after = await operationRow(member, orphan.operationId);
		expect(after.sample_id).toBe(rawId);
		expect(after.work_state, 'still done').toBe('done');
		for (const k of ['operation_date', 'done_by_person_id', 'done_at', 'output_sample_id', 'method_id', 'owner_person_id']) expect(after[k], k).toEqual(before[k]);
		expect(Number(after.version)).toBe(Number(before.version) + 1);
		expect((await sampleRow(member, orphan.sampleId)).current_status, 'its sample stays active').toBe(madeBefore.current_status);
		expect(await lineageOf(member, orphan.sampleId)).toEqual([{ child_sample_id: orphan.sampleId, parent_sample_id: rawId, relationship_type: 'cut_from' }]);
	});

	test('the attach is part of the draft: undo and redo take it off and put it back, a removed wire leaves a loose operation Create refuses, and Delete takes it off the canvas without touching the record', async ({ page }) => {
		const orphan = await makeOrphan('planned');
		const rawId = await attachTo(page, 'LOCAL-RAW-1', orphan);
		const saved = await savedDraft(page, member, (b) => b.items.some((i) => i.attach) && b.wires.length === 1, 'the sample and the attached operation, wired');
		expect(saved.items.find((i) => i.kind === 'operation')).toMatchObject({ existing: { id: orphan.operationId }, attach: true, workState: 'planned' });

		// Undo: one step takes the operation off (the sample stays), redo puts it back.
		await page.keyboard.press('Control+z');
		await expect(opCard(page, orphan.operationId)).toHaveCount(0);
		await expect(sampleCard(page, rawId)).toBeVisible();
		await expect(sampleCard(page, orphan.sampleId), 'the sample it made goes with it').toHaveCount(0);
		await page.keyboard.press('Control+Shift+z');
		await expect(opCard(page, orphan.operationId)).toBeVisible();
		await expect(sampleCard(page, orphan.sampleId)).toBeVisible();
		await expect(createButton(page)).toHaveText('Attach 1 operation');

		// The wire is removable: the operation stays on the canvas, attached to nothing, and Create says what is missing.
		await clickWire(page, wireBetween(page, `s:${rawId}:out`, `op:${orphan.operationId}:in`));
		await page.keyboard.press('Delete');
		await expect(wireBetween(page, `s:${rawId}:out`, `op:${orphan.operationId}:in`)).toHaveCount(0);
		await expect(opCard(page, orphan.operationId)).toBeVisible();
		await expect(createButton(page)).toBeDisabled();
		await expect(createButton(page)).toContainText('missing');
		await expect(checks(page)).toContainText('needs a sample');

		// Delete on the loose operation takes it off the draft; the record is not deleted.
		await selectCard(page, opCard(page, orphan.operationId));
		await page.keyboard.press('Delete');
		await expect(opCard(page, orphan.operationId)).toHaveCount(0);
		await savedDraft(page, member, (b) => !b.items.some((i) => i.kind === 'operation'), 'the draft without the operation');
		const row = await operationRow(member, orphan.operationId);
		expect(row.sample_id, 'still has no input').toBeNull();
		expect(row.work_state).toBe('planned');
	});

	test('an operation already on the canvas, or already attached in this draft, is greyed with the reason', async ({ page }) => {
		const onMap = await makeOrphan('planned');
		const other = await makeOrphan('planned');

		// On the canvas: the map is opened on the sample it made, which draws it as the step that made it.
		await startEditingMapOf(page, 'physical_samples', onMap.sampleId);
		await expect(opCard(page, onMap.operationId)).toBeVisible();
		await openFromDatabase(page, onMap.sampleId);
		const dim = await find(page, onMap);
		await expect(dim).toHaveAttribute('aria-disabled', 'true');
		await expect(dim).toContainText('Already on the canvas.');
		await shot(page, 'picker-greyed-on-canvas');
		await dim.click({ force: true });
		await expect(picker(page), 'a greyed row cannot be picked: the picker stays').toBeVisible();
		await page.keyboard.press('Escape');
		await expect(picker(page)).toBeHidden();

		// Attached in this draft: the second time it is greyed, the other one is not.
		await page.goto(`${STAR}/map`, { waitUntil: 'domcontentloaded' });
		const rawId = await attachTo(page, 'LOCAL-RAW-1', other);
		await openFromDatabase(page, rawId);
		await picker(page).getByRole('combobox').fill(other.sampleCode);
		await expect(picker(page).getByRole('option')).toHaveCount(1);
		await expect(option(page, other.operationId)).toHaveAttribute('aria-disabled', 'true');
		await expect(option(page, other.operationId)).toContainText('Already attached in this draft.');
		await page.keyboard.press('Escape');
		await expect(picker(page)).toBeHidden();
		await savedDraft(page, member, (b) => b.items.filter((i) => i.attach).length === 1, 'still one attached operation');
	});

	test('what cannot be attached to this sample is greyed: done work on a planned sample (the server\'s words), and an operation that makes a sample this one comes from', async ({ page }) => {
		const plannedMaker = await makeOrphan('planned');
		const done = await makeOrphan('done');
		const planned = await makeOrphan('planned');
		await openNewDraft(page);
		// The sample the planned operation makes is planned: pick it and open the picker on it.
		await pickSamples(page, [plannedMaker.sampleCode]);
		await openFromDatabase(page, plannedMaker.sampleId);
		await picker(page).getByRole('combobox').fill('LOCAL-ORPH');
		await expect(option(page, done.operationId)).toHaveAttribute('aria-disabled', 'true');
		await expect(option(page, done.operationId)).toContainText('Its sample is still planned; mark the operation that makes it done first.');
		await expect(option(page, planned.operationId), 'planned work is fine on a planned sample').not.toHaveAttribute('aria-disabled', 'true');
		await expect(option(page, plannedMaker.operationId), 'a sample is not an input of the operation that made it').toHaveAttribute('aria-disabled', 'true');
		await expect(option(page, plannedMaker.operationId)).toContainText('a sample cannot be an input of the operation that made it');
		await option(page, planned.operationId).click();
		await expect(opCard(page, planned.operationId)).toBeVisible();

		// A circle: the operation `plannedMaker` made the sample we started from, so attaching it downstream of that sample would close a loop.
		await openFromDatabase(page, planned.sampleId);
		await picker(page).getByRole('combobox').fill(plannedMaker.sampleCode);
		await expect(option(page, plannedMaker.operationId)).toHaveAttribute('aria-disabled', 'true');
		await expect(option(page, plannedMaker.operationId)).toContainText('which this sample comes from: that would run in a circle');
	});

	test('an operation that got an input after it was picked blocks Create with a visible check, and nothing is written', async ({ page }) => {
		const orphan = await makeOrphan('planned');
		const rawId = await attachTo(page, 'LOCAL-RAW-1', orphan);
		await expect(createButton(page)).toBeEnabled();
		const otherId = await sampleIdOf(admin, 'LOCAL-RAW-2');
		// Someone else gives it an input between the pick and Create.
		const patched = await admin.patch(`${D1}/items/manufacturing_operations/${orphan.operationId}`, { data: { sample_id: otherId } });
		expect(patched.ok(), await patched.text()).toBeTruthy();
		const row = await operationRow(member, orphan.operationId);
		const lineage = await lineageOf(member, orphan.sampleId);
		const draftId = draftIdOf(page);

		const { status, body } = await pressCreate(page, noteMade);
		expect(status, JSON.stringify(body)).toBe(409);
		expect(JSON.stringify(body)).toContain('NOT_ATTACHABLE');
		await expect(checks(page)).toContainText('got an input in the meantime');
		await expect(createButton(page)).toBeDisabled();
		// Nothing was written: the operation is as the other person left it, with its one lineage row, and the draft is still there.
		expect(await operationRow(member, orphan.operationId)).toEqual(row);
		expect((await operationRow(member, orphan.operationId)).sample_id, 'still the other person\'s sample').toBe(otherId);
		expect(await lineageOf(member, orphan.sampleId)).toEqual(lineage);
		expect(lineage.map((l) => l.parent_sample_id)).toEqual([otherId]);
		expect((await getRetrying(member, `${D1}/d1-build/drafts/${draftId}`)).status(), 'the draft is kept').toBe(200);
		expect(rawId).not.toBe(otherId);
	});

	test('an operation changed, or deleted, after it was picked blocks Create too, and nothing is written', async ({ page }) => {
		const edited = await makeOrphan('planned');
		await attachTo(page, 'LOCAL-RAW-1', edited);
		await expect(createButton(page)).toBeEnabled();
		const bumped = await member.patch(`${D1}/items/manufacturing_operations/${edited.operationId}`, { data: { outcome_notes: 'edited elsewhere' } });
		expect(bumped.ok(), await bumped.text()).toBeTruthy();
		const row = await operationRow(member, edited.operationId);
		const answer = await pressCreate(page, noteMade);
		expect(answer.status, JSON.stringify(answer.body)).toBe(409);
		expect(JSON.stringify(answer.body)).toContain('STALE_VERSION');
		await expect(checks(page)).toContainText('Changed since you added it');
		expect(await operationRow(member, edited.operationId), 'untouched').toEqual(row);
		expect(await lineageOf(member, edited.sampleId), 'no lineage was written').toEqual([]);

		// The same draft opened again once the record has been deleted: the page reads it afresh and says it is gone; Create, asked directly, refuses.
		const draftId = draftIdOf(page);
		const gone = await admin.delete(`${D1}/items/manufacturing_operations/${edited.operationId}`);
		expect(gone.ok(), await gone.text()).toBeTruthy();
		await page.goto(`${STAR}/map?edit=${draftId}`, { waitUntil: 'domcontentloaded' });
		await expect(checks(page)).toContainText('no longer exists, or you can no longer see it');
		await expect(createButton(page)).toBeDisabled();
		const refused = await member.post(`${D1}/d1-build/drafts/${draftId}/create`, { data: {} });
		expect(refused.status(), await refused.text()).toBe(409);
		expect(await refused.text()).toContain('GONE');
		expect(await lineageOf(member, edited.sampleId), 'still no lineage').toEqual([]);
	});

	test('the palette entry opens the picker: the operation lands on the canvas attached to nothing, Create is refused until a sample is wired to it; dropping the entry on a sample\'s output attaches it there', async ({ page }) => {
		const floating = await makeOrphan('planned');
		const dropped = await makeOrphan('planned');
		await openNewDraft(page);
		await pickSamples(page, ['LOCAL-RAW-1', 'LOCAL-RAW-2']);
		const rawId = await sampleIdOf(admin, 'LOCAL-RAW-1');
		const raw2Id = await sampleIdOf(admin, 'LOCAL-RAW-2');

		// Clicked: floating.
		await paletteEntry(page, /From database/).click();
		await expect(picker(page)).toBeVisible();
		await expect(picker(page)).toContainText('Add to the canvas');
		await (await find(page, floating)).click();
		await expect(opCard(page, floating.operationId)).toBeVisible();
		await expect(createButton(page)).toBeDisabled();
		await expect(checks(page)).toContainText('needs a sample');
		// Wired by hand (a drag from the sample's output to the operation's input): attached.
		const out = await boxOf(sockOf(page, `sample|${rawId}|out`).first());
		const into = await boxOf(sockOf(page, `row|${floating.operationId}|in`).first());
		await page.mouse.move(out.x + out.width / 2, out.y + out.height / 2);
		await page.mouse.down();
		await page.mouse.move(into.x + into.width / 2, into.y + into.height / 2, { steps: 12 });
		await page.mouse.up();
		await expect(wireBetween(page, `s:${rawId}:out`, `op:${floating.operationId}:in`)).toHaveCount(1);
		await expect(createButton(page)).toHaveText('Attach 1 operation');

		// Dropped on the second sample's output: the picker opens for that sample, and what it picks is wired to it.
		await dragEntryTo(page, paletteEntry(page, /From database/), sockOf(page, `sample|${raw2Id}|out`).first());
		await expect(picker(page)).toBeVisible();
		await expect(picker(page)).toContainText('Attach to LOCAL-RAW-2');
		await (await find(page, dropped)).click();
		await expect(wireBetween(page, `s:${raw2Id}:out`, `op:${dropped.operationId}:in`)).toHaveCount(1);
		await expect(createButton(page)).toHaveText('Attach 2 operations');
		const body = await savedDraft(page, member, (b) => b.items.filter((i) => i.attach).length === 2 && b.wires.length === 2, 'two attached operations, wired');
		expect(body.items.filter((i) => i.attach).map((i) => i.existing?.id).sort()).toEqual([floating.operationId, dropped.operationId].sort());
	});

	test('From database… is offered unconnected and from a sample\'s output, and not at a sample\'s input or an operation\'s output', async ({ page }) => {
		await openNewDraft(page);
		await pickSamples(page, ['LOCAL-RAW-1']);
		const rawId = await sampleIdOf(admin, 'LOCAL-RAW-1');
		const offered = (): Locator => addSearch(page).getByRole('option', { name: /From database/ });
		// Unconnected (Shift+A): it is there, and lands floating.
		await openAddSearch(page);
		await expect(offered()).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(addSearch(page)).toBeHidden();
		// A sample's output: it is.
		await sockOf(page, `sample|${rawId}|out`).first().press('Enter');
		await expect(offered()).toBeVisible();
		await addSearch(page).getByRole('combobox').fill('turning');
		await addSearch(page).getByRole('option', { name: /CNC Turning/ }).click();
		await expect(addSearch(page)).toBeHidden();
		// An operation's output: not.
		await rowSockOut(page).first().press('Enter');
		await expect(addSearch(page)).toBeVisible();
		await expect(offered()).toHaveCount(0);
		await page.keyboard.press('Escape');
		await expect(addSearch(page)).toBeHidden();
		// A new sample's input (what makes it): not.
		await (await paletteKind(page, 'sample')).click();
		await canvasOf(page).locator('[data-sock^="sample|draft:"][data-sock$="|in"]').first().press('Enter');
		await expect(addSearch(page)).toBeVisible();
		await expect(offered()).toHaveCount(0);
	});
});

/** A sample made FROM `from`'s sample by a planned operation (so it descends from it), made by `member`. */
async function makeDescendant(from: Orphan): Promise<{ sampleId: string; sampleCode: string }> {
	const [method] = await listRecords<{ method_id: string }>(admin, 'manufacturing_methods', 'filter[method_code][_eq]=MC&fields=method_id');
	const [parent] = await listRecords<{ material_id: string }>(admin, 'physical_samples', `filter[sample_id][_eq]=${from.sampleId}&fields=material_id`);
	const sampleCode = `LOCAL-DESC-${Date.now().toString(36)}${(counter += 1)}`.toUpperCase();
	const sample = await member.post(`${D1}/items/physical_samples`, { data: { sample_code: sampleCode, current_status: 'planned', material_id: parent.material_id, form: 'cylinder', primary_method_id: method.method_id } });
	expect(sample.ok(), await sample.text()).toBeTruthy();
	const sampleId = JSON.parse(await sample.text()).data.sample_id as string;
	noteMade({ collection: 'physical_samples', id: sampleId });
	const op = await member.post(`${D1}/items/manufacturing_operations`, { data: { sample_id: from.sampleId, output_sample_id: sampleId, method_id: method.method_id, work_state: 'planned', process_category: 'machining' } });
	expect(op.ok(), await op.text()).toBeTruthy();
	noteMade({ collection: 'manufacturing_operations', id: JSON.parse(await op.text()).data.operation_id as string });
	return { sampleId, sampleCode };
}

test.describe('what Create refuses whatever the page showed', () => {
	test.beforeEach(async ({ page }) => {
		await signIn(page, 'member');
	});

	test('an operation is never attached to the sample it made: wired by hand from its own output, the page blocks it and Create (asked directly) refuses, nothing written', async ({ page }) => {
		const orphan = await makeOrphan('planned');
		await openNewDraft(page);
		await paletteEntry(page, /From database/).click();
		await (await find(page, orphan)).click();
		await expect(opCard(page, orphan.operationId)).toBeVisible();
		// The sample it made is drawn after it: drag from that sample's output onto the operation's free input (the whole map in view first: the palette covers its left).
		await fit(page);
		const out = await boxOf(sockOf(page, `sample|${orphan.sampleId}|out`).first());
		const into = await boxOf(sockOf(page, `row|${orphan.operationId}|in`).first());
		await page.mouse.move(out.x + out.width / 2, out.y + out.height / 2);
		await page.mouse.down();
		await page.mouse.move(into.x + into.width / 2, into.y + into.height / 2, { steps: 12 });
		await page.mouse.up();
		await expect(wireBetween(page, `s:${orphan.sampleId}:out`, `op:${orphan.operationId}:in`)).toHaveCount(1);
		await expect(checks(page)).toContainText('The sample this operation made cannot be an input of it.');
		await expect(createButton(page)).toBeDisabled();
		await savedDraft(page, member, (b) => b.items.some((i) => i.attach) && b.wires.length === 1, 'the attach wired to its own output');
		const before = await operationRow(member, orphan.operationId);
		const refused = await member.post(`${D1}/d1-build/drafts/${draftIdOf(page)}/create`, { data: {} });
		expect(refused.status(), await refused.text()).toBe(409);
		expect(await refused.text()).toContain('cannot be an input of the operation that made it');
		expect(await operationRow(member, orphan.operationId), 'nothing was written').toEqual(before);
		expect(before.sample_id).toBeNull();
	});

	test('a lineage loop the page cannot see (a sample picked from the index has no history on the map) is blocked by the server with a visible check, nothing written', async ({ page }) => {
		const orphan = await makeOrphan('planned');
		const descendant = await makeDescendant(orphan); // orphan.sample -> descendant.sample, in the database
		await openNewDraft(page);
		await pickSamples(page, [descendant.sampleCode]);
		await openFromDatabase(page, descendant.sampleId);
		await (await find(page, orphan)).click();
		await expect(opCard(page, orphan.operationId)).toBeVisible();
		await expect(checks(page)).toContainText(`It made ${orphan.sampleCode}, which the sample you attached it to comes from: that would run in a circle.`);
		await expect(createButton(page)).toBeDisabled();
		const before = await operationRow(member, orphan.operationId);
		const lineage = await lineageOf(member, orphan.sampleId);
		const refused = await member.post(`${D1}/d1-build/drafts/${draftIdOf(page)}/create`, { data: {} });
		expect(refused.status(), await refused.text()).toBe(409);
		expect(await refused.text()).toContain('would run in a circle');
		expect(await operationRow(member, orphan.operationId), 'nothing was written').toEqual(before);
		expect(await lineageOf(member, orphan.sampleId), 'no lineage row was added').toEqual(lineage);
	});

	test('a sample that already comes from another sample is greyed in the picker, and Create refuses an attach that would give it a second origin (the other origin appeared after the pick)', async ({ page }) => {
		const rawId = await sampleIdOf(admin, 'LOCAL-RAW-2');
		const [method] = await listRecords<{ method_id: string }>(admin, 'manufacturing_methods', 'filter[method_code][_eq]=MC&fields=method_id');
		const makeOrigin = async (o: Orphan): Promise<void> => {
			const maker = await member.post(`${D1}/items/manufacturing_operations`, { data: { sample_id: rawId, output_sample_id: o.sampleId, method_id: method.method_id, work_state: 'planned', process_category: 'machining' } });
			expect(maker.ok(), await maker.text()).toBeTruthy();
			noteMade({ collection: 'manufacturing_operations', id: JSON.parse(await maker.text()).data.operation_id as string });
		};
		const withOrigin = await makeOrphan('planned');
		await makeOrigin(withOrigin); // another operation already makes its sample from RAW-2
		await openNewDraft(page);
		await pickSamples(page, ['LOCAL-RAW-1']);
		await openFromDatabase(page, await sampleIdOf(admin, 'LOCAL-RAW-1'));
		const row = await find(page, withOrigin);
		await expect(row).toHaveAttribute('aria-disabled', 'true');
		await expect(row).toContainText('already comes from another sample: attaching would give it a second origin');
		await page.keyboard.press('Escape');
		await expect(picker(page)).toBeHidden();

		// The origin appears AFTER the pick: the picker could not grey it, d1-build refuses.
		const late = await makeOrphan('planned');
		await page.goto(`${STAR}/map`, { waitUntil: 'domcontentloaded' });
		await attachTo(page, 'LOCAL-RAW-1', late);
		await expect(createButton(page)).toBeEnabled();
		await savedDraft(page, member, (b) => b.items.some((i) => i.attach) && b.wires.length === 1, 'the attach, saved');
		await makeOrigin(late);
		const before = await operationRow(member, late.operationId);
		const refused = await member.post(`${D1}/d1-build/drafts/${draftIdOf(page)}/create`, { data: {} });
		expect(refused.status(), await refused.text()).toBe(409);
		expect(await refused.text()).toContain('second origin');
		expect(await operationRow(member, late.operationId), 'nothing was written').toEqual(before);
	});

	test('Show more keeps the keyboard in the dialog: focus on the search box, the highlighted row where it was, Esc still closes', async ({ page }) => {
		test.setTimeout(180_000);
		for (let i = 0; i < 22; i++) await makeOrphan('planned');
		await openNewDraft(page);
		await pickSamples(page, ['LOCAL-RAW-1']);
		await openFromDatabase(page, await sampleIdOf(admin, 'LOCAL-RAW-1'));
		const options = picker(page).getByRole('option');
		await expect(options).toHaveCount(20);
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('ArrowDown');
		await expect(options.nth(2)).toHaveAttribute('aria-selected', 'true');
		await picker(page).getByRole('button', { name: 'Show more' }).focus();
		await page.keyboard.press('Enter');
		await expect(options).toHaveCount(22);
		await expect(picker(page).getByRole('button', { name: 'Show more' }), 'the last page: the button is gone').toHaveCount(0);
		await expect(options.nth(2), 'the highlight did not jump to the first row').toHaveAttribute('aria-selected', 'true');
		await expect(picker(page).getByRole('combobox'), 'focus is on the search box, not the page body').toBeFocused();
		await page.keyboard.press('ArrowDown');
		await expect(options.nth(3)).toHaveAttribute('aria-selected', 'true');
		await page.keyboard.press('Escape');
		await expect(picker(page)).toBeHidden();
	});
});

test.describe('who can see what', () => {
	test('a Lab Member sees the orphan operations they may read, not another member\'s', async ({ page, playwright }) => {
		const mine = await makeOrphan('planned');
		const other = await secondMember(playwright, admin, noteUser);
		// The second member's own sample and operation: a draft needs a sample to build from.
		const theirs = await makeOrphan('planned', other.api, other.personId);
		const ownCode = `LOCAL-OTHER-${Date.now().toString(36)}`.toUpperCase();
		const own = await other.api.post(`${D1}/items/physical_samples`, { data: { sample_code: ownCode, current_status: 'active', form: 'cylinder' } });
		expect(own.ok(), await own.text()).toBeTruthy();
		const ownId = JSON.parse(await own.text()).data.sample_id as string;
		noteMade({ collection: 'physical_samples', id: ownId });

		// The API says the same: the second member cannot read the first member's operation, and can read their own.
		expect((await other.api.get(`${D1}/items/manufacturing_operations/${mine.operationId}`)).status(), 'not readable by the second member').toBe(403);
		expect((await other.api.get(`${D1}/items/manufacturing_operations/${theirs.operationId}`)).ok()).toBeTruthy();

		// In the browser as the second member: the list holds theirs and not the other's.
		await page.goto(`${STAR}/signin`, { waitUntil: 'domcontentloaded' });
		await page.locator('input[type="email"]').fill(other.email);
		await page.locator('input[type="password"]').fill(other.password);
		await page.getByRole('button', { name: /^sign in$/i }).click();
		await page.waitForURL((u) => !u.pathname.startsWith('/signin'), { timeout: 30_000 });
		await openNewDraft(page);
		await pickSamples(page, [ownCode]);
		await openFromDatabase(page, ownId);
		await picker(page).getByRole('combobox').fill('LOCAL-ORPH');
		await expect(option(page, theirs.operationId)).toBeVisible();
		await expect(option(page, mine.operationId), 'the first member\'s operation is not listed').toHaveCount(0);
		await picker(page).getByRole('combobox').fill(mine.sampleCode);
		await expect(picker(page).getByRole('status')).toContainText('No operation without an input sample matches');
	});
});

test.describe('who may change what', () => {
	test('a member who may read an operation (as an investigator of its project) but not change it is told so at the pick, and nothing joins the draft', async ({ page, playwright }) => {
		const [project] = await listRecords<{ project_id: string }>(admin, 'projects', 'filter[project_code][_eq]=LOCAL-PROJ&fields=project_id');
		const orphan = await makeOrphan('planned', member, memberPerson, project.project_id);
		const other = await secondMember(playwright, admin, noteUser);
		const userId = users[users.length - 1].userId;
		const made = await admin.post(`${D1}/items/project_investigators`, { data: { project_id: project.project_id, user_id: userId } });
		expect(made.ok(), await made.text()).toBeTruthy();
		// Read through the project, but the access rules let only the owner (or an owner of the sample it acts on) change an operation.
		expect((await other.api.get(`${D1}/items/manufacturing_operations/${orphan.operationId}`)).ok(), 'the investigator can read it').toBeTruthy();
		expect((await other.api.patch(`${D1}/items/manufacturing_operations/${orphan.operationId}`, { data: { outcome_notes: 'x' } })).ok(), 'but not change it').toBeFalsy();

		await page.goto(`${STAR}/signin`, { waitUntil: 'domcontentloaded' });
		await page.locator('input[type="email"]').fill(other.email);
		await page.locator('input[type="password"]').fill(other.password);
		await page.getByRole('button', { name: /^sign in$/i }).click();
		await page.waitForURL((u) => !u.pathname.startsWith('/signin'), { timeout: 30_000 });
		const before = await operationRow(member, orphan.operationId);
		const rawId = await sampleIdOf(admin, 'LOCAL-RAW-1');
		await openNewDraft(page);
		await pickSamples(page, ['LOCAL-RAW-1']);
		await openFromDatabase(page, rawId);
		await (await find(page, orphan)).click();
		await expect(picker(page).getByRole('status')).toContainText('You can see this operation but not change it.');
		await shot(page, 'refused-may-read-not-change');
		await expect(picker(page), 'the picker stays open to choose another').toBeVisible();
		await expect(opCard(page, orphan.operationId)).toHaveCount(0);
		expect(await operationRow(member, orphan.operationId), 'nothing was written').toEqual(before);
	});
});
