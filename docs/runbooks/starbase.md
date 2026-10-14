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
1. `git pull && npm ci && npm run build:starbase && npm run build:extensions`. d1-server has the maintainer's uncommitted
   `docker-compose.yml` edits (the `EMAIL_*` settings), so `git pull` may refuse or conflict: `git stash` first and `git stash pop`
   after (merge by hand if it conflicts), or merge the compose file yourself. Do not discard them: invites need that mail setup. then
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

## People admin (PR 1) (maintainer's step, approve separately)

The admin People page: `d1-people-admin` (a Directus endpoint), migration 180 and STARbase's `/people` and `/accept-invite`.
**No new `.env` keys.** `USER_INVITE_URL_ALLOW_LIST` is derived from `STARBASE_URL` in `docker-compose.yml`
(`${STARBASE_URL}/accept-invite`), so `STARBASE_URL` must already be set (the STARbase rollout above); while it is blank the
invite routes answer `503`.

1. `git pull && npm ci && npm run build:starbase && npm run build:extensions`. d1-server has the maintainer's uncommitted
   `docker-compose.yml` edits (the `EMAIL_*` settings), so `git pull` may refuse or conflict: `git stash` first and `git stash pop`
   after (merge by hand if it conflicts), or merge the compose file yourself. Do not discard them: invites need that mail setup.
