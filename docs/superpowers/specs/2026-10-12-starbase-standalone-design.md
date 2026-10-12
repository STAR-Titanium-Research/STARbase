# STARbase: detaching the Explorer onto its own tailnet address

- **Date:** 2026-10-12
- **Status:** Draft for maintainer review
- **Decision record:** [ADR-0013](../../adr/0013-starbase-separate-tailnet-device-shared-directus-session.md)
- **Glossary:** [CONTEXT.md](../../../CONTEXT.md) (STARbase, Home, index page, record page, task
  screen, plotter, Data Studio)
- **Builds on:** the Explorer specs (2026-10-06 pages, 2026-10-09 rail layout, 2026-10-11
  navigation and N1b, 2026-10-12 Frequently used) and the Labels work.

## 1. Goal

The pages built as the "Explorer" inside the Directus module `d1-home` become **STARbase**, the
STAR group's (Sheffield Titanium Alloy Research) own web app, at
**`https://starbase.tail54eeb6.ts.net`**. This round runs STARbase **in parallel** with the
Directus Home module. Nobody loses the version they use today, and retiring the old module is a
later, separate decision.

**Success means** that a lab member opens the STARbase address on a desktop or a phone, signs in
on STARbase's own page, and can then do everything the Directus Home module does today:
- reach every page from STARbase's sidebar;
- open the Force and FAST plotters as STARbase pages;
- edit a record with Directus's own form inside STARbase.

All of this happens without ever seeing Data Studio's chrome, and while staying signed in to
Data Studio too.

## 2. Decisions (from the 2026-10-12 interview)

| # | Decision |
|---|---|
| Q1 | Everything in `d1-home` moves together: Home (lab view + admin overview + Frequently used), the index pages, the record pages, the task screens (Register sample, People, Labels). |
| Q2 | Run in parallel: a standalone app at the new address; the Directus Home module keeps working. |
| Q3/Q14 | Its own tailnet device named `starbase`, tagged; not a path on d1-server, not a Tailscale Service. |
| Q4/Q5 | The Force and FAST plotters move into STARbase this round, built from shared packages so both apps use the same component. |
| Q6 | STARbase has its own sign-in page, with **one Directus session** underneath (sign in or out once for both). Rigged for Google sign-in: the page shows a button for every provider Directus offers. |
| Q7/Q11 | Edit opens a **form-only Directus page** in a frame; if Directus will not allow the frame, it opens in a new tab. Saving returns to a refreshed record page. |
| Q8 | One shared package of pages, two thin hosts: the Directus module and `apps/starbase/web`. |
| Q9 | Same audience as d1-server. The maintainer makes the access-rules change and generates the auth key. |
| Q10 | Implementation stacks on U1 (Frequently used) and the Labels stack once they have PRs. |
| Q12 | Data Studio gets a quiet "Open in STARbase" link in the Directus Home module's sidebar. |
| Q13 | Each plotter is its own STARbase page, e.g. `/plot/force?operation=<id>`. |
| Q15/Q19 | Branded **STARbase** with the STAR group logos (`G:\Shared drives\STAR Group\Logos & Templates\Logos\STAR Logo\SVGs`), copied into the repo. The accent colour stays the Explorer's. |
| Q16 | From STARbase's first deploy, new report QR codes and report links point to STARbase. |
| Q17 | A proper phone layout this round. Whether phones may join the tailnet stays the #97 decision. |
| Q18 | The label scanner is the next round, not this one. |

## 3. Architecture

```
browser ── https://starbase.tail54eeb6.ts.net ──► starbase (tailscale container, tag:starbase)
   │                                                   └─ serve :443 → proxy:8090 (Caddy site: STARbase SPA)
   │
   └─ credentialed fetch / frame ──► https://d1-server.tail54eeb6.ts.net (unchanged entry)
                                        ├─ Directus  /items /auth /users /assets …   (session cookie)
                                        ├─ /admin/d1-edit/<collection>/<id>          (form-only page, framed)
                                        ├─ /filter /diag                             (plotting sidecars)
                                        └─ /octrees                                  (public-within-tailnet)
```

STARbase serves only static files. All data comes from d1-server, called directly with
`credentials: 'include'`, so the browser sends Directus's session cookie. Both hosts are the
same site (ADR-0013), so that one cookie is the session for STARbase, Data Studio and the
framed form.

### 3.1 Code layout

