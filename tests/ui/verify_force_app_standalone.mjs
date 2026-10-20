// Smoke test for the standalone Force App (apps/force-app/web) — Phase 1.
// Follows the tests/ui/verify_*.mjs convention (env-driven, @playwright/test chromium,
// generous settle time). Two tiers:
//   1. ALWAYS (no backend needed): app root redirects to /login and the login screen renders.
//   2. IF creds given (FORCE_APP_EMAIL/PASSWORD, live Directus): full login → selector →
//      plotting view. Set FORCE_APP_EMAIL to enable the authed tier.
//
// Run:  FORCE_APP_BASE_URL=http://localhost:5180 node tests/ui/verify_force_app_standalone.mjs
import { chromium } from '@playwright/test';

const BASE = process.env.FORCE_APP_BASE_URL || 'http://localhost:5180';
const EMAIL = process.env.FORCE_APP_EMAIL || process.env.D1_ADMIN_EMAIL || process.env.DIRECTUS_ADMIN_EMAIL || '';
const PASS = process.env.FORCE_APP_PASSWORD || process.env.D1_ADMIN_PASSWORD || process.env.DIRECTUS_ADMIN_PASSWORD || '';

(async () => {
  const b = await chromium.launch();
  const c = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
  const p = await c.newPage();
  let ok = true;

  // --- Tier 1: guard + login page render (no backend required) ---
  await p.goto(BASE, { waitUntil: 'networkidle' });
  await p.waitForTimeout(800);
  const onLogin = /\/login/.test(p.url());
  const brand = await p.locator('.brand h1', { hasText: 'Force App' }).count();
  const hasEmail = await p.locator('input[type="email"]').count();
  const hasPass = await p.locator('input[type="password"]').count();
  const hasSubmit = await p.locator('button[type="submit"]').count();
  console.log('redirected to /login:', onLogin);
  console.log('login brand / email / password / submit:', brand, hasEmail, hasPass, hasSubmit);
  ok = ok && onLogin && brand === 1 && hasEmail === 1 && hasPass === 1 && hasSubmit === 1;
  await p.screenshot({ path: 'tests/ui/force_app_login.png', fullPage: true });

  // --- Tier 2: authed flow (only if creds provided) ---
  if (EMAIL && PASS) {
    await p.fill('input[type="email"]', EMAIL);
    await p.fill('input[type="password"]', PASS);
    await p.click('button[type="submit"]');
    await p.waitForTimeout(2500);
    // Lands in the sidebar shell; navigate to Plot.
    const navItems = await p.locator('.sidebar .navitem').count();
    console.log('sidebar nav items:', navItems);
    await p.locator('.sidebar .navitem', { hasText: 'Plot' }).click();
    await p.waitForTimeout(4000);
    const onPlot = /\/plot/.test(p.url());
    // The dashboard mounts a sample/operation list; assert the explorer chrome is present.
    const explorer = await p.locator('[data-panel-id] .charts, .fp-lists .fp-card, .fp-empty').count();
    console.log('reached /plot:', onPlot, '| explorer nodes:', explorer);
    await p.screenshot({ path: 'tests/ui/force_app_plot.png', fullPage: true });
    ok = ok && navItems === 4 && onPlot && explorer > 0;
  } else {
    console.log('(no FORCE_APP_EMAIL/PASSWORD — skipping authed tier; ran login-render checks only)');
  }

  await b.close();
  console.log(ok ? 'PASS' : 'FAIL');
  process.exit(ok ? 0 : 1);
})();
