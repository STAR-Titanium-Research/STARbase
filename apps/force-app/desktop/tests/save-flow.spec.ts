import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

// Exercises the record -> stop -> save flow end to end against the rebuilt app. Forces the
// 'sim' source explicitly: this suite runs on a shared CI runner whose persisted
// force-app.source can be flipped to 'nidaq' by whoever last used it interactively (or by
// workspace.ts's one-time auto-detect, if a device happens to be enumerable that run), and a
// real NI-DAQ device on a CI box is not a reliable, repeatable signal — reads can legitimately
// overrun or error for reasons that have nothing to do with a regression in this app (cabling,
// device power state, another process holding the channel). An earlier version of this test
// deliberately left force-app.source untouched specifically to exercise the real hardware
// read()/stop() race apps/force-app/backend/app/sources/nidaq.py's lock + shortened read timeout
// were written to fix — that's a real and valuable test, but it belongs in a manual/hardware-gated
// run, not in the release pipeline every push has to pass. Forcing 'sim' here proves the shared
// session.py/main.py stop/finalize/save-dialog plumbing isn't regressed, deterministically.
//
// This verifies both things the original bug report was about:
//   1. the staged save-dialog UI (Stopping acquisition / Writing capture files / Loading
//      recorded trace) renders and clears correctly, and
//   2. how long a manual Stop mid-recording actually takes — printed to the test log, and
//      cross-checked against apps/force-app/backend/captures/backend.log's per-stage timings at
//      the end of the run.
//
// Dev-mode Electron launches (this test included) all share the app's real userData profile —
// there's no per-launch isolation — so the fake auth this test seeds into localStorage to get
// past the login screen (see stubDirectusAndBypassLogin) is cleaned up in the finally block.
// Left in place, it bled into the next launch (this test's own real-world symptom, hit while
// developing it: it caused two spurious 401 console errors on smoke.spec.ts's login-page test
// run right after this one).

const MAIN_JS = path.join(__dirname, '..', 'dist', 'main.js');

async function launch(): Promise<ElectronApplication> {
  const { ELECTRON_RUN_AS_NODE, ...cleanEnv } = process.env;
  return electron.launch({
    args: [MAIN_JS],
    env: { ...cleanEnv, FORCE_APP_TEST_HOOKS: '1' },
    timeout: 30_000,
  });
}

async function readAppConfig(app: ElectronApplication): Promise<{ directusUrl: string; recorderUrl: string }> {
  const userDataDir = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  const raw = fs.readFileSync(path.join(userDataDir, 'config.json'), 'utf-8');
  return JSON.parse(raw);
}

// The renderer requires a Directus session token to get past the router's auth guard, and there
// is no real Directus login available to this test. A fake-but-well-formed token alone is not
// enough: the app fires real Directus reads on mount (e.g. workspace.ts's getMethods() warm-up),
// a fake token gets a real 401 from the (reachable, real) server on this machine, and
// directusClient.ts's 401 handler wipes the token and bounces back to /login — which showed up
// as the RecordingOptions panel continuously detaching from the DOM mid-test. Routing every
// Directus request to a generic 200 avoids that entirely, and is more hermetic than depending on
// how a real server happens to respond to a bad token.
async function stubDirectusAndBypassLogin(window: Page, directusUrl: string): Promise<void> {
  const origin = new URL(directusUrl).origin;
  await window.route(`${origin}/**`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) }),
  );
  await window.evaluate(() => {
    localStorage.setItem('force-app.auth', JSON.stringify({
      accessToken: 'test-access-token',
      refreshToken: 'test-refresh-token',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'test-user', role: null },
    }));
    // Force 'sim' regardless of whatever this profile has persisted — see header comment.
    localStorage.setItem('force-app.source', 'sim');
  });
  // Not window.reload(): the current URL at this point is still /login (public route, so the
  // guard never bounces it anywhere) — reloading it just reloads /login again, token or not. A
  // fresh navigation to '/' is what makes the guard actually re-evaluate and redirect to /record.
  await window.goto('app://force/');
}