| Unit | What it is | Depends on |
|---|---|---|
| `packages/d1-ui` (`@d1/ui`) | The kit as today: components, composables, pure helpers, the `ExplorerHost` contract. | Vue only |
| **`packages/starbase-pages`** (`@d1/starbase-pages`, new) | Every page now in `core/extensions/d1-home/src` (Home and its panels, index and record pages, task screens, usage pings) plus **one route table** (`starbaseRoutes`). | `@d1/ui`, the host contract, `@d1/force-plotting`, `@d1/fast-plotting` |
| `packages/force-plotting` | Unchanged. | — |
| **`packages/fast-plotting`** (`@d1/fast-plotting`, new on main) | The FAST plotter, salvaged from the extraction on `feat/lab-web-stage1` (`fdf1eec8`, `4595f7eb`) and checked against today's `d1-fast-dashboard`. | — |
| `core/extensions/d1-home` | Thin Directus host: `defineModule` with `starbaseRoutes`, the Directus `ExplorerHost` (`explorerHost.ts`), Directus's own components. Adds the "Open in STARbase" sidebar link. | `@d1/starbase-pages` |
| `core/extensions/d1-fast-dashboard`, `d1-force-dashboard` | Become thin wrappers over the two plotting packages (force already is). | plotting packages |
| **`core/extensions/d1-edit-frame`** (new) | A Directus module whose page `/admin/d1-edit/<collection>/<id>` renders **only** `v-form` for that record, plus Save and Cancel, with no `private-view` (so no module bar or navigation). Tells its parent window `saved` / `cancelled` through `postMessage`, checking the target origin. | Directus app |
| **`apps/starbase/web`** (new) | A Vite + Vue 3 + TS app: sign-in page, the STARbase `ExplorerHost`, router (`starbaseRoutes` + `/plot/force`, `/plot/fast`, `/signin`), app shell (sidebar, phone menu, branding), stand-ins for Directus's components. Same pattern as `apps/force-app/web`. | `@d1/starbase-pages` |

**The seam.** Today about 18 files in `d1-home` and `d1-ui` call `useApi` / `useStores` directly,
bypassing `ExplorerHost`. There are also about 120 uses of Directus components (`v-icon`,
`v-button`, `v-input`, `v-select`, `v-checkbox`, `v-textarea`, `v-dialog`, `v-card*`, `v-notice`,
`v-progress-*`, `v-drawer`) and 5 of `private-view`. The approach is the one the Force App
proved:
- `apps/starbase/web` aliases `@directus/extensions-sdk` to a shim that serves `useApi` (a fetch
  wrapper with `credentials: 'include'` against d1-server) and the few `useStores` reads the
  pages make (current user, fields);
- it registers stand-in global components for the `v-*` set;
- `private-view` is replaced by a `PageFrame` component that each host supplies.

Moving the pages does not rewrite them. Two places do change behaviour per host and go behind
the `ExplorerHost` contract:
- **`EditDrawer`**: the Directus host keeps its `v-form` drawer, and the STARbase host opens the
  edit frame (§3.4);
- **`openDataStudio`**: the Directus host uses router push, and STARbase opens
  `https://d1-server…/admin<path>` in a new tab.

The contract gains `openEditor(collection, id): Promise<'saved' | 'cancelled'>` and `PageFrame`.

### 3.2 Sign-in and session

- `/signin` is STARbase's own page. It shows the STARbase wordmark, an email and password form,
  and one button per SSO provider.
- **Password:** `POST https://d1-server…/auth/login` with `{ email, password, mode: 'session' }`
  and `credentials: 'include'`. Directus sets `directus_session_token` (the same cookie Data
  Studio uses). After that, every call relies on the cookie and there is no token in
  `localStorage`.
- **Providers:** `GET /auth` lists the configured providers. Each one becomes a link to
  `https://d1-server…/auth/login/<provider>?redirect=https://starbase…/signin/done`. This needs
  nothing in STARbase the day Google is switched on. On the Directus side it needs
  `AUTH_PROVIDERS=google`, `AUTH_GOOGLE_MODE=session` and `AUTH_GOOGLE_REDIRECT_ALLOW_LIST`
  including the STARbase URL. Who may sign in with Google is decided then.
- **Session check:** on load, `GET /users/me`. A 401 sends the user to `/signin?next=<path>`.
  Admin detection follows the Force App's D11 lesson (`/policies/me/globals`, as `explorerHost.ts`
  already does).
