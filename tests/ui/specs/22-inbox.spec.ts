import { test, expect, type Browser, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { D1_BASE, STAR_BASE, watchErrors } from '../starbase/target';
import { stubD1 } from '../starbase/stubD1';
import { STUB_TOOLING as T } from '../starbase/stubScans';
import { foundFile, sampleFiles, stubInbox, type InboxStub } from '../starbase/stubInbox';

// The Inbox (found files: spec 2026-10-15-found-files-inbox-design.md) in STARbase, in a real browser: the sidebar entry and its badge, Home's
// panel, the /inbox page (rows with the reason, Link and Undo, Accept all with its confirm, the surface-scan row and its Add a surface scan
// dialog (desktop and phone width), Other files, Rescan and its 429), Settings' auto-link switch with its consent text, and the Inbox crawler tab on /crawler. d1-server is a stand-in
// (tests/ui/starbase/stubD1.ts for the shell, stubInbox.ts for d1-inbox, the same fake the vitest page tests use), so this needs only STARbase
// served by `vite preview` (tests/ui/README.md), no Directus and no backend.
// Run: cd tests/ui && npx playwright test specs/22-inbox.spec.ts   (INBOX_SHOTS=<dir> also saves screenshots there)
test.use({ trace: 'off' });

const SHOTS = process.env.INBOX_SHOTS;
const assetRequests: string[] = [];
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shot = async (page: Page, name: string) => {
	if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
};

async function start(browser: Browser, path: string, width = 1280, opts: Parameters<typeof stubInbox>[1] = {}): Promise<{ page: Page; inbox: InboxStub; errors: string[] }> {
	const context = await browser.newContext({ viewport: { width, height: 900 } });
	const page = await context.newPage();
	const errors = watchErrors(page);
	// Pictures come from d1-inbox as blobs (the crawler's small copies): the page must never ask Directus's asset route for a found file.
	page.on('request', (r) => { if (r.url().startsWith(`${D1_BASE}/assets/`)) assetRequests.push(r.url()); });
	await stubD1(context);
	const inbox = await stubInbox(context, opts);
	await page.goto(STAR_BASE + path);
	// the sidebar is a drawer on a phone: wait for the page's own tabs there
	await expect(page.locator(width >= 900 ? 'aside nav.d1-nav' : 'nav[aria-label="Inbox tabs"]')).toBeVisible();
	return { page, inbox, errors };
}

const names = (page: Page) => page.locator('[data-test="inbox-row"] .name').allInnerTexts();
const row = (page: Page, name: string) => page.locator('[data-test="inbox-row"]').filter({ hasText: name });

test('the sidebar has an Inbox entry under Home with the count of new files (not the older ones), and Home has a panel', async ({ browser }) => {
	const { page, errors } = await start(browser, '/');
	const entry = page.locator('aside').getByRole('link', { name: /^Inbox/ });
	await expect(entry).toBeVisible();
	await expect(entry.locator('[data-test="nav-badge"] [aria-hidden]')).toHaveText('5');
	// Outside the five sections: it comes straight after Home, above Pinned.
	const labels = await page.locator('aside nav a, aside .row a').allInnerTexts();
	expect(labels.findIndex((l) => /^Inbox/.test(l.trim()))).toBe(labels.findIndex((l) => /^Home/.test(l.trim())) + 1);
	const panel = page.locator('[data-test="home-inbox"]');
	await expect(panel).toBeVisible();
	await expect(panel).toContainText('5 new files');
	await expect(panel).toContainText('1 older file matches a record');
	await shot(page, 'home');
	await panel.getByRole('link', { name: /5 new files/ }).click();
	await expect(page).toHaveURL(/\/inbox/);
	expect(errors).toEqual([]);
	await page.context().close();
});

test('Home\'s "older files match a record" line opens the Older files tab on the Exact match filter, listing only those files', async ({ browser }) => {
	// two older files: one names a record by short ID, one names nothing (the line counts only the first)
	const files = [...sampleFiles(), foundFile({ origin: 'backlog', rel_path: 'Users/ab1cd/old/nothing.tif' })];
	const { page, errors } = await start(browser, '/', 1280, { files });
	await page.locator('[data-test="home-inbox"]').getByRole('link', { name: /1 older file matches a record/ }).click();
	await expect(page).toHaveURL(/tab=older/);
	await expect(page).toHaveURL(/strength=short_id(,|%2C)code/);
	await expect(page.locator('[data-test="filter-strength"]')).toHaveValue('short_id,code');
	await expect(page.locator('[data-test="filter-strength"] option:checked')).toHaveText('Exact match');
	await expect.poll(() => names(page)).toEqual(['55ee66ff_old.tif']);
	expect(errors).toEqual([]);
	await page.context().close();
});

test('the rail shows the Inbox icon with its badge', async ({ browser }) => {
	const { page } = await start(browser, '/', 1280);
	await page.getByRole('button', { name: 'Collapse the sidebar' }).click();
	const icon = page.locator('aside').getByRole('link', { name: /^Inbox, 5 new files/ });
	await expect(icon).toBeVisible();
	await expect(icon.locator('[data-test="nav-badge"]')).toHaveText('5');
	await page.context().close();
});

test('the Inbox page: rows say what the crawler thinks and why; a surface scan has Add a surface scan, not Link; documents are collapsed', async ({ browser }) => {
	const { page, errors } = await start(browser, '/inbox');
	await expect.poll(() => names(page)).toEqual(['3fa9c1d2_A1.tif', '9ab3c4d5_B2.tif', 'plain.tif', 'edge1.al3d']);
	const first = row(page, '3fa9c1d2_A1.tif');
	await expect(first.locator('[data-test="suggestion"]')).toContainText('S-0042');
	await expect(first.locator('[data-test="suggestion"]')).toContainText('short ID `3fa9c1d2` in the file name');
	await expect(first).toContainText('Possible SEM image');
	await expect(row(page, '9ab3c4d5_B2.tif')).toContainText('15 kV · ×5,000 · 2 µm · JEOL');
	await expect(row(page, 'plain.tif').locator('[data-test="suggestion"]')).toHaveCount(0);

	// A file the crawler stored a picture for shows it (a button); every other row shows the icon of its kind; nothing was asked of the asset route.
	await expect(first.locator('button[data-test="thumb"]')).toHaveAccessibleName('View 3fa9c1d2_A1.tif');
	await expect(page.locator('[data-test="inbox-row"] button[data-test="thumb"] img')).toHaveCount(2);
	await expect(row(page, 'plain.tif').locator('button[data-test="thumb"]')).toHaveCount(0);
	await expect(row(page, 'edge1.al3d').locator('button[data-test="thumb"]')).toHaveCount(0);
	expect(assetRequests).toEqual([]);

	const scan = row(page, 'edge1.al3d');
	await expect(scan.getByRole('button', { name: 'Add a surface scan' })).toBeEnabled();
	await expect(scan.getByRole('button', { name: 'Link', exact: true })).toHaveCount(0);
	await expect(scan.locator('[data-test="scan-notice"]')).toHaveText('Added to an insert or an edge, with the condition you choose.');

	const other = page.locator('[data-test="other-files"]');
	await expect(other).toContainText('Other files');
	await expect(other).not.toContainText('notes.pdf');
	await other.locator('[data-test="toggle-other"]').click();
	await expect(other).toContainText('notes.pdf');
	await expect(other).toContainText('Linking reads this file once to fingerprint it.');
	await shot(page, 'inbox-new');
	expect(errors).toEqual([]);
	await page.context().close();
});

const thumb = (page: Page, name: string) => row(page, name).locator('button[data-test="thumb"]');
const preview = (page: Page) => page.locator('[data-test="preview-dialog"]');
/** The picture really decoded (a blob: URL under the production CSP can be blocked, which leaves a broken image). */
const decoded = (img: ReturnType<Page['locator']>) => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0);

