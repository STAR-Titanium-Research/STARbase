import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { D1, apiAs, getRetrying, signIn, stackAvailable } from '../starbase/localStack';
import {
	addSearch, boxOf, buildTurningWithNewSample, canvasMiddle, card, cards, dragEntryTo, emptySpot, holdEntryOver, openNewDraft, paletteEntry, paletteOf, reach, savedDraft, selectCard, settledOverlaps,
	sampleIdOf, startEditingMapOf,
} from '../starbase/mapEdit';

/**
 * The fixes of the Opus review of slice 2a (branch pm-redesign/2c-fixes), driven in a REAL browser against the LOCAL STACK as the seeded Lab Member:
 * a palette drag that loses its pointer is let go (5), a finger scrolls the palette and carries an entry on purpose (6), focus after Insert from the
 * right-click menu (7), and what Insert and a drop refuse on done records (1, 3). The rules of the rest (2, 4) are in insertModel.test.ts and
 * useEditInsert.test.ts, where the draft can be arranged exactly.
 *
 *   bash scripts/dev/local-stack.sh up
 *   cd tests/ui && npx playwright test -c playwright.local-stack.config.ts specs/edit-mode-slice2c.spec.ts
 */

let member: APIRequestContext;
test.beforeAll(async ({ playwright }) => {
	test.skip(!stackAvailable(), 'the local stack is not up: run `bash scripts/dev/local-stack.sh up`');
	member = await apiAs(playwright, 'member');
});
test.afterEach(async () => {
	if (!stackAvailable() || !member) return;
	const r = await getRetrying(member, `${D1}/d1-build/drafts`);
	if (r.ok()) for (const d of (await r.json()).data as { id: string }[]) await member.delete(`${D1}/d1-build/drafts/${d.id}`);
});

const DONE_WIRE = "Done records' wires can't be removed from the map";
/** The element that has keyboard focus: the card it is in (its data-id), else its tag. */
const focusedCard = (page: Page): Promise<string> =>
	page.evaluate(() => {
		const el = document.activeElement as HTMLElement | null;
		return el?.closest<HTMLElement>('.vue-flow__node')?.dataset.id ?? `<${el?.tagName.toLowerCase() ?? 'nothing'}>`;
	});

