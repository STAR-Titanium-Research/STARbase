import { test, expect } from '../fixtures';
import { gotoCreateForm, selectDropdown, fillInput, fieldByLabel } from '../helpers';

/**
 * Physical Samples: the custom "Shape Preview" interface (d1-geometry-preview)
 * renders a live SVG sketch from the Geometry + dimension fields as the form is
 * filled in.
 */
test.describe('Sample — live geometry preview', () => {
	test('cylindrical geometry + dimensions render an SVG sketch', async ({ page }, testInfo) => {
		await gotoCreateForm(page, 'physical_samples');

		// Item Type is hidden (the database defaults it to sample); Geometry and the dimensions show on a blank form.
		await selectDropdown(page, 'Geometry', 'Cylinder');
		await fillInput(page, 'Diameter Ø', '25');
		await fillInput(page, 'Length', '80');
		await page.waitForTimeout(800);

		const preview = fieldByLabel(page, 'Shape Preview');
		await testInfo.attach('geometry-preview', {
			body: await page.screenshot({ fullPage: true }),
			contentType: 'image/png',
		});

		// The custom interface should have drawn an <svg>.
		await expect(preview.locator('svg')).toBeVisible();
		// And the dimension summary strip should echo the entered values.
		await expect(preview).toContainText('25');
		await expect(preview).toContainText('80');
	});

	test('round bar draws a bar along its length with Ø and length dimensions', async ({ page }, testInfo) => {
		await gotoCreateForm(page, 'physical_samples');
		await selectDropdown(page, 'Geometry', 'Round bar');
		await fillInput(page, 'Diameter Ø', '20');
		await fillInput(page, 'Length', '100');
		await page.waitForTimeout(800);

		const preview = fieldByLabel(page, 'Shape Preview');
		await testInfo.attach('geometry-preview-round-bar', {
			body: await page.screenshot({ fullPage: true }),
			contentType: 'image/png',
		});

		const svg = preview.locator('svg').first();
		await expect(svg).toBeVisible();
		// The drawing labels its own dimensions: Ø on the end face, length along the bar.
		await expect(svg).toContainText('Ø20');
		await expect(svg).toContainText('100');
		// And the summary strip echoes them.
		await expect(preview).toContainText('20');
		await expect(preview).toContainText('100');
	});

	test('bar (rectangular) and round bar draw differently', async ({ page }) => {
		await gotoCreateForm(page, 'physical_samples');
		const preview = fieldByLabel(page, 'Shape Preview');

		await selectDropdown(page, 'Geometry', 'Bar', { exact: true });
		await fillInput(page, 'Width', '15');
		await fillInput(page, 'Thickness', '25');
		await fillInput(page, 'Length', '100');
		await page.waitForTimeout(800);
		const barSvg = preview.locator('svg').first();
		await expect(barSvg).toBeVisible();
		// A rectangular bar is made of flat faces (polygons) and has no Ø dimension.
		await expect(barSvg.locator('polygon').first()).toBeVisible();
		await expect(barSvg).not.toContainText('Ø');

		await selectDropdown(page, 'Geometry', 'Round bar');
		await fillInput(page, 'Diameter Ø', '20');
		await page.waitForTimeout(800);
		const roundSvg = preview.locator('svg').first();
		// A round bar is a curved silhouette (paths), no flat box faces, and carries a Ø dimension.
		await expect(roundSvg).toContainText('Ø20');
		await expect(roundSvg.locator('polygon')).toHaveCount(0);
	});
});
