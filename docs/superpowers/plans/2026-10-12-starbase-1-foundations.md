# STARbase, plan 1: foundations (step 0, FAST package, page move)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the risky parts of the STARbase design on a copy of live. Then make the Explorer
pages host-neutral: they move into `@d1/starbase-pages`, and the FAST plotter into
`@d1/fast-plotting`. The Directus Home module must keep working exactly as today.

**Architecture:**
- Pages reach their host through three module-level seams in `@d1/ui`:
  - `setExplorerHostFactory` provides data access, the user and admin status, and field
    definitions;
  - `configureLinks` decides what a path written in Directus form means in this host;
  - `setPageFrame`, in `@d1/starbase-pages`, provides the chrome around a page.
- The Directus side of those seams is a small package, `@d1/directus-host`, installed by every
  Directus extension that uses the kit.
- No page or kit file imports `@directus/extensions-sdk`, and a guard test enforces it.

**Tech Stack:** Vue 3.5, vue-router 4, TypeScript 7, vitest 4, Directus 11 extensions
(`directus-extension build`), Playwright (`@playwright/test` in `tests/ui`), Bash + Docker for the
preview.

**Spec:** `docs/superpowers/specs/2026-10-12-starbase-standalone-design.md`. Read §8 (errata)
first. ADR-0013.

## Global Constraints

- Work in the worktree `D:\Users\CMBE Admn 3214022001\Documents\GitHub\D1-Database\.claude\worktrees\explorer-standalone`
  on branch `feat/explorer-standalone`, stacked on PR #247 (`feat/label-printing`). Never commit
  to `main`.
- **Nothing touches live.** No `docker compose` on the `d1-database` project, no live Directus
  writes, no `tailscale` commands. The preview (`scripts/dev/explorer_preview.sh`) is the only
  running Directus you use.
- **The Directus Home module shows no visible change.** The route harness from Task 3 must pass
  after every task from Task 6 on.
- `@d1/ui` and `@d1/starbase-pages` sources never contain `@directus/extensions-sdk`, `useApi(`
  or `useStores(` (enforced from Task 8).
- Run the tests of every package you touch before each commit (`npm test -w <name>`,
  `npm run typecheck -w <name>`). Each change ships with a test that was actually run.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Push after
  each task: `git push origin HEAD:feat/explorer-standalone`.
- Names used across tasks are exact: `setExplorerHostFactory`, `useExplorerHost`,
  `ExplorerHost.fieldsFor`, `HostApi`, `configureLinks`, `directusLinks`, `starbaseLinks`,
  `resolveLink`, `canonicalPath`, `serverUrl`, `assetUrl`, `openLink`, `linkHref`, `AppLink`,
  `installDirectusHost`, `useDirectusHost`, `setPageFrame`, `starbaseRoutes`, `setFastHost`,
  `useFastHost`.

## Review Focus

1. **A Lab Member (not only an admin)** opens every Home-module page after the move with no
   console error. Task 3's harness runs as both accounts.
2. **Paths with a query string or an encoded id** (`/home/samples?bookmark=3`,
   `/home/samples/a%2Fb`) come back unchanged from `resolveLink` and `canonicalPath`, in both
   hosts. These are unit tests in Task 7.
3. **A host that never calls `configureLinks`** behaves exactly as today: a Directus route stays a
   route, and `/d1-report/` opens in a new tab. This is a unit test in Task 7.
4. **The other extensions that use the kit** (the campaign-ops interface on a campaign form, and
   the lab dashboard) still render after the seam. Today they would throw "no Explorer host" if
   they forgot to install one. The harness covers this in Task 3, and Task 6 installs the host.
5. **A failed request in a moved page** still shows the page's own error state, and not a blank
   page. Directus's `useApi` and the host's `api` must reject the same way, axios-style with
   `e.response.status`. Task 6 checks that the Directus host passes `useApi()` through unwrapped.

---

### Task 0: Branch setup (done while planning)

`feat/explorer-standalone` was rebuilt on `origin/feat/label-printing` (`21c527a9`), with the
docs commits re-applied (`255baf92` … `0f06e6a3`).

- [x] **Step 1: Push the branch and retarget the draft PR at the Labels branch** (done 2026-10-12)

```bash
cd "/d/Users/CMBE Admn 3214022001/Documents/GitHub/D1-Database/.claude/worktrees/explorer-standalone"
git push --force-with-lease origin HEAD:feat/explorer-standalone
gh pr edit 250 --base feat/label-printing
```

Expected: PR #250 shows only the STARbase docs commits.

---

### Task 1: Preview options for extra settings and extra extensions

The step-0 checks need the preview Directus to run with extra settings (CORS, the frame
setting, a different public URL) and with a throwaway extension. Today the script hard-codes
`PUBLIC_URL` and accepts extensions only from `core/extensions`.

**Files:**
- Modify: `scripts/dev/explorer_preview.sh` (header comment, lines 19-23, the overlay loop at
  42-45, the `docker run` at 85-91)

**Interfaces:**
- Produces three environment variables:
  - `D1_PREVIEW_ENV_FILE`: a path to a docker `--env-file`.
  - `D1_PREVIEW_PUBLIC_URL`: overrides `PUBLIC_URL`.
  - `D1_PREVIEW_EXTRA_EXT`: space-separated paths of *built* extension folders (each with a
    `package.json` and a `dist/`), copied into the merged extensions folder.

- [ ] **Step 1: Write the check first (it fails today)**

Create `scripts/dev/explorer_preview_options.test.sh`:

```bash
#!/usr/bin/env bash
# Checks the preview's option plumbing without starting anything: the script must parse, and its
# docker run line must carry the env file, the public-URL override and the extra extensions loop.
set -euo pipefail
cd "$(dirname "$0")/../.."
S=scripts/dev/explorer_preview.sh
bash -n "$S"
grep -q 'D1_PREVIEW_ENV_FILE' "$S"
grep -q 'D1_PREVIEW_PUBLIC_URL' "$S"
grep -q 'D1_PREVIEW_EXTRA_EXT' "$S"
grep -q '"${ENV_ARGS\[@\]}"' "$S"
grep -q 'PUBLIC_URL="$PUBLIC"' "$S"
echo "preview options: ok"
```

Run: `bash scripts/dev/explorer_preview_options.test.sh`
Expected: FAIL (non-zero exit; the first `grep` finds nothing).

- [ ] **Step 2: Implement**

In `scripts/dev/explorer_preview.sh`:

- Header comment, after the usage line: add

```bash
# Options (environment):
#   D1_PREVIEW_ENV_FILE=<file>     extra Directus settings, docker --env-file format (CORS, CSP, ...)
#   D1_PREVIEW_PUBLIC_URL=<url>    PUBLIC_URL for the preview (default http://127.0.0.1:$PORT)
#   D1_PREVIEW_EXTRA_EXT="<dir>…"  built extension folders (package.json + dist/) to add, e.g. a spike
```

- After line 22 (`OVERLAY=…`), add:

```bash
ENV_FILE="${D1_PREVIEW_ENV_FILE:-}"
EXTRA_EXT="${D1_PREVIEW_EXTRA_EXT:-}"
PUBLIC="${D1_PREVIEW_PUBLIC_URL:-http://127.0.0.1:$PORT}"
```

- After the overlay `for` loop (line 45), add:

```bash
for dir in $EXTRA_EXT; do
  [[ -f "$dir/package.json" && -d "$dir/dist" ]] || abort "extra extension $dir needs package.json and dist/"
  name="$(basename "$dir")"
  rm -rf "${EXT_DIR:?}/$name"; mkdir -p "$EXT_DIR/$name"; copy_ext "$dir" "$EXT_DIR/$name" || abort "copy $dir"
done
ENV_ARGS=()
if [[ -n "$ENV_FILE" ]]; then
  [[ -f "$ENV_FILE" ]] || abort "env file $ENV_FILE not found"
  ENV_ARGS=(--env-file "$ENV_FILE")
fi
```

- In the Directus `docker run`, put `"${ENV_ARGS[@]}"` right after `-p "127.0.0.1:$PORT:8055"`,
  and change `-e PUBLIC_URL="http://127.0.0.1:$PORT"` to `-e PUBLIC_URL="$PUBLIC"`.
  - Docker gives `-e` precedence over `--env-file`, so `PUBLIC_URL` is set only through
    `D1_PREVIEW_PUBLIC_URL`.
  - Under `set -u`, an empty array expansion `"${ENV_ARGS[@]}"` is fine on bash ≥ 4.4. Git Bash
    ships 5.x.

- [ ] **Step 3: Run the check**

Run: `bash scripts/dev/explorer_preview_options.test.sh`
Expected: `preview options: ok`

- [ ] **Step 4: Run it for real once**

```bash
printf 'D1_PREVIEW_PROBE=yes\n' > .superpowers/probe.env
npm run build -w directus-extension-d1-home
D1_PREVIEW_ENV_FILE=.superpowers/probe.env bash scripts/dev/explorer_preview.sh
docker exec d1-preview-directus printenv D1_PREVIEW_PROBE
```

Expected: `yes`. Leave the preview running for Task 2, or stop it with `--stop`.

- [ ] **Step 5: Commit**

```bash
git add scripts/dev/explorer_preview.sh scripts/dev/explorer_preview_options.test.sh
git commit -m "chore(preview): extra Directus settings, public URL and spike extensions for the preview

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin HEAD:feat/explorer-standalone
```

---

### Task 2: Step 0, check the three risky bits (STOP gate)

Throwaway code in `.superpowers/starbase-spike/` (git-ignored). Only the results are kept, in
the spec. **After this task, stop and report the results to the maintainer before Task 3.**

The questions:
- **(a)** Does `CONTENT_SECURITY_POLICY_DIRECTIVES__FRAME_ANCESTORS` change Directus's
  `frame-ancestors` header?
- **(b)** Does a Directus module page that does not use `private-view` render without the module
  bar? And can another origin frame it, already signed in?
- **(c)** Does a session-mode login made from `starbase.<tailnet>` reach `d1-server.<tailnet>` for
  STARbase's API calls, for Data Studio and inside a frame? Is sign-out shared too? Do the query
  strings axios builds (a `fields` array, a nested `filter`) work against Directus?

**Files (all git-ignored, not committed):**
- Create: `.superpowers/starbase-spike/d1-spike-bare/package.json`
- Create: `.superpowers/starbase-spike/d1-spike-bare/dist/index.js`
- Create: `.superpowers/starbase-spike/spike.html`
- Create: `.superpowers/starbase-spike/spike.mjs`
- Create: `.superpowers/starbase-spike/spike.env`
- Modify (committed): `docs/superpowers/specs/2026-10-12-starbase-standalone-design.md` (new §9 "Step-0 results")

- [ ] **Step 1: The bare module (hand-written dist, so no build is needed)**

`.superpowers/starbase-spike/d1-spike-bare/package.json`:

```json
{
  "name": "directus-extension-d1-spike-bare",
  "version": "0.0.0",
  "type": "module",
  "directus:extension": { "type": "module", "path": "dist/index.js", "source": "dist/index.js", "host": "^11.0.0" }
}
```

`.superpowers/starbase-spike/d1-spike-bare/dist/index.js`:

```js
import { h } from 'vue';

// Step-0 spike: a module page that does NOT wrap itself in <private-view>.
export default {
	id: 'd1-spike-bare',
	name: 'Spike bare',
	icon: 'crop_free',
	routes: [
		{
			path: '',
			component: {
				name: 'SpikeBare',
				render: () => h('div', { id: 'spike-bare', style: 'padding:24px;font:16px sans-serif' }, 'bare module page'),
			},
		},
	],
};
```

- [ ] **Step 2: The preview settings**

`.superpowers/starbase-spike/spike.env` (first form of the frame setting; Step 6 tries the other
form if this one is ignored):

