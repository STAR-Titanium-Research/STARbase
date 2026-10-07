// Smoke test for the Plot dashboard's FRM map <-> Signals linking (docs/superpowers/specs/
// 2026-10-04-frm-signal-linking-design.md), driven in headless Chromium with no Directus.
//
// What is real: the sim backend records a short cut, and that capture's live_cache.bin is served as
// the stubbed /assets/<id> response, so the Lite cloud is built from real D1LC data. What is
// stubbed: every Directus call (one sample, one operation, one machining_force_analysis row whose
// `series` envelope is bucketed here from the same cache, like buildSeriesEnvelope does).
//
// Usage (repo root; backend.sh start and `npm run dev -w force-app-web` on :5180 must be up):
//   node .claude/skills/force-app-verify/scripts/plot_link_smoke.mjs [--capture <id>] [--out /tmp/fa/shots]
//        [--web http://localhost:5180] [--recorder http://localhost:8200]
// Without --capture it records a 4 s cut with sim_record.py. Exit 1 if any assertion fails.
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (name, dflt) => {
	const i = process.argv.indexOf(`--${name}`);
	return i > -1 ? process.argv[i + 1] : dflt;
};
const web = arg('web', 'http://localhost:5180');
const recorder = arg('recorder', 'http://localhost:8200');
const out = arg('out', '/tmp/fa/shots');
const here = dirname(fileURLToPath(import.meta.url));
const FAKE_DIRECTUS = 'http://directus.invalid';
const ANALYSIS_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const CACHE_FILE = 'bbbbbbbb-0000-4000-8000-000000000002';
const OP_ID = 'OP-LINK-1';
mkdirSync(out, { recursive: true });

// ---- 1. a real live cache ------------------------------------------------------------------
let capture = arg('capture');
if (!capture) {
	console.log('recording a 4 s sim cut ...');
	const txt = execFileSync('python3', [join(here, 'sim_record.py'), '--duration', '4'], { encoding: 'utf8' });
	capture = /capture id: (\S+)/.exec(txt)?.[1];
	if (!capture) { console.error(txt); process.exit(2); }
}
const lcRes = await fetch(`${recorder}/captures/${capture}/live_cache.bin`);
if (!lcRes.ok) { console.error(`live_cache.bin for ${capture}: HTTP ${lcRes.status}`); process.exit(2); }
const lcBuf = Buffer.from(await lcRes.arrayBuffer());
// D1LC: u32 magic, version, N, f32 Fs, feed, diam, csSec, ceSec, then f32[N] t, Fx, Fy, Fz, rpm, revs.
const N = lcBuf.readUInt32LE(8);
const hdr = { Fs: lcBuf.readFloatLE(12), feed: lcBuf.readFloatLE(16), diam: lcBuf.readFloatLE(20), cs: lcBuf.readFloatLE(24), ce: lcBuf.readFloatLE(28) };
const arr = (k) => new Float32Array(lcBuf.buffer, lcBuf.byteOffset + 32 + k * N * 4, N);
const [T, FX, FY, FZ, RPM] = [0, 1, 2, 3, 4].map(arr);
function envelope(src, buckets = 2000) {
	const stride = Math.max(1, Math.ceil(N / buckets)), nb = Math.ceil(N / stride);
	const o = { t: new Array(nb), min: new Array(nb), max: new Array(nb) };
	for (let b = 0, i0 = 0; i0 < N; b++, i0 += stride) {
		let lo = Infinity, hi = -Infinity;
		for (let i = i0; i < Math.min(N, i0 + stride); i++) { if (src[i] < lo) lo = src[i]; if (src[i] > hi) hi = src[i]; }
		o.t[b] = T[i0]; o.min[b] = lo; o.max[b] = hi;
	}
	return o;
}
const series = { Fx: envelope(FX), Fy: envelope(FY), Fz: envelope(FZ), RPM: envelope(RPM) };
const analysis = {
	id: ANALYSIS_ID, status: 'done', live_cache_file: CACHE_FILE, octree_status: 'none', created_at: '2026-10-04T10:00:00Z',
	peak_fx: 1, peak_fy: 1, peak_fz: 1, n_raw: N, sample_rate: hdr.Fs,
	cut_start_idx: Math.round(hdr.cs * hdr.Fs), cut_end_idx: Math.round(hdr.ce * hdr.Fs),
	crop_start_idx_override: null, crop_end_idx_override: null,
	feed: hdr.feed, outer_diameter: hdr.diam, cut_diameter: hdr.diam, inner_diameter: 0, pulses_per_rev: 1,
	series, filter_chain: null, filter_baked: false, doctor_dismissed: false,
	operation_id: {
		operation_id: OP_ID, pass_code: 'LINK-P1', operation_date: '2026-10-04', operation_sequence: 1,
		sample_id: { sample_id: 'S-LINK-1', sample_code: 'LINK-1', nickname: 'Link test', material_id: { common_name: 'Test alloy' }, owner_person_id: { full_name: 'Skill Check' } },
	},
};

