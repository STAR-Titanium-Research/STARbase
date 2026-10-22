import { test, expect, type APIRequestContext } from '@playwright/test';
import { D1, apiAs, getRetrying, listRecords, readRecord, signIn, stackAvailable } from '../starbase/localStack';
import {
	addSearch, buildTurningWithNewSample, canvasMiddle, canvasOf, card, cards, createButton, dragEntryTo, draftIdOf, emptySpot, fit, holdEntryOver, openAddSearch, openNewDraft,
	paletteEntry, paletteFind, paletteKind, paletteOf, pickSamples, reach, readDraft, sampleIdOf, savedDraft, searchOptions, selectCard, settledOverlaps, sockOf, startEditingMapOf, wireBetween, wireMidpoint,
	type DraftBody,
} from '../starbase/mapEdit';

/**
 * Slice 2a of the process map edit mode redesign (R1 the palette and the add search, R2 drops on the empty canvas, a socket and a wire, and
 * insert before / after, R3 "Insert before" refused on a recorded sample) in a REAL browser against the LOCAL STACK, as the seeded Lab Member.
 * The plan: docs/superpowers/plans/2026-10-18-process-map-edit-redesign.md; the rules: docs/superpowers/specs/2026-10-18-process-map-edit-mode-redesign.md.
 *
 *   bash scripts/dev/local-stack.sh up
 *   cd tests/ui && npx playwright test -c playwright.local-stack.config.ts specs/edit-mode-slice2a.spec.ts
 *
 * No test here creates a record; the drafts the member leaves are deleted, so the suite can
 * run again on the same stack. No sleeps: waits are for something on the page or for what the server holds (`savedDraft` polls the draft).
 */

let admin: APIRequestContext;
let member: APIRequestContext;

test.beforeAll(async ({ playwright }) => {
	test.skip(!stackAvailable(), 'the local stack is not up: run `bash scripts/dev/local-stack.sh up`');
	admin = await apiAs(playwright, 'admin');
	member = await apiAs(playwright, 'member');
});

async function deleteDrafts(api: APIRequestContext): Promise<void> {
	const r = await getRetrying(api, `${D1}/d1-build/drafts`);
	if (!r.ok()) return;
	for (const d of (await r.json()).data as { id: string }[]) await api.delete(`${D1}/d1-build/drafts/${d.id}`);
}

test.afterEach(async () => {
	if (!stackAvailable() || !admin) return;
	await deleteDrafts(member);
});

const wiresOf = (b: DraftBody): string[] => b.wires.map((w) => `${w.from.key}${w.from.row !== undefined ? `.${w.from.row}` : ''}>${w.to.key}${w.to.row !== undefined ? `.${w.to.row}` : ''}`).sort();
const operations = (b: DraftBody) => b.items.filter((i) => i.kind === 'operation');
/** What "Insert before" on a sample that already exists as a record says (insertModel.ts `BEFORE_RECORDED`, R3). */
const BEFORE_RECORDED = "Its history is recorded and can't change from the map. Start from a new sample instead.";

