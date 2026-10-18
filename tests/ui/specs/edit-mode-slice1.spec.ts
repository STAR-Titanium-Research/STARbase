import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { D1, STAR, apiAs, listRecords, readRecord, signIn, stackAvailable } from '../starbase/localStack';
import {
	addFromLid, buildTurningWithNewSample, card, cards, boxOf, canvasOf, centreOf, chooseFromSocketMenu, clickEmpty, clickWire, dragBetween, dragCard, createButton, duplicateMany, flowPos, flowPositions, openNewDraft, pickSamples, settledOverlaps, sockOf, dragFrom, draftIdOf, emptySpot, overlaps, pressCreate, readDraft, sampleIdOf, fit, distinctRecords, makePlanned, makeTechSituation, relativeLayout, secondMember, savedDraft, selectCard, startEditingMapOf, wireBetween,
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
/** The Lab Member's People row. */
let memberPerson: string;
const made: Ref[] = [];
const noteMade = (r: Ref): void => void (made.some((m) => m.id === r.id) || made.push(r));
/** Users a test made (a second Lab Member), removed afterwards with their People rows. */
const users: { userId: string; personId: string | null }[] = [];
const noteUser = (u: { userId: string; personId: string | null }): void => void users.push(u);

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
			// A done operation or test cannot be deleted: send it back to planned first (an admin may), then delete it.
			if (collection !== 'physical_samples') await admin.post(`${D1}/d1-build/mark-planned`, { data: { collection, ids: [ref.id] } });
			const r = await admin.delete(`${D1}/items/${collection}/${ref.id}`);
			if (!r.ok() && r.status() !== 404) console.warn(`clean-up: DELETE ${collection}/${ref.id} answered ${r.status()}: ${await r.text()}`);
		}
	}
	made.length = 0;
	for (const u of users.splice(0)) {
		await admin.delete(`${D1}/users/${u.userId}`);
		if (u.personId) await admin.delete(`${D1}/items/people/${u.personId}`);
	}
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

	// ---- 3. a wire end dragged off its socket; dissolve; a cut with three pieces -------------------------------------------------------
	test('dragging a wired input off its socket onto empty canvas removes that wire and opens no menu; undo puts it back (R4)', async ({ page }) => {
		await buildTurningWithNewSample(page, member, 'LOCAL-RAW-1');
		await savedDraft(page, member, (b) => b.wires.length === 2, 'both wires saved');
		await fit(page);
		const wire = wireBetween(page, 'op:draft:', 's:draft:');
		await expect(wire).toHaveCount(1);
		const input = canvasOf(page).locator('[data-sock^="sample|draft:"][data-sock$="|in"]:not(.free)');
		await expect(input).toHaveCount(1);
		await dragFrom(page, input, await emptySpot(page));
		await expect(wire).toHaveCount(0);
		await expect(page.locator('.pm-addmenu')).toHaveCount(0);
		const body = await savedDraft(page, member, (b) => b.wires.length === 1, 'the dragged wire removed');
		expect(body.items, 'the cards stay').toHaveLength(3);
		expect(body.wires[0].to.key, 'the other wire, into the operation, is the one left').not.toBe(body.items.find((i) => i.kind === 'sample' && !i.existing)!.key);
		await page.keyboard.press('Control+z');
		await expect(wire).toHaveCount(1);
		await savedDraft(page, member, (b) => b.wires.length === 2, 'undo put the wire back');
	});

	test('Dissolve (Ctrl+Delete) on a one-in-one-out new operation joins its input to its output, and undo restores it (R4)', async ({ page }) => {
		const { sampleId } = await buildTurningWithNewSample(page, member, 'LOCAL-RAW-1');
		// A second step after the new sample, so there is something to join the input to.
		await chooseFromSocketMenu(page, canvasOf(page).locator('[data-sock^="sample|draft:"][data-sock$="|out"]').first(), /CNC Turning/);
		await savedDraft(page, member, (b) => b.items.length === 4 && b.wires.length === 3, 'sample, operation, new sample, second operation');
		await fit(page);
		const first = cards(page).and(page.getByRole('group', { name: 'CNC Turning, Operation' })).first();
		await selectCard(page, first);
		await page.keyboard.press('Control+Delete');
		const body = await savedDraft(page, member, (b) => b.items.length === 2, 'the operation and its output sample removed');
		expect(body.wires, 'the input sample is wired straight into the second operation').toHaveLength(1);
		const source = body.items.find((i) => i.existing?.id === sampleId)!;
		expect(body.wires[0].from.key).toBe(source.key);
		expect(body.items.find((i) => i.key === body.wires[0].to.key)?.kind).toBe('operation');
		await expect(page.getByRole('group', { name: 'New sample, Sample' })).toHaveCount(0);
		await expect(wireBetween(page, `s:${sampleId}:out`, 'op:draft:')).toHaveCount(1);
		await page.keyboard.press('Control+z');
		await savedDraft(page, member, (b) => b.items.length === 4 && b.wires.length === 3, 'undo restored the operation, its sample and their wires');
		await expect(page.getByRole('group', { name: 'New sample, Sample' })).toBeVisible();
	});

	test('Dissolve refuses a cut with three pieces, with the reason, and changes nothing (R4)', async ({ page }) => {
		await buildTurningWithNewSample(page, member, 'LOCAL-RAW-1');
		const cut = card(page, /, Operation$/);
		// Two more pieces, each from the card's free output socket (a derived socket: it is on the selected card).
		for (let piece = 2; piece <= 3; piece++) {
			await selectCard(page, cut);
			await chooseFromSocketMenu(page, canvasOf(page).locator('.free[data-sock^="row|draft:"][data-sock$="|out|add"]'), /^New sample/);
			await savedDraft(page, member, (b) => b.items.find((i) => i.kind === 'operation')?.rows?.length === piece, `${piece} pieces`);
		}
		await expect(page.locator('.vue-flow__node').and(page.getByRole('group', { name: 'New sample, Sample' }))).toHaveCount(3);
		const before = await savedDraft(page, member, (b) => b.items.length === 5, 'the sample, the cut and three new samples');
		await selectCard(page, cut);
		await page.keyboard.press('Control+Delete');
		await expect(page.locator('.pm-banner[role="alert"]')).toHaveText(/3 outputs/);
		await expect(cut).toBeVisible();
		await expect(page.locator('.vue-flow__node').and(page.getByRole('group', { name: 'New sample, Sample' }))).toHaveCount(3);
		expect(await readDraft(member, draftIdOf(page)), 'nothing was changed').toEqual(before);
	});

	// ---- 4. derived sockets (R5) -----------------------------------------------------------------------------------------------------
	test('the free socket is on the selected card, spares go when the selection leaves, a card keeps its size, and a reload draws the same canvas (R5)', async ({ page }) => {
		await buildTurningWithNewSample(page, member, 'LOCAL-RAW-1');
		const operation = card(page, 'CNC Turning, Operation');
		const sample = card(page, 'New sample, Sample');
		await savedDraft(page, member, (b) => b.items.length === 3 && b.wires.length === 2, 'built');
		await fit(page);
		const free = (c: Locator) => c.locator('.sock.free');
		const sockets = (c: Locator) => c.locator('[data-sock]');
		const frames = async (...cs: Locator[]) => Promise.all(cs.map((c) => boxOf(c)));

		// A card that has no free sockets of its own (the material) is selected: the operation and the sample show their wired sockets only.
		const material = card(page, 'AA, Material');
		await selectCard(page, material);
		await expect(free(operation)).toHaveCount(0);
		// (The new sample has nothing leaving it, so its one free output is always there: a side with nothing wired shows its free socket.)
		await expect(free(sample)).toHaveCount(1);
		await expect(free(sample)).toHaveAttribute('data-sock', /^sample\|draft:.*\|out$/);
		const rest = await frames(operation, sample);
		const restSockets = await sockets(operation).count();

		// Selected: the operation has a free output (a new piece) and a free input; the sample a free output (what happens to it next).
		await selectCard(page, operation);
		await expect(free(operation).first()).toBeVisible();
		await expect(canvasOf(page).locator('.free[data-sock$="|out|add"]')).toHaveCount(1);
		expect(await sockets(operation).count(), 'one more socket: the free one').toBeGreaterThan(restSockets);
		expect(await frames(operation, sample), 'selecting a card does not move or resize it or its neighbour').toEqual(rest);

		// The selection moves to the sample: the operation's spare sockets are gone, the sample has its free output.
		await selectCard(page, sample);
		await expect(free(operation)).toHaveCount(0);
		await expect(canvasOf(page).locator('.free[data-sock^="sample|draft:"][data-sock$="|out"]')).toHaveCount(1);
		expect(await sockets(operation).count()).toBe(restSockets);
		expect(await frames(operation, sample)).toEqual(rest);

		// The selection leaves for a card with no free sockets: only wired sockets again.
		await selectCard(page, material);
		await expect(free(operation)).toHaveCount(0);

		// Nothing about sockets is stored: the draft reloads to the same canvas (same cards, the same sockets, the same arrangement).
		const shape = async () => ({
			cards: await cards(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-id')).sort()),
			sockets: await canvasOf(page).locator('[data-sock]').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-sock')}${e.classList.contains('free') ? ' free' : ''}`).sort()),
			layout: await relativeLayout(page),
		});
		const before = await shape();
		await savedDraft(page, member, (b) => b.items.length === 3, 'saved before the reload');
		await page.reload();
		await expect(cards(page)).toHaveCount(before.cards.length);
		await fit(page);
		const after = await shape();
		expect(after.cards, 'the same cards').toEqual(before.cards);
		expect(after.sockets, 'the same sockets, none of them stored').toEqual(before.sockets);
		// (Only dragged cards have a stored position: the others are laid out again on load, so the arrangement is checked by its order, not pixels.)
		const order = (l: Record<string, { x: number; y: number }>) => Object.entries(l).sort((p, q) => p[1].x - q[1].x).map(([id]) => id);
		expect(order(after.layout), 'the same left-to-right order').toEqual(order(before.layout));
		expect(await overlaps(page), 'and no two cards overlap').toEqual([]);
	});

	test('connecting to the free output socket of an operation adds a piece: a second row, the same input (R5)', async ({ page }) => {
		const { sampleId } = await buildTurningWithNewSample(page, member, 'LOCAL-RAW-1');
		const cut = card(page, /, Operation$/);
		// A loose new sample (from the lid's Add), the second piece's output.
		await page.getByRole('button', { name: /^Add\b/ }).first().click();
		await page.locator('.pm-addmenu').getByRole('option', { name: /^New sample/ }).click();
		await expect(page.locator('.pm-addmenu')).toBeHidden();
		await savedDraft(page, member, (b) => b.items.length === 4, 'the loose sample');
		await fit(page);
		await selectCard(page, cut);
		const freeOut = canvasOf(page).locator('.free[data-sock$="|out|add"]');
		await expect(freeOut).toHaveCount(1);
		// Draw the wire from the operation's free output to the loose sample's free input.
		const loose = canvasOf(page).locator('.free[data-sock^="sample|draft:"][data-sock$="|in"]');
		await expect(loose).toHaveCount(1);
		await dragBetween(page, centreOf(await boxOf(freeOut)), centreOf(await boxOf(loose)));
		const body = await savedDraft(page, member, (b) => b.items.find((i) => i.kind === 'operation')?.rows?.length === 2, 'a second piece');
		const op = body.items.find((i) => i.kind === 'operation')!;
		const input = body.items.find((i) => i.existing?.id === sampleId)!;
		expect(body.wires.filter((w) => w.to.key === op.key).map((w) => `${w.from.key}->${w.to.key}:${w.to.row ?? 0}`).sort(), 'the one input sample feeds every piece').toEqual([`${input.key}->${op.key}:0`, `${input.key}->${op.key}:1`]);
		expect(body.wires.filter((w) => w.from.key === op.key).map((w) => w.from.row).sort(), 'one wire out of each piece').toEqual([0, 1]);
		await expect(createButton(page)).toHaveText('Create 2 operations, 2 samples');
	});

	// ---- 5. layout (R6) ------------------------------------------------------------------------------------------------------------
	test('no two cards overlap after Add, Duplicate x4 and picking three samples (R6)', async ({ page }) => {
		await openNewDraft(page);
		await pickSamples(page, ['LOCAL-RAW-1', 'LOCAL-RAW-2', 'LOCAL-BAR-1']);
		expect(await settledOverlaps(page), 'after picking three samples').toEqual([]);
		await addFromLid(page, /^New sample/);
		await expect(card(page, 'New sample, Sample')).toHaveCount(1);
		expect(await settledOverlaps(page), 'after Add: a new sample').toEqual([]);
		await addFromLid(page, /CNC Turning/);
		await expect(card(page, /, Operation$/)).toHaveCount(1);
		expect(await settledOverlaps(page), 'after Add: an operation').toEqual([]);
		await selectCard(page, card(page, 'New sample, Sample'));
		await duplicateMany(page, 4);
		await expect(card(page, 'New sample, Sample')).toHaveCount(5);
		expect(await settledOverlaps(page), 'after Duplicate x4').toEqual([]);
		// Duplicating the operation too (a card that is wider than a sample).
		await selectCard(page, card(page, /, Operation$/));
		await page.keyboard.press('Shift+D');
		await expect(card(page, /, Operation$/)).toHaveCount(2);
		expect(await settledOverlaps(page), 'after Duplicate of the operation').toEqual([]);
		// Undo and redo leave no overlap either.
		await page.keyboard.press('Control+z');
		await expect(card(page, /, Operation$/)).toHaveCount(1);
		expect(await settledOverlaps(page), 'after undo').toEqual([]);
		await page.keyboard.press('Control+Shift+z');
		await expect(card(page, /, Operation$/)).toHaveCount(2);
		expect(await settledOverlaps(page), 'after redo').toEqual([]);
	});

	test('a card the person dragged keeps its position after a reload, with the cards around it left alone (R6)', async ({ page }) => {
		await openNewDraft(page);
		await addFromLid(page, /^New sample/);
		await addFromLid(page, /^New sample/);
		await expect(card(page, 'New sample, Sample')).toHaveCount(2);
		await settledOverlaps(page);
		await fit(page);
		// By its id: the order of the cards in the page changes as they are dragged.
		const id = (await card(page, 'New sample, Sample').first().getAttribute('data-id'))!;
		const mover = canvasOf(page).locator(`.vue-flow__node[data-id="${id}"]`);
		const key = id.replace(/^s:draft:/, '');
		const was = await flowPos(mover);
		// Drag it down and to the left, well away from where it was put.
		await dragCard(page, mover, { x: -60, y: 150 });
		await expect.poll(async () => (await flowPos(mover)).y, { message: 'the card moved with the pointer' }).toBeGreaterThan(was.y + 20);
		const dragged = await flowPos(mover);
		const saved = await savedDraft(page, member, (b) => !!b.positions[key] && Math.abs(b.positions[key].y - dragged.y) < 1, 'the dragged position saved');
		expect(saved.positions[key].x).toBeCloseTo(dragged.x, 0);
		// Something else is added: the dragged card does not move.
		await addFromLid(page, /CNC Turning/);
		await settledOverlaps(page);
		const afterAdd = await flowPos(mover);
		expect(afterAdd.x, 'x after adding something').toBeCloseTo(dragged.x, 0);
		expect(afterAdd.y, 'y after adding something').toBeCloseTo(dragged.y, 0);
		await savedDraft(page, member, (b) => b.items.length === 3, 'the operation saved');
		await page.reload();
		await expect(card(page, 'New sample, Sample')).toHaveCount(2);
		await settledOverlaps(page);
		const after = await flowPos(mover);
		expect(after.x, 'x after the reload').toBeCloseTo(dragged.x, 0);
		expect(after.y, 'y after the reload').toBeCloseTo(dragged.y, 0);
	});

	test('dragging one card moves only that card: the selected card, and a recorded one, stay where they are (R6)', async ({ page }) => {
		const bar1 = await sampleIdOf(admin, 'LOCAL-BAR-1');
		// The map opens with BAR-1 (the focus) selected: a recorded card.
		await startEditingMapOf(page, 'physical_samples', bar1);
		await addFromLid(page, /^New sample/);
		await settledOverlaps(page);
		await fit(page);
		const focus = card(page, 'LOCAL-BAR-1, Sample');
		const loose = card(page, 'New sample, Sample');
		const [focusWas, looseWas] = [await flowPos(focus), await flowPos(loose)];
		await dragCard(page, loose, { x: 0, y: 150 });
		await expect.poll(async () => (await flowPos(loose)).y, { message: 'the dragged card moved down' }).toBeGreaterThan(looseWas.y + 40);
		expect(await flowPos(focus), 'the recorded, selected card did not move with it').toEqual(focusWas);
		// Select another card, then drag the first again: the one selected does not follow.
		const material = card(page, 'AA, Material');
		const [materialWas, looseNow] = [await flowPos(material), await flowPos(loose)];
		await selectCard(page, material);
		await dragCard(page, loose, { x: 100, y: 0 });
		await expect.poll(async () => (await flowPos(loose)).x, { message: 'the dragged card moved right' }).toBeGreaterThan(looseNow.x + 40);
		expect(await flowPos(material), 'the selected material did not follow the drag').toEqual(materialWas);
		expect(await flowPos(focus)).toEqual(focusWas);
	});

	test('Tidy lays the draft out again, leaves recorded cards where they are, and one Ctrl+Z puts the draft cards back (R6)', async ({ page }) => {
		const bar1 = await sampleIdOf(admin, 'LOCAL-BAR-1');
		const bar2 = await sampleIdOf(admin, 'LOCAL-BAR-2');
		await startEditingMapOf(page, 'physical_samples', bar1);
		await expect(card(page, 'LOCAL-BAR-2, Sample')).toBeVisible();
		await settledOverlaps(page);
		// Every card on the map now is recorded history (the draft is still empty): these must stay put through everything below.
		const history = await flowPositions(page);
		const recordedIds = Object.keys(history);
		// Build from a recorded sample (it joins the draft as an existing item), and add loose cards of the draft's own.
		await chooseFromSocketMenu(page, sockOf(page, `sample|${bar2}|out`).first(), /CNC Turning/);
		await addFromLid(page, /^New sample/);
		await addFromLid(page, /^New sample/);
		await expect(card(page, 'New sample, Sample')).toHaveCount(2);
		await settledOverlaps(page);
		await fit(page);
		// A mess: drag the two loose samples on top of the operation the draft added.
		const target = await boxOf(card(page, /, Operation$/).and(page.locator('[data-id^="op:draft:"]')));
		const looseIds = await card(page, 'New sample, Sample').evaluateAll((els) => els.map((e) => e.getAttribute('data-id')!));
		for (const loose of looseIds.map((lid) => canvasOf(page).locator(`.vue-flow__node[data-id="${lid}"]`))) {
			await dragCard(page, loose, null, { x: target.x + 60, y: target.y + 16 });
		}
		const messy = await flowPositions(page);
		const draftIds = Object.keys(messy).filter((id) => id.includes('draft:'));
		expect(draftIds.length, 'the loose samples and the operation of the draft').toBeGreaterThanOrEqual(3);
		const savedBefore = await savedDraft(page, member, (b) => Object.keys(b.positions).length >= 2, 'the dragged positions saved');

		await page.getByRole('button', { name: /^Tidy$/ }).click();
		await expect.poll(async () => JSON.stringify(await flowPositions(page)) !== JSON.stringify(messy), { message: 'Tidy moved something' }).toBe(true);
		expect(await settledOverlaps(page), 'after Tidy').toEqual([]);
		const tidy = await flowPositions(page);
		for (const id of recordedIds) expect(tidy[id], `recorded card ${id} did not move`).toEqual(history[id]);
		expect(draftIds.some((id) => tidy[id].x !== messy[id].x || tidy[id].y !== messy[id].y), 'a card of the draft moved').toBe(true);
		await savedDraft(page, member, (b) => JSON.stringify(b.positions) !== JSON.stringify(savedBefore.positions), 'Tidy saved');

		// One Ctrl+Z puts every draft card back where it was (and removes nothing else).
		await page.keyboard.press('Control+z');
		await expect.poll(async () => JSON.stringify(await flowPositions(page)), { message: 'undo restored the positions' }).toBe(JSON.stringify(messy));
		const undone = await savedDraft(page, member, (b) => JSON.stringify(b.positions) === JSON.stringify(savedBefore.positions), 'undo saved the old positions');
		expect(undone.items, 'undo took back Tidy and nothing else').toHaveLength(savedBefore.items.length);
	});

	// ---- 6. Mark done and Back to planned (R10, plain fix 13) -----------------------------------------------------------------------
	const markDoneButton = (page: Page) => page.getByRole('button', { name: 'Mark done', exact: true });
	/** Selects the operation's card in view mode and runs the Mark done dialog as a person would (the default date and person). */
	async function markDoneInBrowser(page: Page, operationId: string): Promise<void> {
		await page.goto(`${STAR}/map?focus=manufacturing_operations:${operationId}`, { waitUntil: 'domcontentloaded' });
		const operation = cards(page).and(page.locator(`[data-id="op:${operationId}"]`));
		await expect(operation).toBeVisible();
		await selectCard(page, operation);
		await markDoneButton(page).click();
		const dialog = page.getByRole('dialog', { name: /Mark/ });
		await expect(dialog).toBeVisible();
		const answered = page.waitForResponse((r) => r.url().endsWith('/d1-build/mark-done') && r.request().method() === 'POST');
		await dialog.getByRole('button', { name: 'Mark done', exact: true }).click();
		expect((await answered).status()).toBe(200);
		await expect(dialog).toBeHidden();
	}

	test('Mark done by the owner of the operation: done, done_at and done_by_person_id are set, and the planned output sample is active (R10)', async ({ page }) => {
		const { operationId, sampleId } = await makePlanned(member, admin, 'LOCAL-RAW-2', noteMade);
		// What the output sample's form needs before it can be made active (the server asks for it, with system rights).
		const [method] = await listRecords<{ method_id: string }>(admin, 'manufacturing_methods', 'filter[method_code][_eq]=MC&fields=method_id');
		expect((await member.patch(`${D1}/items/physical_samples/${sampleId}`, { data: { primary_method_id: method.method_id } })).ok()).toBeTruthy();
		await markDoneInBrowser(page, operationId);
		const op = await readRecord<{ work_state: string; done_at: string | null; done_by_person_id: string | null; operation_date: string | null }>(
			member, 'manufacturing_operations', operationId, 'work_state,done_at,done_by_person_id,operation_date',
		);
		expect(op.work_state).toBe('done');
		expect(op.done_at, 'done_at is set').toBeTruthy();
		expect(op.done_by_person_id, 'marked done by the member').toBe(memberPerson);
		expect(op.operation_date, 'the date it was done').toBeTruthy();
		expect((await readRecord<{ current_status: string }>(member, 'physical_samples', sampleId, 'current_status')).current_status, 'the planned output turned active').toBe('active');
		// The map shows it: the sample card says Active now.
		await expect(page.getByRole('group', { name: /^LOCAL-PLN-.*, Sample$/ }).getByText('Active')).toBeVisible();
	});

	test('Mark done when the member may edit the operation but not its output sample: the status flip uses system rights (R10)', async ({ page }) => {
		const made2 = await makeTechSituation(admin, member, noteMade);
		// The situation is real: the member may write the operation, and the sample is refused to them.
		expect((await member.patch(`${D1}/items/physical_samples/${made2.sampleId}`, { data: { notes: 'x' } })).status(), 'the member may not edit the output sample').toBe(403);
		expect((await member.patch(`${D1}/items/manufacturing_operations/${made2.operationId}`, { data: { outcome_notes: 'x' } })).ok(), 'but may edit the operation').toBeTruthy();
		await markDoneInBrowser(page, made2.operationId);
		const op = await readRecord<{ work_state: string; done_by_person_id: string }>(member, 'manufacturing_operations', made2.operationId, 'work_state,done_by_person_id');
		expect(op).toEqual({ work_state: 'done', done_by_person_id: memberPerson });
		expect((await listRecords<{ current_status: string }>(admin, 'physical_samples', `filter[sample_id][_eq]=${made2.sampleId}&fields=current_status`))[0].current_status).toBe('active');
		// Nothing else about the sample changed: the flip touches current_status only.
		const sample = (await listRecords<{ notes: string | null; owner_person_id: string }>(admin, 'physical_samples', `filter[sample_id][_eq]=${made2.sampleId}&fields=notes,owner_person_id`))[0];
		expect(sample.notes).toBeNull();
		expect(sample.owner_person_id, 'still the admin person\'s').toBe(made2.ownerPersonId);
	});

	test('Back to planned by the owner: the operation and its output go back to planned (plain fix 13)', async ({ page }) => {
		const { operationId, sampleId } = await makePlanned(member, admin, 'LOCAL-RAW-2', noteMade);
		const [method] = await listRecords<{ method_id: string }>(admin, 'manufacturing_methods', 'filter[method_code][_eq]=MC&fields=method_id');
		await member.patch(`${D1}/items/physical_samples/${sampleId}`, { data: { primary_method_id: method.method_id } });
		await markDoneInBrowser(page, operationId);
		await expect(page.getByRole('button', { name: 'Back to planned', exact: true })).toBeVisible();
		const answered = page.waitForResponse((r) => r.url().endsWith('/d1-build/mark-planned') && r.request().method() === 'POST');
		await page.getByRole('button', { name: 'Back to planned', exact: true }).click();
		expect((await answered).status()).toBe(200);
		const op = await readRecord<{ work_state: string; done_at: string | null; done_by_person_id: string | null }>(member, 'manufacturing_operations', operationId, 'work_state,done_at,done_by_person_id');
		expect(op).toEqual({ work_state: 'planned', done_at: null, done_by_person_id: null });
		expect((await readRecord<{ current_status: string }>(member, 'physical_samples', sampleId, 'current_status')).current_status).toBe('planned');
		await expect(markDoneButton(page)).toBeVisible();
	});

	test('Back to planned is refused to a Lab Member who does not own the operation, and nothing changes (plain fix 13)', async ({ playwright }) => {
		const { operationId, sampleId } = await makePlanned(member, admin, 'LOCAL-RAW-2', noteMade);
		const [method] = await listRecords<{ method_id: string }>(admin, 'manufacturing_methods', 'filter[method_code][_eq]=MC&fields=method_id');
		await member.patch(`${D1}/items/physical_samples/${sampleId}`, { data: { primary_method_id: method.method_id } });
		expect((await member.post(`${D1}/d1-build/mark-done`, { data: { collection: 'manufacturing_operations', ids: [operationId] } })).ok()).toBeTruthy();
		// A second Lab Member who may EDIT the operation (the owner shares it with them) without owning it.
		const other = await secondMember(playwright, admin, noteUser);
		const shared = await member.post(`${D1}/d1-record-access/manufacturing_operations/${operationId}/entries`, { data: { person_id: other.personId, role: 'edit' } });
		expect(shared.ok(), await shared.text()).toBeTruthy();
		expect((await other.api.patch(`${D1}/items/manufacturing_operations/${operationId}`, { data: { outcome_notes: 'edited by the second member' } })).ok(), 'the second member may edit it').toBeTruthy();
		const refused = await other.api.post(`${D1}/d1-build/mark-planned`, { data: { collection: 'manufacturing_operations', ids: [operationId] } });
		expect(refused.status(), await refused.text()).toBe(403);
		expect((await readRecord<{ work_state: string }>(member, 'manufacturing_operations', operationId, 'work_state')).work_state, 'still done').toBe('done');
		expect((await readRecord<{ current_status: string }>(member, 'physical_samples', sampleId, 'current_status')).current_status, 'its output is still active').toBe('active');
	});

	test('Back to planned by an operation owner who cannot edit the output sample (the technician above) is not refused (design gap, see the report)', async () => {
		// R10 lets the technician Mark done with system rights, but /mark-planned writes the output sample with the caller's own rights, so the
		// same person gets a 403 on the way back and the operation stays done. Not in R10's wording ("Mark done by whoever may edit the
		// operation"; Back to planned "owner rules unchanged"): a design question, so this is a known failure, not a fix.
		test.fail(true, 'design gap: /mark-planned flips the output sample with the caller\'s rights, not system rights');
		const made2 = await makeTechSituation(admin, member, noteMade);
		expect((await member.post(`${D1}/d1-build/mark-done`, { data: { collection: 'manufacturing_operations', ids: [made2.operationId] } })).ok()).toBeTruthy();
		const back = await member.post(`${D1}/d1-build/mark-planned`, { data: { collection: 'manufacturing_operations', ids: [made2.operationId] } });
		expect(back.status(), await back.text()).toBe(200);
	});

	// ---- d1-build writes test_category and the inherited material (plain fix 7, slice 1a) ------------------------------------------
	test('a Create with a new test and a new operation: test_category is filled and the operation inherits its sample\'s material, read back through REST (spec section 3, item 7)', async ({ page }) => {
		const rawId = await sampleIdOf(admin, 'LOCAL-RAW-1');
		const rawMaterial = (await readRecord<{ material_id: string }>(member, 'physical_samples', rawId, 'material_id')).material_id;
		expect(rawMaterial, 'the seed sample has a material').toBeTruthy();
		await openNewDraft(page);
		await pickSamples(page, ['LOCAL-RAW-1']);
		await chooseFromSocketMenu(page, sockOf(page, `sample|${rawId}|out`).first(), /CNC Turning/);
		await chooseFromSocketMenu(page, sockOf(page, `sample|${rawId}|out`).first(), /Tensile/i);
		await expect(createButton(page)).toHaveText('Create 1 operation, 1 test');
		await expect(createButton(page)).toBeEnabled();
		const { status, body } = await pressCreate(page, noteMade);
		expect(status, JSON.stringify(body)).toBe(200);
		const records = distinctRecords(body.data!.created);
		const operation = records.find((r) => r.collection === 'manufacturing_operations')!;
		const test_ = records.find((r) => r.collection === 'test_sessions')!;
		const op = await readRecord<{ material_id: string | null; sample_id: string; work_state: string }>(member, 'manufacturing_operations', operation.id, 'material_id,sample_id,work_state');
		expect(op.material_id, 'the operation inherited its input sample\'s material').toBe(rawMaterial);
		const t = await readRecord<{ test_category: string | null; test_type: string; work_state: string; sample_id: string }>(member, 'test_sessions', test_.id, 'test_category,test_type,work_state,sample_id');
		expect(t.test_type).toBe('tensile');
		expect(t.test_category, 'test_category is filled (not null)').toBeTruthy();
		expect(t.work_state).toBe('planned');
		expect(t.sample_id, 'the test is on the picked sample').toBe(rawId);
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