- **Sign-out:** `POST /auth/logout` with `mode: 'session'`, which signs out of Data Studio too.
- **Directus settings (maintainer-applied):**
  - `CORS_ORIGIN` lists the STARbase origin exactly (no `*`), and `CORS_CREDENTIALS=true`;
  - `SESSION_COOKIE_SECURE=true` (the entry is HTTPS);
  - `CONTENT_SECURITY_POLICY_DIRECTIVES__FRAME_ANCESTORS` allows `'self'` and the STARbase origin;
  - `FILTER_CORS_ORIGINS` / `DIAG_CORS_ORIGINS` get the STARbase origin, and those sidecars allow
    credentials.

  The single `FORCE_APP_ORIGIN` variable that feeds all three CORS lists today is split into
  per-app variables (`FORCE_APP_ORIGIN`, `STARBASE_ORIGIN`) joined in `docker-compose.yml`.

### 3.3 Navigation, branding and phone layout

- **Routes.** The sidebar and routes are the Explorer's (the N1/N1b icon rail and panel), minus
  the Directus base path. STARbase routes are `/`, `/samples`, `/samples/<id>`, … `/labels`,
  `/register-sample`, `/people`, `/plot/force`, `/plot/fast`, `/signin`.
- **Links.** A Data Studio link opens in a new tab.
- **Branding:**
  - `Star-logo-transparent.svg` (light theme) and `Star-logo-transparent-light.svg` (dark theme)
    in the sidebar header and on the sign-in page;
  - `Star-Icon.svg` as the favicon and the collapsed-rail mark;
  - the files are copied into `apps/starbase/web/public/brand/`, and the page title is
    "STARbase".
- **Phone layout** (< 768 px):
  - the icon rail and panel collapse into a top bar with a menu button that opens the panel as
    a full-height sheet;
  - index pages default to the card view;
  - record pages stack the rail above the panels (the L1 stacked layout, tuned for 375 px);
  - plotters get a "best on a larger screen" note but still open.

  The Directus host keeps its desktop layout.

### 3.4 Editing

- The STARbase host's `openEditor(collection, id)` opens a large dialog containing an iframe of
  `https://d1-server…/admin/d1-edit/<collection>/<id>`.
- The frame posts `{ type: 'd1-edit', result: 'saved' | 'cancelled', collection, id }` to
  `window.parent`, with `targetOrigin` = the STARbase origin.
- STARbase accepts messages only from the d1-server origin, then closes the dialog and refetches
  the record.
- Create (e.g. "New sample") uses the same page with `+` as the id, as Data Studio does.
- **Fallback:** if the step-0 check (§6) finds that Directus will not send a `frame-ancestors`
  that includes STARbase, `openEditor` opens the same URL in a new tab instead. A STARbase
  record page refetches when the window regains focus.

### 3.5 Plotters

- `/plot/force?operation=<id>` mounts `ForceDashboard` from `@d1/force-plotting` with STARbase's
  config: Directus, `/filter`, `/diag` and `/octrees` all at the d1-server origin.
  Authentication goes through the plotting package's own host contract
  (`packages/force-plotting/src/host.ts`). The STARbase `ForceHost` is the cookie variant:
  - `authHeaders()` returns `{}`;
  - `fetchCredentials` is `'include'`;
  - the axios instance uses `withCredentials`;
  - `refreshAuth()` re-checks `/users/me` instead of exchanging a refresh token, and `openRecord()` routes to the STARbase record page.

  `filter-service` and `diag-service` already forward the caller's `Cookie` to Directus
  (`plugins/*/app/main.py`). Their CORS middleware only needs `allow_credentials=True` alongside
  the exact STARbase origin.
- `/plot/fast?run=<id>` mounts the FAST plotter from `@d1/fast-plotting`.
- The index-page "Force (n)" / "FAST" row buttons and the record-page plot links route there
  instead of into Directus.
- Inside the Directus host, those buttons keep opening the Directus dashboards.

### 3.6 Links out of the database

- **Reports.** `d1-report`'s `recordUrl` (Labels stack, `render.js`) builds
  `<STARBASE_URL>/<page>/<id>` when `STARBASE_URL` is set, and the Directus Home URL otherwise.
  `STARBASE_URL` is set as part of STARbase's first deploy (Q16), so reports never print an
  address that does not answer yet.