```
CORS_ENABLED=true
CORS_ORIGIN=http://starbase.tail54eeb6.ts.net:5191
CORS_CREDENTIALS=true
CONTENT_SECURITY_POLICY_DIRECTIVES__FRAME_ANCESTORS='self' http://starbase.tail54eeb6.ts.net:5191
```

- [ ] **Step 3: The STARbase stand-in page**

`.superpowers/starbase-spike/spike.html`:

```html
<!doctype html>
<meta charset="utf-8" />
<title>STARbase spike</title>
<script src="/axios.min.js"></script>
<body>
<p id="state">ready</p>
<script>
	const D1 = 'http://d1-server.tail54eeb6.ts.net:18055';
	const api = axios.create({ baseURL: D1, withCredentials: true });
	window.signIn = async (email, password) => {
		await api.post('/auth/login', { email, password, mode: 'session' });
		return true;
	};
	window.probe = async () => {
		const me = (await api.get('/users/me', { params: { fields: ['id', 'email'] } })).data.data;
		const r = await api.get('/items/physical_samples', {
			params: { fields: ['id', 'sample_code'], filter: { sample_code: { _nnull: true } }, limit: 2 },
		});
		return { me, rows: r.data.data.length, url: r.request.responseURL };
	};
	window.signOut = async () => {
		await api.post('/auth/logout', { mode: 'session' });
		return true;
	};
	window.addFrame = () => {
		const f = document.createElement('iframe');
		f.id = 'edit';
		f.width = '900';
		f.height = '600';
		f.src = D1 + '/admin/d1-spike-bare';
		document.body.appendChild(f);
	};
</script>
</body>
```

- [ ] **Step 4: The runner**

`.superpowers/starbase-spike/spike.mjs`:

```js
// Step-0 spike for STARbase (throwaway). Two different hostnames under one tailnet name, both mapped
// to this machine, so cookies are tested across HOSTS (ports alone prove nothing: cookies ignore ports).
//   node .superpowers/starbase-spike/spike.mjs
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const require = createRequire(join(root, 'tests', 'ui', 'package.json'));
const { chromium } = require('@playwright/test');
const axiosJs = readFileSync(join(root, 'node_modules', 'axios', 'dist', 'axios.min.js'));

const creds = Object.fromEntries(
	readFileSync(join(root, '.superpowers', 'preview-credentials.txt'), 'utf8')
		.trim().split('\n').map((l) => l.split('=')),
);
const [email, password] = creds.member.split(' ');

const STAR = 'http://starbase.tail54eeb6.ts.net:5191';
const D1 = 'http://d1-server.tail54eeb6.ts.net:18055';

const server = createServer((req, res) => {
	if (req.url === '/axios.min.js') { res.setHeader('content-type', 'text/javascript'); return res.end(axiosJs); }
	res.setHeader('content-type', 'text/html');
	res.end(readFileSync(join(here, 'spike.html')));
}).listen(5191);

const out = {};
const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP *.tail54eeb6.ts.net 127.0.0.1'] });
try {
	// (a) the header Directus sends for its admin app
	const head = await fetch('http://127.0.0.1:18055/admin/');
	const csp = head.headers.get('content-security-policy') ?? '';
	out.a_frameAncestors = (csp.match(/frame-ancestors[^;]*/) ?? ['(none)'])[0];
	out.a_allowsStarbase = out.a_frameAncestors.includes('starbase.tail54eeb6.ts.net');

	const ctx = await browser.newContext();
	const star = await ctx.newPage();
	await star.goto(`${STAR}/spike.html`);
	out.c_staysHttp = star.url().startsWith('http://'); // no HSTS upgrade on these names

	// (c) sign in from STARbase, then use the session from STARbase, Data Studio and a frame
	await star.evaluate(([e, p]) => window.signIn(e, p), [email, password]);
	out.c_probe = await star.evaluate(() => window.probe());
	const studio = await ctx.newPage();
	await studio.goto(`${D1}/admin/content`, { waitUntil: 'networkidle' });
	out.c_studioSignedIn = !studio.url().includes('/login');

	// (b) the bare module, top level: does Directus draw its module bar around it?
	await studio.goto(`${D1}/admin/d1-spike-bare`, { waitUntil: 'networkidle' });
	out.b_bareRenders = await studio.locator('#spike-bare').isVisible().catch(() => false);
	out.b_moduleBarCount = await studio.locator('.module-bar').count();

	// (a)+(b)+(c) together: the bare page framed inside STARbase, already signed in
	await star.evaluate(() => window.addFrame());
	await star.waitForTimeout(4000);
	const frame = star.frames().find((f) => f.url().includes('d1-spike-bare'));
	out.frame_loaded = !!frame && (await frame.locator('#spike-bare').isVisible().catch(() => false));

	// sign out from STARbase: Data Studio must be signed out too
	await star.evaluate(() => window.signOut());
	await studio.goto(`${D1}/admin/content`, { waitUntil: 'networkidle' });
	out.c_sharedSignOut = studio.url().includes('/login');
} finally {
	await browser.close();
	server.close();
}
console.log(JSON.stringify(out, null, 2));
```

- [ ] **Step 5: Run**

```bash
npm run build -w directus-extension-d1-home
D1_PREVIEW_ENV_FILE=.superpowers/starbase-spike/spike.env \
D1_PREVIEW_PUBLIC_URL=http://d1-server.tail54eeb6.ts.net:18055 \
D1_PREVIEW_EXTRA_EXT=.superpowers/starbase-spike/d1-spike-bare \
bash scripts/dev/explorer_preview.sh
node .superpowers/starbase-spike/spike.mjs
```

Expected output (the hoped-for answers):
- `a_allowsStarbase: true`
- `c_staysHttp: true`
- `c_probe.me.email` is the member's email, `c_probe.rows ≥ 0`, and `c_probe.url` contains
  `fields[]=id` (or `fields%5B%5D=id`) and `filter[sample_code][_nnull]=true` in bracket form
- `c_studioSignedIn: true`
- `b_bareRenders: true`, with `b_moduleBarCount` reported
- `frame_loaded: true`
- `c_sharedSignOut: true`

- [ ] **Step 6: If (a) is false, try the array form once**

Change the last line of `spike.env` to
`CONTENT_SECURITY_POLICY_DIRECTIVES__FRAME_ANCESTORS=array:'self',http://starbase.tail54eeb6.ts.net:5191`.
Then run `bash scripts/dev/explorer_preview.sh --stop`, repeat Step 5, and record which form
works (or that neither does).

- [ ] **Step 7: If `c_staysHttp` is false (HSTS upgraded the names)**

Serve both names over HTTPS with a throwaway self-signed certificate:
1. Generate it: `openssl req -x509 -newkey rsa:2048 -nodes -subj "/CN=starbase" -addext "subjectAltName=DNS:starbase.tail54eeb6.ts.net,DNS:d1-server.tail54eeb6.ts.net" -keyout .superpowers/starbase-spike/key.pem -out .superpowers/starbase-spike/cert.pem -days 2`.
2. Change `createServer` to `https.createServer({ key, cert }, …)`.
3. Front the preview Directus with a second `https` proxy on 18443 (node `http-proxy` is NOT
   available; use `node:https` plus `node:http` request piping).
4. Launch Chromium with `--ignore-certificate-errors`, and use `https://` in `STAR`, `D1` and
   `spike.env`.

Record that HTTPS was needed.

- [ ] **Step 8: Record the results in the spec and STOP**

Append to the spec:

```markdown
## 9. Step-0 results (<date>)

| Check | Result | Consequence |
|---|---|---|
| (a) frame-ancestors setting | <worked with form X / ignored> | <frame / new-tab fallback> |
| (b) bare module | renders: <yes/no>; module bar elements: <n> | <form-only page as designed / needs CSS hiding / other> |
| (b) framed + signed in | <yes/no> | |
| (c) cross-host session (STARbase → API, Data Studio, frame) | <yes/no each> | <shared session / Bearer fallback> |
| (c) shared sign-out | <yes/no> | |
| (c) axios query strings | <url seen> | |
| HSTS | <http worked / https needed> | |
```

Then:

```bash
bash scripts/dev/explorer_preview.sh --stop
git add docs/superpowers/specs/2026-10-12-starbase-standalone-design.md
git commit -m "docs(starbase): step-0 results

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin HEAD:feat/explorer-standalone
```

**STOP.** Report the table to the maintainer. A "no" on (c) changes the sign-in design and needs
their decision. A "no" on (a) means editing opens in a new tab, as the spec already allows.
Continue only once the maintainer says so.

---

### Task 3: A route harness for the Home module (the safety net for the move)

`d1-home` has no tests, so "no visible change" needs a check you can run. This Playwright spec
visits every page of the Home module, as an admin and as a Lab Member, on the preview. It also
visits the two other extensions that use the kit. It must pass on today's code before anything
moves.

**Files:**
- Create: `tests/ui/specs/13-explorer-routes.spec.ts`
- Modify: `tests/ui/README.md` (add one line describing spec 13 and how to run it against the preview)

**Interfaces:**
- Consumes: the `.superpowers/preview-credentials.txt` format, lines `url=…/admin`,
  `admin=<email> <password>` and `member=<email> <password>`.
- Produces: `D1_ROUTES_CREDENTIALS` (path to that file) and `D1_ROUTES_ADMIN_BASE`. The latter is
  the Directus app root to visit, default `<url>`. Plan 2 points the same spec at STARbase.

- [ ] **Step 1: Write the spec**

```ts
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Every page of the Home module (the future STARbase pages), as an admin and as a Lab Member, on
// the preview copy of live: each must draw its page and the Explorer nav with no console error.
// The route list is read from the nav config, so a page added there is checked without editing this.
//   (cd tests/ui && npx playwright test specs/13-explorer-routes.spec.ts)
// Needs: bash scripts/dev/explorer_preview.sh (from the repo root) running.

const repo = join(__dirname, '..', '..', '..');
const credsFile = process.env.D1_ROUTES_CREDENTIALS || join(repo, '.superpowers', 'preview-credentials.txt');
const creds = Object.fromEntries(
	readFileSync(credsFile, 'utf8').trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const ADMIN_BASE = (process.env.D1_ROUTES_ADMIN_BASE || creds.url).replace(/\/+$/, ''); // …/admin
const SERVER = ADMIN_BASE.replace(/\/admin$/, '');

const navSource = readFileSync(join(repo, 'packages', 'd1-ui', 'src', 'nav', 'navConfig.ts'), 'utf8');
const NAV_ROUTES = [...new Set([...navSource.matchAll(/to: '(\/home[^'?]*)'/g)].map((m) => m[1]))];
const EXTRA_ROUTES = ['/home/register-sample', '/home/people', '/home/labels'];
const ROUTES = [...new Set([...NAV_ROUTES, ...EXTRA_ROUTES])];

const RECORDS: [string, string][] = [
	['physical_samples', '/home/samples/'],
	['manufacturing_operations', '/home/operations/'],
	['test_sessions', '/home/tests/'],
	['campaigns', '/home/campaigns/'],
	['projects', '/home/projects/'],
];

const IGNORED_CONSOLE = [/favicon/i, /ResizeObserver loop/];

async function signIn(page: Page, who: 'admin' | 'member') {
	const [email, password] = creds[who].split(' ');
	await page.goto(`${SERVER}/admin/login`, { waitUntil: 'domcontentloaded' });
	await page.locator('input[type="email"]').fill(email);
	await page.locator('input[type="password"]').fill(password);
	await page.getByRole('button', { name: /sign in/i }).click();
	await page.waitForURL((u) => !u.pathname.endsWith('/login'), { timeout: 30_000 });
}

async function firstId(page: Page, collection: string): Promise<string | null> {
	const r = await page.request.get(`${SERVER}/items/${collection}?limit=1&fields=id&sort=-date_created`);
	if (!r.ok()) return null;
	const rows = (await r.json()).data as { id: string }[];
	return rows[0]?.id ?? null;
}

async function visit(page: Page, path: string, errors: string[]) {
	errors.length = 0;
	await page.goto(`${ADMIN_BASE}${path}`, { waitUntil: 'networkidle' });
	await expect(page.locator('.d1-page').first(), `${path}: page body`).toBeVisible();
	await expect(page.locator('nav.d1-nav').first(), `${path}: Explorer nav`).toBeVisible();
	await expect(page.locator('body'), `${path}: no crash text`).not.toContainText(/Unexpected Error|no Explorer host/i);
	expect(errors, `${path}: console errors`).toEqual([]);
}

for (const who of ['admin', 'member'] as const) {
	test.describe(`Home module routes as ${who}`, () => {
		test.setTimeout(10 * 60_000);

		test('every page draws with no console error', async ({ page }) => {
			const errors: string[] = [];
			page.on('pageerror', (e) => errors.push(String(e)));
			page.on('console', (m) => {
				if (m.type() === 'error' && !IGNORED_CONSOLE.some((r) => r.test(m.text()))) errors.push(m.text());
			});
			await signIn(page, who);
			for (const path of ROUTES) await visit(page, path, errors);
			for (const [collection, prefix] of RECORDS) {
				const id = await firstId(page, collection);
				if (id) await visit(page, prefix + encodeURIComponent(id), errors);
			}
		});

		test('the other kit users still render', async ({ page }) => {
			const errors: string[] = [];
			page.on('pageerror', (e) => errors.push(String(e)));
			await signIn(page, who);
			const campaign = await firstId(page, 'campaigns');
			if (campaign) {
				await page.goto(`${ADMIN_BASE}/content/campaigns/${campaign}`, { waitUntil: 'networkidle' });
				await expect(page.locator('body')).not.toContainText(/no Explorer host/i);
			}
			await page.goto(`${ADMIN_BASE}/d1-lab-dashboard`, { waitUntil: 'networkidle' });
			await expect(page.locator('body')).not.toContainText(/no Explorer host/i);
			expect(errors).toEqual([]);
		});
	});
}
```