test('a thumbnail appears in the row, a click opens the full view with its facts and the reduced-size line, and Esc closes it with focus back on the thumbnail', async ({ browser }) => {
	const { page, inbox, errors } = await start(browser, '/inbox', 1280, { previewDelayMs: 800 });
	const btn = thumb(page, '9ab3c4d5_B2.tif');
	await expect(btn.locator('img')).toBeVisible();
	await expect.poll(() => decoded(btn.locator('img'))).toBe(true);
	await shot(page, 'inbox-thumbnails');
	// only the two rows with a picture asked for one, and as the signed-in session (a blob request to d1-inbox, never an <img src> to it)
	expect(inbox.pictureStats.paths.filter((p) => p.endsWith('/thumb'))).toHaveLength(2);
	await btn.click();
	const dialog = preview(page);
	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole('heading', { name: '9ab3c4d5_B2.tif' })).toBeVisible();
	await expect(dialog).toContainText('Users/ab1cd/sem');
	await expect(dialog).toContainText('15 kV · ×5,000 · 2 µm · JEOL');
	await expect(dialog.locator('[data-test="preview-note"]')).toHaveText('Reduced-size preview. The original stays on the share.');
	// while the preview loads: a spinner, and the thumbnail enlarged behind it
	await expect(dialog.locator('[data-test="preview-loading"]')).toBeVisible();
	await expect(dialog.locator('[data-test="preview-thumb"]')).toBeVisible();
	// the dialog is outside the page frame (teleported to <body>), so it must bring the --d1-* tokens itself: its hairline and spinner colour resolve
	await expect(dialog).toHaveCSS('border-top-width', '1px');
	await expect(dialog.locator('.pv-spinner')).not.toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
	await shot(page, 'preview-loading');
	const image = dialog.locator('[data-test="preview-image"]');
	await expect(image).toBeVisible();
	await expect.poll(() => decoded(image)).toBe(true);
	await expect(dialog.locator('[data-test="preview-loading"]')).toHaveCount(0);
	await shot(page, 'preview-open');
	await page.keyboard.press('Escape');
	await expect(dialog).toBeHidden();
	await expect(btn).toBeFocused();
	expect(errors).toEqual([]);
	await page.context().close();
});