// ---- browser + stubs ------------------------------------------------------------------------
const exe = ['/opt/pw-browsers/chromium', '/opt/pw-browsers/chromium/chrome-linux/chrome'].find(existsSync);
let browser;
try { browser = await chromium.launch(); } catch { browser = await chromium.launch({ executablePath: exe }); }
const page = await browser.newPage({ viewport: { width: 1700, height: 1000 } });
const problems = [], failures = [];
page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

await page.addInitScript(({ directus, recorder }) => {
	const user = { id: '00000000-0000-0000-0000-000000000001', email: 'skill@d1.test', first_name: 'Skill', last_name: 'Check' };
	localStorage.setItem('force-app.auth', JSON.stringify({ accessToken: 'fake', refreshToken: 'fake', expiresAt: Date.now() + 864e5, user, offline: false }));
	localStorage.setItem('force-app.config.override', JSON.stringify({ directusUrl: directus, recorderUrl: recorder }));
	localStorage.setItem('force-app.source', 'sim');
}, { directus: FAKE_DIRECTUS, recorder });

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
const unstubbed = new Set();
if (process.env.PLS_DEBUG) page.on('request', (q) => q.url().startsWith(FAKE_DIRECTUS) && console.log('  req', q.method(), q.url().slice(0, 160)));
await page.route(`${FAKE_DIRECTUS}/**`, (r) => {
	const req = r.request();
	if (req.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
	const p = new URL(req.url()).pathname;
	const json = (data) => r.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ data }) });
	if (p === `/assets/${CACHE_FILE}`) return r.fulfill({ status: 200, contentType: 'application/octet-stream', headers: cors, body: lcBuf });
	if (p.startsWith('/users/me')) return json({ ...{ id: '00000000-0000-0000-0000-000000000001', email: 'skill@d1.test', first_name: 'Skill', last_name: 'Check', role: null } });
	// A non-admin account first resolves its people row, else the dashboard lists nothing.
	if (p === '/items/people') return json([{ person_id: 1, full_name: 'Skill Check', is_operator: true }]);
	if (p === '/items/physical_samples') return json([{ sample_id: 'S-LINK-1', sample_code: 'LINK-1', nickname: 'Link test' }]);
	if (p === '/items/machining_force_analysis') return json([analysis]);
	if (p === `/items/machining_force_analysis/${ANALYSIS_ID}`) return json(analysis);
	unstubbed.add(`${req.method()} ${p}`);
	return json(p.startsWith('/items/') && p.split('/').length > 3 ? {} : []);
});

// ---- assertion helpers ----------------------------------------------------------------------
let step = 0;
const shot = async (name) => { const f = `${out}/plot-link-${String(++step).padStart(2, '0')}-${name}.png`; await page.screenshot({ path: f }); console.log(`  shot ${f}`); };
const ok = (cond, what) => { console.log(`  ${cond ? 'PASS' : 'FAIL'} ${what}`); if (!cond) failures.push(what); };
const count = (sel) => page.locator(sel).count();
const settle = (ms = 400) => page.waitForTimeout(ms);
const menu = page.locator('[role=menu]');
const menuItem = (re) => menu.getByRole('menuitem', { name: re });
async function untilCount(sel, n, ms = 3000) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) { if ((await count(sel)) === n) return true; await page.waitForTimeout(100); }
	return (await count(sel)) === n;
}
async function menuClosed(ms = 1500) { return untilCount('[role=menu]', 0, ms); }