test.describe('as a Lab Member', () => {
	test.beforeEach(async ({ page }) => {
		await signIn(page, 'member');
	});

	// ---- 5: a drag that loses its pointer ---------------------------------------------------------------------------------------------
	test('a palette drag is let go when the window loses focus, or the mouse moves with no button down: nothing is dropped later, and the next drag works (5)', async ({ page }) => {
		await openNewDraft(page);
		const turning = paletteEntry(page, /^CNC Turning/);
		const where = await canvasMiddle(page);

		// The pointerup never arrives (the button was let go in another window): the window blurs.
		await holdEntryOver(page, turning, where);
		await expect(page.locator('.pm-chip')).toBeVisible();
		await page.evaluate(() => window.dispatchEvent(new Event('blur')));
		await expect(page.locator('.pm-chip')).toHaveCount(0);
		await page.mouse.up();
		await page.mouse.move(where.x + 30, where.y + 30);
		await expect(cards(page)).toHaveCount(0);

		// A mouse that moves over the page with no button down: the drag was lost, not still going.
		await holdEntryOver(page, turning, where);
		await expect(page.locator('.pm-chip')).toBeVisible();
		await page.evaluate(({ x, y }) => window.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y, buttons: 0, pointerType: 'mouse', bubbles: true })), { x: where.x + 10, y: where.y + 10 });
		await expect(page.locator('.pm-chip')).toHaveCount(0);
		await page.mouse.up();
		await expect(cards(page)).toHaveCount(0);

		// Hidden page: the same.
		await holdEntryOver(page, turning, where);
		await expect(page.locator('.pm-chip')).toBeVisible();
		await page.evaluate(() => {
			Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
			document.dispatchEvent(new Event('visibilitychange'));
			Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
		});
		await expect(page.locator('.pm-chip')).toHaveCount(0);
		await page.mouse.up();
		await expect(cards(page)).toHaveCount(0);

		// Nothing was left holding the pointer: an ordinary drag still drops.
		await dragEntryTo(page, turning, where);
		await expect(card(page, 'CNC Turning, Operation')).toBeVisible();
		await savedDraft(page, member, (b) => b.items.length === 1, 'the one operation of the ordinary drag');
	});

	// ---- 6: a finger ---------------------------------------------------------------------------------------------------------------------
	test.describe('with a touch screen', () => {
		test('a finger scrolls the palette by swiping up and down on its entries; a long press, or a sideways swipe, carries an entry (6)', async ({ browser }) => {
			const context = await browser.newContext({ hasTouch: true, viewport: { width: 1920, height: 1300 } });
			try {
				const page = await context.newPage();
				await signIn(page, 'member');
				await openNewDraft(page);
				const cdp = await context.newCDPSession(page);
				const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x?: number, y?: number) =>
					cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: x!, y: y! }] });
				const list = paletteOf(page).locator('.list');
				const entry = paletteEntry(page, /^CNC Milling/);
				const e0 = await boxOf(entry);
				const from = { x: e0.x + 40, y: e0.y + e0.height / 2 };
				expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight), 'the list is long enough to scroll').toBe(true);

				// A swipe up on an entry moves the list, and carries nothing.
				await touch('touchStart', from.x, from.y);
				for (let i = 1; i <= 12; i++) await touch('touchMove', from.x, from.y - i * 20);
				await touch('touchEnd');
				await expect.poll(() => list.evaluate((el) => el.scrollTop), { message: 'the palette list scrolled' }).toBeGreaterThan(50);
				await expect(page.locator('.pm-chip')).toHaveCount(0);
				await expect(cards(page)).toHaveCount(0);

				// A long press carries it: the chip follows the finger, and letting go on the canvas drops a card there.
				const at = await boxOf(entry);
				const press = { x: at.x + 40, y: at.y + at.height / 2 };
				const target = await canvasMiddle(page);
				await touch('touchStart', press.x, press.y);
				await expect(page.locator('.pm-chip'), 'after the long press').toBeVisible();
				for (let i = 1; i <= 10; i++) await touch('touchMove', press.x + ((target.x - press.x) * i) / 10, press.y + ((target.y - press.y) * i) / 10);
				await touch('touchEnd');
				await expect(card(page, 'CNC Milling, Operation')).toBeVisible();

				// A clearly sideways swipe carries one at once.
				await list.evaluate((el) => void (el.scrollTop = 0)); // (the swipe above scrolled it)
				const again = await boxOf(paletteEntry(page, 'New sample'));
				const side = { x: again.x + 40, y: again.y + again.height / 2 };
				await touch('touchStart', side.x, side.y);
				for (let i = 1; i <= 4; i++) await touch('touchMove', side.x + i * 12, side.y + 1);
				await expect(page.locator('.pm-chip')).toBeVisible();
				const spot = await emptySpot(page);
				for (let i = 1; i <= 10; i++) await touch('touchMove', side.x + 48 + ((spot.x - side.x - 48) * i) / 10, side.y + ((spot.y - side.y) * i) / 10);
				await touch('touchEnd');
				await expect(card(page, 'New sample, Sample')).toBeVisible();
				await savedDraft(page, member, (b) => b.items.length === 2, 'the operation and the sample the finger carried');
			} finally {
				await context.close();
			}
		});
	});

	// ---- 7: focus after Insert from the card's menu --------------------------------------------------------------------------------------
	test('after Insert from the right-click menu, Esc and a choice both leave focus on a card, not on the page body (7)', async ({ page }) => {
		await buildTurningWithNewSample(page, member, 'LOCAL-RAW-1');
		await savedDraft(page, member, (b) => b.items.length === 3 && b.wires.length === 2, 'sample, operation, new sample');
		const sample = card(page, 'New sample, Sample');
		await reach(page, sample);
		await sample.locator('.code, .oname .n').first().click({ button: 'right' });
		await page.getByRole('menuitem', { name: /^Insert before/ }).click();
		await expect(addSearch(page)).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(addSearch(page)).toBeHidden();
		await expect.poll(() => focusedCard(page), { message: 'Esc leaves focus on the card the search was for' }).toMatch(/^s:draft:/);

		await sample.locator('.code, .oname .n').first().click({ button: 'right' });
		await page.getByRole('menuitem', { name: /^Insert before/ }).click();
		await page.keyboard.type('milling');
		await page.keyboard.press('Enter');
		await expect(card(page, 'CNC Milling, Operation')).toBeVisible();
		await expect(addSearch(page)).toBeHidden();
		await expect.poll(() => focusedCard(page), { message: 'a choice leaves focus on a card' }).not.toBe('<body>');
		expect(await focusedCard(page)).toMatch(/^(s|op):/);
	});

	// ---- 1, 3: what is refused on done records ---------------------------------------------------------------------------------------------
	test('a done operation is not offered Insert, I / Shift+I say why up front with no search, and a drop on it is refused and remembers nothing (1, 3)', async ({ page }) => {
		const bar1 = await sampleIdOf(member, 'LOCAL-BAR-1');
		await startEditingMapOf(page, 'physical_samples', bar1);
		const operation = card(page, /^CNC Turning LOCAL-BAR-1-T1, Operation$/);
		await reach(page, operation);
		await operation.locator('.oname .n, .code').first().click({ button: 'right' });
		const menu = page.getByRole('menu', { name: 'Highlight' });
		await expect(menu.getByRole('menuitem', { name: /^Remove/ })).toBeVisible();
		await expect(menu.getByRole('menuitem', { name: /^Insert/ })).toHaveCount(0);
		await page.keyboard.press('Escape');

		// The keys say the reason where the canvas says its problems, and open nothing.
		await selectCard(page, operation);
		const reason = page.locator('.pm-banner[role="alert"]');
		for (const key of ['i', 'Shift+I']) {
			await page.keyboard.press(key);
			await expect(reason, `${key} on a done operation`).toHaveText(new RegExp(DONE_WIRE));
			await expect(addSearch(page)).toHaveCount(0);
			await page.getByRole('button', { name: 'Dismiss' }).first().click();
		}

		// A drop on the done card is refused (nothing binds a recorded operation's sockets, so they are not drop targets), nothing is added, and a
		// refused drop is not remembered as a recent. (The lock reason a drop on such a socket would get is covered in addDrop.test.ts.)
		await settledOverlaps(page);
		const before = await cards(page).count();
		await dragEntryTo(page, paletteEntry(page, 'New sample'), operation);
		await expect(page.locator('.pm-wirepreview .tip')).toContainText('Drop it on the empty canvas, on a free socket or on a wire.');
		await expect(cards(page)).toHaveCount(before);
		await expect(paletteOf(page).locator('.sec').first(), 'a refused drop is not a recent').not.toHaveText('Recent');
	});
});
