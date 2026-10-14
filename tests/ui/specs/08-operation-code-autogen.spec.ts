import { test, expect } from '../fixtures';
import { gotoCreateForm, selectM2O, selectDropdown, fillInput, fieldByLabel } from '../helpers';

/**
 * Manufacturing Operation: the "Operation Code" (pass_code) is auto-composed by the
 * d1-operation-code interface from the input sample, operation sub-type, pass number
 * and cutting parameters — format:
 *   {sample_code}-{subtype}{pass#}-{speed}MPM_{feed}feed_{axial DoC}DoC
 * It stays editable (manual override) but auto-fills while untouched.
 */
test.describe('Manufacturing Operation — operation code auto-generation', () => {
	test('composes the canonical code live from the form fields', async ({ page }) => {
		await gotoCreateForm(page, 'manufacturing_operations');
		await selectM2O(page, 'Manufacturing Method', 'Milling');
		await page.waitForTimeout(1200);
		await selectM2O(page, 'Input Sample / Workpiece', '9-AA-MR-2023-3-24');
		await page.waitForTimeout(800);
		await selectDropdown(page, 'Operation Sub-type', 'Milling – Slotting');
		await page.waitForTimeout(400);
		await fillInput(page, 'Pass #', '6');
		await fillInput(page, 'Cutting Speed Vc', '80');
		await fillInput(page, 'Feed', '0.05');
		await fillInput(page, 'Axial Depth of Cut', '0.1');
		await page.waitForTimeout(800);

		const code = await fieldByLabel(page, 'Operation Code').locator('input').first().inputValue();
		// The method prefix of the sub-type is dropped (MM-S gives S): migration 20261010000156, as in every stored code.
		expect(code).toBe('9-AA-MR-2023-3-24-S6-80MPM_0.05feed_0.1DoC');
	});

	test('a manual edit is preserved (override stops auto-fill)', async ({ page }) => {
		await gotoCreateForm(page, 'manufacturing_operations');
		await selectM2O(page, 'Manufacturing Method', 'Milling');
		await page.waitForTimeout(1200);
		await selectM2O(page, 'Input Sample / Workpiece', '9-AA-MR-2023-3-24');
		await page.waitForTimeout(800);

		const input = fieldByLabel(page, 'Operation Code').locator('input').first();
		await input.fill('CUSTOM-CODE-123');
		// Changing another field must NOT clobber the manual value.
		await selectDropdown(page, 'Operation Sub-type', 'Milling – Slotting');
		await page.waitForTimeout(600);
		expect(await input.inputValue()).toBe('CUSTOM-CODE-123');
	});
});