- [ ] **Step 2: Run it on today's code**

```bash
npm run build -w directus-extension-d1-home
bash scripts/dev/explorer_preview.sh
cd tests/ui && npx playwright test specs/13-explorer-routes.spec.ts --retries=0
```

Expected: 4 passed.
- **If a route fails on today's code**, the failure is pre-existing. Do not fix pages in this
  task. Add the route's text to an explicit `KNOWN_BROKEN` list in the spec with a comment naming
  the error, report it to the maintainer, and keep going.
- **If a console error is environmental** (e.g. a missing asset file on the copy), add a narrowly
  matching regex to `IGNORED_CONSOLE` with a comment.

- [ ] **Step 3: Commit**

```bash
git add tests/ui/specs/13-explorer-routes.spec.ts tests/ui/README.md
git commit -m "test(ui): route harness for every Home-module page, as admin and Lab Member

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin HEAD:feat/explorer-standalone
```

---

### Task 4: `@d1/fast-plotting`, the FAST plotter as a shared package

Re-extract today's `d1-fast-dashboard` into a package, behind the `FastHost` contract from
`feat/lab-web-stage1`. The Directus module becomes a thin wrapper. There is no visible change.

**Files:**
- Create: `packages/fast-plotting/package.json`, `packages/fast-plotting/tsconfig.json`
- Create: `packages/fast-plotting/src/host.ts`, `packages/fast-plotting/src/host.test.ts`,
  `packages/fast-plotting/src/index.ts`
- Move (`git mv`): `core/extensions/d1-fast-dashboard/src/{FastChart.vue,FastDashboard.vue,fastCache.ts,fastMeta.ts}` → `packages/fast-plotting/src/`
- Modify: `packages/fast-plotting/src/FastDashboard.vue` (the `useApi`, `recordRoute` and trace-error lines)
- Create: `core/extensions/d1-fast-dashboard/src/DirectusFastDashboard.vue`
- Modify: `core/extensions/d1-fast-dashboard/src/index.ts`, `core/extensions/d1-fast-dashboard/package.json`
- Modify: `.github/scripts/ci-plan.mjs` (the `directusUi` list), `.github/workflows/ci.yml` (the `directus-ui` job)

**Interfaces:**
- Produces:
  - `FastHost { api: AxiosInstance; openRecord(collection: string, id: string): void }`
  - `setFastHost(host)`, `useFastHost()`, `resetFastHost()`
  - `export { default as FastDashboard } from './FastDashboard.vue'`
- Plan 2's STARbase plot page uses these.

- [ ] **Step 1: Write the failing host test**

`packages/fast-plotting/src/host.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { resetFastHost, setFastHost, useFastHost, type FastHost } from './host';

describe('FastHost', () => {
	afterEach(() => resetFastHost());

	it('throws a clear error when no host is installed', () => {
		expect(() => useFastHost()).toThrow(/no host installed/);
	});

	it('returns the installed host', () => {
		const host = { api: {} as FastHost['api'], openRecord: () => {} };
		setFastHost(host);
		expect(useFastHost()).toBe(host);
	});
});
```

- [ ] **Step 2: Create the package and move the files**

```bash
mkdir -p packages/fast-plotting/src
git show feat/lab-web-stage1:packages/fast-plotting/src/host.ts > packages/fast-plotting/src/host.ts
git mv core/extensions/d1-fast-dashboard/src/FastChart.vue core/extensions/d1-fast-dashboard/src/FastDashboard.vue \
       core/extensions/d1-fast-dashboard/src/fastCache.ts core/extensions/d1-fast-dashboard/src/fastMeta.ts \
       packages/fast-plotting/src/
cp packages/force-plotting/tsconfig.json packages/fast-plotting/tsconfig.json
```

In `host.ts`, change the doc comment's last sentence about `apps/lab-web` to:
`(see apps/starbase/web, plan 2)`. The rest stays as on the branch.

`packages/fast-plotting/package.json`:

```json
{
  "name": "@d1/fast-plotting",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "description": "Shared FAST (sintering) plotting. Consumed from source by the Directus module and STARbase; no build step.",
  "main": "src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "vue-tsc --noEmit"
  },
  "dependencies": {
    "@d1/ui": "*",
    "axios": "^1.20.0",
    "vue": "^3.5.13",
    "vue-router": "^4.5.0"
  },
  "devDependencies": {
    "typescript": "^7.0.2",
    "vitest": "^4.1.10",
    "vue-tsc": "^2.2.0"
  }
}
```

`packages/fast-plotting/src/index.ts`:

```ts
export { default as FastDashboard } from './FastDashboard.vue';
export { default as FastChart } from './FastChart.vue';
export { resetFastHost, setFastHost, useFastHost, type FastHost } from './host';
export * from './fastCache';
export * from './fastMeta';
```

If `fastCache.ts` or `fastMeta.ts` has a default export, or a name clashes between them, export
the names explicitly instead. `npm run typecheck` will say.

- [ ] **Step 3: Point FastDashboard at the host**

In `packages/fast-plotting/src/FastDashboard.vue`:
- remove `import { useApi } from '@directus/extensions-sdk';` and the `recordRoute` import from
  `@d1/ui`;
- add `import { useFastHost } from './host';`;
- replace `const api = useApi();` with `const host = useFastHost(); const api = host.api;`;
- replace each `router.push(recordRoute('<collection>', <id>))` with
  `host.openRecord('<collection>', String(<id>))`. Remove `useRouter` if nothing else uses it,
  but keep `useRoute`, since `route.query.operation` still deep-links.
- apply `4595f7eb`: the trace-load `catch` becomes

```ts
	} catch (e: any) { console.error('FAST trace load failed', e); traceError.value = 'Could not load the trace for this run.'; }
```

The line may differ slightly from the branch's version. Find the `catch` that sets
`traceError.value`.

Check: `grep -n "extensions-sdk\|recordRoute\|useApi" packages/fast-plotting/src/*.vue packages/fast-plotting/src/*.ts`
Expected: no output.

- [ ] **Step 4: The Directus wrapper**

`core/extensions/d1-fast-dashboard/src/DirectusFastDashboard.vue`:

```vue
<script setup lang="ts">
import { useApi } from '@directus/extensions-sdk';
import { useRouter } from 'vue-router';
import { FastDashboard, setFastHost } from '@d1/fast-plotting';
import { recordRoute } from '@d1/ui';

// The Directus side of the FAST plotter's host contract; STARbase installs its own.
const api = useApi();
const router = useRouter();
setFastHost({ api, openRecord: (collection, id) => void router.push(recordRoute(collection, id)) });
</script>

<template>
	<FastDashboard />
</template>
```

In `core/extensions/d1-fast-dashboard/src/index.ts`, import `DirectusFastDashboard` from
`./DirectusFastDashboard.vue` instead of `FastDashboard`, and use it in `routes`.

In `core/extensions/d1-fast-dashboard/package.json` dependencies, add
`"@d1/fast-plotting": "*"`.

- [ ] **Step 5: Install, test, typecheck, build**

```bash
npm install
npm test -w @d1/fast-plotting
npm run typecheck -w @d1/fast-plotting
npm run build -w directus-extension-d1-fast-dashboard
```

Expected: 2 tests pass, the typecheck is clean, and the build writes
`core/extensions/d1-fast-dashboard/dist/index.js`.

- [ ] **Step 6: Wire CI**

- In `.github/scripts/ci-plan.mjs`, add `'packages/fast-plotting/'` to the `directusUi` list.
- In `.github/workflows/ci.yml`, in the `directus-ui` job's "@d1/ui: unit tests + typecheck"
  step, add these lines:

```yaml
          npm test -w @d1/fast-plotting
          npm run typecheck -w @d1/fast-plotting
```

Run: `node --test .github/scripts/ci-plan.test.mjs`
Expected: pass.

- [ ] **Step 7: Check in the preview**

Add `d1-fast-dashboard` to the overlay and run the FAST plotter once:

```bash
D1_PREVIEW_OVERLAY="d1-home d1-admin-overview d1-fast-dashboard" bash scripts/dev/explorer_preview.sh
```

Open `http://127.0.0.1:18055/admin/d1-fast-dashboard` signed in as the admin, pick a run, and
check that the trace draws and that a record link opens the operation's Explorer page. Prefer
`get_page_text` or one small screenshot.

- [ ] **Step 8: Commit**

```bash
git add packages/fast-plotting core/extensions/d1-fast-dashboard .github package-lock.json
git commit -m "refactor(fast): the FAST plotter as @d1/fast-plotting, Directus module as a thin host

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin HEAD:feat/explorer-standalone
```

---

### Task 5: Bring in main (gate)

Tasks 6-11 change `d1-home/src/explorerHost.ts`, `home/QuickActions.vue` and `@d1/ui`'s index.
`main` changed all three in U1 (Frequently used: `usagePing.ts`, `d1-usage`). The Labels PR
#247 has not taken those changes yet, and they conflict
(`core/README.md`, `d1-home/src/home/QuickActions.vue`, `packages/d1-ui/src/index.ts`).

- [ ] **Step 1: Check whether the Labels branch has taken main**

```bash
git fetch origin
git merge-base --is-ancestor origin/main origin/feat/label-printing && echo "labels has main" || echo "labels lacks main"
```

- **If it has main:** run `git merge origin/feat/label-printing`, then continue.
- **If #247 is merged into main:** run `git merge origin/main`, then `gh pr edit 250 --base main`.
- **Otherwise: STOP.** Report "Labels #247 needs main merged before the page move" to the
  maintainer. Do not resolve #247's conflicts on this branch, because they belong to #247.