// ---- load the Plot route --------------------------------------------------------------------
console.log(`capture ${capture}: N=${N}, Fs=${hdr.Fs}, feed=${hdr.feed}, diam=${hdr.diam}, crop=${hdr.cs.toFixed(3)}..${hdr.ce.toFixed(3)} s`);
await page.goto(`${web}/plot?operation=${OP_ID}`, { waitUntil: 'networkidle' });
if (page.url().includes('/login')) { console.error('redirected to /login: the fake session was rejected'); process.exit(2); }
// The FRM map defaults to Lite on a fast connection; click Lite when it did not.
const canvasSel = '.fc-wrap canvas, canvas';
const bigCanvas = async () => {
	const all = page.locator('canvas');
	for (let i = 0, n = await all.count(); i < n; i++) {
		const b = await all.nth(i).boundingBox();
		if (b && b.width > 200 && b.height > 200) return { loc: all.nth(i), box: b };
	}
	return null;
};
let cv = null;
for (let i = 0; i < 60 && !cv; i++) { cv = await bigCanvas(); if (!cv) await page.waitForTimeout(250); }
if (!cv) {
	const lite = page.getByRole('button', { name: /^lite$/i }).first();
	if (await lite.isEnabled().catch(() => false)) await lite.click();
	for (let i = 0; i < 40 && !cv; i++) { cv = await bigCanvas(); if (!cv) await page.waitForTimeout(250); }
}
await settle(1500);
await shot('loaded');
if (!cv) {
	ok(false, 'FRM canvas drawn (no canvas > 200px found)');
	console.log(`unstubbed Directus calls: ${[...unstubbed].join(', ')}`);
	await browser.close(); process.exit(1);
}
ok(true, 'dashboard reached Lite mode with a canvas');
const chartSvg = page.locator('svg.chart-svg').first();
ok((await chartSvg.count()) > 0, 'Signals env charts rendered');

// A drawn point: screenshot the canvas, decode it in a scratch page and take pixels that differ
// from the background; pick one from the middle of the run so it is not on a toolbar/edge.
async function findDrawnPoints() {
	const png = await cv.loc.screenshot();
	const p2 = await browser.newPage();
	const pts = await p2.evaluate(async (b64) => {
		const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
		const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
		const g = c.getContext('2d'); g.drawImage(img, 0, 0);
		const d = g.getImageData(0, 0, c.width, c.height).data;
		const bg = [d[0], d[1], d[2]], res = [];
		for (let y = 40; y < c.height - 40; y++) for (let x = 40; x < c.width - 40; x++) {
			const i = (y * c.width + x) * 4;
			if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 120) res.push([x, y]);
		}
		return { res, w: c.width, h: c.height };
	}, png.toString('base64'));
	await p2.close();
	return pts;
}
const drawn = await findDrawnPoints();
ok(drawn.res.length > 50, `FRM canvas has drawn points (${drawn.res.length} non-background pixels)`);
// Candidate points spread along the drawn run, so a pick that misses by a pixel can be retried.
const pickAt = (k) => { const [x, y] = drawn.res[Math.floor(drawn.res.length * k)]; return { x: cv.box.x + x * (cv.box.width / drawn.w), y: cv.box.y + y * (cv.box.height / drawn.h) }; };

async function rightClick(x, y) { await page.mouse.move(x, y); await page.mouse.down({ button: 'right' }); await page.mouse.up({ button: 'right' }); await settle(300); }
// Right-click along the candidates until the menu's "Show position in time" is enabled.
async function openMapMenuOnPoint() {
	for (const k of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8, 0.1, 0.9]) {
		const p = pickAt(k);
		await rightClick(p.x, p.y);
		if ((await menu.count()) && (await menuItem(/show position in time/i).getAttribute('aria-disabled')) !== 'true') return p;
		if (await menu.count()) { await page.keyboard.press('Escape'); await menuClosed(); }
	}
	return null;
}

