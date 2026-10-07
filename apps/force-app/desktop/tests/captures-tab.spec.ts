import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

// Settings > Local Captures, against the real backend and the operator's real capture drive.
// Read-only: it asserts the listing renders and reports the drive, and never clicks Delete —
// this suite runs on the acquisition machine where those are real recordings.

const MAIN_JS = path.join(__dirname, '..', 'dist', 'main.js');

async function launch(): Promise<ElectronApplication> {
  const { ELECTRON_RUN_AS_NODE, ...cleanEnv } = process.env;
  return electron.launch({
    args: [MAIN_JS],
    env: { ...cleanEnv, FORCE_APP_TEST_HOOKS: '1' },
    timeout: 30_000,
  });
}

async function bypassLogin(window: Page, app: ElectronApplication): Promise<{ recorderUrl: string }> {
  await window.waitForURL((u) => u.href.startsWith('app://force/'), { timeout: 30_000 });
  const userDataDir = await app.evaluate(({ app: a }) => a.getPath('userData'));
  const cfg = JSON.parse(fs.readFileSync(path.join(userDataDir, 'config.json'), 'utf-8'));
  await window.route(`${new URL(cfg.directusUrl).origin}/**`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) }),
  );
  await window.evaluate(() => {
    localStorage.setItem('force-app.auth', JSON.stringify({
      accessToken: 't', refreshToken: 't', expiresAt: Date.now() + 3_600_000, user: { id: 'test', role: null },
    }));
  });
  return cfg;
}

test('Settings > Local Captures lists what is on disk', async () => {
  const app = await launch();
  try {
    const window = await app.firstWindow();
    const cfg = await bypassLogin(window, app);

    await window.goto('app://force/settings?tab=captures');
    await expect(window.locator('.caps')).toBeVisible({ timeout: 15_000 });

    // Cross-check the rendered list (first page, 200 rows) against the endpoint it is built from, so a rendering
    // regression can't pass by showing a plausible-looking but empty list.
    const api = await fetch(`${cfg.recorderUrl}/captures/browse?limit=200`).then((r) => r.json());
    console.log(`[captures-tab] backend reports ${api.captures.length} captures, ${api.total_size_mb} MB`);

    await expect.poll(async () => window.locator('.caps .row').count(), { timeout: 15_000 })
      .toBe(api.captures.length);

    if (api.captures.length) {
      const first = window.locator('.caps .row').first();
      await expect(first.locator('.rname')).not.toBeEmpty();
      // Every row must offer a delete affordance — the whole point of the tab.
      await expect(first.locator('.btn.danger')).toBeVisible();
    } else {
      await expect(window.locator('.caps .empty')).toBeVisible();
    }

    // The drive path is what tells the operator which disk is being filled.
    await expect(window.locator('.caps .path')).toContainText(api.captures_root.slice(0, 3));
  } finally {
    try {
      const window = await app.firstWindow();
      await window.evaluate(() => localStorage.removeItem('force-app.auth'));
    } catch { /* best effort */ }
    await app.close();
  }
});
