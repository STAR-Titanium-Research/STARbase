import { test, expect, type Browser, type Locator, type Page } from '@playwright/test';
import { STAR_BASE } from '../starbase/target';
import { stubD1, type StubState } from '../starbase/stubD1';

// The Explorer sidebar (explorer-sidebar-b2) in STARbase, in a real browser: pins that survive a reload,
// reorder by keyboard, the rail and its hover menus at 1280 px, the overlay at 900 px, the sheet at 600 px,
// the theme toggle, and a keyboard-only pass. d1-server is a stateful stand-in (tests/ui/starbase/stubD1.ts),
// so this needs only STARbase served by `vite preview` (tests/ui/README.md), no Directus.
// Run: cd tests/ui && npx playwright test specs/16-sidebar-b2.spec.ts
test.use({ trace: 'off' });

async function start(browser: Browser, width: number, path = '/operations', height = 800): Promise<{ page: Page; state: StubState }> {
	const context = await browser.newContext({ viewport: { width, height } });
	const page = await context.newPage();
	const state = await stubD1(context);
	await page.goto(STAR_BASE + path);
	await expect(page.locator(width < 768 ? 'header.sb-topbar' : 'aside nav.d1-nav')).toBeVisible();
	return { page, state };
}

const pinned = (page: Page) => page.locator('aside section.pinned');
const pinTargets = (state: StubState) => state.pins.map((p) => p.target);
const pinnedLabels = (page: Page) => pinned(page).getByRole('link').allInnerTexts();
const columnWidth = async (page: Page) => Math.round((await page.locator('aside.sb-side').boundingBox())!.width);
const prefWrites = (state: StubState) => state.usage.filter((u) => u === 'POST /d1-usage/prefs');

async function pinOperations(page: Page) {
	const row = page.locator('aside .row').filter({ has: page.getByRole('link', { name: 'Operations', exact: true }) });
	await row.hover();
	await row.getByRole('button', { name: 'Pin Operations' }).click();
}

test('pin Operations: it is last, and still there after a reload; Alt+Up moves it up', async ({ browser }) => {
	const { page, state } = await start(browser, 1280);
	expect(await columnWidth(page)).toBe(224);
	await expect.poll(() => pinnedLabels(page)).toEqual(['Samples', 'Projects']);
	await pinOperations(page);
	await expect.poll(() => pinnedLabels(page)).toEqual(['Samples', 'Projects', 'Operations']);
	await expect.poll(() => pinTargets(state)).toEqual(['samples', 'projects', 'operations']);

	await page.reload();
	await expect.poll(() => pinnedLabels(page)).toEqual(['Samples', 'Projects', 'Operations']);

	await pinned(page).getByRole('link', { name: 'Operations' }).focus();
	await page.keyboard.press('Alt+ArrowUp');
	await expect.poll(() => pinnedLabels(page)).toEqual(['Samples', 'Operations', 'Projects']);
	await expect.poll(() => pinTargets(state)).toEqual(['samples', 'operations', 'projects']);
	await expect(pinned(page).getByRole('link', { name: 'Operations' })).toBeFocused();

	await page.reload();
	await expect.poll(() => pinnedLabels(page)).toEqual(['Samples', 'Operations', 'Projects']);
	await page.context().close();
});

test('1280 px: collapse to the rail (saved, kept on reload), a hover menu on Inventory, and its header expands', async ({ browser }) => {
	const { page, state } = await start(browser, 1280);
	await page.getByRole('button', { name: 'Collapse the sidebar' }).click();
	await expect.poll(() => columnWidth(page)).toBe(60);
	await expect.poll(() => state.prefs.sidebarCollapsed).toBe(true);
	await page.reload();
	await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
	expect(await columnWidth(page)).toBe(60);

	await page.getByRole('button', { name: 'Inventory', exact: true }).hover();
	const menu = page.locator('.hover-menu');
	await expect(menu).toBeVisible();
	await expect(menu.getByRole('link', { name: 'Tools', exact: true })).toBeVisible();
	await expect(menu.getByRole('link', { name: 'Raw stock lots' })).toBeVisible();
	const box = (await menu.boundingBox())!;
	expect(box.x, 'the menu opens beside the rail, not over it').toBeGreaterThanOrEqual(58);

	await menu.getByRole('button', { name: /expand the sidebar/ }).click();
	await expect.poll(() => columnWidth(page)).toBe(224);
	await expect.poll(() => state.prefs.sidebarCollapsed).toBe(false);
	await expect(page.getByRole('button', { name: /^Inventory/ }).first()).toHaveAttribute('aria-expanded', 'true');
	await page.context().close();
});

