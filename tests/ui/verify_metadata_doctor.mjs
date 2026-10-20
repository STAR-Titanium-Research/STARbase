// End-to-end check for the Metadata Doctor (packages/force-plotting/src/metadataDoctor.ts).
// Follows the tests/ui/verify_*.mjs convention (env-driven, @playwright/test chromium, generous
// settle time).
//
// The point of this test is the RECONCILIATION: diagnose() is unit-tested in isolation, so what
// needs proving here is that the UI feeds it the right rows — i.e. that the list query was widened
// with every column the checks read. If a field is missing from that `fields` array the check
// silently turns off rather than erroring, and only a count like this catches it.
//
// Expected counts come from SQL measured against the live archive (see the plan's Context table).
// Must run as an ADMIN: the list query applies an ownership filter for non-admins, which
// legitimately shrinks every count.
//
// Run:
//   FORCE_APP_BASE_URL=http://localhost/app \
//   FORCE_APP_EMAIL=… FORCE_APP_PASSWORD=… node tests/ui/verify_metadata_doctor.mjs
import { chromium } from '@playwright/test';

// Trailing slash matters: Caddy routes the SPA with `handle_path /app/*`, so a bare
// http://localhost/app does NOT match and falls through to Directus, which answers
// {"code":"ROUTE_NOT_FOUND"} — a 200-looking JSON page with no login form. Normalise it here so a
// missing slash can't masquerade as "the app failed to render".
const BASE = (process.env.FORCE_APP_BASE_URL || 'http://localhost/app').replace(/\/?$/, '/');
const EMAIL = process.env.FORCE_APP_EMAIL || process.env.DIRECTUS_ADMIN_EMAIL || '';
const PASS = process.env.FORCE_APP_PASSWORD || process.env.DIRECTUS_ADMIN_PASSWORD || '';

// Group title -> expected operation count, as measured in SQL over the 181 `status='done'` rows.
const EXPECTED = {
	'Crop covers little of the recording': 79,
	'Not linked to a sample': 16,
};
// Conflicts and backfills are split across four per-field checks; assert their totals instead.
const EXPECTED_CONFLICT_OPS = 37;
const EXPECTED_MISSING_OPS = 47;

if (!EMAIL || !PASS) {
	console.log('FORCE_APP_EMAIL/PASSWORD not set — cannot run (this test needs an admin session).');
	process.exit(1);
}

