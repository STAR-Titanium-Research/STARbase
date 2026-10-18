import { test, expect, type APIRequestContext } from '@playwright/test';
import { D1, STAR, apiAs, listRecords, readRecord, signIn, stackAvailable } from '../starbase/localStack';
import {
	buildTurningWithNewSample, card, cards, clickWire, createButton, pressCreate, readDraft, sampleIdOf, fit, makePlanned, savedDraft, selectCard, startEditingMapOf, wireBetween,
	type Ref,
} from '../starbase/mapEdit';

/**
 * Slice 1 of the process map edit mode redesign (R4 removal, R5 derived sockets, R6 layout, R10 Mark done by the owner, plain fixes
 * and the d1-build side of items 7 and 8) in a REAL browser against the LOCAL STACK, as the seeded Lab Member (and the Lab Admin
 * where a spec says so). The plan: docs/superpowers/plans/2026-10-18-process-map-edit-redesign.md; the spec of the rules:
 * docs/superpowers/specs/2026-10-18-process-map-edit-mode-redesign.md. Run it with edit-mode.spec.ts:
 *
 *   bash scripts/dev/local-stack.sh up
 *   cd tests/ui && npx playwright test -c playwright.local-stack.config.ts
 *
 * Everything a test makes is removed again afterwards through the admin API (planned records only: a done one cannot be deleted), and
 * the drafts the accounts leave behind are deleted, so the suite can run again on the same stack. The seed family is only read, with
 * one exception: the tests that change a record of it put it back (and say so). There are no sleeps: waits are for something on the
 * page or for what the server holds (`savedDraft` polls the saved draft).
 */

let admin: APIRequestContext;
let member: APIRequestContext;
const made: Ref[] = [];
const noteMade = (r: Ref): void => void (made.some((m) => m.id === r.id) || made.push(r));

test.beforeAll(async ({ playwright }) => {
	test.skip(!stackAvailable(), 'the local stack is not up: run `bash scripts/dev/local-stack.sh up`');
	admin = await apiAs(playwright, 'admin');
	member = await apiAs(playwright, 'member');
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
			const r = await admin.delete(`${D1}/items/${collection}/${ref.id}`);
			if (!r.ok() && r.status() !== 404) console.warn(`clean-up: DELETE ${collection}/${ref.id} answered ${r.status()}: ${await r.text()}`);
		}
	}
	made.length = 0;
});