- [ ] **Step 2: Re-run the harness on the merged code**

```bash
npm install
npm run build -w directus-extension-d1-home
bash scripts/dev/explorer_preview.sh --stop; bash scripts/dev/explorer_preview.sh
cd tests/ui && npx playwright test specs/13-explorer-routes.spec.ts --retries=0
```

Expected: 4 passed. Then push.

---

### Task 6: The host contract, widened, with a shared Directus host

**Files:**
- Modify: `packages/d1-ui/src/host.ts`
- Create: `packages/d1-ui/src/host.test.ts`
- Modify: `packages/d1-ui/src/index.ts` (export the new names)
- Create: `packages/directus-host/package.json`, `packages/directus-host/tsconfig.json`,
  `packages/directus-host/src/index.ts`
- Move: `core/extensions/d1-home/src/explorerHost.ts` → `packages/directus-host/src/directusHost.ts` (`git mv`, then edit)
- Modify: `core/extensions/d1-home/src/index.ts`, and every d1-home file that imports `./explorerHost` or `../explorerHost`
- Modify: `core/extensions/d1-campaign-ops/src/index.ts`, `core/extensions/d1-lab-dashboard/src/index.ts`, `core/extensions/d1-project-items/src/index.ts`, and the `package.json` of each (dependency `"@d1/directus-host": "*"`)

**Interfaces:**
- Produces in `@d1/ui`:

```ts
export interface HostRequestConfig { params?: Record<string, unknown>; timeout?: number; headers?: Record<string, string>; responseType?: 'json' | 'text' | 'blob' | 'arraybuffer' }
export interface HostResponse { data: any }
export interface HostApi {
	get(path: string, config?: HostRequestConfig): Promise<HostResponse>;
	post(path: string, body?: unknown, config?: HostRequestConfig): Promise<HostResponse>;
	patch(path: string, body?: unknown, config?: HostRequestConfig): Promise<HostResponse>;
	delete(path: string, config?: HostRequestConfig): Promise<HostResponse>;
}
export type HostField = Record<string, any> & { field: string };
export interface ExplorerHost {
	api: HostApi;
	navigate(to: string): void;
	openDataStudio(path: string): void;
	fieldsFor(collection: string): Promise<HostField[]>;
	isAdmin: Ref<boolean>;
	adminKnown: Ref<boolean>;
	user: Ref<{ id: string; first_name?: string; role?: string | null } | null>;
}
export function setExplorerHostFactory(factory: (() => ExplorerHost) | null): void;
export function useExplorerHost(): ExplorerHost; // throws '@d1/ui: no Explorer host …' if unset
```

- Produces in `@d1/directus-host`:
  - `useDirectusHost(): ExplorerHost`, the per-user cached host, today's `explorerHost.ts` logic.
  - `installDirectusHost(opts?: { onCreate?: (host: ExplorerHost, router: Router) => void }): void`,
    which calls `setExplorerHostFactory(() => useDirectusHost(opts))`.
- `onCreate` is how `d1-home` installs its usage pings once per signed-in user.

- [ ] **Step 1: Write the failing test**

`packages/d1-ui/src/host.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { ref } from 'vue';
import { setExplorerHostFactory, useExplorerHost, type ExplorerHost } from './host';

const fake = (): ExplorerHost => ({
	api: { get: async () => ({ data: {} }), post: async () => ({ data: {} }), patch: async () => ({ data: {} }), delete: async () => ({ data: {} }) },
	navigate: () => {},
	openDataStudio: () => {},
	fieldsFor: async () => [],
	isAdmin: ref(false),
	adminKnown: ref(true),
	user: ref(null),
});

describe('Explorer host factory', () => {
	afterEach(() => setExplorerHostFactory(null));

	it('throws a clear error when no host is installed', () => {
		expect(() => useExplorerHost()).toThrow(/no Explorer host/);
	});

	it('calls the installed factory each time (the host decides what to cache)', () => {
		let calls = 0;
		const host = fake();
		setExplorerHostFactory(() => (calls++, host));
		expect(useExplorerHost()).toBe(host);
		expect(useExplorerHost()).toBe(host);
		expect(calls).toBe(2);
	});
});
```

Run: `npm test -w @d1/ui -- host.test`
Expected: FAIL (`setExplorerHostFactory` is not exported).

- [ ] **Step 2: Implement `host.ts`**

Replace `packages/d1-ui/src/host.ts` with:

```ts
// What an Explorer page needs from whatever app hosts it: the Directus module today, STARbase too.
// Pages and the kit reach the host only through here (and links.ts), so the kit stays host-neutral:
// the noSdkImports guard keeps @directus/extensions-sdk out of every kit and page file.
import type { InjectionKey, Ref } from 'vue';

export interface HostRequestConfig {
	params?: Record<string, unknown>;
	timeout?: number;
	headers?: Record<string, string>;
	responseType?: 'json' | 'text' | 'blob' | 'arraybuffer';
}
export interface HostResponse {
	data: any;
}
// Axios-shaped on purpose: Directus's useApi() is axios, and so is STARbase's client, so a failed
// request rejects the same way in both (e.response.status, which errorText/isForbidden read).
export interface HostApi {
	get(path: string, config?: HostRequestConfig): Promise<HostResponse>;
	post(path: string, body?: unknown, config?: HostRequestConfig): Promise<HostResponse>;
	patch(path: string, body?: unknown, config?: HostRequestConfig): Promise<HostResponse>;
	delete(path: string, config?: HostRequestConfig): Promise<HostResponse>;
}
// One field definition as Directus describes it (GET /fields/<collection>, or the app's fields store).
export type HostField = Record<string, any> & { field: string };

export interface ExplorerHost {
	api: HostApi;
	// An app route in its Directus form, e.g. '/home/samples?bookmark=3' (see links.ts).
	navigate(to: string): void;
	// A Data Studio path, e.g. '/content/samples'.
	openDataStudio(path: string): void;
	// The collection's field definitions, sorted as Data Studio shows them.
	fieldsFor(collection: string): Promise<HostField[]>;
	// Starts as the host's best synchronous guess and is corrected when the server answers, so a page
	// that uses it must react to changes (watch it), not read it once.
	isAdmin: Ref<boolean>;
	// False until the server has answered (or failed to): while false, isAdmin may still be a guess.
	adminKnown: Ref<boolean>;
	user: Ref<{ id: string; first_name?: string; role?: string | null } | null>;
}

export const EXPLORER_HOST: InjectionKey<ExplorerHost> = Symbol('ExplorerHost');

// A module-level factory, like the plotters' setForceHost: each app installs one at start-up, and a
// page asks for the host in its setup. The factory decides what to cache (one host per signed-in user).
let factory: (() => ExplorerHost) | null = null;

export function setExplorerHostFactory(f: (() => ExplorerHost) | null): void {
	factory = f;
}

export function useExplorerHost(): ExplorerHost {
	if (!factory) throw new Error('@d1/ui: no Explorer host. The app must call setExplorerHostFactory() before rendering a page.');
	return factory();
}
```

In `packages/d1-ui/src/index.ts`, where `EXPLORER_HOST` is exported, export the new names too:
`setExplorerHostFactory`, `useExplorerHost`, `type HostApi`, `type HostField`,
`type HostRequestConfig`, `type HostResponse`.

Run: `npm test -w @d1/ui && npm run typecheck -w @d1/ui`
Expected: all pass. If an existing `ExplorerHost` literal in a test lacks the new members
(`fieldsFor`, or `post`/`patch`/`delete`), add them to that literal.

- [ ] **Step 3: Create `@d1/directus-host`**

```bash
mkdir -p packages/directus-host/src
git mv core/extensions/d1-home/src/explorerHost.ts packages/directus-host/src/directusHost.ts
cp packages/d1-ui/tsconfig.json packages/directus-host/tsconfig.json
```

`packages/directus-host/package.json`:

```json
{
  "name": "@d1/directus-host",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "description": "The Directus side of the Explorer host contract (@d1/ui host.ts), shared by every Directus extension that uses the kit.",
  "main": "src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "vue-tsc --noEmit"
  },
  "dependencies": {
    "@d1/ui": "*",
    "vue": "^3.5.13",
    "vue-router": "^4.5.0"
  },
  "devDependencies": {
    "@directus/extensions-sdk": "^17",
    "typescript": "^7.0.2",
    "vue-tsc": "^2.2.0"
  }
}
```

Edit `packages/directus-host/src/directusHost.ts`:
- rename the exported function `useExplorerHost` to `useDirectusHost` and give it a parameter
  `opts: { onCreate?: (host: ExplorerHost, router: Router) => void } = {}` (import `type Router`
  from `vue-router`);
- seed `user` from the store, so the first render is right: replace the `user` ref's initial
  value with

```ts
	const seed = userStore.currentUser;
	const user = ref<{ id: string; first_name?: string; role?: string | null } | null>(
		seed ? { id: seed.id, first_name: seed.first_name, role: typeof seed.role === 'object' ? seed.role?.id ?? null : seed.role ?? null } : null,
	);
```

- replace the line `installUsagePings(router, api);` (and its import) with
  `opts.onCreate?.(host, router);`, placed after `host` is built and before the line that caches
  it;
- add `fieldsFor` to the host object:

```ts
		fieldsFor: async (collection) => {
			const stores = useStores();
			if (typeof stores.useFieldsStore === 'function') {
				const defs = stores.useFieldsStore().getFieldsForCollectionSorted(collection);
				if (Array.isArray(defs) && defs.length) return defs as HostField[];
			}
			const { data } = await api.get(`/fields/${collection}`);
			return data.data as HostField[];
		},
```

  `useStores()` is called lazily inside `fieldsFor`, so it only runs from a page's setup or event
  handler, as today. If `useStores` must be called during setup, hoist `const stores = useStores();`
  next to the existing `useStores().useUserStore()` call and close over it.
- keep `api` as `useApi()` itself, not a wrapper, so errors and interceptors are unchanged.
  Type it with `const api = useApi() as unknown as HostApi;`.

`packages/directus-host/src/index.ts`:

```ts
import type { Router } from 'vue-router';
import { setExplorerHostFactory, type ExplorerHost } from '@d1/ui';
import { useDirectusHost } from './directusHost';

export { useDirectusHost };

// Call once at module scope in each Directus extension that renders kit components or pages.
export function installDirectusHost(opts: { onCreate?: (host: ExplorerHost, router: Router) => void } = {}): void {
	setExplorerHostFactory(() => useDirectusHost(opts));
}
```

- [ ] **Step 4: Install it in the four extensions**

- **`core/extensions/d1-home/src/index.ts`:** at the top (after imports), add:

```ts
import { installDirectusHost } from '@d1/directus-host';
import { installUsagePings } from './usagePing';

installDirectusHost({ onCreate: (host, router) => installUsagePings(router, host.api) });
```

- **Callers of the old import.** For every d1-home file that imported `useExplorerHost` from
  `./explorerHost` or `../explorerHost` (`home.vue`, `people.vue`, `register-sample.vue`,
  `pages/LabelsPage.vue`), change the import to `import { useExplorerHost } from '@d1/ui';`.
  `ExplorerView.vue` does the same: `provide(EXPLORER_HOST, useExplorerHost())`, now from `@d1/ui`.
- **The other three extensions.** In `d1-campaign-ops`, `d1-lab-dashboard` and `d1-project-items`,
  add to `src/index.ts` (module scope, before `export default`):

```ts
import { installDirectusHost } from '@d1/directus-host';

installDirectusHost();
```

  - Add `"@d1/directus-host": "*"` to the `dependencies` of `d1-home`, `d1-campaign-ops`,
    `d1-lab-dashboard` and `d1-project-items`.
  - If one of the three is not an npm workspace member (`d1-project-items` may build from its own
    lockfile), check the root `package.json` workspaces. If it is not a member, add it, the same
    way `d1-campaign-ops` is listed.

