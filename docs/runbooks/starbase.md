# STARbase: rollout and redeploy

STARbase (`apps/starbase/web`) is the group's web app at `https://starbase.tail54eeb6.ts.net`, on its own
tailnet device, signing in with Directus's own session ([ADR-0013](../adr/0013-starbase-separate-tailnet-device-shared-directus-session.md),
[spec](../superpowers/specs/2026-10-12-starbase-standalone-design.md)). It started beside the Directus Home
module; Directus has since lost Home and the two plotter modules (see
[Phase 1 of going headless](#phase-1-of-going-headless-spec-2026-10-13-directus-headless) below).

Every step below is the maintainer's, on d1-server, each approved on its own. Nothing here runs from a
development session.

## Before you start

- `feat/explorer-standalone` is merged and the main checkout is up to date.
- You can edit the tailnet policy and create auth keys.

## 1. Tailnet policy (maintainer's step, approve separately)

Add the tag, owned by you, and let the people who reach d1-server reach STARbase on 443:

```jsonc
"tagOwners": { "tag:starbase": ["<your login>"] },
// next to the rule that grants d1-server, with the same sources:
{ "src": ["<the d1-server audience>"], "dst": ["tag:starbase"], "ip": ["443"] }
```

## 2. Auth key (maintainer's step, approve separately)

Admin console → Settings → Keys → Generate auth key: **reusable**, **not ephemeral** (the device keeps
its state in the `starbase-ts-state` volume), **pre-approved**, tag `tag:starbase`. Put it in `.env`:

```
STARBASE_TS_AUTHKEY=tskey-auth-…
```

## 3. Settings, `.env` (maintainer's step, approve separately)

```
STARBASE_ORIGIN=https://starbase.tail54eeb6.ts.net
STARBASE_URL=https://starbase.tail54eeb6.ts.net
SESSION_COOKIE_SECURE=true
D1_SERVER_ORIGIN=https://d1-server.tail54eeb6.ts.net
```

`docker-compose.yml` joins `STARBASE_ORIGIN` onto Directus's `CORS_ORIGIN` (with `CORS_CREDENTIALS=true`),
onto `FILTER_CORS_ORIGINS` and `DIAG_CORS_ORIGINS`, and onto
`CONTENT_SECURITY_POLICY_DIRECTIVES__FRAME_ANCESTORS` (`'self' <STARbase>`).

**`SESSION_COOKIE_SECURE` is your choice.** `true` is right for the HTTPS tailnet entry, and the smoke check
below is written for it. But a Secure cookie is not sent over plain HTTP, so Data Studio sign-in breaks over
plain HTTP from anywhere that is not `localhost` (for example `http://<lan-address>/`), and in Safari even on
`localhost`. If anyone signs in that way, leave it `false`: it works everywhere, with a weaker cookie. The
compose default stays `false`, so nothing changes until you set it.

**What changes for the existing services when they are recreated.** Even with `STARBASE_ORIGIN` unset, the
new compose file gives:

- Directus: `CORS_CREDENTIALS=true`, frame-ancestors `'self'`, `SESSION_COOKIE_SECURE=false` and
  `STARBASE_URL=""`. These are expected to match Directus's own defaults, so nothing should move.
- Directus also gets `CORS_EXPOSED_HEADERS=Content-Range,Content-Disposition` so STARbase can read a download's
  filename; the variable replaces Directus's default list, so `Content-Range` is kept. Until it is live,
  downloads are named `<file id>.<ext>` (ext from the file's type) instead of the original name.
- filter-service and diag-service now send `Access-Control-Allow-Credentials: true` for the Force App
  origins too (origins stay exact; a `*` is dropped). The Force App sends a Bearer token, which this does
  not affect.

Check the rendered values before recreating anything:

```bash
docker compose --profile starbase config | grep -E 'CORS_ORIGIN|CORS_ORIGINS|CORS_CREDENTIALS|CORS_EXPOSED_HEADERS|FRAME_ANCESTORS|SESSION_COOKIE_SECURE|STARBASE_URL|D1_SERVER_ORIGIN'
```

Later, for Google sign-in (out of scope now): `AUTH_PROVIDERS=google`, `AUTH_GOOGLE_MODE=session`, and
`AUTH_GOOGLE_REDIRECT_ALLOW_LIST` including `https://starbase.tail54eeb6.ts.net/signin/done`. STARbase
shows the button by itself once Directus lists the provider.

## 4. Build and start (maintainer's step, approve separately)

```bash
npm ci
npm run build:starbase                                   # apps/starbase/web/dist, served by Caddy on :8090
npm run build:extensions                                 # d1-edit-frame, d1-lab-dashboard, d1-composition-bar, d1-campaign-ops, d1-project-items
(cd core/extensions/d1-report && npm ci && npm run build)  # report links follow STARBASE_URL (not a workspace, so its own build)
docker compose up -d --force-recreate directus filter-service diag-service proxy
docker compose --profile starbase up -d starbase
docker compose logs --tail 50 starbase                   # expect the node to log in and the serve config to be applied
```

`d1-links` (`/d1-links`) needs no build.

Recreating `proxy` is what loads the new Caddyfile: the `:8090` site (STARbase, with its CSP, and a plain
404 for a missing `/assets/*` file) and the `Cross-Origin-Opener-Policy: unsafe-none` override on
`/admin/d1-edit/*`. Directus sends its own `same-origin-allow-popups` COOP, which would sever `window.opener` for the
edit page's new-tab fallback; Caddy relaxes it for that one path and nowhere else.

### 4a. Shared devices (maintainer's step, approve separately)

Only once the `starbase` device exists (step 4 has run and it shows in the admin console). If d1-server is
shared with anyone outside the tailnet (device sharing), share `starbase` with the same people: access
rules (step 1) do not reach share recipients. First confirm in the admin console that a tagged device can be
shared this way. Until this is done those people cannot reach STARbase.

## 5. Smoke check (maintainer's step, with someone on a second device)

Run the `curl` lines from any device on the tailnet.

1. `curl -sI https://starbase.tail54eeb6.ts.net/`: answers `200` and has a `content-security-policy` header
   that names `https://d1-server.tail54eeb6.ts.net` in `connect-src` and `frame-src`.
2. `curl -s https://starbase.tail54eeb6.ts.net/config.json`: prints
   `{"directusUrl":"https://d1-server.tail54eeb6.ts.net"}`. And
   `curl -sI https://starbase.tail54eeb6.ts.net/assets/nope.js` answers `404` (not the app's HTML).
3. `curl -sI https://d1-server.tail54eeb6.ts.net/admin/ | grep -i content-security-policy`: must contain
   `frame-ancestors 'self' https://starbase.tail54eeb6.ts.net`.
4. `curl -sI https://d1-server.tail54eeb6.ts.net/admin/d1-edit/x/1 | grep -i cross-origin-opener-policy`: must
   say `unsafe-none`. The same check on `/admin/` keeps Directus's own value (`same-origin-allow-popups`).
5. Open `https://starbase.tail54eeb6.ts.net` over the tailnet: the sign-in page, with the STAR logo.
6. Sign in. In another tab, open Data Studio: already signed in.
7. Open a test record, **Edit**: the Directus form opens inside STARbase. Change a field, Save: the
   dialog closes and the page shows the new value. Put it back.
8. Plot one force operation (`/plot/force?operation=<id>`): the signals draw, the **FRM map** streams
   (`/octrees`), a **filter preview** answers (`/filter`), and a **diagnostics preview** answers (`/diag`).
   Download a file from the plot page: it saves as an attachment and the plot page stays where it was.
9. Print a sample report: its QR code and link open the STARbase record page.
10. Sign out of STARbase: Data Studio is signed out too.
11. On a phone (if it is on the tailnet): the top bar and menu, a list, a record page.
12. Real Safari / iOS, if anyone has it: steps 5–7. Step 0 tested Chromium only (spec §9).

The frame posts only to `STARBASE_URL`'s origin (`GET /d1-links`). If that is unset or wrong, Save still
works, but the dialog does not close on its own: the form says "Saved. You can close this form."

If step 7 shows "The form didn't open here" (after about 8 seconds), there are two usual causes:

- step 3 (the frame setting, `frame-ancestors`) does not allow STARbase's origin;
- `STARBASE_URL` is missing or wrong, or its origin differs from `STARBASE_ORIGIN`. The frame cannot say
  "ready" without a target origin. Check it by opening `https://d1-server.tail54eeb6.ts.net/d1-links` while
  signed in: it must show STARbase's address.

In that state the dialog's close button counts as cancelled, so the page does not refetch the saved value
until a reload. The new-tab fallback works meanwhile; if it opens but Save does not close it or tell
STARbase, step 4 (the COOP override) is the one to look at.

## Redeploying after a change (maintainer's step, approve separately)

```bash
git pull && npm ci && npm run build:starbase
docker compose up -d --force-recreate proxy
```

(the same rhythm as the Force App's `/app/`). A change to `d1-edit-frame` also needs its build and a
`directus` recreate. So does any change under `packages/d1-ui`, `packages/starbase-pages`,
`packages/fast-plotting` or `packages/force-plotting`, which the Directus extensions bundle: run
`npm run build:extensions`, then `docker compose up -d --force-recreate directus`.

## Rolling back (maintainer's step, approve separately)

Each item is separate; do them in this order.

1. Stop the device: `docker compose --profile starbase stop starbase`, then
   `docker compose --profile starbase rm -f starbase` to delete the stopped container.
2. Admin console → Settings → Keys: **revoke** the STARbase auth key.
3. Admin console → Machines: **remove** the `starbase` device (this also drops any shares from step 4a).
4. Delete the device's saved state, so a later redeploy registers a fresh node. The volume name carries the
   compose project prefix, so list it first and remove the name it shows:

   ```bash
   docker volume ls | grep starbase-ts-state
   docker volume rm <the name listed above>
   ```

5. In `.env`, unset `STARBASE_URL`, `STARBASE_ORIGIN`, `D1_SERVER_ORIGIN` and `STARBASE_TS_AUTHKEY`, and set
   `SESSION_COOKIE_SECURE` as it was before step 3. Optionally drop the `tag:starbase` policy rule from step 1.
6. Recreate what read them:
   `docker compose up -d --force-recreate directus filter-service diag-service proxy`.

With `STARBASE_URL` unset, the permanent links (`/d1-links/go…`) answer `503` with a plain text message, so a
report's QR code scan shows that message: the Directus Home module is gone (Phase 1 of going headless,
below), so there is nothing for them to fall back to. Roll back that phase first if you need the old pages.

**Warning:** report QR codes and labels printed while `STARBASE_URL` was set point at the STARbase address.
Once it is gone they stop resolving (the host no longer exists), so reprint any that are still in use.

## Phase 1 of going headless (spec 2026-10-13-directus-headless)

Directus loses Home and the two plotter modules; everything Directus prints or opens goes through the
permanent links (`/d1-links/go…`). **Directus mounts `core/extensions` as it is**, and `git pull`
leaves a removed extension's ignored `dist/` and `node_modules/` behind, where Directus keeps
loading them, so step 2 deletes them by hand.

0. Gate: the STARbase rollout above is done and `STARBASE_URL` is set in `.env`. Without it every
   permanent link answers `503` and the old pages are already gone after this phase. Stop here if not.
1. `git pull && npm ci && npm run build:starbase && npm run build:extensions`, then
   `(cd core/extensions/d1-report && npm ci && npm run build)` and
   `(cd core/extensions/d1-report-button && npm ci && npm run build)`.
2. Check the permanent links before anything is deleted. `d1-links` needs no build, but Directus loads
   it only at start, so recreate once: `docker compose up -d --force-recreate directus`, then
   `curl -sI https://d1-server.tail54eeb6.ts.net/d1-links/go` must answer `302` to
   `https://starbase.tail54eeb6.ts.net/`. A `503` means `STARBASE_URL` is not in Directus's environment; a
   `404` means the new `d1-links` is not loaded. **Stop and fix it if it is not a `302`.**
3. Delete what is left of the three removed extensions:
   `rm -rf core/extensions/d1-home core/extensions/d1-force-dashboard core/extensions/d1-fast-dashboard`
   (PowerShell: `Remove-Item -Recurse -Force core/extensions/d1-home, core/extensions/d1-force-dashboard, core/extensions/d1-fast-dashboard`).
4. `make migrate-status` (171 pending), `make migrate` (migration 171), then
   `bash scripts/set_module_bar_starbase.sh`.
5. `docker compose up -d --force-recreate directus`, then
   `docker compose exec directus ls /directus/extensions`: the three names are gone.
6. Smoke:
   - `curl -sI https://d1-server.tail54eeb6.ts.net/d1-links/go/r/physical_samples/<id>` → `302`
     to `https://starbase.tail54eeb6.ts.net/samples/<id>`;
   - `curl -sI "https://d1-server.tail54eeb6.ts.net/d1-links/go/p/a//b"` → `400`;
   - in Data Studio, the module bar's first tile is STARbase and opens it; Home and the Force/FAST
     tiles are gone;
   - a sample report's QR code opens the sample in STARbase;
   - on an operation's Data Studio form, "View Force Analysis" opens STARbase's plot in a new tab;
   - a project's items list links open STARbase.
7. Force App: ship the release that contains "open record through the permanent link".

Rollback, in this order:
1. While still on the phase-1 commit (its migration file must exist): `make migrate-status`, then
   `make migrate-down` (rolls back the newest applied migration, 171; it puts Home and the two plotters
   back in the module bar).
2. `git checkout <previous commit>`.
3. Rebuild with that commit's scripts: `npm ci && npm run build:starbase && npm run build:extensions &&
   npm run build:extension` (the separate script that builds `d1-force-dashboard`, whose tile the down migration restores),
   and the two `d1-report` builds from step 1.
4. `docker compose up -d --force-recreate directus`. The removed folders came back with the checkout.

The STARbase tile stays first in the bar; remove it under Settings → Appearance if wanted.