// ---- A. map -> time -------------------------------------------------------------------------
console.log('\nA. right-click a map point -> Show position in time');
const pA = await openMapMenuOnPoint();
await shot('map-menu');
ok(!!pA && (await menu.count()) === 1, 'right-click on a drawn point opens a [role=menu]');
ok((await menuItem(/show position in time/i).count()) === 1, 'menu offers "Show position in time"');
if (pA) await menuItem(/show position in time/i).click();
await settle(600);
ok(await menuClosed(), 'menu closed after choosing an item');
ok((await count('.fc-mark-line')) >= 1, `pinned marker on the Signals charts (.fc-mark-line x${await count('.fc-mark-line')})`);
ok((await count('.fc-ring.pin')) === 1, 'pinned ring on the map (.fc-ring.pin)');
await shot('pinned-from-map');

// ---- B. Escape semantics (marker is pinned now) -----------------------------------------------
console.log('\nB. Escape: an open menu closes without losing the marker; Escape alone clears it');
await rightClick(pA?.x ?? cv.box.x + 100, pA?.y ?? cv.box.y + 100);
ok((await menu.count()) === 1, 're-opened the map menu while a marker is pinned');
await page.keyboard.press('Escape'); await settle(400);
ok(await menuClosed(), 'Escape closes the open menu');
ok((await count('.fc-mark-line')) >= 1 && (await count('.fc-ring.pin')) === 1, 'Escape that closed a menu KEEPS the marker (.fc-mark-line + .fc-ring.pin still present)');
await shot('menu-escape');
await page.mouse.move(5, 5);   // park outside the charts so no hover ring interferes
await page.keyboard.press('Escape'); await settle(400);
ok((await count('.fc-mark-line')) === 0 && (await count('.fc-ring.pin')) === 0, 'Escape with no menu open clears the marker and the ring');
await shot('escape-cleared');

// ---- C. chart hover -> ring on map ------------------------------------------------------------
console.log('\nC. hover a Signals chart -> hover ring on the map');
const cb = await chartSvg.boundingBox();
const cx = cb.x + cb.width * 0.55, cy = cb.y + cb.height * 0.5;
await page.mouse.move(cx - 30, cy); await page.mouse.move(cx, cy, { steps: 5 }); await settle(400);
ok((await count('.fc-ring.hover')) === 1, 'hovering a chart shows .fc-ring.hover on the map');
await shot('chart-hover');
await page.mouse.move(5, 5, { steps: 5 }); await settle(400);
ok((await count('.fc-ring.hover')) === 0, 'moving away removes .fc-ring.hover');

// ---- D. chart right-click -> Show position on map ---------------------------------------------
console.log('\nD. right-click a chart -> Show position on map');
await rightClick(cx, cy);
await shot('chart-menu');
ok((await menu.count()) === 1 && (await menuItem(/show position on map/i).count()) === 1, 'chart right-click opens a menu with "Show position on map"');
if (await menuItem(/show position on map/i).count()) await menuItem(/show position on map/i).click();
await settle(600);
ok((await count('.fc-ring.pin')) === 1, '.fc-ring.pin present after "Show position on map"');
ok((await count('.fc-mark-line')) >= 1, 'marker line present on the charts too');
await shot('pinned-from-chart');
await page.mouse.move(5, 5);
await page.keyboard.press('Escape'); await settle(300);