test('the full view closes on a click outside and on Close, keeps Tab inside, and a second open asks again', async ({ browser }) => {
	const { page } = await start(browser, '/inbox');
	const btn = thumb(page, '3fa9c1d2_A1.tif');
	await btn.click();
	const dialog = preview(page);
	await expect(dialog.locator('[data-test="preview-image"]')).toBeVisible();
	await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();
	await page.keyboard.press('Tab');
	await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();
	await page.keyboard.press('Shift+Tab');
	await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();
	await page.mouse.click(5, 5);
	await expect(dialog).toBeHidden();
	await expect(btn).toBeFocused();
	await btn.click();
	await expect(dialog).toBeVisible();
	await dialog.getByRole('button', { name: 'Close' }).click();
	await expect(dialog).toBeHidden();
	await expect(btn).toBeFocused();
	await page.context().close();
});

test('a preview that fails says so and Retry loads it; a thumbnail that fails leaves the kind icon, quietly', async ({ browser }) => {
	const { page, inbox } = await start(browser, '/inbox', 1280, { previewFails: 1 });
	await thumb(page, '3fa9c1d2_A1.tif').click();
	const dialog = preview(page);
	await expect(dialog.locator('[data-test="preview-error"]')).toContainText('The preview could not be loaded.');
	await expect(dialog.locator('[data-test="preview-note"]')).toBeVisible();
	await shot(page, 'preview-error');
	await dialog.getByRole('button', { name: 'Retry' }).click();
	await expect(dialog.locator('[data-test="preview-image"]')).toBeVisible();
	await expect(dialog.locator('[data-test="preview-error"]')).toHaveCount(0);
	expect(inbox.pictureStats.paths.filter((p) => p.endsWith('/preview'))).toHaveLength(2);
	await page.context().close();

	const failing = await start(browser, '/inbox', 1280, { thumbFails: true });
	await expect.poll(() => failing.inbox.pictureStats.thumbs).toBe(2);
	await expect(failing.page.locator('[data-test="inbox-row"] button[data-test="thumb"]')).toHaveCount(0);
	await expect(row(failing.page, '3fa9c1d2_A1.tif').locator('.thumb')).toBeVisible();
	await expect(failing.page.locator('[role="alert"]')).toHaveCount(0);
	await failing.page.context().close();
});

