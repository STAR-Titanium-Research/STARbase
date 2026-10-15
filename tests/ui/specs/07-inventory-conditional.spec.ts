import { test, expect } from '../fixtures';
import { gotoCreateForm, selectDropdown, isFieldVisible, fieldByLabel, requireEnv } from '../helpers';

const EMAIL = process.env.D1_ADMIN_EMAIL || 'admin@example.com';
const PASSWORD = requireEnv('D1_ADMIN_PASSWORD');

/**
 * Inventory items show fields relevant to their kind and geometry:
 * - Item Type is hidden (the database defaults it to sample): geometry/dimension/mounting fields are on a blank form
 * - an existing rig-kit row (item_type equipment/misc) hides those sample-only fields
 * - geometry (form) controls which dimensions show (cylindrical → Ø + length,
 *   not width; rectangular → width/length/thickness, not Ø)
 * - the live geometry visualiser (Shape Preview) renders
 */
test.describe('Inventory — conditional fields by kind & geometry', () => {
	test('cylindrical sample shows Ø + length, hides width; visualiser renders', async ({ page }, testInfo) => {
		await gotoCreateForm(page, 'physical_samples');
		await selectDropdown(page, 'Geometry', 'Cylinder');
		await page.waitForTimeout(800);

		await testInfo.attach('cylinder-sample', {
			body: await page.screenshot({ fullPage: true }),
			contentType: 'image/png',
		});

		expect(await isFieldVisible(page, 'Diameter Ø')).toBeTruthy();
		expect(await isFieldVisible(page, 'Length')).toBeTruthy();
		expect(await isFieldVisible(page, 'Width')).toBeFalsy();
		// geometry visualiser present
		await expect(fieldByLabel(page, 'Shape Preview').locator('svg')).toBeVisible();
	});

	test('block sample shows width/length/thickness, hides Ø', async ({ page }) => {
		await gotoCreateForm(page, 'physical_samples');
		await selectDropdown(page, 'Geometry', 'Block');
		await page.waitForTimeout(800);

		expect(await isFieldVisible(page, 'Width')).toBeTruthy();
		expect(await isFieldVisible(page, 'Thickness')).toBeTruthy();
		expect(await isFieldVisible(page, 'Diameter Ø')).toBeFalsy();
	});

	test('round bar shows Ø + length, hides width and thickness', async ({ page }) => {
		await gotoCreateForm(page, 'physical_samples');
		await selectDropdown(page, 'Geometry', 'Round bar');
		await page.waitForTimeout(800);

		expect(await isFieldVisible(page, 'Diameter Ø')).toBeTruthy();
		expect(await isFieldVisible(page, 'Length')).toBeTruthy();
		expect(await isFieldVisible(page, 'Width')).toBeFalsy();
		expect(await isFieldVisible(page, 'Thickness')).toBeFalsy();
		await expect(fieldByLabel(page, 'Shape Preview').locator('svg')).toBeVisible();
	});

	test('tensile coupon shows gauge fields; a plain bar does not', async ({ page }) => {
		await gotoCreateForm(page, 'physical_samples');
		await selectDropdown(page, 'Geometry', 'Tensile coupon');
		await page.waitForTimeout(800);
		expect(await isFieldVisible(page, 'Gauge length')).toBeTruthy();
		expect(await isFieldVisible(page, 'Gauge width')).toBeTruthy();

		await selectDropdown(page, 'Geometry', 'Bar', { exact: true });
		await page.waitForTimeout(800);
		expect(await isFieldVisible(page, 'Gauge length')).toBeFalsy();
		expect(await isFieldVisible(page, 'Diameter Ø')).toBeFalsy();
	});

	test('a rig-kit item (item type equipment) hides sample-only fields (geometry, mounting)', async ({ page }) => {
		// Item Type is hidden on the form, so open an existing rig-kit row (equipment / miscellaneous).
		const token = (await (await page.request.post('/auth/login', { data: { email: EMAIL, password: PASSWORD } })).json()).data.access_token;
		const rows = (await (await page.request.get('/items/physical_samples?limit=1&filter[item_type][_in]=equipment,miscellaneous&fields=sample_id', { headers: { Authorization: `Bearer ${token}` } })).json()).data;
		test.skip(!rows.length, 'no rig-kit (equipment / miscellaneous) row in this database');
		await page.goto(`/admin/content/physical_samples/${rows[0].sample_id}`, { waitUntil: 'domcontentloaded' });
		await page.locator('.field').first().waitFor({ state: 'visible', timeout: 30_000 });
		await page.waitForTimeout(800);

		expect(await isFieldVisible(page, 'Geometry')).toBeFalsy();
		expect(await isFieldVisible(page, 'Mounting Method')).toBeFalsy();
		expect(await isFieldVisible(page, 'Sample Code')).toBeTruthy();
	});
});
