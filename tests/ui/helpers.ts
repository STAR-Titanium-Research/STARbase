import { type Page, type Locator, expect } from '@playwright/test';

const BASE = process.env.D1_BASE_URL || 'http://localhost:8055';
const EMAIL = process.env.D1_ADMIN_EMAIL || 'admin@example.com';
const PASSWORD = process.env.D1_ADMIN_PASSWORD || 'change_me_admin';

/**
 * Log into Directus through the UI. Done per-test (not via shared storageState)
 * because Directus rotates refresh tokens — a session shared across contexts gets
 * invalidated when the first context refreshes it.
 */
export async function login(page: Page) {
	await page.goto(`${BASE}/admin/login`, { waitUntil: 'domcontentloaded' });
	await page.locator('input[type="email"]').fill(EMAIL);
	await page.locator('input[type="password"]').fill(PASSWORD);
	await page.getByRole('button', { name: /sign in/i }).click();
	await page.waitForURL((url) => !url.pathname.endsWith('/login'), { timeout: 30_000 });
}

/**
 * Helpers for driving Directus 11 item forms.
 *
 * Directus renders each field inside a `.field` wrapper whose `<label>` (or
 * `.type-label`) carries the human field name. Interfaces render menus into a
 * portalled `.v-menu-content` overlay appended to <body>, so option clicks must
 * target that overlay, not the field wrapper.
 */

/** Open the create form for a collection. */
export async function gotoCreateForm(page: Page, collection: string) {
	// `domcontentloaded` (not `networkidle`) — Directus holds live connections,
	// so networkidle flakes under sustained load across the suite.
	await page.goto(`/admin/content/${collection}/+`, { waitUntil: 'domcontentloaded' });
	// The form renders the fields; wait for at least one field label.
	await page.locator('.field').first().waitFor({ state: 'visible', timeout: 30_000 });
	await page.waitForTimeout(300);
}

/** The `.field` wrapper whose visible label matches `name` (exact, case-insensitive). */
export function fieldByLabel(page: Page, name: string): Locator {
	return page
		.locator('.field')
		.filter({ has: page.locator('.type-label, label').filter({ hasText: new RegExp(`^\\s*${escapeRe(name)}`, 'i') }) })
		.first();
}

/** True if a field with the given label is rendered AND visible on the form. */
export async function isFieldVisible(page: Page, name: string): Promise<boolean> {
	const f = fieldByLabel(page, name);
	return (await f.count()) > 0 && (await f.isVisible());
}

/**
 * Pick a value from a Directus `select-dropdown` (enum) field. Clicks the field
 * to open the portalled option list, then clicks the option whose text starts
 * with `optionText` (so "Machining" matches "Machining (turning / …)"); pass
 * `{ exact: true }` to match the whole option text, e.g. "Bar" without "Round bar".
 */
export async function selectDropdown(page: Page, fieldLabel: string, optionText: string, opts: { exact?: boolean } = {}) {
	const field = fieldByLabel(page, fieldLabel);
	await field.locator('.v-input, input').first().click();
	await page.waitForTimeout(400);
	// Scope to the portalled dropdown overlay so we don't match nav items
	// (e.g. the "Inventory / Samples" nav entry contains "Sample").
	const overlay = page.locator('.v-menu-content').last();
	await overlay.waitFor({ state: 'visible' });
	const option = overlay
		.locator('.v-list-item')
		.filter({ hasText: new RegExp(opts.exact ? `^\\s*${escapeRe(optionText)}\\s*$` : escapeRe(optionText), 'i') })
		.first();
	await option.click();
}

/**
 * Pick a related item from a Directus M2O field. Clicking "Select an item…"
 * opens a `.v-drawer` with a searchable list; click the row matching `optionText`.
 */
export async function selectM2O(page: Page, fieldLabel: string, optionText: string) {
	const field = fieldByLabel(page, fieldLabel);
	await field.getByText(/select an item/i).first().click();
	const drawer = page.locator('.v-drawer').last();
	await drawer.waitFor({ state: 'visible' });
	await page.waitForTimeout(700);
	// Large collections are virtualized — a specific row may not be rendered at the
	// current scroll position, so filter via the drawer search first. Tightly scoped
	// + short timeout so small lists (no visible search box) are unaffected and it
	// can never hang the test.
	try {
		const box = drawer.locator('.search-input').first();
		await box.waitFor({ state: 'visible', timeout: 2500 });
		await box.click(); // activate — the input is collapsed until clicked
		await page.waitForTimeout(200);
		await box.locator('input').fill(optionText);
		await page.waitForTimeout(900); // debounce + query
	} catch {
		/* no usable search box — fall through to a direct click */
	}
	await drawer.getByText(new RegExp(escapeRe(optionText), 'i')).first().click();
	// Confirm the selection (the ✓ button in the drawer header) to apply and close.
	await drawer.locator('header .v-button').last().click();
	await drawer.waitFor({ state: 'hidden' });
	await page.waitForTimeout(400);
}

/** Fill a plain text/number input field by its label. */
export async function fillInput(page: Page, fieldLabel: string, value: string) {
	const field = fieldByLabel(page, fieldLabel);
	await field.locator('input').first().fill(value);
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