- [ ] **Step 5: Install, test, build, harness**

```bash
npm install
npm test -w @d1/ui && npm run typecheck -w @d1/ui && npm run typecheck -w @d1/directus-host
npm run build:extensions
npm run typecheck -w directus-extension-d1-home
D1_PREVIEW_OVERLAY="d1-home d1-admin-overview d1-fast-dashboard d1-campaign-ops d1-lab-dashboard d1-project-items" bash scripts/dev/explorer_preview.sh
cd tests/ui && npx playwright test specs/13-explorer-routes.spec.ts --retries=0
```

Expected: unit tests and typechecks pass, the builds succeed, and the harness has 4 passed.

Use this `D1_PREVIEW_OVERLAY` value from now on.

- [ ] **Step 6: CI and commit**

- Add `'packages/directus-host/'` to `directusUi` in `ci-plan.mjs`.
- Add `npm run typecheck -w @d1/directus-host` to the directus-ui job.
- Run `node --test .github/scripts/ci-plan.test.mjs`.

```bash
git add -A packages core/extensions .github package.json package-lock.json
git commit -m "refactor(ui): widen the Explorer host contract; @d1/directus-host shared by the kit's Directus extensions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin HEAD:feat/explorer-standalone
```

---

### Task 7: The link resolver and `AppLink`

**Files:**
- Create: `packages/d1-ui/src/links.ts`, `packages/d1-ui/src/links.test.ts`
- Create: `packages/d1-ui/src/components/AppLink.vue`
- Modify: `packages/d1-ui/src/index.ts` (exports)
- Modify: `core/extensions/d1-home/src/usagePing.ts` (`routeTarget(canonicalPath(...))`)
- Modify: `packages/d1-ui/src/nav/navState.ts`, `packages/d1-ui/src/nav/ExplorerNav.vue` (the `=== '/home'` checks)

**Interfaces:**
- Produces:

```ts
export type ResolvedLink = { kind: 'route'; to: string } | { kind: 'external'; href: string };
export interface LinkConfig { serverBase: string; resolve(path: string): ResolvedLink; canonical(routePath: string): string }
export const directusLinks: LinkConfig;
export function starbaseLinks(serverBase: string): LinkConfig;
export function configureLinks(config: LinkConfig): void;
export function resetLinks(): void;
export function resolveLink(path: string): ResolvedLink;
export function canonicalPath(routePath: string): string;
export function serverUrl(path: string): string;
export function assetUrl(fileId: string, query?: Record<string, string | number | boolean>): string;
// `router` is the host app's vue-router (only push/resolve are used), so a resolved route is never resolved twice.
export function openLink(path: string, router: { push(to: string): unknown }): void;
export function linkHref(path: string, router: { resolve(to: string): { href: string } }): string;
// component
AppLink: props { to: string }, default slot; renders <router-link> or <a target="_blank" rel="noopener">
```

- [ ] **Step 1: Write the failing tests**

`packages/d1-ui/src/links.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	assetUrl, canonicalPath, configureLinks, directusLinks, linkHref, openLink, resetLinks, resolveLink, serverUrl, starbaseLinks,
} from './links';

afterEach(() => resetLinks());

describe('the Directus host (the default)', () => {
	it('keeps every app path a route, as written', () => {
		for (const p of ['/home', '/home/samples/a%2Fb', '/home/samples?bookmark=3', '/content/materials/7', '/d1-force-dashboard?operation=9']) {
			expect(resolveLink(p)).toEqual({ kind: 'route', to: p });
		}
	});
	it('opens printable reports on the server, root-relative', () => {
		expect(resolveLink('/d1-report/sample/5')).toEqual({ kind: 'external', href: '/d1-report/sample/5' });
	});
	it('needs no canonicalisation and builds root-relative server URLs', () => {
		expect(canonicalPath('/home/samples/1?x=1')).toBe('/home/samples/1?x=1');
		expect(serverUrl('/d1-trace/sample/1')).toBe('/d1-trace/sample/1');
		expect(assetUrl('abc', { width: 64, fit: 'cover' })).toBe('/assets/abc?width=64&fit=cover');
		expect(assetUrl('abc', { download: '' })).toBe('/assets/abc?download=');
	});
	it('is what configureLinks is reset to', () => {
		configureLinks(starbaseLinks('https://d1.example'));
		resetLinks();
		expect(resolveLink('/home')).toEqual(directusLinks.resolve('/home'));
	});
});

describe('STARbase', () => {
	const D1 = 'https://d1-server.tail54eeb6.ts.net';
	const use = () => configureLinks(starbaseLinks(D1 + '/'));

	it('drops /home from its own pages, keeping query and encoding', () => {
		use();
		expect(resolveLink('/home')).toEqual({ kind: 'route', to: '/' });
		expect(resolveLink('/home?q=x')).toEqual({ kind: 'route', to: '/?q=x' });
		expect(resolveLink('/home/samples/a%2Fb')).toEqual({ kind: 'route', to: '/samples/a%2Fb' });
		expect(resolveLink('/home/samples?bookmark=3&open=k')).toEqual({ kind: 'route', to: '/samples?bookmark=3&open=k' });
	});
	it('maps the plot dashboards to its plot pages', () => {
		use();
		expect(resolveLink('/d1-force-dashboard?operation=9')).toEqual({ kind: 'route', to: '/plot/force?operation=9' });
		expect(resolveLink('/d1-fast-dashboard?operation=9')).toEqual({ kind: 'route', to: '/plot/fast?operation=9' });
		expect(resolveLink('/d1-force-dashboard')).toEqual({ kind: 'route', to: '/plot/force' });
	});
	it('sends everything else to d1-server', () => {
		use();
		expect(resolveLink('/content/materials/7')).toEqual({ kind: 'external', href: `${D1}/admin/content/materials/7` });
		expect(resolveLink('/d1-lab-dashboard/graph?sample=1')).toEqual({ kind: 'external', href: `${D1}/admin/d1-lab-dashboard/graph?sample=1` });
		expect(resolveLink('/d1-report/sample/5')).toEqual({ kind: 'external', href: `${D1}/d1-report/sample/5` });
		expect(resolveLink('/homework')).toEqual({ kind: 'external', href: `${D1}/admin/homework` });
	});
	it('turns its routes back into the Directus form', () => {
		use();
		expect(canonicalPath('/')).toBe('/home');
		expect(canonicalPath('/?q=x')).toBe('/home?q=x');
		expect(canonicalPath('/samples/a%2Fb')).toBe('/home/samples/a%2Fb');
		expect(canonicalPath('/samples?bookmark=3')).toBe('/home/samples?bookmark=3');
		expect(canonicalPath('/plot/force?operation=9')).toBe('/plot/force?operation=9');
	});
	it('round-trips every Explorer path', () => {
		use();
		for (const p of ['/home', '/home/samples/1', '/home/labels?ids=1,2', '/home/people']) {
			const r = resolveLink(p);
			expect(r.kind).toBe('route');
			if (r.kind === 'route') expect(canonicalPath(r.to)).toBe(p);
		}
	});
	it('builds server URLs on d1-server', () => {
		use();
		expect(serverUrl('/d1-trace/sample/1')).toBe(`${D1}/d1-trace/sample/1`);
		expect(assetUrl('f 1', { download: '' })).toBe(`${D1}/assets/f%201?download=`);
	});
});

describe('openLink / linkHref', () => {
	it('pushes routes and opens external links in a new tab', () => {
		const push = vi.fn();
		const open = vi.spyOn(window, 'open').mockImplementation(() => null);
		openLink('/home/samples/1', { push });
		expect(push).toHaveBeenCalledWith('/home/samples/1');
		openLink('/d1-report/sample/1', { push });
		expect(open).toHaveBeenCalledWith('/d1-report/sample/1', '_blank', 'noopener');
		open.mockRestore();
	});
	it('gives a route its router href and an external link its own href', () => {
		const router = { resolve: (to: string) => ({ href: `/admin${to}` }) };
		expect(linkHref('/home/samples/1', router)).toBe('/admin/home/samples/1');
		expect(linkHref('/d1-report/x', router)).toBe('/d1-report/x');
	});
});
```

The `window.open` case needs a DOM. If `@d1/ui`'s vitest has no DOM environment, put
`// @vitest-environment happy-dom` at the top of the file if `happy-dom` is already a dev
dependency anywhere in the workspace (`npm ls happy-dom jsdom`). Otherwise, replace the spy with
a stubbed global: `vi.stubGlobal('window', { open: vi.fn() })` and `vi.unstubAllGlobals()`
afterwards.

Run: `npm test -w @d1/ui -- links.test`
Expected: FAIL (module not found).

- [ ] **Step 2: Implement `links.ts`**

```ts
// Every link a page makes is written as a path of the Directus app (whose root is /admin):
// '/home/samples/<id>', '/content/<collection>/<id>', '/d1-force-dashboard?operation=<id>',
// '/d1-report/sample/<id>'. The host decides what each one means. In the Directus module they are
// routes as written (reports open on the server). In STARbase '/home/…' is its own route without
// the prefix, the two plot dashboards are its plot pages, and everything else opens d1-server in a
// new tab. Pages never build URLs any other way, so there is one place to change per host.

export type ResolvedLink = { kind: 'route'; to: string } | { kind: 'external'; href: string };

export interface LinkConfig {
	// Prefix for URLs of server routes a page builds itself (assets, printable reports): '' when the
	// page is served by Directus (same origin), the d1-server origin in STARbase.
	serverBase: string;
	resolve(path: string): ResolvedLink;
	// The inverse, for code that reasons about the current route (usage pings, the nav's "you are
	// here"): this host's route path back to its Directus form, e.g. '/samples/1' → '/home/samples/1'.
	canonical(routePath: string): string;
}

const REPORT = /^\/d1-report\//;

export const directusLinks: LinkConfig = {
	serverBase: '',
	resolve: (path) => (REPORT.test(path) ? { kind: 'external', href: path } : { kind: 'route', to: path }),
	canonical: (routePath) => routePath,
};

const PLOTS: [string, string][] = [
	['/d1-force-dashboard', '/plot/force'],
	['/d1-fast-dashboard', '/plot/fast'],
];

function startsWithSegment(path: string, prefix: string): boolean {
	return path === prefix || path.startsWith(prefix + '/') || path.startsWith(prefix + '?');
}

export function starbaseLinks(serverBase: string): LinkConfig {
	const base = serverBase.replace(/\/+$/, '');
	return {
		serverBase: base,
		resolve(path) {
			if (startsWithSegment(path, '/home')) {
				const rest = path.slice('/home'.length);
				return { kind: 'route', to: rest.startsWith('/') ? rest : '/' + rest };
			}
			for (const [from, to] of PLOTS) {
				if (startsWithSegment(path, from)) return { kind: 'route', to: to + path.slice(from.length) };
			}
			if (REPORT.test(path)) return { kind: 'external', href: base + path };
			return { kind: 'external', href: `${base}/admin${path}` };
		},
		canonical(routePath) {
			if (startsWithSegment(routePath, '/plot')) return routePath;
			return routePath === '/' || routePath.startsWith('/?') ? '/home' + routePath.slice(1) : '/home' + routePath;
		},
	};
}

let config: LinkConfig = directusLinks;

export function configureLinks(c: LinkConfig): void {
	config = c;
}

export function resetLinks(): void {
	config = directusLinks;
}

export const resolveLink = (path: string): ResolvedLink => config.resolve(path);
export const canonicalPath = (routePath: string): string => config.canonical(routePath);
export const serverUrl = (path: string): string => config.serverBase + path;

export function assetUrl(fileId: string, query: Record<string, string | number | boolean> = {}): string {
	const q = Object.entries(query)
		.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
		.join('&');
	return serverUrl(`/assets/${encodeURIComponent(fileId)}${q ? `?${q}` : ''}`);
}

// Follow a link from code: a route goes through the host's router, anything else opens in a new tab.
// Takes the router itself (not a push callback) so a resolved route goes straight to the router and is
// never resolved a second time (host.navigate resolves; this must not go through it).
export function openLink(path: string, router: { push(to: string): unknown }): void {
	const r = resolveLink(path);
	if (r.kind === 'route') void router.push(r.to);
	else window.open(r.href, '_blank', 'noopener');
}

// The href to show for a link (e.g. for "open in new tab"): the router's href for a route.
export function linkHref(path: string, router: { resolve(to: string): { href: string } }): string {
	const r = resolveLink(path);
	return r.kind === 'route' ? router.resolve(r.to).href : r.href;
}
```