test('the full view fits a phone screen', async ({ browser }) => {
	const { page } = await start(browser, '/inbox', 390);
	await thumb(page, '3fa9c1d2_A1.tif').click();
	const dialog = preview(page);
	await expect(dialog.locator('[data-test="preview-image"]')).toBeVisible();
	const box = (await dialog.boundingBox())!;
	expect(box.x).toBeGreaterThanOrEqual(0);
	expect(box.x + box.width).toBeLessThanOrEqual(390);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	await shot(page, 'preview-phone');
	await dialog.getByRole('button', { name: 'Close' }).click();
	await expect(dialog).toBeHidden();
	await page.context().close();
});

// The stand-in knows the stub tool box's insert and edge (stubScans.ts), so a scan added to them is accepted and labelled with their codes.
const scanItems = { inserts: { [T.insertId]: T.insertCode }, edges: { [T.edgeId]: T.edgeCode } };
const scanDialog = (page: Page) => page.locator('[data-test="add-scan-dialog"]');

async function pickInsert(page: Page) {
	const dialog = scanDialog(page);
	await dialog.locator('[data-test="scan-item-search"]').fill('CNMG');
	await dialog.getByText(T.insertCode, { exact: true }).first().click();
}

test('Add a surface scan: the dialog warns the whole lab will see the file, has no condition chosen, and adds it to an insert; Recently linked says where, and Undo brings the file back', async ({ browser }) => {
	const { page, inbox, errors } = await start(browser, '/inbox', 1280, { scanItems });
	await row(page, 'edge1.al3d').getByRole('button', { name: 'Add a surface scan' }).click();
	const dialog = scanDialog(page);
	await expect(dialog).toBeVisible();
	await expect(dialog.locator('[data-test="visibility-warning"]')).toContainText('Adding a surface scan makes this file visible to every lab member');
	await expect(dialog.locator('input[name="scan-condition"]')).toHaveCount(4);
	await expect(dialog.locator('input[name="scan-condition"]:checked')).toHaveCount(0);
	await expect(dialog.locator('[data-test="scan-confirm"]')).toBeDisabled();
	await shot(page, 'scan-dialog-empty');
	await pickInsert(page);
	await expect(dialog.locator('[data-test="scan-confirm"]')).toBeDisabled();
	await dialog.getByText('Worn', { exact: true }).click();
	await expect(dialog.locator('[data-test="scan-confirm"]')).toBeEnabled();
	await shot(page, 'scan-dialog-filled');
	await dialog.locator('[data-test="scan-confirm"]').click();
	await expect(dialog).toBeHidden();
	await expect(page.locator('[data-test="notice"]')).toContainText(`Added as a surface scan of ${T.insertCode}. It is now visible to every lab member.`);
	await expect.poll(() => names(page)).not.toContain('edge1.al3d');
	expect(inbox.scans).toHaveLength(1);
	expect(inbox.scans[0]).toMatchObject({ insert_id: T.insertId, edge_id: null, condition: 'worn' });
	await page.locator('[data-test="tab-linked"]').click();
	await expect.poll(() => names(page)).toEqual(['edge1.al3d']);
	const linked = row(page, 'edge1.al3d').locator('[data-test="linked-to"]');
	await expect(linked).toContainText(`Added as a surface scan of ${T.insertCode} (worn)`);
	await expect(linked.getByRole('link', { name: `${T.insertCode} (worn)` })).toHaveAttribute('href', new RegExp(`/inserts/${T.insertId}$`));
	await expect(page.locator('[data-test="batch"]')).toContainText('Added as a surface scan, 1 file');
	await shot(page, 'scan-linked');
	await page.locator('[data-test="undo-batch"]').click();
	await expect(page.locator('[data-test="notice"]')).toContainText('Undone: 1 found file back in your Inbox.');
	expect(inbox.scans).toHaveLength(0);
	expect(inbox.files.find((f) => f.rel_path.endsWith('edge1.al3d'))!.state).toBe('new');
	expect(errors).toEqual([]);
	await page.context().close();
});

