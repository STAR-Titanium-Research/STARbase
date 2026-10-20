import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { D1, STAR, apiAs, getRetrying, listRecords, readRecord, signIn, signInWith, stackAvailable } from '../starbase/localStack';
import {
	addSearch, boxOf, canvasMiddle, card, cards, centreOf, canvasOf, createButton, dragBetween, dragEntryTo, emptySpot, fit, openAddSearch, openNewDraft, paletteEntry, paletteOf, pickSamples, pressCreate,
	readDraft, draftIdOf, sampleIdOf, savedDraft, searchOptions, secondMember, selectCard, sockOf, startEditingMapOf, distinctRecords, chooseFromSocketMenu, wireBetween, wireMidpoint, settledOverlaps,
	type DraftBody, type Ref,
} from '../starbase/mapEdit';

/**
 * Slice 4 of the process map edit mode redesign (R7, templates) in a REAL browser against the LOCAL STACK: a filled container saved as a
 * template (rail button, right-click menu), the Templates group first in the palette and the add search, a template dropped as a prefilled
 * container that is created with those values, the three scopes (private, my account role, everyone) as two Lab Members, an administrator and a
 * Lab Viewer see them, rename, who can use it, replace with the selected card's settings and delete, a stale version, and the warning on a
 * template that names a retired tool. The rules are in templates.test.ts, useTemplates.test.ts, useTemplateUi.test.ts and menuModel.test.ts.
 *
 *   bash scripts/dev/local-stack.sh up
 *   cd tests/ui && npx playwright test -c playwright.local-stack.config.ts specs/edit-mode-slice4.spec.ts
 *
 * Everything a test makes is removed afterwards: templates (through the administrator, who may delete any), tools, the records Create made
 * (planned, so deletable), the drafts and the second Lab Member. There are no sleeps: waits are for something on the page or for what the server holds.
 */

let admin: APIRequestContext;
let member: APIRequestContext;
let viewer: APIRequestContext;
let memberPersonId: string;
const RUN = Date.now().toString(36);
const nm = (s: string): string => `PM4 ${s} ${RUN}`;
const ROLE_MEMBER = '10000001-0000-0000-0000-000000000002';

const made: Ref[] = [];
const noteMade = (r: Ref): void => void (made.some((m) => m.id === r.id) || made.push(r));
const users: { userId: string; personId: string | null }[] = [];
const noteUser = (u: { userId: string; personId: string | null }): void => void users.push(u);
/** Other accounts a test used, to find the templates they could see. */
const others: APIRequestContext[] = [];
const toolIds: string[] = [];
/** A tool a test retired: put back (and the tool is deleted anyway). */

interface Template { id: string; name: string; scope: 'private' | 'role' | 'global'; role_id: string | null; collection: string; values: Record<string, unknown>; user_id: string; version: number }
const templatesOf = async (api: APIRequestContext): Promise<Template[]> => {
	const r = await getRetrying(api, `${D1}/d1-build/templates`);
	expect(r.ok(), `GET templates: ${r.status()} ${await r.text()}`).toBeTruthy();
	return (await r.json()).data as Template[];
};
const templateNamed = async (api: APIRequestContext, name: string): Promise<Template | undefined> => (await templatesOf(api)).find((t) => t.name === name);

test.beforeAll(async ({ playwright }) => {
	test.skip(!stackAvailable(), 'the local stack is not up: run `bash scripts/dev/local-stack.sh up`');
	admin = await apiAs(playwright, 'admin');
	member = await apiAs(playwright, 'member');
	viewer = await apiAs(playwright, 'viewer');
	const me = await (await getRetrying(member, `${D1}/users/me?fields=id`)).json();
	memberPersonId = (await listRecords<{ person_id: string }>(admin, 'people', `filter[user_id][_eq]=${me.data.id}&fields=person_id`))[0].person_id;
});

async function deleteDrafts(api: APIRequestContext): Promise<void> {
	const r = await getRetrying(api, `${D1}/d1-build/drafts`);
	if (!r.ok()) return;
	for (const d of (await r.json()).data as { id: string }[]) await api.delete(`${D1}/d1-build/drafts/${d.id}`);
}

test.afterEach(async () => {
	if (!stackAvailable() || !admin) return;
	await deleteDrafts(member);
	// Every template a test left: found as each account that could see it, deleted by the administrator (who may delete any).
	const ids = new Set<string>();
	for (const api of [member, admin, ...others]) for (const t of await templatesOf(api).catch(() => [])) if (t.name.startsWith('PM4 ')) ids.add(t.id);
	for (const id of ids) await admin.delete(`${D1}/d1-build/templates/${id}`);
	for (const collection of ['manufacturing_operations', 'test_sessions', 'physical_samples']) {
		for (const ref of made.filter((m) => m.collection === collection)) {
			const r = await admin.delete(`${D1}/items/${collection}/${ref.id}`);
			if (!r.ok() && r.status() !== 404) console.warn(`clean-up: DELETE ${collection}/${ref.id} answered ${r.status()}: ${await r.text()}`);
		}
	}
	made.length = 0;
	for (const id of toolIds.splice(0)) await admin.delete(`${D1}/items/tools/${id}`);
	for (const u of users.splice(0)) {
		await admin.delete(`${D1}/users/${u.userId}`);
		if (u.personId) await admin.delete(`${D1}/items/people/${u.personId}`);
	}
	for (const api of others.splice(0)) await api.dispose();
});

async function makeTool(label: string): Promise<{ id: string; code: string; name: string }> {
	const code = `PM4-${label}-${RUN}`.toUpperCase();
	const name = `PM4 ${label} holder ${RUN}`;
	const r = await admin.post(`${D1}/items/tools`, { data: { tool_code: code, tool_name: name, tool_type: 'holder' } });
	expect(r.ok(), `tool: ${await r.text()}`).toBeTruthy();
	const id = (await r.json()).data.tool_id as string;
	toolIds.push(id);
	return { id, code, name };
}
async function machineId(name: string): Promise<string> {
	const [row] = await listRecords<{ equipment_id: string }>(admin, 'equipment', `filter[equipment_name][_contains]=${encodeURIComponent(name)}&fields=equipment_id&limit=1`);
	expect(row, `the seeded machine ${name}`).toBeTruthy();
	return row.equipment_id;
}

// ---- the rail's form -------------------------------------------------------------------------------------------------------------

