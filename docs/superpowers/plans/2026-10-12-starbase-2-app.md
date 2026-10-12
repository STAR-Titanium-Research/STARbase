# STARbase, plan 2: the app (OUTLINE, detailed after step 0)

> **Status: outline.** This is turned into a full task-by-task plan (writing-plans) once plan 1's
> step-0 results are in the spec (§9). Those results decide two designs:
> - **sign-in:** shared session cookie, or Bearer like the Force App;
> - **editing:** framed form page, or a new tab.
>
> Detailing code for either before then would be a bet. Everything below holds whatever step 0
> finds, unless marked **(depends on step 0)**.

**Goal:** `apps/starbase/web` serves the STARbase pages at `https://starbase.tail54eeb6.ts.net`
with its own sign-in, sidebar, branding, plot pages and phone layout, in parallel with the
Directus Home module.

**Spec:** `docs/superpowers/specs/2026-10-12-starbase-standalone-design.md` (§3-§7, §8 errata,
§9 step-0 results). **Builds on:** plan 1 (`@d1/starbase-pages`, `starbaseRoutes`, `setPageFrame`,
`setExplorerHostFactory`, `configureLinks` + `starbaseLinks`, `AppLink`, `useFinderShortcut`,
`@d1/fast-plotting`).

## Task outline

1. **App scaffold and runtime config.**
   - `apps/starbase/web`: Vite + Vue 3 + TS, port 5190, `base: '/'`.
   - `config.ts` follows the Force App's pattern: `VITE_*` defaults, then `/config.json` at boot.
     It holds `directusUrl`, `filterUrl`, `diagUrl` and `octreeUrl`.
   - Workspace entry, scripts `dev`, `build`, `test`, `typecheck`; CI (`ci-plan.mjs` plus the
     directus-ui job).
2. **API client and session (depends on step 0).**
   - An axios instance with `baseURL = directusUrl`.
   - **If the shared session works:** `withCredentials: true`; `signIn` posts `/auth/login` with
     `mode: 'session'`; `signOut` posts `/auth/logout` with `mode: 'session'`.
   - **If it does not:** the Force App's Bearer `authStore`/`directusClient`, reused.
   - Both cases: `loadSession` (`GET /users/me` plus `/policies/me/globals`) and a 401 interceptor
     that redirects to `/signin?next=`.
   - Tests: interceptor, `next` handling, admin detection (the D11 policies lesson).
3. **STARbase host.**
   - `createStarbaseHost(api, session, router)` returns an `ExplorerHost`:
     - `navigate` = `openLink(to, router)`;
     - `openDataStudio` opens a new tab on d1-server;
     - `fieldsFor` = `GET /fields/<c>`.
   - It is installed with `setExplorerHostFactory`, alongside `configureLinks(starbaseLinks(directusUrl))`.
   - `installUsagePings(router, api)`, so pings use `canonicalPath`.
4. **Stand-ins for Directus components.**
   - `v-icon` and `v-progress-circular` copied from the Force App.
   - New stand-ins: `v-button` (`to` goes through `resolveLink`), `v-input`, `v-select`,
     `v-checkbox`, `v-textarea`, `v-notice`, `v-dialog`, `v-card*`, `v-progress-linear`, and the
     `v-tooltip` directive. They implement only the props and slots the inventory found.
   - Theme: the ~20 `--theme--*` variables, starting from the Force App's compat layer
     (`styles.css`/`theme.ts`).
   - A unit test per stand-in for the props the pages use.
5. **Shell, branding, sign-in pages.**
   - `AppShell`: ExplorerNav plus Finder via `useFinderShortcut`, and the brand header with the
     light and dark logo SVGs copied from the STAR shared drive into `public/brand/`.
   - `PlainFrame` is installed with `setPageFrame`.
   - `/signin` has the email/password form plus one button per provider from `GET /auth`.
   - `/signin/done` handles the SSO return.
   - The "can't reach the database" state.
   - The router mounts `starbaseRoutes` at `/`, with a `/home/:rest(.*)*` redirect as a safety net.
6. **Edit frame (depends on step 0).**
   - `core/extensions/d1-edit-frame`, a form-only module page. It reuses `editDrawer.ts`'s pure
     helpers and talks to its parent through `postMessage`, with origin checks on both sides.
   - Pure message helpers, tested.
   - `host.openEditor` and the EditDrawer branch for it.
   - Fallback: a new tab plus refetching when the window regains focus.
7. **Plot pages.**
   - `/plot/force` uses the cookie (or Bearer) `ForceHost` variant from spec §3.5.
   - `/plot/fast` uses `setFastHost`.
   - Both are lazy-loaded routes.
8. **Phone layout.**
   - Below 768 px: a top bar plus a sheet for the nav.
   - Cards by default on index pages, via a pure `defaultListPrefs(width, saved)` with tests.
   - Record pages stacked at 375 px.
9. **Links out.**
   - A `d1-links` endpoint returns `{ starbaseUrl }`.
   - An "Open in STARbase" link in `DirectusFrame`.
   - In `d1-report`, `adminRecordUrl` and the `/label(s)` redirects use `STARBASE_URL` when it is
     set. Tests cover both cases.
10. **Deployment pieces.**
    - Compose: a `starbase` service under the `starbase` profile, plus `infra/tailscale/starbase-serve.json`.
    - Caddy: a `:8090` site serving `/srv/starbase` (with CSP), and a proxy mount.
    - CORS: split `FORCE_APP_ORIGIN` / `STARBASE_ORIGIN`; `allow_credentials` on filter-service
      and diag-service **(depends on step 0)**.
    - Directus env: `CORS_CREDENTIALS`, the frame setting, `STARBASE_URL`.
    - `docs/runbooks/starbase.md`, with the maintainer's steps from spec §3.7, including tailnet
      sharing.
11. **End-to-end on the preview.**
    - Plan 1's route harness pointed at STARbase (`D1_ROUTES_ADMIN_BASE`).
    - Specs for sign-in and sign-out (shared with Data Studio), edit through the frame or a new
      tab, Force and FAST plot pages, and the phone viewport.
    - The two-hostname setup from the step-0 spike becomes a committed test helper.
12. **Clean-up and hand-over.**
    - Delete `.superpowers/starbase-spike/`.
    - Final Opus review.
    - Live rollout is the maintainer's: runbook steps 1-5, each approved separately.