test('Add a surface scan to an edge with its operation, the day and a note', async ({ browser }) => {
	const { page, inbox } = await start(browser, '/inbox', 1280, { scanItems });
	await row(page, 'edge1.al3d').getByRole('button', { name: 'Add a surface scan' }).click();
	const dialog = scanDialog(page);
	await dialog.getByRole('radio', { name: 'Edge' }).click();
	await dialog.locator('[data-test="scan-item-search"]').fill('CNMG');
	await dialog.getByText(T.edgeCode, { exact: true }).first().click();
	const op = dialog.locator('[data-test="scan-operation"]');
	await expect(op).toBeEnabled();
	await op.selectOption({ index: 1 });
	await dialog.locator('[data-test="scan-date"]').fill('2026-10-14');
	await dialog.getByText('Cleaned', { exact: true }).click();
	await dialog.locator('[data-test="scan-condition-note"]').fill('ultrasonic bath');
	await dialog.locator('[data-test="scan-notes"]').fill('after pass 3');
	await dialog.locator('[data-test="scan-confirm"]').click();
	await expect(dialog).toBeHidden();
	expect(inbox.scans[0]).toMatchObject({ edge_id: T.edgeId, insert_id: null, condition: 'cleaned', scanned_on: '2026-10-14', condition_note: 'ultrasonic bath', notes: 'after pass 3' });
	expect(inbox.scans[0].operation_id).toBe('00000000-0000-4000-8000-0000000000c1');
	await page.context().close();
});

test('a refused add says why in the dialog, keeps it open and leaves the row in the Inbox', async ({ browser }) => {
	const { page, inbox } = await start(browser, '/inbox', 1280, { scanItems, scanAllowed: false });
	await row(page, 'edge1.al3d').getByRole('button', { name: 'Add a surface scan' }).click();
	const dialog = scanDialog(page);
	await pickInsert(page);
	await dialog.getByText('New', { exact: true }).click();
	await dialog.locator('[data-test="scan-confirm"]').click();
	await expect(dialog.locator('[data-test="scan-error"]')).toHaveText('You are not allowed to add surface scans.');
	await expect(dialog).toBeVisible();
	expect(inbox.scans).toHaveLength(0);
	await shot(page, 'scan-refused');
	await dialog.getByRole('button', { name: 'Cancel' }).click();
	await expect(dialog).toBeHidden();
	expect(await names(page)).toContain('edge1.al3d');
	await page.context().close();
});

