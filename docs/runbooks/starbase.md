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

## 1. Tailnet policy (maintainer's step, approve separately)

Add the tag, owned by you, and let the people who reach d1-server reach STARbase on 443:

```jsonc
"tagOwners": { "tag:starbase": ["<your login>"] },
// next to the rule that grants d1-server, with the same sources:
{ "src": ["<the d1-server audience>"], "dst": ["tag:starbase"], "ip": ["443"] }
```

### 1a. Shared devices (maintainer's step, approve separately)

If d1-server is shared with anyone outside the tailnet (device sharing), share `starbase` with the same
people: access rules do not reach share recipients. First confirm in the admin console that a tagged
device can be shared this way. Do this once the device exists (after step 4); until then those people
cannot reach STARbase.

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
`CONTENT_SECURITY_POLICY_DIRECTIVES__FRAME_ANCESTORS` (`'self' <STARbase>`). Check them before going on:

```bash
docker compose config | grep -E 'CORS_ORIGIN|CORS_ORIGINS|FRAME_ANCESTORS|SESSION_COOKIE_SECURE|STARBASE_URL'
```

Later, for Google sign-in (out of scope now): `AUTH_PROVIDERS=google`, `AUTH_GOOGLE_MODE=session`, and
`AUTH_GOOGLE_REDIRECT_ALLOW_LIST` including `https://starbase.tail54eeb6.ts.net/signin/done`. STARbase
shows the button by itself once Directus lists the provider.

## 4. Build and start (maintainer's step, approve separately)

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

Recreating `proxy` is what loads the new Caddyfile: the `:8090` site (STARbase, with its CSP) and the
`Cross-Origin-Opener-Policy: unsafe-none` override on `/admin/d1-edit/*`. Directus sends its own
`same-origin` COOP, which would sever `window.opener` for the edit page's new-tab fallback; Caddy
relaxes it for that one path and nowhere else.

## 5. Smoke check (maintainer's step, with someone on a second device)

1. Open `https://starbase.tail54eeb6.ts.net` over the tailnet: the sign-in page, with the STAR logo.
2. Sign in. In another tab, open Data Studio: already signed in.
3. Open a test record, **Edit**: the Directus form opens inside STARbase. Change a field, Save: the
   dialog closes and the page shows the new value. Put it back.
4. Plot one force operation (`/plot/force?operation=<id>`): the signals draw, the **FRM map** streams
   (`/octrees`), a **filter preview** answers (`/filter`), and a **diagnostics preview** answers (`/diag`).
   Download a file from the plot page: it saves as an attachment and the plot page stays where it was.
5. In Data Studio's Home module, "Open in STARbase" is under the sidebar and opens the same page.
6. Print a sample report: its QR code and link open the STARbase record page.
7. Sign out of STARbase: Data Studio is signed out too.
8. On a phone (if it is on the tailnet): the top bar and menu, a list, a record page.
9. Real Safari / iOS, if anyone has it: steps 1–3. Step 0 tested Chromium only (spec §9).

The frame posts only to `STARBASE_URL`'s origin (`GET /d1-links`). If that is unset or wrong, Save still
works, but the dialog does not close on its own: the form says "Saved. You can close this form."

If step 3 shows "The form didn't open here", check that the frame setting reached Directus:
`curl -sI https://d1-server.tail54eeb6.ts.net/admin/ | grep -i content-security-policy` must contain
`frame-ancestors 'self' https://starbase.tail54eeb6.ts.net`. The new-tab fallback works meanwhile. If the
fallback opens but Save does not close it or tell STARbase, check the COOP override:
`curl -sI https://d1-server.tail54eeb6.ts.net/admin/d1-edit/x/1 | grep -i cross-origin-opener-policy` must say
`unsafe-none`, while `/admin/` keeps Directus's own value.

## Redeploying after a change (maintainer's step, approve separately)

```bash
git pull && npm ci && npm run build:starbase
docker compose up -d --force-recreate proxy
```

(the same rhythm as the Force App's `/app/`). A change to `d1-edit-frame` also needs its build and a
`directus` recreate.

## Rolling back (maintainer's step, approve separately)

```bash
docker compose --profile starbase stop starbase
```

Then empty `STARBASE_ORIGIN` and `STARBASE_URL` in `.env`, set `SESSION_COOKIE_SECURE` as it was, and
`docker compose up -d --force-recreate directus filter-service diag-service proxy`. Reports and the label
redirects return to the Directus Home module; nothing else changes.