test.describe('as a Lab Member', () => {
	test.beforeEach(async ({ page }) => {
		await signIn(page, 'member');
	});

	// ---- R1: the palette -------------------------------------------------------------------------------------------------------------
	test('the palette lists the kinds; its search finds every method and test type; it folds, and stays folded after a reload (R1)', async ({ page }) => {
		await openNewDraft(page);
		const palette = paletteOf(page);
		await expect(palette).toBeVisible();
		// With nothing typed: the kinds (each in the map's icon) and From database…. The methods and test types are found by typing.
		await expect(palette.locator('.pe')).toHaveCount(4);
		for (const kind of ['sample', 'operation', 'test'] as const) await expect(await paletteKind(page, kind)).toBeVisible();
		await expect(palette.locator('.pe .ki')).toHaveCount(3);
		await expect(paletteEntry(page, /From database/)).toBeVisible();
		await expect(paletteEntry(page, /^CNC Turning/)).toHaveCount(0);
		await expect(paletteEntry(page, /Tensile/)).toHaveCount(0);

		// A search matches the method name, its code, its category and a test type; "MC" is CNC Turning's code.
		await palette.getByRole('searchbox', { name: 'Search the palette' }).fill('turning');
		await expect(paletteEntry(page, /^CNC Turning/)).toBeVisible();
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
		await expect(await paletteKind(page, 'operation')).toBeVisible();
	});

	test('dragging Operation or Test (a kind) onto the empty canvas makes a blank card: an operation with no method yet, left for the card to choose (K1)', async ({ page }) => {
		await openNewDraft(page);
		const where = await emptySpot(page);
		await dragEntryTo(page, await paletteKind(page, 'operation'), where);
		let body = await savedDraft(page, member, (b) => operations(b).length === 1, 'the blank operation');
		expect(operations(body)[0].values.method_id, 'no method yet').toBeFalsy();
		expect(body.wires).toEqual([]);
		await dragEntryTo(page, await paletteKind(page, 'test'), { x: where.x - 330, y: where.y });
		body = await savedDraft(page, member, (b) => b.items.length === 2 && b.items.some((i) => i.kind === 'test'), 'the blank test');
		expect(body.wires).toEqual([]);
	});

	// ---- R2: drops -------------------------------------------------------------------------------------------------------------------
	test('dragging an operation and a test from the palette onto the empty canvas makes floating cards where the pointer let go; undo takes them back (R2)', async ({ page }) => {
		await openNewDraft(page);
		await pickSamples(page, ['LOCAL-RAW-1']);
		await settledOverlaps(page);
		const where = await emptySpot(page);
		await dragEntryTo(page, await paletteFind(page, 'CNC Turning'), where);
		const operation = card(page, 'CNC Turning, Operation');
		await expect(operation).toBeVisible();
		let body = await savedDraft(page, member, (b) => operations(b).length === 1, 'the floating operation');
		expect(body.wires, 'a floating card has no wire').toEqual([]);
		expect(operations(body)[0].values.method_id, 'the method of the entry').toBeTruthy();
		expect(operations(body)[0].workState, 'a new operation is planned').toBe('planned');
		// It lands where the pointer was (the layout may step it aside from another card, not from a clear spot of the canvas).
		await settledOverlaps(page);
		const box = (await operation.boundingBox())!;
		expect(Math.abs(box.x - where.x), 'x of the card against where it was dropped').toBeLessThan(40);
		expect(Math.abs(box.y - where.y), 'y of the card against where it was dropped').toBeLessThan(40);

		// Let go over a card and nothing is added: it says where an entry can go instead.
		await dragEntryTo(page, await paletteFind(page, 'Tensile'), () => operation.boundingBox().then((b) => ({ x: b!.x + b!.width / 2, y: b!.y + b!.height / 2 })));
		await expect(page.locator('.pm-wirepreview .tip')).toContainText('Drop it on the empty canvas, on a free socket or on a wire.');
		await expect(cards(page)).toHaveCount(3); // the picked sample, its material, the operation
		// A test dropped on a clear spot next to it is a second floating card, clear of the first.
		await dragEntryTo(page, await paletteFind(page, 'Tensile'), { x: where.x - 330, y: where.y });
		await expect(card(page, /Tensile.*, Test$/)).toBeVisible();
		body = await savedDraft(page, member, (b) => b.items.length === 3, 'the floating test');
		expect(body.wires).toEqual([]);
		expect(await settledOverlaps(page), 'no two cards overlap after the second drop').toEqual([]);

		await page.keyboard.press('Control+z');
		await page.keyboard.press('Control+z');
		await expect(operation).toHaveCount(0);
		await savedDraft(page, member, (b) => b.items.length === 1, 'both drops undone: only the picked sample is left');
	});

	test('a new sample dragged onto the empty canvas is a free card; Existing sample… opens the picker (R2)', async ({ page }) => {
		await openNewDraft(page);
		await dragEntryTo(page, await paletteKind(page, 'sample'), await canvasMiddle(page));
		await expect(card(page, 'New sample, Sample')).toBeVisible();
		await savedDraft(page, member, (b) => b.items.length === 1 && b.items[0].kind === 'sample' && !b.items[0].existing, 'a free new sample');
		await (await paletteFind(page, 'Existing sample')).click();
		await expect(page.getByRole('dialog', { name: 'Pick samples' })).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(page.getByRole('dialog', { name: 'Pick samples' })).toBeHidden();
	});

	test('dropping on a free sample socket connects there; where it does not fit the drop is refused with the reason and nothing changes (R2)', async ({ page }) => {
		await openNewDraft(page);
		const id = await sampleIdOf(member, 'LOCAL-RAW-1');
		await pickSamples(page, ['LOCAL-RAW-1']);
		const free = sockOf(page, `sample|${id}|out`).first();
		await dragEntryTo(page, await paletteFind(page, 'CNC Turning'), free);
		await expect(card(page, 'CNC Turning, Operation')).toBeVisible();
		let body = await savedDraft(page, member, (b) => b.items.length === 2 && b.wires.length === 1, 'the operation wired from the sample');
		await fit(page); // the map keeps its viewport when a card is added: the operation may be off the screen
		expect(body.wires[0].from.key).toBe(body.items.find((i) => i.existing)!.key);

		// The operation's own output takes a sample, not another operation: refused with the reason.
		const out = canvasOf(page).locator('[data-sock^="row|draft:"][data-sock$="|out"]').first();
		await holdEntryOver(page, await paletteFind(page, 'CNC Turning'), out);
		await expect(out).toHaveClass(/drop-bad/);
		await expect(page.locator('.pm-chip')).toContainText('output takes a sample');
		await page.mouse.up();
		await expect(cards(page).filter({ hasText: /CNC Turning/ })).toHaveCount(1);
		body = await readDraft(member, draftIdOf(page));
		expect(body.items, 'the refused drop changed nothing').toHaveLength(2);

		// A new sample fits it, and is what the operation makes.
		await dragEntryTo(page, await paletteKind(page, 'sample'), out);
		await expect(card(page, 'New sample, Sample')).toBeVisible();
		body = await savedDraft(page, member, (b) => b.items.length === 3 && b.wires.length === 2, 'the new sample made by the operation');
		expect(await settledOverlaps(page)).toEqual([]);
	});

	test('dropping on a wire inserts between its two ends as one undo step; undo restores exactly what was there (R2)', async ({ page }) => {
		await buildTurningWithNewSample(page, member, 'LOCAL-RAW-1');
		const before = await savedDraft(page, member, (b) => b.items.length === 3 && b.wires.length === 2, 'sample, operation, new sample');
		await fit(page);
		const wire = wireBetween(page, 'op:draft:', 's:draft:');
		await expect(wire).toHaveCount(1);

		// While dragging, the wire is marked green: it takes the entry.
		await holdEntryOver(page, await paletteFind(page, 'CNC Milling'), () => wireMidpoint(wire));
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
		await fit(page);
		const wire = wireBetween(page, 's:', 'op:draft:');
		await expect(wire).toHaveCount(1);
		await dragEntryTo(page, await paletteFind(page, 'Heat Treatment'), () => wireMidpoint(wire));
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
		await fit(page);
		const done = wireBetween(page, 's:', 'op:');
		await expect(done.first()).toBeVisible();
		const before = await readDraft(member, draftIdOf(page));
		await holdEntryOver(page, await paletteFind(page, 'CNC Milling'), () => wireMidpoint(done.first()));
		await expect(page.locator('.d1-wire.drop-bad')).toHaveCount(1);
		await expect(page.locator('.pm-chip')).toContainText("Done records' wires can't be removed from the map");
		await page.mouse.up();
		await expect(page.locator('.pm-wirepreview .tip')).toContainText("Done records' wires can't be removed from the map");
		await expect(cards(page).filter({ hasText: /CNC Milling/ })).toHaveCount(0);
		expect(await readDraft(member, draftIdOf(page)), 'the draft is as it was').toEqual(before);
	});

	test('Enter on a palette entry adds it next to the selected card, or at the middle of the canvas; no two cards overlap (R1)', async ({ page }) => {
		await openNewDraft(page);
		await (await paletteKind(page, 'sample')).focus();
		await page.keyboard.press('Enter');
		const first = card(page, 'New sample, Sample');
		await expect(first).toBeVisible();
		await savedDraft(page, member, (b) => b.items.length === 1, 'the first card');
		await selectCard(page, first);
		await (await paletteFind(page, 'CNC Turning')).focus();
		await page.keyboard.press('Enter');
		await expect(card(page, 'CNC Turning, Operation')).toBeVisible();
		await savedDraft(page, member, (b) => b.items.length === 2 && b.wires.length === 1, 'the operation, wired to the selected new sample');
		expect(await settledOverlaps(page)).toEqual([]);
	});

	// ---- R1: the add search ------------------------------------------------------------------------------------------------------------
	test('Shift+A and Ctrl+K open the add search; typing narrows it; Enter adds the top hit; Esc closes it and adds nothing (R1)', async ({ page }) => {
		await openNewDraft(page);
		await openAddSearch(page, 'Shift+A');
		await expect(page.getByRole('dialog')).toHaveCount(1);
		await page.keyboard.type('tens');
		expect((await searchOptions(page))[0]).toBe('Destructive — Tensile');
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
		expect(options).toContain('Destructive — Tensile');
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
		expect(options).not.toContain('Destructive — Tensile');
		await page.keyboard.press('Escape');

		// A free input of a new operation: samples that could feed it.
		await dragEntryTo(page, await paletteFind(page, 'CNC Milling'), () => emptySpot(page));
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
		expect((await searchOptions(page))[0], 'nothing added yet: the catalog starts with the kinds').toBe('Sample');
		await page.keyboard.type('tensile');
		await page.keyboard.press('Enter');
		await expect(card(page, /Tensile.*, Test$/)).toBeVisible();

		await openAddSearch(page);
		expect((await searchOptions(page))[0]).toBe('Destructive — Tensile');
		await expect(addSearch(page).locator('.sec').first()).toHaveText('Recent');
		expect((await searchOptions(page)).filter((o) => o === 'Destructive — Tensile'), 'listed once, not in two places').toHaveLength(1);
		await page.keyboard.press('Escape');
		// (the palette lists its four kinds first, then what was added lately)
		await expect(paletteOf(page).locator('.sec').filter({ hasText: 'Recent' })).toBeVisible();
		await expect(paletteOf(page).locator('.pe').nth(4)).toContainText('Tensile');

		await page.reload({ waitUntil: 'domcontentloaded' });
		await expect(paletteOf(page).locator('.pe').nth(4)).toContainText('Tensile');
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
		expect(options, 'only operations can go before a sample').not.toContain('Destructive — Tensile');
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
		await dragEntryTo(page, await paletteKind(page, 'sample'), await canvasMiddle(page));
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

	test('the card\'s right-click menu offers Insert after, and Insert before… disabled with the reason on a done sample (R2, R3)', async ({ page }) => {
		const bar2 = await sampleIdOf(member, 'LOCAL-BAR-2');
		await startEditingMapOf(page, 'physical_samples', bar2);
		const done = card(page, 'LOCAL-BAR-2, Sample');
		await reach(page, done);
		await done.locator('.code').first().click({ button: 'right' });
		const menu = page.getByRole('menu', { name: 'Highlight' });
		await expect(menu.getByRole('menuitem', { name: /^Insert after/ })).toBeVisible();
		const before = menu.getByRole('menuitem', { name: /^Insert before/ });
		await expect(before, 'shown, but not available').toBeDisabled();
		await expect(before).toHaveAttribute('title', BEFORE_RECORDED);
		await expect(menu.getByRole('menuitem', { name: /earlier step/i })).toHaveCount(0);
		await page.keyboard.press('Escape');
		await expect(menu).toBeHidden();
		// "After" a done sample is an ordinary operation it feeds.
		await done.locator('.code').first().click({ button: 'right' });
		await menu.getByRole('menuitem', { name: /^Insert after/ }).click();
		await expect(page.getByRole('dialog', { name: 'Insert after LOCAL-BAR-2' })).toBeVisible();
		await page.keyboard.type('milling');
		await page.keyboard.press('Enter');
		await expect(card(page, 'CNC Milling, Operation')).toBeVisible();
		const body = await savedDraft(page, member, (b) => operations(b).length === 1, 'the milling after the done sample');
		expect(body.wires, 'fed by the done sample (which joined the draft), nothing else rewired').toHaveLength(1);
		expect(await settledOverlaps(page)).toEqual([]);
	});

	test('Shift+I on the done sample LOCAL-BAR-2 is refused with the reason: nothing is added, there is no undo step, and no record changes (R3)', async ({ page }) => {
		const bar2 = await sampleIdOf(member, 'LOCAL-BAR-2');
		const snapshot = async () => ({
			sample: await readRecord<Record<string, unknown>>(admin, 'physical_samples', bar2, 'sample_id,sample_code,current_status,version,updated_at,owner_person_id'),
			maker: await listRecords<Record<string, unknown>>(admin, 'manufacturing_operations', `filter[output_sample_id][_eq]=${bar2}&fields=operation_id,sample_id,output_sample_id,work_state,version,updated_at&sort=operation_id`),
			asParent: await listRecords<Record<string, unknown>>(admin, 'sample_genealogy', `filter[parent_sample_id][_eq]=${bar2}&fields=parent_sample_id,child_sample_id`),
			asChild: await listRecords<Record<string, unknown>>(admin, 'sample_genealogy', `filter[child_sample_id][_eq]=${bar2}&fields=parent_sample_id,child_sample_id&sort=parent_sample_id`),
			operations: (await listRecords<Record<string, unknown>>(admin, 'manufacturing_operations', 'fields=operation_id&limit=-1')).length,
			samples: (await listRecords<Record<string, unknown>>(admin, 'physical_samples', 'fields=sample_id&limit=-1')).length,
		});
		const before = await snapshot();
		await startEditingMapOf(page, 'physical_samples', bar2);
		const done = card(page, 'LOCAL-BAR-2, Sample');
		await selectCard(page, done);
		const cardsBefore = await cards(page).count();
		await expect(page.getByRole('button', { name: 'Undo' }), 'nothing to undo yet').toBeDisabled();

		await page.keyboard.press('Shift+I');
		// The reason is said where the canvas says its problems; no search opens.
		await expect(page.locator('.pm-banner[role="alert"]')).toContainText(BEFORE_RECORDED);
		await expect(addSearch(page)).toHaveCount(0);

		// Nothing was added, there is no undo step, and the draft holds nothing to create.
		await expect(cards(page)).toHaveCount(cardsBefore);
		await expect(page.getByRole('button', { name: 'Undo' })).toBeDisabled();
		await expect(createButton(page), 'nothing to create').toBeDisabled();
		await expect(createButton(page)).toHaveText('Add an operation, test or new sample to create');
		const body = await savedDraft(page, member, (b) => b.items.length === 0, 'an empty draft');
		expect(body.items).toEqual([]);
		expect(body.wires).toEqual([]);

		// Insert AFTER the same sample still works (its own test above); the refusal changed nothing about any record.
		expect(await snapshot()).toEqual(before);
	});
});
