# STARbase, plan 2: the app

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `apps/starbase/web` serves the STARbase pages at `https://starbase.tail54eeb6.ts.net`, in
parallel with the Directus Home module. It has its own sign-in page on Directus's shared session,
its own sidebar, the STAR branding, the Force and FAST plotters as pages, editing through a framed
Directus form, and a phone layout. Deployment files are written but not run.

**Architecture:**
- STARbase is a static Vite + Vue 3 app. It calls d1-server directly with `withCredentials`, so
  the browser sends Directus's `directus_session_token` cookie, the same one Data Studio uses
  (ADR-0013, spec §9). There is no token in STARbase.
- It plugs into plan 1's three seams:
  - `setExplorerHostFactory`, with a STARbase `ExplorerHost` over its axios client;
  - `configureLinks(starbaseLinks(directusUrl))`;
  - `setPageFrame(PlainFrame)`.
- It registers small stand-ins for the Directus global components the pages use.
- Editing opens d1-server's new form-only module page (`/admin/d1-edit/<collection>/<id>`) in a
  dialog. That page talks back through `postMessage`, and a new tab is the fallback.
- The plotters get cookie-variant `ForceHost` and `FastHost` implementations.

**Tech Stack:**
- Vue 3.5, vue-router 4.6, Vite 6.4, TypeScript 7, vitest 4, axios 1.20, `material-symbols`;
- Directus 11 module and endpoint extensions;
- Playwright (`tests/ui`), Caddy 2, `tailscale/tailscale` (containerboot), FastAPI (CORS).

**Spec:** `docs/superpowers/specs/2026-10-12-starbase-standalone-design.md`.
- Read §3 to §5 first, then §8 (errata) and §9 (step-0 results).
- Also read ADR-0013 and the glossary in `CONTEXT.md`.
- Builds on plan 1 (`docs/superpowers/plans/2026-10-12-starbase-1-foundations.md`), which is
  executed. Its interfaces exist on the branch.

## Global Constraints

- **Where.** Work in the worktree
  `D:\Users\CMBE Admn 3214022001\Documents\GitHub\D1-Database\.claude\worktrees\explorer-standalone`
  (git-bash: `/d/Users/CMBE Admn 3214022001/Documents/GitHub/D1-Database/.claude/worktrees/explorer-standalone`),
  on branch `feat/explorer-standalone`, which has draft PR #250 to `main`. Never commit to `main`.
- **Nothing touches live:**
  - no `docker compose` against the `d1-database` project, no `tailscale` command, no live Directus write;
  - the only compose calls allowed are parse-only `docker compose ... config` runs: Task 11's test
    (project name `d1-starbase-check`) and `tests/phase0_smoke.sh`;
  - Task 11's `caddy validate` run and its throwaway `d1-starbase-caddy-check` container (Step 7)
    start no service of the stack.
- **Previews:**
  - Only `D1_PREVIEW_NAME=d1-starbase D1_PREVIEW_PORT=18057`. Another session runs the default
    preview (`d1-preview`, port 18055), and nothing here may start, stop or overwrite it.
  - Task 0 must be done before any preview is started.
  - `--stop` is always run with the same two variables set.
  - Credentials are in `.superpowers/preview-credentials-d1-starbase.txt`.
- **Deployment is written, never run.** Task 11 writes:
  - the compose service under the `starbase` profile;
  - the Caddy `:8090` site;
  - `infra/tailscale/starbase-serve.json`;
  - the environment variables;
  - `docs/runbooks/starbase.md`.

  The live rollout is the maintainer's: runbook steps 1-5, each approved separately.
- **The Directus Home module keeps working unchanged.**
  - After any change under `packages/d1-ui`, `packages/starbase-pages` or `core/extensions/d1-home`,
    run the **Directus regression run** written out in that task.
  - That run is the plan 1 route harness (`tests/ui/specs/13-explorer-routes.spec.ts`) against the
    `d1-starbase` preview, and it must report `4 passed`.
- **Tests.** Run the tests and typecheck of every workspace you touch before each commit
  (`npm test -w <name>`, `npm run typecheck -w <name>`). Every change ships with a test that was
  actually run.
- **Commits and pushes.** Commit messages end with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Push after each task with
  `git push origin HEAD:feat/explorer-standalone`, never with force.
- **CI is wired in the task that creates each workspace.** That means the root `workspaces` and
  scripts, `.github/scripts/ci-plan.mjs` with `ci-plan.test.mjs`, the `directus-ui` job in
  `.github/workflows/ci.yml`, and `.claude/skills/ci-local/scripts/plan_checks.sh`.
- **Branding.** The name is written **STARbase**.
  - The logos are copied from `G:\Shared drives\STAR Group\Logos & Templates\Logos\STAR Logo\SVGs`
    into `apps/starbase/web/public/brand/`:
    - `Star-logo-transparent.svg` has dark text, for the light theme;
    - `Star-logo-transparent-light.svg` has light text, for the dark theme;
    - `Star-Icon.svg` is the favicon and the rail mark.
  - The accent is the Explorer's: the theme primary `#18222F`. That is the project colour read from
    the preview copy's `directus_settings`, with Color Match as the light theme and Directus Default as
    the dark one.
- **No Bearer token, anywhere.** STARbase never stores a token, and every request it makes carries
  the session cookie.
- **Ports.**
  - STARbase is on `127.0.0.1:5190`, for both `vite` and `vite preview`.
  - The two-hostname test layout uses `https://starbase.tail54eeb6.ts.net:5191` and
    `https://d1-server.tail54eeb6.ts.net:18443`.
- **Names used across tasks are exact:**
  - app modules: `resolveConfig`, `loadRuntimeConfig`, `getConfig`, `createApi`, `refreshSession`,
    `sessionAlive`, `installSessionGuard`, `SessionGuard`, `createSession`, `Session`, `safeNext`,
    `guardDecision`, `homeRedirect`, `createStarbaseHost`, `installStarbaseHost`, `useApp`, `APP`,
    `registerStandins`, `PlainFrame`, `buildRoutes`, `createStarbaseRouter`, `createEditor`,
    `createBrowserEditor`, `EditorDialog`, `starbaseForceHost`, `starbaseFastHost`, `plotRoutes`,
    `useNarrow`, `starbaseCsp`;
  - kit names in `@d1/ui`: `editFrameUrl`, `parentOriginFrom`, `readEditMessage`, `editMessage`,
    `NEW_ITEM_ID`, `createFormFields`, `editMode`, `ExplorerHost.openEditor`, `starbaseUrlFor`,
    `starbaseUrlOnce`, `setPhoneListDefault`, `defaultListPrefs`, `readSavedListPrefs`,
    `PHONE_LIST_MAX_WIDTH`;
  - the CSS variable `--d1-header-offset`.
- **Visual checks.** Use the Browser pane (`preview_start` with a `url`) and prefer `get_page_text`
  or `read_page`. Take at most one small screenshot per check.

## Review Focus

1. **Signed out elsewhere** (Data Studio sign-out, ended session): Directus answers the next request as the public role, **403 not 401**, and STARbase must go to `/signin?next=<page>`, while a live session's 403 stays the page's message. Tests: `api.test.ts` (Task 2), e2e (Task 12).
2. **Untrusted `next`** (`//evil`, `https://…`, `/\evil`, `/signin…`, repeated): lands on `/`; a real deep link (`/samples/a%2Fb?x=1`, a QR code) comes back unchanged through password and SSO sign-in. Tests: `session.test.ts`, `guard.test.ts` (Task 2), e2e (Task 12).
3. **The edit frame never says ready** (signed out in the frame, CSP refused, slow server): after 8 s the dialog offers a new tab, which refreshes the record on return; a blocked pop-up says so. Tests: `editor.test.ts` (Task 7), e2e (Task 12).
4. **A stray or forged `postMessage`** (other origin, other window, other record, malformed): ignored, the dialog unchanged. Tests: `editFrame.test.ts` (Task 6), `editor.test.ts` (Task 7).
5. **d1-server unreachable** (network error, timeout, 5xx at boot): a full-page "Can't reach the database" with Retry, never a spinner or a bounce to `/signin`. Tests: `session.test.ts`, `api.test.ts` (Task 2), the check in Task 5 Step 7.

## Decisions this plan makes (the spec does not settle them)

- **Plot pages ping as their dashboards.**
  - `starbaseLinks().canonical('/plot/force?…')` returns `/d1-force-dashboard?…` (and the same for
    FAST), the inverse of `resolve`.
  - Usage pings and the nav's "you are here" then agree across hosts.
  - Plan 1's `links.test.ts` line that kept `/plot/…` unchanged is updated in Task 3.
- **Sticky offset.**
  - The five record pages write `--d1-sticky-top: var(--d1-header-offset, 70px)`.
  - The Directus frame leaves the variable unset (70px, as today), and STARbase's `PlainFrame` sets
    it to its own header height.
- **Session renewal.**
  - On a 401, or a 403 whose `/users/me` probe also fails, STARbase posts `/auth/refresh` with
    `mode: 'session'` once (shared by concurrent failures), then retries.
  - A refusal there means signed out.
  - The Force plotter's `refreshAuth` goes through the same path.
  - This widens spec §3.5 ("re-checks `/users/me`"). A session-mode cookie whose access token has
    lapsed answers 401 although the session lives. Task 2 Step 7 measures this on the preview.
- **`/config.json` in production** is answered by Caddy from `D1_SERVER_ORIGIN`. There is no file
  in `dist/`, so the URL lives in one place, which is also where the CSP takes it from.
- **The frame learns STARbase's origin from `?parent=`.**
  - The frame posts only to that exact origin, and only when it is a valid http(s) origin.
  - Directus's `frame-ancestors` already limits who can frame the page. A forged `parent` only sends
    `{saved, collection, id}` to a window that opened the tab itself.
- **Fallback promise.**
  - In new-tab mode, `openEditor` resolves with the tab's own message when one arrives.
  - Otherwise it resolves `'saved'` on the next focus of the STARbase window, or when the user clicks
    Done.
  - So the spec's two values hold, and the page refetches.
- **`/content/<collection>/+` links** (New project, the quick actions) stay Data Studio links in a
  new tab. The frame page supports `+` for create, but routing those links into the dialog is left
  for later.
- **Stand-in tests** render with `vue/server-renderer` and test pure helpers. The workspace has no
  DOM environment, and adding one for markup checks is not worth a new dependency. Interaction is
  covered by the e2e in Task 12.
- **Phone cards default** is a STARbase-only switch (`setPhoneListDefault(true)`), so the Directus
  host keeps its table at every width. The default is never written to storage.
- **The star mark** (`Star-Icon.svg`) is the favicon and the mark in the phone top bar. The desktop
  sidebar shows the full logo above the Explorer rail. The rail itself (`@d1/ui` `NavRail`) has no
  brand slot, and giving it one would change the Directus module too.
- **Two more tasks than the outline.** Task 0 (per-name preview files) must run before any preview
  starts, and the edit frame is split at the Directus/STARbase seam (Tasks 6 and 7) so each side
  gets its own review gate.

## Files (what each new unit is for)

```
apps/starbase/web/
  package.json, vite.config.ts, tsconfig.json, index.html, public/brand/*.svg
  src/main.ts                 boot: config, api, session, router, host, stand-ins, mount
  src/config.ts               d1-server URLs (VITE_* then /config.json)
  src/api.ts                  axios with credentials + the session guard (401/403 → refresh/sign-in)
  src/session.ts              who is signed in; sign-in/out; providers; safeNext; error texts
  src/guard.ts                router guard decision; /home/… redirect
  src/host.ts                 the STARbase ExplorerHost (+ links, usage pings)
  src/context.ts              provide/inject of api, session, guard, editor
  src/router.ts               /signin, /signin/done, /home redirect, '/' shell with plot + starbaseRoutes
  src/App.vue, AppShell.vue, PlainFrame.vue, BrandLogo.vue
  src/pages/SignInPage.vue, SignInDone.vue, UnreachablePage.vue
  src/standins/*              v-* stand-ins, the tooltip directive, registerStandins
  src/theme.css, styles.css   --theme--* values (light/dark), base styles
  src/editor/*                the edit dialog (frame, ready timeout, new-tab fallback)
  src/plot/*                  /plot/force, /plot/fast, their hosts, the phone note
  src/narrow.ts               phone width
  src/csp.ts                  the CSP (Caddy and vite preview send the same)
packages/d1-ui/src/editFrame.ts           the frame's message protocol (both sides)
core/extensions/d1-edit-frame/            the form-only Directus module page
core/extensions/d1-links/                 GET /d1-links → { starbaseUrl }
infra/tailscale/starbase-serve.json       tailscale serve: 443 → proxy:8090
docs/runbooks/starbase.md                 the maintainer's rollout
tests/ui/starbase/                        preview env files, the two-hostname helper, test targets
tests/ui/specs/14-starbase.spec.ts        STARbase end-to-end
```

---

### Task 0: Give each preview its own files (before any preview starts)

`scripts/dev/explorer_preview.sh` keeps its credentials, its merged extensions folder and an HTTP
response file at fixed paths. On every start it runs `rm -rf` on the extensions folder, and its
`--stop` deletes the credentials. Another session's preview (`d1-preview` on 18055) has that folder
bind-mounted right now. Started under another name, the script would wipe it, so the paths must
depend on the name.

**Files:**
- Modify: `scripts/dev/explorer_preview.sh` (the variable block after `PUBLIC=…`, the two
  `.superpowers/preview-resp.json` uses, the header comment)
- Create: `scripts/dev/explorer_preview_isolation.test.sh`

**Interfaces:**
- Produces, for `D1_PREVIEW_NAME=d1-starbase`:
  - `.superpowers/preview-credentials-d1-starbase.txt` (same format: `url=`, `admin=`, `member=`);
  - `.superpowers/preview-extensions-d1-starbase/`;
  - `.superpowers/preview-resp-d1-starbase.json`.
- The default name keeps today's paths.

- [ ] **Step 1: Write the check (it fails today)**

`scripts/dev/explorer_preview_isolation.test.sh`:

```bash
#!/usr/bin/env bash
# Two previews (two sessions) must never touch each other's files: every per-preview path depends
# on D1_PREVIEW_NAME, and the default name keeps today's paths. Starts nothing.
set -euo pipefail
cd "$(dirname "$0")/../.."
S=scripts/dev/explorer_preview.sh
bash -n "$S"
fail() { echo "FAIL: $1"; exit 1; }
grep -qF 'if [[ "$NAME" == d1-preview ]]; then SUFFIX=""; else SUFFIX="-$NAME"; fi' "$S" || fail "no per-name suffix"
grep -qF 'CREDS=.superpowers/preview-credentials${SUFFIX}.txt' "$S" || fail "credentials path is not per name"
grep -qF 'EXT_DIR=.superpowers/preview-extensions${SUFFIX}' "$S" || fail "extensions path is not per name"
grep -qF 'RESP=.superpowers/preview-resp${SUFFIX}.json' "$S" || fail "response path is not per name"
if grep -qF '.superpowers/preview-resp.json' "$S"; then fail "a fixed response path is left"; fi
if grep -qE '^CREDS=\.superpowers/preview-credentials\.txt$' "$S"; then fail "a fixed credentials path is left"; fi
echo "preview isolation: ok"
```

Run: `bash scripts/dev/explorer_preview_isolation.test.sh`
Expected: `FAIL: no per-name suffix`, with a non-zero exit.

- [ ] **Step 2: Implement**

In `scripts/dev/explorer_preview.sh`:

- Replace the two lines `CREDS=.superpowers/preview-credentials.txt` and
  `EXT_DIR=.superpowers/preview-extensions` with:

```bash
# Files of ONE preview. The default name keeps the old paths; any other name gets its own, so a second
# preview (another session) never deletes or overwrites the first one's credentials or its mounted
# extensions folder (start clears EXT_DIR, --stop removes CREDS and EXT_DIR).
if [[ "$NAME" == d1-preview ]]; then SUFFIX=""; else SUFFIX="-$NAME"; fi
CREDS=.superpowers/preview-credentials${SUFFIX}.txt
EXT_DIR=.superpowers/preview-extensions${SUFFIX}
RESP=.superpowers/preview-resp${SUFFIX}.json
```

- In the password loop, replace both `.superpowers/preview-resp.json` with `"$RESP"`. The `curl -o`
  becomes `-o "$RESP"`, and the `abort` argument becomes `"$(cat "$RESP" 2>/dev/null)"`.
- In the header comment, under `Options (environment):`, add:

```bash
#   D1_PREVIEW_NAME=<name>         container/network prefix (default d1-preview); any other name also gets
#                                  its own credentials file .superpowers/preview-credentials-<name>.txt
#   D1_PREVIEW_PORT=<port>         published port (default 18055)
```

- [ ] **Step 3: Run the check**

Run: `bash scripts/dev/explorer_preview_isolation.test.sh`
Expected: `preview isolation: ok`

- [ ] **Step 4: Run it for real once, and prove the default preview is untouched**

```bash
ls -l --time-style=+%s .superpowers/preview-credentials.txt 2>/dev/null | awk '{print $6}' > .superpowers/default-creds.mtime || true
npm run build -w directus-extension-d1-home
D1_PREVIEW_NAME=d1-starbase D1_PREVIEW_PORT=18057 bash scripts/dev/explorer_preview.sh
test -s .superpowers/preview-credentials-d1-starbase.txt && grep -q '^url=http://127.0.0.1:18057/admin$' .superpowers/preview-credentials-d1-starbase.txt && echo "own creds: ok"
diff <(ls -l --time-style=+%s .superpowers/preview-credentials.txt 2>/dev/null | awk '{print $6}') .superpowers/default-creds.mtime && echo "default creds untouched"
docker ps --format '{{.Names}}' | grep -E '^d1-(preview|starbase)-directus$'
D1_PREVIEW_NAME=d1-starbase D1_PREVIEW_PORT=18057 bash scripts/dev/explorer_preview.sh --stop
```

Expected:
- `own creds: ok`;
- `default creds untouched`;
- both `d1-preview-directus` (the other session's, if it is running) and `d1-starbase-directus`
  are listed before the stop;
- after the stop, `d1-preview-directus` is still running if it was before.

- [ ] **Step 5: Commit**

```bash
git add scripts/dev/explorer_preview.sh scripts/dev/explorer_preview_isolation.test.sh
git commit -m "chore(preview): per-name credentials and extensions folder, so two previews never clash

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin HEAD:feat/explorer-standalone
```

---

### Task 1: App scaffold, runtime config, branding files and CI

**Files:**
- Create: `apps/starbase/web/package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`
- Create: `apps/starbase/web/src/env.d.ts`, `src/main.ts`, `src/config.ts`, `src/config.test.ts`
- Create (copied): `apps/starbase/web/public/brand/Star-logo-transparent.svg`, `Star-logo-transparent-light.svg`, `Star-Icon.svg`
- Modify: `package.json` (root: `workspaces`, `scripts`)
- Modify: `.github/scripts/ci-plan.mjs` (`directusUi`), `.github/scripts/ci-plan.test.mjs`
- Modify: `.github/workflows/ci.yml` (the `directus-ui` job)
- Modify: `.claude/skills/ci-local/scripts/plan_checks.sh` (the directus-ui line)

**Interfaces:**
- Produces:

```ts
export interface StarbaseConfig { directusUrl: string; filterUrl: string; diagUrl: string; octreeUrl: string }
export type ConfigEnv = Partial<Record<'VITE_DIRECTUS_URL' | 'VITE_FILTER_URL' | 'VITE_DIAG_URL' | 'VITE_OCTREE_URL', string>>;
export const DEFAULT_DIRECTUS_URL = 'https://d1-server.tail54eeb6.ts.net';
export function resolveConfig(env: ConfigEnv, runtime: Partial<StarbaseConfig> | null): StarbaseConfig;
export function loadRuntimeConfig(fetchImpl?: typeof fetch): Promise<StarbaseConfig>;
export function getConfig(): Readonly<StarbaseConfig>;
```

- The workspace is `starbase-web`, and the root gets the `build:starbase` script.

- [ ] **Step 1: The workspace files**

`apps/starbase/web/package.json`:

```json
{
  "name": "starbase-web",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "description": "STARbase: the STAR group's web app (Home, index and record pages, task screens, plotters), standalone on Directus's shared session (ADR-0013).",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "typecheck": "vue-tsc --noEmit"
  },
  "dependencies": {
    "@d1/fast-plotting": "*",
    "@d1/force-plotting": "*",
    "@d1/starbase-pages": "*",
    "@d1/ui": "*",
    "axios": "^1.20.0",
    "material-symbols": "^0.47.6",
    "vue": "^3.5.13",
    "vue-router": "^4.5.0"
  },
  "devDependencies": {
    "@vitejs/plugin-vue": "^5.2.1",
    "typescript": "^7.0.2",
    "vite": "^6.0.7",
    "vitest": "^4.1.10",
    "vue-tsc": "^2.2.0"
  }
}
```

`apps/starbase/web/vite.config.ts`:

```ts
import { defineConfig } from 'vite';
import { configDefaults } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

// STARbase is served at the root of its own origin (https://starbase.<tailnet>.ts.net), in development
// and in production alike, so base is '/'. 127.0.0.1 and not localhost: the preview Directus is reached
// at 127.0.0.1 too, so the session cookie is same-site in development (spec §5).
export default defineConfig({
	base: '/',
	plugins: [vue()],
	server: { host: '127.0.0.1', port: 5190, strictPort: true },
	preview: { host: '127.0.0.1', port: 5190, strictPort: true },
	test: { exclude: [...configDefaults.exclude, 'e2e/**'] },
});
```

`apps/starbase/web/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "module": "ESNext",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "preserve",
    "strict": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src/**/*.ts", "src/**/*.d.ts", "src/**/*.vue"]
}
```

`apps/starbase/web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <link rel="icon" type="image/svg+xml" href="/brand/Star-Icon.svg" />
    <title>STARbase</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

`apps/starbase/web/src/env.d.ts`:

```ts
/// <reference types="vite/client" />

interface ImportMetaEnv {
	readonly VITE_DIRECTUS_URL?: string;
	readonly VITE_FILTER_URL?: string;
	readonly VITE_DIAG_URL?: string;
	readonly VITE_OCTREE_URL?: string;
}
interface ImportMeta {
	readonly env: ImportMetaEnv;
}

declare module '*.vue' {
	import type { DefineComponent } from 'vue';
	const component: DefineComponent<{}, {}, any>;
	export default component;
}
```

The logos:

```bash
mkdir -p apps/starbase/web/public/brand
SRC="/g/Shared drives/STAR Group/Logos & Templates/Logos/STAR Logo/SVGs"
cp "$SRC/Star-logo-transparent.svg" "$SRC/Star-logo-transparent-light.svg" "$SRC/Star-Icon.svg" apps/starbase/web/public/brand/
ls apps/starbase/web/public/brand
```

Expected: the three files. Open each one and check that it is a plain SVG: no `<script>` and no
external `href`. Run `grep -lE '<script|href="http' apps/starbase/web/public/brand/*.svg`, which
should print nothing.

- [ ] **Step 2: Write the failing config test**

`apps/starbase/web/src/config.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_DIRECTUS_URL, getConfig, loadRuntimeConfig, resolveConfig, type ConfigEnv } from './config';

const D1 = DEFAULT_DIRECTUS_URL;

describe('resolveConfig', () => {
	it('defaults to d1-server and the sidecars at their paths on it', () => {
		expect(resolveConfig({}, null)).toEqual({
			directusUrl: D1, filterUrl: `${D1}/filter`, diagUrl: `${D1}/diag`, octreeUrl: `${D1}/octrees`,
		});
	});
	it('derives the sidecars from a directusUrl alone (production config.json is just that)', () => {
		expect(resolveConfig({}, { directusUrl: 'https://d1.example/' })).toEqual({
			directusUrl: 'https://d1.example', filterUrl: 'https://d1.example/filter', diagUrl: 'https://d1.example/diag', octreeUrl: 'https://d1.example/octrees',
		});
	});
	it('runtime beats build time, an explicit sidecar beats the derived one, trailing slashes go', () => {
		const env: ConfigEnv = { VITE_DIRECTUS_URL: 'http://127.0.0.1:18057', VITE_FILTER_URL: 'http://127.0.0.1:8000/' };
		expect(resolveConfig(env, null).filterUrl).toBe('http://127.0.0.1:8000');
		expect(resolveConfig(env, { directusUrl: 'https://d1.example' }).directusUrl).toBe('https://d1.example');
		expect(resolveConfig(env, { octreeUrl: 'https://o.example//' }).octreeUrl).toBe('https://o.example');
	});
	it('blank values count as unset', () => {
		expect(resolveConfig({ VITE_DIRECTUS_URL: '  ' }, { directusUrl: '' }).directusUrl).toBe(D1);
	});
});

describe('loadRuntimeConfig', () => {
	it('applies /config.json, fetched without the cache', async () => {
		const f = vi.fn(async () => ({ ok: true, json: async () => ({ directusUrl: 'https://d1.example/' }) }));
		await loadRuntimeConfig(f as unknown as typeof fetch);
		expect(f).toHaveBeenCalledWith('/config.json', { cache: 'no-store' });
		expect(getConfig().directusUrl).toBe('https://d1.example');
		expect(getConfig().diagUrl).toBe('https://d1.example/diag');
	});
	it('keeps the build-time values when the file is missing, broken or unreachable', async () => {
		const buildTime = resolveConfig(import.meta.env as ConfigEnv, null);
		await loadRuntimeConfig((async () => ({ ok: false })) as unknown as typeof fetch);
		expect(getConfig()).toEqual(buildTime);
		await loadRuntimeConfig((async () => ({ ok: true, json: async () => 'nope' })) as unknown as typeof fetch);
		expect(getConfig()).toEqual(buildTime);
		await loadRuntimeConfig((async () => { throw new TypeError('offline'); }) as unknown as typeof fetch);
		expect(getConfig()).toEqual(buildTime);
	});
});
```

Run: `npm install && npm test -w starbase-web`
Expected: FAIL. `./config` cannot be resolved.

- [ ] **Step 3: Implement `config.ts` and a placeholder `main.ts`**

`apps/starbase/web/src/config.ts`:

```ts
// Where STARbase finds d1-server. STARbase is a static bundle on its own origin, and every call goes to
// d1-server directly with the Directus session cookie (spec §3, ADR-0013). There are two sources, and the
// later one wins: build-time VITE_* variables (development: VITE_DIRECTUS_URL=http://127.0.0.1:18057),
// then /config.json at boot (production: Caddy answers it from D1_SERVER_ORIGIN, infra/caddy/Caddyfile).
// The sidecars default to their paths on the Directus origin, so a config of just { directusUrl } is complete.

export interface StarbaseConfig {
	directusUrl: string;
	filterUrl: string;
	diagUrl: string;
	octreeUrl: string;
}
export type ConfigEnv = Partial<Record<'VITE_DIRECTUS_URL' | 'VITE_FILTER_URL' | 'VITE_DIAG_URL' | 'VITE_OCTREE_URL', string>>;

export const DEFAULT_DIRECTUS_URL = 'https://d1-server.tail54eeb6.ts.net';

const strip = (s: string): string => s.trim().replace(/\/+$/, '');
// The first value that is a non-blank string, without its trailing slashes.
function pick(...values: unknown[]): string | undefined {
	for (const v of values) if (typeof v === 'string' && strip(v) !== '') return strip(v);
	return undefined;
}

export function resolveConfig(env: ConfigEnv, runtime: Partial<StarbaseConfig> | null): StarbaseConfig {
	const directusUrl = pick(runtime?.directusUrl, env.VITE_DIRECTUS_URL) ?? DEFAULT_DIRECTUS_URL;
	return {
		directusUrl,
		filterUrl: pick(runtime?.filterUrl, env.VITE_FILTER_URL) ?? `${directusUrl}/filter`,
		diagUrl: pick(runtime?.diagUrl, env.VITE_DIAG_URL) ?? `${directusUrl}/diag`,
		octreeUrl: pick(runtime?.octreeUrl, env.VITE_OCTREE_URL) ?? `${directusUrl}/octrees`,
	};
}

let config: StarbaseConfig = resolveConfig(import.meta.env as ConfigEnv, null);

export async function loadRuntimeConfig(fetchImpl: typeof fetch = fetch): Promise<StarbaseConfig> {
	let runtime: Partial<StarbaseConfig> | null = null;
	try {
		const res = await fetchImpl('/config.json', { cache: 'no-store' });
		if (res.ok) {
			const json: unknown = await res.json();
			if (json && typeof json === 'object' && !Array.isArray(json)) runtime = json as Partial<StarbaseConfig>;
		}
	} catch {
		// No runtime file (development, tests): the build-time values stand.
	}
	config = resolveConfig(import.meta.env as ConfigEnv, runtime);
	return config;
}

export function getConfig(): Readonly<StarbaseConfig> {
	return config;
}
```

`apps/starbase/web/src/main.ts` (a placeholder until Task 5 writes the real boot):

```ts
import { createApp, h } from 'vue';
import { loadRuntimeConfig } from './config';

async function bootstrap() {
	await loadRuntimeConfig();
	createApp({ render: () => h('p', 'STARbase') }).mount('#app');
}
void bootstrap();
```

- [ ] **Step 4: Root workspace and scripts**

In the root `package.json`:
- add `"apps/starbase/web"` to `workspaces`, after `"apps/force-app/desktop"`;
- add the script `"build:starbase": "npm run build -w starbase-web"`, after `build:web:desktop`.

Then run:

```bash
npm install
npm test -w starbase-web && npm run typecheck -w starbase-web && npm run build -w starbase-web
```

Expected: 6 tests pass, the typecheck is clean, and the build writes
`apps/starbase/web/dist/index.html` and `dist/brand/Star-Icon.svg`.

- [ ] **Step 5: Wire CI**

In `.github/scripts/ci-plan.mjs`, change the `directusUi` list so that it starts with:

```js
  directusUi: [
    'packages/d1-ui/', 'packages/fast-plotting/', 'packages/directus-host/', 'packages/starbase-pages/', 'packages/force-plotting/',
    'apps/starbase/web/', 'core/extensions/d1-home/', 'core/extensions/d1-lab-dashboard/',
```

The rest of the list stays as it is. `packages/force-plotting/` is added because STARbase builds
it.

In `.github/scripts/ci-plan.test.mjs`, after the STARbase-packages test, add:

```js
test('the STARbase app and the force plotting it builds plan the directusUi job', () => {
  for (const f of ['apps/starbase/web/src/main.ts', 'packages/force-plotting/src/host.ts']) {
    assert.equal(plan([f], EXT).directusUi, true, f);
  }
});
```

In `.github/workflows/ci.yml`, in the `directus-ui` job:
- rename the job to `name: Explorer UI and STARbase (@d1/ui, the extensions that use it, apps/starbase/web)`;
- add this step after "Build the Directus extensions that use @d1/ui":

```yaml
      - name: "STARbase app: unit tests + typecheck + build"
        run: |
          npm test -w starbase-web
          npm run typecheck -w starbase-web
          npm run build -w starbase-web
```

In `.claude/skills/ci-local/scripts/plan_checks.sh`, replace the directus-ui `has … &&` line pair
with:

```bash
has '^(packages/(d1-ui|starbase-pages|fast-plotting|directus-host|force-plotting)/|apps/starbase/web/|core/extensions/(d1-home|d1-lab-dashboard|d1-composition-bar|d1-campaign-ops|d1-project-items|d1-fast-dashboard)/)' && \
  echo "npm test -w @d1/ui && npm run typecheck -w @d1/ui && npm test -w @d1/fast-plotting && npm run typecheck -w @d1/fast-plotting && npm test -w @d1/directus-host && npm run typecheck -w @d1/directus-host && npm test -w @d1/starbase-pages && npm run typecheck -w @d1/starbase-pages && npm run typecheck -w directus-extension-d1-home -w directus-extension-d1-lab-dashboard -w directus-extension-d1-campaign-ops && npm run build:extensions && npm test -w starbase-web && npm run typecheck -w starbase-web && npm run build -w starbase-web   # CI: directus-ui"
```

Run: `node --test .github/scripts/ci-plan.test.mjs && bash .claude/skills/ci-local/scripts/plan_checks.sh | grep -c starbase-web`
Expected: all ci-plan tests pass, and the count is `1` or more.

- [ ] **Step 6: Commit**

```bash
git add apps/starbase/web package.json package-lock.json .github .claude/skills/ci-local/scripts/plan_checks.sh
git commit -m "feat(starbase): app scaffold, runtime config and the STAR logos; CI builds it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin HEAD:feat/explorer-standalone
```

---
### Task 2: API client, session and the sign-in guard

There is no token in STARbase. The axios client sends the session cookie. A guard on its responses
tells three cases apart:
- a lapsed access token: renew it and retry;
- no session at all, for example after signing out elsewhere: go to sign-in;
- a real refusal: leave it to the page.

**Files:**
- Create: `apps/starbase/web/src/testing/fakeServer.ts`
- Create: `apps/starbase/web/src/api.ts`, `src/api.test.ts`
- Create: `apps/starbase/web/src/session.ts`, `src/session.test.ts`
- Create: `apps/starbase/web/src/guard.ts`, `src/guard.test.ts`
- Modify: `docs/superpowers/specs/2026-10-12-starbase-standalone-design.md` (§9, one row from Step 7)

**Interfaces:**
- Consumes: `getConfig()` (Task 1).
- Produces:

```ts
// api.ts
declare module 'axios' { interface AxiosRequestConfig { sbNoGuard?: boolean; sbRetried?: boolean } }
export function createApi(baseURL: string): AxiosInstance;            // withCredentials, timeout 30 s
export type RefreshOutcome = 'ok' | 'refused' | 'unreachable';
export type Recovery = 'retry' | 'fail' | 'signed-out';
export function refreshSession(api: AxiosInstance): Promise<RefreshOutcome>;   // POST /auth/refresh {mode:'session'}
export function sessionAlive(api: AxiosInstance): Promise<boolean>;            // GET /users/me
export interface SessionGuard { recover(status: number): Promise<Recovery> }
export function installSessionGuard(api: AxiosInstance, onSignedOut: () => void,
  probes?: { alive(): Promise<boolean>; refresh(): Promise<RefreshOutcome> }): SessionGuard;
// session.ts
export type SessionState = 'unknown' | 'signed-in' | 'signed-out' | 'unreachable';
export interface SessionUser { id: string; first_name?: string; last_name?: string; email?: string; role: string | null }
export interface AuthProvider { name: string; label: string; icon: string | null }
export interface Session { state; user; isAdmin; adminKnown; load(); ensure(); signIn(email, password); signOut(); markSignedOut() }
export function createSession(api: AxiosInstance): Session;
export function classifyLoadError(e: unknown): 'signed-out' | 'unreachable';
export function safeNext(raw: unknown): string;
export function listProviders(api: AxiosInstance): Promise<AuthProvider[]>;
export function providerLoginUrl(directusUrl: string, provider: string, appOrigin: string, next: unknown): string;
export function signInErrorText(e: unknown): string;
export function ssoErrorText(reason: string): string;
export const SESSION_NOT_KEPT: string;
// guard.ts
export interface GuardTarget { path: string; fullPath: string; meta: Record<string | number | symbol, unknown>; query: Record<string, unknown> }
export function guardDecision(to: GuardTarget, state: SessionState): true | string;
export function homeRedirect(fullPath: string): string;
```

- [ ] **Step 1: The fake d1-server for the tests**

`apps/starbase/web/src/testing/fakeServer.ts`:

```ts
import { AxiosError, type AxiosInstance, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';

export type Reply = number | 'network' | { status: number; data: unknown };

// A fake d1-server for unit tests: every request made through `api` is answered by `route`, keyed
// "METHOD /path" (the path as the caller wrote it, without the query), with no network. A 4xx/5xx
// rejects exactly as axios does (an AxiosError carrying `response`), 'network' rejects with no response.
// Returns the requests made, in order.
export function fakeServer(api: AxiosInstance, route: (key: string, cfg: InternalAxiosRequestConfig) => Reply): string[] {
	const calls: string[] = [];
	api.defaults.adapter = async (cfg: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
		const key = `${(cfg.method ?? 'get').toUpperCase()} ${cfg.url}`;
		calls.push(key);
		const reply = route(key, cfg);
		if (reply === 'network') throw new AxiosError('Network Error', AxiosError.ERR_NETWORK, cfg);
		const { status, data } = typeof reply === 'number' ? { status: reply, data: { data: {} } } : reply;
		const response = { data, status, statusText: String(status), headers: {}, config: cfg } as AxiosResponse;
		if (status >= 400) throw new AxiosError(`HTTP ${status}`, AxiosError.ERR_BAD_RESPONSE, cfg, null, response);
		return response;
	};
	return calls;
}
```

- [ ] **Step 2: Write the failing tests**

`apps/starbase/web/src/api.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createApi, installSessionGuard, refreshSession, sessionAlive } from './api';
import { fakeServer, type Reply } from './testing/fakeServer';

const D1 = 'https://d1-server.tail54eeb6.ts.net';
const statusOf = (e: unknown) => (e as { response?: { status?: number } }).response?.status;

function setup(route: (key: string) => Reply) {
	const api = createApi(D1);
	const onSignedOut = vi.fn();
	const guard = installSessionGuard(api, onSignedOut);
	const calls = fakeServer(api, (key) => route(key));
	return { api, guard, onSignedOut, calls };
}

describe('createApi', () => {
	it('talks to d1-server with the session cookie, never a token', () => {
		const api = createApi(D1);
		expect(api.defaults.baseURL).toBe(D1);
		expect(api.defaults.withCredentials).toBe(true);
		expect(api.defaults.headers.common?.Authorization).toBeUndefined();
	});
});

describe('the session guard', () => {
	it('a 401 renews the session once and retries the request', async () => {
		let first = true;
		const { api, calls, onSignedOut } = setup((key) => {
			if (key === 'GET /items/x') {
				const s = first ? 401 : 200;
				first = false;
				return s;
			}
			return key === 'POST /auth/refresh' ? 200 : 404;
		});
		await expect(api.get('/items/x')).resolves.toMatchObject({ status: 200 });
		expect(calls).toEqual(['GET /items/x', 'POST /auth/refresh', 'GET /items/x']);
		expect(onSignedOut).not.toHaveBeenCalled();
	});

	it("a 403 with a live session is the page's to show: no renewal, no sign-out", async () => {
		const { api, calls, onSignedOut } = setup((key) => (key === 'GET /items/x' ? 403 : key === 'GET /users/me' ? 200 : 404));
		expect(statusOf(await api.get('/items/x').catch((e) => e))).toBe(403);
		expect(calls).toEqual(['GET /items/x', 'GET /users/me']);
		expect(onSignedOut).not.toHaveBeenCalled();
	});

	it('signed out elsewhere: a 403 as the public role sends the user to sign in (Review Focus 1)', async () => {
		const { api, calls, onSignedOut } = setup((key) =>
			key === 'GET /items/x' ? 403 : key === 'GET /users/me' ? 401 : key === 'POST /auth/refresh' ? 400 : 404,
		);
		expect(statusOf(await api.get('/items/x').catch((e) => e))).toBe(403);
		expect(calls).toEqual(['GET /items/x', 'GET /users/me', 'POST /auth/refresh']);
		expect(onSignedOut).toHaveBeenCalledTimes(1);
	});

	it('a network error is not a sign-out (Review Focus 5)', async () => {
		const { api, calls, onSignedOut } = setup(() => 'network');
		const e = await api.get('/items/x').catch((x) => x);
		expect(statusOf(e)).toBeUndefined();
		expect(calls).toEqual(['GET /items/x']);
		expect(onSignedOut).not.toHaveBeenCalled();
	});

	it('a renewal that cannot reach the server does not sign out', async () => {
		const { api, onSignedOut } = setup((key) => (key === 'GET /items/x' ? 401 : 'network'));
		expect(statusOf(await api.get('/items/x').catch((e) => e))).toBe(401);
		expect(onSignedOut).not.toHaveBeenCalled();
	});

	it('concurrent 401s share one renewal', async () => {
		const seen = new Set<string>();
		const { api, calls } = setup((key) => {
			if (key.startsWith('GET /items/')) {
				if (seen.has(key)) return 200;
				seen.add(key);
				return 401;
			}
			return key === 'POST /auth/refresh' ? 200 : 404;
		});
		await Promise.all([api.get('/items/a'), api.get('/items/b')]);
		expect(calls.filter((c) => c === 'POST /auth/refresh')).toHaveLength(1);
	});

	it('a request that fails again after the retry is not retried a second time', async () => {
		const { api, calls } = setup((key) => (key === 'GET /items/x' ? 401 : key === 'POST /auth/refresh' ? 200 : 404));
		expect(statusOf(await api.get('/items/x').catch((e) => e))).toBe(401);
		expect(calls).toEqual(['GET /items/x', 'POST /auth/refresh', 'GET /items/x']);
	});

	it('sign-in, sign-out and the probes are not guarded', async () => {
		const { api, calls } = setup(() => 401);
		await api.post('/auth/login', {}, { sbNoGuard: true }).catch(() => {});
		expect(calls).toEqual(['POST /auth/login']);
	});

	it('recover() for the plotters: a live session is a refusal, a lapsed one is renewed', async () => {
		const alive = setup((key) => (key === 'GET /users/me' ? 200 : 404));
		expect(await alive.guard.recover(403)).toBe('fail');
		const lapsed = setup((key) => (key === 'GET /users/me' ? 401 : key === 'POST /auth/refresh' ? 200 : 404));
		expect(await lapsed.guard.recover(403)).toBe('retry');
	});
});

describe('refreshSession and sessionAlive', () => {
	it('renews in session mode, and tells a refusal from no answer', async () => {
		const api = createApi(D1);
		let body: unknown;
		fakeServer(api, (key, cfg) => {
			body = JSON.parse(String(cfg.data));
			return 200;
		});
		expect(await refreshSession(api)).toBe('ok');
		expect(body).toEqual({ mode: 'session' });
		fakeServer(api, () => 401);
		expect(await refreshSession(api)).toBe('refused');
		fakeServer(api, () => 'network');
		expect(await refreshSession(api)).toBe('unreachable');
	});
	it('a session is alive unless /users/me says 401 or 403 (no answer counts as alive)', async () => {
		const api = createApi(D1);
		fakeServer(api, () => 200);
		expect(await sessionAlive(api)).toBe(true);
		fakeServer(api, () => 403);
		expect(await sessionAlive(api)).toBe(false);
		fakeServer(api, () => 'network');
		expect(await sessionAlive(api)).toBe(true);
	});
});
```

`apps/starbase/web/src/session.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createApi } from './api';
import {
	SESSION_NOT_KEPT, classifyLoadError, createSession, listProviders, providerLoginUrl, safeNext, signInErrorText, ssoErrorText,
} from './session';
import { fakeServer, type Reply } from './testing/fakeServer';

const D1 = 'https://d1-server.tail54eeb6.ts.net';
const ME = { status: 200, data: { data: { id: 'u1', first_name: 'Ada', role: 'r1' } } };
const ADMIN = { status: 200, data: { data: { admin_access: true } } };

function setup(route: (key: string, cfg: any) => Reply) {
	const api = createApi(D1);
	const calls = fakeServer(api, route);
	return { api, calls, session: createSession(api) };
}

describe('createSession', () => {
	it('load: signed in, with the user and the server-side admin flag', async () => {
		const { session } = setup((key) => (key === 'GET /users/me' ? ME : key === 'GET /policies/me/globals' ? ADMIN : 404));
		expect(await session.load()).toBe('signed-in');
		expect(session.user.value).toEqual({ id: 'u1', first_name: 'Ada', role: 'r1' });
		await vi.waitFor(() => expect(session.adminKnown.value).toBe(true));
		expect(session.isAdmin.value).toBe(true);
	});

	it('load: a lapsed access token is renewed before deciding', async () => {
		let first = true;
		const { session, calls } = setup((key) => {
			if (key === 'GET /users/me') {
				const r = first ? 401 : ME;
				first = false;
				return r;
			}
			return key === 'POST /auth/refresh' ? 200 : 404;
		});
		expect(await session.load()).toBe('signed-in');
		expect(calls.slice(0, 3)).toEqual(['GET /users/me', 'POST /auth/refresh', 'GET /users/me']);
	});

	it('load: no session at all is signed-out', async () => {
		const { session } = setup((key) => (key === 'POST /auth/refresh' ? 400 : 401));
		expect(await session.load()).toBe('signed-out');
		expect(session.user.value).toBeNull();
	});

	it('load: no answer, a timeout or a 5xx is unreachable, not signed out (Review Focus 5)', async () => {
		expect(await setup(() => 'network').session.load()).toBe('unreachable');
		expect(await setup(() => 502).session.load()).toBe('unreachable');
		expect(classifyLoadError({ code: 'ECONNABORTED' })).toBe('unreachable');
		expect(classifyLoadError({ response: { status: 403 } })).toBe('signed-out');
	});

	it('ensure: loads once, however many navigations ask at the same time', async () => {
		const { session, calls } = setup((key) => (key === 'GET /users/me' ? ME : 404));
		await Promise.all([session.ensure(), session.ensure(), session.ensure()]);
		expect(calls.filter((c) => c === 'GET /users/me')).toHaveLength(1);
		await session.ensure();
		expect(calls.filter((c) => c === 'GET /users/me')).toHaveLength(1);
	});

	it('signIn: posts the password in session mode (the cookie Data Studio uses), then loads who it is', async () => {
		let login: any;
		const { session } = setup((key, cfg) => {
			if (key === 'POST /auth/login') {
				login = { body: JSON.parse(String(cfg.data)), withCredentials: cfg.withCredentials };
				return 200;
			}
			return key === 'GET /users/me' ? ME : 404;
		});
		await session.signIn('ada@example.org', 'pw');
		expect(login).toEqual({ body: { email: 'ada@example.org', password: 'pw', mode: 'session' }, withCredentials: true });
		expect(session.state.value).toBe('signed-in');
	});

	it('signIn: says so when the browser did not keep the session', async () => {
		const { session } = setup((key) => (key === 'POST /auth/login' ? 200 : key === 'POST /auth/refresh' ? 400 : 401));
		await expect(session.signIn('a@b.c', 'pw')).rejects.toThrow(SESSION_NOT_KEPT);
	});

	it('signOut: ends the session in session mode (Data Studio too) and forgets the user, even offline', async () => {
		let logout: unknown;
		const { session } = setup((key, cfg) => {
			if (key === 'POST /auth/logout') {
				logout = JSON.parse(String(cfg.data));
				return 'network';
			}
			return key === 'GET /users/me' ? ME : 404;
		});
		await session.load();
		await session.signOut();
		expect(logout).toEqual({ mode: 'session' });
		expect(session.state.value).toBe('signed-out');
		expect(session.user.value).toBeNull();
	});
});

describe('safeNext (Review Focus 2)', () => {
	it('keeps a path of this app, query and encoding included', () => {
		expect(safeNext('/samples/a%2Fb?x=1#k')).toBe('/samples/a%2Fb?x=1#k');
		expect(safeNext('/plot/force?operation=9')).toBe('/plot/force?operation=9');
	});
	it('sends anything else to Home', () => {
		for (const bad of ['//evil.example', 'https://evil.example', '/\\evil.example', '/signin', '/signin?next=/x', '/signin/done', 'samples', '', undefined, null, ['/samples'], '/a\nb']) {
			expect(safeNext(bad), String(bad)).toBe('/');
		}
	});
});

describe('providers', () => {
	it('one button per provider Directus lists', async () => {
		const { api } = setup(() => ({ status: 200, data: { data: [{ name: 'google', driver: 'openid', icon: 'google' }, { name: 'lab', label: 'Lab SSO' }, { driver: 'x' }] } }));
		expect(await listProviders(api)).toEqual([
			{ name: 'google', label: 'Google', icon: 'google' },
			{ name: 'lab', label: 'Lab SSO', icon: null },
		]);
	});
	it('no providers (or no answer) means just the password form', async () => {
		expect(await listProviders(setup(() => 'network').api)).toEqual([]);
	});
	it("the provider link returns to STARbase's /signin/done with a safe next", () => {
		expect(providerLoginUrl(`${D1}/`, 'google', 'https://starbase.tail54eeb6.ts.net', '/samples/1?x=1')).toBe(
			`${D1}/auth/login/google?redirect=${encodeURIComponent('https://starbase.tail54eeb6.ts.net/signin/done?next=%2Fsamples%2F1%3Fx%3D1')}`,
		);
		expect(providerLoginUrl(D1, 'google', 'https://s', '//evil')).toContain(encodeURIComponent('next=%2F'));
	});
});

describe('error texts', () => {
	it('sign-in failures say what to do', () => {
		expect(signInErrorText({ response: { status: 401, data: {} } })).toBe('Wrong email or password.');
		expect(signInErrorText({ message: 'Network Error' })).toMatch(/Can't reach the database/);
		expect(signInErrorText({ response: { status: 429, data: { errors: [{ message: 'Too many requests' }] } } })).toBe('Too many requests');
		expect(signInErrorText(new Error(SESSION_NOT_KEPT))).toBe(SESSION_NOT_KEPT);
	});
	it("an SSO return shows Directus's reason", () => {
		expect(ssoErrorText('INVALID_CREDENTIALS')).toBe('Directus did not accept that account.');
		expect(ssoErrorText('SOMETHING_NEW')).toBe('Directus said: SOMETHING_NEW');
	});
});
```

`apps/starbase/web/src/guard.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { guardDecision, homeRedirect, type GuardTarget } from './guard';

const to = (fullPath: string, meta: Record<string, unknown> = {}): GuardTarget => {
	const [path, q = ''] = fullPath.split('?');
	return { path, fullPath, meta, query: Object.fromEntries(new URLSearchParams(q)) };
};

describe('guardDecision', () => {
	it('lets a signed-in user through', () => {
		expect(guardDecision(to('/samples/1'), 'signed-in')).toBe(true);
	});
	it('sends a signed-out user to sign in, remembering the page (Review Focus 2)', () => {
		expect(guardDecision(to('/samples/a%2Fb?x=1'), 'signed-out')).toBe(`/signin?next=${encodeURIComponent('/samples/a%2Fb?x=1')}`);
		expect(guardDecision(to('/'), 'signed-out')).toBe('/signin');
	});
	it('the sign-in pages are public; a signed-in user on /signin goes straight on, safely', () => {
		expect(guardDecision(to('/signin'), 'signed-out')).toBe(true);
		expect(guardDecision(to('/signin/done', { public: true }), 'signed-out')).toBe(true);
		expect(guardDecision(to('/signin?next=%2Fsamples%2F1'), 'signed-in')).toBe('/samples/1');
		expect(guardDecision(to('/signin?next=%2F%2Fevil.example'), 'signed-in')).toBe('/');
	});
	it('unreachable lets the route through: App shows the full-page state over it (Review Focus 5)', () => {
		expect(guardDecision(to('/samples/1'), 'unreachable')).toBe(true);
	});
});

describe('homeRedirect', () => {
	it('drops /home from an old Directus-form link, keeping the rest', () => {
		expect(homeRedirect('/home')).toBe('/');
		expect(homeRedirect('/home/')).toBe('/');
		expect(homeRedirect('/home?q=1')).toBe('/?q=1');
		expect(homeRedirect('/home/samples/a%2Fb?x=1#k')).toBe('/samples/a%2Fb?x=1#k');
		expect(homeRedirect('/home/labels?ids=1,2')).toBe('/labels?ids=1,2');
	});
});
```

Run: `npm test -w starbase-web`
Expected: FAIL. `./api`, `./session` and `./guard` cannot be resolved.

- [ ] **Step 3: Implement `api.ts`**

`apps/starbase/web/src/api.ts`:

```ts
import axios, { type AxiosError, type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';

// STARbase's client for d1-server. There is no token anywhere: the browser sends Directus's session
// cookie (withCredentials), the one Data Studio uses (ADR-0013). Pages get this instance as host.api and
// the plotters as their api, so every request passes the session guard below.

declare module 'axios' {
	interface AxiosRequestConfig {
		/** Not watched by the session guard: sign-in, sign-out and the guard's own probes. */
		sbNoGuard?: boolean;
		/** Already retried once after a session renewal. */
		sbRetried?: boolean;
	}
}