test('Add a surface scan works at phone width: the dialog fits the screen and Confirm can be reached', async ({ browser }) => {
	const { page, inbox, errors } = await start(browser, '/inbox', 390);
	await row(page, 'edge1.al3d').getByRole('button', { name: 'Add a surface scan' }).click();
	const dialog = scanDialog(page);
	await expect(dialog).toBeVisible();
	const box = (await dialog.boundingBox())!;
	expect(box.x).toBeGreaterThanOrEqual(0);
	expect(box.x + box.width).toBeLessThanOrEqual(390);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	await pickInsert(page);
	await dialog.getByText('Worn', { exact: true }).click();
	await shot(page, 'scan-dialog-phone');
	const confirm = dialog.locator('[data-test="scan-confirm"]');
	await confirm.scrollIntoViewIfNeeded();
	await expect(confirm).toBeEnabled();
	await confirm.click();
	await expect(dialog).toBeHidden();
	expect(inbox.scans).toHaveLength(1);
	expect(errors).toEqual([]);
	await page.context().close();
});

test('Link a suggested file: the row goes, the badge drops, and Undo brings both back', async ({ browser }) => {
	const { page, inbox } = await start(browser, '/inbox');
	const badge = page.locator('aside').getByRole('link', { name: /^Inbox/ }).locator('[data-test="nav-badge"] [aria-hidden]');
	await expect(badge).toHaveText('5');
	await row(page, '3fa9c1d2_A1.tif').getByRole('button', { name: 'Link', exact: true }).click();
	await expect(page.locator('[data-test="notice"]')).toContainText('Linked 1 found file.');
	await expect.poll(() => names(page)).not.toContain('3fa9c1d2_A1.tif');
	await expect(badge).toHaveText('4');
	expect(inbox.files[0].state).toBe('linked');
	await page.locator('[data-test="undo"]').click();
	await expect.poll(() => names(page)).toContain('3fa9c1d2_A1.tif');
	await expect(badge).toHaveText('5');
	expect(inbox.files[0].state).toBe('new');
	await page.context().close();
});

test('Change: the record picker finds a sample by its code, and choosing it links the file there', async ({ browser }) => {
	const { page, inbox } = await start(browser, '/inbox');
	await row(page, 'plain.tif').getByRole('button', { name: 'Link to…' }).click();
	const dialog = page.getByRole('dialog');
	await expect(dialog).toBeVisible();
	await dialog.locator('[data-test="link-search"]').fill('S-0042');
	await expect(dialog).toContainText('Test coupon');
	await dialog.locator('input[name="inbox-record"]').first().check();
	await shot(page, 'link-dialog');
	await dialog.getByRole('button', { name: /^Link to S-0042$/ }).click();
	await expect(dialog).toBeHidden();
	const plain = inbox.files.find((f) => f.rel_path.endsWith('plain.tif'))!;
	expect(plain.linked_record_id).toBe('123e4567-e89b-42d3-a456-426614174000');
	await page.context().close();
});

test('Accept all opens on a dry run, names the count and where files go, links exactly those in one batch, and one Undo reverses it', async ({ browser }) => {
	const { page, inbox } = await start(browser, '/inbox');
	const accept = page.locator('[data-test="accept-all"]');
	await expect(accept).toBeEnabled();
	await accept.click();
	const confirm = page.locator('[data-test="accept-confirm"]');
	await expect(confirm).toContainText('Link 2 found files to the record that each short ID names?');
	await expect(page.locator('[data-test="accept-pairs"]')).toContainText('3fa9c1d2_A1.tif');
	await expect(page.locator('[data-test="accept-pairs"]')).toContainText('S-0042');
	await expect(page.locator('[data-test="accept-left"]')).toContainText('1 surface scan');
	// the dry run changed nothing, and asked with dry_run
	expect(inbox.files.every((f) => f.state === 'new')).toBe(true);
	expect(inbox.calls.filter((c) => c.path === '/d1-inbox/accept-all').map((c) => (c.body as { dry_run?: boolean }).dry_run === true)).toEqual([true]);
	await shot(page, 'accept-confirm');
	await page.locator('[data-test="accept-confirm-button"]').click();
	await expect(page.locator('[data-test="notice"]')).toContainText('Linked 2 found files.');
	const real = inbox.calls.filter((c) => c.path === '/d1-inbox/accept-all').at(-1)!;
	expect((real.body as { candidate_ids?: string[] }).candidate_ids).toHaveLength(2);
	expect(inbox.files.filter((f) => f.link_kind === 'bulk')).toHaveLength(2);
	await page.locator('[data-test="undo"]').click();
	await expect.poll(() => inbox.files.filter((f) => f.state === 'linked').length).toBe(0);
	await page.context().close();
});