test.describe('as a Lab Member', () => {
	test.beforeEach(async ({ page }) => {
		await signIn(page, 'member');
	});

	// ---- 1. Delete / X / Backspace on a new card and a wire; undo and redo ---------------------------------------------------------
	for (const key of ['Delete', 'x', 'Backspace']) {
		test(`${key} removes a selected new card, undo restores it and redo removes it again (R4)`, async ({ page }) => {
			await buildTurningWithNewSample(page, member, 'LOCAL-RAW-1');
			const operation = card(page, 'CNC Turning, Operation');
			const sample = card(page, 'New sample, Sample');
			await expect(operation).toBeVisible();
			await savedDraft(page, member, (b) => b.items.length === 3 && b.wires.length === 2, 'sample, operation, new sample and their two wires');

			// The new sample: its own card and the wire into it go; the operation stays.
			await selectCard(page, sample);
			await page.keyboard.press(key);
			await expect(sample).toHaveCount(0);
			await expect(operation).toBeVisible();
			let body = await savedDraft(page, member, (b) => b.items.length === 2, 'the new sample removed');
			expect(body.wires, 'the wire into the removed sample went with it').toHaveLength(1);

			// Undo (Ctrl+Z) brings the card and its wire back; redo (Ctrl+Shift+Z) removes them again.
			await page.keyboard.press('Control+z');
			await expect(sample).toBeVisible();
			body = await savedDraft(page, member, (b) => b.items.length === 3 && b.wires.length === 2, 'undo put the sample and its wire back');
			await page.keyboard.press('Control+Shift+z');
			await expect(sample).toHaveCount(0);
			await savedDraft(page, member, (b) => b.items.length === 2 && b.wires.length === 1, 'redo removed the sample again');

			// The operation goes with both of its wires.
			await selectCard(page, operation);
			await page.keyboard.press(key);
			await expect(operation).toHaveCount(0);
			body = await savedDraft(page, member, (b) => b.items.length === 1, 'the operation removed');
			expect(body.wires, 'no wire is left pointing at a removed card').toHaveLength(0);
			await page.keyboard.press('Control+z');
			await expect(operation).toBeVisible();
			await savedDraft(page, member, (b) => b.items.length === 2 && b.wires.length === 1, 'undo brought the operation back with the wire from its input');
		});
	}

	test('a selected wire is removed by Delete, X or Backspace; the keys do nothing while typing in a field; undo restores it (R4)', async ({ page }) => {
		await buildTurningWithNewSample(page, member, 'LOCAL-RAW-1');
		await savedDraft(page, member, (b) => b.wires.length === 2, 'both wires saved');
		const operation = card(page, 'CNC Turning, Operation');
		const sample = card(page, 'New sample, Sample');
		await fit(page);
		// The drawn wire from the operation's output to the new sample (the material's wire into LOCAL-RAW-1 is recorded history).
		const wire = wireBetween(page, 'op:draft:', 's:draft:');
		const name = page.getByLabel('Draft name');

		for (const key of ['Delete', 'x', 'Backspace']) {
			await clickWire(page, wire);
			await expect(page.locator('.d1-wire.sel')).toHaveCount(1);
			// Typing in the draft's name is the field's: the wire stays and nothing is saved as removed.
			await name.focus();
			await page.keyboard.press(key);
			await expect(page.locator('.d1-wire.sel')).toHaveCount(1);
			await expect(wire).toHaveCount(1);
			await name.blur();
			// On the canvas the key takes the wire, and only the wire.
			await page.keyboard.press(key);
			await expect(wire).toHaveCount(0);
			await expect(operation).toBeVisible();
			await expect(sample).toBeVisible();
			const body = await savedDraft(page, member, (b) => b.wires.length === 1, `the wire removed with ${key}`);
			expect(body.items, 'a wire removal keeps both cards').toHaveLength(3);
			await page.keyboard.press('Control+z');
			await expect(wire).toHaveCount(1);
			await savedDraft(page, member, (b) => b.wires.length === 2, `undo put the wire back after ${key}`);
		}
	});

	// ---- 2. a planned record that exists: struck through, deleted at Create; done records are locked ---------------------------------
	test('a planned operation and its planned output: Delete strikes them through, Create deletes them from the database and the map (R4)', async ({ page }) => {
		const { operationId, sampleId, inputId } = await makePlanned(member, admin, 'LOCAL-RAW-2', noteMade);
		await startEditingMapOf(page, 'manufacturing_operations', operationId);
		const operation = cards(page).filter({ hasText: /CNC Turning/ }).and(page.getByRole('group', { name: /, Operation$/ }));
		const output = page.getByRole('group', { name: /^LOCAL-PLN-.*, Sample$/ });
		await expect(operation).toBeVisible();
		await selectCard(page, operation);
		await page.keyboard.press('Delete');
		const struck = page.locator('.vue-flow__node .node.removing');
		// Struck through with a "Will be deleted" pill (a ::after of the card), the operation and the planned sample it makes.
		await expect(struck).toHaveCount(2);
		for (const c of [operation, output]) {
			const inner = c.locator('.node.removing');
			await expect(inner).toHaveCount(1);
			expect(await inner.evaluate((el) => getComputedStyle(el, '::after').content), 'the pill').toContain('Will be deleted');
			expect(await inner.locator('.code, .n').first().evaluate((el) => getComputedStyle(el).textDecorationLine), 'the code is struck through').toContain('line-through');
		}
		await expect(createButton(page)).toHaveText('Delete 1 planned record');
		await expect(createButton(page)).toBeEnabled();
		// Nothing is deleted yet: it is a draft until Create.
		expect((await readRecord<{ work_state: string }>(member, 'manufacturing_operations', operationId, 'work_state')).work_state).toBe('planned');

		// Undo brings both cards back as they were; redo strikes them again.
		await page.keyboard.press('Control+z');
		await expect(struck).toHaveCount(0);
		await expect(createButton(page)).toHaveText('Add an operation, test or new sample to create');
		await page.keyboard.press('Control+Shift+z');
		await expect(struck).toHaveCount(2);

		// Create deletes them in the database, and the map no longer has them.
		const answer = await pressCreate(page, noteMade);
		expect(answer.status, JSON.stringify(answer.body)).toBe(200);
		expect(await existing(admin, 'manufacturing_operations', 'operation_id', operationId), 'the planned operation is gone from the database').toBe(false);
		expect(await existing(admin, 'physical_samples', 'sample_id', sampleId), 'its planned output sample is gone too').toBe(false);
		await expect(operation).toHaveCount(0);
		await expect(output).toHaveCount(0);
		// The input sample is untouched.
		expect((await readRecord<{ current_status: string }>(member, 'physical_samples', inputId, 'current_status')).current_status).toBe('active');
	});

	test('a done operation, a done sample and the wire between them cannot be removed: a lock, the reason, and nothing is sent (R4, ADR-0019 §6)', async ({ page }) => {
		const bar1 = await sampleIdOf(admin, 'LOCAL-BAR-1');
		const bar2 = await sampleIdOf(admin, 'LOCAL-BAR-2');
		const [done] = await listRecords<{ operation_id: string }>(admin, 'manufacturing_operations', 'filter[pass_code][_eq]=LOCAL-BAR-1-T1&fields=operation_id');
		const draftId = await startEditingMapOf(page, 'physical_samples', bar1);
		const operation = card(page, /^CNC Turning LOCAL-BAR-1-T1, Operation$/);
		const output = card(page, 'LOCAL-BAR-2, Sample');
		await expect(operation).toBeVisible();
		await expect(output).toBeVisible();
		// Every request that could write a record: a Create, or a delete / write on a record.
		const sent: string[] = [];
		page.on('request', (r) => {
			if (/\/d1-build\/drafts\/[^/]+\/create$/.test(r.url()) || (r.method() !== 'GET' && /\/items\//.test(r.url()))) sent.push(`${r.method()} ${r.url()}`);
		});
		const reason = page.locator('.pm-banner[role="alert"]');
		const before = await cards(page).count();

		for (const [what, target] of [['the done operation', operation], ['the done sample', output]] as const) {
			for (const key of ['Delete', 'x', 'Backspace']) {
				await selectCard(page, target);
				await page.keyboard.press(key);
				await expect(reason, `${what} with ${key}`).toHaveText(/Done records can't be removed from the map/);
				// The card wears a lock with the same reason, and is not struck through.
				await expect(target.locator('.lock[role="img"]')).toHaveAttribute('aria-label', "Done records can't be removed from the map");
				await expect(page.locator('.vue-flow__node .node.removing')).toHaveCount(0);
				await page.getByRole('button', { name: 'Dismiss' }).first().click();
				await expect(reason).toHaveCount(0);
			}
			// The lid's Remove button says the same.
			await selectCard(page, target);
			await page.getByRole('button', { name: 'Remove', exact: true }).click();
			await expect(reason).toHaveText(/Done records can't be removed from the map/);
			await page.getByRole('button', { name: 'Dismiss' }).first().click();
		}
		await expect(cards(page)).toHaveCount(before);

		// The wire between two done records: selected, Delete says why, and the wire wears a padlock.
		for (const wire of [wireBetween(page, `s:${bar1}`, 'op:'), wireBetween(page, 'op:', `s:${bar2}`)]) {
			await clickWire(page, wire);
			await page.keyboard.press('Delete');
			await expect(reason).toHaveText(/Done records' wires can't be removed from the map/);
			await expect(wire.locator('.lock[role="img"]')).toHaveAttribute('aria-label', "Done records' wires can't be removed from the map");
			await expect(wire).toHaveCount(1);
			await page.getByRole('button', { name: 'Dismiss' }).first().click();
		}

		// Nothing was changed, in the draft or the database, and nothing was sent to create.
		expect(sent, 'nothing that writes a record was sent').toEqual([]);
		const body = await readDraft(member, draftId);
		expect(body.items.filter((i) => i.remove), 'nothing in the draft is marked for deletion').toHaveLength(0);
		expect(body.wires, 'no wire was added or removed').toHaveLength(0);
		await expect(createButton(page)).toBeDisabled();
		const row = await readRecord<{ work_state: string }>(member, 'manufacturing_operations', done.operation_id, 'work_state');
		expect(row.work_state).toBe('done');
		expect(await existing(admin, 'physical_samples', 'sample_id', bar2), 'the done output sample is still there').toBe(true);
	});
});

/** Whether a row with this id is in the database (read as `api`: a list query answers [] for a row that is gone, where a read of one id answers 403). */
async function existing(api: APIRequestContext, collection: string, idField: string, id: string): Promise<boolean> {
	return (await listRecords(api, collection, `filter[${idField}][_eq]=${id}&fields=${idField}`)).length > 0;
}