// ---- E. Set crop start here -------------------------------------------------------------------
console.log('\nE. map menu -> Set crop start here');
const saveBtn = page.getByRole('button', { name: /^save changes$/i });
// The stub's metadata can already make "Save changes" appear, so the crop edit is proven by the
// handle moving and by the dialog's "Crop window" row rather than by the button alone.
const dialogHas = async (re) => {
	if (!(await saveBtn.count())) return false;
	await saveBtn.first().click(); await settle(300);
	const txt = (await page.locator('.changes-dialog').innerText().catch(() => '')) || '';
	await page.getByRole('button', { name: /^cancel$/i }).click().catch(() => {}); await settle(200);
	return re.test(txt);
};
ok(!(await dialogHas(/crop window/i)), 'no pending crop edit beforehand ("Save changes" dialog has no Crop window row)');
const cropX = () => page.locator('.crop-hit').first().evaluate((el) => el.getAttribute('x') ?? el.getBoundingClientRect().x).catch(() => null);
const cropBefore = await cropX();
let setOk = false;
for (const k of [0.8, 0.7, 0.9, 0.6, 0.5]) {   // later points: an earlier-than-end start is always allowed
	const p = pickAt(k); await rightClick(p.x, p.y);
	const it = menuItem(/set crop start here/i);
	if ((await menu.count()) && (await it.count()) && (await it.getAttribute('aria-disabled')) !== 'true') { await it.click(); setOk = true; break; }
	if (await menu.count()) { await page.keyboard.press('Escape'); await menuClosed(); }
}
await settle(600);
ok(setOk, '"Set crop start here" available and clicked on a map point');
ok(await dialogHas(/crop window/i), 'crop edit is pending: "Save changes" dialog lists a Crop window row');
const cropAfter = await cropX();
ok(cropBefore !== cropAfter, `crop handle moved (${cropBefore} -> ${cropAfter})`);
await shot('crop-start-set');

// ---- F. right-drag does not open the menu -----------------------------------------------------
console.log('\nF. right-drag on the map does not open the menu');
await page.keyboard.press('Escape'); await settle(200);
const c0 = { x: cv.box.x + cv.box.width / 2, y: cv.box.y + cv.box.height / 2 };
// Native drag. Chromium on Linux/macOS fires `contextmenu` on the right-button PRESS (Windows, where
// the app ships, fires it on release), so here the press-time event has no movement to judge yet.
await page.mouse.move(c0.x, c0.y); await page.mouse.down({ button: 'right' });
await page.mouse.move(c0.x + 60, c0.y + 30, { steps: 8 }); await page.mouse.up({ button: 'right' }); await settle(500);
const nativeOpened = (await menu.count()) > 0;
console.log(`  INFO native right-drag (contextmenu on press on this OS): menu ${nativeOpened ? 'OPENED' : 'not opened'}`);
await shot('right-drag-native');
if (nativeOpened) { await page.keyboard.press('Escape'); await menuClosed(); }
// Windows ordering, synthesized: pointerdown(2) -> moves -> pointerup(2) -> contextmenu at the release point.
await cv.loc.evaluate((el, c) => {
	const base = { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'mouse', button: 2, view: window };
	const at = (x, y) => ({ clientX: x, clientY: y });
	el.dispatchEvent(new PointerEvent('pointerdown', { ...base, ...at(c.x, c.y), buttons: 2 }));
	for (let i = 1; i <= 6; i++) el.dispatchEvent(new PointerEvent('pointermove', { ...base, ...at(c.x + i * 10, c.y + i * 5), button: -1, buttons: 2 }));
	el.dispatchEvent(new PointerEvent('pointerup', { ...base, ...at(c.x + 60, c.y + 30), buttons: 0 }));
	el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, ...at(c.x + 60, c.y + 30) }));
}, c0);
await settle(500);
ok((await menu.count()) === 0, 'right-drag (press, move 67 px, release, then contextmenu) opened no menu');
await shot('right-drag');
await page.keyboard.press('Escape');

console.log(`\nunstubbed Directus calls (answered with empty data): ${[...unstubbed].join(', ') || 'none'}`);
await browser.close();
if (problems.length) console.log(`\nconsole/page errors (informational):\n- ${[...new Set(problems)].slice(0, 15).join('\n- ')}`);
if (failures.length) { console.log(`\n${failures.length} assertion(s) FAILED:\n- ${failures.join('\n- ')}`); process.exit(1); }
console.log('\nall assertions passed');
