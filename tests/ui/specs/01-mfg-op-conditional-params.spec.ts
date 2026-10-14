import { test, expect } from '../fixtures';
import { gotoCreateForm, selectM2O, isFieldVisible } from '../helpers';

/**
 * Manufacturing Operations: the user picks only a **Manufacturing Method**. The
 * Process Category is inferred from it by the d1-process-category interface, and
 * that drives which typed parameter fields appear inline. (Directus field
 * conditions can't read the method M2O directly, so the inferred scalar
 * process_category is the bridge — migration 031 + the auto interface.)
 */
test.describe('Manufacturing Operation — method drives inline parameter fields', () => {
	test('no method selected → no typed param fields visible', async ({ page }) => {
		await gotoCreateForm(page, 'manufacturing_operations');
		expect(await isFieldVisible(page, 'Cutting Speed Vc')).toBeFalsy();
		expect(await isFieldVisible(page, 'Mould Diameter')).toBeFalsy();
	});

	test('a machining method shows machining fields inline only', async ({ page }, testInfo) => {
		await gotoCreateForm(page, 'manufacturing_operations');
		await selectM2O(page, 'Method', 'Machining (General)');
		await page.waitForTimeout(1200); // method → category lookup → conditions

		await testInfo.attach('after-machining-method', {
			body: await page.screenshot({ fullPage: true }),
			contentType: 'image/png',
		});

		expect(await isFieldVisible(page, 'Cutting Speed Vc')).toBeTruthy();
		expect(await isFieldVisible(page, 'Spindle Speed')).toBeTruthy();
		expect(await isFieldVisible(page, 'Mould Diameter')).toBeFalsy();

		// Regression: the Machining Parameters accordion must RENDER, not throw the
		// Directus error boundary. Config drift between a group and its children
		// (a child missing the group's hidden+condition) surfaces as this text.
		await expect(page.getByText(/unexpected error/i)).toHaveCount(0);
	});

	// Turning (MT) and Milling (MM) are real machining methods; selecting them must
	// reveal the Machining accordion cleanly — this is the exact case that regressed.
	for (const method of ['Turning', 'Milling']) {
		test(`${method} method renders machining params without an error boundary`, async ({ page }) => {
			await gotoCreateForm(page, 'manufacturing_operations');
			await selectM2O(page, 'Method', method);
			await page.waitForTimeout(1200);

			expect(await isFieldVisible(page, 'Cutting Speed Vc')).toBeTruthy();
			await expect(page.getByText(/unexpected error/i)).toHaveCount(0);
		});
	}

	test('a FAST/SPS method shows sintering fields inline only', async ({ page }) => {
		await gotoCreateForm(page, 'manufacturing_operations');
		await selectM2O(page, 'Method', 'FAST/SPS Sintering');
		await page.waitForTimeout(1200);

		expect(await isFieldVisible(page, 'Mould Diameter')).toBeTruthy();
		expect(await isFieldVisible(page, 'Cutting Speed Vc')).toBeFalsy();
	});

	test('an additive method shows AM fields inline only', async ({ page }) => {
		await gotoCreateForm(page, 'manufacturing_operations');
		await selectM2O(page, 'Method', 'Additive Manufacturing');
		await page.waitForTimeout(1200);

		expect(await isFieldVisible(page, 'Layer Thickness')).toBeTruthy();
		expect(await isFieldVisible(page, 'Cutting Speed Vc')).toBeFalsy();
	});
});