export function createApi(baseURL: string): AxiosInstance {
	return axios.create({ baseURL, withCredentials: true, timeout: 30_000 });
}

export type RefreshOutcome = 'ok' | 'refused' | 'unreachable';
export type Recovery = 'retry' | 'fail' | 'signed-out';

// POST /auth/refresh in session mode: Directus renews the session cookie (Data Studio does the same, and
// Directus's refresh grace period covers both apps renewing at once). A refusal means there is no
// session any more; no answer at all means d1-server could not be reached, which is not a sign-out.
export async function refreshSession(api: AxiosInstance): Promise<RefreshOutcome> {
	try {
		await api.post('/auth/refresh', { mode: 'session' }, { sbNoGuard: true });
		return 'ok';
	} catch (e) {
		return (e as AxiosError).response ? 'refused' : 'unreachable';
	}
}

// Is the session still there? /users/me answers while it is. No answer counts as alive: a network blip
// must never sign anyone out.
export async function sessionAlive(api: AxiosInstance): Promise<boolean> {
	try {
		await api.get('/users/me', { params: { fields: 'id' }, sbNoGuard: true });
		return true;
	} catch (e) {
		const status = (e as AxiosError).response?.status;
		return !(status === 401 || status === 403);
	}
}

export interface SessionGuard {
	// What a 401/403 means: 'retry' (the session was renewed), 'fail' (a real refusal, or no answer),
	// 'signed-out' (no session; onSignedOut has been called). Also used by the Force plotter's refreshAuth.
	recover(status: number): Promise<Recovery>;
}

// After a sign-out in Data Studio there is no cookie, and Directus answers items as the PUBLIC role:
// 403, not 401 (spec §4, Review Focus 1). So a 403 is checked: if the session is alive it is a real
// refusal (a Lab Member reading what they may not; the page shows it), otherwise the session is renewed
// or, if that is refused, the user is sent to sign in. Concurrent failures share one check per status.
export function installSessionGuard(
	api: AxiosInstance,
	onSignedOut: () => void,
	probes: { alive(): Promise<boolean>; refresh(): Promise<RefreshOutcome> } = { alive: () => sessionAlive(api), refresh: () => refreshSession(api) },
): SessionGuard {
	const inFlight = new Map<number, Promise<Recovery>>();

	async function run(status: number): Promise<Recovery> {
		if (status === 403 && (await probes.alive())) return 'fail';
		const outcome = await probes.refresh();
		if (outcome === 'ok') return 'retry';
		if (outcome === 'refused') {
			onSignedOut();
			return 'signed-out';
		}
		return 'fail';
	}

	const guard: SessionGuard = {
		recover(status) {
			let p = inFlight.get(status);
			if (!p) {
				p = run(status).finally(() => inFlight.delete(status));
				inFlight.set(status, p);
			}
			return p;
		},
	};

	api.interceptors.response.use(undefined, async (error: AxiosError) => {
		const cfg = error.config as InternalAxiosRequestConfig | undefined;
		const status = error.response?.status;
		if (!cfg || cfg.sbNoGuard || cfg.sbRetried || (status !== 401 && status !== 403)) throw error;
		if ((await guard.recover(status)) !== 'retry') throw error;
		cfg.sbRetried = true;
		return api.request(cfg);
	});

	return guard;
}
```

- [ ] **Step 4: Implement `session.ts` and `guard.ts`**

`apps/starbase/web/src/session.ts`:

```ts
import { ref, type Ref } from 'vue';
import type { AxiosError, AxiosInstance } from 'axios';
import { refreshSession } from './api';

// Who is signed in to STARbase. There is no STARbase account: the browser holds Directus's session
// cookie (set by /auth/login in session mode, here or in Data Studio), and this asks d1-server whose it
// is (spec §3.2). Admin status is the server's own answer (GET /policies/me/globals): in Directus 11 the
// flag lives on policies, not roles (the Force App's lesson).

export type SessionState = 'unknown' | 'signed-in' | 'signed-out' | 'unreachable';
export interface SessionUser {
	id: string;
	first_name?: string;
	last_name?: string;
	email?: string;
	role: string | null;
}
export interface AuthProvider {
	name: string;
	label: string;
	icon: string | null;
}

export interface Session {
	state: Ref<SessionState>;
	user: Ref<SessionUser | null>;
	isAdmin: Ref<boolean>;
	adminKnown: Ref<boolean>;
	load(): Promise<SessionState>;
	ensure(): Promise<SessionState>;
	signIn(email: string, password: string): Promise<void>;
	signOut(): Promise<void>;
	markSignedOut(): void;
}

export const SESSION_NOT_KEPT =
	'Directus accepted the sign-in, but this browser did not keep the session for STARbase. Check that cookies are allowed for d1-server.';

const USER_FIELDS = 'id,first_name,last_name,email,role';
const LOAD_TIMEOUT_MS = 10_000;

const statusOf = (e: unknown): number | undefined => (e as AxiosError)?.response?.status;

// A failed /users/me: 401/403 is "no session"; no answer, a timeout or a 5xx is "can't reach".
export function classifyLoadError(e: unknown): 'signed-out' | 'unreachable' {
	const s = statusOf(e);
	return s === 401 || s === 403 ? 'signed-out' : 'unreachable';
}

function toUser(u: any): SessionUser {
	const role = u?.role && typeof u.role === 'object' ? (u.role.id ?? null) : (u?.role ?? null);
	const user: SessionUser = { id: String(u?.id), role };
	if (u?.first_name) user.first_name = u.first_name;
	if (u?.last_name) user.last_name = u.last_name;
	if (u?.email) user.email = u.email;
	return user;
}

export function createSession(api: AxiosInstance): Session {
	const state = ref<SessionState>('unknown');
	const user = ref<SessionUser | null>(null);
	const isAdmin = ref(false);
	const adminKnown = ref(false);
	let loading: Promise<SessionState> | null = null;

	function markSignedOut(): void {
		state.value = 'signed-out';
		user.value = null;
		isAdmin.value = false;
		adminKnown.value = false;
	}

	async function readAdmin(): Promise<void> {
		adminKnown.value = false;
		try {
			const r = await api.get('/policies/me/globals', { sbNoGuard: true });
			isAdmin.value = r.data?.data?.admin_access === true;
		} catch {
			isAdmin.value = false;
		} finally {
			adminKnown.value = true;
		}
	}

	const me = () => api.get('/users/me', { params: { fields: USER_FIELDS }, timeout: LOAD_TIMEOUT_MS, sbNoGuard: true });

	async function fetchState(): Promise<SessionState> {
		let res;
		try {
			res = await me();
		} catch (e) {
			if (classifyLoadError(e) === 'unreachable') return (state.value = 'unreachable');
			// No session, or only its access token lapsed: one renewal decides.
			const renewed = await refreshSession(api);
			if (renewed === 'unreachable') return (state.value = 'unreachable');
			if (renewed === 'refused') {
				markSignedOut();
				return state.value;
			}
			try {
				res = await me();
			} catch (again) {
				if (classifyLoadError(again) === 'unreachable') return (state.value = 'unreachable');
				markSignedOut();
				return state.value;
			}
		}
		user.value = toUser(res.data?.data);
		state.value = 'signed-in';
		void readAdmin();
		return state.value;
	}

	function load(): Promise<SessionState> {
		if (!loading) loading = fetchState().finally(() => (loading = null));
		return loading;
	}

	async function ensure(): Promise<SessionState> {
		return state.value === 'unknown' ? load() : state.value;
	}

	async function signIn(email: string, password: string): Promise<void> {
		await api.post('/auth/login', { email, password, mode: 'session' }, { sbNoGuard: true });
		if ((await load()) !== 'signed-in') throw new Error(SESSION_NOT_KEPT);
	}

	async function signOut(): Promise<void> {
		try {
			await api.post('/auth/logout', { mode: 'session' }, { sbNoGuard: true });
		} catch {
			// Already gone, or d1-server unreachable: STARbase forgets the user either way.
		}
		markSignedOut();
	}

	return { state, user, isAdmin, adminKnown, load, ensure, signIn, signOut, markSignedOut };
}

// Where to go after signing in: a path of this app only. Another site (//host, a scheme, a backslash
// that browsers treat as a slash), a control character or the sign-in pages themselves give Home.
export function safeNext(raw: unknown): string {
	if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
	if (/[\u0000-\u001f\\]/.test(raw)) return '/';
	if (raw === '/signin' || raw.startsWith('/signin/') || raw.startsWith('/signin?')) return '/';
	return raw;
}

// One button per SSO provider Directus offers (GET /auth). None, or no answer: just the password form.
export async function listProviders(api: AxiosInstance): Promise<AuthProvider[]> {
	try {
		const r = await api.get('/auth', { sbNoGuard: true });
		const list: unknown = r.data?.data;
		if (!Array.isArray(list)) return [];
		return list
			.filter((p) => p && typeof p.name === 'string' && p.name !== '')
			.map((p) => ({
				name: p.name as string,
				label: typeof p.label === 'string' && p.label ? p.label : (p.name as string).charAt(0).toUpperCase() + (p.name as string).slice(1),
				icon: typeof p.icon === 'string' ? p.icon : null,
			}));
	} catch {
		return [];
	}
}

// The provider's sign-in on d1-server, coming back to /signin/done. Directus must list this URL in
// AUTH_<PROVIDER>_REDIRECT_ALLOW_LIST (runbook).
export function providerLoginUrl(directusUrl: string, provider: string, appOrigin: string, next: unknown): string {
	const back = `${appOrigin}/signin/done?next=${encodeURIComponent(safeNext(next))}`;
	return `${directusUrl.replace(/\/+$/, '')}/auth/login/${encodeURIComponent(provider)}?redirect=${encodeURIComponent(back)}`;
}

export function signInErrorText(e: unknown): string {
	if (e instanceof Error && e.message === SESSION_NOT_KEPT) return SESSION_NOT_KEPT;
	const err = e as AxiosError<{ errors?: { message?: string }[] }>;
	if (!err?.response) return "Can't reach the database. Check that this device is on the tailnet, then try again.";
	if (err.response.status === 401) return 'Wrong email or password.';
	return err.response.data?.errors?.[0]?.message || 'Sign-in failed.';
}

// /signin/done?reason=<CODE>: Directus sends the user back with its own code when an SSO sign-in fails.
export function ssoErrorText(reason: string): string {
	const known: Record<string, string> = {
		INVALID_CREDENTIALS: 'Directus did not accept that account.',
		INVALID_PROVIDER: 'That sign-in provider is not set up on d1-server.',
		USER_SUSPENDED: 'That account is suspended.',
	};
	return known[reason] ?? `Directus said: ${reason}`;
}
```

`apps/starbase/web/src/guard.ts`:

```ts
import { safeNext, type SessionState } from './session';

export interface GuardTarget {
	path: string;
	fullPath: string;
	meta: Record<string | number | symbol, unknown>;
	query: Record<string, unknown>;
}

// Before every navigation (router.ts): signed out → the sign-in page, remembering where they were going;
// /signin while signed in → straight on to `next`; unreachable → the route goes through and App.vue shows
// the full-page "Can't reach the database" over it (spec §4). A string is a redirect.
export function guardDecision(to: GuardTarget, state: SessionState): true | string {
	if (to.path === '/signin') return state === 'signed-in' ? safeNext(to.query.next) : true;
	if (to.meta.public === true) return true;
	if (state === 'signed-out') return to.fullPath === '/' ? '/signin' : `/signin?next=${encodeURIComponent(to.fullPath)}`;
	return true;
}