Check `'/home?q=x'` against `startsWithSegment`: `rest = '?q=x'`, so the route is `'/?q=x'`.

- [ ] **Step 3: `AppLink.vue`**

`packages/d1-ui/src/components/AppLink.vue`:

```vue
<script setup lang="ts">
import { computed } from 'vue';
import { resolveLink } from '../links';

// A link written as a Directus app path (see links.ts): a router-link when it is a route of this
// host, a new-tab <a> when it is not. Attributes (class, title, @click.stop) fall through to either.
const props = defineProps<{ to: string }>();
const link = computed(() => resolveLink(props.to));
</script>

<template>
	<router-link v-if="link.kind === 'route'" :to="link.to"><slot /></router-link>
	<a v-else :href="link.href" target="_blank" rel="noopener"><slot /></a>
</template>
```

Export `AppLink` and every `links.ts` name from `packages/d1-ui/src/index.ts`.

- [ ] **Step 4: Make the "you are here" checks and the usage pings host-neutral**

- `packages/d1-ui/src/nav/navState.ts` (line ~54) and `packages/d1-ui/src/nav/ExplorerNav.vue`
  (lines ~45, ~83): wherever the code compares `route.path` (or a path argument) with `'/home'`
  or tests `startsWith('/home')`, compare `canonicalPath(route.path)` instead. Import
  `canonicalPath` from `../links`.
- `core/extensions/d1-home/src/usagePing.ts`: in the router hook, change
  `routeTarget(to.fullPath)` to `routeTarget(canonicalPath(to.fullPath))`. Do the same for the
  immediate ping of the current route. Import `canonicalPath` from `@d1/ui`.
- Add to `links.test.ts`:

```ts
import { routeTarget } from './usage';

describe('usage pings agree across hosts', () => {
	it('a STARbase route canonicalises to the same target as the Directus one', () => {
		const id = '3f2b8a1c-0000-4000-8000-000000000001';
		const directus = routeTarget(`/home/samples/${id}`);
		configureLinks(starbaseLinks('https://d1.example'));
		expect(routeTarget(canonicalPath(`/samples/${id}`))).toEqual(directus);
		expect(routeTarget(canonicalPath('/samples'))).toEqual(routeTarget('/home/samples'));
	});
});
```

- [ ] **Step 5: Run**

```bash
npm test -w @d1/ui && npm run typecheck -w @d1/ui
npm run build -w directus-extension-d1-home
bash scripts/dev/explorer_preview.sh --stop; D1_PREVIEW_OVERLAY="d1-home d1-admin-overview d1-fast-dashboard d1-campaign-ops d1-lab-dashboard d1-project-items" bash scripts/dev/explorer_preview.sh
cd tests/ui && npx playwright test specs/13-explorer-routes.spec.ts --retries=0
```

Expected: all pass, and the harness has 4 passed.

- [ ] **Step 6: Commit**

```bash
git add -A packages/d1-ui core/extensions/d1-home
git commit -m "feat(ui): link resolver and AppLink, so each host decides what an app path means

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin HEAD:feat/explorer-standalone
```

---

### Task 8: Take the kit off the Directus SDK, and guard it

**Files:**
- Modify: `packages/d1-ui/src/composables/useItems.ts`, `useCanUpdate.ts`, `useFieldDefs.ts`
- Modify: `packages/d1-ui/src/campaign/OperationsPanel.vue`, `SamplesPanel.vue`, `TestsPanel.vue`
- Modify: `packages/d1-ui/src/components/EditDrawer.vue`
- Modify: `packages/d1-ui/src/index/thumbs.ts` (line 61), `packages/d1-ui/src/nav/NavPanel.vue` (line ~26), `packages/d1-ui/src/index/IndexPage.vue` (`rowHref` ~127, the `router.push` in `useIndexPage.ts` ~239)
- Modify: every `<router-link` in `packages/d1-ui/src` and the `<component :is="... 'router-link' ...">` in `RecordCard.vue` and `StatTile.vue`
- Modify: `packages/d1-ui/src/noSdkImports.test.ts`
- Modify: `packages/d1-ui/package.json` (move `@directus/extensions-sdk` out of devDependencies)

**Interfaces:**
- Consumes: `useExplorerHost` (Task 6); `AppLink`, `assetUrl`, `linkHref` and `openLink`
  (Task 7).
- Produces: a kit with no SDK in it. Exported signatures stay the same (`useItems()`,
  `useCanUpdate(collection, id)`, `useFieldDefs()`, `EditDrawer` props and emits).

- [ ] **Step 1: Extend the guard first (it fails today)**

Replace the first `describe` in `packages/d1-ui/src/noSdkImports.test.ts` with:

```ts
// The whole kit is host-neutral: STARbase renders it outside Directus. Directus is reached only
// through the host (host.ts) and links go through links.ts / AppLink.
describe('the kit stays host-neutral', () => {
	const files = sources(here).filter((f) => !f.endsWith('.test.ts'));
	const rel = (f: string) => f.slice(here.length + 1).replace(/\\/g, '/');

	it('finds the files it is meant to check', () => {
		expect(files.some((f) => f.endsWith('navConfig.ts'))).toBe(true);
		expect(files.some((f) => f.endsWith('EditDrawer.vue'))).toBe(true);
	});

	it('does not use the Directus extensions SDK', () => {
		for (const f of files) {
			const src = readFileSync(f, 'utf8');
			expect(src, rel(f)).not.toContain(FORBIDDEN);
			expect(src, rel(f)).not.toMatch(/\buse(Api|Stores)\(/);
		}
	});

	it('builds links and asset URLs only through links.ts', () => {
		const allowed = ['links.ts', 'components/AppLink.vue'];
		for (const f of files.filter((f) => !allowed.includes(rel(f)))) {
			const src = readFileSync(f, 'utf8');
			expect(src, rel(f)).not.toMatch(/<router-link\b|['"`]router-link['"`]/);
			expect(src, rel(f)).not.toMatch(/['"`]\/assets\//);
			expect(src, rel(f)).not.toMatch(/window\.open\(/);
		}
	});
});
```

Run: `npm test -w @d1/ui -- noSdkImports`
Expected: FAIL, listing `useItems.ts`, `EditDrawer.vue`, `thumbs.ts`, the `router-link` users and
so on.

- [ ] **Step 2: Data access through the host**

- **`useItems.ts`:** replace the SDK import and `const api = useApi();` with
  `import { useExplorerHost } from '../host';` and `const api = useExplorerHost().api;`.
- **`useCanUpdate.ts`:** use `createCanUpdate(useExplorerHost().api, collection, id)`. If
  `createCanUpdate`'s first parameter type is narrower or different, widen it to `HostApi` (or
  `Pick<HostApi, 'get'>`).
- **`useFieldDefs.ts`:**

```ts
import { useExplorerHost } from '../host';
import type { ParamFieldDef } from '../params';