/** The rail's "all fields" section of the selected card (it is collapsed until opened; the key settings form above it has the same fields). */
const allFields = (page: Page): Locator => page.locator('section.d1-section', { has: page.getByRole('heading', { name: /all fields/i }) });
async function openAllFields(page: Page): Promise<Locator> {
	const all = allFields(page);
	if (!(await all.getByRole('combobox', { name: 'Tool', exact: true }).isVisible().catch(() => false))) await page.getByRole('heading', { name: /all fields/i }).click();
	await expect(all.getByRole('combobox', { name: 'Tool', exact: true })).toBeVisible();
	return all;
}
/** Picks a record in one of the form's pickers: types `query`, chooses the option that reads `option`. */
async function pick(all: Locator, label: string, query: string, option: RegExp | string): Promise<void> {
	const box = all.getByRole('combobox', { name: label, exact: true });
	await box.click();
	await box.fill(query);
	await all.getByRole('option', { name: option }).first().click();
}
/** A CNC Turning from the palette onto the empty middle of the canvas, selected, with its "all fields" open. Returns its saved draft key. */
async function dropTurning(page: Page, api: APIRequestContext, where?: { x: number; y: number }): Promise<void> {
	const before = (await readDraft(api, draftIdOf(page))).items.length;
	await dragEntryTo(page, paletteEntry(page, /^CNC Turning/), where ?? (await canvasMiddle(page)));
	await savedDraft(page, api, (b) => b.items.length === before + 1, 'the CNC Turning dropped');
}
async function selectOperation(page: Page): Promise<void> {
	await selectCard(page, cards(page).filter({ hasText: /Turning/ }).first());
}
/** The drawn card of the draft container whose row has the key `rowKey` (it holds that row's sockets). */
const cardOfRow = (page: Page, rowKey: string): Locator => cards(page).filter({ has: page.locator(`[data-sock="row|draft:${rowKey}|in"]`) });

const FIELDS = ['equipment_id', 'tool_id', 'operator_person_id'] as const;
/** The add search from the one new operation's free output socket, then "New sample". */
async function openAddSearchOnRow(page: Page): Promise<void> {
	await chooseFromSocketMenu(page, canvasOf(page).locator('[data-sock^="row|draft:"][data-sock$="|out"]').first(), /^New sample/);
}
const dialogOf = (page: Page): Locator => page.getByRole('dialog', { name: /as a template$/ });
/** The rail's Save as template… button, the dialog, a name and a scope; returns what the server answered. */
async function saveAsTemplate(page: Page, name: string, scope: RegExp = /^Only me/, opts: { notes?: boolean; opened?: boolean } = {}): Promise<Template> {
	if (!opts.opened) await page.getByRole('button', { name: /^Save as template/ }).click();
	const dialog = dialogOf(page);
	await expect(dialog).toBeVisible();
	await dialog.getByPlaceholder('Template name').fill(name);
	await dialog.getByRole('radio', { name: scope }).check();
	if (opts.notes) await dialog.getByRole('checkbox', { name: /notes/i }).check();
	const answered = page.waitForResponse((r) => /\/d1-build\/templates$/.test(r.url()) && r.request().method() === 'POST');
	await dialog.getByRole('button', { name: 'Save template' }).click();
	const response = await answered;
	expect(response.status(), await response.text()).toBe(201);
	await expect(dialog).toBeHidden();
	return (await response.json()).data as Template;
}