test('after a Link, focus moves to the next row; the status region is one element that holds the message', async ({ browser }) => {
	const { page } = await start(browser, '/inbox');
	const region = page.locator('[data-test="status"]');
	await expect(region).toHaveAttribute('role', 'status');
	await row(page, '3fa9c1d2_A1.tif').getByRole('button', { name: 'Link', exact: true }).click();
	await expect(region).toContainText('Linked 1 found file.');
	await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[data-test="inbox-row"]')?.textContent?.includes('9ab3c4d5_B2.tif') ?? false)).toBe(true);
	await page.context().close();
});

test('tabs and filters live in the URL: Older files, then Dismissed with Restore, and a filtered link', async ({ browser }) => {
	const { page } = await start(browser, '/inbox');
	await page.locator('[data-test="tab-older"]').click();
	await expect(page).toHaveURL(/tab=older/);
	await expect.poll(() => names(page)).toEqual(['55ee66ff_old.tif']);
	await page.locator('[data-test="tab-new"]').click();
	await row(page, 'plain.tif').getByRole('button', { name: 'Dismiss' }).click();
	await expect.poll(() => names(page)).not.toContain('plain.tif');
	await page.locator('[data-test="tab-dismissed"]').click();
	await expect.poll(() => names(page)).toEqual(['plain.tif']);
	await row(page, 'plain.tif').getByRole('button', { name: 'Restore' }).click();
	await expect.poll(() => names(page)).toEqual([]);
	await page.goto(`${STAR_BASE}/inbox?kind=sem_image&strength=short_id`);
	await expect.poll(() => names(page)).toEqual(['3fa9c1d2_A1.tif', '9ab3c4d5_B2.tif']);
	await expect(page.locator('[data-test="filter-kind"]')).toHaveValue('sem_image');
	await page.context().close();
});

test('Recently linked groups the files of one batch under a single Undo', async ({ browser }) => {
	const { page, inbox } = await start(browser, '/inbox');
	await page.locator('[data-test="accept-all"]').click();
	await page.locator('[data-test="accept-confirm-button"]').click();
	await expect(page.locator('[data-test="notice"]')).toContainText('Linked 2 found files.');
	await page.locator('[data-test="tab-linked"]').click();
	await expect(page).toHaveURL(/tab=linked/);
	const batch = page.locator('[data-test="batch"]');
	await expect(batch).toHaveCount(1);
	await expect(batch).toContainText('Accepted in bulk, 2 files');
	await expect.poll(() => names(page)).toEqual(['3fa9c1d2_A1.tif', '9ab3c4d5_B2.tif']);
	await expect(row(page, '3fa9c1d2_A1.tif').locator('[data-test="linked-to"]')).toContainText('Accepted in bulk to S-0042');
	await shot(page, 'inbox-linked');
	await batch.locator('[data-test="undo-batch"]').click();
	await expect(page.locator('[data-test="notice"]')).toContainText('Undone: 2 found files back in your Inbox.');
	await expect.poll(() => names(page)).toEqual([]);
	expect(inbox.files.filter((f) => f.state === 'linked')).toHaveLength(0);
	await page.context().close();
});

test('Rescan my folder: the second request shows the rate-limit message', async ({ browser }) => {
	const { page } = await start(browser, '/inbox');
	await page.locator('[data-test="rescan"]').click();
	await expect(page.locator('[data-test="notice"]')).toContainText('Rescan requested.');
	await page.locator('[data-test="rescan"]').click();
	await expect(page.locator('[data-test="notice"]')).toContainText('A scan of your folder is already queued or ran recently.');
	await expect(page.locator('[data-test="notice"]')).toContainText('rescanned once every 10 minutes');
	await shot(page, 'rescan-429');
	await page.context().close();
});