// The field definitions of a collection (labels, units, conditions) as the signed-in user's app sees
// them; the host knows where they come from (the Directus app's fields store, or GET /fields).
export function useFieldDefs() {
	const host = useExplorerHost();
	async function getFieldDefs(collection: string): Promise<ParamFieldDef[]> {
		return (await host.fieldsFor(collection)) as unknown as ParamFieldDef[];
	}
	return { getFieldDefs };
}
```

- **The three campaign panels:** replace `import { useApi } from '@directus/extensions-sdk';`
  with `import { useExplorerHost } from '../host';`, and `const api = useApi();` with
  `const api = useExplorerHost().api;`.
- **`EditDrawer.vue`:**
  - replace `useApi()` with `useExplorerHost().api`;
  - replace the fields-store read with the host: `fields` becomes a `ref<HostField[]>([])` filled
    in `load()` by `formFields(await host.fieldsFor(props.collection), item.value, props.hiddenFields)`;
  - `formAvailable` becomes `typeof resolveComponent('v-form') !== 'string'` (no store check);
  - the fallback that pushes `dataStudioRoute(...)` becomes
    `host.openDataStudio(dataStudioRoute(props.collection, props.primaryKey))`, and the
    `useRouter` import goes if nothing else uses it.
  - Keep all other behaviour: the version check, `buildPatch`, the discard dialog.

- [ ] **Step 3: Links and asset URLs through `links.ts`**

- **`index/thumbs.ts` line 61:**
  `return assetUrl(id, { width: w, height: h, fit: 'cover', format: 'webp' });`, with `assetUrl`
  imported from `../links`. The existing thumbs tests must still pass. In the Directus host,
  `assetUrl` gives exactly the old string.
- **`nav/NavPanel.vue` `newTabHref`:** replace the `/d1-report/` special case and
  `router.resolve(to).href` with `linkHref(to, router)`.
- **`index/IndexPage.vue` `rowHref`:** use `linkHref(target, router)` in the same way. **`index/useIndexPage.ts` ~239:** when the target is a page URL, use
  `openLink(target, router)`. A `router.replace` of the index's own query stays as
  it is, because that is a route of the current page.
- **Every `<router-link …>` in `packages/d1-ui/src`:** change it to `<AppLink …>` and
  `</router-link>` to `</AppLink>`, and import `AppLink` from the right relative path
  (`../components/AppLink.vue` or `./AppLink.vue`).
  - Keep `:to`, classes and `@click.stop`. Attributes fall through.
  - If a `router-link` uses `custom` or `v-slot="{ navigate, href }"`, leave it as `router-link`,
    but compute its `to` with `resolveLink(...)`. In that case, add the file to the `allowed` list
    in the guard with a comment saying why.
- **`RecordCard.vue` and `StatTile.vue`:** replace `:is="to ? 'router-link' : 'div'"` with
  `:is="to ? AppLink : 'div'"` (import `AppLink`).

- [ ] **Step 4: Remove the SDK from `@d1/ui`'s dependencies**

In `packages/d1-ui/package.json`, delete `"@directus/extensions-sdk"` from `devDependencies`.
Then run `npm install`.

- [ ] **Step 5: Run everything**

```bash
npm test -w @d1/ui && npm run typecheck -w @d1/ui
npm run build:extensions
bash scripts/dev/explorer_preview.sh --stop; D1_PREVIEW_OVERLAY="d1-home d1-admin-overview d1-fast-dashboard d1-campaign-ops d1-lab-dashboard d1-project-items" bash scripts/dev/explorer_preview.sh
cd tests/ui && npx playwright test specs/13-explorer-routes.spec.ts --retries=0
```

Expected: the guard passes, every test passes, and the harness has 4 passed. Also open one
record page in the preview, click **Edit**, change nothing, and close it. The Directus form must
still open in the drawer. Use `get_page_text` to confirm the drawer title.

- [ ] **Step 6: Commit**

```bash
git add -A packages/d1-ui package-lock.json
git commit -m "refactor(ui): the kit reaches Directus only through the host and links

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin HEAD:feat/explorer-standalone
```

---

### Task 9: Move the pages into `@d1/starbase-pages` (moves and import paths only)

A pure move, so `git log --follow` keeps each file's history and a reviewer can check it at a
glance. No behaviour changes in this commit.

**Files:**
- Create: `packages/starbase-pages/package.json`, `packages/starbase-pages/tsconfig.json`, `packages/starbase-pages/src/index.ts`
- Move: everything in `core/extensions/d1-home/src` **except** `index.ts` into `packages/starbase-pages/src/`, keeping sub-folders
- Modify: `core/extensions/d1-home/src/index.ts` (imports from `@d1/starbase-pages`), `core/extensions/d1-home/package.json`

**Interfaces:**
- Produces: `@d1/starbase-pages`, which exports every page component the module's routes use
  (same names as today's imports in `index.ts`), plus `usagePing.ts`'s `installUsagePings` and
  `pingVisit`.

- [ ] **Step 1: Move**

```bash
mkdir -p packages/starbase-pages/src
cd core/extensions/d1-home/src
for f in $(ls -A | grep -v '^index.ts$'); do git mv "$f" ../../../../packages/starbase-pages/src/; done
cd -
cp packages/d1-ui/tsconfig.json packages/starbase-pages/tsconfig.json
```

`packages/starbase-pages/package.json`:

```json
{
  "name": "@d1/starbase-pages",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "description": "STARbase's pages (Home, index and record pages, task screens). Host-neutral; mounted by the Directus Home module and by apps/starbase/web.",
  "main": "src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "test": "vitest run --passWithNoTests",
    "typecheck": "vue-tsc --noEmit"
  },
  "dependencies": {
    "@d1/ui": "*",
    "qrcode": "^1.5.4",
    "vue": "^3.5.13",
    "vue-router": "^4.5.0"
  },
  "devDependencies": {
    "@types/qrcode": "*",
    "typescript": "^7.0.2",
    "vitest": "^4.1.10",
    "vue-tsc": "^2.2.0"
  }
}
```

Copy `@types/qrcode`'s exact version range from `core/extensions/d1-home/package.json` in place
of `*`. Remove `qrcode` and `@types/qrcode` from d1-home's package.json. Add
`"@d1/starbase-pages": "*"` to d1-home's dependencies.

`packages/starbase-pages/src/index.ts`:

```ts
export { default as HomeView } from './home.vue';
export { default as RegisterSample } from './register-sample.vue';
export { default as PeopleView } from './people.vue';
export { default as SamplePage } from './pages/SamplePage.vue';
export { default as CampaignPage } from './pages/CampaignPage.vue';
export { default as ProjectsIndex } from './pages/ProjectsIndex.vue';
export { default as ProjectPage } from './pages/ProjectPage.vue';
export { default as OperationPage } from './pages/OperationPage.vue';
export { default as TestPage } from './pages/TestPage.vue';
export { default as LabelsPage } from './pages/LabelsPage.vue';
export { default as IndexRoute } from './pages/IndexRoute.vue';
export { installUsagePings, pingVisit } from './usagePing';
```

Match the list to the components `d1-home/src/index.ts` actually imports. Add any that are
missing.

- [ ] **Step 2: Point `d1-home/src/index.ts` at the package**

Replace its page imports with one
`import { HomeView, RegisterSample, … } from '@d1/starbase-pages';`, and its `./usagePing` import
with `import { installUsagePings } from '@d1/starbase-pages';`. Leave the routes array as it is.

- [ ] **Step 3: Install, typecheck, build, harness**

```bash
npm install
npm run typecheck -w @d1/starbase-pages
npm run typecheck -w directus-extension-d1-home
npm run build -w directus-extension-d1-home
bash scripts/dev/explorer_preview.sh --stop; D1_PREVIEW_OVERLAY="d1-home d1-admin-overview d1-fast-dashboard d1-campaign-ops d1-lab-dashboard d1-project-items" bash scripts/dev/explorer_preview.sh
cd tests/ui && npx playwright test specs/13-explorer-routes.spec.ts --retries=0
```

Expected: typechecks pass, and the harness has 4 passed. If relative imports broke (e.g. a page
importing `../geometry`), the moved tree kept its shape, so they should not. Fix only the import
paths that the typecheck names.

- [ ] **Step 4: CI and commit**

- Add `'packages/starbase-pages/'` to `directusUi` in `ci-plan.mjs`.
- Add `npm test -w @d1/starbase-pages` and `npm run typecheck -w @d1/starbase-pages` to the
  directus-ui job.
- Run `node --test .github/scripts/ci-plan.test.mjs`.

```bash
git add -A packages/starbase-pages core/extensions/d1-home .github package.json package-lock.json
git commit -m "refactor(home): move the Explorer pages into @d1/starbase-pages (moves and import paths only)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin HEAD:feat/explorer-standalone
```

---

### Task 10: Take the moved pages off the Directus SDK and root-relative URLs

**Files:** (paths under `packages/starbase-pages/src/`)
- Modify: `home.vue`, `register-sample.vue`, `people.vue`, `pages/ProjectsIndex.vue`, `home/LabStats.vue`, `home/NeedsAttention.vue`, `home/RecentActivity.vue`, `home/useAdminOverview.ts`, `home/goto.ts`, `home/QuickActions.vue`, `home/MyWork.vue`, `home/AdminPanels.vue`, `labels/useLabelSamples.ts`, `labels/useLabelTemplates.ts`, `labels/useTemplateSave.ts`, `pages/sample/useSampleData.ts`, `pages/sample/SampleFiles.vue`, `pages/SamplePage.vue`, `pages/OperationPage.vue`, `pages/TestPage.vue`, `pages/ProjectPage.vue`, `pages/CampaignPage.vue`, `pages/IndexRoute.vue`, `pages/LabelsPage.vue`, plus every other file that `<router-link>`s or `window.open`s (the guard lists them)
- Create: `packages/starbase-pages/src/hostNeutral.test.ts`

**Interfaces:**
- Consumes: `useExplorerHost` (`api`, `user`, `navigate`, `openDataStudio`), `AppLink`,
  `assetUrl` and `openLink`.

- [ ] **Step 1: The guard (it fails now)**

`packages/starbase-pages/src/hostNeutral.test.ts`:

```ts
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// STARbase's pages run in two hosts (the Directus Home module and apps/starbase/web): they reach
// Directus only through the Explorer host and build links only through @d1/ui's links.ts / AppLink.
const here = dirname(fileURLToPath(import.meta.url));
const sources = (p: string): string[] =>
	statSync(p).isFile() ? (/\.(ts|vue)$/.test(p) && !p.endsWith('.test.ts') ? [p] : []) : readdirSync(p).flatMap((n) => sources(join(p, n)));
const files = sources(here);
const rel = (f: string) => f.slice(here.length + 1).replace(/\\/g, '/');

