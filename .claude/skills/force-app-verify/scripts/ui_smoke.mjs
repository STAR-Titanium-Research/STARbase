// Drive the real force-app web UI against the sim backend, with no Directus: seed a fake
// session in localStorage (the router guard only checks for a token), stub every Directus call
// with empty data, force the sim source, then open a route and screenshot it. With --record it
// also presses Start on the Record page and lets the sim run finish.
//
// Usage (from the repo root, with `npm run dev -w force-app-web` on :5180 and backend.sh up):
//   node .claude/skills/force-app-verify/scripts/ui_smoke.mjs [--route /record] [--record]
//        [--out /tmp/fa/shots] [--web http://localhost:5180] [--recorder http://localhost:8200]
//
// What this can't show: anything whose data comes from Directus (Plot page contents, sample
// pickers, uploads). Those need a real Directus; say so rather than reporting them verified.
import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';

const arg = (name, dflt) => {
	const i = process.argv.indexOf(`--${name}`);
	return i > -1 ? process.argv[i + 1] : dflt;
};
const route = arg('route', '/record');
const web = arg('web', 'http://localhost:5180');
const recorder = arg('recorder', 'http://localhost:8200');
const out = arg('out', '/tmp/fa/shots');
const record = process.argv.includes('--record');
const FAKE_DIRECTUS = 'http://directus.invalid';
mkdirSync(out, { recursive: true });

// Cloud sessions ship one Chromium at /opt/pw-browsers/chromium (the binary itself) that may not
// match this Playwright version's expected build; fall back to it when the default launch fails.
const exe = ['/opt/pw-browsers/chromium', '/opt/pw-browsers/chromium/chrome-linux/chrome'].find(existsSync);
let browser;
try {
	browser = await chromium.launch();
} catch {
	browser = await chromium.launch({ executablePath: exe });
}
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

const problems = [];
page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

await page.addInitScript(
	({ directus, recorder }) => {
		const user = { id: '00000000-0000-0000-0000-000000000001', email: 'skill@d1.test', first_name: 'Skill', last_name: 'Check' };
		localStorage.setItem('force-app.auth', JSON.stringify({ accessToken: 'fake', refreshToken: 'fake', expiresAt: Date.now() + 864e5, user, offline: false }));
		localStorage.setItem('force-app.config.override', JSON.stringify({ directusUrl: directus, recorderUrl: recorder }));
		localStorage.setItem('force-app.source', 'sim');
	},
	{ directus: FAKE_DIRECTUS, recorder },
);
await page.route(`${FAKE_DIRECTUS}/**`, (r) => {
	const u = new URL(r.request().url());
	const body = u.pathname.startsWith('/users/me')
		? { data: { id: '00000000-0000-0000-0000-000000000001', email: 'skill@d1.test', first_name: 'Skill', last_name: 'Check', role: null } }
		: { data: [] };
	return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
});

await page.goto(`${web}${route}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
const slug = route.replace(/\W+/g, '_').replace(/^_|_$/g, '') || 'root';
await page.screenshot({ path: `${out}/${slug}.png` });
console.log(`url: ${page.url()}\nshot: ${out}/${slug}.png`);
if (page.url().includes('/login')) problems.push('redirected to /login: the fake session was rejected');

if (record) {
	// Icons are Material Symbols ligatures, so their text is part of the accessible name:
	// this button's name is "fiber_manual_record Start" (and "flagCut start" must not match).
	const start = page.getByRole('button', { name: /^(fiber_manual_record\s+)?start$/i }).first();
	if (!(await start.isVisible().catch(() => false))) {
		problems.push('no visible Start button on the page');
	} else {
		const before = (await (await fetch(`${recorder}/record/status`)).json()).id ?? null;
		await start.click();
		// No Sample is picked in the smoke run: the pre-flight asks "Start anyway" first (R4).
		const anyway = page.getByTestId('start-anyway');
		if (await anyway.isVisible({ timeout: 2000 }).catch(() => false)) {
			console.log('pre-flight: no Sample -> "Start anyway"');
			await anyway.click();
		}
		// The safety gate (fbda167) asks to test alarms before the first run of a session.
		const skip = page.getByRole('button', { name: /start without testing/i });
		if (await skip.isVisible({ timeout: 2000 }).catch(() => false)) {
			console.log('alarm-test prompt shown -> "Start without testing"');
			await skip.click();
		}
		await page.waitForTimeout(3000);
		await page.screenshot({ path: `${out}/${slug}_recording.png` });
		console.log(`shot: ${out}/${slug}_recording.png`);
		const status = await (await fetch(`${recorder}/record/status`)).json();
		console.log(`backend: state=${status.state} id=${status.id ?? '-'} samples=${status.n_total ?? 0}`);
		if (!status.id || status.id === before) problems.push('Start did not create a new backend session');
		else if (!(status.n_total > 0)) problems.push('new session has no samples yet');
	}
}

await browser.close();
if (problems.length) {
	console.log(`\n${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
	process.exit(1);
}
console.log('\nno console errors');