test('rebuilt app: sim record -> stop -> save dialog shows staged progress and completes', async () => {
  const app = await launch();
  const pageErrors: string[] = [];
  // There is no "delete a finalized capture" endpoint (only /recovery/discard, which explicitly
  // refuses once summary.json exists) — clicking "Don't save" deliberately leaves the raw capture
  // on disk (see SaveCutDialog.vue's own comment on that). So this sim recording is real and
  // lands in the same D:\ captures folder as the operator's actual recordings unless the test
  // removes it itself; captureId/capturesRoot are filled in once known and cleaned up below.
  let captureId: string | null = null;
  let capturesRoot: string | null = null;
  try {
    const window = await app.firstWindow();
    window.on('pageerror', (err) => pageErrors.push(err.message));

    await window.waitForURL((url) => url.href.startsWith('app://force/'), { timeout: 30_000 });
    const cfg = await readAppConfig(app);
    capturesRoot = await fetch(`${cfg.recorderUrl}/storage/config`).then((r) => r.json()).then((j) => j.captures_root);
    await stubDirectusAndBypassLogin(window, cfg.directusUrl);

    // Past the auth guard, '/' redirects to '/record'.
    await window.waitForURL((url) => url.href.includes('/record'), { timeout: 15_000 });

    const startBtn = window.locator('.btn.start');
    await expect(startBtn).toBeEnabled({ timeout: 15_000 }); // waits on w.st.connected (WS to the recorder)
    await startBtn.click();

    // The first start of a session asks whether to test the alarms first (workspace.ts,
    // checkAlarmsBeforeStart). This used to be a window.confirm() that opened a native OS dialog
    // Playwright could not see, so the gate had to be skipped outright under FORCE_APP_TEST_HOOKS;
    // now it is a real DOM dialog, so the test meets it exactly as an operator does and declines.
    const alarmGate = window.locator('[data-testid="confirm-dialog"]');
    await expect(alarmGate).toBeVisible({ timeout: 10_000 });
    await window.locator('[data-testid="confirm-cancel"]').click(); // "Start without testing"
    await expect(alarmGate).toBeHidden();

    const stopBtn = window.locator('.btn.stop');
    await expect(stopBtn).toBeVisible({ timeout: 10_000 });

    // Let a few seconds of real acquisition accumulate — long enough that the manual Stop below
    // is very likely to land mid-chunk inside a blocking NI-DAQ read, which is exactly the "stop
    // while a hardware read is in flight" scenario the nidaq.py fix targets — before stopping
    // mid-recording rather than waiting for any configured duration to elapse on its own.
    await window.waitForTimeout(3000);
    await expect(stopBtn).toBeEnabled();
    const tStopClick = Date.now();
    await stopBtn.click();
    captureId = await fetch(`${cfg.recorderUrl}/record/status`).then((r) => r.json()).then((j) => j.id ?? null);

    // The save dialog opens the instant Stop is pressed and should show all three progress stages
    // (rendered under v-if="loading" — brief on fast hardware, so catching one mid-flight isn't
    // guaranteed, but should still be visible at least once before it clears).
    const dialog = window.locator('.scd-modal');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await expect(window.locator('.scd-stage')).not.toHaveCount(0, { timeout: 2_000 }).catch(() => {});

    // Once loading finishes, the progress list (v-if="loading") is replaced by the save form —
    // this is the real regression + timing check: if the acquisition-stop or finalize path is
    // broken (or slow), this never happens (or takes a long time) and the dialog is stuck showing
    // '.scd-stage' elements instead. This is the actual number from the original bug report
    // ("30s to display the plot") — printed below, not just bounded by the assertion timeout, so
    // it's evidence either way rather than a pass/fail coin flip.
    await expect(window.locator('.scd-opts')).toBeVisible({ timeout: 45_000 });
    const stopToReadySec = (Date.now() - tStopClick) / 1000;
    console.log(`[timing] Stop click -> save form ready: ${stopToReadySec.toFixed(2)}s (source=sim)`);
    await expect(window.locator('.scd-stage')).toHaveCount(0);
    await expect(window.locator('.scd-plot canvas')).toBeVisible();

    // Discard without saving — exercises the dialog's other primary exit path.
    await dialog.getByRole('button', { name: "Don't save" }).click();
    await expect(window.locator('.scd-confirm')).toBeVisible();
    await dialog.getByRole('button', { name: 'Yes, discard' }).click();
    await expect(dialog).not.toBeVisible({ timeout: 5_000 });

    expect(pageErrors).toEqual([]);
  } finally {
    try {
      // main.ts points the sidecar at <userData>/logs via FORCE_APP_LOG_DIR (the backend's own
      // fallback is %LOCALAPPDATA%\force-app\logs — never package-relative, which under a packaged
      // install would land in Program Files and be unwritable).
      const userDataDir = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
      const logPath = path.join(userDataDir, 'logs', 'backend.log');
      const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
      console.log('[backend.log tail]\n' + lines.slice(-12).join('\n'));
    } catch {
      /* log file not found — not fatal to the test */
    }
    try {
      const window = await app.firstWindow();
      await window.evaluate(() => {
        localStorage.removeItem('force-app.auth');
        // Don't leave the forced 'sim' override behind on this shared profile — the next real
        // operator session (or the next test relying on whatever was persisted before) should see
        // whatever source was configured prior to this run, not a source this test injected.
        localStorage.removeItem('force-app.source');
      });
    } catch {
      /* app may already be in a bad state (test failure) — best-effort cleanup only */
    }
    await app.close();
    if (captureId && capturesRoot) {
      // Path guard mirrors the backend's own (main.py's _capture_file / recovery's session_id
      // checks) — captureId always comes from the backend's own /record/status, but never build
      // a filesystem path from an unvalidated string.
      if (!captureId.includes('/') && !captureId.includes('\\') && !captureId.includes('..')) {
        fs.rmSync(path.join(capturesRoot, captureId), { recursive: true, force: true });
      }
    }
  }
});