2. `make migrate-status` (180 pending), then `make migrate` (migration 180: the SQL functions behind the attention line and a
   person's access counts).
3. `docker compose up -d --force-recreate directus`. The recreate is what makes Directus load `d1-people-admin` and pick up
   `USER_INVITE_URL_ALLOW_LIST`; a plain `restart` is not enough for a changed environment. Then
   `docker compose up -d --force-recreate proxy` for the new STARbase build.
4. Invites need a working mail transport: the `EMAIL_*` settings on live (see `docs/runbooks/a1-record-access-cutover.md`). Directus
   sends the mail without waiting, so a failed delivery is only in `docker compose logs directus`; the page says "sent", never
   "delivered". Check by inviting yourself from People → Invite, then opening the link.
5. Smoke: People shows the "needs attention" line and the Role menu; a person's panel shows Account and Access;
   `curl -s -o /dev/null -w '%{http_code}' https://d1-server.tail54eeb6.ts.net/d1-people-admin/people` without a session is `401`.

Rollback: `make migrate-down` (180), `git checkout <previous commit>`, rebuild as in step 1, recreate `directus` and `proxy`.
A login invited meanwhile stays (an invited user is an ordinary Directus user).

## Teams (PR 2) (maintainer's step, approve separately)

Teams: migrations 181 (`teams`, `team_members`, `team_events`) and 182 (team grants, the derived access rows, the pending tables, the
SQL functions), the new `d1-teams` endpoint, the team routes of `d1-record-access` and STARbase's Teams view, team page, members card
and Home "Waiting for you". **No new `.env` keys.**

**Deploy `d1-record-access` together with migration 182.** 182 splits `UNIQUE (record, person_id)` on the five access tables into two
partial unique indexes, so the person-entry upsert of the old `d1-record-access` (`ON CONFLICT (record, person_id)`) no longer matches
an index and every add-person call fails until the new build (its upsert names `WHERE team_access_id IS NULL`) is loaded. Never apply 182
and leave the old extension running; the steps below do both in one go. `d1-teams` is a new extension folder inside the mounted
`core/extensions` directory: it needs no registration, only the recreate in step 4.

1. `git pull && npm ci && npm run build:starbase && npm run build:extensions` (same stash advice as the People admin section above).
2. Back up (`docs/runbooks/backup-restore.md`), then `make migrate-status` (181 and 182 pending) and `make migrate`. 182 gives no team
   access to anybody (no grants exist yet), so existing readers do not change.
3. Check the derived rows and the readers, both must be clean:
   ```sql
   SELECT * FROM d1_private.team_drift();            -- 0 rows
   SELECT d1_private.readers_drift_count();          -- 0
   ```
4. Reload Directus on the new extensions and a clean permission cache. **Between `make migrate` (182) and this step the old
   `d1-record-access` is still running, and adding a person through Who has access fails (its upsert no longer matches an index): keep that
   window short, go straight from step 2 to here (step 3 is SQL only and can wait until Directus is back).** In order:
   ```bash
   docker compose stop directus                      # first: a running Directus would re-cache stale permissions after a flush
   # Redis also holds the rq queues of heavy-data-worker and analysis-worker. FLUSHALL drops queued and in-flight jobs, so check first:
   docker compose exec heavy-data-worker sh -c 'rq info --url "$REDIS_URL"'     # every queue: 0 queued, 0 failed, and no worker busy
   docker compose exec -T redis redis-cli FLUSHALL   # only when rq info shows nothing queued, nothing failed and no busy worker; otherwise wait for a quiet window
   docker compose up -d directus                     # (--force-recreate if the extension folder or .env changed)
   docker compose up -d --force-recreate proxy       # the new STARbase build
   ```
   Alternative that leaves Redis alone (skip the `rq info` check and the flush): start Directus (`docker compose up -d --force-recreate
   directus`) and, as an administrator, run `POST /utils/cache/clear` **immediately after Directus starts and before the proxy is recreated or
   anyone is let back in**, so no cached permission answer from before the migration is served (Directus caches permissions; the reference
   is docs/runbooks/upgrade-2026-10-row-level-visibility.md step 3). Then recreate proxy.
5. Smoke: People shows the People | Teams switch; New team creates one and opens `/home/teams/<id>`; on a sample you own, Who has
   access → add the team, then add a person to the team: that person is "waiting" (Home "Waiting for you" for the owner) until
   approved or until Trust future members is ticked. `curl -s -o /dev/null -w '%{http_code}' https://d1-server.tail54eeb6.ts.net/d1-teams`
   without a session is `401`. Joiner and team mails need the `EMAIL_*` settings (see the People admin section).

Known behaviour: a derived row (an `<type>_access` row with `team_access_id` set) cannot be edited by hand, not even by an
Administrator in Data Studio (42501 "Team access rows are managed by the team's grant"); change the team's grant instead. If the
drift check ever shows rows (`missing`, `extra` or `role`, per grant and person), remove the team's grant on that record and add it
again from Who has access (the grant's triggers rebuild its derived rows); do not edit derived rows by hand.

Performance: the write paths `team_join_100_records` and `team_grant_20_members` are in `scripts/dev/perf_writes.sql` and
`scripts/dev/directus_perf_writes.mjs`. The gate (p95 < 300 ms per list request, writes at most 2x, the two team writers under 500 ms) was
run on 2026-10-14 on the seeded copy of live, before (`--skip 20261014000180 --skip 20261014000181 --skip 20261014000182`, overlays
`d1-next-number d1-access-guard d1-record-access d1-trace d1-admin-overview`) and after (the same plus `d1-teams d1-people-admin
d1-person-link`), with `D1_SMOKE_MODE=perf D1_SMOKE_REQUIRE_LM=1 bash scripts/dev/directus_smoke.sh` and
`py -3 scripts/dev/perf_compare.py before.log after.log`: GATE PASS, worst read p95 143 ms, worst write ratio x1.00,
`team_join_100_records` 115 ms and `team_grant_20_members` 81 ms through Directus (59 ms and 17 ms in SQL). Re-run it on the
maintainer's machine if the copy of live has changed a lot; the procedure is in `docs/runbooks/a1-record-access-cutover.md`.

Rollback: `make migrate-down` twice (182, then 181; 182's down deletes the derived rows and restores the old unique constraints),
`git checkout <previous commit>`, rebuild, then reload exactly as in step 4: `docker compose stop directus`, flush Redis only after `rq info`
shows nothing queued, nothing failed and no busy worker (or, instead of the flush, start Directus and run `POST /utils/cache/clear` as an
administrator at once), start `directus`, recreate `proxy`. Deploy the previous `d1-record-access` at the same time. Teams, their members and history are lost with 181's down.

## Recorded batches (migration 177, process map slice 2)

Recorded batches (ADR-0017): a `batches` table, a nullable `batch_id` on `manufacturing_operations` and
`test_sessions`, the Lab Member permissions for `batches`, and the FAST press's `sintering_batch_number` field
relabelled **Powder batch**. Maintainer's step, approve separately.

**Order.** The map tolerates a missing `batch_id` (it asks for the field only when Directus reports it), so this STARbase
build can be deployed before or after the migration. Migrating does not change what the map draws until someone sets a
`batch_id`. The **Batch** field on an operation or test form, and the **Batches** collection, need steps 1 and 2 only; step 3 is for the map (its grouping by `batch_id`):

1. `git pull`, then `make migrate-status` (177 pending) and `make migrate` (migration 177).
2. `docker compose restart directus`: Directus reads its schema and permissions at start, and no Redis cache is configured for it, so the restart is the operative step. This also loads the `d1-owner-default` hook, which now fills `owner_person_id` on a new
   batch (it has no build step; `core/extensions` is mounted as it is). Without the restart a Lab Member's new batch has no
   owner, and only an admin could then edit it.
3. The STARbase build that groups by `batch_id` (only the map needs it): `git pull && npm ci && npm run build:starbase`, then
   `docker compose up -d --force-recreate proxy` (see "Redeploying after a change" above). This step can come before
   or after steps 1 and 2.

Run the migration while no import is running: it sets a 10 s lock timeout, so on a lock timeout just run `make migrate` again.

Check:
- `GET /fields/batches` answers (admin token); `GET /fields/manufacturing_operations/sintering_batch_number` shows the
  translation "Powder batch".
- In Data Studio, create a batch with the **Code** field left alone: it saves as `B-0001`, `B-0002`, ... The form shows the
  text `batches_next_code()` in that field before the first save (Directus prefills a column default it cannot evaluate);
  it is never sent, and the database fills the code. Only a code someone types is kept. (An explicit `"code": null` through the API is refused by Directus with a 400; a blank code is filled.)
- Set **Batch** on two operations of one sample and open the sample's Process map: one container, "Batch B-…".

Rollback: `make migrate-down` drops `batches` (operations and tests keep their rows; `batch_id` goes). Restart Directus
immediately afterwards: its cached schema still lists `batch_id`, so every read that asks for `fields=*` on operations or tests
fails with a 500 until it restarts. `make migrate-down` rolls back only the latest applied migration, so it undoes 177 only
while 177 is still the newest one applied.

## Report a bug page (`/report-bug`)

STARbase's own Report a bug page posts to the `d1-bug-report` Directus endpoint
(`core/extensions/d1-bug-report-endpoint`), which looks the reporter up from the session and forwards
`{title, body, labels}` to the bug-report relay (`apps/force-app/bug-report-relay`). Issues carry the labels
`starbase-report`, `bug` or `enhancement`, and `area:starbase`; the area and page the reporter
picked are in the body, never labels. The relay is unchanged, and there is no "already reported" list.

Deploy (maintainer's step, approve separately). The endpoint is plain JavaScript, so it has no build of its own
(`build:extensions` does not list it, like `d1-ask-endpoint`); the STARbase pages ship with `npm run build:starbase`.
The same branch changes `@d1/ui`, which the Directus extensions bundle, so rebuild those too:

1. Check out the branch; `npm run build:extensions` and `npm run build:starbase`. `core/extensions` is mounted
   read-only into Directus, so the new folder is already there.
2. `docker compose exec -T redis redis-cli FLUSHALL`, then `docker compose restart directus` (extensions load at start).
3. `BUG_REPORT_RELAY_URL` can stay unset: the endpoint defaults to `http://bug-report-relay:8211`, the compose service.
4. Smoke: sign in to STARbase, open Report a bug, send a test report; the page shows the issue number. An unreachable
   relay shows "could not reach the bug-report relay" instead.
