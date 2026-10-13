import { test, expect, type Browser, type Locator, type Page } from '@playwright/test';
import { STAR_BASE } from '../starbase/target';
import { STUB_SAMPLE, stubD1, type StubState } from '../starbase/stubD1';

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

test('first paint: a chosen rail and theme are drawn before /d1-usage/nav answers (and kept if it fails)', async ({ browser }) => {
	const { page, state } = await start(browser, 1280);
	await page.getByRole('button', { name: /^Theme: System/ }).click();
	await page.getByRole('button', { name: /^Theme: Light/ }).click();
	await page.getByRole('button', { name: 'Collapse the sidebar' }).click();
	await expect.poll(() => [state.prefs.sidebarCollapsed, state.prefs.theme]).toEqual([true, 'dark']);

	// The answer is held back: the reload must already be a 60px rail in the saved theme.
	let release!: () => void;
	state.holdNav = new Promise<void>((r) => (release = r));
	const asked = page.waitForRequest((r) => r.url().endsWith('/d1-usage/nav'));
	await page.reload();
	await asked;
	await expect(page.locator('aside.sb-side')).toBeVisible();
	expect(await columnWidth(page), 'a rail at first paint, not 224px').toBe(60);
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
	release();
	state.holdNav = null;
	await expect.poll(() => state.usage.filter((u) => u === 'GET /d1-usage/nav').length).toBeGreaterThan(1);
	expect(await columnWidth(page)).toBe(60);
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

	// A failed /nav leaves the remembered choices in force for the session.
	state.failNav = true;
	await page.reload();
	await expect.poll(() => state.usage.filter((u) => u === 'GET /d1-usage/nav').length).toBeGreaterThan(2);
	await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
	expect(await columnWidth(page)).toBe(60);
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
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

// Home's "Frequently used" lists only what is not pinned: pinning a row sends it to the end of the sidebar's
// Pinned list and takes it off Home; unpinning in the sidebar brings it back on the next load.
test('Home: pinning a Frequently used row moves it into the sidebar and off Home; a failed pin puts it back', async ({ browser }) => {
	const { page, state } = await start(browser, 1280, '/');
	// Enough rows that the list stays full (it shows six) and no suggestions fill it.
	state.usedPages = ['samples', 'operations', 'tests', 'campaigns', 'tools', 'equipment', 'materials', 'inserts'];
	await page.reload();
	await expect.poll(() => pinnedLabels(page)).toEqual(['Samples', 'Projects']);
	const panel = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Frequently used' }) });
	const pages = panel.getByRole('region', { name: 'Pages and actions' });
	const names = () => pages.locator('li .name').allInnerTexts();
	const first = ['Operations', 'Tests', 'Campaigns', 'Tools', 'Equipment', 'Materials'];
	const afterOperations = ['Tests', 'Campaigns', 'Tools', 'Equipment', 'Materials', 'Cutting inserts'];
	// Samples is pinned already, so the endpoint leaves it out of the list.
	await expect.poll(names).toEqual(first);
	await expect(pages.getByRole('button', { name: 'Pin Samples' })).toHaveCount(0);

	// A failed save: the row leaves, then comes back in its place, and the sidebar is unchanged.
	state.failPin = true;
	await pages.getByRole('button', { name: 'Pin Tests' }).click();
	await expect.poll(names).toEqual(first);
	expect(pinTargets(state)).toEqual(['samples', 'projects']);
	await expect.poll(() => pinnedLabels(page)).toEqual(['Samples', 'Projects']);
	state.failPin = false;

	await pages.getByRole('button', { name: 'Pin Operations' }).click();
	await expect.poll(names).toEqual(afterOperations);
	await expect.poll(() => pinnedLabels(page)).toEqual(['Samples', 'Projects', 'Operations']);
	await expect.poll(() => pinTargets(state)).toEqual(['samples', 'projects', 'operations']);

	// Still off Home after a reload (the endpoint leaves pinned rows out); unpinned, it is back on the next load.
	await page.reload();
	await expect.poll(names).toEqual(afterOperations);
	state.pins = state.pins.filter((p) => p.target !== 'operations');
	await page.reload();
	await expect.poll(names).toEqual(first);
	await page.context().close();
});

// The Pin / Pinned toggle in the header of an index page, a saved view and a record page. It shares the
// pins with the sidebar: pinning updates both at once, unpinning in the sidebar resets the button.
// A pinned row's text can carry a second line (where it is), so rows are matched by how they start.
const hasPinned = async (page: Page, label: string) => (await pinnedLabels(page)).some((l) => l.split('\n')[0].trim() === label);
const headerPin = (page: Page) => page.locator('main').getByRole('button', { name: /^Pin(ned)?\b/ });

test('Pin toggle: on an index page, a saved view and a sample page; the sidebar and the button agree', async ({ browser }) => {
	const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
	const page = await context.newPage();
	const state = await stubD1(context);
	state.bookmarks = [{ id: 11, bookmark: 'Active samples', collection: 'physical_samples' }];
	const record = `physical_samples:${STUB_SAMPLE.sample_id}`;

	// An index page that is not pinned: "Pin" (disabled only until the pins load), and Pinned at once.
	await page.goto(STAR_BASE + '/operations');
	await expect(headerPin(page)).toHaveText(/^Pin(?!ned)/);
	await expect(headerPin(page)).toHaveAttribute('aria-pressed', 'false');
	await expect(headerPin(page)).toBeEnabled();
	await headerPin(page).click();
	await expect(headerPin(page)).toHaveText(/^Pinned/);
	await expect(headerPin(page)).toHaveAttribute('aria-pressed', 'true');
	await expect.poll(() => pinnedLabels(page)).toEqual(['Samples', 'Projects', 'Operations']);
	await expect.poll(() => pinTargets(state)).toEqual(['samples', 'projects', 'operations']);

	// Unpinning in the sidebar resets the button.
	await pinned(page).getByRole('link', { name: 'Operations' }).hover();
	await pinned(page).getByRole('button', { name: 'Pin Operations' }).click();
	await expect(headerPin(page)).toHaveText(/^Pin(?!ned)/);
	await expect(headerPin(page)).toHaveAttribute('aria-pressed', 'false');
	await expect.poll(() => pinTargets(state)).toEqual(['samples', 'projects']);

	// Samples is pinned (a default pin): the page says Pinned. With a saved view open the toggle is the view's.
	await page.goto(STAR_BASE + '/samples');
	await expect(headerPin(page)).toHaveText(/^Pinned/);
	await page.goto(STAR_BASE + '/samples?bookmark=11');
	await expect(headerPin(page)).toHaveText(/^Pin(?!ned)/);
	await expect(headerPin(page)).toHaveAttribute('aria-pressed', 'false');
	await headerPin(page).click();
	await expect(headerPin(page)).toHaveText(/^Pinned/);
	await expect.poll(() => state.pins.map((p) => `${p.kind}:${p.target}`)).toEqual(['page:samples', 'page:projects', 'view:11']);
	await expect.poll(() => hasPinned(page, 'Active samples')).toBe(true);
	// The whole list is still the page's own pin, unchanged.
	await page.goto(STAR_BASE + '/samples');
	await expect(headerPin(page)).toHaveText(/^Pinned/);

	// A sample's page: Pin, then Pinned at once, and the sidebar row carries the sample's code.
	await page.goto(STAR_BASE + `/samples/${STUB_SAMPLE.sample_id}`);
	await expect(page.getByRole('heading', { name: STUB_SAMPLE.sample_code, exact: true })).toBeVisible();
	await expect(headerPin(page)).toHaveText(/^Pin(?!ned)/);
	await headerPin(page).click();
	await expect(headerPin(page)).toHaveText(/^Pinned/);
	await expect.poll(() => pinTargets(state)).toContain(record);
	await expect.poll(() => hasPinned(page, STUB_SAMPLE.sample_code)).toBe(true);

	// It is still pinned after a reload, and unpinning in the sidebar resets the button.
	await page.reload();
	await expect(headerPin(page)).toHaveText(/^Pinned/);
	const row = pinned(page).locator('.row').filter({ has: page.getByRole('link', { name: STUB_SAMPLE.sample_code }) });
	await row.hover();
	await row.getByRole('button', { name: /^Pin / }).click();
	await expect(headerPin(page)).toHaveText(/^Pin(?!ned)/);
	await expect.poll(() => pinTargets(state)).not.toContain(record);

	// Unpinning from the header takes the row out of the sidebar again.
	await headerPin(page).click();
	await expect(headerPin(page)).toHaveText(/^Pinned/);
	await headerPin(page).click();
	await expect(headerPin(page)).toHaveText(/^Pin(?!ned)/);
	await expect.poll(() => hasPinned(page, STUB_SAMPLE.sample_code)).toBe(false);
	await context.close();
});

test('Pin toggle: a failed save puts the button back, and says nothing next to it', async ({ browser }) => {
	const { page, state } = await start(browser, 1280, '/operations');
	state.failPin = true;
	await expect(headerPin(page)).toBeEnabled();
	await headerPin(page).click();
	await expect(headerPin(page)).toHaveText(/^Pin(?!ned)/);
	await expect(headerPin(page)).toHaveAttribute('aria-pressed', 'false');
	expect(pinTargets(state)).toEqual(['samples', 'projects']);
	await expect(page.locator('main').getByText("Couldn't save your pins")).toHaveCount(0);
	await page.context().close();
});

// Projects and People are bespoke pages (not IndexPage) with their own header toggle.
test('Pin toggle: the Projects page shows its default pin, unpinning there leaves the sidebar; People pins too', async ({ browser }) => {
	const { page, state } = await start(browser, 1280, '/projects');
	await expect(headerPin(page)).toBeEnabled();
	await expect(headerPin(page)).toHaveText(/^Pinned/);
	await expect(headerPin(page)).toHaveAttribute('aria-pressed', 'true');
	await headerPin(page).click();
	await expect(headerPin(page)).toHaveText(/^Pin(?!ned)/);
	await expect.poll(() => pinnedLabels(page)).toEqual(['Samples']);
	await expect.poll(() => pinTargets(state)).toEqual(['samples']);
	await headerPin(page).click();
	await expect(headerPin(page)).toHaveText(/^Pinned/);
	await expect.poll(() => pinnedLabels(page)).toEqual(['Samples', 'Projects']);

	await page.goto(STAR_BASE + '/people');
	await expect(headerPin(page)).toBeEnabled();
	await expect(headerPin(page)).toHaveText(/^Pin(?!ned)/);
	await headerPin(page).click();
	await expect(headerPin(page)).toHaveText(/^Pinned/);
	await expect.poll(() => pinTargets(state)).toEqual(['samples', 'projects', 'people']);
	await expect.poll(() => pinnedLabels(page)).toEqual(['Samples', 'Projects', 'People']);
	await page.context().close();
});

// Settings (decision 9): every control saves as it changes and is still there after a reload.
test('Settings: the theme radio and Start collapsed persist after a reload', async ({ browser }) => {
	const { page, state } = await start(browser, 1280, '/settings');
	await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible();
	const html = page.locator('html');

	await page.getByRole('radio', { name: 'Dark' }).check();
	await expect(html).toHaveAttribute('data-theme', 'dark');
	await expect.poll(() => state.prefs.theme).toBe('dark');
	await page.reload();
	await expect(page.getByRole('radio', { name: 'Dark' })).toBeChecked();
	await expect(html).toHaveAttribute('data-theme', 'dark');

	const startCollapsed = page.getByRole('checkbox', { name: 'Start collapsed' });
	await expect(startCollapsed).not.toBeChecked();
	await startCollapsed.check();
	await expect.poll(() => state.prefs.sidebarCollapsed).toBe(true);
	await page.reload();
	await expect(page.getByRole('checkbox', { name: 'Start collapsed' })).toBeChecked();
	await expect.poll(() => columnWidth(page)).toBe(60);

	const auto = page.getByRole('checkbox', { name: 'Collapse automatically on narrow windows' });
	await expect(auto).toBeChecked();
	await auto.uncheck();
	await expect.poll(() => state.prefs.autoCollapse).toBe(false);
	await page.reload();
	await expect(page.getByRole('checkbox', { name: 'Collapse automatically on narrow windows' })).not.toBeChecked();
	await page.context().close();
});

test('Settings: a failed save says "Couldn\'t save", goes back to the stored value, and Retry saves it', async ({ browser }) => {
	const { page, state } = await start(browser, 1280, '/settings');
	await page.route('**/d1-usage/prefs', (r) => (r.request().method() === 'POST' ? r.fulfill({ status: 500, headers: { 'access-control-allow-origin': STAR_BASE, 'access-control-allow-credentials': 'true' }, json: {} }) : r.fallback()), { times: 1 });
	const auto = page.getByRole('checkbox', { name: 'Collapse automatically on narrow windows' });
	await expect(auto).toBeChecked();
	await auto.uncheck();
	await expect(page.getByRole('alert').filter({ hasText: "Couldn't save" })).toBeVisible();
	await expect(auto).toBeChecked();
	await page.getByRole('alert').getByRole('button', { name: 'Retry' }).click();
	await expect.poll(() => state.prefs.autoCollapse).toBe(false);
	await expect(page.getByRole('alert').filter({ hasText: "Couldn't save" })).toHaveCount(0);
	await expect(auto).not.toBeChecked();
	await page.context().close();
});

test('Settings: Move up reorders the sidebar; Reset to defaults (confirmed) leaves Samples, Projects', async ({ browser }) => {
	const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
	const page = await context.newPage();
	const state = await stubD1(context);
	state.pins.push({ kind: 'page', target: 'operations' });
	await page.goto(STAR_BASE + '/settings');
	await expect(page.locator('aside nav.d1-nav')).toBeVisible();
	const list = page.getByRole('list', { name: 'Pinned pages' });
	await expect.poll(() => pinnedLabels(page)).toEqual(['Samples', 'Projects', 'Operations']);
	await expect(list.locator('li .name')).toHaveText(['Samples', 'Projects', 'Operations']);

	await list.getByRole('button', { name: 'Move Operations up' }).click();
	await expect.poll(() => pinnedLabels(page)).toEqual(['Samples', 'Operations', 'Projects']);
	await expect(list.locator('li .name')).toHaveText(['Samples', 'Operations', 'Projects']);
	await expect.poll(() => pinTargets(state)).toEqual(['samples', 'operations', 'projects']);
	await expect(list.getByRole('button', { name: 'Move Operations up' })).toBeFocused();
	await page.reload();
	await expect.poll(() => pinnedLabels(page)).toEqual(['Samples', 'Operations', 'Projects']);

	// Cancel keeps the pins; confirming replaces them.
	await page.getByRole('button', { name: 'Reset to defaults' }).click();
	const dialog = page.getByRole('dialog');
	await expect(dialog).toContainText('Replace your pins with Samples and Projects?');
	await dialog.getByRole('button', { name: 'Cancel' }).click();
	await expect(dialog).toHaveCount(0);
	expect(pinTargets(state)).toEqual(['samples', 'operations', 'projects']);
	await page.getByRole('button', { name: 'Reset to defaults' }).click();
	await page.getByRole('dialog').getByRole('button', { name: 'Reset', exact: true }).click();
	await expect.poll(() => pinnedLabels(page)).toEqual(['Samples', 'Projects']);
	await expect(list.locator('li .name')).toHaveText(['Samples', 'Projects']);
	expect(pinTargets(state)).toEqual(['samples', 'projects']);
	await context.close();
});

test('Settings: a pin that cannot be resolved is listed under "No longer available", and Remove clears it', async ({ browser }) => {
	const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
	const page = await context.newPage();
	const state = await stubD1(context);
	state.pins.push({ kind: 'page', target: 'gone-page' });
	await page.goto(STAR_BASE + '/settings');
	await expect(page.locator('aside nav.d1-nav')).toBeVisible();
	const gone = page.locator('.gone');
	await expect(gone.getByRole('heading', { name: 'No longer available' })).toBeVisible();
	await expect(gone.locator('li')).toHaveCount(1);
	await expect(gone.locator('li')).toContainText('gone-page');
	await expect.poll(() => pinnedLabels(page)).toEqual(['Samples', 'Projects']);

	await gone.getByRole('button', { name: /^Remove / }).click();
	await expect(gone).toHaveCount(0);
	await expect.poll(() => pinTargets(state)).toEqual(['samples', 'projects']);
	await page.reload();
	await expect(page.locator('.gone')).toHaveCount(0);
	await context.close();
});

test('Settings: Forget my list views and Clear my history', async ({ browser }) => {
	const { page, state } = await start(browser, 1280, '/settings', 1000);
	await page.evaluate(() => {
		localStorage.setItem('d1.list.samples', '{"view":"cards","density":"roomy"}');
		localStorage.setItem('starbase.theme', 'dark');
	});
	await page.getByRole('button', { name: 'Forget my list views' }).click();
	await expect(page.getByText('Done. Every list starts from the default.')).toBeVisible();
	expect(await page.evaluate(() => localStorage.getItem('d1.list.samples'))).toBeNull();
	expect(await page.evaluate(() => localStorage.getItem('starbase.theme'))).toBe('dark');

	await page.getByRole('button', { name: 'Clear my history' }).click();
	await expect(page.getByText('History cleared.')).toBeVisible();
	expect(state.usage).toContain('POST /d1-usage/clear');
	// A reviewer's screenshot of the finished page (not part of the assertions): SETTINGS_SHOT=<path>.
	if (process.env.SETTINGS_SHOT) { await page.evaluate(() => document.querySelectorAll('main, body').forEach((el) => el.scrollTo(0, 0))); await page.screenshot({ path: process.env.SETTINGS_SHOT }); };
	await page.context().close();
});
