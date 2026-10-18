import { test, expect, type APIRequestContext } from '@playwright/test';
import { D1, STAR, apiAs, listRecords, readRecord, signIn, stackAvailable } from '../starbase/localStack';
import {
	buildTurningWithNewSample, card, clickWire, fit, savedDraft, selectCard, wireBetween,
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
});
