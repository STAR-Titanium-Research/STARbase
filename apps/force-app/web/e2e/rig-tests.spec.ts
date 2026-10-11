import { test, expect, type Page } from '@playwright/test';

// Rig-test requests end to end through the REAL web UI with BOTH backends stubbed in the browser
// (page.route), so unlike recording-options.spec.ts it needs neither Directus nor a recorder: only
// the vite dev server on :5180 (see playwright.config.ts). It drives the contract in
// docs/superpowers/plans/2026-10-11-rig-test-requests-phase1.md: pending -> Run now -> question ->
// answer -> done, plus minimise (Escape) and Cancel.
const DIRECTUS = 'http://directus.invalid';
const RECORDER = 'http://recorder.invalid';

interface Stub { run: any; answered: boolean; pending: any[]; cancelled: boolean }

async function setup(page: Page): Promise<Stub> {
	const s: Stub = {
		cancelled: false, answered: false, run: null,
		pending: [{
			number: 231, title: 'R4 pre-flight chips', url: 'https://github.com/x/y/issues/231', requested_by: 'dpremoli',
			created_at: new Date().toISOString(), items: [{ id: 'R4', title: 'Pre-flight chips', steps: [] }],
			estimate_s: { full: 240, automated: 0 }, needs_operator_steps: 2,
		}],
	};
	await page.addInitScript(({ d, r }) => {
		const user = { id: '00000000-0000-0000-0000-000000000001', email: 'e2e@d1.test', first_name: 'E2E', last_name: 'Check' };
		localStorage.setItem('force-app.auth', JSON.stringify({ accessToken: 'fake', refreshToken: 'fake', expiresAt: Date.now() + 864e5, user, offline: false }));
		localStorage.setItem('force-app.config.override', JSON.stringify({ directusUrl: d, recorderUrl: r }));
	}, { d: DIRECTUS, r: RECORDER });
	await page.route(`${DIRECTUS}/**`, (r) => r.fulfill({ json: { data: [] } }));
	const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
	await page.route(`${RECORDER}/**`, async (route) => {
		const req = route.request();
		const path = new URL(req.url()).pathname;
		const json = (body: unknown, status = 200) => route.fulfill({ status, json: body, headers: cors });
		if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
		if (path === '/record/status') return json({ state: 'idle' });
		if (path === '/rig-tests/eligibility') return json({ eligible: true, rig_id: 'rig-e2e', relay: 'ok' });
		if (path === '/rig-tests/pending') return json({ requests: s.pending });
		if (path === '/rig-tests/history') return json({ runs: [] });
		if (path === '/rig-tests/run') {
			if (!s.run) return json({ state: 'idle' });
			const steps = [
				{ index: 0, item_id: 'R4', kind: 'ask', text: 'Pull the cable. Does the chip warn?', status: s.answered ? 'pass' : 'active' },
				{ index: 1, item_id: 'R4', kind: 'ask', text: 'Plug it back in.', status: s.answered ? 'pass' : 'pending' },
			];
			const state = s.cancelled ? 'cancelled' : s.answered ? 'done' : 'running';
			return json({
				number: 231, state, started_at: '', deadline_at: '', elapsed_s: 30, estimate_s: 240, steps, current: 0,
				question: state === 'running' ? { step: 0, text: steps[0].text, options: ['Yes', 'No'], expires_at: new Date(Date.now() + 240_000).toISOString() } : undefined,
			});
		}
		if (/^\/rig-tests\/\d+\/accept$/.test(path)) { s.pending = []; s.run = true; return json({ ok: true }); }
		if (path === '/rig-tests/run/answer') { s.answered = true; return json({ ok: true }); }
		if (path === '/rig-tests/run/cancel') { s.cancelled = true; return json({ ok: true }); }
		return json({ detail: 'Not Found' }, 404);
	});
	return s;
}

test('prompt -> Run now -> question -> answer -> finished summary', async ({ page }) => {
	await setup(page);
	await page.goto('/settings?tab=general');
	const prompt = page.getByTestId('rig-test-prompt');
	await expect(prompt).toContainText('#231 R4 pre-flight chips');
	await expect(prompt).toContainText('about 4 min, 2 steps need you');
	await prompt.getByRole('button', { name: /Run now/ }).click();

	const question = page.getByTestId('rig-test-question');
	await expect(question).toContainText('Does the chip warn?');
	await question.getByRole('button', { name: 'Yes' }).click();
	await expect(page.getByTestId('rig-test-modal')).toContainText('Rig test finished: every step passed');
	await page.getByRole('button', { name: 'Close' }).click();
	await expect(page.getByTestId('rig-test-modal')).toHaveCount(0);
});

test('Escape minimises to the bar (the run keeps going); Cancel asks first', async ({ page }) => {
	const s = await setup(page);
	await page.goto('/settings?tab=general');
	await page.getByTestId('rig-test-prompt').getByRole('button', { name: /Run now/ }).click();
	await expect(page.getByTestId('rig-test-modal')).toBeVisible();

	await page.keyboard.press('Escape');
	const bar = page.getByTestId('rig-test-bar');
	await expect(bar).toContainText('Rig test #231, step 1/2');
	expect(s.cancelled).toBe(false);

	await bar.getByRole('button', { name: 'Cancel' }).click();
	await page.getByTestId('confirm-cancel').click(); // "Keep running"
	expect(s.cancelled).toBe(false);
	await bar.getByRole('button', { name: 'Cancel' }).click();
	await page.getByTestId('confirm-accept').click();
	await expect(page.getByTestId('rig-test-modal')).toContainText('Rig test cancelled');
	expect(s.cancelled).toBe(true);
});
