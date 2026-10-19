import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

/**
 * Playwright config for the suites that run against the LOCAL STACK (scripts/dev/local-stack.sh: real Postgres, real Directus with
 * the repo's extensions, STARbase's dev server), not against the d1-starbase preview of tests/ui/README.md.
 *
 *   bash scripts/dev/local-stack.sh up
 *   cd tests/ui && npx playwright test -c playwright.local-stack.config.ts
 *
 * The cloud container has one Chromium at /opt/pw-browsers/chromium whose build does not match the installed Playwright, so the
 * binary is passed explicitly (never `playwright install` there); D1_CHROMIUM overrides it. A tall viewport: the process map keeps
 * the viewport where it was when a card is added, so a small window leaves new cards off screen.
 */
const chromium = [process.env.D1_CHROMIUM, '/opt/pw-browsers/chromium'].find((p): p is string => !!p && existsSync(p));

export default defineConfig({
	testDir: './specs',
	testMatch: ['edit-mode.spec.ts', 'edit-mode-slice1.spec.ts', 'edit-mode-slice2a.spec.ts', 'edit-mode-slice2b.spec.ts'],
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 90_000,
	expect: { timeout: 15_000 },
	reporter: [['list']],
	use: {
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure',
		launchOptions: chromium ? { executablePath: chromium } : {},
	},
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1920, height: 1300 } } }],
});