test.describe('as a Lab Member', () => {
	test.beforeEach(async ({ page }) => {
		await signIn(page, 'member');
	});

	// ---- the whole round: fill, save, find, drop, wire, create ----------------------------------------------------------------
	test('a filled CNC Turning saved as a private template is first in the palette and in Shift+A, drops prefilled with no date or sample, and Create writes those values (R7)', async ({ page }) => {
		const tool = await makeTool('ROUND');
		const haas = await machineId('Haas VF-2');
		const raw1 = await sampleIdOf(member, 'LOCAL-RAW-1');
		await openNewDraft(page);
		await dropTurning(page, member);
		await selectOperation(page);
		const all = await openAllFields(page);
		await pick(all, 'Machine', 'Haas', /Haas VF-2/);
		await pick(all, 'Tool', tool.code, new RegExp(tool.code));
		await pick(all, 'Operator', 'Local Member', /Local Member/);
		// What must NOT travel: a planned date and notes (and, of course, a sample, which is wiring).
		await all.locator('[data-field="planned_date"] input').fill('2026-12-24');
		await all.locator('[data-field="outcome_notes"] textarea').fill('hold two minutes at depth');
		const filled = await savedDraft(page, member, (b) => FIELDS.every((f) => !!b.items[0]?.values[f]) && b.items[0].values.planned_date === '2026-12-24' && !!b.items[0].values.outcome_notes, 'machine, tool, operator, date and notes on the card');
		expect(filled.items[0].values).toMatchObject({ equipment_id: haas, tool_id: tool.id, operator_person_id: memberPersonId });

		// Save as template: the rail's section, the dialog says what it keeps and what it never keeps.
		await expect(page.getByRole('heading', { name: 'Template', exact: true })).toBeVisible();
		await page.getByRole('button', { name: /^Save as template/ }).click();
		const dialog = dialogOf(page);
		await expect(dialog.getByPlaceholder('Template name')).toHaveValue('CNC Turning');
		await expect(dialog.getByRole('radio', { name: /^Only me/ })).toBeChecked();
		const keeps = dialog.locator('[data-keeps]');
		for (const word of ['Method', 'Machine', 'Tool', 'Operator']) await expect(keeps).toContainText(word);
		await expect(keeps).not.toContainText('Planned date');
		await expect(keeps).toContainText('Never the sample, the dates, whether it is done, results, files or codes.');
		await expect(dialog.getByRole('checkbox', { name: /notes/i })).not.toBeChecked();
		const saved = await saveAsTemplate(page, nm('Round'), /^Only me/, { opened: true });
		expect(saved).toMatchObject({ name: nm('Round'), scope: 'private', role_id: null, collection: 'manufacturing_operations' });

		// What the server holds: the filled fields, never the date, the notes or a sample.
		const stored = await templateNamed(member, nm('Round'));
		expect(stored?.values).toMatchObject({ equipment_id: haas, tool_id: tool.id, operator_person_id: memberPersonId, process_category: 'machining' });
		expect(typeof stored?.values.method_id).toBe('string');
		for (const f of ['planned_date', 'operation_date', 'outcome_notes', 'sample_id', 'output_sample_id', 'work_state', 'owner_person_id', 'project_id']) expect(stored?.values, `no ${f} in a template`).not.toHaveProperty(f);

		// The palette says so and lists it first, above the samples; folded it opens.
		await expect(page.locator('[data-template-notice]')).toContainText(`Saved the template ${nm('Round')}.`);
		const sections = paletteOf(page).locator('.sec');
		await expect(sections.first()).toHaveText('Templates');
		await expect(paletteOf(page).locator('.pe').first()).toContainText(nm('Round'));
		await expect(paletteEntry(page, nm('Round'))).toContainText('CNC Turning');

		// The add search lists it first too, and finds it by its name and by its method.
		await openAddSearch(page);
		expect((await searchOptions(page))[0]).toBe(nm('Round'));
		await addSearch(page).getByRole('combobox').fill('round');
		expect(await searchOptions(page)).toEqual([nm('Round')]);
		await addSearch(page).getByRole('combobox').fill('turning');
		expect(await searchOptions(page)).toContain(nm('Round'));
		await page.keyboard.press('Escape');
		await expect(addSearch(page)).toBeHidden();

		// The first card goes (the template does not depend on it); the template is dropped on the empty canvas.
		await selectOperation(page);
		await page.keyboard.press('Delete');
		await expect(cards(page)).toHaveCount(0);
		await dragEntryTo(page, paletteEntry(page, nm('Round')), await canvasMiddle(page));
		const drafted = await savedDraft(page, member, (b) => b.items.length === 1, 'the template dropped as a container');
		const dropped = drafted.items[0];
		expect(dropped).toMatchObject({ kind: 'operation', workState: 'planned', values: { equipment_id: haas, tool_id: tool.id, operator_person_id: memberPersonId } });
		for (const f of ['planned_date', 'operation_date', 'outcome_notes', 'sample_id']) expect(dropped.values, `no ${f} on the dropped card`).not.toHaveProperty(f);
		expect(drafted.wires).toEqual([]);

		// Editable afterwards and not linked: the machine changed on the card does not touch the template.
		await selectOperation(page);
		const form = await openAllFields(page);
		await expect(form.getByRole('combobox', { name: 'Tool', exact: true })).toHaveValue(new RegExp(tool.code));
		await form.locator('[data-field="planned_date"] input').fill('2027-01-05');
		await savedDraft(page, member, (b) => b.items[0].values.planned_date === '2027-01-05', 'the card edited after the drop');
		expect((await templateNamed(member, nm('Round')))?.values).not.toHaveProperty('planned_date');

		// Wire a sample into it and Create: the operation is written with the prefilled fields.
		await pickSamples(page, ['LOCAL-RAW-1']);
		await fit(page);
		await settledOverlaps(page); // (the cards glide to their places after the pick: sockets are measured once they rest)
		const rowKey = dropped.rows?.[0]?.key;
		expect(rowKey, 'the dropped operation has its row').toBeTruthy();
		const source = sockOf(page, `sample|${raw1}|out`).first();
		const target = canvasOf(page).locator(`[data-sock="row|draft:${rowKey}|in"]`);
		await dragBetween(page, centreOf(await boxOf(source)), centreOf(await boxOf(target)));
		await savedDraft(page, member, (b) => b.wires.length === 1, 'the sample wired to the template card');
		await expect(createButton(page)).toBeEnabled();
		const answer = await pressCreate(page, noteMade);
		expect(answer.status, JSON.stringify(answer.body)).toBe(200);
		const [operation] = distinctRecords(answer.body.data!.created).filter((r) => r.collection === 'manufacturing_operations');
		const row = await readRecord<Record<string, unknown>>(member, 'manufacturing_operations', operation.id, 'method_id,equipment_id,tool_id,operator_person_id,planned_date,operation_date,outcome_notes,sample_id,work_state,process_category');
		expect(row).toMatchObject({ equipment_id: haas, tool_id: tool.id, operator_person_id: memberPersonId, sample_id: raw1, work_state: 'planned', process_category: 'machining', outcome_notes: null, operation_date: null, planned_date: '2027-01-05' });
		expect(row.method_id).toBe(stored?.values.method_id);
		// The template is what it was: making the record did not change it.
		expect((await templateNamed(member, nm('Round')))?.version).toBe(stored?.version);
	});

	test('the notes travel only when ticked, and the template of a test is saved and listed too (R7)', async ({ page }) => {
		await openNewDraft(page);
		await dropTurning(page, member);
		await selectOperation(page);
		const all = await openAllFields(page);
		await all.locator('[data-field="outcome_notes"] textarea').fill('rough pass, 2 mm');
		await savedDraft(page, member, (b) => b.items[0].values.outcome_notes === 'rough pass, 2 mm', 'notes on the card');
		await page.getByRole('button', { name: /^Save as template/ }).click();
		await expect(dialogOf(page).getByRole('checkbox', { name: /notes/i })).toBeVisible();
		const saved = await saveAsTemplate(page, nm('With notes'), /^Only me/, { notes: true, opened: true });
		expect(saved.values.outcome_notes).toBe('rough pass, 2 mm');
		// A test: the tensile type of the palette, dropped, then saved.
		await selectOperation(page);
		await page.keyboard.press('Delete');
		// (the tests are at the bottom of the dock's list: scrolled to before the pointer goes there)
		await paletteEntry(page, /Destructive — Tensile/).scrollIntoViewIfNeeded();
		await dragEntryTo(page, paletteEntry(page, /Destructive — Tensile/), await canvasMiddle(page));
		await savedDraft(page, member, (b) => b.items.length === 1 && b.items[0].kind === 'test', 'a tensile test on the canvas');
		await selectCard(page, cards(page).filter({ hasText: /Tensile/i }).first());
		await page.getByRole('button', { name: /^Save as template/ }).click();
		await expect(dialogOf(page)).toHaveAccessibleName('Save this test as a template');
		const test1 = await saveAsTemplate(page, nm('Pull'), /^Everyone/, { opened: true });
		expect(test1).toMatchObject({ scope: 'global', collection: 'test_sessions', values: { test_type: 'tensile' } });
		await expect(paletteOf(page).locator('.pe').first()).toContainText(nm('Pull'));
	});

	test('the card\'s right-click menu saves a recorded container as a template: it is read first, and nothing of its run travels (R7)', async ({ page }) => {
		const bar1 = await sampleIdOf(member, 'LOCAL-BAR-1');
		await startEditingMapOf(page, 'physical_samples', bar1);
		const done = card(page, /^CNC Turning LOCAL-BAR-1-T1, Operation$/);
		await expect(done).toBeVisible();
		await done.locator('.code, .oname .n').first().click({ button: 'right' });
		const menu = page.getByRole('menu', { name: 'Highlight' });
		await menu.getByRole('menuitem', { name: /Save as template/ }).click();
		const dialog = dialogOf(page);
		await expect(dialog).toBeVisible();
		await expect(dialog.getByPlaceholder('Template name')).toHaveValue('CNC Turning');
		await expect(dialog.locator('[data-keeps]')).toContainText('Method');
		const saved = await saveAsTemplate(page, nm('From a done cut'), /^Only me/, { opened: true });
		expect(saved.values).toMatchObject({ process_category: 'machining' });
		for (const f of ['operation_date', 'pass_code', 'sample_id', 'output_sample_id', 'work_state', 'done_at', 'owner_person_id', 'project_id', 'version']) expect(saved.values, `no ${f} from a done record`).not.toHaveProperty(f);
		// The record it was made from is untouched.
		const op = (await listRecords<{ version: number; work_state: string }>(admin, 'manufacturing_operations', 'filter[pass_code][_eq]=LOCAL-BAR-1-T1&fields=version,work_state'))[0];
		expect(op.work_state).toBe('done');
	});

	test('a template drops on a free socket (connected there) and on a wire (inserted between), and Enter on its entry adds it (R2 with R7)', async ({ page }) => {
		const haas = await machineId('Haas VF-2');
		const [method] = await listRecords<{ method_id: string }>(admin, 'manufacturing_methods', 'filter[method_code][_eq]=MC&fields=method_id');
		const made1 = await member.post(`${D1}/d1-build/templates`, { data: { name: nm('Drops'), collection: 'manufacturing_operations', values: { method_id: method.method_id, equipment_id: haas, process_category: 'machining' } } });
		expect(made1.status()).toBe(201);
		const raw1 = await sampleIdOf(member, 'LOCAL-RAW-1');
		await openNewDraft(page);
		await pickSamples(page, ['LOCAL-RAW-1']);
		const withHaas = (b: DraftBody) => b.items.filter((i) => i.kind === 'operation' && i.values.equipment_id === haas).length;

		// On the sample's free output socket: the operation is made from the template and wired to the sample.
		await dragEntryTo(page, paletteEntry(page, nm('Drops')), sockOf(page, `sample|${raw1}|out`).first());
		let body = await savedDraft(page, member, (b) => withHaas(b) === 1 && b.wires.length === 1, 'the template dropped on a socket');
		expect(body.wires[0].from.key).toBe(body.items.find((i) => i.kind === 'sample')!.key);
		// A new sample out of it, so there is a wire between an operation and a sample.
		await openAddSearchOnRow(page);
		body = await savedDraft(page, member, (b) => b.items.length === 3 && b.wires.length === 2, 'a new sample out of the operation');

		// On that wire: inserted between its two ends (a new sample and the template's operation).
		await fit(page);
		await dragEntryTo(page, paletteEntry(page, nm('Drops')), () => wireMidpoint(wireBetween(page, 'op:draft:', 's:draft:')));
		body = await savedDraft(page, member, (b) => withHaas(b) === 2 && b.items.length === 5, 'the template dropped on the wire');
		expect(body.wires.length).toBeGreaterThanOrEqual(4);

		// Enter on the entry adds one next to the selected card.
		await paletteEntry(page, nm('Drops')).focus();
		await page.keyboard.press('Enter');
		await savedDraft(page, member, (b) => withHaas(b) === 3, 'Enter on the template entry');
	});

	test('a FAST/SPS operation saved as a template carries no run number, so two operations made from it are both created (migration 156 makes machine + run number unique)', async ({ page }) => {
		const haas = await machineId('Haas VF-2');
		const [fast] = await listRecords<{ method_id: string }>(admin, 'manufacturing_methods', 'filter[method_code][_eq]=MF&fields=method_id');
		const raw1 = await sampleIdOf(member, 'LOCAL-RAW-1');
		const raw2 = await sampleIdOf(member, 'LOCAL-RAW-2');
		// A recorded FAST operation with a run number, a machine and a setting (made by the administrator, deleted afterwards).
		const run = 7000 + Math.floor(Math.random() * 1000);
		const op = await admin.post(`${D1}/items/manufacturing_operations`, {
			data: { sample_id: raw2, method_id: fast.method_id, process_category: 'sintering', equipment_id: haas, sintering_run_number: run, sintering_max_temp_celsius: 1450, sintering_batch_number: 'B-PM4', work_state: 'planned' },
		});
		expect(op.ok(), await op.text()).toBeTruthy();
		const opId = (await op.json()).data.operation_id as string;
		noteMade({ collection: 'manufacturing_operations', id: opId });

		await startEditingMapOf(page, 'physical_samples', raw2);
		const container = cards(page).filter({ hasText: /FAST/i });
		await expect(container.first()).toBeVisible();
		await container.first().locator('.code, .oname .n').first().click({ button: 'right' });
		await page.getByRole('menu', { name: 'Highlight' }).getByRole('menuitem', { name: /Save as template/ }).click();
		const saved = await saveAsTemplate(page, nm('Fast run'), /^Only me/, { opened: true });
		// (a decimal column reads back from Directus as a string: "1450.00")
		expect(saved.values).toMatchObject({ equipment_id: haas, process_category: 'sintering' });
		expect(Number(saved.values.sintering_max_temp_celsius)).toBe(1450);
		for (const f of ['sintering_run_number', 'sintering_batch_number', 'source_system', 'recorded_metadata', 'owner', 'gcode_file']) expect(saved.values, `no ${f}`).not.toHaveProperty(f);

		// Two operations from the template, one on each sample: Create accepts both.
		await openNewDraft(page);
		await pickSamples(page, ['LOCAL-RAW-1', 'LOCAL-RAW-2']);
		await chooseFromSocketMenu(page, sockOf(page, `sample|${raw1}|out`).first(), new RegExp(nm('Fast run')));
		await chooseFromSocketMenu(page, sockOf(page, `sample|${raw2}|out`).first(), new RegExp(nm('Fast run')));
		const body = await savedDraft(page, member, (b) => b.items.filter((i) => i.kind === 'operation').length === 2 && b.wires.length === 2, 'two operations made from the template');
		for (const i of body.items.filter((x) => x.kind === 'operation')) {
			expect(i.values.equipment_id).toBe(haas);
			expect(Number(i.values.sintering_max_temp_celsius)).toBe(1450);
		}
		const answer = await pressCreate(page, noteMade);
		expect(answer.status, JSON.stringify(answer.body)).toBe(200);
		const made2 = distinctRecords(answer.body.data!.created).filter((r) => r.collection === 'manufacturing_operations');
		expect(made2).toHaveLength(2);
		for (const r of made2) {
			const row = await readRecord<Record<string, unknown>>(member, 'manufacturing_operations', r.id, 'equipment_id,sintering_run_number,sintering_max_temp_celsius,process_category');
			expect(row).toMatchObject({ equipment_id: haas, sintering_run_number: null, process_category: 'sintering' });
			expect(Number(row.sintering_max_temp_celsius)).toBe(1450);
		}
	});

	test('a done test saved as a template keeps its type and parameters and never its results, status, files, owner or codes', async ({ page }) => {
		const bar1 = await sampleIdOf(member, 'LOCAL-BAR-1');
		const [t] = await listRecords<Record<string, unknown>>(admin, 'test_sessions', 'filter[test_code][_eq]=LOCAL-BAR-1-TENSILE&fields=session_id,status,tensile_uts_mpa,tensile_gauge_length_mm,data_file_uri,summary_stats,owner');
		const me = await (await getRetrying(admin, `${D1}/users/me?fields=id`)).json();
		const patch = async (data: Record<string, unknown>) => {
			const r = await admin.patch(`${D1}/items/test_sessions/${t.session_id}`, { data });
			expect(r.ok(), await r.text()).toBeTruthy();
		};
		// The seeded done tensile test gets a pipeline status, a result, a file and an owner for the run of this test, and has them back after it.
		await patch({ status: 'analysed', tensile_uts_mpa: 960, tensile_gauge_length_mm: 25, data_file_uri: 's3://pm4/data.csv', owner: me.data.id });
		try {
			await startEditingMapOf(page, 'physical_samples', bar1);
			const test1 = cards(page).filter({ hasText: /tensile/i }).first();
			await expect(test1).toBeVisible();
			await test1.locator('.code, .oname .n').first().click({ button: 'right' });
			await page.getByRole('menu', { name: 'Highlight' }).getByRole('menuitem', { name: /Save as template/ }).click();
			const saved = await saveAsTemplate(page, nm('Done tensile'), /^Everyone/, { opened: true });
			expect(saved.collection).toBe('test_sessions');
			expect(saved.values.test_type).toBe('tensile');
			expect(Number(saved.values.tensile_gauge_length_mm)).toBe(25);
			for (const f of ['status', 'tensile_uts_mpa', 'data_file_uri', 'summary_stats', 'owner', 'test_code_number', 'test_code_subject_id', 'session_date', 'work_state']) expect(saved.values, `no ${f}`).not.toHaveProperty(f);
		} finally {
			await patch({ status: t.status ?? null, tensile_uts_mpa: t.tensile_uts_mpa ?? null, tensile_gauge_length_mm: t.tensile_gauge_length_mm ?? null, data_file_uri: t.data_file_uri ?? null, owner: t.owner ?? null });
		}
	});

	// ---- the scopes ----------------------------------------------------------------------------------------------------------
	test('private, my account role and everyone: who sees which, and who may change them (R7, E11)', async ({ page, playwright, browser }) => {
		const second = await secondMember(playwright, admin, noteUser);
		others.push(second.api);
		// Made in the dialog (role and everyone) and through the API (private): the same three scopes.
		await openNewDraft(page);
		await dropTurning(page, member);
		await selectOperation(page);
		const role = await saveAsTemplate(page, nm('Role'), /^My account role/);
		expect(role).toMatchObject({ scope: 'role', role_id: ROLE_MEMBER });
		await selectOperation(page);
		const everyone = await saveAsTemplate(page, nm('Everyone'), /^Everyone/);
		expect(everyone).toMatchObject({ scope: 'global', role_id: null });
		await selectOperation(page);
		const own = await saveAsTemplate(page, nm('Private'), /^Only me/);
		expect(own.scope).toBe('private');
		const names = async (api: APIRequestContext): Promise<string[]> => (await templatesOf(api)).map((t) => t.name).filter((n) => n.startsWith('PM4 ') && n.endsWith(RUN));
		expect((await names(member)).sort()).toEqual([nm('Everyone'), nm('Private'), nm('Role')].sort());
		// A second Lab Member shares the role: the role one and the everyone one, not the private one.
		expect((await names(second.api)).sort()).toEqual([nm('Everyone'), nm('Role')].sort());
		// An administrator has another role: the one for everyone only (the role's is not shared with them).
		expect(await names(admin)).toEqual([nm('Everyone')]);

		// Who may change: nobody but the maker and an administrator.
		const patch = (api: APIRequestContext, t: Template) => api.patch(`${D1}/d1-build/templates/${t.id}`, { data: { name: nm('Hijacked'), version: t.version } });
		expect((await patch(second.api, role)).status()).toBe(403);
		expect((await second.api.delete(`${D1}/d1-build/templates/${everyone.id}`)).status()).toBe(403);
		expect((await second.api.patch(`${D1}/d1-build/templates/${own.id}`, { data: { name: 'x', version: own.version } })).status(), 'a private template is another person\'s: not even found').toBe(404);
		expect((await patch(admin, role)).status(), 'an administrator may change any').toBe(200);
		expect((await templateNamed(member, nm('Hijacked')))?.id).toBe(role.id);
		const renamed = (await templateNamed(member, nm('Hijacked')))!;
		expect((await admin.patch(`${D1}/d1-build/templates/${renamed.id}`, { data: { name: nm('Role'), version: renamed.version } })).status()).toBe(200);

		// In the second member's own browser: the same two, first in the palette, with no controls to change them.
		const ctx = await browser.newContext({ viewport: { width: 1920, height: 1300 } });
		const page2 = await ctx.newPage();
		try {
			await signInWith(page2, second.email, second.password);
			await openNewDraft(page2);
			const entries = paletteOf(page2).locator('.pe');
			await expect(paletteEntry(page2, nm('Role'))).toBeVisible();
			await expect(paletteEntry(page2, nm('Everyone'))).toBeVisible();
			await expect(paletteEntry(page2, nm('Private'))).toHaveCount(0);
			await expect(paletteOf(page2).locator('.sec').first()).toHaveText('Templates');
			await expect(entries.first()).toContainText('PM4 ');
			await expect(paletteOf(page2).getByRole('button', { name: /Manage the template/ })).toHaveCount(0);
			// And what they add from it is theirs.
			await dragEntryTo(page2, paletteEntry(page2, nm('Everyone')), await canvasMiddle(page2));
			const body = await savedDraft(page2, second.api, (b) => b.items.length === 1, 'the shared template dropped by the second member');
			expect(body.items[0].values.method_id).toBe((await templateNamed(member, nm('Everyone')))?.values.method_id);
		} finally {
			await deleteDrafts(second.api);
			await ctx.close();
		}
	});

	test('a Lab Viewer cannot reach templates: d1-build answers 403 and the page offers no edit mode, palette or templates (R11, R7)', async ({ browser }) => {
		await templatesOf(member); // (the member's own list is fine)
		for (const [method, path] of [['get', '/d1-build/templates'], ['post', '/d1-build/templates']] as const) {
			const r = await (method === 'get' ? viewer.get(`${D1}${path}`) : viewer.post(`${D1}${path}`, { data: { name: nm('V'), collection: 'manufacturing_operations', values: { method_id: '10000001-0000-0000-0000-000000000099' } } }));
			expect(r.status(), `${method} ${path} as a Lab Viewer`).toBe(403);
			expect((await r.json()).errors[0].extensions.code).toBe('FORBIDDEN');
		}
		const ctx = await browser.newContext({ viewport: { width: 1920, height: 1300 } });
		const page = await ctx.newPage();
		try {
			await signIn(page, 'viewer');
			await page.goto(`${STAR}/map`, { waitUntil: 'domcontentloaded' });
			await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
			await page.goto(`${STAR}/map?edit=new`, { waitUntil: 'domcontentloaded' });
			await expect(page.getByText('Your account may not build processes.')).toBeVisible();
			await expect(paletteOf(page)).toHaveCount(0);
			await expect(page.getByText('Templates', { exact: true })).toHaveCount(0);
			await expect(page.getByRole('button', { name: /Save as template/ })).toHaveCount(0);
		} finally {
			await ctx.close();
		}
	});

	// ---- manage: rename, who can use it, replace, delete, stale ----------------------------------------------------------------
	test('rename, who can use it, replace with the selected card\'s settings and delete; what was made from a template never changes (R7)', async ({ page }) => {
		const tool = await makeTool('MANAGE');
		const haas = await machineId('Haas VF-2');
		const [method] = await listRecords<{ method_id: string }>(admin, 'manufacturing_methods', 'filter[method_code][_eq]=MC&fields=method_id');
		const created = await member.post(`${D1}/d1-build/templates`, { data: { name: nm('Manage'), collection: 'manufacturing_operations', scope: 'private', values: { method_id: method.method_id, tool_id: tool.id, process_category: 'machining' } } });
		expect(created.status()).toBe(201);
		const tpl = (await created.json()).data as Template;
		await openNewDraft(page);
		// Made from it BEFORE it changes: this card must stay as it is.
		await dragEntryTo(page, paletteEntry(page, nm('Manage')), await canvasMiddle(page));
		const first = await savedDraft(page, member, (b) => b.items.length === 1, 'a card made from the template');
		expect(first.items[0].values).toMatchObject({ tool_id: tool.id });
		const original = JSON.stringify(first.items[0].values);

		// (its label follows the template's name, so it is found by what the two names share)
		const manage = paletteOf(page).getByRole('group', { name: /^Manage the template PM4 Manage/ });
		await paletteOf(page).getByRole('button', { name: `Manage the template ${nm('Manage')}` }).click();
		await expect(manage).toBeVisible();

		// Rename.
		await manage.getByLabel('Template name').fill(nm('Managed'));
		await manage.getByRole('button', { name: 'Rename' }).click();
		await expect(paletteEntry(page, nm('Managed'))).toBeVisible();
		await expect(page.locator('[data-template-notice]')).toContainText(`Renamed the template ${nm('Managed')}.`);
		expect((await templateNamed(member, nm('Managed')))?.id).toBe(tpl.id);

		// Who can use it.
		await manage.getByRole('radio', { name: 'Everyone' }).check();
		await expect.poll(async () => (await templateNamed(member, nm('Managed')))?.scope).toBe('global');
		await manage.getByRole('radio', { name: 'Only me' }).check();
		await expect.poll(async () => (await templateNamed(member, nm('Managed')))?.scope).toBe('private');

		// Replace needs a card of the same kind selected; with none it says what to select.
		await expect(manage.getByRole('button', { name: /^Replace with the selected card/ })).toBeDisabled();
		await dropTurning(page, member, await emptySpot(page));
		const two = await readDraft(member, draftIdOf(page));
		const blank = two.items.find((i) => i.values.tool_id === undefined)!;
		await selectCard(page, cardOfRow(page, blank.rows![0].key));
		const all = await openAllFields(page);
		await pick(all, 'Machine', 'Haas', /Haas VF-2/);
		await savedDraft(page, member, (b) => b.items.some((i) => i.values.equipment_id === haas), 'the machine on the second card');
		// The selection is the blank card that has the machine now.
		await expect(manage.getByRole('button', { name: /^Replace with the selected card/ })).toBeEnabled();
		await manage.getByRole('button', { name: /^Replace with the selected card/ }).click();
		await expect(manage.getByRole('alert')).toContainText('What was made from it is not changed.');
		await manage.getByRole('button', { name: 'Replace', exact: true }).click();
		await expect.poll(async () => (await templateNamed(member, nm('Managed')))?.values.equipment_id).toBe(haas);
		const after = await templateNamed(member, nm('Managed'));
		expect(after?.values.method_id).toBe(method.method_id);
		expect(after?.values).not.toHaveProperty('tool_id');
		// The card made from the template before is as it was.
		const body = await readDraft(member, draftIdOf(page));
		expect(JSON.stringify(body.items.find((i) => i.values.tool_id === tool.id)?.values)).toBe(original);

		// Delete asks once more, then the entry is gone and the cards stay.
		await manage.getByRole('button', { name: 'Delete', exact: true }).click();
		await expect(manage.getByRole('alert')).toContainText(`Delete ${nm('Managed')}?`);
		await manage.getByRole('button', { name: 'Cancel' }).click();
		await expect(paletteEntry(page, nm('Managed'))).toBeVisible();
		await manage.getByRole('button', { name: 'Delete', exact: true }).click();
		await manage.getByRole('button', { name: 'Delete', exact: true }).last().click();
		await expect(paletteEntry(page, nm('Managed'))).toHaveCount(0);
		await expect(page.locator('[data-template-notice]')).toContainText('What was made from it is unchanged.');
		expect((await getRetrying(member, `${D1}/d1-build/templates/${tpl.id}`)).status()).toBe(404);
		expect((await readDraft(member, draftIdOf(page))).items).toHaveLength(2);
		await expect(cards(page)).toHaveCount(2);
	});

	test('a template that changed elsewhere says so in plain words, reloads, and the second try works (OCC)', async ({ page }) => {
		const [method] = await listRecords<{ method_id: string }>(admin, 'manufacturing_methods', 'filter[method_code][_eq]=MC&fields=method_id');
		const made1 = await member.post(`${D1}/d1-build/templates`, { data: { name: nm('Stale'), collection: 'manufacturing_operations', values: { method_id: method.method_id } } });
		const tpl = (await made1.json()).data as Template;
		await openNewDraft(page);
		await expect(paletteEntry(page, nm('Stale'))).toBeVisible();
		// Someone else (this account in another tab) changes it first.
		expect((await member.patch(`${D1}/d1-build/templates/${tpl.id}`, { data: { name: nm('Stale elsewhere'), version: tpl.version } })).status()).toBe(200);
		await paletteOf(page).getByRole('button', { name: `Manage the template ${nm('Stale')}` }).click();
		const manage = paletteOf(page).getByRole('group', { name: /^Manage the template PM4 Stale/ });
		await manage.getByLabel('Template name').fill(nm('Stale mine'));
		await manage.getByRole('button', { name: 'Rename' }).click();
		await expect(page.locator('[data-template-notice]')).toContainText('This template changed since you opened it. It has been reloaded: try again.');
		await expect(paletteEntry(page, nm('Stale elsewhere'))).toBeVisible();
		expect((await templatesOf(member)).find((t) => t.id === tpl.id)?.name).toBe(nm('Stale elsewhere'));
		// The panel is still open on the template as the server has it now: the name typed is still there, and the second try is made against the new version.
		await expect(manage.getByLabel('Template name')).toHaveValue(nm('Stale mine'));
		await manage.getByRole('button', { name: 'Rename' }).click();
		await expect.poll(async () => (await templatesOf(member)).find((t) => t.id === tpl.id)?.name).toBe(nm('Stale mine'));
	});

	// ---- the keyboard and focus around the controls (review: arrows, a refused change, where focus goes) ------------------------------
	/** Where focus is now: the `.pm-tm` panel it is in, the template ⋯ button it is on, the card, or "the page body". */
	const focusNow = (page: Page): Promise<string> =>
		page.evaluate(() => {
			const el = document.activeElement as HTMLElement | null;
			if (!el || el === document.body) return 'body';
			if (el.closest('.pm-tm')) return 'panel';
			if (el.dataset.tm) return `more:${el.dataset.tm}`;
			if (el.closest('.vue-flow__node')) return 'card';
			if (el.matches('input[type="search"]')) return 'search';
			if (el.getAttribute('role') === 'dialog') return 'dialog';
			return el.tagName.toLowerCase() + (el.textContent ? `:${el.textContent.trim().slice(0, 30)}` : '');
		});
	const makeTemplate = async (name: string, values: Record<string, unknown> = {}): Promise<Template> => {
		const [method] = await listRecords<{ method_id: string }>(admin, 'manufacturing_methods', 'filter[method_code][_eq]=MC&fields=method_id');
		const r = await member.post(`${D1}/d1-build/templates`, { data: { name, collection: 'manufacturing_operations', values: { method_id: method.method_id, process_category: 'machining', ...values } } });
		expect(r.status()).toBe(201);
		return (await r.json()).data as Template;
	};
	const openManage = async (page: Page, name: string): Promise<Locator> => {
		await paletteOf(page).getByRole('button', { name: `Manage the template ${name}` }).click();
		return paletteOf(page).getByRole('group', { name: /^Manage the template PM4 Keys/ });
	};

	test('the arrow keys inside a template\'s controls change "Who can use it" and do not jump to the first entry (keyboard)', async ({ page }) => {
		const tpl = await makeTemplate(nm('Keys'));
		await openNewDraft(page);
		const manage = await openManage(page, nm('Keys'));
		const only = manage.getByRole('radio', { name: 'Only me' });
		await only.focus();
		await page.keyboard.press('ArrowDown');
		// The native radio group moved to the next one; the page did not take the key for the entry list.
		await expect.poll(async () => (await templatesOf(member)).find((t) => t.id === tpl.id)?.scope).toBe('role');
		expect(await focusNow(page)).toBe('panel');
		await expect(manage.getByRole('radio', { name: 'My account role' })).toBeChecked();
		await page.keyboard.press('ArrowDown');
		await expect.poll(async () => (await templatesOf(member)).find((t) => t.id === tpl.id)?.scope).toBe('global');
		expect(await focusNow(page)).toBe('panel');
		// The same keys still walk the entries from the search box.
		await paletteOf(page).getByRole('searchbox').focus();
		await page.keyboard.press('ArrowDown');
		expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.closest('.pe') !== null)).toBe(true);
	});

	test('a refused change puts the radio back and says why; focus stays in the controls (403 on PATCH)', async ({ page }) => {
		const tpl = await makeTemplate(nm('Keys'));
		await openNewDraft(page);
		const manage = await openManage(page, nm('Keys'));
		await page.route(`**/d1-build/templates/${tpl.id}`, (route) =>
			route.request().method() === 'PATCH'
				? route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ errors: [{ message: 'Only the person who made a template, or an administrator, can change it.', extensions: { code: 'FORBIDDEN' } }] }) })
				: route.continue(),
		);
		await manage.getByRole('radio', { name: 'Everyone' }).check();
		await expect(page.locator('[data-template-notice]')).toContainText('Only the person who made a template, or an administrator, can change it.');
		await expect(manage.getByRole('radio', { name: 'Only me' })).toBeChecked();
		await expect(manage.getByRole('radio', { name: 'Everyone' })).not.toBeChecked();
		expect(await focusNow(page)).not.toBe('body');
		expect((await templatesOf(member)).find((t) => t.id === tpl.id)?.scope).toBe('private');
	});

	test('focus never falls to the page body: Esc, Replace, Cancel and Delete in the controls (keyboard)', async ({ page }) => {
		const tpl = await makeTemplate(nm('Keys'));
		await openNewDraft(page);
		await dropTurning(page, member);
		await selectOperation(page);
		const manage = await openManage(page, nm('Keys'));
		// Esc closes the panel and gives focus to the ⋯ button of that template.
		await manage.getByLabel('Template name').focus();
		await page.keyboard.press('Escape');
		await expect(manage).toHaveCount(0);
		expect(await focusNow(page)).toBe(`more:${tpl.id}`);
		// Replace: ask, cancel with the keyboard, ask again and confirm; the focus is on the controls each time.
		const again = await openManage(page, nm('Keys'));
		await again.getByRole('button', { name: /^Replace with the selected card/ }).click();
		await again.getByRole('button', { name: 'Cancel' }).focus();
		await page.keyboard.press('Enter');
		expect(await focusNow(page)).toBe('panel');
		await again.getByRole('button', { name: /^Replace with the selected card/ }).click();
		await again.getByRole('button', { name: 'Replace', exact: true }).click();
		await expect(page.locator('[data-template-notice]')).toContainText('Replaced the settings of');
		expect(await focusNow(page)).toBe('panel');
		// Delete: the entry goes; focus is on the search box.
		await again.getByRole('button', { name: 'Delete', exact: true }).click();
		await again.getByRole('button', { name: 'Delete', exact: true }).last().click();
		await expect(paletteEntry(page, nm('Keys'))).toHaveCount(0);
		expect(await focusNow(page)).toBe('search');
	});

	test('the Save as template dialog: with nothing to save it takes focus and Esc closes it; from the right-click menu focus comes back to the card (keyboard)', async ({ page }) => {
		await openNewDraft(page);
		await dropTurning(page, member);
		await selectOperation(page);
		// No method, nothing to save: the dialog says so and holds focus itself.
		await page.getByRole('button', { name: 'Clear Method' }).first().click();
		await savedDraft(page, member, (b) => !b.items[0].values.method_id, 'the method cleared');
		await page.getByRole('button', { name: /^Save as template/ }).click();
		const dialog = dialogOf(page);
		await expect(dialog).toContainText('Choose the method of this operation first.');
		await expect(dialog).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(dialog).toBeHidden();
		expect(await focusNow(page)).toContain('button:');
		// From the card's right-click menu (which has closed by then): focus returns to the selected card.
		await page.getByRole('combobox', { name: 'Method' }).first().click();
		await page.getByRole('combobox', { name: 'Method' }).first().fill('Turning');
		await page.getByRole('option', { name: /CNC Turning/ }).first().click();
		await savedDraft(page, member, (b) => !!b.items[0].values.method_id, 'the method back');
		await cards(page).filter({ hasText: /Turning/ }).first().locator('.code, .oname .n').first().click({ button: 'right' });
		await page.getByRole('menu', { name: 'Highlight' }).getByRole('menuitem', { name: /Save as template/ }).click();
		await expect(dialogOf(page)).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(dialogOf(page)).toBeHidden();
		expect(await focusNow(page)).toBe('card');
	});

	test('a template whose method no longer exists is listed with the reason and cannot be added, from the palette or the add search', async ({ page }) => {
		const r = await member.post(`${D1}/d1-build/templates`, { data: { name: nm('Orphan'), collection: 'manufacturing_operations', values: { method_id: '00000000-0000-4000-8000-0000000000aa' } } });
		expect(r.status()).toBe(201);
		await openNewDraft(page);
		const entry = paletteEntry(page, nm('Orphan'));
		await expect(entry).toBeVisible();
		await expect(entry).toHaveAttribute('aria-disabled', 'true');
		await expect(entry.locator('[data-warning]')).toContainText('no longer in the list of methods');
		// Dragging it, clicking it and Enter on it add nothing.
		await dragEntryTo(page, entry, await canvasMiddle(page));
		await entry.click({ force: true });
		await entry.focus();
		await page.keyboard.press('Enter');
		await expect(cards(page)).toHaveCount(0);
		expect((await readDraft(member, draftIdOf(page))).items).toEqual([]);
		// The add search lists it greyed with the reason; it cannot be chosen.
		await openAddSearch(page);
		const option = addSearch(page).getByRole('option', { name: new RegExp(nm('Orphan')) });
		await expect(option).toHaveAttribute('aria-disabled', 'true');
		await expect(option).toContainText('no longer in the list of methods');
		await option.click({ force: true });
		await expect(cards(page)).toHaveCount(0);
		await page.keyboard.press('Escape');
		// It can still be deleted from the controls.
		const manage = paletteOf(page).getByRole('group', { name: /^Manage the template PM4 Orphan/ });
		await paletteOf(page).getByRole('button', { name: `Manage the template ${nm('Orphan')}` }).click();
		await manage.getByRole('button', { name: 'Delete', exact: true }).click();
		await manage.getByRole('button', { name: 'Delete', exact: true }).last().click();
		await expect(entry).toHaveCount(0);
	});

	// ---- the gear a template names --------------------------------------------------------------------------------------------
	test('a template that names a retired tool is greyed with the reason in the palette and the add search, and its card warns in Checks (R7)', async ({ page }) => {
		const tool = await makeTool('RETIRED');
		const [method] = await listRecords<{ method_id: string }>(admin, 'manufacturing_methods', 'filter[method_code][_eq]=MC&fields=method_id');
		const ok = await member.post(`${D1}/d1-build/templates`, { data: { name: nm('Retired tool'), collection: 'manufacturing_operations', values: { method_id: method.method_id, tool_id: tool.id, process_category: 'machining' } } });
		expect(ok.status()).toBe(201);
		const fine = await member.post(`${D1}/d1-build/templates`, { data: { name: nm('Fine tool'), collection: 'manufacturing_operations', values: { method_id: method.method_id, process_category: 'machining' } } });
		expect(fine.status()).toBe(201);
		const retire = await admin.patch(`${D1}/items/tools/${tool.id}`, { data: { is_active: false } });
		expect(retire.ok(), await retire.text()).toBeTruthy();
		await openNewDraft(page);
		const entry = paletteEntry(page, nm('Retired tool'));
		await expect(entry).toBeVisible();
		await expect(entry.locator('[data-warning]')).toHaveText(`The tool ${tool.name} is retired.`);
		await expect(entry).toHaveClass(/grey/);
		await expect(paletteEntry(page, nm('Fine tool')).locator('[data-warning]')).toHaveCount(0);
		// The add search says the same under the entry, and it can still be chosen.
		await openAddSearch(page);
		const option = addSearch(page).getByRole('option', { name: new RegExp(nm('Retired tool')) });
		await expect(option).toContainText(`The tool ${tool.name} is retired.`);
		await expect(option).not.toHaveAttribute('aria-disabled', 'true');
		await option.click();
		await expect(addSearch(page)).toBeHidden();
		await savedDraft(page, member, (b) => b.items.length === 1 && b.items[0].values.tool_id === tool.id, 'a card made from the warned template');
		// Checks: a warning on the card, not a block.
		await expect(page.getByText(`The tool ${tool.name} is retired.`).last()).toBeVisible();
		// Brought back into use: a reload shows no warning.
		expect((await admin.patch(`${D1}/items/tools/${tool.id}`, { data: { is_active: true } })).ok()).toBeTruthy();
		await page.reload({ waitUntil: 'domcontentloaded' });
		await expect(paletteEntry(page, nm('Retired tool'))).toBeVisible();
		await expect(paletteEntry(page, nm('Retired tool')).locator('[data-warning]')).toHaveCount(0);
	});
});