test('Settings: the auto-link switch is off, shows its consent text, and turns on only through the confirm', async ({ browser }) => {
	const { page, inbox } = await start(browser, '/settings', 1280, {
		files: [foundFile({ state: 'linked', link_kind: 'auto', link_batch_id: 'b1', decided_at: '2026-10-15T09:00:00Z', linked_label: 'S-0042', linked_collection: 'physical_samples', linked_record_id: '123e4567-e89b-42d3-a456-426614174000', rel_path: 'Users/ab1cd/sem/3fa9c1d2.tif' })],
	});
	const section = page.locator('[data-test="autolink-section"]');
	await expect(section).toBeVisible();
	const sw = section.locator('[data-test="autolink-switch"]');
	await expect(sw).not.toBeChecked();
	await expect(section).toContainText('Documents are never linked automatically');
	await expect(section).toContainText('Recently auto-linked');
	await expect(section.locator('[data-test="recently-auto-linked"]')).toContainText('3fa9c1d2.tif');
	await shot(page, 'settings-inbox');
	await sw.click();
	const dialog = page.getByRole('dialog');
	await expect(dialog).toContainText('exactly one record that you can edit');
	await expect(sw).not.toBeChecked();
	await dialog.locator('[data-test="autolink-confirm"]').click();
	await expect(sw).toBeChecked();
	expect(inbox.calls.at(-1)).toMatchObject({ method: 'put', body: { auto_link: true } });
	await section.locator('[data-test="autolink-undo"]').click();
	await expect(section.locator('[data-test="recently-auto-linked"]')).toContainText('Nothing was linked automatically yet.');
	await page.context().close();
});

test('the Inbox crawler tab on /crawler (admin): daemon, last scan, folders no one owns, people with no alias, Scan all', async ({ browser }) => {
	const { page, inbox } = await start(browser, '/crawler?tab=inbox');
	await expect(page.locator('[data-test="ic-daemon"]')).toHaveText('Online, running');
	await expect(page.locator('[data-test="ic-unmatched"]')).toContainText('Users/zz9');
	await expect(page.locator('[data-test="ic-no-alias"]')).toContainText('Bo Chan');
	await expect(page.locator('[data-test="inbox-crawler"]')).toContainText('People without a uni alias');
	await page.locator('[data-test="ic-scan-all"]').click();
	await expect(page.locator('[data-test="inbox-crawler"]')).toContainText('Scan of every folder requested.');
	expect(inbox.calls.some((c) => c.path === '/d1-inbox/admin/scan-all')).toBe(true);
	await shot(page, 'crawler-inbox');
	await page.locator('[data-test="crawler-tab-force"]').click();
	await expect(page).not.toHaveURL(/tab=inbox/);
	await page.context().close();
});

test('on a server with no d1-inbox the sidebar has no Inbox entry and Home has no panel', async ({ browser }) => {
	const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
	const page = await context.newPage();
	await stubD1(context);
	// Directus answers 404 for a route no extension serves.
	await context.route(`${D1_BASE}/d1-inbox/**`, (r) => r.fulfill({ status: 404, headers: { 'access-control-allow-origin': STAR_BASE, 'access-control-allow-credentials': 'true' }, json: { errors: [{ message: "Route /d1-inbox/summary doesn't exist.", extensions: { code: 'ROUTE_NOT_FOUND' } }] } }));
	await page.goto(STAR_BASE + '/');
	await expect(page.locator('aside nav.d1-nav')).toBeVisible();
	await expect(page.locator('aside').getByRole('link', { name: /^Inbox/ })).toHaveCount(0);
	await expect(page.locator('[data-test="home-inbox"]')).toHaveCount(0);
	await context.close();
});