test('[ and ] collapse and expand, but not while typing in a field', async ({ browser }) => {
	const { page, state } = await start(browser, 1280);
	await page.locator('main').click({ position: { x: 5, y: 5 } });
	await page.keyboard.press('[');
	await expect.poll(() => columnWidth(page)).toBe(60);
	await expect.poll(() => state.prefs.sidebarCollapsed).toBe(true);
	await page.keyboard.press(']');
	await expect.poll(() => columnWidth(page)).toBe(224);
	// In a text field the keys are text.
	await page.evaluate(() => {
		const input = document.createElement('input');
		input.id = 'probe';
		document.querySelector('main')!.prepend(input);
		input.focus();
	});
	await page.keyboard.type('[');
	await expect(page.locator('#probe')).toHaveValue('[');
	expect(await columnWidth(page)).toBe(224);
	await page.context().close();
});

test('900 px: a rail; Expand opens the overlay (nothing saved); Esc, the backdrop, a page and growing close it', async ({ browser }) => {
	const { page, state } = await start(browser, 900);
	expect(await columnWidth(page)).toBe(60);
	const expand = page.getByRole('button', { name: 'Expand sidebar' });
	const overlay = page.getByRole('dialog', { name: 'Pages' });

	await expand.click();
	await expect(overlay).toBeVisible();
	expect(Math.round((await overlay.boundingBox())!.width)).toBe(224);
	expect(await columnWidth(page), 'the page does not move').toBe(60);
	await expect(page.getByRole('button', { name: 'Collapse the sidebar' })).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(overlay).toBeHidden();
	await expect(expand).toBeFocused();

	await expand.click();
	await expect(overlay).toBeVisible();
	await page.mouse.click(700, 400);
	await expect(overlay).toBeHidden();

	await expand.click();
	await overlay.getByRole('link', { name: 'Projects', exact: true }).first().click();
	await expect(page).toHaveURL(/\/projects/);
	await expect(overlay).toBeHidden();

	await expand.click();
	await expect(overlay).toBeVisible();
	await page.setViewportSize({ width: 1000, height: 800 });
	await expect(overlay).toBeHidden();
	await expect.poll(() => columnWidth(page)).toBe(224);
	expect(prefWrites(state), 'the overlay never writes a preference').toEqual([]);
	await page.context().close();
});

