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

The admin People page: `d1-people-admin` (a Directus endpoint), migration 174 and STARbase's `/people` and `/accept-invite`.
**No new `.env` keys.** `USER_INVITE_URL_ALLOW_LIST` is derived from `STARBASE_URL` in `docker-compose.yml`
(`${STARBASE_URL}/accept-invite`), so `STARBASE_URL` must already be set (the STARbase rollout above); while it is blank the
invite routes answer `503`.

1. `git pull && npm ci && npm run build:starbase && npm run build:extensions`. d1-server has the maintainer's uncommitted
   `docker-compose.yml` edits (the `EMAIL_*` settings), so `git pull` may refuse or conflict: `git stash` first and `git stash pop`
   after (merge by hand if it conflicts), or merge the compose file yourself. Do not discard them: invites need that mail setup.
2. `make migrate-status` (174 pending), then `make migrate` (migration 174: the SQL functions behind the attention line and a
   person's access counts).
3. `docker compose up -d --force-recreate directus`. The recreate is what makes Directus load `d1-people-admin` and pick up
   `USER_INVITE_URL_ALLOW_LIST`; a plain `restart` is not enough for a changed environment. Then
   `docker compose up -d --force-recreate proxy` for the new STARbase build.
4. Invites need a working mail transport: the `EMAIL_*` settings on live (see `docs/runbooks/a1-record-access-cutover.md`). Directus
   sends the mail without waiting, so a failed delivery is only in `docker compose logs directus`; the page says "sent", never
   "delivered". Check by inviting yourself from People → Invite, then opening the link.
5. Smoke: People shows the "needs attention" line and the Role menu; a person's panel shows Account and Access;
   `curl -s -o /dev/null -w '%{http_code}' https://d1-server.tail54eeb6.ts.net/d1-people-admin/people` without a session is `401`.

Rollback: `make migrate-down` (174), `git checkout <previous commit>`, rebuild as in step 1, recreate `directus` and `proxy`.
A login invited meanwhile stays (an invited user is an ordinary Directus user).

## Teams (PR 2) (maintainer's step, approve separately)

Teams: migrations 175 (`teams`, `team_members`, `team_events`) and 176 (team grants, the derived access rows, the pending tables, the
SQL functions), the new `d1-teams` endpoint, the team routes of `d1-record-access` and STARbase's Teams view, team page, members card
and Home "Waiting for you". **No new `.env` keys.**

**Deploy `d1-record-access` together with migration 176.** 176 splits `UNIQUE (record, person_id)` on the five access tables into two
partial unique indexes, so the person-entry upsert of the old `d1-record-access` (`ON CONFLICT (record, person_id)`) no longer matches
an index and every add-person call fails until the new build (its upsert names `WHERE team_access_id IS NULL`) is loaded. Never apply 176
and leave the old extension running; the steps below do both in one go. `d1-teams` is a new extension folder inside the mounted
`core/extensions` directory: it needs no registration, only the recreate in step 4.

1. `git pull && npm ci && npm run build:starbase && npm run build:extensions` (same stash advice as the People admin section above).
2. Back up (`docs/runbooks/backup-restore.md`), then `make migrate-status` (175 and 176 pending) and `make migrate`. 176 gives no team
   access to anybody (no grants exist yet), so existing readers do not change.
3. Check the derived rows and the readers, both must be clean:
   ```sql
   SELECT * FROM d1_private.team_drift();            -- 0 rows
   SELECT d1_private.readers_drift_count();          -- 0
   ```
4. Reload Directus on the new extensions and a clean permission cache. **Between `make migrate` (176) and this step the old
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
run on 2026-10-14 on the seeded copy of live, before (`--skip 20261014000174 --skip 20261014000175 --skip 20261014000176`, overlays
`d1-next-number d1-access-guard d1-record-access d1-trace d1-admin-overview`) and after (the same plus `d1-teams d1-people-admin
d1-person-link`), with `D1_SMOKE_MODE=perf D1_SMOKE_REQUIRE_LM=1 bash scripts/dev/directus_smoke.sh` and
`py -3 scripts/dev/perf_compare.py before.log after.log`: GATE PASS, worst read p95 143 ms, worst write ratio x1.00,
`team_join_100_records` 115 ms and `team_grant_20_members` 81 ms through Directus (59 ms and 17 ms in SQL). Re-run it on the
maintainer's machine if the copy of live has changed a lot; the procedure is in `docs/runbooks/a1-record-access-cutover.md`.

Rollback: `make migrate-down` twice (176, then 175; 176's down deletes the derived rows and restores the old unique constraints),
`git checkout <previous commit>`, rebuild, then reload exactly as in step 4: `docker compose stop directus`, flush Redis only after `rq info`
shows nothing queued, nothing failed and no busy worker (or, instead of the flush, start Directus and run `POST /utils/cache/clear` as an
administrator at once), start `directus`, recreate `proxy`. Deploy the previous `d1-record-access` at the same time. Teams, their members and history are lost with 175's down.

## Team ownership (PR 3) (maintainer's step, approve separately)

A team can own a sample, campaign, operation or test (never a project); its managers act as the owner and its members can edit. Migrations
**177** (`owner_team_id`, the owner grant, the `manage` level, the readers and bookkeeping) and **178** (the regenerated Lab Member rules),
the new `d1-access-guard` and `d1-owner-default`, `d1-record-access` (transfer to a team, team owners in Who has access), `d1-teams`
(delete guard, owned counts, owners' queue) and `d1-admin-overview` (ownerless counts), and STARbase (team owners in Who has access, the
rails, the team page, My work). **No new `.env` keys.** Needs PR 2 ("Teams (PR 2)" above) deployed first.

**Apply 177 and 178 together, and deploy the five extensions with them.** 177 alone would let any editor write `owner_team_id` through the
API (the guard that refuses it is 178's rules plus `d1-access-guard`'s `rules.json`) and make their own team the owner, so a manager of
their team would be handed `manage`. Never stop between the two migrations, and never leave the old extensions running with 177 applied:
the old `d1-record-access` does not know `owner_team_id`, the old `d1-teams` would not turn the refusal of an owning team's delete into the 409 with counts, and the
old `d1-admin-overview` counts team-owned records as ownerless (the new one needs the column and fails soft without it). That is why
Directus is stopped before `make migrate` (step 2) and only started again on the new extensions (step 4).

1. `git pull && npm ci && npm run build:starbase && npm run build:extensions` (same stash advice as the People admin section above).
2. **Stop Directus first** (`docker compose stop directus`) so the old Directus and the old guard never serve against 177 without 178's
   rules (a running Directus would let an editor write `owner_team_id` in that window). Back up (`docs/runbooks/backup-restore.md`), then
   `make migrate-status` (177 and 178 pending) and `make migrate`. 177 changes no
   access: no record has an `owner_team_id` yet, so existing readers do not change. 178 replaces 15 collections' Lab Member rows (a backup
   of the old rows is in `d1_private.team_ownership_rules_backup`).
3. Check, both must be clean:
   ```sql
   SELECT * FROM d1_private.team_drift();            -- 0 rows
   SELECT d1_private.readers_drift_count();          -- 0
   ```
4. Reload Directus on the new extensions and a clean permission cache, **in the same order as "Teams (PR 2)" step 4** (Directus is
   already stopped from step 2, and must stay stopped until here, so nothing re-caches stale permissions): either flush Redis (only after
   `docker compose exec heavy-data-worker sh -c 'rq info --url "$REDIS_URL"'` shows every queue empty, nothing failed and no busy worker:
   `docker compose exec -T redis redis-cli FLUSHALL`) and `docker compose up -d directus` (with `--force-recreate` for the changed
   extension folders), or start Directus and run `POST /utils/cache/clear` as an administrator **immediately after it starts and before
   anyone is let back in**; then `docker compose up -d --force-recreate proxy` for the new STARbase build. Directus is down from step 2
   until here, so keep that window short (178's rules and the new extensions must be live together).
5. Smoke: on a sample you own, Who has access → Transfer ownership… → pick a team you manage; the owner row now reads "<team> (managers)",
   the rail's Owner shows the team name, and you (the previous owner) stay on it as Can edit. A plain member of that team can edit the
   sample but sees "Only <team>'s managers can change who has access." and no controls; transfer a team with no manager and the dialog
   says "has no manager". On the team's page Delete says what it owns and does nothing. Transfer the sample back to yourself: the team
   no longer owns it and its members lose access. `team_drift()` and `readers_drift_count()` are still 0 after the smoke.
   Tailnet browser smoke is `tests/ui/specs/19-team-ownership.spec.ts` on the preview (below), not on live.

Known behaviour: a record becomes team-owned only through Transfer ownership (a Lab Member's create with `owner_team_id` is refused with
403; an administrator or an import may create one). Transfer from a team to a person or to another team does **not** keep the outgoing
managers on the record (a person to person transfer keeps the old owner as Can edit): the dialog warns, and the new owner adds them back.
A team whose only managers are inactive can still receive a transfer; such a record is administrator-managed until a manager is
reactivated. A team that owns records cannot be deleted (409 `TEAM_OWNS_RECORDS`, with counts): transfer them first. If `team_drift()` shows
`own_missing`, `own_extra` or `own_pending`, clear the record's team (transfer it to a person) and transfer it again; never edit derived
rows by hand. Label owner initials, `d1-report`'s owner row, ForceDashboard "related to me" and Home's force-error tile still follow the
person owner only (spec section 11, E30).

Preview and E2E: `npm run build:extensions && npm run build -w starbase-web`, then the preview with the overlay of `tests/ui/README.md`
(it must include `d1-owner-default d1-access-guard`; the preview applies 177 and 178) and
`cd tests/ui && npx playwright test specs/19-team-ownership.spec.ts`. It proves on real Directus that a plain member of the owning team is
refused delete, share and transfer although a manager's `manage` row is on the same record.

Performance: the gate of PR 2 (p95 below 300 ms per list request, writes at most 2x, the two team writers under 500 ms) was re-run on
2026-10-14 on the seeded copy of live, before (`--skip 20261014000177 --skip 20261014000178`, overlays `d1-next-number d1-access-guard
d1-trace d1-admin-overview d1-people-admin d1-person-link`: the new `d1-record-access` and `d1-teams` read `owner_team_id`, so the "before"
runs without them) and after (the same plus `d1-owner-default d1-record-access d1-teams`), each with `D1_SMOKE_MODE=perf D1_SMOKE_REQUIRE_LM=1
bash scripts/dev/directus_smoke.sh` and compared with `py -3 scripts/dev/perf_compare.py before.log after.log`. Result: worst read p95 144 ms
(`co_owned_operation_all_fields` as a stranger, 38 to 144 ms, and `co_owned_operation_item` 13 to 39 ms: the reads that moved, x3.8 and x3.0;
177 alone causes it, 178's rules add nothing; the member's own `co_owned_operation_*` reads are x1.9 to x2.1), every other read within x1.7; writes at most x1.53 (`link_login_big_pi`),
the importer and the cascades x1.0 to x1.1. The team writers: `team_grant_20_members` 30 ms in SQL (was 15) and 106 ms through Directus,
`team_join_100_records` 71 ms in SQL (was 36) and 123 ms through Directus, all far under their 500 ms limit. `perf_compare.py` still prints
`GATE: FAIL (2 problems)` for the two team writers, and the table behind it is not like for like: it keeps one line per scenario name (the last), the
"after" log has the SQL line and then the Directus line, the "before" log has only the SQL line (no `d1-teams` in it), so it compares Directus-after
(106 and 123 ms) with SQL-before (15 and 36 ms), x7.07 and x3.42. Like for like in SQL the ratios are x2.0 (30 / 15 ms) and x1.97 (71 / 36 ms), right
at the 2x line and from millisecond medians of three repetitions; through Directus there is no "before". Spec section 10 (E20) judges the two
writers against 500 ms, where both pass by a wide margin. Two earlier "after" runs on the same machine were uniformly 3 to 4x slower on every
request, unrelated ones included (`force_replay_search` 8 to 24 ms), while a 177-only run, the "before" runs and a third "after" run were
not: machine load, not the change; if a re-run looks like that, repeat it on a quiet machine. Re-run it when the copy of live has changed a lot
(the procedure is in `docs/runbooks/a1-record-access-cutover.md`).

Rollback: `docker compose stop directus` first, then `make migrate-down` twice (178, then 177), **after** transferring every team-owned record to a person (177's down refuses with
0A000 while any record has an `owner_team_id`; 178's down restores the previous Lab Member rows from its backup table), `git checkout
<previous commit>`, rebuild, then reload exactly as in step 4 and deploy the previous `d1-access-guard`, `d1-owner-default`,
`d1-record-access`, `d1-teams` and `d1-admin-overview` at the same time. Teams, members and history stay (175 and 176 are untouched).