- **Data Studio.** The "Open in STARbase" link in `d1-home`'s sidebar reads the same setting,
  exposed to the app by a tiny endpoint extension, `GET /d1-links`, which returns
  `{ starbaseUrl }` (or `null` while it is unset, which hides the link).
- **Later retirement** (not this round): the Directus Home module is replaced by redirects to
  STARbase, so every printed link still lands.

### 3.7 Deployment

- **`docker-compose.yml`:**
  - a `starbase` service on `tailscale/tailscale` under a `starbase` compose profile, so the stack
    still starts without a key;
  - `TS_HOSTNAME=starbase`, `TS_AUTHKEY=${STARBASE_TS_AUTHKEY}`, `TS_EXTRA_ARGS=--advertise-tags=tag:starbase`;
  - a state volume, and `TS_SERVE_CONFIG` mapping HTTPS 443 → `http://proxy:8090`.
- **Caddy:**
  - a second site block `:8090` serves `/srv/starbase` (the built `apps/starbase/web/dist`) with
    an SPA fallback;
  - `index.html` is `no-cache` and the hashed assets are immutable;
  - a CSP of `default-src 'self'`, with `connect-src`, `img-src` and `frame-src` allowing the
    d1-server origin;
  - port 8090 is **not** published on the host.
- **Runbook** `docs/runbooks/starbase.md`, listing the maintainer's steps in order:
  1. Add `tag:starbase` to the tailnet policy, owned by the maintainer, and grant the d1-server
     audience access to `tag:starbase:443`.
  1a. If d1-server is shared with anyone outside the tailnet (device sharing), share `starbase`
     with the same people. Access rules do not reach share recipients. Confirm in the admin
     console that a tagged device can be shared this way.
  2. Generate a tagged, reusable or ephemeral auth key and put it in `.env` as
     `STARBASE_TS_AUTHKEY`.
  3. Set `STARBASE_ORIGIN` and `STARBASE_URL`, and the Directus settings in §3.2.
  4. Recreate `directus`, `filter-service`, `diag-service` and `proxy`, and start the `starbase`
     profile.
  5. Run the smoke check (§5).
