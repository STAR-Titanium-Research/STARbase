import { test, expect } from '../fixtures';
import { gotoCreateForm, selectM2O, selectDropdown, fieldByLabel } from '../helpers';

/**
 * The Machine picker (custom d1-machine-picker interface) filters to equipment
 * whose `capabilities` include the operation's inferred process category / the
 * test's category. It reads the sibling field from the live form, so it works in
 * create mode (where Directus $CURRENT_ITEM filters do not). It is tiered: when
 * capable machines span more than one facility a facility filter appears first,
 * then the machine list — so we target the machine tier as the LAST select.
 */
test('machining operation → machine list shows only machining-capable equipment', async ({ page }, testInfo) => {
	await gotoCreateForm(page, 'manufacturing_operations');
	await selectM2O(page, 'Method', 'Machining (General)');
	await page.waitForTimeout(1500); // method → process_category → picker query

	const machine = fieldByLabel(page, 'Machine');
	// the form is taller now (Field groups): bring the field into view first, the picker's v-select has no box of its own
	await machine.scrollIntoViewIfNeeded();
	await machine.locator('.v-select:not(.facility-select)').first().click();
	await page.waitForTimeout(800);

	const opts = (await page.locator('.v-list-item').allTextContents()).join(' | ');
	await testInfo.attach('machine-options', {
		body: await page.screenshot({ fullPage: true }),
		contentType: 'image/png',
	});
	console.log('MACHINE_OPTS=' + opts);

	expect(opts).toMatch(/NLX-2500|C-62|DMU 60|NTX 2500/);
	expect(opts).not.toMatch(/FCT HP D 25/); // sintering-only — excluded
});

test('SEM test → machine list shows the imaging (nde) instruments, not the lathe', async ({ page }) => {
	await gotoCreateForm(page, 'test_sessions');
	await selectDropdown(page, 'Test Type', 'SEM');
	await page.waitForTimeout(1500); // test_type → test_category → picker query

	const machine = fieldByLabel(page, 'Machine');
	// nde machines span several facilities → facility tier appears first; the
	// machine tier is the last select.
	// the form is taller now (Field groups): bring the field into view first, the picker's v-select has no box of its own
	await machine.scrollIntoViewIfNeeded();
	await machine.locator('.v-select:not(.facility-select)').first().click();
	await page.waitForTimeout(800);

	const opts = (await page.locator('.v-list-item').allTextContents()).join(' | ');
	console.log('SEM_MACHINE_OPTS=' + opts);
	// Real microscopes are now offered…
	expect(opts).toMatch(/Zeiss EVO10|FEI Inspect|FEI Nova|JEOL|Clemex/);
	// …and the CNC lathe is no longer wrongly offered for imaging (the NLX-only bug).
	expect(opts).not.toMatch(/NLX-2500/);
	expect(opts).not.toMatch(/FCT HP D 25/);
});