(async () => {
	const b = await chromium.launch();
	const c = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1800, height: 1100 } });
	const p = await c.newPage();
	const errors = [];
	// The TDZ class of bug in this file surfaces as a console.warn, not an error (Vue's app error
	// handler catches setup errors and re-logs them) — so watch both levels.
	p.on('console', (m) => {
		const t = m.text();
		if (/ReferenceError|before initialization|Cannot read/.test(t)) errors.push(t);
	});
	let ok = true;
	const check = (label, actual, expected) => {
		const pass = actual === expected;
		console.log(`${pass ? 'ok  ' : 'FAIL'}  ${label}: ${actual}${pass ? '' : ` (expected ${expected})`}`);
		if (!pass) ok = false;
	};

	await p.goto(BASE, { waitUntil: 'networkidle' });
	// The production bundle is ~900 kB, so the SPA needs longer to mount here than against a dev
	// server — wait for the field itself rather than a fixed delay.
	await p.waitForSelector('input[type="email"]', { timeout: 30000 });
	await p.fill('input[type="email"]', EMAIL);
	await p.fill('input[type="password"]', PASS);
	await p.click('button[type="submit"]');
	await p.waitForTimeout(2500);
	// Navigate straight to the route rather than clicking the sidebar: the nav item is an <a> that
	// can be laid out off-screen depending on viewport/collapse state, and this test is about the
	// Doctor, not the shell chrome.
	await p.goto(`${BASE}plot`, { waitUntil: 'networkidle' });
	await p.waitForSelector('section[aria-label="Operations"]', { timeout: 30000 });
	await p.waitForTimeout(6000);

	// ---- The "issues only" filter chip carries the flagged-operation count.
	const filter = p.locator('label.issues');
	if (await filter.count() === 0) {
		console.log('FAIL  the "Metadata issues only" filter did not render');
		await p.screenshot({ path: 'tests/ui/metadata_doctor_fail.png', fullPage: true });
		await b.close();
		process.exit(1);
	}
	const flagged = parseInt((await filter.locator('.fp-chip').innerText()).trim(), 10);
	console.log(`operations with at least one finding: ${flagged}`);
	if (!(flagged > 0)) { console.log('FAIL  expected a non-zero flagged count'); ok = false; }

	// ---- Open the Doctor panel and switch it to the whole-archive view.
	await p.locator('.pt-add > button').click();
	await p.waitForTimeout(300);
	await p.locator('.pt-menu button', { hasText: 'Metadata doctor' }).click();
	await p.waitForTimeout(1200);
	await p.locator('[aria-label="Scope"] button', { hasText: 'All' }).click();
	await p.waitForTimeout(1200);

	const groups = p.locator('.doc-group');
	const n = await groups.count();
	console.log(`finding groups: ${n}`);
	const counts = {};
	for (let i = 0; i < n; i++) {
		const g = groups.nth(i);
		const title = (await g.locator('.doc-title').innerText()).trim();
		counts[title] = (await g.locator('.doc-oprow').count());
	}
	console.log('per-group counts:', counts);

	for (const [title, expected] of Object.entries(EXPECTED)) check(title, counts[title] ?? 0, expected);

	// Conflicts/backfills are per-field groups; count the DISTINCT analysis rows across each family
	// the same way the SQL did (a row with both a feed and a DoC conflict counts once).
	// Dedupe on data-row-id, NOT on the displayed pass_code: an operation can have more than one
	// .mat, so two distinct rows can share a name (e.g. 122-AA-MM-2025-6-5-F11 has two) and keying
	// on the label silently under-counts.
	const familyOps = async (pattern) => {
		const ids = new Set();
		for (let i = 0; i < n; i++) {
			const g = groups.nth(i);
			const title = (await g.locator('.doc-title').innerText()).trim();
			if (!pattern.test(title)) continue;
			for (const id of await g.locator('.doc-oprow').evaluateAll((els) => els.map((e) => e.dataset.rowId))) ids.add(id);
		}
		return ids.size;
	};
	check('operations with >=1 conflict', await familyOps(/conflict/i), EXPECTED_CONFLICT_OPS);
	check('operations with >=1 backfill', await familyOps(/missing in D1/i), EXPECTED_MISSING_OPS);

	// ---- The two noisy checks must be OFF until asked for.
	const beforeOpt = await groups.count();
	const nameGroup = await p.locator('.doc-group', { hasText: 'Name does not match its fields' }).count();
	check('"name vs fields" is off by default', nameGroup, 0);
	await p.locator('.doc-opt', { hasText: 'Name vs fields' }).locator('input').check();
	await p.waitForTimeout(1200);
	const afterOpt = await p.locator('.doc-group').count();
	console.log(`groups before/after enabling the optional name check: ${beforeOpt} -> ${afterOpt}`);
	if (!(afterOpt > beforeOpt)) { console.log('FAIL  enabling the optional check added no group'); ok = false; }

	await p.screenshot({ path: 'tests/ui/metadata_doctor_all.png', fullPage: true });

	// ---- Per-operation view: pick an op from a conflict group and confirm its findings render.
	await p.locator('.doc-group').filter({ hasText: 'conflict' }).first().locator('.doc-oprow').first().click();
	await p.waitForTimeout(4000);
	await p.locator('[aria-label="Scope"] button', { hasText: 'This op' }).click();
	await p.waitForTimeout(800);
	const findings = await p.locator('.doc-find').count();
	console.log(`findings on the selected operation: ${findings}`);
	if (!(findings > 0)) { console.log('FAIL  selected operation showed no findings'); ok = false; }
	const adoptBtn = await p.locator('.doc-btn', { hasText: 'Use .mat value in D1' }).count();
	console.log(`adopt buttons offered: ${adoptBtn}`);
	await p.screenshot({ path: 'tests/ui/metadata_doctor_op.png', fullPage: true });

	// ---- Dismiss round-trip. This is the one write path no unit test can cover: it exercises the
	// PATCH, the Lab Member update permission, and that the value survives a reload. The test
	// RESTORES the dismissal afterwards so the archive is left exactly as it was found.
	const firstTitle = (await p.locator('.doc-find .doc-title').first().innerText()).trim();
	const opUrl = p.url();
	await p.locator('.doc-find').first().locator('.doc-btn', { hasText: 'Not a problem' }).click();
	await p.waitForTimeout(2500);
	const afterDismiss = await p.locator('.doc-find').count();
	check(`dismissing "${firstTitle}" removed it from the active list`, afterDismiss, findings - 1);
	const inDismissed = await p.locator('.doc-dis-row', { hasText: firstTitle }).count();
	check('it moved to the Dismissed section', inDismissed, 1);

	await p.goto(opUrl, { waitUntil: 'networkidle' });
	await p.waitForSelector('section[aria-label="Operations"]', { timeout: 30000 });
	await p.waitForTimeout(6000);
	const persisted = await p.locator('.doc-dis-row', { hasText: firstTitle }).count();
	check('the dismissal survived a reload', persisted, 1);

	// Restore, so this test leaves no trace in the database.
	await p.locator('.doc-dis-row', { hasText: firstTitle }).locator('.doc-btn', { hasText: 'Restore' }).click();
	await p.waitForTimeout(2500);
	const restored = await p.locator('.doc-find').count();
	check('restoring brought the finding back', restored, findings);

	if (errors.length) { console.log('FAIL  console errors:', errors.slice(0, 3)); ok = false; }

	await b.close();
	console.log(ok ? 'PASS' : 'FAIL');
	process.exit(ok ? 0 : 1);
})();
