import { test, expect, type APIRequestContext } from '@playwright/test';
import { D1, apiAs, listRecords, readRecord, signIn, stackAvailable } from '../starbase/localStack';
import {
	addSearch, boxOf, buildTurningWithNewSample, canvasMiddle, canvasOf, card, cards, centreOf, createButton, distinctRecords, dragEntryTo, draftIdOf, emptySpot, holdEntryOver, openAddSearch, openNewDraft,
	paletteEntry, paletteOf, pickSamples, pressCreate, readDraft, sampleIdOf, savedDraft, searchFromSocket, searchOptions, selectCard, settledOverlaps, sockOf, startEditingMapOf, wireBetween, wireMidpoint,
	type DraftBody, type Ref,
} from '../starbase/mapEdit';

/**
 * Slice 2a of the process map edit mode redesign (R1 the palette and the add search, R2 drops on the empty canvas, a socket and a wire, and
 * insert before / after, R3 "Add an earlier step" for a done sample) in a REAL browser against the LOCAL STACK, as the seeded Lab Member.
 * The plan: docs/superpowers/plans/2026-10-18-process-map-edit-redesign.md; the rules: docs/superpowers/specs/2026-10-18-process-map-edit-mode-redesign.md.
 *
 *   bash scripts/dev/local-stack.sh up
 *   cd tests/ui && npx playwright test -c playwright.local-stack.config.ts specs/edit-mode-slice2a.spec.ts
 *
 * Everything a test makes is removed again afterwards through the admin API, and the drafts the member leaves are deleted, so the suite can
 * run again on the same stack. No sleeps: waits are for something on the page or for what the server holds (`savedDraft` polls the draft).
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
			if (collection !== 'physical_samples') await admin.post(`${D1}/d1-build/mark-planned`, { data: { collection, ids: [ref.id] } });
			const r = await admin.delete(`${D1}/items/${collection}/${ref.id}`);
			if (!r.ok() && r.status() !== 404) console.warn(`clean-up: DELETE ${collection}/${ref.id} answered ${r.status()}: ${await r.text()}`);
		}
	}
	made.length = 0;
});

const wiresOf = (b: DraftBody): string[] => b.wires.map((w) => `${w.from.key}${w.from.row !== undefined ? `.${w.from.row}` : ''}>${w.to.key}${w.to.row !== undefined ? `.${w.to.row}` : ''}`).sort();
const operations = (b: DraftBody) => b.items.filter((i) => i.kind === 'operation');

test.describe('as a Lab Member', () => {
	test.beforeEach(async ({ page }) => {
		await signIn(page, 'member');
	});

	// ---- R1: the palette -------------------------------------------------------------------------------------------------------------
	test('the palette lists the one catalog by process category; its search narrows it; it folds, and stays folded after a reload (R1)', async ({ page }) => {
		await openNewDraft(page);
		const palette = paletteOf(page);
		await expect(palette).toBeVisible();
		for (const head of ['Samples', 'Machining', 'Tests']) await expect(palette.locator('.sec', { hasText: head })).toBeVisible();
		await expect(paletteEntry(page, 'New sample')).toBeVisible();
		await expect(paletteEntry(page, 'Existing sample…')).toBeVisible();
		await expect(paletteEntry(page, /^CNC Turning/)).toBeVisible();
		await expect(paletteEntry(page, /^Tensile/)).toBeVisible();

		// A search matches the method name, its code, its category and a test type; "MC" is CNC Turning's code.
		await palette.getByRole('searchbox', { name: 'Search the palette' }).fill('mc');
		await expect(paletteEntry(page, /CNC Turning/)).toBeVisible();
		await expect(paletteEntry(page, /Tensile/)).toHaveCount(0);
		await palette.getByRole('searchbox', { name: 'Search the palette' }).fill('tensile');
		await expect(palette.locator('.pe')).toHaveCount(1);
		await palette.getByRole('searchbox', { name: 'Search the palette' }).fill('zzzz');
		await expect(palette.getByText('Nothing fits what you typed.')).toBeVisible();
		await palette.getByRole('searchbox', { name: 'Search the palette' }).fill('');

		// Folded to a rail; remembered for this person across a reload.
		await palette.getByRole('button', { name: 'Fold the palette' }).click();
		await expect(palette.locator('.pe')).toHaveCount(0);
		await page.reload({ waitUntil: 'domcontentloaded' });
		await expect(paletteOf(page).getByRole('button', { name: 'Open the palette' })).toBeVisible();
		await expect(paletteOf(page).locator('.pe')).toHaveCount(0);
		await paletteOf(page).getByRole('button', { name: 'Open the palette' }).click();
		await page.reload({ waitUntil: 'domcontentloaded' });
		await expect(paletteEntry(page, /^CNC Turning/)).toBeVisible();
	});

	// ---- R2: drops -------------------------------------------------------------------------------------------------------------------
	test('dragging an operation and a test from the palette onto the empty canvas makes floating cards where the pointer let go; undo takes them back (R2)', async ({ page }) => {
		await openNewDraft(page);
		const where = await canvasMiddle(page);
		await dragEntryTo(page, paletteEntry(page, /^CNC Turning/), where);
		const operation = card(page, 'CNC Turning, Operation');
		await expect(operation).toBeVisible();
		let body = await savedDraft(page, member, (b) => operations(b).length === 1, 'the floating operation');
		expect(body.wires, 'a floating card has no wire').toEqual([]);
		expect(operations(body)[0].values.method_id, 'the method of the entry').toBeTruthy();
		expect(operations(body)[0].workState, 'a new operation is planned').toBe('planned');
		// It lands where the pointer was (the layout may step it aside from another card, not from an empty canvas).
		const box = (await operation.boundingBox())!;
		expect(Math.abs(box.x - where.x), 'x of the card against where it was dropped').toBeLessThan(40);
		expect(Math.abs(box.y - where.y), 'y of the card against where it was dropped').toBeLessThan(40);

		// A second one dropped on the very same spot does not land on the first.
		await dragEntryTo(page, paletteEntry(page, /^Tensile/), where);
		await expect(card(page, /^Tensile.*, Test$/)).toBeVisible();
		body = await savedDraft(page, member, (b) => b.items.length === 2, 'the floating test');
		expect(body.wires).toEqual([]);
		expect(await settledOverlaps(page), 'no two cards overlap after the second drop').toEqual([]);

		await page.keyboard.press('Control+z');
		await page.keyboard.press('Control+z');
		await expect(cards(page)).toHaveCount(0);
		await savedDraft(page, member, (b) => b.items.length === 0, 'both drops undone');
	});

	test('a new sample dragged onto the empty canvas is a free card; Existing sample… opens the picker (R2)', async ({ page }) => {
		await openNewDraft(page);
		await dragEntryTo(page, paletteEntry(page, 'New sample'), await canvasMiddle(page));
		await expect(card(page, 'New sample, Sample')).toBeVisible();
		await savedDraft(page, member, (b) => b.items.length === 1 && b.items[0].kind === 'sample' && !b.items[0].existing, 'a free new sample');
		await paletteEntry(page, 'Existing sample…').click();
		await expect(page.getByRole('dialog', { name: 'Pick samples' })).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(page.getByRole('dialog', { name: 'Pick samples' })).toBeHidden();
	});

	test('dropping on a free sample socket connects there; where it does not fit the drop is refused with the reason and nothing changes (R2)', async ({ page }) => {
		await openNewDraft(page);
		const id = await sampleIdOf(member, 'LOCAL-RAW-1');
		await pickSamples(page, ['LOCAL-RAW-1']);
		const free = sockOf(page, `sample|${id}|out`).first();
		await dragEntryTo(page, paletteEntry(page, /^CNC Turning/), centreOf(await boxOf(free)));
		await expect(card(page, 'CNC Turning, Operation')).toBeVisible();
		let body = await savedDraft(page, member, (b) => b.items.length === 2 && b.wires.length === 1, 'the operation wired from the sample');
		expect(body.wires[0].from.key).toBe(body.items.find((i) => i.existing)!.key);

		// The operation's own output takes a sample, not another operation: refused with the reason.
		const out = canvasOf(page).locator('[data-sock^="row|draft:"][data-sock$="|out"]').first();
		await holdEntryOver(page, paletteEntry(page, /^CNC Turning/), centreOf(await boxOf(out)));
		await expect(out).toHaveClass(/drop-bad/);
		await expect(page.locator('.pm-chip')).toContainText('output takes a sample');
		await page.mouse.up();
		await expect(cards(page).filter({ hasText: /CNC Turning/ })).toHaveCount(1);
		body = await readDraft(member, draftIdOf(page));
		expect(body.items, 'the refused drop changed nothing').toHaveLength(2);

		// A new sample fits it, and is what the operation makes.
		await dragEntryTo(page, paletteEntry(page, 'New sample'), centreOf(await boxOf(out)));
		await expect(card(page, 'New sample, Sample')).toBeVisible();
		body = await savedDraft(page, member, (b) => b.items.length === 3 && b.wires.length === 2, 'the new sample made by the operation');
		expect(await settledOverlaps(page)).toEqual([]);
	});

	test('dropping on a wire inserts between its two ends as one undo step; undo restores exactly what was there (R2)', async ({ page }) => {
		await buildTurningWithNewSample(page, member, 'LOCAL-RAW-1');
		const before = await savedDraft(page, member, (b) => b.items.length === 3 && b.wires.length === 2, 'sample, operation, new sample');
		await page.getByRole('button', { name: /^Fit$/ }).click();
		const wire = wireBetween(page, 'op:draft:', 's:draft:');
		await expect(wire).toHaveCount(1);
		const mid = await wireMidpoint(wire);

		// While dragging, the wire is marked green: it takes the entry.
		await holdEntryOver(page, paletteEntry(page, /^CNC Milling/), mid);
		await expect(page.locator('.d1-wire.drop-ok')).toHaveCount(1);
		await expect(page.locator('.pm-chip')).toContainText('Insert between the two ends');
		await page.mouse.up();

		await expect(cards(page).filter({ hasText: /CNC Milling/ })).toHaveCount(1);
		const after = await savedDraft(page, member, (b) => b.items.length === 5, 'the milling and the sample it makes inserted');
		expect(operations(after)).toHaveLength(2);
		expect(after.wires, 'two wires more: the old one is replaced by three').toHaveLength(4);
		// The turning's output no longer goes straight to the old new sample: milling and a new sample are between them.
		const turning = operations(before)[0].key;
		expect(after.wires.some((w) => w.from.key === turning && after.items.find((i) => i.key === w.to.key)?.kind === 'sample' && w.to.key !== operations(before)[0].key && !before.items.some((i) => i.key === w.to.key))).toBe(true);
		expect(after.wires.filter((w) => before.items.some((i) => i.key === w.to.key && i.kind === 'sample' && !i.existing)).every((w) => after.items.find((i) => i.key === w.from.key)?.kind === 'operation')).toBe(true);
		expect(await settledOverlaps(page), 'no two cards overlap after the insert').toEqual([]);

		// One Ctrl+Z puts the draft back as it was.
		await page.keyboard.press('Control+z');
		await expect(cards(page).filter({ hasText: /CNC Milling/ })).toHaveCount(0);
		const undone = await savedDraft(page, member, (b) => b.items.length === 3, 'undo took the insert back in one step');
		expect(wiresOf(undone)).toEqual(wiresOf(before));
		expect(undone.items.map((i) => i.key)).toEqual(before.items.map((i) => i.key));
		await page.keyboard.press('Control+Shift+z');
		await savedDraft(page, member, (b) => b.items.length === 5, 'redo did it again');
	});

	test('dropping on the wire from a sample to its operation puts the new operation in front of it (R2)', async ({ page }) => {
		await buildTurningWithNewSample(page, member, 'LOCAL-RAW-1');
		await page.getByRole('button', { name: /^Fit$/ }).click();
		const wire = wireBetween(page, 's:', 'op:draft:');
		await expect(wire).toHaveCount(1);
		await dragEntryTo(page, paletteEntry(page, /^Heat Treatment/), await wireMidpoint(wire));
		await expect(card(page, 'Heat Treatment, Operation')).toBeVisible();
		const body = await savedDraft(page, member, (b) => b.items.length === 5, 'heat treatment and its new sample in front of the turning');
		const heat = operations(body).find((o) => o.key !== operations(body)[0].key)!;
		const turning = operations(body).find((o) => o.key !== heat.key)!;
		// sample -> heat treatment -> new sample -> turning -> new sample
		const into = (key: string) => body.wires.find((w) => w.to.key === key)!;
		expect(body.items.find((i) => i.key === into(heat.key).from.key)?.existing, 'the picked sample feeds the new operation').toBeTruthy();
		const between = into(turning.key).from.key;
		expect(into(between).from.key, 'what the turning takes in is made by the heat treatment').toBe(heat.key);
		expect(await settledOverlaps(page)).toEqual([]);
	});

	test('a wire of done records refuses the drop with its reason and the wire shows red; nothing changes (R2, R4)', async ({ page }) => {
		const bar2 = await sampleIdOf(member, 'LOCAL-BAR-2');
		await startEditingMapOf(page, 'physical_samples', bar2);
		await page.getByRole('button', { name: /^Fit$/ }).click();
		const done = wireBetween(page, 's:', 'op:');
		await expect(done.first()).toBeVisible();
		const mid = await wireMidpoint(done.first());
		const before = await readDraft(member, draftIdOf(page));
		await holdEntryOver(page, paletteEntry(page, /^CNC Milling/), mid);
		await expect(page.locator('.d1-wire.drop-bad')).toHaveCount(1);
		await expect(page.locator('.pm-chip')).toContainText("Done records' wires can't be changed from the map");
		await page.mouse.up();
		await expect(page.locator('.pm-wirepreview .tip')).toContainText("Done records' wires can't be changed from the map");
		await expect(cards(page).filter({ hasText: /CNC Milling/ })).toHaveCount(0);
		expect(await readDraft(member, draftIdOf(page)), 'the draft is as it was').toEqual(before);
	});

	test('Enter on a palette entry adds it next to the selected card, or at the middle of the canvas; no two cards overlap (R1)', async ({ page }) => {
		await openNewDraft(page);
		await paletteEntry(page, 'New sample').focus();
		await page.keyboard.press('Enter');
		const first = card(page, 'New sample, Sample');
		await expect(first).toBeVisible();
		await savedDraft(page, member, (b) => b.items.length === 1, 'the first card');
		await selectCard(page, first);
		await paletteEntry(page, /^CNC Turning/).focus();
		await page.keyboard.press('Enter');
		await expect(card(page, 'CNC Turning, Operation')).toBeVisible();
		await savedDraft(page, member, (b) => b.items.length === 2 && b.wires.length === 0, 'the operation, floating beside the card');
		expect(await settledOverlaps(page)).toEqual([]);
	});

	// ---- R1: the add search ------------------------------------------------------------------------------------------------------------
	test('Shift+A and Ctrl+K open the add search; typing narrows it; Enter adds the top hit; Esc closes it and adds nothing (R1)', async ({ page }) => {
		await openNewDraft(page);
		await openAddSearch(page, 'Shift+A');
		await expect(page.getByRole('dialog')).toHaveCount(1);
		await page.keyboard.type('tens');
		expect((await searchOptions(page))[0]).toBe('Tensile');
		// Esc closes it and nothing was added.
		await page.keyboard.press('Escape');
		await expect(addSearch(page)).toBeHidden();
		await expect(cards(page)).toHaveCount(0);

		// Ctrl+K opens the same search, not the shell's Finder.
		await openAddSearch(page, 'Control+k');
		await expect(page.getByRole('dialog')).toHaveCount(1);
		await expect(page.locator('.d1-finder')).toHaveCount(0);
		// Nothing fits: nothing is added by Enter.
		await page.keyboard.type('zzzz');
		await expect(addSearch(page).getByText('Nothing fits what you typed.')).toBeVisible();
		await page.keyboard.press('Enter');
		await expect(addSearch(page)).toBeVisible();
		await page.keyboard.press('Control+a');
		// A method's code and its category find it; the best match is first, and Enter adds it.
		await page.keyboard.type('mc');
		expect(await searchOptions(page)).toEqual(['CNC Turning']);
		await page.keyboard.press('Control+a');
		await page.keyboard.type('machining');
		expect(await searchOptions(page)).toEqual(['CNC Milling', 'CNC Turning']);
		await page.keyboard.press('Control+a');
		await page.keyboard.type('turn');
		await page.keyboard.press('Enter');
		await expect(addSearch(page)).toBeHidden();
		await expect(card(page, 'CNC Turning, Operation')).toBeVisible();
		await savedDraft(page, member, (b) => operations(b).length === 1 && b.wires.length === 0, 'the operation, floating');
		expect(await settledOverlaps(page)).toEqual([]);
	});

	test('from a free socket the add search lists only what can connect there, and what is chosen is connected to it (R2)', async ({ page }) => {
		await openNewDraft(page);
		const id = await sampleIdOf(member, 'LOCAL-RAW-1');
		await pickSamples(page, ['LOCAL-RAW-1']);

		// A sample's output: operations and tests (no samples).
		await sockOf(page, `sample|${id}|out`).first().press('Enter');
		let options = await searchOptions(page);
		expect(options).toContain('CNC Turning');
		expect(options).toContain('Tensile');
		expect(options).not.toContain('New sample');
		expect(options).not.toContain('Existing sample…');
		await page.keyboard.type('turn');
		await page.keyboard.press('Enter');
		await expect(card(page, 'CNC Turning, Operation')).toBeVisible();
		await savedDraft(page, member, (b) => b.items.length === 2 && b.wires.length === 1, 'the operation wired from the sample, by Enter on the top hit');

		// An operation's output: the samples it can make, no operations.
		const out = canvasOf(page).locator('[data-sock^="row|draft:"][data-sock$="|out"]').first();
		await out.press('Enter');
		options = await searchOptions(page);
		expect(options).toEqual(expect.arrayContaining(['New sample', 'Same sample', 'Existing sample…']));
		expect(options).not.toContain('CNC Turning');
		expect(options).not.toContain('Tensile');
		await page.keyboard.press('Escape');

		// A free input of a new operation: samples that could feed it.
		await dragEntryTo(page, paletteEntry(page, /^CNC Milling/), await emptySpot(page));
		const input = canvasOf(page).locator('.free[data-sock^="row|draft:"][data-sock$="|in"]').first();
		await input.press('Enter');
		options = await searchOptions(page);
		expect(options.filter((o) => o !== 'Connect to…')).toEqual(['New sample', 'Existing sample…']);
		await page.keyboard.press('Escape');
		await expect(addSearch(page)).toBeHidden();
	});

	test('what was added lately comes first when the add search opens again, in the palette too, and after a reload (R1)', async ({ page }) => {
		await openNewDraft(page);
		await openAddSearch(page);
		expect((await searchOptions(page))[0], 'nothing added yet: the catalog starts with the samples').toBe('New sample');
		await page.keyboard.type('tensile');
		await page.keyboard.press('Enter');
		await expect(card(page, /^Tensile.*, Test$/)).toBeVisible();

		await openAddSearch(page);
		expect((await searchOptions(page))[0]).toBe('Tensile');
		await expect(addSearch(page).locator('.sec').first()).toHaveText('Recent');
		expect((await searchOptions(page)).filter((o) => o === 'Tensile'), 'listed once, not in two places').toHaveLength(1);
		await page.keyboard.press('Escape');
		await expect(paletteOf(page).locator('.sec').first()).toHaveText('Recent');
		await expect(paletteOf(page).locator('.pe').first()).toContainText('Tensile');

		await page.reload({ waitUntil: 'domcontentloaded' });
		await expect(paletteOf(page).locator('.pe').first()).toContainText('Tensile');
	});

	// ---- R2: insert before and after; R3 ---------------------------------------------------------------------------------------------
	test('Shift+I on a new sample something makes inserts an operation before it, with the same undo as a drop (R2)', async ({ page }) => {
		await buildTurningWithNewSample(page, member, 'LOCAL-RAW-1');
		const before = await savedDraft(page, member, (b) => b.items.length === 3 && b.wires.length === 2, 'sample, operation, new sample');
		const sample = card(page, 'New sample, Sample');
		await selectCard(page, sample);
		await page.keyboard.press('Shift+I');
		await expect(addSearch(page)).toBeVisible();
		await expect(page.getByRole('dialog', { name: 'Insert before New sample' })).toBeVisible();
		const options = await searchOptions(page);
		expect(options).toContain('CNC Turning');
		expect(options, 'only operations can go before a sample').not.toContain('Tensile');
		expect(options).not.toContain('New sample');
		await page.keyboard.type('milling');
		await page.keyboard.press('Enter');
		await expect(card(page, 'CNC Milling, Operation')).toBeVisible();
		const after = await savedDraft(page, member, (b) => b.items.length === 5, 'the milling and a sample before the new sample');
		expect(operations(after)).toHaveLength(2);
		expect(await settledOverlaps(page)).toEqual([]);
		await page.keyboard.press('Control+z');
		const undone = await savedDraft(page, member, (b) => b.items.length === 3, 'one undo');
		expect(wiresOf(undone)).toEqual(wiresOf(before));
	});

	test('Insert before a sample nothing makes: an operation makes it, with a new sample going in; I inserts after, between a sample and its operation (R2)', async ({ page }) => {
		await openNewDraft(page);
		await dragEntryTo(page, paletteEntry(page, 'New sample'), await canvasMiddle(page));
		const lone = card(page, 'New sample, Sample');
		await expect(lone).toBeVisible();
		await selectCard(page, lone);
		await page.keyboard.press('Shift+I');
		await page.keyboard.type('turn');
		await page.keyboard.press('Enter');
		await expect(card(page, 'CNC Turning, Operation')).toBeVisible();
		const body = await savedDraft(page, member, (b) => b.items.length === 3 && b.wires.length === 2, 'a turning that makes the sample, and a new sample going into it');
		expect(wiresOf(body)).toHaveLength(2);
		expect(await settledOverlaps(page)).toEqual([]);
		// I (after) on the operation that now has an output: between it and the sample it makes.
		await selectCard(page, card(page, 'CNC Turning, Operation'));
		await page.keyboard.press('i');
		await expect(addSearch(page)).toBeVisible();
		await page.keyboard.type('heat');
		await page.keyboard.press('Enter');
		await expect(card(page, 'Heat Treatment, Operation')).toBeVisible();
		await savedDraft(page, member, (b) => operations(b).length === 2 && b.items.length === 5, 'a heat treatment after the turning');
		expect(await settledOverlaps(page)).toEqual([]);
	});

	test('"Add an earlier step" on the done sample LOCAL-BAR-2 creates a new planned chain upstream and changes nothing about any done record (R3)', async ({ page }) => {
		const bar2 = await sampleIdOf(member, 'LOCAL-BAR-2');
		const snapshot = async () => ({
			sample: await readRecord<Record<string, unknown>>(admin, 'physical_samples', bar2, 'sample_id,sample_code,current_status,version,date_updated,owner_person_id'),
			maker: await listRecords<Record<string, unknown>>(admin, 'manufacturing_operations', `filter[output_sample_id][_eq]=${bar2}&fields=operation_id,sample_id,output_sample_id,work_state,version,date_updated&sort=operation_id`),
			asParent: await listRecords<Record<string, unknown>>(admin, 'sample_genealogy', `filter[parent_sample_id][_eq]=${bar2}&fields=parent_sample_id,child_sample_id`),
			asChild: await listRecords<Record<string, unknown>>(admin, 'sample_genealogy', `filter[child_sample_id][_eq]=${bar2}&fields=parent_sample_id,child_sample_id&sort=parent_sample_id`),
		});
		const before = await snapshot();
		await startEditingMapOf(page, 'physical_samples', bar2);
		const done = card(page, 'LOCAL-BAR-2, Sample');
		await selectCard(page, done);
		// "Before" a done sample offers one thing, and no operation that would be its new parent.
		await page.keyboard.press('Shift+I');
		await expect(page.getByRole('dialog', { name: 'Add an earlier step to LOCAL-BAR-2' })).toBeVisible();
		expect(await searchOptions(page)).toEqual(['Add an earlier step']);
		await page.keyboard.press('Enter');
		await expect(addSearch(page)).toBeHidden();

		// Three new cards: a planned sample, an operation of no method yet, the sample it makes. Not wired to LOCAL-BAR-2.
		const body = await savedDraft(page, member, (b) => b.items.length === 3, 'the earlier chain');
		expect(body.items.map((i) => i.kind)).toEqual(['sample', 'operation', 'sample']);
		expect(body.items.every((i) => !i.existing), 'the done sample is not even part of the draft').toBe(true);
		expect(body.wires).toHaveLength(2);
		const newSamples = cards(page).filter({ has: page.locator('.node.draft') }).and(page.getByRole('group', { name: 'New sample, Sample' }));
		await expect(newSamples).toHaveCount(2);
		expect(await settledOverlaps(page)).toEqual([]);

		// Fill in what a new sample and a planned operation need, then Create, and read everything back.
		await selectCard(page, newSamples.first());
		await page.getByPlaceholder(/Search materials/).fill('Ti-6Al');
		await page.getByRole('option', { name: /Ti-6Al-4V Grade 5/ }).click();
		await page.getByLabel(/^Geometry/).selectOption({ label: 'Cylinder' });
		await page.getByPlaceholder(/Search manufacturing methods/).fill('Turning');
		await page.getByRole('option', { name: /CNC Turning/ }).click();
		await selectCard(page, cards(page).filter({ hasText: /Operation$/ }).and(page.getByRole('group', { name: /Operation$/ })).first());
		await page.getByPlaceholder(/Search manufacturing methods/).fill('Turning');
		await page.getByRole('option', { name: /CNC Turning/ }).click();
		await expect(createButton(page)).toHaveText('Create 1 operation, 2 samples');
		await expect(createButton(page)).toBeEnabled();
		const { status, body: answer } = await pressCreate(page, noteMade);
		expect(status, JSON.stringify(answer)).toBe(200);
		const records = distinctRecords(answer.data!.created);
		expect(records.filter((r) => r.collection === 'manufacturing_operations')).toHaveLength(1);
		const [op] = records.filter((r) => r.collection === 'manufacturing_operations');
		const created = await readRecord<{ work_state: string; sample_id: string; output_sample_id: string }>(member, 'manufacturing_operations', op.id, 'work_state,sample_id,output_sample_id');
		expect(created.work_state, 'planned').toBe('planned');
		expect(created.sample_id, 'the new chain does not start from the done sample').not.toBe(bar2);
		expect(created.output_sample_id, 'and does not make it').not.toBe(bar2);
		const output = await readRecord<{ current_status: string }>(member, 'physical_samples', created.output_sample_id, 'current_status');
		expect(output.current_status, 'a planned operation makes a planned sample').toBe('planned');

		// The done records are exactly as they were: the sample, its maker, and no lineage row gained or lost.
		expect(await snapshot()).toEqual(before);
	});
});
