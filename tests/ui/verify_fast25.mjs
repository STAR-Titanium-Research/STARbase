import { chromium } from '@playwright/test';
const BASE = process.env.D1_BASE_URL || 'https://d1-server.tail54eeb6.ts.net';
const EMAIL = process.env.D1_ADMIN_EMAIL || 'admin@example.com';
const PASSWORD = process.env.D1_ADMIN_PASSWORD;
if (!PASSWORD) throw new Error('D1_ADMIN_PASSWORD must be set (no default)');
const OP = 'a2e2c03a-2d05-51ed-baf4-8e03f92522b6'; // 25-machine example CSV import
(async () => {
  const b = await chromium.launch();
  const c = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 950 } });
  const p = await c.newPage();
  const errs = [];
  p.on('console', m => { if (m.type()==='error' && !m.text().includes('auth/refresh') && !m.text().includes('status of 400')) errs.push(m.text()); });
  p.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  await p.goto(`${BASE}/admin/login`);
  await p.fill('input[type="email"]', EMAIL);
  await p.fill('input[type="password"]', PASSWORD);
  await p.click('button[type="submit"]');
  await p.waitForTimeout(2500);

  await p.goto(`${BASE}/admin/d1-fast-dashboard?operation=${OP}`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(3000);

  const traceTxt = (await p.locator('.trace-meta').first().textContent().catch(()=>'')).trim();
  console.log('trace meta:', traceTxt);
  console.log('expect 25-machine / 3015 rows / 32 series:', /25-machine/.test(traceTxt) && /3015 rows/.test(traceTxt) && /32 series/.test(traceTxt));

  // default seeded plots (temp tile + force tile) should already have polylines
  await p.waitForTimeout(1000);
  const tiles = await p.locator('.plot-grid .plot-tile').count();
  const svgs = await p.locator('.plot-grid .plot-tile .fchart-svg').count();
  const paths1 = await p.locator('.plot-grid .plot-tile').nth(0).locator('.fchart-svg path').count();
  const paths2 = await p.locator('.plot-grid .plot-tile').nth(1).locator('.fchart-svg path').count();
  console.log('tiles:', tiles, '| svgs:', svgs, '| tile1 polylines:', paths1, '| tile2 polylines:', paths2);

  // check axis ticks + legend rendered with sane (non-NaN) values
  const tickTexts = await p.locator('.plot-grid .plot-tile').first().locator('.tick').allTextContents();
  console.log('tile1 tick sample:', JSON.stringify(tickTexts.slice(0,6)));
  const hasNaN = tickTexts.some(t => /NaN|undefined/.test(t));
  console.log('any NaN/undefined in ticks:', hasNaN);

  const legendTexts = await p.locator('.plot-grid .plot-tile').first().locator('.lg').allTextContents();
  console.log('tile1 legend:', JSON.stringify(legendTexts));

  // right-click -> add a 3rd, different-unit series (e.g. a pressure/vacuum one) to a new tile
  await p.locator('.plots-head .btn').click(); // add plot
  await p.waitForTimeout(300);
  const tile3 = p.locator('.plot-grid .plot-tile').nth(2);
  await tile3.click({ button: 'right' });
  await p.waitForTimeout(400);
  const groups = await p.locator('.ctx-grp-label').allTextContents();
  console.log('series groups available:', JSON.stringify(groups));
  const items = p.locator('.ctx-item');
  const n = await items.count();
  // pick two items from possibly different groups to exercise mixed-unit normalise path
  if (n >= 2) {
    await items.nth(0).locator('input').check();
    await items.nth(Math.min(5, n-1)).locator('input').check();
  }
  await p.mouse.click(5,5);
  await p.waitForTimeout(600);
  const paths3 = await tile3.locator('.fchart-svg path').count();
  console.log('tile3 (new, 2 series) polylines:', paths3);

  // toggle normalise on tile3 and confirm it re-renders without error
  await tile3.locator('.ib').first().click();
  await p.waitForTimeout(400);
  const paths3b = await tile3.locator('.fchart-svg path').count();
  console.log('tile3 after normalise toggle polylines:', paths3b);

  // download button works (href present)
  const dlHref = await p.locator('.btn.dl').getAttribute('onclick').catch(()=>null);
  const dlPresent = await p.locator('.btn.dl').count();
  console.log('download button present:', dlPresent > 0);

  await p.screenshot({ path: 'fast25.png', fullPage: false });
  console.log('errors:', errs.length ? JSON.stringify(errs.slice(0,6)) : 'none');
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