- **Redeploying STARbase** after a change: build `apps/starbase/web`, then recreate `proxy`
  (the same rhythm as the Force App's `/app/`).

## 4. Error handling

- **Expired session:** any 401 from d1-server sends the user to `/signin?next=…` and drops no
  unsaved state. STARbase has no forms of its own, and editing state lives in the framed form.
- **d1-server unreachable:** a full-page "can't reach the database" state with a retry. This is
  not an endless spinner.
- **Frame refused** (CSP or cookie): detected by the frame not posting a ready message within a
  few seconds. The dialog then offers "open in a new tab". The same handling covers a future
  browser change.
- **SSO return with an error:** `/signin/done` shows Directus's reason and links back to `/signin`.
- **Plotter sidecar down:** keeps the plotters' existing per-panel error states.

## 5. Testing

- **Unit (vitest).** The moved pages keep their tests; the 464+ `d1-ui` and `d1-home` tests run
  from the new package. New tests cover:
  - the STARbase host (sign-in flow, the 401 redirect, provider buttons from a `GET /auth`
    fixture);
  - the `postMessage` origin checks on both sides;
  - the route table producing the same pages in both hosts.
- **The Directus host must not regress.** The existing preview (`scripts/dev/explorer_preview.sh`,
  a copy of live) is used to click through every page in the Directus module after the move.
- **End-to-end (Playwright) against the preview.** STARbase runs on `127.0.0.1:<port>` against
  the preview Directus on `127.0.0.1:18055`. Cookies are shared across ports on one host, so this
  reproduces the shared session locally, with `SESSION_COOKIE_SECURE=false` on the preview only.
  The flows checked:
  - sign in;
  - every sidebar page;
  - a record page;
  - edit through the frame, save, see the refreshed value;
  - sign out of STARbase, then confirm Data Studio is signed out too;
  - Force and FAST plot pages render;
  - phone viewport (375 px) for the sidebar sheet, cards and a record page.
- **Live smoke** (runbook step 5, maintainer present): open STARbase over the tailnet, sign in,
  open Data Studio in another tab already signed in, edit a test record through the frame, plot
  one force operation.

## 6. Order of work (for the plan)

0. **Step 0: check the risky bits on the preview first, before anything else.**
   (a) does `CONTENT_SECURITY_POLICY_DIRECTIVES__FRAME_ANCESTORS` actually change the header?
   (b) does a Directus module without `private-view` render with no module bar?
   (c) does the session-mode cookie from a credentialed login reach both apps when they are on
   **two different hostnames** under one registrable domain? Same-host ports do not prove this,
   because cookies ignore the port. The check maps `starbase.tail54eeb6.ts.net` and
   `d1-server.tail54eeb6.ts.net` to loopback in a test Chromium (`--host-resolver-rules`) and
   serves each over local HTTPS with a throwaway certificate. If that cannot be made to work
   locally, the first real proof is rollout step 5, and a failure there means STARbase falls
   back to a Bearer sign-in like the Force App, with editing in a new tab.
   Results go into this spec. A "no" on (a) switches editing to the new-tab fallback; a "no" on
   (c) comes back to the maintainer before anything is built.
1. Salvage `@d1/fast-plotting` and make `d1-fast-dashboard` a thin wrapper (no visible change).
2. Move the pages into `@d1/starbase-pages`, with `d1-home` becoming the thin Directus host (no
   visible change; the preview click-through passes).
3. `apps/starbase/web` shell: sign-in, host, shims, sidebar, branding, all pages.
4. `d1-edit-frame` and `openEditor` (frame or fallback).
5. Plot pages and the row and record plot buttons.
6. Phone layout.
7. Deploy pieces: the compose service, the Caddy site, the CORS variable split, `STARBASE_URL`
   for reports and the Data Studio link, and the runbook.
8. Live rollout, which is the maintainer's: runbook steps 1–5, each approved separately.

Branch: `feat/explorer-standalone`, stacked on U1 and the Labels stack once they have PRs. A
draft PR is open from the first commit, and pushes follow each step.

## 7. Out of scope this round

- Retiring the Directus Home module and its redirects.
- The label scanner (next round).
- The phone-tailnet decision (#97).
- Configuring Google sign-in and its account policy.
- The access dialog (A1).
- The lineage graph (G1).
- Moving STARbase off d1-server.
- The Force App's own `/app/` (unchanged).

## 8. Errata (2026-10-12, found while planning)

The code inventory done for the plan corrected four points above. They change how things are
built, not what was decided.

1. **No SDK alias.** §3.1 says STARbase aliases `@directus/extensions-sdk` to a shim "the way the
   Force App did". The Force App never did that. `@d1/force-plotting` is host-neutral by
   construction and reaches its host through `setForceHost`. STARbase follows the same pattern:
   - every page and kit file reaches Directus only through `ExplorerHost`, whose `api` is widened
     to `get`/`post`/`patch`/`delete` and which gains `fieldsFor()`;
   - links go through one link resolver in `@d1/ui` (`configureLinks`): pages keep writing today's
     Directus paths (`/home/…`, `/content/…`, `/d1-force-dashboard?…`), and each host maps them to
     a route or an external URL;
   - pages render inside a frame component the host installs (`setPageFrame`);
   - `noSdkImports.test.ts` is extended into a guard over all of `@d1/ui` and
     `@d1/starbase-pages`.
2. **FAST deep link.** The FAST plotter already reads `?operation=<id>`, so its STARbase page is
   `/plot/fast?operation=<id>`, not `?run=`.
3. **Report links.** The function in `d1-report` is `adminRecordUrl` (not `recordUrl`), and its
   `/label` and `/labels` redirects hard-code `/admin/home/labels`. Both learn `STARBASE_URL`.
4. **The FAST extraction on `feat/lab-web-stage1` is out of date.** It predates `f58605ce`
   (stale-load guards and cleanup) and `5d794c11` (`recordRoute` links). `@d1/fast-plotting` is
   re-extracted from today's `d1-fast-dashboard`, taking only the branch's `FastHost` contract and
   its error-message fix (`4595f7eb`).

**Plan split.** Step 0 can change the sign-in (to Bearer) and the editing (to a new tab), so the
work is in two plans:
- `2026-10-12-starbase-1-foundations.md` covers step 0, the FAST package and the page move. It
  holds whatever step 0 finds.
- `2026-10-12-starbase-2-app.md` covers the app, the edit frame, the plot pages, the phone layout
  and deployment. It is an outline until the step-0 results are recorded here.
