import { test, expect } from '../fixtures';
import { request, type APIRequestContext, type Page } from '@playwright/test';
import { gotoCreateForm, selectDropdown, fieldByLabel, fillInput, requireEnv } from '../helpers';

/**
 * Form QA 2026-10-14 (migration 20261014000173): the four bugs found by driving the create forms.
 *  - a Test Session saves from the form (the hidden sample_id was required, so every save was refused);
 *  - an "Imaging / Analysis" campaign saves (the CHECK rejected it with HTTP 500);
 *  - Owner shows a person's name, not a UUID in a text box (the d1-owner-picker interface is not installed);
 *  - an operation's stored machining sub-type (MT-F, ...) shows its label.
 */
const BASE = process.env.D1_BASE_URL || 'http://localhost:8055';
const EMAIL = process.env.D1_ADMIN_EMAIL || 'admin@example.com';
const PASSWORD = requireEnv('D1_ADMIN_PASSWORD');
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

let api: APIRequestContext;
let h: Record<string, string>;
const created: [string, string][] = [];

test.beforeAll(async () => {
	api = await request.newContext({ baseURL: BASE });
	const login = await api.post('/auth/login', { data: { email: EMAIL, password: PASSWORD } });
	h = { Authorization: `Bearer ${(await login.json()).data.access_token}` };
});
test.afterAll(async () => {
	for (const [c, id] of created.reverse()) await api.delete(`/items/${c}/${id}`, { headers: h });
	await api.dispose();
});

async function saveAndCapture(page: Page, collection: string) {
	const resp = page.waitForResponse((r) => r.url().includes(`/items/${collection}`) && r.request().method() === 'POST');
	await page.locator('.header-bar .v-button').filter({ has: page.locator('[data-icon="check"]') }).first().click();
	return resp;
}

test('a test session saves from the form with a subject and the date picked', async ({ page }) => {
	const sample = (await (await api.get('/items/physical_samples?limit=1&sort=-created_at&fields=sample_id,sample_code', { headers: h })).json()).data[0];
	await gotoCreateForm(page, 'test_sessions');
	await selectDropdown(page, 'Test Type', 'Hardness');
	const subject = fieldByLabel(page, 'Subject');
	await subject.getByRole('button', { name: /add existing/i }).click();
	await page.locator('.v-menu-content').last().locator('.v-list-item').first().click(); // the samples collection
	const drawer = page.locator('.v-drawer').last();
	await drawer.waitFor({ state: 'visible' });
	await drawer.locator('.search-input').first().click();
	await drawer.locator('.search-input input').fill(sample.sample_code);
	await drawer.locator('tbody tr').filter({ hasText: sample.sample_code }).first().click();
	await drawer.locator('header .v-button').last().click();
	await expect(subject).toContainText(sample.sample_code);

	// Session Date is required in the form since migration 174
	await fieldByLabel(page, 'Session Date').locator('.interface button').first().click();
	await page.locator('.v-menu-content .calendar-cell-trigger:not([data-outside-view])').first().click(); // any day of the month shown
	await page.keyboard.press('Escape');

	const resp = await saveAndCapture(page, 'test_sessions');
	expect(resp.status()).toBe(200);
	const id = (await resp.json()).data.session_id;
	created.push(['test_sessions', id]);
	const row = (await (await api.get(`/items/test_sessions/${id}?fields=sample_id`, { headers: h })).json()).data;
	expect(row.sample_id).toBe(sample.sample_id); // derived from the subject by the database
});

test('an Imaging / Analysis campaign saves', async ({ page }) => {
	await gotoCreateForm(page, 'campaigns');
	await selectDropdown(page, 'Campaign Type', 'Imaging / Analysis');
	await fillInput(page, 'Name', `PW-IMG-${Date.now()}`);
	const resp = await saveAndCapture(page, 'campaigns');
	expect(resp.status()).toBe(200);
	created.push(['campaigns', (await resp.json()).data.campaign_id]);
});

test('Owner shows the owner by name, not a UUID', async ({ page }) => {
	const s = (await (await api.get('/items/physical_samples?limit=1&filter[owner_person_id][_nnull]=true&fields=sample_id,owner_person_id.full_name', { headers: h })).json()).data[0];
	await page.goto(`/admin/content/physical_samples/${s.sample_id}`, { waitUntil: 'domcontentloaded' });
	const owner = fieldByLabel(page, 'Owner');
	await expect(owner).toContainText(s.owner_person_id.full_name);
	expect(await owner.locator('input').count()).toBe(0); // a related-item dropdown, not a text box
	expect(await owner.innerText()).not.toMatch(UUID);
});

test('a stored machining sub-type shows its label', async ({ page }) => {
	const op = (await (await api.get('/items/manufacturing_operations?limit=1&filter[machining_operation_subtype][_eq]=MT-F&fields=operation_id', { headers: h })).json()).data[0];
	test.skip(!op, 'no MT-F operation in this database');
	await page.goto(`/admin/content/manufacturing_operations/${op.operation_id}`, { waitUntil: 'domcontentloaded' });
	await expect(fieldByLabel(page, 'Operation Sub-type').locator('input').first()).toHaveValue('Turning – Facing');
});