test('600 px: the phone sheet holds the expanded sidebar', async ({ browser }) => {
	const { page } = await start(browser, 600, '/operations');
	await expect(page.locator('aside.sb-side')).toHaveCount(0);
	await page.getByRole('button', { name: 'Menu', exact: true }).click();
	const sheet = page.getByRole('dialog', { name: 'Pages' });
	await expect(sheet).toBeVisible();
	await expect(sheet.getByRole('button', { name: 'Find a record (Ctrl K)' })).toBeVisible();
	await expect(sheet.getByRole('button', { name: /^Records/ })).toHaveAttribute('aria-expanded', 'true');
	await expect(sheet.getByRole('button', { name: 'Collapse the sidebar' })).toHaveCount(0);
	await expect(sheet.getByRole('link', { name: 'Settings' })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(sheet).toBeHidden();
	await expect(page.getByRole('button', { name: 'Menu', exact: true })).toBeFocused();
	await page.context().close();
});

test('the foot: Settings gear, theme toggle (saved, kept on reload), and the compact foot under the rail', async ({ browser }) => {
	const { page, state } = await start(browser, 1280);
	await expect(page.locator('aside').getByRole('link', { name: 'Settings', exact: true })).toHaveAttribute('href', '/settings');
	const html = page.locator('html');
	await expect(html).not.toHaveAttribute('data-theme', /.*/);
	await page.getByRole('button', { name: /^Theme: System/ }).click();
	await expect(html).toHaveAttribute('data-theme', 'light');
	await page.getByRole('button', { name: /^Theme: Light/ }).click();
	await expect(html).toHaveAttribute('data-theme', 'dark');
	await expect.poll(() => state.prefs.theme).toBe('dark');
	await page.reload();
	await expect(html).toHaveAttribute('data-theme', 'dark');
	await expect(page.locator('main')).toHaveCSS('color-scheme', 'dark');
	await page.getByRole('button', { name: /^Theme: Dark/ }).click();
	await expect(html).not.toHaveAttribute('data-theme', /.*/);

	await page.getByRole('button', { name: 'Collapse the sidebar' }).click();
	const foot = page.locator('aside .sb-foot.rail');
	await expect(foot.getByRole('link', { name: 'Settings' })).toHaveAttribute('title', 'Settings');
	await expect(foot.getByRole('link', { name: /Data Studio/ })).toHaveAttribute('title', /Data Studio/);
	await expect(foot.getByRole('button', { name: 'Sign out' })).toHaveAttribute('title', 'Sign out');
	await page.context().close();
});

// Keyboard only: Tab to reach things, Enter to act. The page is left alone with the mouse.
async function tabTo(page: Page, target: Locator, max = 60) {
	for (let i = 0; i < max; i++) {
		if (await target.evaluate((el) => el === document.activeElement)) return;
		await page.keyboard.press('Tab');
	}
	throw new Error('Tab never reached the element');
}

test('keyboard only: pin, move, the row menu, then the rail and its hover menu', async ({ browser }) => {
	const { page, state } = await start(browser, 1280);
	// Pin Operations: Tab from its link to its pin button, Enter.
	const link = page.locator('aside section:not(.pinned)').getByRole('link', { name: 'Operations', exact: true });
	await tabTo(page, link);
	await page.keyboard.press('Tab');
	await expect(page.getByRole('button', { name: 'Pin Operations' }).first()).toBeFocused();
	await page.keyboard.press('Enter');
	await expect.poll(() => pinTargets(state)).toEqual(['samples', 'projects', 'operations']);

	// Move it up with Alt+ArrowUp from its pinned link.
	await pinned(page).getByRole('link', { name: 'Operations' }).focus();
	await page.keyboard.press('Alt+ArrowUp');
	await expect.poll(() => pinTargets(state)).toEqual(['samples', 'operations', 'projects']);

	// The row menu: Tab to the "..." button, Enter opens a menu with focus inside, Escape returns focus to the button.
	const more = pinned(page).getByRole('button', { name: 'More actions for Operations' });
	await tabTo(page, more);
	await page.keyboard.press('Enter');
	const menu = page.getByRole('menu', { name: 'Row actions' });
	await expect(menu).toBeVisible();
	await expect(menu.getByRole('menuitem').first()).toBeFocused();
	await page.keyboard.press('ArrowDown');
	await page.keyboard.press('Escape');
	await expect(menu).toBeHidden();
	await expect(more).toBeFocused();
	// Move down from the menu: Enter on "Move down".
	await page.keyboard.press('Enter');
	await menu.getByRole('menuitem', { name: 'Move down' }).focus();
	await page.keyboard.press('Enter');
	await expect.poll(() => pinTargets(state)).toEqual(['samples', 'projects', 'operations']);

	// Collapse with the keyboard, then reach a section icon: its hover menu opens on focus, Escape closes it.
	await page.getByRole('button', { name: 'Collapse the sidebar' }).focus();
	await page.keyboard.press('Enter');
	await expect.poll(() => columnWidth(page)).toBe(60);
	const reference = page.getByRole('button', { name: 'Reference', exact: true });
	await tabTo(page, reference);
	const hover = page.locator('.hover-menu');
	await expect(hover).toBeVisible();
	await page.keyboard.press('Tab');
	await expect(hover.getByRole('button', { name: /expand the sidebar/ })).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(hover).toBeHidden();
	await expect(reference).toBeFocused();
	await page.context().close();
});