describe('STARbase pages stay host-neutral', () => {
	it('finds the pages', () => {
		expect(files.some((f) => f.endsWith('SamplePage.vue'))).toBe(true);
	});
	it('do not use the Directus extensions SDK', () => {
		for (const f of files) {
			const src = readFileSync(f, 'utf8');
			expect(src, rel(f)).not.toContain('@directus/extensions-sdk');
			expect(src, rel(f)).not.toMatch(/\buse(Api|Stores)\(/);
		}
	});
	it('build links and asset URLs only through @d1/ui', () => {
		for (const f of files) {
			const src = readFileSync(f, 'utf8');
			expect(src, rel(f)).not.toMatch(/<router-link\b|['"`]router-link['"`]/);
			expect(src, rel(f)).not.toMatch(/['"`]\/assets\//);
			expect(src, rel(f)).not.toMatch(/window\.open\(/);
			expect(src, rel(f)).not.toMatch(/\brouter\.push\(/);
		}
	});
});
```

The `printFrame.ts` print iframe is not a link, so it does not use `window.open`. If it did, the
test would name it. In that case, add an explicit `if (rel(f) === 'labels/printFrame.ts') continue;`
with a comment.

Run: `npm test -w @d1/starbase-pages`
Expected: FAIL, listing the files below.

- [ ] **Step 2: Data access**

For each file that uses `useApi()`:
- replace `import { useApi … } from '@directus/extensions-sdk';` with
  `import { useExplorerHost } from '@d1/ui';`;
- replace `const api = useApi();` with `const api = useExplorerHost().api;`.

The calls stay as they are (`api.get/post/patch/delete` with the same paths). The files are
`register-sample.vue`, `people.vue`, `home/LabStats.vue`, `home/NeedsAttention.vue`,
`home/RecentActivity.vue`, `home/useAdminOverview.ts`, `labels/useLabelSamples.ts`,
`labels/useLabelTemplates.ts`, `labels/useTemplateSave.ts` and `pages/sample/useSampleData.ts`.

For each file that uses `useStores().useUserStore().currentUser`, use the host's `user` instead
(`const host = useExplorerHost();`):
- **`home.vue`:** the greeting reads `host.user.value?.first_name`.
- **`register-sample.vue`:** the person lookup reads `host.user.value?.id`.
  - If it runs at setup before `user` is known, `watch(() => host.user.value?.id, …, { immediate: true })`
    and do the lookup when it becomes non-null.
- **`pages/ProjectsIndex.vue`:** the role filter reads `host.user.value?.id` inside its computed,
  so the computed reacts when the user arrives.

- [ ] **Step 3: Navigation and links**

- **`router.push(x)` → `host.navigate(x)`**, where `x` is an app path. The sites are
  `people.vue:16`, `register-sample.vue:159` and `home/goto.ts`. In the Directus host,
  `navigate` is `router.push`, so behaviour is unchanged. STARbase's `navigate` resolves the
  path (plan 2).
- **`home/goto.ts`:** the function becomes:

```ts
import { openLink } from '@d1/ui';
import type { Router } from 'vue-router';

// Follow a Home tile's link: a page of this app, or (reports, Data Studio) a new tab.
export function go(router: Router, to: string): void {
	openLink(to, router);
}
```

  Keep its existing signature. If callers pass something other than `(router, to)`, keep that
  shape.
- **`window.open(\`/d1-report/…\`, '_blank', 'noopener')` → `openLink(\`/d1-report/…\`, router)`**,
  with `const router = useRouter()` from vue-router. Never pass `host.navigate`, because it
  resolves the path a second time. The sites are
  `OperationPage.vue:75`, `SamplePage.vue:63`, `TestPage.vue:64` and `register-sample.vue:160`.
- **Every `<router-link>` in the moved pages becomes `<AppLink>`**, imported from `@d1/ui`.
  - This includes the `/home` crumbs, `MyWork.vue`'s `/home/projects` and `/home/people`,
    `SamplePage.vue`'s lineage-graph link, the `SampleRecords.vue` analysis links and
    `AdminPanels.vue`'s `/d1-force-crawler`, `/files` and `/files/<id>`.
  - `v-button :to="…"` stays as it is in this task. In the Directus host `v-button :to` is a
    router link, and the paths it gets are already Directus paths. Plan 2's STARbase `VButton`
    stand-in resolves `to` through `resolveLink`. This avoids rewriting every button now.
- **`pages/sample/SampleFiles.vue:53`:** `:href="assetUrl(f.id, { download: '' })"`, with
  `assetUrl` imported from `@d1/ui`.

  The old URL was `/assets/<id>?download`. The new one is `/assets/<id>?download=`, which
  Directus treats the same way. Check it once in the preview by downloading a file from a sample
  with files.

- [ ] **Step 4: Run everything**

```bash
npm test -w @d1/starbase-pages && npm run typecheck -w @d1/starbase-pages
npm test -w @d1/ui
npm run build -w directus-extension-d1-home
bash scripts/dev/explorer_preview.sh --stop; D1_PREVIEW_OVERLAY="d1-home d1-admin-overview d1-fast-dashboard d1-campaign-ops d1-lab-dashboard d1-project-items" bash scripts/dev/explorer_preview.sh
cd tests/ui && npx playwright test specs/13-explorer-routes.spec.ts --retries=0
```

Expected: the guard and all tests pass, and the harness has 4 passed. In the preview, also:
- click **Register sample** through to the success screen on the copy (a copy, so this is
  allowed), and open its report link (a new tab to `/d1-report/sample/<id>`);
- open the People page and the Labels page.

- [ ] **Step 5: Commit**

```bash
git add -A packages/starbase-pages
git commit -m "refactor(starbase-pages): pages reach Directus only through the host and links

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin HEAD:feat/explorer-standalone
```

---

### Task 11: The page frame, the route table and a thin Directus host

**Files:**
- Create: `packages/starbase-pages/src/frame.ts`, `packages/starbase-pages/src/frame.test.ts`, `packages/starbase-pages/src/routes.ts`, `packages/starbase-pages/src/routes.test.ts`
- Modify: `packages/starbase-pages/src/ExplorerView.vue` (renders the installed frame)
- Create: `core/extensions/d1-home/src/DirectusFrame.vue` (today's `ExplorerView.vue` template: `private-view`, nav, finder, Ctrl+K)
- Create: `packages/d1-ui/src/finder/useFinderShortcut.ts` (+ test)
- Modify: `core/extensions/d1-home/src/index.ts`, `packages/starbase-pages/src/index.ts`

**Interfaces:**
- Produces:
  - `setPageFrame(component: Component | null)` and `usePageFrame(): Component` (throws
    `'@d1/starbase-pages: no page frame …'` if unset).
  - `starbaseRoutes: RouteRecordRaw[]`, with paths relative to the host's mount point
    (`''`, `'register-sample'`, …, `':slug'` last).
  - `useFinderShortcut(): { finderOpen: Ref<boolean>; openFinder(): void; closeFinder(): void }`
    in `@d1/ui`.
- Plan 2's STARbase shell uses `starbaseRoutes`, `setPageFrame` and `useFinderShortcut`.

- [ ] **Step 1: Failing tests**

`packages/starbase-pages/src/frame.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { defineComponent } from 'vue';
import { setPageFrame, usePageFrame } from './frame';

describe('page frame', () => {
	afterEach(() => setPageFrame(null));
	it('throws a clear error when the host installed none', () => {
		expect(() => usePageFrame()).toThrow(/no page frame/);
	});
	it('returns the installed frame', () => {
		const Frame = defineComponent({ name: 'Frame', template: '<div><slot /></div>' });
		setPageFrame(Frame);
		expect(usePageFrame()).toBe(Frame);
	});
});
```

`packages/starbase-pages/src/routes.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { starbaseRoutes } from './routes';

describe('starbaseRoutes', () => {
	const paths = starbaseRoutes.map((r) => r.path);
	it('has every page of the Home module', () => {
		for (const p of ['', 'register-sample', 'people', 'projects', 'projects/:id', 'campaigns/:id', 'samples/:id', 'operations/:id', 'tests/:id', 'labels', ':slug']) {
			expect(paths).toContain(p);
		}
	});
	it('puts the catch-all index route last, so static paths win', () => {
		expect(paths[paths.length - 1]).toBe(':slug');
	});
	it('uses relative paths, so each host mounts them where it wants', () => {
		for (const p of paths) expect(p.startsWith('/')).toBe(false);
	});
});
```

`packages/d1-ui/src/finder/useFinderShortcut.test.ts`: test the pure part. Extract the
`keydown` decision into
`shouldOpenFinder(e: KeyboardEvent-like, finderOpen: boolean, doc: Document-like): boolean` in
`finder/finder.ts`, next to `isFinderShortcut`. Cover these cases:
- Ctrl+K, finder closed, no modal: true;
- finder already open: false;
- a modal open (`isModalOpen` true): false;
- a plain `k` press: false.

Reuse how the existing `isFinderShortcut`/`isModalOpen` tests build their fake events and
documents (`finder/*.test.ts`).

Run: `npm test -w @d1/starbase-pages && npm test -w @d1/ui -- finder`
Expected: FAIL.

- [ ] **Step 2: Implement**

`packages/starbase-pages/src/frame.ts`:

```ts
import type { Component } from 'vue';

// The chrome around a page, installed by the host: in the Directus module, Directus's <private-view>
// with the Explorer nav in its navigation slot; in STARbase, its own shell's content area. A page
// renders <ExplorerView :title> and gets whichever is installed.
let frame: Component | null = null;

export function setPageFrame(c: Component | null): void {
	frame = c;
}

export function usePageFrame(): Component {
	if (!frame) throw new Error('@d1/starbase-pages: no page frame. The app must call setPageFrame() before rendering a page.');
	return frame;
}
```

`packages/starbase-pages/src/routes.ts`: today's `routes` array from
`core/extensions/d1-home/src/index.ts`, verbatim, typed `RouteRecordRaw[]`, importing the page
components relatively:

```ts
import type { RouteRecordRaw } from 'vue-router';
import HomeView from './home.vue';
import RegisterSample from './register-sample.vue';
import PeopleView from './people.vue';
import SamplePage from './pages/SamplePage.vue';
import CampaignPage from './pages/CampaignPage.vue';
import ProjectsIndex from './pages/ProjectsIndex.vue';
import ProjectPage from './pages/ProjectPage.vue';
import OperationPage from './pages/OperationPage.vue';
import TestPage from './pages/TestPage.vue';
import LabelsPage from './pages/LabelsPage.vue';
import IndexRoute from './pages/IndexRoute.vue';

// Every STARbase page, relative to where the host mounts them: the Directus module at /home, the
// standalone app at /. The catch-all index route stays last (vue-router ranks static paths first anyway).
export const starbaseRoutes: RouteRecordRaw[] = [
	{ path: '', component: HomeView },
	{ path: 'register-sample', component: RegisterSample },
	{ path: 'people', component: PeopleView },
	{ path: 'projects', component: ProjectsIndex },
	{ path: 'projects/:id', component: ProjectPage, props: true },
	{ path: 'campaigns/:id', component: CampaignPage, props: true },
	{ path: 'samples/:id', component: SamplePage, props: true },
	{ path: 'operations/:id', component: OperationPage, props: true },
	{ path: 'tests/:id', component: TestPage, props: true },
	{ path: 'labels', component: LabelsPage },
	{ path: ':slug', component: IndexRoute, props: true },
];
```

If `index.ts` on the merged branch has more routes (U1 or Labels added one), copy them all in
the same order.

`packages/starbase-pages/src/ExplorerView.vue` (replace its content):

```vue
<script setup lang="ts">
import { provide } from 'vue';
import { EXPLORER_HOST, useExplorerHost } from '@d1/ui';
import { usePageFrame } from './frame';

// Every page renders inside this: it hands the page's slots to the host's frame and provides the
// host to the kit components that inject it (nav, finder, index page).
defineProps<{ title: string }>();
provide(EXPLORER_HOST, useExplorerHost());
const Frame = usePageFrame();
</script>

<template>
	<component :is="Frame" :title="title">
		<template v-for="(_, name) in $slots" :key="name" #[name]="slotProps"><slot :name="name" v-bind="slotProps || {}" /></template>
	</component>
</template>
```

`packages/d1-ui/src/finder/useFinderShortcut.ts`:

```ts
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { shouldOpenFinder } from './finder';

// Ctrl/Cmd+K opens the finder, unless it is already open or a dialog is in front. Each host's frame
// uses this next to <ExplorerNav> and <Finder>.
export function useFinderShortcut() {
	const finderOpen = ref(false);
	const onKey = (e: KeyboardEvent) => {
		if (!shouldOpenFinder(e, finderOpen.value, document)) return;
		e.preventDefault();
		finderOpen.value = true;
	};
	onMounted(() => window.addEventListener('keydown', onKey));
	onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
	return { finderOpen, openFinder: () => void (finderOpen.value = true), closeFinder: () => void (finderOpen.value = false) };
}
```

`shouldOpenFinder` in `finder/finder.ts` holds exactly today's decision from `ExplorerView.vue`.
That is: an `isFinderShortcut(e)` press, the finder not already open, and no modal open per
`isModalOpen(document, '#dialog-outlet > *, [role="dialog"][aria-modal="true"]:not(.d1-finder)')`.
Keep the `preventDefault` behaviour identical to today's: today it calls `preventDefault()` for
every finder shortcut, even when it then ignores the press. So call `e.preventDefault()` when
`isFinderShortcut(e)` is true, before the other checks. Export `useFinderShortcut` and
`shouldOpenFinder` from `@d1/ui`.

`core/extensions/d1-home/src/DirectusFrame.vue`:

```vue
<script setup lang="ts">
import { ExplorerNav, Finder, useFinderShortcut } from '@d1/ui';

// The Directus side of the page frame: Directus's own <private-view> with the Explorer nav and the
// finder in its navigation slot. STARbase installs its own shell instead.
defineProps<{ title: string }>();
const { finderOpen, openFinder, closeFinder } = useFinderShortcut();
</script>

<template>
	<private-view :title="title">
		<template #navigation>
			<ExplorerNav :show-brand="false" style="--d1-nav-offset: 54px" @open-finder="openFinder" />
			<Finder v-if="finderOpen" @close="closeFinder" />
		</template>
		<template v-for="(_, name) in $slots" :key="name" #[name]="slotProps"><slot :name="name" v-bind="slotProps || {}" /></template>
	</private-view>
</template>
```

`core/extensions/d1-home/src/index.ts` (whole file):

```ts
import { defineModule } from '@directus/extensions-sdk';
import { installDirectusHost } from '@d1/directus-host';
import { installUsagePings, setPageFrame, starbaseRoutes } from '@d1/starbase-pages';
import DirectusFrame from './DirectusFrame.vue';

// The Directus Home module: the STARbase pages (@d1/starbase-pages) inside Data Studio, mounted at
// /home. The standalone STARbase app mounts the same routes at / with its own host and frame.
installDirectusHost({ onCreate: (host, router) => installUsagePings(router, host.api) });
setPageFrame(DirectusFrame);

export default defineModule({
	id: 'home',
	name: 'Home',
	icon: 'cottage',
	routes: starbaseRoutes,
});
```

In `packages/starbase-pages/src/index.ts`, add:
- `export { setPageFrame, usePageFrame } from './frame';`
- `export { starbaseRoutes } from './routes';`
- `export { default as ExplorerView } from './ExplorerView.vue';`

The `HomeView`, … exports stay.

- [ ] **Step 3: Run everything**

```bash
npm test -w @d1/starbase-pages && npm run typecheck -w @d1/starbase-pages
npm test -w @d1/ui && npm run typecheck -w @d1/ui
npm run build:extensions
npm run typecheck -w directus-extension-d1-home
bash scripts/dev/explorer_preview.sh --stop; D1_PREVIEW_OVERLAY="d1-home d1-admin-overview d1-fast-dashboard d1-campaign-ops d1-lab-dashboard d1-project-items" bash scripts/dev/explorer_preview.sh
cd tests/ui && npx playwright test specs/13-explorer-routes.spec.ts --retries=0
```

Expected: everything passes, and the harness has 4 passed. In the preview, press Ctrl+K on a
record page (the finder opens), then Esc (it closes). Press Ctrl+K with the Edit drawer open:
nothing happens.

- [ ] **Step 4: Commit and hand over**

```bash
git add -A packages core/extensions/d1-home
git commit -m "refactor(starbase-pages): page frame and route table; d1-home is a thin Directus host

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin HEAD:feat/explorer-standalone
bash scripts/dev/explorer_preview.sh --stop
```

Then run the final whole-branch review (Opus), and report to the maintainer that plan 1 is done.
Plan 2 (the STARbase app) is detailed next, from the step-0 results.