// Old links in the Directus form (/home/samples/<id>?x=1, printed before STARbase) land on the same page.
export function homeRedirect(fullPath: string): string {
	const rest = fullPath.replace(/^\/home(?=[/?#]|$)/, '');
	if (rest === '' || rest === '/') return '/';
	return rest.startsWith('/') ? rest : `/${rest}`;
}
```

- [ ] **Step 5: Run the tests**

Run: `npm test -w starbase-web && npm run typecheck -w starbase-web`
Expected: every test passes, and the typecheck is clean.

- [ ] **Step 6: Commit**

```bash
git add apps/starbase/web/src
git commit -m "feat(starbase): session on Directus's cookie, with a guard that tells signed-out from refused

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin HEAD:feat/explorer-standalone
```

- [ ] **Step 7: Measure session renewal on the preview, and record it**

This is throwaway, in `.superpowers/`, which is git-ignored. The code above is right either way.
This step only records which case is real.

`.superpowers/starbase-ttl.env`:

```
ACCESS_TOKEN_TTL=20s
```

`.superpowers/starbase-ttl.mjs`:

```js
// Throwaway: does a session-mode cookie outlive ACCESS_TOKEN_TTL, and does /auth/refresh renew it?
import { readFileSync } from 'node:fs';
const line = (k) => readFileSync('.superpowers/preview-credentials-d1-starbase.txt', 'utf8').split('\n').find((l) => l.startsWith(k + '=')).slice(k.length + 1);
const member = line('member');
const [email, password] = [member.slice(0, member.indexOf(' ')), member.slice(member.indexOf(' ') + 1)];
const D1 = 'http://127.0.0.1:18057';
const cookieOf = (res) => (res.headers.getSetCookie().find((c) => c.startsWith('directus_session_token=')) ?? '').split(';')[0];
let cookie = cookieOf(await fetch(`${D1}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, mode: 'session' }) }));
const me = async () => (await fetch(`${D1}/users/me?fields=id`, { headers: { cookie } })).status;
console.log('right after sign-in:', await me());
await new Promise((r) => setTimeout(r, 30_000));
console.log('after 30 s (ACCESS_TOKEN_TTL 20 s):', await me());
const ref = await fetch(`${D1}/auth/refresh`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'session' }) });
console.log('refresh:', ref.status);
if (cookieOf(ref)) cookie = cookieOf(ref);
console.log('after refresh:', await me());
```

```bash
npm run build -w directus-extension-d1-home
D1_PREVIEW_NAME=d1-starbase D1_PREVIEW_PORT=18057 D1_PREVIEW_ENV_FILE=.superpowers/starbase-ttl.env bash scripts/dev/explorer_preview.sh
node .superpowers/starbase-ttl.mjs
D1_PREVIEW_NAME=d1-starbase D1_PREVIEW_PORT=18057 bash scripts/dev/explorer_preview.sh --stop
```

Expected, one of two outcomes:
- `200`, then `401`, `refresh: 200`, `200`. The access token inside the cookie lapses, and the
  renewal path is what keeps people signed in.
- `200` throughout. The cookie lives for `SESSION_COOKIE_TTL`, and the renewal only runs after a
  real sign-out elsewhere.

Append one row to the table in spec §9:

```markdown
| (d) session renewal (plan 2) | <the four printed lines> | STARbase renews on a 401, or on a 403 whose /users/me probe fails, with POST /auth/refresh {mode:'session'} (plan 2 Task 2) |
```

```bash
git add docs/superpowers/specs/2026-10-12-starbase-standalone-design.md
git commit -m "docs(starbase): session renewal measured on the preview

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin HEAD:feat/explorer-standalone
```

---

### Task 3: The STARbase host, its links and usage pings

**Files:**
- Create: `apps/starbase/web/src/host.ts`, `src/host.test.ts`
- Modify: `packages/d1-ui/src/links.ts` (`starbaseLinks().canonical`), `packages/d1-ui/src/links.test.ts`
- Modify: `packages/starbase-pages/src/home/FrequentlyUsed.vue` (the `newTab` link), `packages/starbase-pages/src/hostNeutral.test.ts`

**Interfaces:**
- Consumes:
  - `Session` (Task 2);
  - from `@d1/ui`: `ExplorerHost`, `HostApi`, `HostField`, `setExplorerHostFactory`,
    `configureLinks`, `starbaseLinks`, `openLink`, `linkHref`;
  - `installUsagePings(router, api)` from `@d1/starbase-pages`.
- Produces:

```ts
export interface HostDeps {
	api: AxiosInstance; session: Session; router: Router; directusUrl: string;
	openWindow?: (url: string) => void;                                         // default window.open(url, '_blank', 'noopener')
	openEditor?: (collection: string, id: string) => Promise<'saved' | 'cancelled'>; // Task 7 passes it
}
export function sortFields(defs: HostField[]): HostField[];
export function createStarbaseHost(deps: HostDeps): ExplorerHost;
export function installStarbaseHost(deps: HostDeps): ExplorerHost;  // links + factory + pings, once per user
export function resetStarbaseHost(): void;                            // tests
```

- [ ] **Step 1: Write the failing tests**

`apps/starbase/web/src/host.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { resetLinks, useExplorerHost } from '@d1/ui';
import { createStarbaseHost, installStarbaseHost, resetStarbaseHost, sortFields, type HostDeps } from './host';
import type { Session } from './session';

const D1 = 'https://d1-server.tail54eeb6.ts.net';
const SID = '3f2b8a1c-0000-4000-8000-000000000001';

function fakeSession(id = 'u1'): Session {
	return {
		state: ref('signed-in'), user: ref({ id, first_name: 'Ada', role: 'r1' }), isAdmin: ref(false), adminKnown: ref(true),
		load: vi.fn(), ensure: vi.fn(), signIn: vi.fn(), signOut: vi.fn(), markSignedOut: vi.fn(),
	} as unknown as Session;
}
const fakeRouter = (path = '/') => ({ push: vi.fn(), currentRoute: ref({ fullPath: path }), afterEach: vi.fn(() => () => {}) });
const fakeApi = (fields: unknown[] = []) => ({
	get: vi.fn(async () => ({ data: { data: fields } })), post: vi.fn(async () => ({})), patch: vi.fn(), delete: vi.fn(),
});
function deps(over: Partial<HostDeps> & { routerPath?: string; userId?: string } = {}) {
	const router = fakeRouter(over.routerPath);
	const api = fakeApi();
	const d = { api, session: fakeSession(over.userId), router, directusUrl: D1, openWindow: vi.fn(), ...over } as unknown as HostDeps & {
		api: ReturnType<typeof fakeApi>; router: ReturnType<typeof fakeRouter>; openWindow: ReturnType<typeof vi.fn>;
	};
	return d;
}

afterEach(() => {
	resetStarbaseHost();
	resetLinks();
});

describe('the STARbase host', () => {
	it('navigate takes Directus-form paths to STARbase routes', () => {
		const d = deps();
		const host = installStarbaseHost(d);
		host.navigate('/home/samples/1?x=1');
		host.navigate('/d1-force-dashboard?operation=9');
		expect(d.router.push.mock.calls.map((c) => c[0])).toEqual(['/samples/1?x=1', '/plot/force?operation=9']);
	});

	it('a Data Studio link opens d1-server in a new tab', () => {
		const d = deps();
		createStarbaseHost(d).openDataStudio('/content/materials/7');
		expect(d.openWindow).toHaveBeenCalledWith(`${D1}/admin/content/materials/7`);
	});

	it('fieldsFor asks d1-server and sorts as Data Studio does', async () => {
		const d = deps();
		d.api.get.mockResolvedValueOnce({ data: { data: [
			{ field: 'b', meta: { sort: 2 } }, { field: 'z', meta: null }, { field: 'a', meta: { sort: 1 } }, { field: 'c', meta: { sort: 2 } },
		] } });
		const fields = await createStarbaseHost(d).fieldsFor('physical_samples');
		expect(d.api.get).toHaveBeenCalledWith('/fields/physical_samples');
		expect(fields.map((f) => f.field)).toEqual(['a', 'b', 'c', 'z']);
	});

	it("isAdmin, adminKnown and user are the session's own refs", () => {
		const d = deps();
		const host = createStarbaseHost(d);
		expect(host.isAdmin).toBe(d.session.isAdmin);
		expect(host.adminKnown).toBe(d.session.adminKnown);
		expect(host.user).toBe(d.session.user);
	});
});

describe('installStarbaseHost', () => {
	it('before anyone signed in, the pages are told so', () => {
		expect(() => useExplorerHost()).toThrow(/no Explorer host/);
	});

	it('one host per signed-in user', () => {
		const d = deps();
		const first = installStarbaseHost(d);
		expect(installStarbaseHost(d)).toBe(first);
		expect(useExplorerHost()).toBe(first);
		d.session.user.value = { id: 'u2', role: null };
		expect(installStarbaseHost(d)).not.toBe(first);
	});

	it('visit pings use the Directus form, so both hosts count the same targets', () => {
		const d = deps({ routerPath: `/samples/${SID}` });
		installStarbaseHost(d);
		expect(d.api.post).toHaveBeenCalledWith('/d1-usage/visit', { kind: 'record', target: `physical_samples:${SID}` });
	});

	it('a plot page pings as its dashboard', () => {
		const d = deps({ routerPath: '/plot/force?operation=9', userId: 'u3' });
		installStarbaseHost(d);
		expect(d.api.post).toHaveBeenCalledWith('/d1-usage/visit', { kind: 'page', target: 'force-dashboard' });
	});
});

describe('sortFields', () => {
	it('by meta.sort, unsorted last, ties in their original order', () => {
		const defs = [{ field: 'x' }, { field: 'b', meta: { sort: 2 } }, { field: 'a', meta: { sort: 2 } }, { field: 'y', meta: { sort: 1 } }];
		expect(sortFields(defs).map((f) => f.field)).toEqual(['y', 'b', 'a', 'x']);
	});
});
```

In `packages/d1-ui/src/links.test.ts`, inside `describe('STARbase', …)`:

- in `it('turns its routes back into the Directus form', …)`, replace
  `expect(canonicalPath('/plot/force?operation=9')).toBe('/plot/force?operation=9');` with:

```ts
		expect(canonicalPath('/plot/force?operation=9')).toBe('/d1-force-dashboard?operation=9');
		expect(canonicalPath('/plot/fast')).toBe('/d1-fast-dashboard');
		expect(canonicalPath('/plotting')).toBe('/home/plotting');
```

- after `it('round-trips every Explorer path', …)`, add:

```ts
	it('round-trips the plot dashboards too', () => {
		use();
		for (const p of ['/d1-force-dashboard?operation=9', '/d1-fast-dashboard?operation=3', '/d1-force-dashboard']) {
			const r = resolveLink(p);
			expect(r.kind).toBe('route');
			if (r.kind === 'route') expect(canonicalPath(r.to)).toBe(p);
		}
	});
```

In the same file, in `describe('usage pings agree across hosts', …)`, add to the existing `it`:

```ts
		expect(routeTarget(canonicalPath('/plot/fast?operation=3'))).toEqual({ kind: 'page', target: 'fast-dashboard' });
```

In `packages/starbase-pages/src/hostNeutral.test.ts`, inside
`it('build links and asset URLs only through @d1/ui', …)`, add to the loop:

```ts
			// A raw href to a link's `to` skips the host's resolver (FrequentlyUsed's newTab once did).
			expect(src, rel(f)).not.toMatch(/:href="[\w.]+\.to"/);
```

Run:
```bash
npm test -w starbase-web
npm test -w @d1/ui -- links.test
npm test -w @d1/starbase-pages
```
Expected: FAIL in all three:
- `./host` is not found;
- the `/plot` canonical assertions fail;
- the guard names `home/FrequentlyUsed.vue`.

- [ ] **Step 2: Map the plot pages back in `links.ts`**

In `packages/d1-ui/src/links.ts`, in `starbaseLinks(...).canonical`, replace

```ts
			if (startsWithSegment(routePath, '/plot')) return routePath;
```

with

```ts
			// The plot pages are the dashboards in the Directus form (the inverse of resolve), so usage pings
			// and "you are here" count /plot/force as /d1-force-dashboard in both hosts.
			for (const [from, to] of PLOTS) {
				if (startsWithSegment(routePath, to)) return from + routePath.slice(to.length);
			}
```

- [ ] **Step 3: Fix FrequentlyUsed's new-tab link**

In `packages/starbase-pages/src/home/FrequentlyUsed.vue`:
- change the `@d1/ui` import to `import { AppLink, Section, linkHref, type UsageEntry } from '@d1/ui';`;
- add `import { useRouter } from 'vue-router';`;
- add `const router = useRouter();` after the imports in `<script setup>`;
- change
  `<a v-if="e.newTab" class="name" :href="e.to" target="_blank" rel="noopener" @click="openedElsewhere(e)">`
  to
  `<a v-if="e.newTab" class="name" :href="linkHref(e.to, router)" target="_blank" rel="noopener" @click="openedElsewhere(e)">`.

- [ ] **Step 4: Implement `host.ts`**

`apps/starbase/web/src/host.ts`:

```ts
import type { AxiosInstance } from 'axios';
import type { Router } from 'vue-router';
import { configureLinks, openLink, setExplorerHostFactory, starbaseLinks, type ExplorerHost, type HostApi, type HostField } from '@d1/ui';
import { installUsagePings } from '@d1/starbase-pages';
import type { Session } from './session';

// STARbase's side of the Explorer host contract (@d1/ui host.ts); the Directus module's is
// @d1/directus-host. Pages, the sidebar and the finder reach d1-server only through this.

export interface HostDeps {
	api: AxiosInstance;
	session: Session;
	router: Router;
	directusUrl: string;
	openWindow?: (url: string) => void;
	openEditor?: (collection: string, id: string) => Promise<'saved' | 'cancelled'>;
}

// The order Data Studio shows a collection's fields in: by meta.sort, unsorted last, ties as given.
export function sortFields(defs: HostField[]): HostField[] {
	const key = (f: HostField) => (typeof f.meta?.sort === 'number' ? f.meta.sort : Number.POSITIVE_INFINITY);
	return defs
		.map((f, i) => ({ f, i }))
		.sort((a, b) => (key(a.f) === key(b.f) ? a.i - b.i : key(a.f) - key(b.f)))
		.map(({ f }) => f);
}

export function createStarbaseHost(deps: HostDeps): ExplorerHost {
	const { api, session, router, directusUrl } = deps;
	const openWindow = deps.openWindow ?? ((url: string) => void window.open(url, '_blank', 'noopener'));
	const host: ExplorerHost = {
		// The same axios instance the session guard watches: errors reject axios-style (e.response.status).
		api: api as unknown as HostApi,
		navigate: (to) => openLink(to, router),
		openDataStudio: (path) => openWindow(`${directusUrl}/admin${path}`),
		fieldsFor: async (collection) => {
			const { data } = await api.get(`/fields/${encodeURIComponent(collection)}`);
			return sortFields((data?.data ?? []) as HostField[]);
		},
		isAdmin: session.isAdmin,
		adminKnown: session.adminKnown,
		user: session.user as ExplorerHost['user'],
	};
	if (deps.openEditor) Object.assign(host, { openEditor: deps.openEditor });
	return host;
}

// One host per signed-in user, built when the session says who it is (main.ts watches the user). The
// links follow STARbase's routes, and the visit pings start once per user, in the Directus form
// (canonicalPath), so Frequently used counts the same targets in both hosts.
let current: { userId: string; host: ExplorerHost } | null = null;

export function installStarbaseHost(deps: HostDeps): ExplorerHost {
	configureLinks(starbaseLinks(deps.directusUrl));
	setExplorerHostFactory(() => {
		if (!current) throw new Error('@d1/ui: no Explorer host. STARbase builds one once someone is signed in.');
		return current.host;
	});
	const userId = deps.session.user.value?.id ?? '';
	if (current && current.userId === userId) return current.host;
	const host = createStarbaseHost(deps);
	current = { userId, host };
	installUsagePings(deps.router, deps.api);
	return host;
}

export function resetStarbaseHost(): void {
	current = null;
	setExplorerHostFactory(null);
}
```

`ExplorerHost` has no `openEditor` until Task 7, so `Object.assign` keeps this compiling now.
Task 7 replaces that line with a typed field.

- [ ] **Step 5: Run the tests, then the Directus regression run**

```bash
npm test -w starbase-web && npm run typecheck -w starbase-web
npm test -w @d1/ui && npm run typecheck -w @d1/ui
npm test -w @d1/starbase-pages && npm run typecheck -w @d1/starbase-pages
npm run build:extensions
export D1_PREVIEW_NAME=d1-starbase D1_PREVIEW_PORT=18057
export D1_PREVIEW_OVERLAY="d1-home d1-admin-overview d1-fast-dashboard d1-campaign-ops d1-lab-dashboard d1-project-items d1-usage"
bash scripts/dev/explorer_preview.sh --stop; bash scripts/dev/explorer_preview.sh
CREDS="$PWD/.superpowers/preview-credentials-d1-starbase.txt"
(cd tests/ui && D1_ROUTES_CREDENTIALS="$CREDS" npx playwright test specs/13-explorer-routes.spec.ts --retries=0)
```

Expected: every unit test passes, the typechecks are clean, and the harness reports `4 passed`.
Leave the preview running for Task 4 and Task 5.

- [ ] **Step 6: Commit**

```bash
git add apps/starbase/web/src packages/d1-ui/src/links.ts packages/d1-ui/src/links.test.ts packages/starbase-pages/src
git commit -m "feat(starbase): the STARbase host; plot pages ping as their dashboards; FrequentlyUsed new-tab link through the resolver

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin HEAD:feat/explorer-standalone
```

---
### Task 4: Stand-ins for Directus's components, and the theme

The kit, the pages and the plotters use Directus's global components. The only props and slots
the stand-ins implement are the ones those packages use. This is the inventory of 2026-10-13, as
`<v-…>` tags with their attributes, over `packages/{d1-ui,starbase-pages,fast-plotting,force-plotting}/src`:

| Component | Props and slots used |
|---|---|
| `v-icon` | `name`, `x-small`, `small`, `large`, `left`, `right`, `clickable`, falls-through `title`, `class`, `@click` |
| `v-button` | `to` (Directus-form paths), `secondary`, `kind="danger"`, `small`, `x-small`, `large`, `icon`, `rounded`, `loading`, `disabled`, `@click`, default slot |
| `v-input` | `v-model`, `model-value`, `@update:model-value`, `placeholder`, `type="number"`, `disabled`, `autofocus`, `small`, `#prepend` |
| `v-select` | `v-model`, `items` (`{ text, value }`), `placeholder`, `show-deselect` |
| `v-checkbox` | `v-model` (its label is the page's own `<label>`) |
| `v-textarea` | `v-model`, `placeholder` |
| `v-notice` | `type` (`danger`, `warning`), default slot |
| `v-dialog` | `v-model`, `@esc`, default slot (a `v-card`) |
| `v-card`, `-title`, `-text`, `-actions` | default slot |
| `v-progress-circular` | `indeterminate`, `small`, `x-small` |
| `v-progress-linear` | `indeterminate` |
| `v-tooltip` (directive) | a string value, the `.bottom` modifier |

`v-form` and `v-drawer` are **not** stood in. Only `EditDrawer` uses them, and in STARbase it goes
through `host.openEditor` (Task 7). `private-view` is registered in Task 8 as `PlainFrame`.

**Files:**
- Create in `apps/starbase/web/src/standins/`:
  - `VIcon.vue`, `VProgressCircular.vue`, `VProgressLinear.vue`;
  - `VButton.vue`, `VInput.vue`, `VSelect.vue`, `VCheckbox.vue`, `VTextarea.vue`;
  - `VNotice.vue`, `VDialog.vue`, `VCard.vue`, `VCardTitle.vue`, `VCardText.vue`, `VCardActions.vue`;
  - `tooltip.ts`, `inputModel.ts`, `selectModel.ts`, `register.ts`, `standins.test.ts`.
- Create: `apps/starbase/web/src/theme.css`, `src/themeVars.test.ts`

**Interfaces:**
- Consumes: `AppLink` from `@d1/ui`.
- Produces:
  - `registerStandins(app: App): void`, which registers all `v-*` above and the `tooltip` directive;
  - `STANDINS: Record<string, Component>`;
  - `applyTooltip(el, value)` and `vTooltip`;
  - `toInputValue(v)` and `fromInputValue(raw, type?)`;
  - `optionKey(items, value)`, `valueFor(items, key)`, `DESELECT` and `SelectItem`.

- [ ] **Step 1: Write the failing tests**

`apps/starbase/web/src/standins/standins.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { createSSRApp, h, resolveComponent, resolveDirective, withDirectives, type Component } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { createMemoryHistory, createRouter } from 'vue-router';
import { configureLinks, resetLinks, starbaseLinks } from '@d1/ui';
import { fromInputValue, toInputValue } from './inputModel';
import { registerStandins } from './register';
import { DESELECT, optionKey, valueFor } from './selectModel';
import { applyTooltip } from './tooltip';

// No DOM in this workspace: the stand-ins are rendered to HTML (vue/server-renderer), and what they do
// on input is tested through their pure helpers. Clicking through them is the e2e's job (Task 12).
const D1 = 'https://d1-server.tail54eeb6.ts.net';

async function render(node: () => ReturnType<typeof h>) {
	const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)*', component: { render: () => null } }] });
	const app = createSSRApp({ render: node });
	registerStandins(app);
	app.use(router);
	await router.push('/');
	await router.isReady();
	const ctx: { teleports?: Record<string, string> } = {};
	const html = await renderToString(app, ctx);
	return { html, teleported: Object.values(ctx.teleports ?? {}).join('') };
}
const v = (tag: string, props: Record<string, unknown> = {}, slots: Record<string, () => unknown> = {}) => () =>
	h(resolveComponent(tag) as Component, props, slots as never);

afterEach(() => resetLinks());

describe('v-button', () => {
	it('a STARbase page link stays in the app', async () => {
		configureLinks(starbaseLinks(D1));
		const { html } = await render(v('v-button', { to: '/home/samples/1', secondary: true }, { default: () => 'Sample' }));
		expect(html).toContain('href="/samples/1"');
		expect(html).not.toContain('target="_blank"');
		expect(html).toContain('v-button');
		expect(html).toContain('secondary');
	});
	it('a Data Studio link opens d1-server in a new tab', async () => {
		configureLinks(starbaseLinks(D1));
		const { html } = await render(v('v-button', { to: '/content/projects/+' }, { default: () => 'New project' }));
		expect(html).toContain(`href="${D1}/admin/content/projects/+"`);
		expect(html).toContain('target="_blank"');
	});
	it('without `to` it is a button; loading disables it', async () => {
		const { html } = await render(v('v-button', { loading: true, kind: 'danger' }, { default: () => 'Delete' }));
		expect(html).toMatch(/<button[^>]*type="button"/);
		expect(html).toContain('disabled');
		expect(html).toContain('aria-busy="true"');
		expect(html).toContain('danger');
	});
});

describe('v-dialog', () => {
	it('renders nothing while closed, so Ctrl+K still opens the finder', async () => {
		const { html, teleported } = await render(v('v-dialog', { modelValue: false }, { default: () => 'Body' }));
		expect(html + teleported).not.toContain('aria-modal');
		expect(html + teleported).not.toContain('Body');
	});
	it('open, it is a modal dialog: the finder stays shut over it', async () => {
		const { teleported } = await render(v('v-dialog', { modelValue: true }, { default: () => 'Body' }));
		expect(teleported).toContain('role="dialog"');
		expect(teleported).toContain('aria-modal="true"');
		expect(teleported).toContain('Body');
	});
});

describe('the other stand-ins', () => {
	it('v-icon: the glyph, its size, and a clickable one is a button', async () => {
		expect((await render(v('v-icon', { name: 'edit', xSmall: true }))).html).toMatch(/font-size:\s*14px/);
		const clickable = (await render(v('v-icon', { name: 'download', clickable: true }))).html;
		expect(clickable).toContain('role="button"');
		expect(clickable).toContain('>download<');
	});
	it('v-notice: danger and warning are alerts, others a status', async () => {
		expect((await render(v('v-notice', { type: 'danger' }, { default: () => 'Bad' }))).html).toContain('role="alert"');
		expect((await render(v('v-notice', {}, { default: () => 'Note' }))).html).toContain('role="status"');
	});
	it('v-input: type, placeholder and the prepend slot', async () => {
		const { html } = await render(v('v-input', { type: 'number', placeholder: '0', modelValue: 2.5 }, { prepend: () => h('i', 'S') }));
		expect(html).toContain('type="number"');
		expect(html).toContain('placeholder="0"');
		expect(html).toContain('value="2.5"');
		expect(html).toContain('<i>S</i>');
	});
	it('v-select: the placeholder, the items, and "None" only when something is chosen', async () => {
		const items = [{ text: 'Ti-6Al-4V', value: 'm1' }];
		const empty = (await render(v('v-select', { items, placeholder: 'Choose material…', showDeselect: true, modelValue: null }))).html;
		expect(empty).toContain('Choose material…');
		expect(empty).toContain('Ti-6Al-4V');
		expect(empty).not.toContain('— None —');
		expect((await render(v('v-select', { items, showDeselect: true, modelValue: 'm1' }))).html).toContain('— None —');
	});
	it('v-checkbox, v-textarea, v-progress-*, v-card-*', async () => {
		expect((await render(v('v-checkbox', { modelValue: true }))).html).toMatch(/type="checkbox"[^>]*checked/);
		expect((await render(v('v-textarea', { modelValue: 'n', placeholder: 'Optional' }))).html).toContain('placeholder="Optional"');
		expect((await render(v('v-progress-linear', { indeterminate: true }))).html).toContain('role="progressbar"');
		expect((await render(v('v-progress-circular', { indeterminate: true, small: true }))).html).toContain('role="progressbar"');
		expect((await render(v('v-card-title', {}, { default: () => 'Discard?' }))).html).toMatch(/<h2 class="v-card-title"[^>]*>Discard\?<\/h2>/);
	});
	it('v-tooltip renders a title', async () => {
		const { html } = await render(() => withDirectives(h('button', 'x'), [[resolveDirective('tooltip')!, 'Save']]));
		expect(html).toContain('title="Save"');
	});
});

describe('pure helpers', () => {
	it('v-input gives a number for type="number" (null when emptied), text otherwise', () => {
		expect(fromInputValue('2.5', 'number')).toBe(2.5);
		expect(fromInputValue('', 'number')).toBeNull();
		expect(fromInputValue('abc', 'number')).toBeNull();
		expect(fromInputValue(' x ', undefined)).toBe(' x ');
		expect(toInputValue(null)).toBe('');
		expect(toInputValue(0)).toBe('0');
	});
	it('v-select keys options by index, so any value type survives the native <select>', () => {
		const items = [{ text: 'A', value: 7 }, { text: 'B', value: 'u-1' }];
		expect(optionKey(items, 'u-1')).toBe('1');
		expect(optionKey(items, 'missing')).toBe('');
		expect(valueFor(items, '0')).toBe(7);
		expect(valueFor(items, DESELECT)).toBeNull();
		expect(valueFor(items, '9')).toBeNull();
	});
	it('the tooltip is the title, and the accessible name unless the element has its own', () => {
		const attrs = new Map<string, string>();
		const el = { dataset: {} as Record<string, string>, setAttribute: (k: string, v: string) => void attrs.set(k, v), removeAttribute: (k: string) => void attrs.delete(k), hasAttribute: (k: string) => attrs.has(k) };
		applyTooltip(el, 'Copy file path');
		expect([attrs.get('title'), attrs.get('aria-label')]).toEqual(['Copy file path', 'Copy file path']);
		applyTooltip(el, 'Copied!');
		expect([attrs.get('title'), attrs.get('aria-label')]).toEqual(['Copied!', 'Copied!']);
		applyTooltip(el, '');
		expect(attrs.has('title') || attrs.has('aria-label')).toBe(false);
		const own = new Map([['aria-label', 'Download']]);
		const el2 = { dataset: {} as Record<string, string>, setAttribute: (k: string, v: string) => void own.set(k, v), removeAttribute: (k: string) => void own.delete(k), hasAttribute: (k: string) => own.has(k) };
		applyTooltip(el2, 'Download the file');
		expect(own.get('aria-label')).toBe('Download');
		expect(own.get('title')).toBe('Download the file');
	});
});
```

`apps/starbase/web/src/themeVars.test.ts`:

```ts
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Every --theme-- variable the kit, the pages and the plotters read is one Directus defines. Outside
// Directus, theme.css must define each of them, in both schemes, or a panel goes transparent or a text
// goes black-on-black.
const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..', '..');
const ROOTS = ['packages/d1-ui/src', 'packages/starbase-pages/src', 'packages/force-plotting/src', 'packages/fast-plotting/src'];
const files = (p: string): string[] =>
	statSync(p).isFile() ? (/\.(vue|css|ts)$/.test(p) ? [p] : []) : readdirSync(p).filter((n) => n !== 'node_modules').flatMap((n) => files(join(p, n)));
const used = [...new Set(ROOTS.flatMap((r) => files(join(repo, r))).flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/var\(\s*(--theme--[a-z0-9-]+)/g)].map((m) => m[1])))].sort();
const css = readFileSync(join(here, 'theme.css'), 'utf8');
const [light, dark] = css.split('@media (prefers-color-scheme: dark)');

describe('theme.css', () => {
	it('finds the variables it is meant to check', () => {
		expect(used).toContain('--theme--primary');
		expect(used.length).toBeGreaterThan(15);
	});
	it('defines every --theme-- variable used, for light and for dark', () => {
		for (const name of used) {
			expect(light, `${name} (light)`).toContain(`${name}:`);
			expect(dark ?? '', `${name} (dark)`).toContain(`${name}:`);
		}
	});
});
```

Run: `npm test -w starbase-web`
Expected: FAIL. `./register`, `./inputModel` and the other new modules are missing, and so is
`theme.css`.

- [ ] **Step 2: The pure helpers and the directive**

`apps/starbase/web/src/standins/inputModel.ts`:

```ts
// <v-input>'s value both ways. Directus's v-input gives a number for type="number" and null when the
// box is emptied; any other type stays text.
export const toInputValue = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

export function fromInputValue(raw: string, type?: string): string | number | null {
	if (type !== 'number') return raw;
	if (raw.trim() === '') return null;
	const n = Number(raw);
	return Number.isFinite(n) ? n : null;
}
```

`apps/starbase/web/src/standins/selectModel.ts`:

```ts
// <v-select :items="[{ text, value }]">: a native <select> speaks strings, while the values are uuids,
// numbers or codes, so each option is keyed by its index.
export interface SelectItem {
	text: string;
	value: unknown;
}
export const DESELECT = '__deselect__';

export function optionKey(items: SelectItem[], value: unknown): string {
	const i = items.findIndex((it) => it.value === value);
	return i < 0 ? '' : String(i);
}

export function valueFor(items: SelectItem[], key: string): unknown {
	if (key === '' || key === DESELECT) return null;
	const item = items[Number(key)];
	return item ? item.value : null;
}
```

`apps/starbase/web/src/standins/tooltip.ts`:

```ts
import type { Directive } from 'vue';

// Stand-in for Directus's v-tooltip (v-tooltip="'Copy file path'", v-tooltip.bottom="…"): the text is
// the element's title, and its accessible name too unless it has one of its own. Placement modifiers are
// accepted and ignored.
export interface TooltipTarget {
	dataset: Record<string, string | undefined>;
	setAttribute(name: string, value: string): void;
	removeAttribute(name: string): void;
	hasAttribute(name: string): boolean;
}

export function applyTooltip(el: TooltipTarget, value: unknown): void {
	const text = value === null || value === undefined || value === false ? '' : String(value);
	const ours = el.dataset.sbTip === '1';
	if (!text) {
		el.removeAttribute('title');
		if (ours) {
			el.removeAttribute('aria-label');
			delete el.dataset.sbTip;
		}
		return;
	}
	el.setAttribute('title', text);
	if (ours || !el.hasAttribute('aria-label')) {
		el.setAttribute('aria-label', text);
		el.dataset.sbTip = '1';
	}
}

export const vTooltip: Directive<HTMLElement, unknown> = {
	mounted: (el, binding) => applyTooltip(el, binding.value),
	updated: (el, binding) => applyTooltip(el, binding.value),
	getSSRProps: (binding) => (binding.value ? { title: String(binding.value) } : {}),
};
```

- [ ] **Step 3: The components**

`apps/starbase/web/src/standins/VIcon.vue`:

```vue
<script setup lang="ts">
import { computed } from 'vue';

// Stand-in for Directus's <v-icon>: a Material Symbols glyph by name. Clickable icons (copy a path,
// download) are buttons for the keyboard and screen readers; the page's @click falls through.
const props = defineProps<{ name?: string; xSmall?: boolean; small?: boolean; large?: boolean; xLarge?: boolean; left?: boolean; right?: boolean; clickable?: boolean }>();
const size = computed(() => (props.xSmall ? 14 : props.small ? 18 : props.large ? 32 : props.xLarge ? 40 : 24));
</script>

<template>
	<span
		class="material-symbols-rounded v-icon"
		:class="{ left, right, clickable }"
		:style="{ fontSize: size + 'px' }"
		:role="clickable ? 'button' : undefined"
		:tabindex="clickable ? 0 : undefined"
		:aria-hidden="clickable ? undefined : 'true'"
		>{{ name }}</span
	>
</template>

<style scoped>
.v-icon {
	display: inline-flex; align-items: center; justify-content: center; line-height: 1; vertical-align: middle;
	user-select: none; font-variation-settings: 'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 24;
}
.left { margin-right: 4px; }
.right { margin-left: 4px; }
.clickable { cursor: pointer; border-radius: 4px; }
.clickable:focus-visible { outline: 2px solid var(--theme--primary); outline-offset: 1px; }
</style>
```

`apps/starbase/web/src/standins/VProgressCircular.vue`:

```vue
<script setup lang="ts">
// Stand-in for <v-progress-circular indeterminate />: a CSS ring (the `spin` keyframes are in styles.css).
const props = defineProps<{ indeterminate?: boolean; xSmall?: boolean; small?: boolean; large?: boolean }>();
const dim = props.xSmall ? 14 : props.small ? 18 : props.large ? 40 : 28;
</script>

<template>
	<span class="v-progress-circular" :style="{ width: dim + 'px', height: dim + 'px' }" role="progressbar" aria-label="Loading"></span>
</template>

<style scoped>
.v-progress-circular {
	display: inline-block; border-radius: 50%; border: 2px solid currentColor; border-top-color: transparent;
	opacity: 0.8; animation: spin 0.9s linear infinite;
}
</style>
```

`apps/starbase/web/src/standins/VProgressLinear.vue`:

```vue
<script setup lang="ts">
defineProps<{ indeterminate?: boolean }>();
</script>

<template>
	<div class="v-progress-linear" role="progressbar" aria-label="Loading"><span class="bar" /></div>
</template>

<style scoped>
.v-progress-linear { position: relative; height: 4px; overflow: hidden; border-radius: 2px; background: var(--theme--background-normal); }
.bar { position: absolute; inset: 0 auto 0 0; width: 40%; background: var(--theme--primary); animation: slide 1.2s ease-in-out infinite; }
@keyframes slide { from { left: -40%; } to { left: 100%; } }
@media (prefers-reduced-motion: reduce) { .bar { animation: none; width: 100%; opacity: 0.4; } }
</style>
```

`apps/starbase/web/src/standins/VButton.vue`:

```vue
<script setup lang="ts">
import { computed } from 'vue';
import { AppLink } from '@d1/ui';

// Stand-in for Directus's <v-button>. `to` is a path in the Directus form ('/home/…', '/content/…'), so
// it goes through AppLink (links.ts): a STARbase route stays in the app, anything else opens d1-server in
// a new tab. Without `to` it is a plain button; the page's @click falls through to it.
const props = defineProps<{
	to?: string; secondary?: boolean; kind?: 'normal' | 'warning' | 'danger';
	small?: boolean; xSmall?: boolean; large?: boolean; icon?: boolean; rounded?: boolean; loading?: boolean; disabled?: boolean;
}>();
const classes = computed(() => ({
	secondary: props.secondary, danger: props.kind === 'danger', warning: props.kind === 'warning',
	small: props.small, 'x-small': props.xSmall, large: props.large, icon: props.icon, rounded: props.rounded,
}));
</script>

<template>
	<AppLink v-if="to && !disabled" :to="to" class="v-button" :class="classes"><slot /></AppLink>
	<button v-else type="button" class="v-button" :class="classes" :disabled="disabled || loading" :aria-busy="loading ? 'true' : undefined">
		<span v-if="loading" class="spinner" aria-hidden="true" />
		<slot />
	</button>
</template>

<style scoped>
.v-button {
	display: inline-flex; align-items: center; justify-content: center; gap: 4px; min-height: 36px; padding: 0 14px;
	border: 1px solid var(--theme--border-color); border-radius: var(--theme--border-radius, 8px);
	background: var(--theme--primary); color: var(--theme--foreground-inverted);
	font: inherit; font-size: var(--fs-md, 13px); font-weight: 600; text-decoration: none; white-space: nowrap; cursor: pointer;
}
.v-button.secondary { background: var(--theme--background-normal); color: var(--theme--foreground); }
.v-button.danger { background: var(--theme--danger); border-color: var(--theme--danger); color: #fff; }
.v-button.warning { background: var(--theme--warning); border-color: var(--theme--warning); color: #111; }
.v-button.small { min-height: 30px; padding: 0 10px; font-size: var(--fs-sm, 12px); }
.v-button.x-small { min-height: 24px; padding: 0 8px; font-size: var(--fs-xs, 11px); }
.v-button.large { min-height: 44px; padding: 0 18px; }
.v-button.icon { width: 36px; padding: 0; }
.v-button.rounded { border-radius: 999px; }
.v-button:disabled { opacity: 0.5; cursor: default; }
.v-button:focus-visible { outline: 2px solid var(--theme--primary); outline-offset: 2px; }
.spinner { width: 12px; height: 12px; border-radius: 50%; border: 2px solid currentColor; border-top-color: transparent; animation: spin 0.9s linear infinite; }
</style>
```

`apps/starbase/web/src/standins/VInput.vue`:

```vue
<script setup lang="ts">
import { fromInputValue, toInputValue } from './inputModel';

const props = defineProps<{ modelValue?: string | number | null; placeholder?: string; type?: string; disabled?: boolean; autofocus?: boolean; small?: boolean }>();
const emit = defineEmits<{ (e: 'update:modelValue', value: string | number | null): void }>();
const onInput = (e: Event) => emit('update:modelValue', fromInputValue((e.target as HTMLInputElement).value, props.type));
</script>

<template>
	<div class="v-input" :class="{ small, disabled }">
		<span v-if="$slots.prepend" class="prepend"><slot name="prepend" /></span>
		<input :type="type ?? 'text'" :value="toInputValue(modelValue)" :placeholder="placeholder" :disabled="disabled" :autofocus="autofocus" @input="onInput" />
	</div>
</template>

<style scoped>
.v-input {
	display: flex; align-items: center; gap: 6px; min-height: 36px; padding: 0 10px;
	border: 1px solid var(--theme--form--field--input--border-color); border-radius: var(--theme--border-radius, 8px);
	background: var(--theme--form--field--input--background); color: var(--theme--foreground);
}
.v-input.small { min-height: 30px; }
.v-input.disabled { opacity: 0.7; }
.v-input:focus-within { border-color: var(--theme--primary); }
input { flex: 1 1 auto; min-width: 0; border: 0; outline: 0; background: transparent; color: inherit; font: inherit; }
.prepend { display: inline-flex; color: var(--theme--foreground-subdued); }
</style>
```

`apps/starbase/web/src/standins/VSelect.vue`:

```vue
<script setup lang="ts">
import { computed } from 'vue';
import { DESELECT, optionKey, valueFor, type SelectItem } from './selectModel';

const props = defineProps<{ modelValue?: unknown; items: SelectItem[]; placeholder?: string; showDeselect?: boolean; disabled?: boolean }>();
const emit = defineEmits<{ (e: 'update:modelValue', value: unknown): void }>();
const selected = computed(() => optionKey(props.items, props.modelValue));
const onChange = (e: Event) => emit('update:modelValue', valueFor(props.items, (e.target as HTMLSelectElement).value));
</script>

<template>
	<select class="v-select" :value="selected" :disabled="disabled" @change="onChange">
		<option value="" disabled :selected="selected === ''">{{ placeholder ?? 'Choose…' }}</option>
		<option v-if="showDeselect && selected !== ''" :value="DESELECT">— None —</option>
		<option v-for="(item, i) in items" :key="i" :value="String(i)" :selected="selected === String(i)">{{ item.text }}</option>
	</select>
</template>

<style scoped>
.v-select {
	width: 100%; min-height: 36px; padding: 0 10px; font: inherit; color: var(--theme--foreground);
	border: 1px solid var(--theme--form--field--input--border-color); border-radius: var(--theme--border-radius, 8px);
	background: var(--theme--form--field--input--background);
}
.v-select:focus { outline: 2px solid var(--theme--primary); outline-offset: 1px; }
</style>
```

`apps/starbase/web/src/standins/VCheckbox.vue`:

```vue
<script setup lang="ts">
defineProps<{ modelValue?: boolean | null; disabled?: boolean }>();
const emit = defineEmits<{ (e: 'update:modelValue', value: boolean): void }>();
</script>

<template>
	<input type="checkbox" class="v-checkbox" :checked="!!modelValue" :disabled="disabled" @change="emit('update:modelValue', ($event.target as HTMLInputElement).checked)" />
</template>

<style scoped>
.v-checkbox { width: 18px; height: 18px; accent-color: var(--theme--primary); vertical-align: middle; }
</style>
```

`apps/starbase/web/src/standins/VTextarea.vue`:

```vue
<script setup lang="ts">
defineProps<{ modelValue?: string | null; placeholder?: string; disabled?: boolean }>();
const emit = defineEmits<{ (e: 'update:modelValue', value: string): void }>();
</script>

<template>
	<textarea class="v-textarea" :value="modelValue ?? ''" :placeholder="placeholder" :disabled="disabled" rows="4" @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)" />
</template>

<style scoped>
.v-textarea {
	width: 100%; box-sizing: border-box; padding: 8px 10px; font: inherit; color: var(--theme--foreground); resize: vertical;
	border: 1px solid var(--theme--form--field--input--border-color); border-radius: var(--theme--border-radius, 8px);
	background: var(--theme--form--field--input--background);
}
.v-textarea:focus { outline: 2px solid var(--theme--primary); outline-offset: 1px; }
</style>
```

`apps/starbase/web/src/standins/VNotice.vue`:

```vue
<script setup lang="ts">
const props = withDefaults(defineProps<{ type?: 'info' | 'success' | 'warning' | 'danger' }>(), { type: 'info' });
const role = props.type === 'danger' || props.type === 'warning' ? 'alert' : 'status';
</script>

<template>
	<div class="v-notice" :class="type" :role="role"><slot /></div>
</template>

<style scoped>
.v-notice { padding: 10px 12px; border-radius: var(--theme--border-radius, 8px); border-left: 4px solid var(--theme--primary); background: var(--theme--background-normal); color: var(--theme--foreground); }
.v-notice.success { border-left-color: var(--theme--success); }
.v-notice.warning { border-left-color: var(--theme--warning); }
.v-notice.danger { border-left-color: var(--theme--danger); background: var(--theme--danger-background); }
</style>
```

`apps/starbase/web/src/standins/VDialog.vue`:

```vue
<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';

// Stand-in for Directus's <v-dialog v-model @esc>. It renders NOTHING while closed: an always-mounted
// aria-modal box would make the finder think a dialog is open, and Ctrl+K would never open it again
// (@d1/ui finderNav.ts, MODAL_SELECTOR). Open: a backdrop and a role="dialog" aria-modal="true" box in
// <body>. Esc and a click on the backdrop emit `esc`; the page decides (close, or ask first).
const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ (e: 'update:modelValue', open: boolean): void; (e: 'esc'): void }>();
const box = ref<HTMLElement | null>(null);

const onKey = (e: KeyboardEvent) => {
	if (e.key !== 'Escape') return;
	e.stopPropagation();
	emit('esc');
};

watch(
	() => props.modelValue,
	async (open) => {
		if (typeof document === 'undefined') return;
		if (!open) {
			document.removeEventListener('keydown', onKey);
			return;
		}
		document.addEventListener('keydown', onKey);
		await nextTick();
		box.value?.querySelector<HTMLElement>('[autofocus], input, select, textarea, button')?.focus();
	},
	{ immediate: true },
);
onBeforeUnmount(() => {
	if (typeof document !== 'undefined') document.removeEventListener('keydown', onKey);
});
</script>

<template>
	<Teleport to="body">
		<div v-if="modelValue" class="v-dialog-backdrop" @mousedown.self="emit('esc')">
			<div ref="box" class="v-dialog" role="dialog" aria-modal="true"><slot /></div>
		</div>
	</Teleport>
</template>

<style scoped>
.v-dialog-backdrop { position: fixed; inset: 0; z-index: 100; display: grid; place-items: center; padding: 16px; background: rgba(0, 0, 0, 0.45); }
.v-dialog { width: min(560px, 100%); max-height: calc(100dvh - 32px); overflow: auto; }
</style>
```

`VCard.vue`, `VCardTitle.vue`, `VCardText.vue` and `VCardActions.vue` in
`apps/starbase/web/src/standins/`:

```vue
<!-- VCard.vue -->
<template><div class="v-card"><slot /></div></template>
<style scoped>
.v-card { border-radius: calc(var(--theme--border-radius, 8px) + 4px); background: var(--theme--background); color: var(--theme--foreground); box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25); }
</style>
```

```vue
<!-- VCardTitle.vue -->
<template><h2 class="v-card-title"><slot /></h2></template>
<style scoped>
.v-card-title { margin: 0; padding: 20px 20px 8px; font-size: var(--fs-lg, 15px); font-weight: 700; }
</style>
```

```vue
<!-- VCardText.vue -->
<template><div class="v-card-text"><slot /></div></template>
<style scoped>
.v-card-text { padding: 8px 20px; }
</style>
```

```vue
<!-- VCardActions.vue -->
<template><div class="v-card-actions"><slot /></div></template>
<style scoped>
.v-card-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; padding: 12px 20px 20px; }
</style>
```

`apps/starbase/web/src/standins/register.ts`:

```ts
import type { App, Component } from 'vue';
import VButton from './VButton.vue';
import VCard from './VCard.vue';
import VCardActions from './VCardActions.vue';
import VCardText from './VCardText.vue';
import VCardTitle from './VCardTitle.vue';
import VCheckbox from './VCheckbox.vue';
import VDialog from './VDialog.vue';
import VIcon from './VIcon.vue';
import VInput from './VInput.vue';
import VNotice from './VNotice.vue';
import VProgressCircular from './VProgressCircular.vue';
import VProgressLinear from './VProgressLinear.vue';
import VSelect from './VSelect.vue';
import VTextarea from './VTextarea.vue';
import { vTooltip } from './tooltip';

// The Directus global components the shared pages use, as STARbase's own (the inventory is in plan 2,
// Task 4). v-form and v-drawer are deliberately absent: EditDrawer uses the host's editor in STARbase.
export const STANDINS: Record<string, Component> = {
	'v-button': VButton, 'v-card': VCard, 'v-card-actions': VCardActions, 'v-card-text': VCardText, 'v-card-title': VCardTitle,
	'v-checkbox': VCheckbox, 'v-dialog': VDialog, 'v-icon': VIcon, 'v-input': VInput, 'v-notice': VNotice,
	'v-progress-circular': VProgressCircular, 'v-progress-linear': VProgressLinear, 'v-select': VSelect, 'v-textarea': VTextarea,
};

export function registerStandins(app: App): void {
	for (const [name, component] of Object.entries(STANDINS)) app.component(name, component);
	app.directive('tooltip', vTooltip);
}
```

- [ ] **Step 4: The theme**

`apps/starbase/web/src/theme.css` defines the values Directus would provide. The lab's settings are
the light theme "Directus Color Match" and the dark theme "Directus Default", both on the project
colour `#18222F`. The values come from `@directus/themes` and the preview copy's `directus_settings`,
including its `borderRadius` override of 8px. The light block comes first. The dark block must
follow the exact text `@media (prefers-color-scheme: dark)`, because the guard splits the file
there.

```css
/* The Directus theme variables the shared pages read (--theme--*), outside Directus. Light is the lab's
   "Directus Color Match" on the project colour #18222F, dark is "Directus Default" (values from
   @directus/themes and the lab's directus_settings). STARbase follows the system scheme; color-scheme
   lets the kit's light-dark() choose. Every variable used is checked by themeVars.test.ts. */
:root {
	color-scheme: light dark;
	--project-color: #18222f;
	--theme--primary: #18222f;
	--theme--primary-background: color-mix(in srgb, var(--theme--background), var(--theme--primary) 10%);
	--theme--primary-foreground: #ffffff;
	--theme--secondary: #ff99dd;
	--theme--success: #2ecda7;
	--theme--warning: #ffa439;
	--theme--danger: #e35169;
	--theme--danger-background: color-mix(in srgb, var(--theme--background), var(--theme--danger) 10%);
	--theme--foreground: color-mix(in srgb, #000000, #18222f 70%);
	--theme--foreground-subdued: color-mix(in srgb, #ffffff, #18222f 60%);
	--theme--foreground-inverted: #ffffff;
	--theme--background: color-mix(in srgb, #ffffff, #18222f 7%);
	--theme--background-normal: color-mix(in srgb, #ffffff, #18222f 15%);
	--theme--background-subdued: color-mix(in srgb, #ffffff, #18222f 10%);
	--theme--background-accent: color-mix(in srgb, #ffffff, #18222f 20%);
	--theme--border-color: color-mix(in srgb, #ffffff, #18222f 20%);
	--theme--border-color-subdued: color-mix(in srgb, #ffffff, #18222f 15%);
	--theme--border-radius: 8px;
	--theme--form--field--input--background: #ffffff;
	--theme--form--field--input--border-color: var(--theme--border-color);
	--theme--fonts--sans--font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
	--theme--fonts--monospace--font-family: 'Fira Mono', 'JetBrains Mono', Consolas, 'Liberation Mono', monospace;
	--theme--navigation--list--foreground: var(--theme--foreground);
	--theme--navigation--list--font-family: var(--theme--fonts--sans--font-family);
	--theme--navigation--list--background-hover: var(--theme--background-normal);
	--theme--navigation--list--background-active: var(--theme--background-accent);
}

@media (prefers-color-scheme: dark) {
	:root {
		--theme--primary: #18222f;
		--theme--primary-background: color-mix(in srgb, var(--theme--background), var(--theme--primary) 10%);
		--theme--primary-foreground: #ffffff;
		--theme--secondary: #ff99dd;
		--theme--success: #2ecda7;
		--theme--warning: #ffa439;
		--theme--danger: #e35169;
		--theme--danger-background: color-mix(in srgb, var(--theme--background), var(--theme--danger) 10%);
		--theme--foreground: #c9d1d9;
		--theme--foreground-subdued: #666672;
		--theme--foreground-inverted: #ffffff;
		--theme--background: #0d1117;
		--theme--background-normal: #21262e;
		--theme--background-subdued: #161b22;
		--theme--background-accent: #30363d;
		--theme--border-color: #21262e;
		--theme--border-color-subdued: #21262d;
		--theme--border-radius: 8px;
		--theme--form--field--input--background: #161b22;
		--theme--form--field--input--border-color: #30363d;
		--theme--fonts--sans--font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
		--theme--fonts--monospace--font-family: 'Fira Mono', 'JetBrains Mono', Consolas, 'Liberation Mono', monospace;
		--theme--navigation--list--foreground: var(--theme--foreground);
		--theme--navigation--list--font-family: var(--theme--fonts--sans--font-family);
		--theme--navigation--list--background-hover: var(--theme--background-normal);
		--theme--navigation--list--background-active: var(--theme--background-accent);
	}
}
```

If the guard names a variable that is missing here (a page added one since this list was made), add
it to both blocks. Take the Directus Default value for that variable from
`node_modules/@directus/themes/dist/index.js`.

- [ ] **Step 5: Run the tests**

Run: `npm test -w starbase-web && npm run typecheck -w starbase-web`
Expected: every test passes, and the typecheck is clean.

- [ ] **Step 6: Commit**

```bash
git add apps/starbase/web/src
git commit -m "feat(starbase): stand-ins for the Directus components the pages use, and the lab's theme values

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin HEAD:feat/explorer-standalone
```

---

### Task 5: Shell, branding, sign-in pages, router and page frame

**Files:**
- Create: `apps/starbase/web/src/context.ts`, `src/router.ts`, `src/routes.test.ts`
- Create: `apps/starbase/web/src/App.vue`, `src/AppShell.vue`, `src/PlainFrame.vue`, `src/BrandLogo.vue`, `src/styles.css`
- Create: `apps/starbase/web/src/pages/SignInPage.vue`, `src/pages/SignInDone.vue`, `src/pages/UnreachablePage.vue`
- Modify: `apps/starbase/web/src/main.ts` (the real boot)
- Modify: `packages/starbase-pages/src/pages/{SamplePage,OperationPage,TestPage,ProjectPage,CampaignPage}.vue` (the `RecordLayout` sticky offset), `packages/starbase-pages/src/hostNeutral.test.ts`
- Modify: `packages/d1-ui/src/components/RecordLayout.vue` (its comment only)
- Create: `tests/ui/starbase/preview-ports.env`

**Interfaces:**
- Consumes: Tasks 1-4, plus `starbaseRoutes`, `setPageFrame` and `openScan` from
  `@d1/starbase-pages`, and `ExplorerNav`, `Finder` and `useFinderShortcut` from `@d1/ui`.
- Produces:

```ts
// context.ts
export interface AppContext { api: AxiosInstance; session: Session; guard: SessionGuard }   // Task 7 adds editor
export const APP: InjectionKey<AppContext>;
export function useApp(): AppContext;
// router.ts
export function buildRoutes(extraChildren?: RouteRecordRaw[]): RouteRecordRaw[];
export function createStarbaseRouter(session: Session, extraChildren?: RouteRecordRaw[]): Router;
// PlainFrame.vue: props { title?: string }; slots headline, title-outer:prepend, actions, default;
//   sets --d1-header-offset on its root.
```

- [ ] **Step 1: Write the failing tests**

`apps/starbase/web/src/routes.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import { configureLinks, resetLinks, resolveLink, starbaseLinks } from '@d1/ui';
import {
	CampaignPage, HomeView, IndexRoute, LabelsPage, OperationPage, PeopleView, ProjectPage, ProjectsIndex, RegisterSample, SamplePage, TestPage,
} from '@d1/starbase-pages';
import { buildRoutes } from './router';

afterEach(() => resetLinks());
const memoryRouter = () => createRouter({ history: createMemoryHistory(), routes: buildRoutes() });

describe('STARbase routes', () => {
	it('every Directus-form link lands on the same page component as in the Directus module (spec §5)', () => {
		configureLinks(starbaseLinks('https://d1-server.tail54eeb6.ts.net'));
		const router = memoryRouter();
		const cases: [string, unknown][] = [
			['/home', HomeView], ['/home/register-sample', RegisterSample], ['/home/people', PeopleView], ['/home/projects', ProjectsIndex],
			['/home/projects/p1', ProjectPage], ['/home/campaigns/c1', CampaignPage], ['/home/samples/a%2Fb', SamplePage],
			['/home/operations/o1', OperationPage], ['/home/tests/t1', TestPage], ['/home/labels?ids=1,2', LabelsPage], ['/home/samples', IndexRoute],
		];
		for (const [path, component] of cases) {
			const r = resolveLink(path);
			expect(r.kind, path).toBe('route');
			if (r.kind === 'route') expect(router.resolve(r.to).matched.at(-1)?.components?.default, path).toBe(component);
		}
	});
	it('the pages are children of the shell route, so their relative paths work', () => {
		const shell = buildRoutes().find((r) => r.path === '/');
		expect(shell?.children?.map((c) => c.path)).toEqual(expect.arrayContaining(['', 'samples/:id', ':slug']));
	});
	it('the sign-in pages are public and outside the shell', () => {
		const router = memoryRouter();
		for (const p of ['/signin', '/signin/done']) {
			const r = router.resolve(p);
			expect(r.meta.public, p).toBe(true);
			expect(r.matched, p).toHaveLength(1);
		}
	});
	it('an old /home link redirects with its query and encoding', async () => {
		const router = memoryRouter();
		await router.push('/home/samples/a%2Fb?x=1');
		expect(router.currentRoute.value.fullPath).toBe('/samples/a%2Fb?x=1');
	});
});
```

In `packages/starbase-pages/src/hostNeutral.test.ts`, add a test inside the `describe`:

```ts
	it('leave the sticky offset to the host frame', () => {
		// The Data Studio header is 70px; STARbase's frame is not. Pages fall back to 70px, frames say.
		for (const f of files) expect(readFileSync(f, 'utf8'), rel(f)).not.toMatch(/--d1-sticky-top:\s*\d/);
	});
```

Run: `npm test -w starbase-web && npm test -w @d1/starbase-pages`
Expected: FAIL. `./router` is missing, and the guard names the five record pages.

- [ ] **Step 2: The sticky offset in the five record pages**

In each of `SamplePage.vue`, `OperationPage.vue`, `TestPage.vue`, `ProjectPage.vue` and
`CampaignPage.vue` (under `packages/starbase-pages/src/pages/`), replace

```vue
<RecordLayout style="--d1-sticky-top: 70px">
```

with

```vue
<RecordLayout style="--d1-sticky-top: var(--d1-header-offset, 70px)">
```

In `packages/d1-ui/src/components/RecordLayout.vue`, change the comment line
`// of the Directus header bar plus a gap on its own root (`style="--d1-sticky-top: 70px"`, with a`
and the next one so they read:

```ts
// of the host's header bar plus a gap on its own root (`style="--d1-sticky-top: var(--d1-header-offset, 70px)"`:
// the Data Studio header is 70px with its gap, and STARbase's PlainFrame sets --d1-header-offset), because only the host knows it.
```

- [ ] **Step 3: Context, router, frame, logo**

`apps/starbase/web/src/context.ts`:

```ts
import { inject, type InjectionKey } from 'vue';
import type { AxiosInstance } from 'axios';
import type { SessionGuard } from './api';
import type { Session } from './session';

// What main.ts builds once and the app's own components share (the shared pages use the Explorer host).
export interface AppContext {
	api: AxiosInstance;
	session: Session;
	guard: SessionGuard;
}

export const APP: InjectionKey<AppContext> = Symbol('starbase-app');

export function useApp(): AppContext {
	const ctx = inject(APP);
	if (!ctx) throw new Error('STARbase: no app context (main.ts provides it).');
	return ctx;
}
```

`apps/starbase/web/src/router.ts`:

```ts
import { createRouter, createWebHistory, type Router, type RouteRecordRaw } from 'vue-router';
import { starbaseRoutes } from '@d1/starbase-pages';
import AppShell from './AppShell.vue';
import SignInDone from './pages/SignInDone.vue';
import SignInPage from './pages/SignInPage.vue';
import { guardDecision, homeRedirect } from './guard';
import type { Session } from './session';

// STARbase's routes (spec §3.3): the sign-in pages on their own, old Directus-form links redirected, and
// every signed-in page inside the shell. starbaseRoutes are relative paths, so they must be children of a
// '/' route; extraChildren (the plot pages, Task 8) come first, and ':slug' stays last.
export function buildRoutes(extraChildren: RouteRecordRaw[] = []): RouteRecordRaw[] {
	return [
		{ path: '/signin', name: 'signin', component: SignInPage, meta: { public: true } },
		{ path: '/signin/done', name: 'signin-done', component: SignInDone, meta: { public: true } },
		{ path: '/home/:rest(.*)*', redirect: (to) => homeRedirect(to.fullPath) },
		{ path: '/', component: AppShell, children: [...extraChildren, ...starbaseRoutes] },
	];
}

export function createStarbaseRouter(session: Session, extraChildren: RouteRecordRaw[] = []): Router {
	const router = createRouter({ history: createWebHistory('/'), routes: buildRoutes(extraChildren) });
	router.beforeEach(async (to) => guardDecision(to, await session.ensure()));
	return router;
}
```

`apps/starbase/web/src/PlainFrame.vue`:

```vue
<script setup lang="ts">
import { watchEffect } from 'vue';

// STARbase's page frame (setPageFrame) and, from Task 8, its <private-view> for the plotters: the page's
// title row (with its headline crumbs, the title-outer:prepend slot People uses for its back button, and
// the actions) in a header that sticks to the top of the content column, then the page. Its root sets
// --d1-header-offset, which the record pages' sticky rail reads (they fall back to Data Studio's 70px).
const props = defineProps<{ title?: string }>();
watchEffect(() => {
	if (typeof document !== 'undefined') document.title = props.title ? `${props.title} · STARbase` : 'STARbase';
});
</script>

<template>
	<div class="sb-frame">
		<header class="sb-frame-head">
			<div v-if="$slots.headline" class="sb-headline"><slot name="headline" /></div>
			<div class="sb-title-row">
				<slot name="title-outer:prepend" />
				<h1 class="sb-title">{{ title }}</h1>
				<div class="sb-actions"><slot name="actions" /></div>
			</div>
		</header>
		<div class="sb-frame-body"><slot /></div>
	</div>
</template>

<style scoped>
.sb-frame { --d1-header-offset: 72px; min-height: 100%; }
.sb-frame-head {
	position: sticky; top: 0; z-index: 5; box-sizing: border-box; height: 64px; padding: 6px var(--content-padding, 32px) 0;
	display: flex; flex-direction: column; justify-content: center;
	background: var(--theme--background); border-bottom: 1px solid var(--theme--border-color-subdued);
}
.sb-headline { font-size: var(--fs-xs, 11px); color: var(--theme--foreground-subdued); }
.sb-headline :deep(.crumb) { cursor: pointer; }
.sb-title-row { display: flex; align-items: center; gap: 10px; min-width: 0; }
.sb-title { margin: 0; flex: 1 1 auto; min-width: 0; font-size: var(--fs-xl, 18px); font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sb-actions { display: flex; align-items: center; gap: 8px; }
@media (max-width: 767px) {
	.sb-frame-head { position: static; height: auto; min-height: 56px; padding-top: 8px; padding-bottom: 8px; }
	.sb-title { font-size: var(--fs-lg, 15px); white-space: normal; }
	.sb-actions { flex-wrap: wrap; }
}
</style>
```

`apps/starbase/web/src/BrandLogo.vue`:

```vue
<script setup lang="ts">
// The STAR group logo and the STARbase name (spec §3.3): dark text on the light theme, light text on the
// dark theme. `compact` shows only the star (the phone top bar).
defineProps<{ compact?: boolean }>();
</script>

<template>
	<span class="sb-logo" :class="{ compact }">
		<img v-if="compact" src="/brand/Star-Icon.svg" alt="" class="sb-mark" />
		<picture v-else>
			<source srcset="/brand/Star-logo-transparent-light.svg" media="(prefers-color-scheme: dark)" />
			<img src="/brand/Star-logo-transparent.svg" alt="STAR group" class="sb-wordmark" />
		</picture>
		<span class="sb-name">STARbase</span>
	</span>
</template>

<style scoped>
.sb-logo { display: inline-flex; align-items: center; gap: 10px; color: var(--theme--foreground); text-decoration: none; }
.sb-wordmark { height: 32px; width: auto; }
.sb-mark { height: 28px; width: 28px; }
.sb-name { font-size: var(--fs-lg, 15px); font-weight: 800; letter-spacing: 0.01em; }
</style>
```

- [ ] **Step 4: Shell, sign-in pages and the unreachable state**

`apps/starbase/web/src/AppShell.vue`:

```vue
<script setup lang="ts">
import { useRouter } from 'vue-router';
import { ExplorerNav, Finder, useFinderShortcut } from '@d1/ui';
import { openScan } from '@d1/starbase-pages';
import BrandLogo from './BrandLogo.vue';
import { getConfig } from './config';
import { useApp } from './context';

// STARbase's chrome around every signed-in page (spec §3.3): the brand, the Explorer sidebar (its rail and
// panel, from @d1/ui) and the finder (Ctrl/Cmd+K and the sidebar's box), then the page. Data Studio
// opens in a new tab. The phone layout is added in Task 9.
const { session } = useApp();
const router = useRouter();
const { finderOpen, openFinder, closeFinder } = useFinderShortcut();
const scanFromFinder = () => {
	closeFinder();
	openScan();
};
const studioHref = `${getConfig().directusUrl}/admin`;

async function signOut() {
	await session.signOut();
	await router.replace('/signin');
}
</script>

<template>
	<div class="sb-shell">
		<aside class="sb-side" aria-label="STARbase">
			<router-link to="/" class="sb-brand" aria-label="STARbase Home"><BrandLogo /></router-link>
			<ExplorerNav :show-brand="false" style="--d1-nav-offset: 64px" @open-finder="openFinder" />
			<div class="sb-foot">
				<a :href="studioHref" target="_blank" rel="noopener" class="sb-foot-link"><v-icon name="open_in_new" x-small left />Data Studio</a>
				<span class="sb-user">{{ session.user.value?.first_name ?? '' }}</span>
				<button type="button" class="sb-signout" @click="signOut"><v-icon name="logout" x-small left />Sign out</button>
			</div>
		</aside>
		<main class="sb-content"><router-view /></main>
		<Finder v-if="finderOpen" can-scan @close="closeFinder" @scan="scanFromFinder" />
	</div>
</template>

<style scoped>
.sb-shell { display: grid; grid-template-columns: 272px minmax(0, 1fr); height: 100dvh; }
.sb-side {
	display: flex; flex-direction: column; min-height: 0; overflow-y: auto;
	background: var(--theme--background-subdued); border-right: 1px solid var(--theme--border-color-subdued);
}
.sb-brand { display: flex; align-items: center; height: 64px; padding: 0 16px; flex: none; text-decoration: none; }
.sb-foot {
	margin-top: auto; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 12px 16px;
	border-top: 1px solid var(--theme--border-color-subdued); font-size: var(--fs-sm, 12px);
}
.sb-foot-link { color: var(--theme--foreground-subdued); text-decoration: none; }
.sb-user { margin-left: auto; color: var(--theme--foreground-subdued); }
.sb-signout { border: 0; background: none; padding: 4px; font: inherit; color: var(--theme--foreground); cursor: pointer; }
.sb-content { min-width: 0; height: 100dvh; overflow-y: auto; }
</style>
```

`apps/starbase/web/src/pages/SignInPage.vue`:

```vue
<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import BrandLogo from '../BrandLogo.vue';
import { getConfig } from '../config';
import { useApp } from '../context';
import { listProviders, providerLoginUrl, safeNext, signInErrorText, type AuthProvider } from '../session';

// STARbase's own sign-in page (spec §3.2): email and password into Directus's session (the same cookie
// Data Studio uses), and one button per SSO provider Directus offers.
const { api, session } = useApp();
const route = useRoute();
const router = useRouter();
const email = ref('');
const password = ref('');
const busy = ref(false);
const error = ref('');
const providers = ref<AuthProvider[]>([]);
const next = () => safeNext(route.query.next);

onMounted(async () => {
	providers.value = await listProviders(api);
});

async function submit() {
	if (busy.value) return;
	busy.value = true;
	error.value = '';
	try {
		await session.signIn(email.value.trim(), password.value);
		await router.replace(next());
	} catch (e) {
		error.value = signInErrorText(e);
	} finally {
		busy.value = false;
	}
}

const providerHref = (p: AuthProvider) => providerLoginUrl(getConfig().directusUrl, p.name, window.location.origin, next());
</script>

<template>
	<main class="sb-center">
		<form class="sb-card" @submit.prevent="submit">
			<BrandLogo />
			<h1>Sign in</h1>
			<label class="sb-field">Email<input v-model="email" type="email" autocomplete="username" required autofocus /></label>
			<label class="sb-field">Password<input v-model="password" type="password" autocomplete="current-password" required /></label>
			<p v-if="error" class="sb-error" role="alert">{{ error }}</p>
			<button type="submit" class="sb-primary" :disabled="busy">{{ busy ? 'Signing in…' : 'Sign in' }}</button>
			<template v-if="providers.length">
				<p class="sb-or">or</p>
				<a v-for="p in providers" :key="p.name" class="sb-provider" :href="providerHref(p)">Sign in with {{ p.label }}</a>
			</template>
			<p class="sb-hint">The same account as Data Studio. Signing in here signs you in there too.</p>
		</form>
	</main>
</template>
```

`apps/starbase/web/src/pages/SignInDone.vue`:

```vue
<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import BrandLogo from '../BrandLogo.vue';
import { useApp } from '../context';
import { safeNext, ssoErrorText } from '../session';

// Where an SSO sign-in comes back (spec §3.2, §4). Directus has set the session cookie, or says why not
// in ?reason=.
const { session } = useApp();
const route = useRoute();
const router = useRouter();
const problem = ref('');

onMounted(async () => {
	const reason = typeof route.query.reason === 'string' ? route.query.reason : '';
	if (reason) {
		problem.value = ssoErrorText(reason);
		return;
	}
	const state = await session.load();
	if (state === 'signed-in') await router.replace(safeNext(route.query.next));
	else if (state === 'unreachable') problem.value = "Can't reach the database to finish signing in.";
	else problem.value = 'The sign-in did not reach STARbase. Try again, or use your email and password.';
});
</script>

<template>
	<main class="sb-center">
		<div class="sb-card">
			<BrandLogo />
			<template v-if="problem">
				<h1>Sign-in didn't finish</h1>
				<p class="sb-error" role="alert">{{ problem }}</p>
				<router-link :to="{ path: '/signin', query: route.query.next ? { next: String(route.query.next) } : {} }" class="sb-primary">Back to sign in</router-link>
			</template>
			<p v-else role="status">Signing you in…</p>
		</div>
	</main>
</template>
```

`apps/starbase/web/src/pages/UnreachablePage.vue`:

```vue
<script setup lang="ts">
import BrandLogo from '../BrandLogo.vue';
import { getConfig } from '../config';

// d1-server did not answer (spec §4): a full page with a way forward, never an endless spinner.
defineProps<{ retrying?: boolean }>();
defineEmits<{ (e: 'retry'): void }>();
const server = getConfig().directusUrl;
</script>

<template>
	<main class="sb-center">
		<div class="sb-card" role="alert">
			<BrandLogo />
			<h1>Can't reach the database</h1>
			<p>STARbase couldn't reach d1-server at <code>{{ server }}</code>. Check that this device is on the tailnet, then try again.</p>
			<button type="button" class="sb-primary" :disabled="retrying" @click="$emit('retry')">{{ retrying ? 'Trying…' : 'Try again' }}</button>
		</div>
	</main>
</template>
```

`apps/starbase/web/src/App.vue`:

```vue
<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useApp } from './context';
import UnreachablePage from './pages/UnreachablePage.vue';

const { session } = useApp();
const router = useRouter();
const retrying = ref(false);

// After "Can't reach the database": ask again, then re-run the current navigation so the guard decides
// where it goes (the page, or /signin when the session is gone).
async function retry() {
	retrying.value = true;
	try {
		if ((await session.load()) === 'unreachable') return;
		const here = router.currentRoute.value;
		await router.replace({ path: here.path, query: here.query, hash: here.hash, force: true });
	} finally {
		retrying.value = false;
	}
}
</script>

<template>
	<UnreachablePage v-if="session.state.value === 'unreachable'" :retrying="retrying" @retry="retry" />
	<router-view v-else />
</template>
```

`apps/starbase/web/src/styles.css`:

```css
/* STARbase's base styles. The colours are the theme's (theme.css); pages bring their own (the kit's tokens.css). */
html, body, #app { height: 100%; margin: 0; }
body {
	background: var(--theme--background);
	color: var(--theme--foreground);
	font-family: var(--theme--fonts--sans--font-family);
	font-size: 13px;
	-webkit-text-size-adjust: 100%;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* The sign-in, SSO-return and unreachable pages: one centred card. */
.sb-center { min-height: 100dvh; display: grid; place-items: center; padding: 16px; box-sizing: border-box; }
.sb-card {
	width: min(380px, 100%); box-sizing: border-box; display: flex; flex-direction: column; gap: 12px; padding: 28px 24px;
	border: 1px solid var(--theme--border-color-subdued); border-radius: 14px; background: var(--theme--background-subdued);
}
.sb-card h1 { margin: 4px 0 0; font-size: 18px; }
.sb-field { display: flex; flex-direction: column; gap: 4px; font-weight: 600; font-size: 12px; }
.sb-field input {
	min-height: 38px; padding: 0 10px; font: inherit; font-weight: 400; font-size: 14px; color: var(--theme--foreground);
	border: 1px solid var(--theme--form--field--input--border-color); border-radius: 8px; background: var(--theme--form--field--input--background);
}
.sb-primary {
	display: inline-flex; justify-content: center; align-items: center; min-height: 40px; border: 0; border-radius: 8px;
	background: var(--theme--primary); color: var(--theme--foreground-inverted); font: inherit; font-weight: 700; text-decoration: none; cursor: pointer;
}
.sb-primary:disabled { opacity: 0.6; }
.sb-provider {
	display: flex; justify-content: center; align-items: center; min-height: 38px; border-radius: 8px; text-decoration: none;
	border: 1px solid var(--theme--border-color); color: var(--theme--foreground);
}
.sb-or { margin: 0; text-align: center; color: var(--theme--foreground-subdued); }
.sb-error { margin: 0; color: var(--theme--danger); }
.sb-hint { margin: 0; font-size: 12px; color: var(--theme--foreground-subdued); }
```

- [ ] **Step 5: The real boot**

`apps/starbase/web/src/main.ts` (whole file):

```ts
import { createApp, watch } from 'vue';
import { setPageFrame } from '@d1/starbase-pages';
// Bundled, not a CDN: Material Symbols as in the Force App (no network dependency for every icon).
import 'material-symbols/rounded.css';
import './theme.css';
import './styles.css';
import App from './App.vue';
import PlainFrame from './PlainFrame.vue';
import { createApi, installSessionGuard } from './api';
import { loadRuntimeConfig } from './config';
import { APP } from './context';
import { installStarbaseHost } from './host';
import { createStarbaseRouter } from './router';
import { createSession } from './session';
import { registerStandins } from './standins/register';

async function bootstrap() {
	const config = await loadRuntimeConfig();
	const api = createApi(config.directusUrl);
	const session = createSession(api);
	const router = createStarbaseRouter(session);

	// Any request that finds the session gone (signed out here, in Data Studio, or expired) lands on the
	// sign-in page, coming back to where it was (spec §4).
	const guard = installSessionGuard(api, () => {
		session.markSignedOut();
		const here = router.currentRoute.value;
		if (here.name === 'signin' || here.name === 'signin-done') return;
		void router.replace(here.fullPath === '/' ? '/signin' : `/signin?next=${encodeURIComponent(here.fullPath)}`);
	});

	setPageFrame(PlainFrame);
	// One Explorer host per signed-in user. 'sync' so it exists before the first page's setup runs (the
	// guard sets the user, then the navigation renders the page).
	watch(
		() => session.user.value?.id,
		(id) => {
			if (id) installStarbaseHost({ api, session, router, directusUrl: config.directusUrl });
		},
		{ flush: 'sync', immediate: true },
	);

	const app = createApp(App);
	app.provide(APP, { api, session, guard });
	registerStandins(app);
	app.use(router);
	app.mount('#app');
}

void bootstrap();
```

- [ ] **Step 6: Run the tests**

```bash
npm test -w starbase-web && npm run typecheck -w starbase-web && npm run build -w starbase-web
npm test -w @d1/starbase-pages && npm run typecheck -w @d1/starbase-pages
npm test -w @d1/ui && npm run typecheck -w @d1/ui
```

Expected: every test passes, the typechecks are clean, and the build succeeds.

- [ ] **Step 7: See it on the preview**

`tests/ui/starbase/preview-ports.env`. This is what the preview Directus needs so STARbase on
`127.0.0.1:5190` can use its session (spec §5): same host, different ports, so the cookie is
same-site, and it is not Secure, because this is plain HTTP.

```
CORS_ENABLED=true
CORS_ORIGIN=http://127.0.0.1:5190
CORS_CREDENTIALS=true
CONTENT_SECURITY_POLICY_DIRECTIVES__FRAME_ANCESTORS='self' http://127.0.0.1:5190
SESSION_COOKIE_SECURE=false
```

```bash
npm run build:extensions
export D1_PREVIEW_NAME=d1-starbase D1_PREVIEW_PORT=18057 D1_PREVIEW_ENV_FILE=tests/ui/starbase/preview-ports.env
export D1_PREVIEW_OVERLAY="d1-home d1-admin-overview d1-fast-dashboard d1-campaign-ops d1-lab-dashboard d1-project-items d1-usage"
bash scripts/dev/explorer_preview.sh --stop; bash scripts/dev/explorer_preview.sh
```

Start STARbase in the background with `run_in_background`:
`VITE_DIRECTUS_URL=http://127.0.0.1:18057 npm run dev -w starbase-web`.

In the Browser pane, open `http://127.0.0.1:5190/samples` and check each of these:
- It goes to `/signin?next=%2Fsamples`, which shows the logo and the form.
- Sign in as the member from `.superpowers/preview-credentials-d1-starbase.txt`. You land on
  `/samples`, with the sidebar, the page title "Samples" in the header and the list.
- Open one sample. The rail sticks under the header while the page scrolls.
- Ctrl+K opens the finder, and Esc closes it.
- On People, open a person. The `v-dialog` opens, and Ctrl+K does nothing while it is open.
- Open `http://127.0.0.1:18057/admin/content` in a new tab. Data Studio is already signed in.
- Click **Sign out** in STARbase, and reload the Data Studio tab. It is at the login page.
- Unreachable: run `docker stop d1-starbase-directus`, then reload STARbase.
  - Expect "Can't reach the database" with **Try again**, and not `/signin`.
  - Run `docker start d1-starbase-directus`, wait for `curl -fs http://127.0.0.1:18057/server/health`,
    then click **Try again**. You land on `/signin` (signed out) or on the page.

Use `get_page_text` for each check, and one screenshot of a record page.

- [ ] **Step 8: The Directus regression run, then commit**

```bash
CREDS="$PWD/.superpowers/preview-credentials-d1-starbase.txt"
(cd tests/ui && D1_ROUTES_CREDENTIALS="$CREDS" npx playwright test specs/13-explorer-routes.spec.ts --retries=0)
```

Expected: `4 passed`, because the record pages' 70px fallback is unchanged in Directus. Open one
Directus record page and check that the rail still sticks under the Data Studio header.

```bash
git add apps/starbase/web packages/starbase-pages/src packages/d1-ui/src/components/RecordLayout.vue tests/ui/starbase/preview-ports.env
git commit -m "feat(starbase): shell, sign-in pages, router and page frame; record pages take the sticky offset from their frame

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin HEAD:feat/explorer-standalone
```

---
### Task 6: The edit frame, Directus side (`d1-edit-frame` and its message protocol)

The new Directus module page `/admin/d1-edit/<collection>/<id>` renders only Directus's `v-form`
for one record, with Save and Cancel, and no `private-view`. Step 0 showed that such a page has no
module bar. It tells the STARbase window that framed it, or the STARbase tab that opened it, that it
is ready, saved or cancelled. It only ever posts to the exact origin it was given. `+` as the id
creates a record.

**Files:**
- Create: `packages/d1-ui/src/editFrame.ts`, `packages/d1-ui/src/editFrame.test.ts`
- Modify: `packages/d1-ui/src/editDrawer.ts` (add `createFormFields`), `packages/d1-ui/src/editDrawer.test.ts`
- Modify: `packages/d1-ui/package.json` (`exports`: `./editDrawer`, `./editFrame`), `packages/d1-ui/src/index.ts` (export the editFrame names)
- Create: `core/extensions/d1-edit-frame/package.json`, `tsconfig.json`, `src/index.ts`, `src/EditFramePage.vue`
- Modify: root `package.json` (`workspaces`, `build:extensions`), `.github/scripts/ci-plan.mjs`, `.github/scripts/ci-plan.test.mjs`, `.github/workflows/ci.yml`, `.claude/skills/ci-local/scripts/plan_checks.sh`
- Modify: `core/README.md` (the module row)

**Interfaces:**
- Produces in `@d1/ui`. These are also importable as `@d1/ui/editFrame`, with no Vue components
  pulled in:

```ts
export const EDIT_MESSAGE_TYPE = 'd1-edit';
export const NEW_ITEM_ID = '+';
export type EditResult = 'ready' | 'saved' | 'cancelled';
export interface EditMessage { type: 'd1-edit'; result: EditResult; collection: string; id: string }
export interface ExpectedEditSource { origin: string; source: unknown; collection: string; id: string }
export function editFrameUrl(serverBase: string, collection: string, id: string, parentOrigin: string): string;
export function parentOriginFrom(search: string): string | null;
export function editMessage(result: EditResult, collection: string, id: string): EditMessage;
export function isEditMessage(data: unknown): data is EditMessage;
export function readEditMessage(event: { origin: string; source: unknown; data: unknown }, expected: ExpectedEditSource): EditMessage | null;
// editDrawer.ts (also as @d1/ui/editDrawer)
export function createFormFields(fields: FieldDef[], hidden?: string[]): FieldDef[];
```

- The Directus module has `id: 'd1-edit'` and `hidden: true`, and its route is
  `:collection/:id` (props).

- [ ] **Step 1: Write the failing tests**

`packages/d1-ui/src/editFrame.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { editFrameUrl, editMessage, isEditMessage, NEW_ITEM_ID, parentOriginFrom, readEditMessage } from './editFrame';

const D1 = 'https://d1-server.tail54eeb6.ts.net';
const STAR = 'https://starbase.tail54eeb6.ts.net';

describe('editFrameUrl', () => {
	it("is d1-server's form-only page, with STARbase's origin to answer to", () => {
		expect(editFrameUrl(`${D1}/`, 'physical_samples', 'abc', STAR)).toBe(
			`${D1}/admin/d1-edit/physical_samples/abc?parent=${encodeURIComponent(STAR)}`,
		);
	});
	it('encodes an id with a slash, a space or a percent, and the frame gets the same id back (Review Focus 4)', () => {
		const url = editFrameUrl(D1, 'physical_samples', 'a/b c%', STAR);
		expect(url).toContain('/admin/d1-edit/physical_samples/a%2Fb%20c%25?');
		const segment = new URL(url).pathname.split('/').pop()!;
		expect(decodeURIComponent(segment)).toBe('a/b c%');
	});
	it("keeps '+' (a new record) as Data Studio writes it", () => {
		expect(editFrameUrl(D1, 'projects', NEW_ITEM_ID, STAR)).toContain('/admin/d1-edit/projects/+?parent=');
	});
});

describe('parentOriginFrom', () => {
	it('accepts an exact http(s) origin', () => {
		expect(parentOriginFrom(`?parent=${encodeURIComponent(STAR)}`)).toBe(STAR);
		expect(parentOriginFrom(`?parent=${encodeURIComponent('http://127.0.0.1:5190')}`)).toBe('http://127.0.0.1:5190');
	});
	it('refuses anything that is not exactly an origin', () => {
		for (const p of [`${STAR}/samples`, `${STAR}/`, 'javascript:alert(1)', 'https://user@starbase.example', '*', '', 'null']) {
			expect(parentOriginFrom(`?parent=${encodeURIComponent(p)}`), p).toBeNull();
		}
		expect(parentOriginFrom('')).toBeNull();
	});
});

describe('readEditMessage (Review Focus 4)', () => {
	const frame = { name: 'the frame' };
	const expected = { origin: D1, source: frame, collection: 'physical_samples', id: 's1' };
	const ev = (data: unknown, origin = D1, source: unknown = frame) => ({ data, origin, source });

	it('accepts the frame telling about the record it was opened for', () => {
		expect(readEditMessage(ev(editMessage('saved', 'physical_samples', 's1')), expected)).toEqual(editMessage('saved', 'physical_samples', 's1'));
		expect(readEditMessage(ev(editMessage('ready', 'physical_samples', 's1')), expected)?.result).toBe('ready');
	});
	it('ignores another origin, another window, no window, another record and malformed data', () => {
		const ok = editMessage('saved', 'physical_samples', 's1');
		expect(readEditMessage(ev(ok, STAR), expected)).toBeNull();
		expect(readEditMessage(ev(ok, D1, { name: 'another tab' }), expected)).toBeNull();
		expect(readEditMessage(ev(ok, D1, null), { ...expected, source: null })).toBeNull();
		expect(readEditMessage(ev(editMessage('saved', 'projects', 's1')), expected)).toBeNull();
		expect(readEditMessage(ev(editMessage('saved', 'physical_samples', 's2')), expected)).toBeNull();
		for (const bad of [null, 'saved', { type: 'd1-edit', result: 'deleted', collection: 'physical_samples', id: 's1' }, { type: 'x', result: 'saved', collection: 'physical_samples', id: 's1' }]) {
			expect(readEditMessage(ev(bad), expected)).toBeNull();
		}
	});
	it("a new record ('+') comes back saved under its new id; cancelling keeps '+'", () => {
		const create = { ...expected, id: NEW_ITEM_ID };
		expect(readEditMessage(ev(editMessage('saved', 'physical_samples', 'new-1')), create)?.id).toBe('new-1');
		expect(readEditMessage(ev(editMessage('cancelled', 'physical_samples', NEW_ITEM_ID)), create)?.result).toBe('cancelled');
		expect(readEditMessage(ev(editMessage('cancelled', 'physical_samples', 'other')), create)).toBeNull();
	});
	it('isEditMessage checks the shape only', () => {
		expect(isEditMessage(editMessage('cancelled', 'c', '1'))).toBe(true);
		expect(isEditMessage({ type: 'd1-edit', result: 'saved', collection: 'c' })).toBe(false);
	});
});
```

Add to `packages/d1-ui/src/editDrawer.test.ts`. Put `createFormFields` into its existing
`import { … } from './editDrawer';`, then append:

```ts
describe('createFormFields', () => {
	it("a new record ('+') offers every field but the system ones and the hidden ones", () => {
		expect(createFormFields(defs).map((f) => f.field)).toEqual(['sample_id', 'sample_code', 'owner', 'data_files_open']);
		expect(createFormFields(defs, ['owner']).map((f) => f.field)).toEqual(['sample_id', 'sample_code', 'data_files_open']);
	});
	it('formFields would show nothing for a new record, which is why create has its own rule', () => {
		expect(formFields(defs, null)).toEqual([]);
	});
});
```

Run: `npm test -w @d1/ui -- editFrame editDrawer`
Expected: FAIL. `./editFrame` is missing, and `createFormFields` is not exported.

- [ ] **Step 2: Implement the protocol and `createFormFields`**

`packages/d1-ui/src/editFrame.ts`:

```ts
// The edit frame's messages (spec §3.4). d1-server's form-only page /admin/d1-edit/<collection>/<id>
// tells the window that opened it (STARbase's edit dialog, or the STARbase tab that opened it as a new
// tab) that it is ready, saved or cancelled. Origins are checked both ways:
//   - the frame posts only to the exact origin it was given in ?parent= (and Directus's frame-ancestors
//     decides who may frame the page at all), never to '*';
//   - STARbase reads only messages from d1-server's origin, from its own frame or tab, about the record
//     it opened (readEditMessage).

export const EDIT_MESSAGE_TYPE = 'd1-edit';
// Data Studio's id for "a new record".
export const NEW_ITEM_ID = '+';

export type EditResult = 'ready' | 'saved' | 'cancelled';

export interface EditMessage {
	type: typeof EDIT_MESSAGE_TYPE;
	result: EditResult;
	collection: string;
	id: string;
}

export interface ExpectedEditSource {
	origin: string;
	source: unknown;
	collection: string;
	id: string;
}

export function editFrameUrl(serverBase: string, collection: string, id: string, parentOrigin: string): string {
	const base = serverBase.replace(/\/+$/, '');
	const key = id === NEW_ITEM_ID ? NEW_ITEM_ID : encodeURIComponent(id);
	return `${base}/admin/d1-edit/${encodeURIComponent(collection)}/${key}?parent=${encodeURIComponent(parentOrigin)}`;
}

// The frame's own ?parent=, if it is exactly an http(s) origin (no path, no user, no trailing slash).
export function parentOriginFrom(search: string): string | null {
	const raw = new URLSearchParams(search).get('parent');
	if (!raw) return null;
	try {
		const u = new URL(raw);
		if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
		return u.origin === raw ? raw : null;
	} catch {
		return null;
	}
}

export function editMessage(result: EditResult, collection: string, id: string): EditMessage {
	return { type: EDIT_MESSAGE_TYPE, result, collection, id };
}

export function isEditMessage(data: unknown): data is EditMessage {
	if (!data || typeof data !== 'object') return false;
	const d = data as Record<string, unknown>;
	return (
		d.type === EDIT_MESSAGE_TYPE &&
		(d.result === 'ready' || d.result === 'saved' || d.result === 'cancelled') &&
		typeof d.collection === 'string' &&
		typeof d.id === 'string'
	);
}

// A message STARbase may act on, or null. A new record ('+') comes back 'saved' under its new id.
export function readEditMessage(event: { origin: string; source: unknown; data: unknown }, expected: ExpectedEditSource): EditMessage | null {
	if (event.origin !== expected.origin) return null;
	if (!expected.source || event.source !== expected.source) return null;
	if (!isEditMessage(event.data)) return null;
	const m = event.data;
	if (m.collection !== expected.collection) return null;
	const sameRecord = m.id === expected.id || (expected.id === NEW_ITEM_ID && m.result === 'saved');
	return sameRecord ? m : null;
}
```

In `packages/d1-ui/src/editDrawer.ts`, after `formFields`, add:

```ts
// A new record ('+'): every field the user could fill in, that is all but the system fields and the ones
// the caller hides. formFields cannot be used: with no item yet, it would show nothing. The form itself
// (v-form) leaves out hidden-in-form fields and shows read-only ones disabled.
export function createFormFields(fields: FieldDef[], hidden: string[] = []): FieldDef[] {
	return fields.filter((f) => !f.meta?.system && !hidden.includes(f.field));
}
```

In `packages/d1-ui/package.json`, change `exports` to:

```json
  "exports": {
    ".": "./src/index.ts",
    "./recordRoute": "./src/recordRoute.ts",
    "./editDrawer": "./src/editDrawer.ts",
    "./editFrame": "./src/editFrame.ts"
  },
```

In `packages/d1-ui/src/index.ts`, after the `EditDrawer` component export, add:

```ts
export {
	EDIT_MESSAGE_TYPE, NEW_ITEM_ID, editFrameUrl, editMessage, isEditMessage, parentOriginFrom, readEditMessage,
} from './editFrame';
export type { EditMessage, EditResult, ExpectedEditSource } from './editFrame';
export { createFormFields } from './editDrawer';
```

Run: `npm test -w @d1/ui && npm run typecheck -w @d1/ui`
Expected: all pass.

- [ ] **Step 3: The Directus module**

```bash
mkdir -p core/extensions/d1-edit-frame/src
cp core/extensions/d1-home/tsconfig.json core/extensions/d1-edit-frame/tsconfig.json
```

`core/extensions/d1-edit-frame/package.json`:

```json
{
  "name": "directus-extension-d1-edit-frame",
  "version": "1.0.0",
  "type": "module",
  "description": "The form-only record page STARbase frames: /admin/d1-edit/<collection>/<id>, Directus's own v-form with Save and Cancel, no module bar or navigation (spec §3.4).",
  "scripts": {
    "build": "directus-extension build",
    "dev": "directus-extension build --watch",
    "typecheck": "vue-tsc --noEmit"
  },
  "keywords": ["directus", "directus-extension", "directus-custom-module"],
  "devDependencies": {
    "@directus/extensions-sdk": "^17",
    "@vue/compiler-sfc": "^3.5.43",
    "typescript": "^7",
    "vue": "^3",
    "vue-tsc": "^2.2.0"
  },
  "directus:extension": {
    "type": "module",
    "path": "dist/index.js",
    "source": "src/index.ts",
    "host": "^11.0.0"
  },
  "dependencies": {
    "@d1/ui": "*"
  }
}
```

`core/extensions/d1-edit-frame/src/index.ts`:

```ts
import { defineModule } from '@directus/extensions-sdk';
import EditFramePage from './EditFramePage.vue';

// The form-only record page that STARbase frames (spec §3.4). Step 0 (spec §9, check b) showed that a
// module page without <private-view> renders with no module bar or navigation. Hidden from the module
// bar: it is only ever opened by URL, /admin/d1-edit/<collection>/<id>?parent=<STARbase origin>.
export default defineModule({
	id: 'd1-edit',
	name: 'Edit (STARbase)',
	icon: 'edit_note',
	hidden: true,
	routes: [{ path: ':collection/:id', component: EditFramePage, props: true }],
});
```

`core/extensions/d1-edit-frame/src/EditFramePage.vue`:

```vue
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useApi, useStores } from '@directus/extensions-sdk';
// Subpath imports: the pure helpers only, not the kit's Vue components.
import { buildPatch, createFormFields, formFields, saveErrors, versionChanged, type FieldDef } from '@d1/ui/editDrawer';
import { editMessage, NEW_ITEM_ID, parentOriginFrom, type EditResult } from '@d1/ui/editFrame';

// One record in Directus's own form (v-form: every custom interface works), with Save and Cancel and
// nothing else, for STARbase to frame. The same checks as the kit's EditDrawer: only changed fields
// are PATCHed, the OCC version is re-read before saving, and a refusal says why.
const props = defineProps<{ collection: string; id: string }>();

const api = useApi();
const fieldsStore = useStores().useFieldsStore();
const parentOrigin = parentOriginFrom(window.location.search);
const creating = computed(() => props.id === NEW_ITEM_ID);

const item = ref<Record<string, any> | null>(null);
const fields = ref<FieldDef[]>([]);
const edits = ref<Record<string, any>>({});
const loading = ref(true);
const loadError = ref('');
const saving = ref(false);
const saveError = ref<string[]>([]);
const conflict = ref<{ loaded: number; current: number } | null>(null);
const confirmDiscard = ref(false);
const done = ref<'' | 'saved' | 'cancelled'>('');
const hasEdits = computed(() => buildPatch(edits.value) !== null);
const endpoint = () => `/items/${props.collection}/${encodeURIComponent(props.id)}`;
const primaryKeyField = computed(() => fields.value.find((f) => f.schema?.is_primary_key)?.field ?? 'id');
const framed = window.parent !== window;

// Tell STARbase: the page framing this one, or the STARbase tab that opened it in a new tab. Only to
// the exact origin from ?parent= (none, or not a valid origin: tell nobody).
function tell(result: EditResult, id = props.id) {
	if (!parentOrigin) return;
	const target: Window | null = framed ? window.parent : window.opener;
	target?.postMessage(editMessage(result, props.collection, id), parentOrigin);
}

function messageOf(e: any): string {
	return e?.response?.data?.errors?.[0]?.message ?? e?.message ?? 'unknown error';
}

async function load() {
	loading.value = true;
	loadError.value = '';
	conflict.value = null;
	edits.value = {};
	try {
		const defs = fieldsStore.getFieldsForCollectionSorted(props.collection) as unknown as FieldDef[];
		if (creating.value) {
			item.value = {};
			fields.value = createFormFields(defs);
		} else {
			const res = await api.get(endpoint(), { params: { fields: ['*'] } });
			item.value = res.data.data;
			fields.value = formFields(defs, item.value);
		}
	} catch (e) {
		loadError.value = `Could not load the record: ${messageOf(e)}`;
	} finally {
		loading.value = false;
	}
}

function finish(result: 'saved' | 'cancelled', id = props.id) {
	done.value = result;
	tell(result, id);
	// Opened as a tab by STARbase (the fallback): close it, the STARbase tab takes over.
	if (!framed && window.opener) window.close();
}

async function save(overwrite = false) {
	const patch = buildPatch(edits.value);
	if (saving.value || (!patch && !creating.value)) return;
	saving.value = true;
	saveError.value = [];
	try {
		if (creating.value) {
			const res = await api.post(`/items/${props.collection}`, patch ?? {});
			finish('saved', String(res.data?.data?.[primaryKeyField.value] ?? ''));
			return;
		}
		// occ_update_trigger_function() bumps `version` on every update: a different number means someone
		// else saved while this form was open.
		if (!overwrite && item.value && 'version' in item.value) {
			const res = await api.get(endpoint(), { params: { fields: ['version'] } });
			const current = res.data.data?.version;
			if (versionChanged(item.value.version, current)) {
				conflict.value = { loaded: Number(item.value.version), current: Number(current) };
				return;
			}
		}
		conflict.value = null;
		await api.patch(endpoint(), patch);
		finish('saved');
	} catch (e) {
		saveError.value = saveErrors(e, props.collection);
	} finally {
		saving.value = false;
	}
}

function cancel() {
	if (hasEdits.value) confirmDiscard.value = true;
	else finish('cancelled');
}

function discard() {
	confirmDiscard.value = false;
	finish('cancelled');
}

onMounted(() => {
	// Rendering at all means Directus has a session here: STARbase stops waiting (its "ready" timeout).
	tell('ready');
	void load();
});
</script>

<template>
	<div class="d1-edit-frame">
		<header class="bar">
			<h1>{{ creating ? 'New record' : 'Edit record' }} <small>{{ collection }}</small></h1>
			<div v-if="!done" class="actions">
				<v-button secondary :disabled="saving" @click="cancel">Cancel</v-button>
				<v-button :loading="saving" :disabled="loading || (!hasEdits && !creating)" @click="save()">Save</v-button>
			</div>
		</header>

		<main class="body">
			<v-notice v-if="done === 'saved'" type="success">Saved.{{ framed ? '' : ' You can close this tab.' }}</v-notice>
			<v-notice v-else-if="done === 'cancelled'" type="info">Nothing was saved.{{ framed ? '' : ' You can close this tab.' }}</v-notice>
			<v-notice v-else-if="loadError" type="danger">{{ loadError }}</v-notice>
			<v-progress-linear v-else-if="loading" indeterminate />
			<template v-else-if="item">
				<v-notice v-if="conflict" type="warning" class="notice">
					Someone else saved this record while you were editing (version {{ conflict.loaded }} is now {{ conflict.current }}).
					Saving now would overwrite their changes.
					<span class="conflict-actions">
						<v-button small secondary @click="load()">Discard mine and reload</v-button>
						<v-button small @click="save(true)">Save anyway</v-button>
					</span>
				</v-notice>
				<v-notice v-for="msg in saveError" :key="msg" type="danger" class="notice">{{ msg }}</v-notice>
				<v-form v-model="edits" :fields="fields" :initial-values="item" :primary-key="creating ? NEW_ITEM_ID : id" :disabled="saving" />
			</template>
		</main>

		<v-dialog v-model="confirmDiscard" @esc="confirmDiscard = false">
			<v-card>
				<v-card-title>Discard your changes?</v-card-title>
				<v-card-text>The edits you made to this record have not been saved.</v-card-text>
				<v-card-actions>
					<v-button secondary @click="confirmDiscard = false">Keep editing</v-button>
					<v-button kind="danger" @click="discard">Discard</v-button>
				</v-card-actions>
			</v-card>
		</v-dialog>
	</div>
</template>

<style scoped>
.d1-edit-frame { min-height: 100vh; background: var(--theme--background); color: var(--theme--foreground); }
.bar {
	position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 12px; padding: 12px 24px;
	background: var(--theme--background); border-bottom: 1px solid var(--theme--border-color-subdued);
}
.bar h1 { flex: 1 1 auto; margin: 0; font-size: 18px; }
.bar small { font-weight: 400; color: var(--theme--foreground-subdued); }
.actions { display: flex; gap: 8px; }
.body { padding: 20px 24px 64px; }
.notice { margin-bottom: 16px; }
.conflict-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
</style>
```

In `core/README.md`, in the **module** row of the extensions table, add after `d1-fast-dashboard (FAST sintering traces)`:
`, d1-edit-frame (hidden; /admin/d1-edit/<collection>/<id>, one record's form with Save and Cancel and no navigation, framed by STARbase)`.
In the line listing the workspace extensions (line 46, beginning `` `d1-home`, `d1-lab-dashboard` ``),
add `` `d1-edit-frame` ``.

- [ ] **Step 4: Workspace and CI**

- Root `package.json`:
  - add `"core/extensions/d1-edit-frame"` to `workspaces`, after `"core/extensions/d1-home"`;
  - in `build:extensions`, add ` -w directus-extension-d1-edit-frame` after
    `-w directus-extension-d1-home`.
- `.github/scripts/ci-plan.mjs`: in `directusUi`, add `'core/extensions/d1-edit-frame/'` after
  `'core/extensions/d1-home/'`.
- `.github/scripts/ci-plan.test.mjs`: add:

```js
test('the edit frame module plans the directusUi job', () => {
  assert.equal(plan(['core/extensions/d1-edit-frame/src/EditFramePage.vue'], EXT).directusUi, true);
});
```

- `.github/workflows/ci.yml`, `directus-ui` job, step "Typecheck the Explorer pages, the lab
  dashboard and the campaign interface": add the line
  `npm run typecheck -w directus-extension-d1-edit-frame`.
- `.claude/skills/ci-local/scripts/plan_checks.sh`, the directus-ui line:
  - in the regex, change `core/extensions/(d1-home|` to `core/extensions/(d1-home|d1-edit-frame|`;
  - in the echoed command, change `-w directus-extension-d1-campaign-ops &&` to
    `-w directus-extension-d1-campaign-ops -w directus-extension-d1-edit-frame &&`.

```bash
npm install
npm run typecheck -w directus-extension-d1-edit-frame
npm run build -w directus-extension-d1-edit-frame
node --test .github/scripts/ci-plan.test.mjs
```

Expected:
- the typecheck is clean;
- `core/extensions/d1-edit-frame/dist/index.js` is written;
- the ci-plan tests pass.

- [ ] **Step 5: Check it on the preview, as a top-level page**

```bash
npm run build:extensions
export D1_PREVIEW_NAME=d1-starbase D1_PREVIEW_PORT=18057 D1_PREVIEW_ENV_FILE=tests/ui/starbase/preview-ports.env
export D1_PREVIEW_OVERLAY="d1-home d1-admin-overview d1-fast-dashboard d1-campaign-ops d1-lab-dashboard d1-project-items d1-usage d1-edit-frame"
bash scripts/dev/explorer_preview.sh --stop; bash scripts/dev/explorer_preview.sh
```

In the Browser pane, sign in to `http://127.0.0.1:18057/admin` as the admin. Pick a sample id
with `GET /items/physical_samples?limit=1&fields=sample_id`, then open
`http://127.0.0.1:18057/admin/d1-edit/physical_samples/<id>?parent=http%3A%2F%2F127.0.0.1%3A5190`.

Check:
- `document.querySelectorAll('.module-bar').length` is `0` (use `javascript_tool`);
- the form's fields are visible (`.v-form .field` count > 0);
- change one text field and Save. "Saved." appears, and `GET /items/physical_samples/<id>` shows the
  new value. Put the old value back the same way. This is the copy, so writing to it is allowed;
- `http://127.0.0.1:18057/admin/d1-edit/projects/+` shows an empty form with fields.

- [ ] **Step 6: The Directus regression run, then commit**

```bash
CREDS="$PWD/.superpowers/preview-credentials-d1-starbase.txt"
(cd tests/ui && D1_ROUTES_CREDENTIALS="$CREDS" npx playwright test specs/13-explorer-routes.spec.ts --retries=0)
```

Expected: `4 passed`.

```bash
git add packages/d1-ui core/extensions/d1-edit-frame core/README.md package.json package-lock.json .github .claude/skills/ci-local/scripts/plan_checks.sh
git commit -m "feat(edit-frame): a form-only Directus page STARbase frames, and the message protocol both sides check

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin HEAD:feat/explorer-standalone
```

---

### Task 7: Editing from STARbase (`openEditor`, the dialog, the new-tab fallback)

**Files:**
- Modify: `packages/d1-ui/src/host.ts` (optional `openEditor`), `packages/d1-ui/src/editDrawer.ts` (`editMode`), `packages/d1-ui/src/editDrawer.test.ts`, `packages/d1-ui/src/components/EditDrawer.vue`, `packages/d1-ui/src/index.ts`
- Create: `apps/starbase/web/src/editor/editor.ts`, `src/editor/editor.test.ts`, `src/editor/browserEditor.ts`, `src/editor/EditorDialog.vue`
- Modify: `apps/starbase/web/src/host.ts`, `src/host.test.ts`, `src/context.ts`, `src/App.vue`, `src/main.ts`

**Interfaces:**
- Consumes: `editFrameUrl` and `readEditMessage` from `@d1/ui` (Task 6).
- Produces:

```ts
// @d1/ui host.ts, on ExplorerHost:
openEditor?(collection: string, id: string): Promise<'saved' | 'cancelled'>;
// @d1/ui editDrawer.ts
export type EditMode = 'host' | 'drawer' | 'data-studio';
export function editMode(hostEditor: boolean, formAvailable: () => boolean): EditMode;
// apps/starbase/web/src/editor/editor.ts
export type EditorPhase = 'closed' | 'loading' | 'ready' | 'refused' | 'tab';
export interface EditorState { phase: EditorPhase; url: string; collection: string; id: string; blocked: boolean }
export interface EditorDeps { serverBase: string; appOrigin: string; readyTimeoutMs?: number;
  openTab(url: string): Window | null; onWindowFocus(cb: () => void): () => void }
export const READY_TIMEOUT_MS = 8000;
export function createEditor(deps: EditorDeps): Editor;  // { state, open, attachFrame, onMessage, openInTab, close, done }
export function createBrowserEditor(serverBase: string): Editor;
// context.ts: AppContext gains `editor: Editor`.
```

- [ ] **Step 1: Write the failing tests**

`apps/starbase/web/src/editor/editor.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { editMessage } from '@d1/ui';
import { createEditor, READY_TIMEOUT_MS } from './editor';

const D1 = 'https://d1-server.tail54eeb6.ts.net';
const STAR = 'https://starbase.tail54eeb6.ts.net';

function setup(tab: object | null = { name: 'tab' }) {
	let focus: (() => void) | null = null;
	const openTab = vi.fn(() => tab as Window | null);
	const editor = createEditor({ serverBase: D1, appOrigin: STAR, openTab, onWindowFocus: (cb) => ((focus = cb), () => (focus = null)) });
	const frame = { name: 'frame' };
	editor.attachFrame(() => frame);
	return { editor, frame, openTab, focus: () => focus?.() };
}
const from = (source: unknown, data: unknown, origin = D1) => ({ origin, source, data });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('the edit dialog', () => {
	it('opens the frame on the record, and a saved message closes it with "saved"', async () => {
		const { editor, frame } = setup();
		const done = editor.open('physical_samples', 'a/b');
		expect(editor.state.phase).toBe('loading');
		expect(editor.state.url).toBe(`${D1}/admin/d1-edit/physical_samples/a%2Fb?parent=${encodeURIComponent(STAR)}`);
		editor.onMessage(from(frame, editMessage('ready', 'physical_samples', 'a/b')));
		expect(editor.state.phase).toBe('ready');
		editor.onMessage(from(frame, editMessage('saved', 'physical_samples', 'a/b')));
		await expect(done).resolves.toBe('saved');
		expect(editor.state.phase).toBe('closed');
	});

	it('cancel in the frame, or closing the dialog, is "cancelled"', async () => {
		const { editor, frame } = setup();
		const a = editor.open('projects', 'p1');
		editor.onMessage(from(frame, editMessage('cancelled', 'projects', 'p1')));
		await expect(a).resolves.toBe('cancelled');
		const b = editor.open('projects', 'p1');
		editor.close();
		await expect(b).resolves.toBe('cancelled');
	});

	it('no ready message in time: offer a new tab; coming back to STARbase counts as saved (Review Focus 3)', async () => {
		const { editor, openTab, focus } = setup();
		const done = editor.open('physical_samples', 's1');
		vi.advanceTimersByTime(READY_TIMEOUT_MS - 1);
		expect(editor.state.phase).toBe('loading');
		vi.advanceTimersByTime(1);
		expect(editor.state.phase).toBe('refused');
		editor.openInTab();
		expect(openTab).toHaveBeenCalledWith(editor.state.url);
		expect(editor.state.phase).toBe('tab');
		focus();
		await expect(done).resolves.toBe('saved');
	});

	it('the tab itself can answer, and Done closes too', async () => {
		const tab = { name: 'tab' };
		const { editor } = setup(tab);
		const a = editor.open('physical_samples', 's1');
		editor.openInTab();
		editor.onMessage(from(tab, editMessage('cancelled', 'physical_samples', 's1')));
		await expect(a).resolves.toBe('cancelled');
		const b = editor.open('physical_samples', 's1');
		editor.openInTab();
		editor.done();
		await expect(b).resolves.toBe('saved');
	});

	it('a blocked pop-up says so and keeps the dialog open', () => {
		const { editor } = setup(null);
		void editor.open('physical_samples', 's1');
		vi.advanceTimersByTime(READY_TIMEOUT_MS);
		editor.openInTab();
		expect(editor.state.phase).toBe('refused');
		expect(editor.state.blocked).toBe(true);
	});

	it('a late ready after the offer still shows the form', () => {
		const { editor, frame } = setup();
		void editor.open('physical_samples', 's1');
		vi.advanceTimersByTime(READY_TIMEOUT_MS);
		editor.onMessage(from(frame, editMessage('ready', 'physical_samples', 's1')));
		expect(editor.state.phase).toBe('ready');
	});

	it('ignores stray and forged messages (Review Focus 4)', () => {
		const { editor, frame } = setup();
		void editor.open('physical_samples', 's1');
		editor.onMessage(from(frame, editMessage('saved', 'physical_samples', 's1'), STAR));
		editor.onMessage(from({ name: 'another window' }, editMessage('saved', 'physical_samples', 's1')));
		editor.onMessage(from(frame, editMessage('saved', 'physical_samples', 's2')));
		editor.onMessage(from(frame, { type: 'd1-edit', result: 'saved' }));
		expect(editor.state.phase).toBe('loading');
	});

	it('a second Edit replaces the first, which resolves "cancelled"', async () => {
		const { editor } = setup();
		const first = editor.open('physical_samples', 's1');
		void editor.open('physical_samples', 's2');
		await expect(first).resolves.toBe('cancelled');
		expect(editor.state.id).toBe('s2');
	});
});
```

Add to `packages/d1-ui/src/editDrawer.test.ts`. Put `editMode` into the import from
`./editDrawer`, add `vi` to the `vitest` import, and append:

```ts
describe('editMode', () => {
	it("uses the host's editor when it has one, without asking for v-form", () => {
		const probe = vi.fn(() => true);
		expect(editMode(true, probe)).toBe('host');
		expect(probe).not.toHaveBeenCalled();
	});
	it("else Directus's v-form in a drawer, else the Data Studio form", () => {
		expect(editMode(false, () => true)).toBe('drawer');
		expect(editMode(false, () => false)).toBe('data-studio');
	});
});
```

Add to `apps/starbase/web/src/host.test.ts`, inside `describe('the STARbase host', …)`:

```ts
	it("openEditor is the dialog's, passed through", async () => {
		const openEditor = vi.fn(async () => 'saved' as const);
		const host = createStarbaseHost(deps({ openEditor }));
		await expect(host.openEditor?.('physical_samples', 's1')).resolves.toBe('saved');
		expect(openEditor).toHaveBeenCalledWith('physical_samples', 's1');
	});
```

Run: `npm test -w starbase-web && npm test -w @d1/ui -- editDrawer`
Expected: FAIL. `./editor` is missing, and `editMode` is not exported.

- [ ] **Step 2: The contract and EditDrawer**

In `packages/d1-ui/src/host.ts`, add to `ExplorerHost`, after `fieldsFor`:

```ts
	// Edit a record in the host's own editor, resolving when the person is done. Optional: the Directus host
	// has none (EditDrawer shows Directus's v-form in a drawer); STARbase frames d1-server's form-only page
	// (spec §3.4). '+' as the id creates a record.
	openEditor?(collection: string, id: string): Promise<'saved' | 'cancelled'>;
```

In `packages/d1-ui/src/editDrawer.ts`, append:

```ts
export type EditMode = 'host' | 'drawer' | 'data-studio';

// How a record page edits: the host's own editor when it has one (STARbase's framed form), else
// Directus's v-form in a drawer, else the Data Studio form. `formAvailable` is only asked when there is
// no host editor, so STARbase never looks up a v-form it does not have.
export function editMode(hostEditor: boolean, formAvailable: () => boolean): EditMode {
	if (hostEditor) return 'host';
	return formAvailable() ? 'drawer' : 'data-studio';
}
```

Export `editMode` and `type EditMode` from `packages/d1-ui/src/index.ts`, next to
`createFormFields`.

In `packages/d1-ui/src/components/EditDrawer.vue`:
- change the `../editDrawer` import to
  `import { buildPatch, editMode, formFields, saveErrors, versionChanged } from '../editDrawer';`;
- replace `const formAvailable = typeof resolveComponent('v-form') !== 'string';` with:

```ts
// STARbase edits in its own dialog (host.openEditor); Directus has v-form; anything else goes to Data Studio.
const mode = editMode(typeof host.openEditor === 'function', () => typeof resolveComponent('v-form') !== 'string');
const formAvailable = mode === 'drawer';
```

- in the `watch` callback, replace the block

```ts
		if (!formAvailable) {
			emit('update:modelValue', false);
			host.openDataStudio(dataStudioRoute(props.collection, props.primaryKey));
			return;
		}
```

with

```ts
		if (mode === 'host') {
			void editInHost();
			return;
		}
		if (mode === 'data-studio') {
			emit('update:modelValue', false);
			host.openDataStudio(dataStudioRoute(props.collection, props.primaryKey));
			return;
		}
```

- add, after `close()`:

```ts
// The host's editor does the editing; the drawer only reports back, so the page refetches on 'saved'.
async function editInHost() {
	const result = await host.openEditor!(props.collection, props.primaryKey);
	emit('update:modelValue', false);
	if (result === 'saved') emit('saved');
}
```

The template is unchanged: `<v-drawer v-if="formAvailable" …>` renders nothing in STARbase.

- [ ] **Step 3: The STARbase editor**

`apps/starbase/web/src/editor/editor.ts`:

```ts
import { reactive } from 'vue';
import { editFrameUrl, readEditMessage } from '@d1/ui';

// STARbase's editor (host.openEditor, spec §3.4): a dialog framing d1-server's form-only page. The frame
// says 'ready' when it renders (so it is signed in and allowed to be framed), then 'saved' or 'cancelled'.
// No 'ready' within READY_TIMEOUT_MS (signed out inside the frame, the frame refused by CSP, d1-server
// slow) offers the same page in a new tab; that tab answers through window.opener, and without an answer,
// coming back to STARbase counts as saved so the record page refetches. Free of the DOM for its tests:
// createBrowserEditor (browserEditor.ts) supplies window.open and the focus event.

export type EditorPhase = 'closed' | 'loading' | 'ready' | 'refused' | 'tab';
export interface EditorState {
	phase: EditorPhase;
	url: string;
	collection: string;
	id: string;
	/** The browser refused to open the new tab. */
	blocked: boolean;
}
export interface EditorDeps {
	serverBase: string;
	appOrigin: string;
	readyTimeoutMs?: number;
	openTab(url: string): Window | null;
	onWindowFocus(cb: () => void): () => void;
}

export const READY_TIMEOUT_MS = 8000;

export function createEditor(deps: EditorDeps) {
	const state = reactive<EditorState>({ phase: 'closed', url: '', collection: '', id: '', blocked: false });
	const serverOrigin = new URL(deps.serverBase).origin;
	let resolve: ((r: 'saved' | 'cancelled') => void) | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let frameWindow: () => unknown = () => null;
	let tab: Window | null = null;
	let offFocus: (() => void) | null = null;

	function stopWaiting() {
		if (timer !== null) clearTimeout(timer);
		timer = null;
	}

	function finish(result: 'saved' | 'cancelled') {
		stopWaiting();
		offFocus?.();
		offFocus = null;
		tab = null;
		Object.assign(state, { phase: 'closed', url: '', collection: '', id: '', blocked: false });
		const r = resolve;
		resolve = null;
		r?.(result);
	}

	function open(collection: string, id: string): Promise<'saved' | 'cancelled'> {
		if (resolve) finish('cancelled');
		Object.assign(state, { phase: 'loading', url: editFrameUrl(deps.serverBase, collection, id, deps.appOrigin), collection, id, blocked: false });
		timer = setTimeout(() => {
			timer = null;
			if (state.phase === 'loading') state.phase = 'refused';
		}, deps.readyTimeoutMs ?? READY_TIMEOUT_MS);
		return new Promise((r) => {
			resolve = r;
		});
	}

	function onMessage(event: { origin: string; source: unknown; data: unknown }) {
		if (state.phase === 'closed') return;
		const source = state.phase === 'tab' ? tab : frameWindow();
		const msg = readEditMessage(event, { origin: serverOrigin, source, collection: state.collection, id: state.id });
		if (!msg) return;
		if (msg.result === 'ready') {
			stopWaiting();
			if (state.phase === 'loading' || state.phase === 'refused') state.phase = 'ready';
			return;
		}
		finish(msg.result);
	}

	function openInTab() {
		stopWaiting();
		const w = deps.openTab(state.url);
		if (!w) {
			Object.assign(state, { phase: 'refused', blocked: true });
			return;
		}
		tab = w;
		state.phase = 'tab';
		offFocus = deps.onWindowFocus(() => finish('saved'));
	}

	return {
		state,
		open,
		attachFrame: (get: () => unknown) => void (frameWindow = get),
		onMessage,
		openInTab,
		close: () => finish('cancelled'),
		done: () => finish('saved'),
	};
}

export type Editor = ReturnType<typeof createEditor>;
```

`apps/starbase/web/src/editor/browserEditor.ts`:

```ts
import { createEditor, type Editor } from './editor';

export function createBrowserEditor(serverBase: string): Editor {
	return createEditor({
		serverBase,
		appOrigin: window.location.origin,
		// Not 'noopener': the form page answers through window.opener, to this exact origin only.
		openTab: (url) => window.open(url, '_blank'),
		onWindowFocus: (cb) => {
			const h = () => cb();
			window.addEventListener('focus', h);
			return () => window.removeEventListener('focus', h);
		},
	});
}
```

`apps/starbase/web/src/editor/EditorDialog.vue`:

```vue
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { Editor } from './editor';

// The edit dialog (spec §3.4). Esc and the backdrop do NOT close it: the edits are in the frame, which
// STARbase cannot see, so closing is the close button, which asks first once the form is showing.
const props = defineProps<{ editor: Editor }>();
const s = props.editor.state;
const frameEl = ref<HTMLIFrameElement | null>(null);
const confirmClose = ref(false);
const onMessage = (e: MessageEvent) => props.editor.onMessage(e);

onMounted(() => {
	window.addEventListener('message', onMessage);
	props.editor.attachFrame(() => frameEl.value?.contentWindow ?? null);
});
onBeforeUnmount(() => window.removeEventListener('message', onMessage));
watch(() => s.phase, () => (confirmClose.value = false));

function askClose() {
	if (s.phase === 'ready') confirmClose.value = true;
	else props.editor.close();
}
</script>

<template>
	<Teleport to="body">
		<div v-if="s.phase !== 'closed'" class="sb-editor-backdrop">
			<div class="sb-editor" role="dialog" aria-modal="true" aria-label="Edit record">
				<header class="sb-editor-head">
					<span class="sb-editor-title">Edit</span>
					<template v-if="confirmClose">
						<span class="sb-editor-ask">Close without saving? Changes in the form are lost.</span>
						<button type="button" class="sb-editor-btn danger" @click="editor.close()">Close</button>
						<button type="button" class="sb-editor-btn" @click="confirmClose = false">Keep editing</button>
					</template>
					<button v-else type="button" class="sb-editor-x" aria-label="Close the form" @click="askClose"><v-icon name="close" /></button>
				</header>
				<div v-if="s.phase === 'refused'" class="sb-editor-note" role="alert">
					<p v-if="s.blocked">The browser blocked the new tab. Allow pop-ups for STARbase and try again.</p>
					<p v-else>The form didn't open here. You may need to sign in again below, or this browser does not allow the form inside STARbase.</p>
					<v-button small @click="editor.openInTab()">Open in a new tab</v-button>
				</div>
				<div v-else-if="s.phase === 'tab'" class="sb-editor-note" role="status">
					<p>The form is open in another tab. Save or cancel there, then come back: this page refreshes when you do.</p>
					<v-button small secondary @click="editor.done()">Done</v-button>
				</div>
				<iframe
					v-if="s.phase !== 'tab'"
					ref="frameEl"
					class="sb-editor-frame"
					:class="{ waiting: s.phase === 'loading' }"
					:src="s.url"
					title="Directus form"
				/>
			</div>
		</div>
	</Teleport>
</template>

<style scoped>
.sb-editor-backdrop { position: fixed; inset: 0; z-index: 90; display: grid; place-items: center; padding: 16px; background: rgba(0, 0, 0, 0.45); }
.sb-editor {
	display: flex; flex-direction: column; width: min(1100px, 100%); height: min(860px, calc(100dvh - 32px));
	border-radius: 12px; overflow: hidden; background: var(--theme--background); box-shadow: 0 12px 48px rgba(0, 0, 0, 0.35);
}
.sb-editor-head { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid var(--theme--border-color-subdued); }
.sb-editor-title { flex: 1 1 auto; font-weight: 700; }
.sb-editor-ask { color: var(--theme--foreground-subdued); }
.sb-editor-x, .sb-editor-btn { border: 0; background: none; padding: 6px 8px; font: inherit; color: var(--theme--foreground); cursor: pointer; border-radius: 6px; }
.sb-editor-btn.danger { color: var(--theme--danger); font-weight: 700; }
.sb-editor-note { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 12px 16px; background: var(--theme--background-normal); }
.sb-editor-note p { margin: 0; flex: 1 1 240px; }
.sb-editor-frame { flex: 1 1 auto; width: 100%; border: 0; background: var(--theme--background); }
.sb-editor-frame.waiting { opacity: 0.4; }
@media (max-width: 767px) {
	.sb-editor-backdrop { padding: 0; }
	.sb-editor { width: 100%; height: 100dvh; border-radius: 0; }
}
</style>
```

- [ ] **Step 4: Wire it in**

- In `apps/starbase/web/src/host.ts`, replace
  `if (deps.openEditor) Object.assign(host, { openEditor: deps.openEditor });` with
  `if (deps.openEditor) host.openEditor = deps.openEditor;`.
- In `apps/starbase/web/src/context.ts`, add `import type { Editor } from './editor/editor';` and
  the member `editor: Editor;` to `AppContext`.
- In `apps/starbase/web/src/App.vue`, change `const { session } = useApp();` to
  `const { session, editor } = useApp();`. Import
  `EditorDialog from './editor/EditorDialog.vue'`, and add `<EditorDialog :editor="editor" />` as
  the last element of the template.
- In `apps/starbase/web/src/main.ts`:
  - import `createBrowserEditor` from `./editor/browserEditor`;
  - after `const router = …`, add `const editor = createBrowserEditor(config.directusUrl);`;
  - pass `openEditor: (collection, id) => editor.open(collection, id)` into `installStarbaseHost({ … })`;
  - change the provide to `app.provide(APP, { api, session, guard, editor });`.

- [ ] **Step 5: Run the tests**

```bash
npm test -w starbase-web && npm run typecheck -w starbase-web && npm run build -w starbase-web
npm test -w @d1/ui && npm run typecheck -w @d1/ui
npm test -w @d1/starbase-pages && npm run typecheck -w @d1/starbase-pages
```

Expected: every test passes, and the typechecks and the build are clean.

- [ ] **Step 6: See it, then run the Directus regression run**

The preview from Task 6 is still running, with `d1-edit-frame` and `preview-ports.env`. Start
STARbase with `VITE_DIRECTUS_URL=http://127.0.0.1:18057 npm run dev -w starbase-web`, in the
background.

In the Browser pane, as the admin:
1. Open a sample and click **Edit**. The dialog shows the Directus form, with no module bar.
2. Change a text field and click Save. The dialog closes and the record page reloads with the value.
   Put it back the same way.
3. Ctrl+K while the dialog is open does nothing.
4. Click Edit, then the close button. It asks "Close without saving?".

Then check Directus is unchanged:

```bash
CREDS="$PWD/.superpowers/preview-credentials-d1-starbase.txt"
(cd tests/ui && D1_ROUTES_CREDENTIALS="$CREDS" npx playwright test specs/13-explorer-routes.spec.ts --retries=0)
```

Expected: `4 passed`. Open a Directus record page at `http://127.0.0.1:18057/admin/home/samples/<id>`,
click **Edit**, change nothing and close. The `v-form` drawer still opens. Use `get_page_text` to
see its title.

- [ ] **Step 7: Commit**

```bash
git add packages/d1-ui apps/starbase/web/src
git commit -m "feat(starbase): edit through the framed Directus form, with a new-tab fallback; EditDrawer uses a host's editor

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin HEAD:feat/explorer-standalone
```

---
### Task 8: The plot pages

**Files:**
- Create: `apps/starbase/web/src/narrow.ts`, `src/narrow.test.ts`
- Create: `apps/starbase/web/src/plot/plotHosts.ts`, `src/plot/plotHosts.test.ts`, `src/plot/routes.ts`, `src/plot/ForcePlotPage.vue`, `src/plot/FastPlotPage.vue`, `src/plot/PhoneNote.vue`
- Modify: `apps/starbase/web/src/main.ts` (the plot routes, `private-view`), `src/routes.test.ts`

**Interfaces:**
- Consumes:
  - `ForceHost` and `setForceHost` from `@d1/force-plotting`, and `ForceDashboard`;
  - `FastHost` and `setFastHost` from `@d1/fast-plotting`, and `FastDashboard`;
  - `recordRoute`, `openLink` and `assetUrl` from `@d1/ui`;
  - `SessionGuard.recover` (Task 2), `getConfig` (Task 1), `useApp` (Task 5).
- Produces:

```ts
// narrow.ts
export const PHONE_MAX_WIDTH = 767;
export const PHONE_QUERY = '(max-width: 767px)';
export function isPhoneWidth(width: number): boolean;
export function useNarrow(): Ref<boolean>;
// plot/plotHosts.ts
export interface PlotDeps { api: AxiosInstance; session: Pick<Session, 'user' | 'isAdmin'>; guard: Pick<SessionGuard, 'recover'>;
  router: Pick<Router, 'push'>; config: () => Readonly<StarbaseConfig>; download?: (href: string) => void }
export function forceUser(session: Pick<Session, 'user' | 'isAdmin'>): ForceHostUser | null;
export function starbaseForceHost(deps: PlotDeps): ForceHost;
export function starbaseFastHost(deps: Pick<PlotDeps, 'api' | 'router'>): FastHost;
// plot/routes.ts
export const plotRoutes: RouteRecordRaw[];   // 'plot/force' (name plot-force), 'plot/fast' (name plot-fast), lazy
```

- [ ] **Step 1: Write the failing tests**

`apps/starbase/web/src/narrow.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isPhoneWidth, PHONE_MAX_WIDTH, PHONE_QUERY } from './narrow';

describe('phone width (spec §3.3: under 768 px)', () => {
	it('is below 768 px', () => {
		expect(isPhoneWidth(375)).toBe(true);
		expect(isPhoneWidth(767)).toBe(true);
		expect(isPhoneWidth(768)).toBe(false);
		expect(PHONE_QUERY).toBe(`(max-width: ${PHONE_MAX_WIDTH}px)`);
	});
});
```

`apps/starbase/web/src/plot/plotHosts.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { configureLinks, resetLinks, starbaseLinks } from '@d1/ui';
import { forceUser, starbaseFastHost, starbaseForceHost, type PlotDeps } from './plotHosts';

const D1 = 'https://d1-server.tail54eeb6.ts.net';

function deps(recovery: 'retry' | 'fail' | 'signed-out' = 'retry') {
	const config = { directusUrl: D1, filterUrl: `${D1}/filter`, diagUrl: `${D1}/diag`, octreeUrl: `${D1}/octrees` };
	const d = {
		api: { name: 'the STARbase axios instance' } as unknown as PlotDeps['api'],
		session: { user: ref({ id: 'u1', first_name: 'Ada', role: 'r1' }), isAdmin: ref(true) },
		guard: { recover: vi.fn(async () => recovery) },
		router: { push: vi.fn() },
		config: () => config,
		download: vi.fn(),
	};
	return { d: d as unknown as PlotDeps & typeof d, config };
}

afterEach(() => resetLinks());

describe('the Force plotter in STARbase (the cookie variant, spec §3.5)', () => {
	it('sends the session cookie with its raw fetches, and no Authorization header', () => {
		const host = starbaseForceHost(deps().d);
		expect(host.fetchCredentials).toBe('include');
		expect(host.authHeaders()).toEqual({});
		expect(host.dense).toBe(true);
	});
	it('reads the sidecar URLs live from the config', () => {
		const { d, config } = deps();
		const host = starbaseForceHost(d);
		expect([host.filterUrl, host.diagUrl, host.octreeUrl]).toEqual([`${D1}/filter`, `${D1}/diag`, `${D1}/octrees`]);
		config.octreeUrl = 'https://octrees.example';
		expect(host.octreeUrl).toBe('https://octrees.example');
	});
	it('opens a record on its STARbase page', () => {
		configureLinks(starbaseLinks(D1));
		const { d } = deps();
		starbaseForceHost(d).openRecord('physical_samples', 's 1');
		expect(d.router.push).toHaveBeenCalledWith('/samples/s%201');
	});
	it('refreshAuth re-checks the session: renewed means retry, a live session refusing does not', async () => {
		const renewed = deps('retry');
		expect(await starbaseForceHost(renewed.d).refreshAuth!()).toBe(true);
		expect(renewed.d.guard.recover).toHaveBeenCalledWith(403);
		expect(await starbaseForceHost(deps('fail').d).refreshAuth!()).toBe(false);
		expect(await starbaseForceHost(deps('signed-out').d).refreshAuth!()).toBe(false);
	});
	it('downloads a file from d1-server with ?download=', async () => {
		configureLinks(starbaseLinks(D1));
		const { d } = deps();
		await starbaseForceHost(d).downloadAsset('f 1');
		expect(d.download).toHaveBeenCalledWith(`${D1}/assets/f%201?download=`);
	});
	it('the current user carries the server-side admin flag (policies, not roles)', () => {
		const { d } = deps();
		expect(forceUser(d.session)).toEqual({ id: 'u1', first_name: 'Ada', role: 'r1', admin_access: true });
		d.session.user.value = null as never;
		expect(forceUser(d.session)).toBeNull();
	});
});

describe('the FAST plotter in STARbase', () => {
	it('uses the same client and opens records on STARbase pages', () => {
		configureLinks(starbaseLinks(D1));
		const { d } = deps();
		const host = starbaseFastHost(d);
		expect(host.api).toBe(d.api);
		host.openRecord('manufacturing_operations', 'o1');
		expect(d.router.push).toHaveBeenCalledWith('/operations/o1');
	});
});
```

Append to `apps/starbase/web/src/routes.test.ts`. Add `import { plotRoutes } from './plot/routes';`
to the imports.

```ts
describe('the plot pages', () => {
	it('are STARbase pages inside the shell, and the dashboards resolve to them', () => {
		configureLinks(starbaseLinks('https://d1-server.tail54eeb6.ts.net'));
		const router = createRouter({ history: createMemoryHistory(), routes: buildRoutes(plotRoutes) });
		expect(router.resolve('/plot/force?operation=9').name).toBe('plot-force');
		const fast = resolveLink('/d1-fast-dashboard?operation=3');
		expect(fast).toEqual({ kind: 'route', to: '/plot/fast?operation=3' });
		if (fast.kind === 'route') expect(router.resolve(fast.to).name).toBe('plot-fast');
		expect(router.resolve('/plot/force').matched).toHaveLength(2);
	});
});
```

Run: `npm test -w starbase-web`
Expected: FAIL. `./narrow`, `./plotHosts` and `./plot/routes` are missing.

- [ ] **Step 2: Implement**

`apps/starbase/web/src/narrow.ts`:

```ts
import { onBeforeUnmount, ref, type Ref } from 'vue';

// STARbase's phone layout starts below 768 px (spec §3.3). One query for the shell, the plot note and
// the e2e, matched live (rotating a phone or resizing a window switches layouts).
export const PHONE_MAX_WIDTH = 767;
export const PHONE_QUERY = `(max-width: ${PHONE_MAX_WIDTH}px)`;

export function isPhoneWidth(width: number): boolean {
	return width <= PHONE_MAX_WIDTH;
}

export function useNarrow(): Ref<boolean> {
	const mq = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(PHONE_QUERY) : null;
	const narrow = ref(mq?.matches ?? false);
	const onChange = (e: MediaQueryListEvent) => (narrow.value = e.matches);
	mq?.addEventListener('change', onChange);
	onBeforeUnmount(() => mq?.removeEventListener('change', onChange));
	return narrow;
}
```

`apps/starbase/web/src/plot/plotHosts.ts`:

```ts
import type { AxiosInstance } from 'axios';
import type { Router } from 'vue-router';
import type { ForceHost, ForceHostUser } from '@d1/force-plotting';
import type { FastHost } from '@d1/fast-plotting';
import { assetUrl, openLink, recordRoute } from '@d1/ui';
import type { SessionGuard } from '../api';
import type { StarbaseConfig } from '../config';
import type { Session } from '../session';

// The plotters' host contracts, STARbase's cookie variant (spec §3.5). Type imports only: the plotting
// packages themselves load with their lazy plot pages (ForcePlotPage/FastPlotPage install these).

export interface PlotDeps {
	api: AxiosInstance;
	session: Pick<Session, 'user' | 'isAdmin'>;
	guard: Pick<SessionGuard, 'recover'>;
	router: Pick<Router, 'push'>;
	config: () => Readonly<StarbaseConfig>;
	download?: (href: string) => void;
}

// The plotter scopes by admin role: the flag comes from the server (GET /policies/me/globals).
export function forceUser(session: Pick<Session, 'user' | 'isAdmin'>): ForceHostUser | null {
	const u = session.user.value;
	return u ? { ...u, admin_access: session.isAdmin.value } : null;
}

function clickDownload(href: string): void {
	const a = document.createElement('a');
	a.href = href;
	a.rel = 'noopener';
	document.body.appendChild(a);
	a.click();
	a.remove();
}

export function starbaseForceHost(deps: PlotDeps): ForceHost {
	const download = deps.download ?? clickDownload;
	return {
		api: deps.api,
		currentUser: () => forceUser(deps.session),
		get filterUrl() {
			return deps.config().filterUrl;
		},
		get diagUrl() {
			return deps.config().diagUrl;
		},
		get octreeUrl() {
			return deps.config().octreeUrl;
		},
		// The session cookie goes with every raw fetch to /filter and /diag (they forward it to Directus);
		// /octrees is public within the tailnet and is fetched without credentials by the plotter itself.
		authHeaders: () => ({}),
		fetchCredentials: 'include',
		// "Re-checks the session" (spec §3.5): renewed means retry once; a live session that refused, or no
		// session (the guard has sent the user to sign in), means no retry.
		refreshAuth: async () => (await deps.guard.recover(403)) === 'retry',
		openRecord: (collection, id) => openLink(recordRoute(collection, id), deps.router),
		// A top-level navigation to d1-server carries the session cookie; ?download makes it an attachment.
		downloadAsset: async (fileId) => download(assetUrl(String(fileId), { download: '' })),
		dense: true,
	};
}

export function starbaseFastHost(deps: Pick<PlotDeps, 'api' | 'router'>): FastHost {
	return { api: deps.api, openRecord: (collection, id) => openLink(recordRoute(collection, id), deps.router) };
}
```

`apps/starbase/web/src/plot/routes.ts`:

```ts
import type { RouteRecordRaw } from 'vue-router';

// The plotters as STARbase pages (spec §3.5, Q13): /plot/force?operation=<id>, /plot/fast?operation=<id>.
// Lazy: three.js, potree and the FAST charts load only when a plot is opened.
export const plotRoutes: RouteRecordRaw[] = [
	{ path: 'plot/force', name: 'plot-force', component: () => import('./ForcePlotPage.vue') },
	{ path: 'plot/fast', name: 'plot-fast', component: () => import('./FastPlotPage.vue') },
];
```

`apps/starbase/web/src/plot/PhoneNote.vue`:

```vue
<script setup lang="ts">
import { useNarrow } from '../narrow';

// Spec §3.3: on a phone the plotters still open, with a note.
const narrow = useNarrow();
</script>

<template>
	<p v-if="narrow" class="sb-phone-note" role="note">The plotter works best on a larger screen.</p>
</template>

<style scoped>
.sb-phone-note { margin: 0; padding: 8px 16px; font-size: var(--fs-sm, 12px); background: var(--theme--background-normal); color: var(--theme--foreground-subdued); }
</style>
```

`apps/starbase/web/src/plot/ForcePlotPage.vue`:

```vue
<script setup lang="ts">
import { useRouter } from 'vue-router';
import { ForceDashboard, setForceHost } from '@d1/force-plotting';
import { getConfig } from '../config';
import { useApp } from '../context';
import PhoneNote from './PhoneNote.vue';
import { starbaseForceHost } from './plotHosts';

// /plot/force?operation=<id>: the shared Force plotter (the Force App's too). Its <private-view> is
// STARbase's PlainFrame (main.ts registers it under that name).
const { api, session, guard } = useApp();
setForceHost(starbaseForceHost({ api, session, guard, router: useRouter(), config: getConfig }));
</script>

<template>
	<PhoneNote />
	<ForceDashboard />
</template>
```

`apps/starbase/web/src/plot/FastPlotPage.vue`:

```vue
<script setup lang="ts">
import { useRouter } from 'vue-router';
import { FastDashboard, setFastHost } from '@d1/fast-plotting';
import { useApp } from '../context';
import PhoneNote from './PhoneNote.vue';
import { starbaseFastHost } from './plotHosts';

// /plot/fast?operation=<id> (spec §8 erratum 2): the shared FAST plotter.
const { api } = useApp();
setFastHost(starbaseFastHost({ api, router: useRouter() }));
</script>

<template>
	<PhoneNote />
	<FastDashboard />
</template>
```

In `apps/starbase/web/src/main.ts`:
- add `import { plotRoutes } from './plot/routes';`;
- change `createStarbaseRouter(session)` to `createStarbaseRouter(session, plotRoutes)`;
- after `registerStandins(app);`, add:

```ts
	// The plotters render <private-view title="…"> (written for Directus): here it is STARbase's page frame.
	app.component('private-view', PlainFrame);
```

- [ ] **Step 3: Run the tests and the build**

```bash
npm test -w starbase-web && npm run typecheck -w starbase-web && npm run build -w starbase-web
ls apps/starbase/web/dist/assets | grep -ciE 'ForcePlotPage|FastPlotPage'
```

Expected:
- every test passes, and the typecheck and the build are clean;
- the count is `2` or more: the plot pages are their own chunks.

- [ ] **Step 4: See them on the preview**

Use the preview and the dev server from Task 7. In the Browser pane, signed in as the admin:
- open `/operations` and click a row's **Force** (or **FAST**) button. The URL is
  `/plot/force?operation=<id>` (or `/plot/fast?…`), the page header says "Force Analysis" (or "FAST
  Analysis") in STARbase's frame, and the operations list draws. The preview has no `filter` or
  `diag` sidecar, so a panel that needs one shows its own error, as spec §4 says;
- on a record page, a plot link opens the same STARbase page;
- `get_page_text` shows no "no host installed".

- [ ] **Step 5: Commit**

```bash
git add apps/starbase/web/src
git commit -m "feat(starbase): the Force and FAST plotters as STARbase pages, on the session cookie

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin HEAD:feat/explorer-standalone
```

---

### Task 9: Phone layout

**Files:**
- Modify: `packages/d1-ui/src/index/listPrefs.ts`, `packages/d1-ui/src/index/listPrefs.test.ts`, `packages/d1-ui/src/index.ts`
- Create: `apps/starbase/web/src/ShellFoot.vue`
- Modify: `apps/starbase/web/src/AppShell.vue` (whole file), `src/styles.css`, `src/main.ts`, `src/narrow.test.ts`

**Interfaces:**
- Produces in `@d1/ui`:

```ts
export const PHONE_LIST_MAX_WIDTH = 767;
export function setPhoneListDefault(on: boolean): void;   // STARbase: true; Directus never calls it
export function readSavedListPrefs(slug: string, storage?: Storage | null): Partial<ListPrefs>;
export function defaultListPrefs(width: number, saved: Partial<ListPrefs>): ListPrefs;
// readListPrefs(slug, storage?, width?) keeps its result for every existing caller
```

- [ ] **Step 1: Write the failing tests**

Append to `packages/d1-ui/src/index/listPrefs.test.ts`. Add `defaultListPrefs`,
`readSavedListPrefs`, `setPhoneListDefault` and `PHONE_LIST_MAX_WIDTH` to the import from
`./listPrefs`, and `afterEach` and `vi` to the `vitest` import.

```ts
describe('phone default (STARbase, spec §3.3)', () => {
	afterEach(() => setPhoneListDefault(false));

	it('a phone-width list starts as cards when nothing was chosen', () => {
		expect(defaultListPrefs(375, {})).toEqual({ view: 'cards', density: 'normal' });
		expect(defaultListPrefs(PHONE_LIST_MAX_WIDTH + 1, {})).toEqual({ view: 'table', density: 'normal' });
	});
	it('a choice the person made wins at any width', () => {
		expect(defaultListPrefs(375, { view: 'table' })).toEqual({ view: 'table', density: 'normal' });
		expect(defaultListPrefs(1280, { density: 'roomy' })).toEqual({ view: 'table', density: 'roomy' });
	});
	it('only a host that asks for it gets cards: the Directus module keeps its table at any width', () => {
		expect(readListPrefs('samples', fakeStorage(), 375)).toEqual({ view: 'table', density: 'normal' });
		setPhoneListDefault(true);
		expect(readListPrefs('samples', fakeStorage(), 375)).toEqual({ view: 'cards', density: 'normal' });
		expect(readListPrefs('samples', fakeStorage({ 'd1.list.samples': '{"view":"table"}' }), 375).view).toBe('table');
	});
	it('the default is never written back', () => {
		setPhoneListDefault(true);
		const storage = fakeStorage();
		const setItem = vi.spyOn(storage, 'setItem');
		readListPrefs('samples', storage, 375);
		expect(setItem).not.toHaveBeenCalled();
	});
	it('readSavedListPrefs keeps only the valid halves', () => {
		expect(readSavedListPrefs('samples', fakeStorage({ 'd1.list.samples': '{"view":"cards","density":"huge"}' }))).toEqual({ view: 'cards' });
		expect(readSavedListPrefs('samples', throwing())).toEqual({});
	});
});
```

In `apps/starbase/web/src/narrow.test.ts`, add `import { PHONE_LIST_MAX_WIDTH } from '@d1/ui';`
to the imports at the top, then append:

```ts
describe('one phone width', () => {
	it('the shell and the lists switch at the same width', () => {
		expect(PHONE_MAX_WIDTH).toBe(PHONE_LIST_MAX_WIDTH);
	});
});
```

Run: `npm test -w @d1/ui -- listPrefs && npm test -w starbase-web -- narrow`
Expected: FAIL. The new names are not exported.

- [ ] **Step 2: Implement the list default**

In `packages/d1-ui/src/index/listPrefs.ts`, replace `readListPrefs` with:

```ts
// Under this width a list starts as cards when the person has not chosen (STARbase's phone layout, spec
// §3.3). Only a host that asks for it gets this: STARbase calls setPhoneListDefault(true) at start-up,
// the Directus module never does and keeps its table at every width.
export const PHONE_LIST_MAX_WIDTH = 767;
let phoneCards = false;

export function setPhoneListDefault(on: boolean): void {
	phoneCards = on;
}

// What this person chose for this list, half by half; nothing stored, a broken value or blocked storage
// is {}.
export function readSavedListPrefs(slug: string, storage: Storage | null = browserStorage()): Partial<ListPrefs> {
	const saved: Partial<ListPrefs> = {};
	try {
		const raw = storage?.getItem(listPrefsKey(slug));
		if (!raw) return saved;
		const v: unknown = JSON.parse(raw);
		if (v && typeof v === 'object' && !Array.isArray(v)) {
			const { view, density } = v as Record<string, unknown>;
			if (LIST_VIEWS.includes(view as ListView)) saved.view = view as ListView;
			if (DENSITIES.includes(density as Density)) saved.density = density as Density;
		}
	} catch {
		// broken value or blocked storage: nothing saved
	}
	return saved;
}

export function defaultListPrefs(width: number, saved: Partial<ListPrefs>): ListPrefs {
	return {
		view: saved.view ?? (width <= PHONE_LIST_MAX_WIDTH ? 'cards' : DEFAULT_LIST_PREFS.view),
		density: saved.density ?? DEFAULT_LIST_PREFS.density,
	};
}

function viewportWidth(): number {
	try {
		return typeof window === 'undefined' ? Number.POSITIVE_INFINITY : window.innerWidth;
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

// The stored value is a JSON object; each half is checked on its own, so a good half survives a bad one.
// Nothing stored gives the default for this width (only when the host asked for the phone default).
// Reading never writes: a default is not a choice.
export function readListPrefs(slug: string, storage: Storage | null = browserStorage(), width: number = viewportWidth()): ListPrefs {
	return defaultListPrefs(phoneCards ? width : Number.POSITIVE_INFINITY, readSavedListPrefs(slug, storage));
}
```

In `packages/d1-ui/src/index.ts`, add near the index-page exports:

```ts
export { PHONE_LIST_MAX_WIDTH, defaultListPrefs, readSavedListPrefs, setPhoneListDefault } from './index/listPrefs';
```

Run: `npm test -w @d1/ui && npm run typecheck -w @d1/ui`
Expected: every test passes, including the existing `readListPrefs` tests, which are unchanged.

- [ ] **Step 3: The phone shell**

`apps/starbase/web/src/ShellFoot.vue`:

```vue
<script setup lang="ts">
import { useRouter } from 'vue-router';
import { getConfig } from './config';
import { useApp } from './context';

// The sidebar's foot (desktop) and the phone sheet's: Data Studio in a new tab, who is signed in, sign out.
const { session } = useApp();
const router = useRouter();
const studioHref = `${getConfig().directusUrl}/admin`;

async function signOut() {
	await session.signOut();
	await router.replace('/signin');
}
</script>

<template>
	<div class="sb-foot">
		<a :href="studioHref" target="_blank" rel="noopener" class="sb-foot-link"><v-icon name="open_in_new" x-small left />Data Studio</a>
		<span class="sb-user">{{ session.user.value?.first_name ?? '' }}</span>
		<button type="button" class="sb-signout" @click="signOut"><v-icon name="logout" x-small left />Sign out</button>
	</div>
</template>

<style scoped>
.sb-foot {
	margin-top: auto; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 12px 16px;
	border-top: 1px solid var(--theme--border-color-subdued); font-size: var(--fs-sm, 12px);
}
.sb-foot-link { color: var(--theme--foreground-subdued); text-decoration: none; }
.sb-user { margin-left: auto; color: var(--theme--foreground-subdued); }
.sb-signout { border: 0; background: none; padding: 4px; font: inherit; color: var(--theme--foreground); cursor: pointer; }
</style>
```

`apps/starbase/web/src/AppShell.vue` (whole file):

```vue
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ExplorerNav, Finder, useFinderShortcut } from '@d1/ui';
import { openScan } from '@d1/starbase-pages';
import BrandLogo from './BrandLogo.vue';
import ShellFoot from './ShellFoot.vue';
import { useNarrow } from './narrow';

// STARbase's chrome around every signed-in page (spec §3.3). Desktop: the brand, the Explorer sidebar
// (rail and panel, from @d1/ui) and its foot beside the page. Phone (< 768 px): a top bar with a menu
// button that opens the same sidebar as a full-height sheet (an aria-modal dialog, so Ctrl+K stays shut
// while it is open), and a find button. The finder is shared by both.
const narrow = useNarrow();
const sheetOpen = ref(false);
const route = useRoute();
const { finderOpen, openFinder, closeFinder } = useFinderShortcut();

const scanFromFinder = () => {
	closeFinder();
	openScan();
};
const findFromSheet = () => {
	sheetOpen.value = false;
	openFinder();
};

// The sheet closes when a page is chosen, when the window grows past phone width, and on Esc.
watch(() => route.fullPath, () => (sheetOpen.value = false));
watch(narrow, (isNarrow) => {
	if (!isNarrow) sheetOpen.value = false;
});
const onKey = (e: KeyboardEvent) => {
	if (e.key === 'Escape' && sheetOpen.value) sheetOpen.value = false;
};
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
	<div class="sb-shell" :class="{ phone: narrow }">
		<aside v-if="!narrow" class="sb-side" aria-label="STARbase">
			<router-link to="/" class="sb-brand" aria-label="STARbase Home"><BrandLogo /></router-link>
			<ExplorerNav :show-brand="false" style="--d1-nav-offset: 64px" @open-finder="openFinder" />
			<ShellFoot />
		</aside>
		<header v-else class="sb-topbar">
			<button type="button" class="sb-icon-btn" aria-label="Menu" :aria-expanded="sheetOpen" @click="sheetOpen = true"><v-icon name="menu" /></button>
			<router-link to="/" class="sb-brand" aria-label="STARbase Home"><BrandLogo compact /></router-link>
			<button type="button" class="sb-icon-btn" aria-label="Find a record" @click="openFinder"><v-icon name="search" /></button>
		</header>

		<main class="sb-content"><router-view /></main>

		<div v-if="narrow && sheetOpen" class="sb-sheet-backdrop" @mousedown.self="sheetOpen = false">
			<div class="sb-sheet" role="dialog" aria-modal="true" aria-label="Pages">
				<div class="sb-sheet-head">
					<BrandLogo />
					<button type="button" class="sb-icon-btn" aria-label="Close the menu" @click="sheetOpen = false"><v-icon name="close" /></button>
				</div>
				<ExplorerNav :show-brand="false" style="--d1-nav-offset: 56px" @open-finder="findFromSheet" />
				<ShellFoot />
			</div>
		</div>

		<Finder v-if="finderOpen" can-scan @close="closeFinder" @scan="scanFromFinder" />
	</div>
</template>

<style scoped>
.sb-shell { display: grid; grid-template-columns: 272px minmax(0, 1fr); height: 100dvh; }
.sb-side {
	display: flex; flex-direction: column; min-height: 0; overflow-y: auto;
	background: var(--theme--background-subdued); border-right: 1px solid var(--theme--border-color-subdued);
}
.sb-brand { display: flex; align-items: center; height: 64px; padding: 0 16px; flex: none; text-decoration: none; }
.sb-content { min-width: 0; height: 100dvh; overflow-y: auto; overflow-x: hidden; }

.sb-shell.phone { grid-template-columns: minmax(0, 1fr); grid-template-rows: 56px minmax(0, 1fr); }
.sb-shell.phone .sb-content { height: calc(100dvh - 56px); }
.sb-topbar {
	display: flex; align-items: center; justify-content: space-between; height: 56px; padding: 0 8px;
	background: var(--theme--background-subdued); border-bottom: 1px solid var(--theme--border-color-subdued);
}
.sb-topbar .sb-brand { height: 56px; padding: 0 8px; }
.sb-icon-btn {
	display: inline-grid; place-items: center; width: 44px; height: 44px; border: 0; border-radius: 10px;
	background: none; color: var(--theme--foreground); cursor: pointer;
}
.sb-icon-btn:focus-visible { outline: 2px solid var(--theme--primary); }
.sb-sheet-backdrop { position: fixed; inset: 0; z-index: 80; background: rgba(0, 0, 0, 0.4); }
.sb-sheet {
	display: flex; flex-direction: column; width: min(340px, 88vw); height: 100dvh; overflow-y: auto;
	background: var(--theme--background-subdued); box-shadow: 4px 0 24px rgba(0, 0, 0, 0.3);
}
.sb-sheet-head { display: flex; align-items: center; justify-content: space-between; height: 56px; padding: 0 8px 0 16px; flex: none; }
</style>
```

Append to `apps/starbase/web/src/styles.css`:

```css
/* Phone (< 768 px, spec §3.3): the pages' side padding (PageShell reads --content-padding) shrinks so a
   record page fits 375 px with no sideways scroll. */
@media (max-width: 767px) {
	:root { --content-padding: 16px; }
}
```

In `apps/starbase/web/src/main.ts`:
- add `setPhoneListDefault` to an `@d1/ui` import: `import { setPhoneListDefault } from '@d1/ui';`;
- call `setPhoneListDefault(true);` right after `setPageFrame(PlainFrame);`.

- [ ] **Step 4: Run the tests**

```bash
npm test -w starbase-web && npm run typecheck -w starbase-web && npm run build -w starbase-web
npm test -w @d1/ui && npm run typecheck -w @d1/ui
```

Expected: every test passes, and the typechecks and the build are clean.

- [ ] **Step 5: See it at 375 px**

In the Browser pane, with the dev server and the preview from Task 7, call
`resize_window({ preset: 'mobile' })` and reload. Then:
- `/`: the top bar shows the menu, the star and the find button. The menu opens the "Pages" sheet
  with the sidebar. Choosing **Samples** closes the sheet, and `/samples` shows cards, because this
  browser has not chosen a view.
- Open a sample record page. Run
  `(() => { const c = document.querySelector('.sb-content'); return c.scrollWidth <= c.clientWidth; })()`
  in `javascript_tool`. It returns `true`, with no sideways scroll, and the rail is stacked above the
  panels.
  - If it returns `false`, find the culprit with
    `[...document.querySelectorAll('.sb-content *')].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1).slice(0, 5).map((e) => e.className)`.
  - If it is STARbase chrome (`sb-*`), fix it in STARbase's CSS.
  - If it is a kit or page component, fix that component, then run the Directus regression run in
    Step 6.
- `/plot/force` shows "The plotter works best on a larger screen." above the plotter.
- One screenshot of the sheet.

Then call `resize_window({ preset: 'desktop' })`.

- [ ] **Step 6: The Directus regression run, then commit**

```bash
npm run build:extensions
export D1_PREVIEW_NAME=d1-starbase D1_PREVIEW_PORT=18057 D1_PREVIEW_ENV_FILE=tests/ui/starbase/preview-ports.env
export D1_PREVIEW_OVERLAY="d1-home d1-admin-overview d1-fast-dashboard d1-campaign-ops d1-lab-dashboard d1-project-items d1-usage d1-edit-frame"
bash scripts/dev/explorer_preview.sh --stop; bash scripts/dev/explorer_preview.sh
CREDS="$PWD/.superpowers/preview-credentials-d1-starbase.txt"
(cd tests/ui && D1_ROUTES_CREDENTIALS="$CREDS" npx playwright test specs/13-explorer-routes.spec.ts --retries=0)
```

Expected: `4 passed`.

```bash
git add packages/d1-ui apps/starbase/web/src
git commit -m "feat(starbase): phone layout (top bar and sheet, cards by default on lists, record pages at 375 px)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin HEAD:feat/explorer-standalone
```

---
### Task 10: Links out of the database (`/d1-links`, "Open in STARbase", report links)

**Files:**
- Create: `core/extensions/d1-links/package.json`, `core/extensions/d1-links/index.js`, `core/extensions/d1-links/index.test.mjs`
- Modify: `packages/d1-ui/src/links.ts` (`starbaseUrlFor`, `starbaseUrlOnce`, `resetStarbaseUrl`), `packages/d1-ui/src/links.test.ts`, `packages/d1-ui/src/index.ts`
- Modify: `core/extensions/d1-home/src/DirectusFrame.vue`
- Modify: `core/extensions/d1-report/src/render.js`, `core/extensions/d1-report/src/index.js`, `core/extensions/d1-report/src/index.test.mjs`
- Modify: `core/README.md` (the endpoint row), `tests/ui/starbase/preview-ports.env`

**Interfaces:**
- Produces:
  - `GET /d1-links` returns `{ starbaseUrl: string | null }` to a signed-in user, and 401 to anyone
    else;
  - `export function starbaseUrlFrom(env): string | null` and `export function mount(router, env)`
    in `d1-links/index.js`;
  - in `@d1/ui`:
    - `starbaseUrlFor(starbaseUrl: string, directusPath: string): string`;
    - `starbaseUrlOnce(api: { get(path: string): Promise<{ data: any }> }): Promise<string | null>`;
    - `resetStarbaseUrl(): void`;
  - in `d1-report`: `adminRecordUrl(publicUrl, collection, id, starbaseUrl = '')`.

- [ ] **Step 1: Write the failing tests**

`core/extensions/d1-links/index.test.mjs`:

```js
// Run with: node --test core/extensions/d1-links/index.test.mjs   (CI's lint job runs every core/extensions/*/index.test.mjs)
import assert from 'node:assert/strict';
import { test } from 'node:test';

import ext, { mount, starbaseUrlFrom } from './index.js';

function call(env, accountability = { user: 'u1' }) {
	let handler;
	mount({ get: (path, fn) => { assert.equal(path, '/'); handler = fn; } }, env);
	const out = { status: 200, headers: {}, body: undefined };
	const res = {
		status(c) { out.status = c; return res; },
		set(k, v) { out.headers[k] = v; return res; },
		json(b) { out.body = b; return res; },
	};
	handler({ accountability }, res);
	return out;
}

test('starbaseUrlFrom: an http(s) address without its trailing slash, else null', () => {
	assert.equal(starbaseUrlFrom({ STARBASE_URL: 'https://starbase.tail54eeb6.ts.net/' }), 'https://starbase.tail54eeb6.ts.net');
	assert.equal(starbaseUrlFrom({ STARBASE_URL: '  ' }), null);
	assert.equal(starbaseUrlFrom({}), null);
	assert.equal(starbaseUrlFrom(undefined), null);
	assert.equal(starbaseUrlFrom({ STARBASE_URL: 'javascript:alert(1)' }), null);
	assert.equal(starbaseUrlFrom({ STARBASE_URL: 'not a url' }), null);
});

test('GET /d1-links tells a signed-in user where STARbase is', () => {
	const out = call({ STARBASE_URL: 'https://starbase.tail54eeb6.ts.net' });
	assert.equal(out.status, 200);
	assert.deepEqual(out.body, { starbaseUrl: 'https://starbase.tail54eeb6.ts.net' });
	assert.equal(out.headers['Cache-Control'], 'no-store');
});

test('unset: null, so Data Studio hides its link', () => {
	assert.deepEqual(call({}).body, { starbaseUrl: null });
});

test('not signed in: 401', () => {
	assert.equal(call({ STARBASE_URL: 'https://s.example' }, null).status, 401);
	assert.equal(call({ STARBASE_URL: 'https://s.example' }, { user: null }).status, 401);
});

test('mounts at /d1-links', () => {
	assert.equal(ext.id, 'd1-links');
});
```

Append to `packages/d1-ui/src/links.test.ts`. Add `resetStarbaseUrl`, `starbaseUrlFor` and
`starbaseUrlOnce` to its import from `./links`.

```ts
describe('Open in STARbase (the Directus Home module)', () => {
	const SB = 'https://starbase.tail54eeb6.ts.net/';
	afterEach(() => resetStarbaseUrl());

	it("maps the Home-module page to the same STARbase page, else STARbase's Home", () => {
		expect(starbaseUrlFor(SB, '/home')).toBe('https://starbase.tail54eeb6.ts.net/');
		expect(starbaseUrlFor(SB, '/home/samples/a%2Fb?x=1')).toBe('https://starbase.tail54eeb6.ts.net/samples/a%2Fb?x=1');
		expect(starbaseUrlFor(SB, '/d1-force-dashboard?operation=9')).toBe('https://starbase.tail54eeb6.ts.net/plot/force?operation=9');
		expect(starbaseUrlFor(SB, '/content/materials/7')).toBe('https://starbase.tail54eeb6.ts.net/');
	});
	it('asks d1-server once per page load', async () => {
		const get = vi.fn(async () => ({ data: { starbaseUrl: 'https://starbase.example' } }));
		expect(await starbaseUrlOnce({ get })).toBe('https://starbase.example');
		await starbaseUrlOnce({ get });
		expect(get).toHaveBeenCalledTimes(1);
		expect(get).toHaveBeenCalledWith('/d1-links');
	});
	it('a missing endpoint (404 before deployment), null or a bad value hides the link', async () => {
		expect(await starbaseUrlOnce({ get: async () => Promise.reject(Object.assign(new Error('404'), { response: { status: 404 } })) })).toBeNull();
		resetStarbaseUrl();
		expect(await starbaseUrlOnce({ get: async () => ({ data: { starbaseUrl: null } }) })).toBeNull();
		resetStarbaseUrl();
		expect(await starbaseUrlOnce({ get: async () => ({ data: { starbaseUrl: 'javascript:alert(1)' } }) })).toBeNull();
	});
});
```

If `links.test.ts` does not import `afterEach` from `vitest` yet, add it.

In `core/extensions/d1-report/src/index.test.mjs`, append:

```js
// ---- STARBASE_URL: report links and label redirects go to STARbase (spec §3.6, Q16) ----------

const STAR_ENV = { PUBLIC_URL: 'https://lims.example.org', STARBASE_URL: 'https://starbase.example.org/' };

test('adminRecordUrl: with a STARbase address, Explorer pages open in STARbase; other records stay on Data Studio', () => {
	assert.equal(adminRecordUrl('https://lims.example.org', 'physical_samples', 'a/b', 'https://starbase.example.org/'), 'https://starbase.example.org/samples/a%2Fb');
	assert.equal(adminRecordUrl('https://lims.example.org', 'projects', 'p1', 'https://starbase.example.org'), 'https://starbase.example.org/projects/p1');
	assert.equal(adminRecordUrl('https://lims.example.org', 'equipment', 'e1', 'https://starbase.example.org'), 'https://lims.example.org/admin/content/equipment/e1');
	assert.equal(adminRecordUrl('https://lims.example.org', 'projects', 'p1', ''), 'https://lims.example.org/admin/home/projects/p1');
});

test('with STARBASE_URL set, every report links to STARbase and no Directus Home link is left', async () => {
	const h = harness({ physical_samples: true, manufacturing_operations: true, test_sessions: true, people: true, sample_genealogy: true }, STAR_ENV);
	const sample = await get(h.routes, '/sample/:id', SID, user);
	assert.ok(sample.out.body.includes(`https://starbase.example.org/samples/${SID}`), 'sample report');
	const op = await get(h.routes, '/operation/:id', OP_A, user);
	assert.ok(op.out.body.includes(`https://starbase.example.org/operations/${OP_A}`), 'operation report');
	assert.ok(op.out.body.includes(`https://starbase.example.org/samples/${SID}`), "operation report's sample link");
	const t = await get(h.routes, '/test/:id', TEST_ID, user);
	assert.ok(t.out.body.includes(`https://starbase.example.org/tests/${TEST_ID}`), 'test report');
	for (const body of [sample.out.body, op.out.body, t.out.body]) assert.ok(!body.includes('/admin/home/'), 'a Directus Home link is left');
});

test('GET /label and /labels go to STARbase when STARBASE_URL is set', async () => {
	const { routes } = harness({}, STAR_ENV);
	assert.equal((await getRedirect(routes, '/label', { ids: SID, codes: 'S 1' })).redirectTo, `https://starbase.example.org/labels?ids=${SID}&codes=S+1`);
	assert.equal((await getRedirect(routes, '/labels', {})).redirectTo, 'https://starbase.example.org/labels');
});
```

Run:
```bash
node --test core/extensions/d1-links/index.test.mjs
npm test -w @d1/ui -- links.test
(cd core/extensions/d1-report && npm ci --no-audit --no-fund && npm test)
```
Expected: FAIL. `d1-links/index.js` is missing, the `@d1/ui` names are not exported, and
d1-report's new tests fail.

- [ ] **Step 2: The `/d1-links` endpoint**

`core/extensions/d1-links/package.json`:

```json
{
  "name": "directus-extension-d1-links",
  "version": "1.0.0",
  "type": "module",
  "description": "/d1-links: where STARbase answers ({ starbaseUrl }), for Data Studio's \"Open in STARbase\" link. STARBASE_URL, or null while it is unset.",
  "keywords": ["directus", "directus-extension", "directus-custom-endpoint"],
  "directus:extension": {
    "type": "endpoint",
    "path": "index.js",
    "source": "index.js",
    "host": "^11.0.0"
  }
}
```

`core/extensions/d1-links/index.js`:

```js
// Directus endpoint: d1-links  (mounted at /d1-links)
//
//   GET /d1-links -> { starbaseUrl: string | null }
//
// Where STARbase answers, for the Data Studio side: the Home module's quiet "Open in STARbase" link
// reads it (spec §3.6, Q12). It is STARBASE_URL from the environment, the same setting d1-report's QR
// codes and links use, and null while it is unset (the link then stays hidden). Signed-in users only.
// No build step (the d1-usage pattern): Directus loads this file as it is.

export function starbaseUrlFrom(env) {
	const raw = String(env?.STARBASE_URL ?? '').trim().replace(/\/+$/, '');
	if (!raw) return null;
	try {
		const u = new URL(raw);
		return u.protocol === 'https:' || u.protocol === 'http:' ? raw : null;
	} catch {
		return null;
	}
}

export function mount(router, env) {
	router.get('/', (req, res) => {
		if (!req.accountability?.user) return res.status(401).json({ errors: [{ message: 'Authentication required.' }] });
		res.set('Cache-Control', 'no-store');
		return res.json({ starbaseUrl: starbaseUrlFrom(env) });
	});
}

export default {
	id: 'd1-links',
	handler: (router, { env }) => mount(router, env),
};
```

- [ ] **Step 3: The kit helpers and the Directus link**

Append to `packages/d1-ui/src/links.ts`:

```ts
// The STARbase address of a page shown in the Directus Home module (its "Open in STARbase" link):
// '/home/samples/<id>?x=1' → '<starbaseUrl>/samples/<id>?x=1', the plot dashboards → the plot pages;
// a page STARbase does not have opens its Home.
export function starbaseUrlFor(starbaseUrl: string, directusPath: string): string {
	const base = starbaseUrl.replace(/\/+$/, '');
	const r = starbaseLinks('').resolve(directusPath);
	return base + (r.kind === 'route' ? r.to : '/');
}

// GET /d1-links (core/extensions/d1-links): STARbase's address, or null while it is unset or the endpoint
// is not there (404 before deployment). Asked once per page load, whatever the number of pages visited.
let starbaseUrlRequest: Promise<string | null> | null = null;

export function starbaseUrlOnce(api: { get(path: string): Promise<{ data: any }> }): Promise<string | null> {
	starbaseUrlRequest ??= api.get('/d1-links').then(
		(r) => {
			const u = r.data?.starbaseUrl;
			return typeof u === 'string' && /^https?:\/\//.test(u) ? u : null;
		},
		() => null,
	);
	return starbaseUrlRequest;
}

export function resetStarbaseUrl(): void {
	starbaseUrlRequest = null;
}
```

In `packages/d1-ui/src/index.ts`, add `resetStarbaseUrl`, `starbaseUrlFor` and `starbaseUrlOnce`
to the `./links` export list.

`core/extensions/d1-home/src/DirectusFrame.vue`:
- in `<script setup>`, change the `@d1/ui` import to
  `import { ExplorerNav, Finder, starbaseUrlFor, starbaseUrlOnce, useExplorerHost, useFinderShortcut } from '@d1/ui';`;
- add `import { computed, onMounted, ref } from 'vue';` and `import { useRoute } from 'vue-router';`;
- after `scanFromFinder`, add:

```ts
// Q12: a quiet "Open in STARbase" under the sidebar, to the same page there. Hidden while STARBASE_URL
// is unset or /d1-links is not deployed.
const host = useExplorerHost();
const route = useRoute();
const starbaseUrl = ref<string | null>(null);
onMounted(async () => {
	starbaseUrl.value = await starbaseUrlOnce(host.api);
});
const starbaseHref = computed(() => (starbaseUrl.value ? starbaseUrlFor(starbaseUrl.value, route.fullPath) : null));
```

- in the template's `#navigation` slot, after the `<Finder …/>` line, add:

```vue
			<a v-if="starbaseHref" class="d1-open-starbase" :href="starbaseHref" target="_blank" rel="noopener">Open in STARbase</a>
```

- add a `<style scoped>` block (or append to it):

```css
.d1-open-starbase {
	display: block; margin: 8px 12px 16px; font-size: var(--fs-xs, 11px);
	color: var(--theme--foreground-subdued); text-decoration: none;
}
.d1-open-starbase:hover { text-decoration: underline; }
```

- [ ] **Step 4: Reports and label redirects learn `STARBASE_URL`**

In `core/extensions/d1-report/src/render.js`, replace `adminRecordUrl` and its comment with:

```js
// Where report QR codes and in-report links open (sign-in required). A record with an Explorer page
// opens there: in STARbase when `starbaseUrl` (STARBASE_URL) is set (spec §3.6, Q16), else in the
// Directus Home module (/admin/home/samples/<id>). Any other record goes to its Data Studio form.
// Both bases may carry trailing slashes. (Labels are printed from the labels page and encode a
// self-describing QR payload, not a link.)
export function adminRecordUrl(publicUrl, collection, id, starbaseUrl = '') {
	const base = String(publicUrl || '').replace(/\/+$/, '');
	const star = String(starbaseUrl || '').replace(/\/+$/, '');
	const key = encodeURIComponent(String(id));
	const page = EXPLORER_PAGES[collection];
	if (page && star) return `${star}/${page}/${key}`;
	return page ? `${base}/admin/home/${page}/${key}` : `${base}/admin/content/${collection}/${key}`;
}
```

In `render.js`:
- `renderOperationReport`: change
  `const { op: o, qrSvg, recordUrl, publicUrl, fa, fastRun } = d;` to
  `const { op: o, qrSvg, recordUrl, publicUrl, starbaseUrl, fa, fastRun } = d;`, and
  `adminRecordUrl(publicUrl, 'physical_samples', o.sample_id)` to
  `adminRecordUrl(publicUrl, 'physical_samples', o.sample_id, starbaseUrl)`;
- `renderTestReport`: the same two changes, on `t`.

In `core/extensions/d1-report/src/index.js`, inside `handler`, after the `notFound` helper, add:

```js
		// STARbase's address once it is deployed (STARBASE_URL, spec §3.6); '' until then.
		const starbaseUrl = () => String(env.STARBASE_URL || '').replace(/\/+$/, '');
```

Then:
- at the three `const recordUrl = adminRecordUrl(publicUrl, '<collection>', <id>);` lines, add the
  argument `starbaseUrl()`;
- in `renderOperationReport({ … publicUrl })` and `renderTestReport({ … publicUrl })`, add
  `starbaseUrl: starbaseUrl()`;
- replace the two label routes with:

```js
		// Label routes redirect to the labels page (no authentication required): STARbase's when it is
		// deployed, else the Directus Home module's.
		router.get('/label', (req, res) => {
			const star = starbaseUrl();
			const base = String(env.PUBLIC_URL || '').replace(/\/+$/, '');
			const target = new URL(star ? '/labels' : '/admin/home/labels', 'http://localhost');
			if (req.query.ids) target.searchParams.set('ids', req.query.ids);
			if (req.query.codes) target.searchParams.set('codes', req.query.codes);
			res.status(302).redirect((star || base) + target.pathname + target.search);
		});

		router.get('/labels', (req, res) => {
			const star = starbaseUrl();
			const base = String(env.PUBLIC_URL || '').replace(/\/+$/, '');
			res.status(302).redirect(star ? `${star}/labels` : `${base}/admin/home/labels`);
		});
```

If the "no Directus Home link is left" assertion names a link built some other way in a report body,
route that link through `adminRecordUrl(…, starbaseUrl)` as well.

In `core/README.md`, in the **endpoint** row, change the `d1-report` description to end
"…`/label` and `/labels` redirect to the labels page (STARbase's once `STARBASE_URL` is set)".
Then add after the `d1-usage` entry:
`, d1-links (/d1-links: { starbaseUrl } for Data Studio's "Open in STARbase" link; STARBASE_URL or null)`.

Add one line to `tests/ui/starbase/preview-ports.env`:

```
STARBASE_URL=http://127.0.0.1:5190
```

- [ ] **Step 5: Run the tests**

```bash
node --test core/extensions/*/index.test.mjs
npm test -w @d1/ui && npm run typecheck -w @d1/ui
npm run typecheck -w directus-extension-d1-home
(cd core/extensions/d1-report && npm test && npm run build)
```

Expected: every test passes, the typechecks are clean, and the d1-report build succeeds.

- [ ] **Step 6: The Directus regression run, and see the link**

```bash
npm run build:extensions
export D1_PREVIEW_NAME=d1-starbase D1_PREVIEW_PORT=18057 D1_PREVIEW_ENV_FILE=tests/ui/starbase/preview-ports.env
export D1_PREVIEW_OVERLAY="d1-home d1-admin-overview d1-fast-dashboard d1-campaign-ops d1-lab-dashboard d1-project-items d1-usage d1-edit-frame d1-links"
bash scripts/dev/explorer_preview.sh --stop; bash scripts/dev/explorer_preview.sh
CREDS="$PWD/.superpowers/preview-credentials-d1-starbase.txt"
(cd tests/ui && D1_ROUTES_CREDENTIALS="$CREDS" npx playwright test specs/13-explorer-routes.spec.ts --retries=0)
```

Expected: `4 passed`. In the Browser pane, open `http://127.0.0.1:18057/admin/home/samples` as the
member. Under the sidebar, "Open in STARbase" links to `http://127.0.0.1:5190/samples`.

- [ ] **Step 7: Commit**

```bash
git add core/extensions/d1-links core/extensions/d1-home/src/DirectusFrame.vue core/extensions/d1-report/src packages/d1-ui core/README.md tests/ui/starbase/preview-ports.env
git commit -m "feat(starbase): /d1-links and Data Studio's Open in STARbase; report links and label redirects follow STARBASE_URL

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin HEAD:feat/explorer-standalone
```

---

### Task 11: Deployment pieces (written, never run)

Nothing in this task starts, stops or recreates a service of the stack. The checks are:
- parse-only `docker compose config`, under the throwaway project name `d1-starbase-check`;
- `caddy validate`, and one serve of the built app (Step 7), each in a throwaway container;
- unit tests.

**Files:**
- Create: `apps/starbase/web/src/csp.ts`, `apps/starbase/web/src/csp.test.ts`
- Modify: `apps/starbase/web/vite.config.ts` (`preview.headers`)
- Modify: `infra/caddy/Caddyfile` (the `:8090` site)
- Create: `infra/tailscale/starbase-serve.json`
- Modify: `docker-compose.yml` (directus, filter-service, diag-service, proxy, the `starbase` service, volumes), `.env.example`
- Create: `tests/starbase_compose.test.mjs`
- Modify: `plugins/filter-service/app/main.py`, `plugins/diag-service/app/main.py` (`cors_options`)
- Create: `plugins/filter-service/tests/test_cors.py`, `plugins/diag-service/tests/test_cors.py`
- Modify: `.github/workflows/ci.yml` (a lint step), `.claude/skills/ci-local/scripts/plan_checks.sh`
- Create: `docs/runbooks/starbase.md`

**Interfaces:**
- Produces:
  - `starbaseCsp(d1Origin: string): string`;
  - `cors_options(origins_env: str) -> dict | None` in both sidecars;
  - the environment variables `STARBASE_ORIGIN`, `STARBASE_URL`, `STARBASE_TS_AUTHKEY`,
    `D1_SERVER_ORIGIN` and `SESSION_COOKIE_SECURE`.

- [ ] **Step 1: Write the failing tests**

`apps/starbase/web/src/csp.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { starbaseCsp } from './csp';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

describe("STARbase's CSP", () => {
	it('is exactly what Caddy sends in production', () => {
		const caddy = readFileSync(join(repo, 'infra', 'caddy', 'Caddyfile'), 'utf8');
		const line = caddy.split('\n').find((l) => l.includes('header Content-Security-Policy'));
		expect(line, 'the :8090 site sends a CSP').toBeDefined();
		expect(line).toContain(`"${starbaseCsp('{$D1_SERVER_ORIGIN}')}"`);
	});
	it('lets the app reach and frame d1-server, and nothing else', () => {
		const csp = starbaseCsp('https://d1-server.tail54eeb6.ts.net');
		expect(csp).toContain("connect-src 'self' https://d1-server.tail54eeb6.ts.net");
		expect(csp).toContain("img-src 'self' data: blob: https://d1-server.tail54eeb6.ts.net");
		expect(csp).toContain('frame-src https://d1-server.tail54eeb6.ts.net');
		expect(csp).toContain("script-src 'self'");
		expect(csp).toContain("frame-ancestors 'none'");
		expect(csp).not.toContain('*');
	});
});
```

`tests/starbase_compose.test.mjs`:

```js
// node --test tests/starbase_compose.test.mjs
// STARbase's compose wiring, checked with parse-only `docker compose config` under a throwaway project
// name (no container is created or touched). Skipped where docker is not installed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const SECRETS = ['POSTGRES_PASSWORD', 'MINIO_ROOT_PASSWORD', 'DIRECTUS_KEY', 'DIRECTUS_SECRET', 'DIRECTUS_ADMIN_PASSWORD', 'WORKER_WEBHOOK_SECRET', 'REDIS_PASSWORD'];
const STAR = 'https://starbase.tail54eeb6.ts.net';
let docker = true;
try {
	execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' });
} catch {
	docker = false;
}

function config(extra, profile) {
	const env = join(mkdtempSync(join(tmpdir(), 'sb-compose-')), '.env');
	writeFileSync(env, [...SECRETS.map((v) => `${v}=x`), 'FORCE_APP_ORIGIN=http://localhost:5180', ...extra].join('\n') + '\n');
	const args = ['compose', '-p', 'd1-starbase-check', '--env-file', env, ...(profile ? ['--profile', profile] : []), 'config', '--format', 'json'];
	return JSON.parse(execFileSync('docker', args, { cwd: repo, encoding: 'utf8' }));
}

test('without STARBASE_ORIGIN nothing is added: no trailing comma, no extra origin, no starbase device', { skip: !docker }, () => {
	const c = config([]);
	assert.equal(c.services.directus.environment.CORS_ORIGIN, 'http://localhost:5180');
	assert.equal(c.services['filter-service'].environment.FILTER_CORS_ORIGINS, 'http://localhost:5180');
	assert.equal(c.services['diag-service'].environment.DIAG_CORS_ORIGINS, 'http://localhost:5180');
	assert.equal(c.services.directus.environment.CONTENT_SECURITY_POLICY_DIRECTIVES__FRAME_ANCESTORS, "'self'");
	assert.equal(c.services.directus.environment.SESSION_COOKIE_SECURE, 'false');
	assert.equal(c.services.starbase, undefined);
});

test('with STARBASE_ORIGIN, the three CORS lists and the frame setting gain exactly that origin', { skip: !docker }, () => {
	const c = config([`STARBASE_ORIGIN=${STAR}`, `STARBASE_URL=${STAR}`, 'SESSION_COOKIE_SECURE=true'], 'starbase');
	assert.equal(c.services.directus.environment.CORS_ORIGIN, `http://localhost:5180,${STAR}`);
	assert.equal(c.services.directus.environment.CORS_CREDENTIALS, 'true');
	assert.equal(c.services['filter-service'].environment.FILTER_CORS_ORIGINS, `http://localhost:5180,${STAR}`);
	assert.equal(c.services['diag-service'].environment.DIAG_CORS_ORIGINS, `http://localhost:5180,${STAR}`);
	assert.equal(c.services.directus.environment.CONTENT_SECURITY_POLICY_DIRECTIVES__FRAME_ANCESTORS, `'self' ${STAR}`);
	assert.equal(c.services.directus.environment.STARBASE_URL, STAR);
	assert.equal(c.services.directus.environment.SESSION_COOKIE_SECURE, 'true');
});

test('the starbase device: its own hostname and tag, serve config, state volume', { skip: !docker }, () => {
	const s = config([`STARBASE_ORIGIN=${STAR}`, 'STARBASE_TS_AUTHKEY=tskey-test'], 'starbase').services.starbase;
	assert.equal(s.environment.TS_HOSTNAME, 'starbase');
	assert.equal(s.environment.TS_EXTRA_ARGS, '--advertise-tags=tag:starbase');
	assert.equal(s.environment.TS_SERVE_CONFIG, '/config/starbase-serve.json');
	assert.ok(s.volumes.some((v) => v.target === '/var/lib/tailscale'));
});

test('the proxy serves the built STARbase on :8090 without publishing it', { skip: !docker }, () => {
	const p = config([]).services.proxy;
	assert.ok(p.volumes.some((v) => v.target === '/srv/starbase'));
	assert.ok(!(p.ports ?? []).some((x) => String(x.target) === '8090'));
	assert.equal(p.environment.D1_SERVER_ORIGIN, 'https://d1-server.tail54eeb6.ts.net');
});
```

`plugins/filter-service/tests/test_cors.py`:

```python
"""CORS for the standalone apps: exact origins, with credentials (STARbase sends the Directus session
cookie, ADR-0013; the Force App sends a Bearer token, which credentials do not harm). Never '*'."""

import sys
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app.main as m  # noqa: E402

STAR = "https://starbase.tail54eeb6.ts.net"


def _client(origins: str) -> TestClient:
    app = FastAPI()

    @app.get("/health")
    def health():
        return {"ok": True}

    app.add_middleware(CORSMiddleware, **m.cors_options(origins))
    return TestClient(app)


def test_no_origins_means_no_cors():
    assert m.cors_options("") is None
    assert m.cors_options(" , ") is None


def test_a_wildcard_is_never_allowed():
    assert m.cors_options("*") is None
    assert m.cors_options(f"*,{STAR}")["allow_origins"] == [STAR]


def test_starbase_gets_a_credentialed_preflight():
    r = _client(f"http://localhost:5180,{STAR}").options(
        "/health",
        headers={"Origin": STAR, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type"},
    )
    assert r.status_code == 200
    assert r.headers["access-control-allow-origin"] == STAR
    assert r.headers["access-control-allow-credentials"] == "true"


def test_another_origin_is_refused():
    r = _client(STAR).options("/health", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"})
    assert "access-control-allow-origin" not in r.headers
```

`plugins/diag-service/tests/test_cors.py` has a different head, because diag-service's `app.main`
imports `scripts/diag`. Its first lines are:

```python
"""CORS for the standalone apps: exact origins, with credentials (STARbase sends the Directus session
cookie, ADR-0013; the Force App sends a Bearer token, which credentials do not harm). Never '*'."""

import os
import sys

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.testclient import TestClient

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
for _p in (os.path.join(_REPO, "scripts"), os.path.join(_REPO, "plugins", "diag-service")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import app.main as m  # noqa: E402
```

Everything after them, from `STAR = "https://starbase.tail54eeb6.ts.net"` to the end, is the same as
in the filter-service file above.

Run:
```bash
npm test -w starbase-web -- csp
node --test tests/starbase_compose.test.mjs
py -m venv .superpowers/venv-filter && .superpowers/venv-filter/Scripts/python -m pip install -q -r plugins/filter-service/requirements.txt
(cd plugins/filter-service && ../../.superpowers/venv-filter/Scripts/python -m pytest tests/test_cors.py -q)
py -m venv .superpowers/venv-diag && .superpowers/venv-diag/Scripts/python -m pip install -q -r plugins/diag-service/requirements.txt
(cd plugins/diag-service && ../../.superpowers/venv-diag/Scripts/python -m pytest tests/test_cors.py -q)
```
Expected: FAIL.
- `./csp` is missing.
- The compose tests fail on `CORS_ORIGIN` and on the missing `starbase` service.
- `cors_options` does not exist.

- [ ] **Step 2: The CSP and `vite preview`**

`apps/starbase/web/src/csp.ts`:

```ts
// STARbase's Content-Security-Policy, in one place. Caddy sends it in production (infra/caddy/Caddyfile;
// csp.test.ts checks they match) and `vite preview` sends it for the end-to-end run, so the tests see
// what the lab sees. `d1` is d1-server's origin: the API, /filter, /diag, /octrees, the asset thumbnails
// and the framed edit form all live there.
export function starbaseCsp(d1: string): string {
	return [
		"default-src 'self'",
		`connect-src 'self' ${d1}`,
		`img-src 'self' data: blob: ${d1}`,
		`frame-src ${d1}`,
		// Vue's style bindings and the label preview (a srcdoc frame, which inherits this CSP) set inline styles.
		"style-src 'self' 'unsafe-inline'",
		"script-src 'self'",
		"font-src 'self' data:",
		// three.js and potree may start workers from blobs.
		"worker-src 'self' blob:",
		"object-src 'none'",
		"base-uri 'self'",
		"frame-ancestors 'none'",
	].join('; ');
}
```

`apps/starbase/web/vite.config.ts`: add `import { starbaseCsp } from './src/csp';`, and change
`preview` to:

```ts
	// The production CSP on the preview server too (Task 12 runs the e2e against `vite preview`), aimed at
	// the preview Directus unless STARBASE_D1_ORIGIN says otherwise.
	preview: {
		host: '127.0.0.1',
		port: 5190,
		strictPort: true,
		headers: { 'Content-Security-Policy': starbaseCsp(process.env.STARBASE_D1_ORIGIN ?? 'http://127.0.0.1:18057') },
	},
```

- [ ] **Step 3: Caddy, tailscale serve, compose and the environment**

Append to `infra/caddy/Caddyfile`, after the closing `}` of the `:80` site:

```
# STARbase (apps/starbase/web, built into dist/; ADR-0013, docs/runbooks/starbase.md). The `starbase`
# container (docker-compose.yml, profile starbase) runs tailscale serve: HTTPS 443 on its own tailnet
# device → http://proxy:8090. This port is never published on the host. STARbase calls d1-server
# cross-origin with the Directus session cookie; the CSP allows exactly that origin
# (apps/starbase/web/src/csp.ts holds the same string, and its test compares them).
:8090 {
    header Content-Security-Policy "default-src 'self'; connect-src 'self' {$D1_SERVER_ORIGIN}; img-src 'self' data: blob: {$D1_SERVER_ORIGIN}; frame-src {$D1_SERVER_ORIGIN}; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self' data:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
    header X-Content-Type-Options nosniff
    header Referrer-Policy strict-origin-when-cross-origin
    # Where d1-server is: the app reads this at boot (apps/starbase/web/src/config.ts). One setting, here.
    handle /config.json {
        header Content-Type application/json
        header Cache-Control no-cache
        respond `{"directusUrl":"{$D1_SERVER_ORIGIN}"}` 200
    }
    handle {
        root * /srv/starbase
        # Hashed bundles never change; everything else (index.html, the SPA routes) revalidates.
        @assets path /assets/*
        header @assets Cache-Control "public, max-age=31536000, immutable"
        @app not path /assets/*
        header @app Cache-Control no-cache
        try_files {path} /index.html
        file_server
    }
}
```

Check that the CSP string is exactly `starbaseCsp('{$D1_SERVER_ORIGIN}')`. `csp.test.ts` will say if
it is not.

`infra/tailscale/starbase-serve.json`:

```json
{
  "TCP": { "443": { "HTTPS": true } },
  "Web": {
    "${TS_CERT_DOMAIN}:443": { "Handlers": { "/": { "Proxy": "http://proxy:8090" } } }
  },
  "AllowFunnel": { "${TS_CERT_DOMAIN}:443": false }
}
```

containerboot replaces `${TS_CERT_DOMAIN}` with the device's name, `starbase.<tailnet>.ts.net`, and
re-applies the file when it changes. This is from the `cmd/containerboot` documentation, under
`TS_SERVE_CONFIG`.

In `docker-compose.yml`:

- `directus` → `environment`. Replace the CORS comment and the two CORS lines with:

```yaml
      # CORS for the standalone apps on their own origins: the Force App (apps/force-app/web, Bearer
      # tokens) and STARbase (apps/starbase/web, the Directus session cookie, ADR-0013), each from its own
      # variable. An unset STARBASE_ORIGIN adds nothing. Comma-separate several Force App origins in .env.
      CORS_ENABLED: "true"
      CORS_ORIGIN: ${FORCE_APP_ORIGIN:-http://localhost:5180}${STARBASE_ORIGIN:+,${STARBASE_ORIGIN}}
      CORS_CREDENTIALS: "true"
      # STARbase frames the form-only edit page (/admin/d1-edit/…, spec §3.4); no other origin may.
      CONTENT_SECURITY_POLICY_DIRECTIVES__FRAME_ANCESTORS: "'self'${STARBASE_ORIGIN:+ ${STARBASE_ORIGIN}}"
      # true behind the HTTPS tailnet entry (runbook step 3); false keeps plain-HTTP local use signed in.
      SESSION_COOKIE_SECURE: "${SESSION_COOKIE_SECURE:-false}"
      # STARbase's address for report QR codes and links, the label redirects and Data Studio's "Open in
      # STARbase" (d1-report, d1-links; spec §3.6). Unset: the Directus Home module.
      STARBASE_URL: ${STARBASE_URL:-}
```

- `filter-service` → `environment`: replace the CORS comment and `FILTER_CORS_ORIGINS` with:

```yaml
      # CORS for the standalone apps: the Force App calls /filter/* with a Bearer token, STARbase with the
      # Directus session cookie (credentials allowed, exact origins only); both are forwarded to Directus
      # for asset authz. The X-Filter-* response headers are exposed.
      FILTER_CORS_ORIGINS: ${FORCE_APP_ORIGIN:-http://localhost:5180}${STARBASE_ORIGIN:+,${STARBASE_ORIGIN}}
```

- `diag-service` → `environment`: replace the CORS comment and `DIAG_CORS_ORIGINS` with:

```yaml
      # CORS for the standalone apps (Force App: Bearer; STARbase: the session cookie, credentials allowed).
      DIAG_CORS_ORIGINS: ${FORCE_APP_ORIGIN:-http://localhost:5180}${STARBASE_ORIGIN:+,${STARBASE_ORIGIN}}
```

- `proxy`:
  - under `volumes`, after the `force-app` line, add
    `      - ./apps/starbase/web/dist:/srv/starbase:ro   # STARbase SPA, served on :8090 (not published; the starbase device proxies to it)`;
  - add an `environment` block after `extra_hosts`:

```yaml
    environment:
      # d1-server's origin as STARbase calls it: Caddy's :8090 site answers /config.json and builds the CSP from it.
      D1_SERVER_ORIGIN: ${D1_SERVER_ORIGIN:-https://d1-server.tail54eeb6.ts.net}
```

- After the `proxy` service, add:

```yaml
  # STARbase's own tailnet device (ADR-0013, spec §3.7): https://starbase.<tailnet>.ts.net → proxy:8090.
  # Opt-in profile, so the stack still starts without its auth key:
  #   docker compose --profile starbase up -d starbase        (docs/runbooks/starbase.md, step 4)
  starbase:
    image: tailscale/tailscale:stable
    profiles: ["starbase"]
    restart: unless-stopped
    depends_on: [proxy]
    environment:
      TS_HOSTNAME: starbase
      TS_AUTHKEY: ${STARBASE_TS_AUTHKEY:-}
      TS_EXTRA_ARGS: --advertise-tags=tag:starbase
      TS_STATE_DIR: /var/lib/tailscale
      TS_SERVE_CONFIG: /config/starbase-serve.json
    volumes:
      - starbase-ts-state:/var/lib/tailscale
      - ./infra/tailscale:/config:ro
    networks: [d1net]
```

- Under the top-level `volumes:`, add `  starbase-ts-state:` after `caddy-config:`.

In `.env.example`:
- change the comment above `FORCE_APP_ORIGIN` to begin "Origins of the standalone Force App
  (Bearer tokens) allowed to call Directus, filter-service and diag-service cross-origin:";
- after the `FORCE_APP_ORIGIN=` line, add:

```
# ---- STARbase (apps/starbase/web; ADR-0013, docs/runbooks/starbase.md) ----
# STARbase's exact origin: allowed with credentials by Directus, filter-service and diag-service, and
# allowed to frame the edit form. Leave empty until STARbase is deployed (nothing is added then).
STARBASE_ORIGIN=
# Where report QR codes and links, the label redirects and Data Studio's "Open in STARbase" point.
# Empty = the Directus Home module. Set it on STARbase's first deploy (spec Q16).
STARBASE_URL=
# Tagged (tag:starbase) Tailscale auth key for the `starbase` device; used only by the starbase profile.
STARBASE_TS_AUTHKEY=
# d1-server's origin as STARbase calls it (Caddy's :8090 site: /config.json and the CSP).
D1_SERVER_ORIGIN=https://d1-server.tail54eeb6.ts.net
# Directus's session cookie is Secure: true behind HTTPS (the tailnet entry), false for plain-HTTP local use.
SESSION_COOKIE_SECURE=false
```

- [ ] **Step 4: Credentials in the sidecars' CORS**

In `plugins/filter-service/app/main.py`, replace the block from `_cors_origins = [` through the end of
its `app.add_middleware(…)` call with:

```python
def cors_options(origins_env: str) -> dict | None:
    """CORSMiddleware options for the comma-separated FILTER_CORS_ORIGINS, or None for none.

    Credentials are allowed: STARbase calls with the Directus session cookie (ADR-0013), which this
    service forwards to Directus. The Force App sends a Bearer token instead, which is not harmed.
    Origins are exact; a '*' is dropped (a wildcard must never be combined with credentials)."""
    origins = [o.strip() for o in origins_env.split(",") if o.strip() and o.strip() != "*"]
    if not origins:
        return None
    return {
        "allow_origins": origins,
        "allow_credentials": True,
        "allow_methods": ["GET", "POST", "OPTIONS"],
        "allow_headers": ["Authorization", "Content-Type"],
        "expose_headers": ["X-Filter-Skipped", "X-Filter-Ms", "X-Filter-Stride"],
    }


_cors = cors_options(os.environ.get("FILTER_CORS_ORIGINS", ""))
if _cors:
    app.add_middleware(CORSMiddleware, **_cors)
```

In `plugins/diag-service/app/main.py`, do the same for the block from `_cors = [` through its
`add_middleware`. Read `DIAG_CORS_ORIGINS`, with `"expose_headers"` set to the six `X-Diag-*`
headers that are there today (`X-Diag-Cache`, `X-Diag-Ms`, `X-Diag-Preview`, `X-Diag-Skipped`,
`X-Diag-Viewport-N`, `X-Diag-Viewport-Cols`). Name the result `_cors` as before.

- [ ] **Step 5: CI**

In `.github/workflows/ci.yml`, in the `lint` job, after the "Extension endpoint tests" step, add:

```yaml
      - name: "STARbase compose wiring (parse-only)"
        if: ${{ !cancelled() }}
        run: node --test tests/starbase_compose.test.mjs
```

In `.claude/skills/ci-local/scripts/plan_checks.sh`, after the line that echoes
`bash tests/phase0_smoke.sh`, add:

```bash
has '^(docker-compose\.yml|\.env\.example|infra/(caddy|tailscale)/)' && echo "node --test tests/starbase_compose.test.mjs && npm test -w starbase-web -- csp   # CI: lint, directus-ui"
```

- [ ] **Step 6: Run every check**

```bash
npm test -w starbase-web && npm run typecheck -w starbase-web
node --test tests/starbase_compose.test.mjs
bash tests/phase0_smoke.sh
MSYS_NO_PATHCONV=1 docker run --rm -e D1_SERVER_ORIGIN=https://d1-server.tail54eeb6.ts.net \
  -v "$(pwd -W)/infra/caddy/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2-alpine \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
(cd plugins/filter-service && ../../.superpowers/venv-filter/Scripts/python -m pytest -q)
(cd plugins/diag-service && ../../.superpowers/venv-diag/Scripts/python -m pytest -q)
node --test .github/scripts/ci-plan.test.mjs
```

Expected:
- every test passes;
- `phase0_smoke.sh` reports `.env.example` covering each new variable, and both `docker compose
  config` checks pass;
- `caddy validate` prints `Valid configuration`;
- both sidecars' whole suites pass.

If the compose test fails only on the nested `${STARBASE_ORIGIN:+,${STARBASE_ORIGIN}}`, that is, the
installed compose cannot nest inside `:+`, stop and report it to the maintainer. Do not fall back to a
localhost default.

- [ ] **Step 7: Serve the build the way production will**

`caddy validate` only parses the file. Report QR codes open deep paths such as `/samples/<uuid>`, and in
production only Caddy's SPA fallback serves them. Every e2e run uses `vite preview`, which has its
own fallback. A broken `/config.json` would also go unnoticed, because `DEFAULT_DIRECTUS_URL`
happens to be right. So serve the real build with the real Caddyfile once, in a throwaway container
that is not compose and not the stack's proxy. Only 8090 is published, on `127.0.0.1:18090`.

```bash
npm run build -w starbase-web
MSYS_NO_PATHCONV=1 docker run -d --name d1-starbase-caddy-check -p 127.0.0.1:18090:8090 \
  -e D1_SERVER_ORIGIN=https://d1-server.tail54eeb6.ts.net \
  -v "$(pwd -W)/infra/caddy/Caddyfile:/etc/caddy/Caddyfile:ro" \
  -v "$(pwd -W)/apps/starbase/web/dist:/srv/starbase:ro" caddy:2-alpine
H=http://127.0.0.1:18090
curl -fsS --retry 10 --retry-connrefused --retry-delay 1 "$H/config.json"; echo
curl -fsSI "$H/samples/3f2b8a1c-0000-4000-8000-000000000001" | grep -iE '^(content-type|cache-control|content-security-policy):'
curl -fsS "$H/samples/3f2b8a1c-0000-4000-8000-000000000001" | grep -c '<title>STARbase</title>'
A=$(basename "$(ls apps/starbase/web/dist/assets/*.js | head -1)")
curl -fsSI "$H/assets/$A" | grep -iE '^(cache-control|content-security-policy):'
docker rm -f d1-starbase-caddy-check
```

Expected:
- `/config.json` prints `{"directusUrl":"https://d1-server.tail54eeb6.ts.net"}`, which is valid JSON;
- the deep path answers with `content-type: text/html`, `cache-control: no-cache`, and the CSP
  naming `https://d1-server.tail54eeb6.ts.net` in `connect-src` and `frame-src`. Its body is
  `index.html`, so the count is `1`;
- the hashed asset answers with `cache-control: public, max-age=31536000, immutable`, and with the
  same CSP.

- [ ] **Step 8: The runbook**

`docs/runbooks/starbase.md`:

````markdown
# STARbase: rollout and redeploy

STARbase (`apps/starbase/web`) is the group's web app at `https://starbase.tail54eeb6.ts.net`, on its own
tailnet device, signing in with Directus's own session ([ADR-0013](../adr/0013-starbase-separate-tailnet-device-shared-directus-session.md),
[spec](../superpowers/specs/2026-10-12-starbase-standalone-design.md)). It runs beside the Directus Home
module; nothing is removed.

Every step below is the maintainer's, on d1-server, each approved on its own. Nothing here runs from a
development session.

## Before you start

- `feat/explorer-standalone` is merged and the main checkout is up to date.
- You can edit the tailnet policy and create auth keys.

## 1. Tailnet policy

Add the tag, owned by you, and let the people who reach d1-server reach STARbase on 443:

```jsonc
"tagOwners": { "tag:starbase": ["<your login>"] },
// next to the rule that grants d1-server, with the same sources:
{ "src": ["<the d1-server audience>"], "dst": ["tag:starbase"], "ip": ["443"] }
```

### 1a. Shared devices

If d1-server is shared with anyone outside the tailnet (device sharing), share `starbase` with the same
people: access rules do not reach share recipients. First confirm in the admin console that a tagged
device can be shared this way.

## 2. Auth key

Admin console → Settings → Keys → Generate auth key: **reusable**, **not ephemeral** (the device keeps
its state in the `starbase-ts-state` volume), **pre-approved**, tag `tag:starbase`. Put it in `.env`:

```
STARBASE_TS_AUTHKEY=tskey-auth-…
```

## 3. Settings (`.env`)

```
STARBASE_ORIGIN=https://starbase.tail54eeb6.ts.net
STARBASE_URL=https://starbase.tail54eeb6.ts.net
SESSION_COOKIE_SECURE=true
D1_SERVER_ORIGIN=https://d1-server.tail54eeb6.ts.net
```

`docker-compose.yml` joins `STARBASE_ORIGIN` onto Directus's `CORS_ORIGIN` (with `CORS_CREDENTIALS=true`),
onto `FILTER_CORS_ORIGINS` and `DIAG_CORS_ORIGINS`, and onto
`CONTENT_SECURITY_POLICY_DIRECTIVES__FRAME_ANCESTORS` (`'self' <STARbase>`). Check them before going on:

```bash
docker compose config | grep -E 'CORS_ORIGIN|CORS_ORIGINS|FRAME_ANCESTORS|SESSION_COOKIE_SECURE|STARBASE_URL'
```

Later, for Google sign-in (out of scope now): `AUTH_PROVIDERS=google`, `AUTH_GOOGLE_MODE=session`, and
`AUTH_GOOGLE_REDIRECT_ALLOW_LIST` including `https://starbase.tail54eeb6.ts.net/signin/done`. STARbase
shows the button by itself once Directus lists the provider.

## 4. Build and start

```bash
npm ci
npm run build:starbase                                   # apps/starbase/web/dist, served by Caddy on :8090
npm run build -w directus-extension-d1-edit-frame        # the framed form page
(cd core/extensions/d1-report && npm ci && npm run build)  # report links follow STARBASE_URL
docker compose up -d --force-recreate directus filter-service diag-service proxy
docker compose --profile starbase up -d starbase
docker compose logs --tail 50 starbase                   # expect the node to log in and the serve config to be applied
```

`d1-links` (`/d1-links`) needs no build.

## 5. Smoke check (with someone on a second device)

1. Open `https://starbase.tail54eeb6.ts.net` over the tailnet: the sign-in page, with the STAR logo.
2. Sign in. In another tab, open Data Studio: already signed in.
3. Open a test record, **Edit**: the Directus form opens inside STARbase. Change a field, Save: the
   dialog closes and the page shows the new value. Put it back.
4. Plot one force operation (`/plot/force?operation=<id>`): the signals draw, the **FRM map** streams
   (`/octrees`), a **filter preview** answers (`/filter`), and a **diagnostics preview** answers (`/diag`).
5. In Data Studio's Home module, "Open in STARbase" is under the sidebar and opens the same page.
6. Print a sample report: its QR code and link open the STARbase record page.
7. Sign out of STARbase: Data Studio is signed out too.
8. On a phone (if it is on the tailnet): the top bar and menu, a list as cards, a record page.
9. Real Safari / iOS, if anyone has it: steps 1–3. Step 0 tested Chromium only (spec §9).

If step 3 shows "The form didn't open here", check that the frame setting reached Directus:
`curl -sI https://d1-server.tail54eeb6.ts.net/admin/ | grep -i content-security-policy` must contain
`frame-ancestors 'self' https://starbase.tail54eeb6.ts.net`. The new-tab fallback works meanwhile.

## Redeploying after a change

```bash
git pull && npm ci && npm run build:starbase
docker compose up -d --force-recreate proxy
```

(the same rhythm as the Force App's `/app/`). A change to `d1-edit-frame` also needs its build and a
`directus` recreate.

## Rolling back

```bash
docker compose --profile starbase stop starbase
```

Then empty `STARBASE_ORIGIN` and `STARBASE_URL` in `.env`, set `SESSION_COOKIE_SECURE` as it was, and
`docker compose up -d --force-recreate directus filter-service diag-service proxy`. Reports and the label
redirects return to the Directus Home module; nothing else changes.
````

- [ ] **Step 9: Commit**

```bash
git add apps/starbase/web infra/caddy/Caddyfile infra/tailscale/starbase-serve.json docker-compose.yml .env.example \
  tests/starbase_compose.test.mjs plugins/filter-service plugins/diag-service .github/workflows/ci.yml \
  .claude/skills/ci-local/scripts/plan_checks.sh docs/runbooks/starbase.md
git commit -m "feat(starbase): deployment pieces (tailnet device, Caddy :8090 with CSP, credentialed CORS) and the runbook; nothing run

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin HEAD:feat/explorer-standalone
```

---
### Task 12: End to end on the preview

The spec §5 flows are checked against the `d1-starbase` preview, with STARbase served by `vite preview`
under the production CSP, in two layouts:
- **ports** (the default): one host, two ports;
- **hosts**: step 0's two tailnet hostnames over local HTTPS, which is now a committed helper.

Plan 1's route harness also runs against STARbase.

**Files:**
- Create: `tests/ui/starbase/hosts.ts`, `tests/ui/starbase/target.ts`, `tests/ui/starbase/preview-hosts.env`
- Create: `tests/ui/specs/14-starbase.spec.ts`
- Modify: `tests/ui/specs/13-explorer-routes.spec.ts` (a STARbase mode), `tests/ui/README.md`

**Interfaces:**
- Consumes:
  - the preview credentials file (`url=`, `admin=`, `member=`);
  - `tests/ui/starbase/preview-ports.env` (Tasks 5 and 10);
  - every STARbase name the specs click: the button **Sign out**, the button **Menu**, the dialog
    **Pages**, the dialog **Edit record**, the button **Open in a new tab**, `h1.sb-title`,
    `.sb-content`, `iframe.sb-editor-frame`.
- Produces:
  - `startHostsLayout(): Promise<{ close(): Promise<void> }>`, `HOSTS_LAUNCH_ARGS`, `STAR_HOST` and
    `D1_HOST` (from `hosts.ts`);
  - `MODE`, `STAR_BASE`, `D1_BASE`, `D1_LOCAL`, `pointAtD1`, `signInStarbase`, `fillSignIn`,
    `adminApi` and `firstId` (from `target.ts`);
  - the environment variables `STARBASE_E2E_MODE`, `STARBASE_E2E_CREDENTIALS` and
    `D1_ROUTES_STARBASE`.

- [ ] **Step 1: The two-hostname helper (step 0, committed)**

`tests/ui/starbase/hosts.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Step 0's layout (spec §9, run 2), kept: starbase.<tailnet> and d1-server.<tailnet> mapped to this machine
// in the test browser, each over HTTPS with a throwaway certificate, so cookies are tested across HOSTS
// (ports alone prove nothing: cookies ignore ports) and Directus's cookie can be Secure.
//   https://starbase.<tailnet>:5191  → http://127.0.0.1:5190  (vite preview; Host rewritten, it checks it)
//   https://d1-server.<tailnet>:18443 → http://127.0.0.1:18057 (the preview Directus; headers as sent)
export const TAILNET = 'tail54eeb6.ts.net';
export const STAR_HOST = `starbase.${TAILNET}`;
export const D1_HOST = `d1-server.${TAILNET}`;
export const HOSTS_LAUNCH_ARGS = [`--host-resolver-rules=MAP *.${TAILNET} 127.0.0.1`, '--ignore-certificate-errors'];

export function throwawayCert(): { key: Buffer; cert: Buffer } {
	const dir = mkdtempSync(join(tmpdir(), 'starbase-cert-'));
	execFileSync(
		'openssl',
		['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=starbase-e2e', '-addext', `subjectAltName=DNS:${STAR_HOST},DNS:${D1_HOST}`,
			'-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '2'],
		{ stdio: 'ignore', env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
	);
	return { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) };
}

export interface ProxyOptions {
	listenPort: number;
	targetPort: number;
	rewriteHost: boolean;
	tls: { key: Buffer; cert: Buffer };
}

// node:https in front of a local http server; every header, Set-Cookie included, passed through both ways.
export function startHttpsProxy(o: ProxyOptions): Promise<https.Server> {
	const server = https.createServer(o.tls, (req, res) => {
		const headers = o.rewriteHost ? { ...req.headers, host: `127.0.0.1:${o.targetPort}` } : req.headers;
		const upstream = http.request({ host: '127.0.0.1', port: o.targetPort, method: req.method, path: req.url, headers }, (ur) => {
			const pairs: [string, string][] = [];
			for (let i = 0; i < ur.rawHeaders.length; i += 2) pairs.push([ur.rawHeaders[i], ur.rawHeaders[i + 1]]);
			res.writeHead(ur.statusCode ?? 502, pairs as unknown as http.OutgoingHttpHeaders);
			ur.pipe(res);
		});
		upstream.on('error', (e) => {
			res.statusCode = 502;
			res.end(String(e));
		});
		req.pipe(upstream);
	});
	return new Promise((resolve) => server.listen(o.listenPort, '127.0.0.1', () => resolve(server)));
}

export async function startHostsLayout(): Promise<{ close(): Promise<void> }> {
	const tls = throwawayCert();
	const servers = [
		await startHttpsProxy({ listenPort: 5191, targetPort: 5190, rewriteHost: true, tls }),
		await startHttpsProxy({ listenPort: 18443, targetPort: 18057, rewriteHost: false, tls }),
	];
	return {
		close: async () => {
			for (const s of servers) {
				s.closeAllConnections();
				await new Promise<void>((r) => s.close(() => r()));
			}
		},
	};
}
```

`tests/ui/starbase/target.ts`:

```ts
import { expect, type APIRequestContext, type BrowserContext, type Page, type PlaywrightWorkerArgs } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { D1_HOST, STAR_HOST } from './hosts';

// Where the STARbase end-to-end run points (spec §5):
//   ports (default): STARbase on http://127.0.0.1:5190 (vite preview), the preview Directus on
//     http://127.0.0.1:18057. One host, so the session cookie is same-site; not Secure (plain HTTP).
//   hosts (STARBASE_E2E_MODE=hosts): step 0's two hostnames over local HTTPS (hosts.ts), Secure cookie.
export type Mode = 'ports' | 'hosts';
export const MODE: Mode = process.env.STARBASE_E2E_MODE === 'hosts' ? 'hosts' : 'ports';
export const STAR_BASE = MODE === 'hosts' ? `https://${STAR_HOST}:5191` : 'http://127.0.0.1:5190';
export const D1_BASE = MODE === 'hosts' ? `https://${D1_HOST}:18443` : 'http://127.0.0.1:18057';
// The tests' own API calls (finding ids, checking and putting values back) go straight to the preview.
export const D1_LOCAL = 'http://127.0.0.1:18057';

const repo = join(__dirname, '..', '..', '..');
const credsFile = process.env.STARBASE_E2E_CREDENTIALS || join(repo, '.superpowers', 'preview-credentials-d1-starbase.txt');
const creds: Record<string, string> = Object.fromEntries(
	readFileSync(credsFile, 'utf8').trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);

// "<email> <password>", split on the first space only.
export function account(who: 'admin' | 'member'): [string, string] {
	const v = creds[who];
	const i = v.indexOf(' ');
	return [v.slice(0, i), v.slice(i + 1)];
}

// STARbase reads /config.json at boot; vite preview has none, so each browser context answers it.
export async function pointAtD1(context: BrowserContext): Promise<void> {
	await context.route(`${STAR_BASE}/config.json`, (r) => r.fulfill({ json: { directusUrl: D1_BASE } }));
}

export async function fillSignIn(page: Page, who: 'admin' | 'member'): Promise<void> {
	const [email, password] = account(who);
	await page.locator('input[type="email"]').fill(email);
	await page.locator('input[type="password"]').fill(password);
	await page.getByRole('button', { name: /^sign in$/i }).click();
}

export async function signInStarbase(page: Page, who: 'admin' | 'member'): Promise<void> {
	await pointAtD1(page.context());
	await page.goto(`${STAR_BASE}/signin`, { waitUntil: 'domcontentloaded' });
	await fillSignIn(page, who);
	await page.waitForURL((u) => !u.pathname.startsWith('/signin'), { timeout: 30_000 });
}

export async function adminApi(playwright: PlaywrightWorkerArgs['playwright']): Promise<APIRequestContext> {
	const [email, password] = account('admin');
	const anon = await playwright.request.newContext();
	const login = await anon.post(`${D1_LOCAL}/auth/login`, { data: { email, password, mode: 'json' } });
	expect(login.ok(), 'admin API login').toBeTruthy();
	const token = (await login.json()).data.access_token as string;
	await anon.dispose();
	return playwright.request.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
}

// The first record's primary key (not every collection's key is `id`).
export async function firstId(api: APIRequestContext, collection: string): Promise<string> {
	const fields = (await (await api.get(`${D1_LOCAL}/fields/${collection}`)).json()).data as { field: string; schema?: { is_primary_key?: boolean } }[];
	const pk = fields.find((x) => x.schema?.is_primary_key)!.field;
	const rows = (await (await api.get(`${D1_LOCAL}/items/${collection}?limit=1&fields=${encodeURIComponent(pk)}`)).json()).data as Record<string, string>[];
	expect(rows[0]?.[pk], `${collection}: a record to use`).toBeTruthy();
	return String(rows[0][pk]);
}
```

`tests/ui/starbase/preview-hosts.env`:

```
CORS_ENABLED=true
CORS_ORIGIN=https://starbase.tail54eeb6.ts.net:5191
CORS_CREDENTIALS=true
CONTENT_SECURITY_POLICY_DIRECTIVES__FRAME_ANCESTORS='self' https://starbase.tail54eeb6.ts.net:5191
SESSION_COOKIE_SECURE=true
STARBASE_URL=https://starbase.tail54eeb6.ts.net:5191
```

- [ ] **Step 2: The STARbase specs**

`tests/ui/specs/14-starbase.spec.ts`:

```ts
import { test, expect, type Page } from '@playwright/test';
import { HOSTS_LAUNCH_ARGS, startHostsLayout } from '../starbase/hosts';
import { D1_BASE, D1_LOCAL, MODE, STAR_BASE, adminApi, fillSignIn, firstId, pointAtD1, signInStarbase } from '../starbase/target';

// STARbase end to end (spec §5) on the d1-starbase preview, with STARbase served by `vite preview` under
// its production CSP. How to run both layouts: tests/ui/README.md, spec 14.

if (MODE === 'hosts') test.use({ launchOptions: { args: HOSTS_LAUNCH_ARGS }, ignoreHTTPSErrors: true });
test.describe.configure({ mode: 'serial' });

let layout: { close(): Promise<void> } | null = null;
test.beforeAll(async () => {
	if (MODE === 'hosts') layout = await startHostsLayout();
});
test.afterAll(async () => {
	await layout?.close();
});

// What means STARbase broke: page errors, 5xx, a CSP refusal or any other console error. "Failed to load
// resource" lines are 4xx reads the pages handle (a Lab Member's refused lists) and missing sidecars.
function watchErrors(page: Page): string[] {
	const errors: string[] = [];
	page.on('pageerror', (e) => errors.push(String(e)));
	page.on('response', (r) => {
		if (r.status() >= 500) errors.push(`${r.status()} ${r.url()}`);
	});
	page.on('console', (m) => {
		if (m.type() === 'error' && !/Failed to load resource|favicon/i.test(m.text())) errors.push(m.text());
	});
	return errors;
}

test('sign in on STARbase, and Data Studio is signed in too', async ({ page, context }) => {
	const errors = watchErrors(page);
	await signInStarbase(page, 'member');
	await expect(page.locator('nav.d1-nav').first()).toBeVisible();
	await expect(page.locator('.d1-page').first()).toBeVisible();
	const studio = await context.newPage();
	await studio.goto(`${D1_BASE}/admin/content`, { waitUntil: 'networkidle' });
	expect(studio.url()).not.toContain('/login');
	expect(errors).toEqual([]);
});

test('a deep link opened signed out comes back after sign-in; an old /home link lands too (Review Focus 2)', async ({ page, playwright }) => {
	const api = await adminApi(playwright);
	const id = await firstId(api, 'physical_samples');
	await api.dispose();
	await pointAtD1(page.context());
	const deep = `/samples/${encodeURIComponent(id)}?from=qr`;
	await page.goto(STAR_BASE + deep);
	await page.waitForURL(/\/signin\?next=/);
	await fillSignIn(page, 'admin');
	await page.waitForURL((u) => u.pathname.startsWith('/samples/'));
	const here = new URL(page.url());
	expect(here.pathname + here.search).toBe(deep);
	await page.goto(`${STAR_BASE}/home/samples/${encodeURIComponent(id)}`);
	await expect(page).toHaveURL(`${STAR_BASE}/samples/${encodeURIComponent(id)}`);
});

test('edit through the frame: save, and the record page shows the new value', async ({ page, playwright }) => {
	const api = await adminApi(playwright);
	const id = await firstId(api, 'physical_samples');
	const read = async () => (await (await api.get(`${D1_LOCAL}/items/physical_samples/${id}?fields=location`)).json()).data.location as string | null;
	const before = await read();
	const marker = `e2e-${Date.now()}`;
	try {
		await signInStarbase(page, 'admin');
		await page.goto(`${STAR_BASE}/samples/${encodeURIComponent(id)}`);
		await page.getByRole('button', { name: /^Edit$/ }).click();
		const dialog = page.getByRole('dialog', { name: 'Edit record' });
		await expect(dialog).toBeVisible();
		const frame = page.frameLocator('iframe.sb-editor-frame');
		// The Directus form inside the frame: a field is a .field with its label in .type-label.
		const field = frame.locator('.field').filter({ has: frame.locator('.type-label').filter({ hasText: /^\s*Location/i }) }).locator('input').first();
		await field.fill(marker);
		const refetch = page.waitForResponse((r) => r.url().includes('/items/physical_samples') && r.request().method() === 'GET');
		await frame.getByRole('button', { name: 'Save' }).click();
		await expect(dialog).toBeHidden();
		await refetch;
		expect(await read()).toBe(marker);
	} finally {
		await api.patch(`${D1_LOCAL}/items/physical_samples/${id}`, { data: { location: before } });
		await api.dispose();
	}
});

test('a frame that never says ready offers a new tab, and coming back refreshes (Review Focus 3)', async ({ page, context, playwright }) => {
	test.setTimeout(90_000);
	const api = await adminApi(playwright);
	const id = await firstId(api, 'physical_samples');
	await api.dispose();
	await signInStarbase(page, 'admin');
	// Stand in for a refused frame (CSP, or signed out inside it): the form page never posts 'ready'.
	await context.route(`${D1_BASE}/admin/d1-edit/**`, (r) =>
		r.fulfill({ status: 200, contentType: 'text/html', headers: { 'content-security-policy': "frame-ancestors 'none'" }, body: '<p>refused</p>' }),
	);
	await page.goto(`${STAR_BASE}/samples/${encodeURIComponent(id)}`);
	await page.getByRole('button', { name: /^Edit$/ }).click();
	const dialog = page.getByRole('dialog', { name: 'Edit record' });
	const offer = dialog.getByRole('button', { name: 'Open in a new tab' });
	await expect(offer).toBeVisible({ timeout: 15_000 });
	const popup = page.waitForEvent('popup');
	await offer.click();
	const tab = await popup;
	expect(tab.url()).toContain(`/admin/d1-edit/physical_samples/${id}`);
	const refetch = page.waitForResponse((r) => r.url().includes('/items/physical_samples') && r.request().method() === 'GET');
	await tab.close();
	await page.bringToFront();
	await page.evaluate(() => window.dispatchEvent(new Event('focus')));
	await expect(dialog).toBeHidden();
	await refetch;
});

test('signed out in Data Studio: the next STARbase request goes to sign-in (Review Focus 1)', async ({ page, context }) => {
	await signInStarbase(page, 'member');
	const studio = await context.newPage();
	await studio.goto(`${D1_BASE}/admin/content`, { waitUntil: 'networkidle' });
	await studio.evaluate(async () => {
		await fetch('/auth/logout', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'session' }) });
	});
	await page.bringToFront();
	// A client-side navigation (no reload): the page's requests come back 403 as the public role.
	await page.evaluate(() => {
		window.history.pushState({}, '', '/samples');
		window.dispatchEvent(new PopStateEvent('popstate'));
	});
	await page.waitForURL(/\/signin\?next=%2Fsamples/, { timeout: 30_000 });
});

test('a credentialed write from a STARbase page passes CORS (People notes)', async ({ page, playwright }) => {
	const api = await adminApi(playwright);
	const people = (await (await api.get(`${D1_LOCAL}/items/people?fields=person_id,notes&limit=-1`)).json()).data as { person_id: string; notes: string | null }[];
	const notesOf = new Map(people.map((p) => [String(p.person_id), p.notes]));
	let personId = '';
	try {
		await signInStarbase(page, 'admin');
		await page.goto(`${STAR_BASE}/people`);
		await page.locator('.prow').first().click();
		const dialog = page.getByRole('dialog');
		await dialog.locator('textarea').fill(`e2e ${Date.now()}`);
		const patch = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().includes('/items/people/'));
		await dialog.getByRole('button', { name: 'Save' }).click();
		const res = await patch;
		personId = decodeURIComponent(new URL(res.url()).pathname.split('/').pop()!);
		expect(res.status()).toBe(200);
		// allHeaders(), not headers(): Playwright's headers() leaves out security-related headers.
		const headers = await res.allHeaders();
		expect(headers['access-control-allow-origin']).toBe(STAR_BASE);
		expect(headers['access-control-allow-credentials']).toBe('true');
	} finally {
		if (personId) await api.patch(`${D1_LOCAL}/items/people/${personId}`, { data: { notes: notesOf.get(personId) ?? null } });
		await api.dispose();
	}
});

test('sign out of STARbase signs Data Studio out too', async ({ page, context }) => {
	await signInStarbase(page, 'member');
	const studio = await context.newPage();
	await studio.goto(`${D1_BASE}/admin/content`, { waitUntil: 'networkidle' });
	expect(studio.url()).not.toContain('/login');
	await page.bringToFront();
	await page.getByRole('button', { name: 'Sign out' }).click();
	await expect(page).toHaveURL(/\/signin$/);
	await studio.reload({ waitUntil: 'networkidle' });
	await expect(studio).toHaveURL(/\/admin\/login/);
});

test('the Force and FAST plot pages render in STARbase', async ({ page }) => {
	const errors = watchErrors(page);
	await signInStarbase(page, 'admin');
	await page.goto(`${STAR_BASE}/plot/force`);
	await expect(page.locator('.fd').first()).toBeVisible({ timeout: 30_000 });
	await expect(page.locator('h1.sb-title')).toHaveText('Force Analysis');
	await page.goto(`${STAR_BASE}/plot/fast`);
	await expect(page.locator('.fd').first()).toBeVisible({ timeout: 30_000 });
	await expect(page.locator('h1.sb-title')).toHaveText('FAST Analysis');
	expect(errors).toEqual([]);
});

test('phone (375 px): the menu sheet, cards by default, a record page with no sideways scroll', async ({ browser, playwright }) => {
	const api = await adminApi(playwright);
	const id = await firstId(api, 'physical_samples');
	await api.dispose();
	const context = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, ignoreHTTPSErrors: MODE === 'hosts' });
	const page = await context.newPage();
	try {
		await signInStarbase(page, 'admin');
		await page.getByRole('button', { name: 'Menu' }).click();
		const sheet = page.getByRole('dialog', { name: 'Pages' });
		await expect(sheet.locator('nav.d1-nav')).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(sheet).toBeHidden();
		await page.goto(`${STAR_BASE}/samples`);
		await expect(page.locator('.card-grid').first()).toBeVisible();
		await page.goto(`${STAR_BASE}/samples/${encodeURIComponent(id)}`);
		await expect(page.locator('.d1-record-layout').first()).toBeVisible();
		const fits = await page.evaluate(() => {
			const c = document.querySelector('.sb-content')!;
			return c.scrollWidth <= c.clientWidth;
		});
		expect(fits, 'no sideways scroll at 375 px').toBe(true);
	} finally {
		await context.close();
	}
});
```

- [ ] **Step 3: Plan 1's route harness, STARbase mode**

In `tests/ui/specs/13-explorer-routes.spec.ts`:

- after the `SERVER` line, add:

```ts
// STARbase mode: D1_ROUTES_STARBASE=<STARbase origin> visits the same pages in the standalone app (paths
// without /home, its own sign-in page). The Directus-only check (the other kit users) is skipped.
const STARBASE = (process.env.D1_ROUTES_STARBASE || '').replace(/\/+$/, '');
const appUrl = (path: string) => (STARBASE ? STARBASE + (path.replace(/^\/home(?=\/|$)/, '') || '/') : ADMIN_BASE + path);
```

- at the start of `signIn`, after `const [email, password] = splitCreds(who);`, add:

```ts
	if (STARBASE) {
		await page.context().route(`${STARBASE}/config.json`, (r) => r.fulfill({ json: { directusUrl: SERVER } }));
		await page.goto(`${STARBASE}/signin`, { waitUntil: 'domcontentloaded' });
		await page.locator('input[type="email"]').fill(email);
		await page.locator('input[type="password"]').fill(password);
		await page.getByRole('button', { name: /^sign in$/i }).click();
		await page.waitForURL((u) => !u.pathname.startsWith('/signin'), { timeout: 30_000 });
		return;
	}
```

- in `visit`, change `await page.goto(`${ADMIN_BASE}${path}`, …)` to `await page.goto(appUrl(path), …)`;
- as the first line of `test('the other kit users still render', …)`'s body, add
  `test.skip(!!STARBASE, 'Directus-only: the campaign form and the lab dashboard are Data Studio pages');`.

The `IGNORED_CONSOLE` list does not match "Refused to …", so a CSP violation in STARbase fails the
harness. Keep it that way.

`tests/ui/README.md`:
- in the spec 13 row, append: "Also runs against STARbase with `D1_ROUTES_STARBASE=http://127.0.0.1:5190` (the
  Directus-only check is skipped)."
- add a row:

```markdown
| `14-starbase` | STARbase (`apps/starbase/web`) end to end: sign-in shared with Data Studio, a deep link through sign-in, editing through the framed Directus form and its new-tab fallback, a sign-out in Data Studio sending STARbase to sign in, a credentialed write, shared sign-out, the plot pages, the phone layout. Against the `d1-starbase` preview and `vite preview` (production CSP). Two layouts: ports (default) and `STARBASE_E2E_MODE=hosts`, step 0's two tailnet hostnames over local HTTPS (`tests/ui/starbase/hosts.ts`). Commands in plan 2, Task 12. |
```

- [ ] **Step 4: Run, ports layout**

```bash
npm run build:extensions
export D1_PREVIEW_NAME=d1-starbase D1_PREVIEW_PORT=18057 D1_PREVIEW_ENV_FILE=tests/ui/starbase/preview-ports.env
export D1_PREVIEW_OVERLAY="d1-home d1-admin-overview d1-fast-dashboard d1-campaign-ops d1-lab-dashboard d1-project-items d1-usage d1-edit-frame d1-links"
bash scripts/dev/explorer_preview.sh --stop; bash scripts/dev/explorer_preview.sh
npm run build -w starbase-web
```

Stop any STARbase dev server from earlier tasks, because it holds port 5190. Then start, with
`run_in_background`:
`STARBASE_D1_ORIGIN=http://127.0.0.1:18057 npm run preview -w starbase-web`.

```bash
CREDS="$PWD/.superpowers/preview-credentials-d1-starbase.txt"
(cd tests/ui && D1_ROUTES_CREDENTIALS="$CREDS" D1_ROUTES_STARBASE=http://127.0.0.1:5190 npx playwright test specs/13-explorer-routes.spec.ts --retries=0)
(cd tests/ui && STARBASE_E2E_CREDENTIALS="$CREDS" npx playwright test specs/14-starbase.spec.ts --retries=0)
(cd tests/ui && D1_ROUTES_CREDENTIALS="$CREDS" npx playwright test specs/13-explorer-routes.spec.ts --retries=0)
```

Expected:
- spec 13 against STARbase reports `2 passed, 2 skipped`: every page, as the admin and as the
  member, with no console error and no CSP refusal;
- spec 14 reports `9 passed`;
- spec 13 against Directus reports `4 passed`.

If a spec 14 test fails on a selector inside the Directus form, the label may not read "Location".
List the labels with `frame.locator('.type-label').allInnerTexts()` and use a text field this
collection has. Change only the selector.

- [ ] **Step 5: Run, hosts layout (the production shape: two hostnames, HTTPS, a Secure cookie)**

```bash
bash scripts/dev/explorer_preview.sh --stop
D1_PREVIEW_ENV_FILE=tests/ui/starbase/preview-hosts.env D1_PREVIEW_PUBLIC_URL=https://d1-server.tail54eeb6.ts.net:18443 bash scripts/dev/explorer_preview.sh
```

Restart the background `vite preview` as
`STARBASE_D1_ORIGIN=https://d1-server.tail54eeb6.ts.net:18443 npm run preview -w starbase-web`.

```bash
CREDS="$PWD/.superpowers/preview-credentials-d1-starbase.txt"
(cd tests/ui && STARBASE_E2E_MODE=hosts STARBASE_E2E_CREDENTIALS="$CREDS" npx playwright test specs/14-starbase.spec.ts --retries=0)
```

Expected: `9 passed`. If `openssl` is not found, run the same command from Git Bash, whose `PATH`
has `/usr/bin/openssl`.

- [ ] **Step 6: Commit**

```bash
git add tests/ui/starbase tests/ui/specs/14-starbase.spec.ts tests/ui/specs/13-explorer-routes.spec.ts tests/ui/README.md
git commit -m "test(starbase): end to end on the preview in both layouts; the route harness runs against STARbase too

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin HEAD:feat/explorer-standalone
```

---

### Task 13: Clean-up and hand-over

- [ ] **Step 1: Remove the throwaways and stop what is running**

```bash
rm -rf .superpowers/starbase-spike .superpowers/starbase-ttl.env .superpowers/starbase-ttl.mjs .superpowers/venv-filter .superpowers/venv-diag
D1_PREVIEW_NAME=d1-starbase D1_PREVIEW_PORT=18057 bash scripts/dev/explorer_preview.sh --stop
docker ps --format '{{.Names}}' | grep -c '^d1-starbase-' || true
```

Expected: the count is `0`. Stop the background `vite preview` or `vite` task too. If the other
session's `d1-preview-*` containers are running, leave them alone.

- [ ] **Step 2: Everything CI will run**

```bash
bash .claude/skills/ci-local/scripts/plan_checks.sh
```

Run every command it lists, except the ones marked as needing a scratch database, which this branch
does not touch. Expected: all pass.

- [ ] **Step 3: Final review**

Run the whole-branch review with Opus: plan 2's commits against the spec, and the Review Focus list
above. Fix what it finds in follow-up commits, rerunning the touched tests and the Directus
regression run, and push.

- [ ] **Step 4: Hand over**

Report to the maintainer:
- what STARbase does now;
- the e2e results in both layouts, and the session-renewal row added to spec §9;
- that the live rollout is theirs: `docs/runbooks/starbase.md`, steps 1–5, each approved separately.

Nothing in this plan runs those steps.
