import { test, expect } from '../fixtures';
import { gotoCreateForm, selectDropdown, isFieldVisible, fieldByLabel } from '../helpers';

/**
 * Inventory items show fields relevant to their kind and geometry:
 * - item_type = sample → geometry/dimension/mounting fields available
 * - item_type = equipment/misc → those sample-only fields hidden
 * - geometry (form) controls which dimensions show (cylindrical → Ø + length,
 *   not width; rectangular → width/length/thickness, not Ø)
 * - the live geometry visualiser (Shape Preview) renders
 */
test.describe('Inventory — conditional fields by kind & geometry', () => {
	test('cylindrical sample shows Ø + length, hides width; visualiser renders', async ({ page }, testInfo) => {
		await gotoCreateForm(page, 'physical_samples');
		await selectDropdown(page, 'Item Type', 'Sample');
		await selectDropdown(page, 'Geometry', 'Cylinder');
		await page.waitForTimeout(800);

		await testInfo.attach('cylinder-sample', {
			body: await page.screenshot({ fullPage: true }),
			contentType: 'image/png',
		});

		expect(await isFieldVisible(page, 'Ø (mm)')).toBeTruthy();
		expect(await isFieldVisible(page, 'z / Length (mm)')).toBeTruthy();
		expect(await isFieldVisible(page, 'x / Width (mm)')).toBeFalsy();
		// geometry visualiser present
		await expect(fieldByLabel(page, 'Shape Preview').locator('svg')).toBeVisible();
	});

	test('block sample shows width/length/thickness, hides Ø', async ({ page }) => {
		await gotoCreateForm(page, 'physical_samples');
		await selectDropdown(page, 'Item Type', 'Sample');
		await selectDropdown(page, 'Geometry', 'Block');
		await page.waitForTimeout(800);

		expect(await isFieldVisible(page, 'x / Width (mm)')).toBeTruthy();
		expect(await isFieldVisible(page, 'y / Thickness (mm)')).toBeTruthy();
		expect(await isFieldVisible(page, 'Ø (mm)')).toBeFalsy();
	});

	test('round bar shows Ø + length, hides width and thickness', async ({ page }) => {
		await gotoCreateForm(page, 'physical_samples');
		await selectDropdown(page, 'Item Type', 'Sample');
		await selectDropdown(page, 'Geometry', 'Round bar');
		await page.waitForTimeout(800);

		expect(await isFieldVisible(page, 'Ø (mm)')).toBeTruthy();
		expect(await isFieldVisible(page, 'z / Length (mm)')).toBeTruthy();
		expect(await isFieldVisible(page, 'x / Width (mm)')).toBeFalsy();
		expect(await isFieldVisible(page, 'y / Thickness (mm)')).toBeFalsy();
		await expect(fieldByLabel(page, 'Shape Preview').locator('svg')).toBeVisible();
	});

	test('tensile coupon shows gauge fields; a plain bar does not', async ({ page }) => {
		await gotoCreateForm(page, 'physical_samples');
		await selectDropdown(page, 'Item Type', 'Sample');
		await selectDropdown(page, 'Geometry', 'Tensile coupon');
		await page.waitForTimeout(800);
		expect(await isFieldVisible(page, 'Gauge length')).toBeTruthy();
		expect(await isFieldVisible(page, 'Gauge width')).toBeTruthy();

		await selectDropdown(page, 'Geometry', 'Bar', { exact: true });
		await page.waitForTimeout(800);
		expect(await isFieldVisible(page, 'Gauge length')).toBeFalsy();
		expect(await isFieldVisible(page, 'Ø (mm)')).toBeFalsy();
	});

	test('equipment item hides sample-only fields (geometry, mounting)', async ({ page }) => {
		await gotoCreateForm(page, 'physical_samples');
		await selectDropdown(page, 'Item Type', 'Equipment');
		await page.waitForTimeout(800);

		expect(await isFieldVisible(page, 'Geometry')).toBeFalsy();
		expect(await isFieldVisible(page, 'Mounting Method')).toBeFalsy();
	});
});
