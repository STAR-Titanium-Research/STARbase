import { test, expect } from '../fixtures';
import { type Page } from '@playwright/test';
import { gotoCreateForm, selectDropdown, selectM2O, fieldByLabel, isFieldVisible } from '../helpers';

/**
 * Form layout (migration 20261014000174): every record form is a stack of headed Field groups.
 * A group renders as `.v-detail.group-detail` with its title in `.v-divider .title`; this reads the visible titles in
 * order, so the test follows the layout without depending on how a group is drawn.
 */
async function groupTitles(page: Page): Promise<string[]> {
	return page.evaluate(() =>
		[...document.querySelectorAll('.v-form .v-detail.group-detail')]
			.filter((g) => g.getClientRects().length > 0)
			.map((g) => g.querySelector('.v-divider .title')?.textContent?.trim() ?? '?'),
	);
}

test.describe('Form layout — Field groups', () => {
	test('Sample: groups in order, Material and Geometry on a blank form, Item Type hidden, no Related records yet', async ({ page }) => {
		await gotoCreateForm(page, 'physical_samples');
		expect(await groupTitles(page)).toEqual([
			'What', 'Material & origin', 'Geometry', 'Surface & mounting', 'Who & where', 'Notes', 'Legacy / system',
		]);
		expect(await isFieldVisible(page, 'Material')).toBeTruthy();
		expect(await isFieldVisible(page, 'Geometry')).toBeTruthy();
		expect(await isFieldVisible(page, 'Item Type')).toBeFalsy();
	});

	test('Operation: What and Who & where first; the machining groups appear with a machining method', async ({ page }) => {
		await gotoCreateForm(page, 'manufacturing_operations');
		expect(await groupTitles(page)).toEqual(['What', 'Who & where', 'Notes & files', 'Legacy / system']);
		await selectM2O(page, 'Method', 'Milling');
		await page.waitForTimeout(800);
		expect(await groupTitles(page)).toEqual([
			'What', 'Who & where', 'Tooling', 'Cutting parameters', 'Data capture', 'Notes & files', 'Legacy / system',
		]);
	});

	test('Test: a type shows its parameters group before its results group', async ({ page }) => {
		await gotoCreateForm(page, 'test_sessions');
		expect(await groupTitles(page)).toEqual(['What', 'Who & where', 'Notes & files', 'Legacy / system']);
		await selectDropdown(page, 'Test Type', 'Tensile');
		await page.waitForTimeout(800);
		expect(await groupTitles(page)).toEqual([
			'What', 'Who & where', 'Tensile parameters', 'Tensile results', 'Notes & files', 'Legacy / system',
		]);
		expect(await isFieldVisible(page, 'UTS')).toBeTruthy();
	});

	test('Project, Campaign and Raw stock lot: What first, Related records collapsed', async ({ page }) => {
		await gotoCreateForm(page, 'projects');
		expect(await groupTitles(page)).toEqual(['What', 'Who', 'Related records', 'Legacy / system']);
		await gotoCreateForm(page, 'campaigns');
		expect(await groupTitles(page)).toEqual(['What', 'Who & where', 'Notes', 'Related records', 'Legacy / system']);
		await gotoCreateForm(page, 'raw_stock_lots');
		expect(await groupTitles(page)).toEqual(['What', 'Supplier', 'Quantity', 'Notes']);
		// the three fields that had no field row until migration 174 carry proper labels
		expect(await isFieldVisible(page, 'Certificate URL')).toBeTruthy();
		expect(await isFieldVisible(page, 'Purity %')).toBeTruthy();
		expect(await isFieldVisible(page, 'Mesh Size')).toBeFalsy(); // powder only
		await selectDropdown(page, 'Stock Type', 'Powder');
		expect(await isFieldVisible(page, 'Mesh Size')).toBeTruthy();
		await expect(fieldByLabel(page, 'Lot Code')).toBeVisible();
	});
});
