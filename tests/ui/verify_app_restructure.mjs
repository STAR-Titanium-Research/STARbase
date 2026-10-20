// App IA restructure: left-sidebar shell (Record/Plot/Lab Amp/Settings), Settings sub-tabs, the
// Lab Amp page, Metadata advanced (Directus) fields, and Settings>Alarms driving the Record overlay.
//   FORCE_APP_EMAIL=… FORCE_APP_PASSWORD=… node tests/ui/verify_app_restructure.mjs
import { chromium } from '@playwright/test';

const BASE = process.env.FORCE_APP_BASE_URL || 'http://localhost:5180';
const EMAIL = process.env.FORCE_APP_EMAIL || 'admin@example.com';
const PASS = process.env.FORCE_APP_PASSWORD || '';
const nav = (p, label) => p.locator('.sidebar .navitem', { hasText: label }).click();

(async () => {
	const b = await chromium.launch();
	const c = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1720, height: 1040 } });
	const p = await c.newPage();
	const errs = [];
	p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
	let ok = true;

	await p.goto(BASE, { waitUntil: 'networkidle' });
	await p.fill('input[type="email"]', EMAIL);
	await p.fill('input[type="password"]', PASS);
	await p.click('button[type="submit"]');
	await p.waitForTimeout(2500);

	// lands on /record with the sidebar
	const onRecord = /\/record/.test(p.url());
	const navItems = await p.locator('.sidebar .navitem').count();
	const panels = await p.locator('.panel-frame').count();
	const noAlarmPanel = await p.locator('.panel-frame', { hasText: 'Safety Alarms' }).count();
	console.log('landed /record:', onRecord, '| nav items:', navItems, '| record panels:', panels, '| alarms panel moved out:', noAlarmPanel === 0);
	ok = ok && onRecord && navItems === 4 && panels === 5 && noAlarmPanel === 0;

	// Settings > Alarms: set a low force threshold
	await nav(p, 'Settings'); await p.waitForTimeout(600);
	const onSettings = /\/settings/.test(p.url());
	await p.locator('.subtab', { hasText: 'Safety Alarms' }).click();
	await p.locator('.alarms .thr input').first().fill('50');
	await p.locator('.alarms h2').click(); // blur to persist
	console.log('settings reached:', onSettings);
	ok = ok && onSettings;

	// Lab Amp page
	await nav(p, 'Lab Amp'); await p.waitForTimeout(1200);
	const onLabamp = /\/labamp/.test(p.url());
	const connected = await p.locator('.labamp-page .conn.ok').count();
	const sensorRows = await p.locator('.labamp-page table tbody tr').count();
	const refItems = await p.locator('.labamp-page .ref').count();
	console.log('labamp:', onLabamp, '| connected:', connected === 1, '| sensor rows:', sensorRows, '| reference items:', refItems);
	ok = ok && onLabamp && connected === 1 && sensorRows === 8 && refItems >= 4;
	await p.screenshot({ path: 'tests/ui/restructure_labamp.png', fullPage: true });

	// Plot page (Directus dashboard renders)
	await nav(p, 'Plot'); await p.waitForTimeout(3500);
	const plotNodes = await p.locator('.fp-lists .fp-card, .fp-empty, [data-panel-id] .charts').count();
	console.log('plot page nodes:', plotNodes);
	ok = ok && plotNodes > 0;

	// Record: metadata advanced fields + alarm from settings threshold
	await nav(p, 'Record'); await p.waitForTimeout(800);
	await p.locator('.disclose', { hasText: 'Machining details' }).click();
	const advInputs = await p.locator('.advanced input').count();
	console.log('metadata advanced inputs:', advInputs);
	ok = ok && advInputs >= 6;

	await p.locator('label', { hasText: 'Duration' }).locator('input').fill('4');
	await p.locator('label', { hasText: 'Sample rate' }).locator('input').fill('6000');
	await p.locator('.btn.start').click();
	await p.locator('.alarm-overlay').waitFor({ timeout: 10000 });
	const overlay = await p.locator('.alarm-overlay').count();
	console.log('alarm overlay from settings threshold:', overlay === 1);
	await p.screenshot({ path: 'tests/ui/restructure_record_alarm.png', fullPage: true });
	await p.locator('.ao-ack').click();
	ok = ok && overlay === 1;

	if (errs.length) console.log('page console errors:', JSON.stringify(errs.slice(0, 10), null, 2));
	await b.close();
	console.log(ok ? 'PASS' : 'FAIL');
	process.exit(ok ? 0 : 1);
})();
