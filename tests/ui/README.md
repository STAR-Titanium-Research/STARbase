# D1-Database — Directus UI tests

Playwright end-to-end tests that drive the **real Directus admin UI** and assert
the form behaviour the SQL config is supposed to produce. These catch the class
of bug that schema-level checks miss — e.g. a conditional panel that is wired in
`directus_fields.conditions` but doesn't actually toggle in the browser.

## What's covered

| Spec | Asserts |
|------|---------|
| `01-mfg-op-conditional-params` | Manufacturing Operation form: picking a **Process Category** reveals only that type's typed parameter **fields inline** (Machining / Sintering / Additive). |
| `02-test-session-conditional-params` | Test Session form: picking a **Test Type** reveals only that type's typed parameter **fields inline** (Tensile / Hardness). |
| `03-sample-geometry-preview` | Sample form: the custom **Shape Preview** interface draws a live SVG from Geometry + dimensions, including the cylinder, round bar (Ø + length) and bar shapes. |
| `04-project-investigators` | Project form: the **Secondary Investigators** M2M field and its access-notice are present. |
| `05-detail-pages-load` | Regression: opening an **existing** record (samples/projects/operations/sessions) returns the form, not a 500 / "Page Not Found". Catches alias fields missing `no-data` and M2M junctions whose tables don't exist. |
| `06-machine-filter` | Machine picker (`d1-machine-picker`): an operation or test offers only equipment capable of its process/test category, tiered by facility. |
| `07-inventory-conditional` | Sample form: per-geometry dimensions (incl. round bar and tensile-coupon gauge fields) show or hide by Geometry and the Shape Preview renders (Item Type is hidden: the database defaults it to sample); an existing rig-kit row (item type equipment) hides the sample-only fields. |
| `08-operation-code-autogen` | Manufacturing Operation: the operation code composes live from sample, sub-type, pass and cutting parameters, and a manual edit is kept. |
| `09-campaign-inheritance` | Campaigns: a new operation inherits project and equipment from its campaign (the `campaign-inherit` hook) and is owned by its creator, and the form fills the project live. |
| `10-ask-db-chat` | **Ask the Database** module: a stubbed proxy response renders the SQL block, result table, and Plotly chart; the `/d1-ask/chat` endpoint rejects unauthenticated requests (401) and passes the auth gate for a logged-in session. A live end-to-end smoke runs only with `D1_LLM_LIVE=1`. |
| `11-force-dashboard` | STARbase's Force plotter (`/plot/force`; it was the Directus Force Analysis module before phase 1 of going headless): sample → operation drill-down, signal charts and the per-axis FRM, including the Figure ⇄ Lite switch. Needs at least one processed `machining_force_analysis` row, and the STARbase preview set up as in the section below (each test signs in to STARbase). The Force Crawler test at the end still drives Data Studio. |
| `12-force-crawler` | Force Crawler module: status, queue stats, settings and activity read from and written to `force_crawler_state`. |
| `13-explorer-routes` | Explorer pages: every page in the nav config plus a first record of each kind draws its body and nav with no console error, as an admin and as a Lab Member. These pages are STARbase's (the Home module is gone), so they always run on STARbase; the other kit users (the `d1-campaign-ops` interface and the `d1-lab-dashboard` module) still render in Data Studio. Runs against the preview, not live, with the STARbase setup in the section below (env `D1_ROUTES_CREDENTIALS`, `D1_ROUTES_ADMIN_BASE`, and `D1_ROUTES_STARBASE=http://127.0.0.1:5190` when STARbase is not at its default address). |
| `14-starbase` | STARbase (`apps/starbase/web`) end to end: sign-in shared with Data Studio, a deep link through sign-in, editing through the framed Directus form and its new-tab fallback, a sign-out in Data Studio sending STARbase to sign in, a credentialed write, shared sign-out, the plot pages, the phone layout. Against the `d1-starbase` preview and `vite preview` (production CSP). Two layouts: ports (default) and `STARBASE_E2E_MODE=hosts`, step 0's two tailnet hostnames over local HTTPS (`tests/ui/starbase/hosts.ts`). Commands in plan 2, Task 12. |
| `15-starbase-polish` | STARbase follow-ups from the plan-2 review, in a real browser: the phone menu stays open on a drag from the sheet onto the backdrop and closes on a tap there; a dialog (People, and the edit form) closes on Esc/backdrop and returns focus to its opener; a failed plot download (404) leaves the plot page in place and says so, a good one saves under the server's filename. Same setup as spec 14 (ports layout). Run: `cd tests/ui && npx playwright test specs/15-starbase-polish.spec.ts`. |
| `16-sidebar-b2` | The Explorer sidebar in STARbase (explorer-sidebar-b2): pin Operations and reload, reorder by `Alt+↑`, collapse to the rail with a hover menu at 1280 px, `[` / `]`, the overlay at 900 px (Esc, backdrop, page, growing past 999 px), the sheet at 600 px, the theme toggle and the compact foot, and a keyboard-only pass, and pinning a row of Home's Frequently used list (it moves into the sidebar), and the Settings page (theme and sidebar switches persist, a failed save and Retry, Move up, Reset to defaults, "No longer available", Forget my list views, Clear my history). Needs only STARbase from `vite preview` (production CSP): d1-server is a stateful stand-in (`tests/ui/starbase/stubD1.ts`, routed in the browser), no Directus. Run: `npm run build -w starbase-web && STARBASE_D1_ORIGIN=http://127.0.0.1:18057 npm run preview -w starbase-web`, then `cd tests/ui && npx playwright test specs/16-sidebar-b2.spec.ts`. |
| `17-form-blockers` | The four form bugs of migration 173: a Test Session saves from the form with only a Subject picked (its hidden `sample_id` is set by the database), an Imaging / Analysis campaign saves, Owner shows the person by name (not a UUID in a text box), and a stored machining sub-type (MT-F) shows its label. |
| `18-form-layout` | The headed Field groups of migration 174 on the Sample, Operation, Test, Project, Campaign and Raw stock lot create forms (names and order), Related records absent on a new Sample, Material and Geometry on a blank Sample form, the per-type Test groups, Item Type hidden, and a Lab Member sees Co-owners read-only. |
| `17-people-admin` | The admin People page (`d1-people-admin` + STARbase `/people`): chips and Sort in the URL and across a reload, the attention line opening a filtered list, the person panel's account role and last sign-in with a role change that round-trips, suspend and reactivate (the suspended member is signed out), invite a new person (row "Invite not accepted"; no mail transport in the preview, so no delivery check) and `/accept-invite` with a bad token, a member's view (no attention line or Role menu, own row opens the panel, the endpoint answers 403), Esc layering (select, Edit dialog, attention menu, then the panel and focus back on the row), the phone bottom sheet, and the three SQL functions against real Postgres. Same setup as spec 14 (ports layout); the preview overlay needs `d1-people-admin d1-record-access` (the script's default has them). Run: `cd tests/ui && npx playwright test specs/17-people-admin.spec.ts`. |
| `18-teams` | Teams (`d1-teams`, the team routes of `d1-record-access`, STARbase Teams view, team page, Who has access, Home Waiting for you): a team given Can edit on a Restricted sample gives an active member read and edit (the owner adds it in the Who has access dialog; the member could not read it before); a joiner without Trust future members is pending and cannot read, the owner sees Waiting for you on Home and approves, and the joiner reads and edits; Decline all keeps them out and the owner approves later from the row; Trust future members lets the next joiner read at once; Leave on the team page ends access at once; hover and keyboard focus on a team row show the members card (a disclosure: focus stays on the trigger, Esc closes only the card); the last manager is refused ("Make someone else a manager first", also 409 `LAST_MANAGER`); the People | Teams switch and the team page for a member; the people-admin access counts on real Postgres. Makes its own logins, people, teams and a Restricted sample through the API and removes them in `finally`. Same setup as spec 14 (ports layout); the preview overlay needs `d1-teams d1-record-access d1-people-admin d1-person-link` (the script's default has them) and migrations 181 and 182 (the preview applies them). Run: `cd tests/ui && npx playwright test specs/18-teams.spec.ts`. |
| `19-team-ownership` | Team ownership (migrations 183 and 184, `d1-record-access` transfer to a team, `d1-teams` delete guard, `d1-access-guard`, `d1-owner-default`, STARbase Who has access with a team owner, the rail, the team page), on real Directus and Postgres: the owner transfers a Restricted sample to a team in the browser (the owner row reads "<team> (managers)", the owner grant is not a team entry, the previous owner stays as Can edit); a manager and a plain member of the same team on the same record (**the person and role conditions of the delete and manage rules bind to the same access row**: the member reads and edits but is refused share, transfer, delete and the owner fields, sees "Only <team>'s managers can change who has access." and no controls, while the manager shares and sees them); a stranger reads nothing until shared; the rail shows the team; promoting the member to manager allows sharing, demoting removes it at once; the manager deletes the record; Ruling O3 (a Lab Member's create with `owner_team_id` is 403); Ruling O4 (a transfer to a team with no manager is 409 `TEAM_HAS_NO_MANAGER`, in the API and as the dialog's message); Delete on a team that owns a record is refused with the counts and does nothing; transfer back to a person clears the owner team and the derived access (the manager sees "Not found or not visible to you" afterwards, Ruling O5) and the team then deletes; a team-owned orphan operation is read by a team member and refused to a stranger while an ownerless one stays open. Makes its own logins, people, teams, samples and operations through the API and removes them in `finally`. Same setup as spec 14 (ports layout); the preview overlay needs `d1-teams d1-record-access d1-people-admin d1-person-link d1-owner-default d1-access-guard` and migrations 183 and 184 (the preview applies them). Run: `cd tests/ui && npx playwright test specs/19-team-ownership.spec.ts`. |
| `20-my-teams` | My teams (`d1-teams` `GET /:id/records` and `GET /mine/recent`, the index kit's Team filter, STARbase's Projects page and the Home My teams panel), on real Directus and Postgres: the endpoints name only records the viewer can read (**Ruling M1**: a restricted sample shared with the team before the member joined, so pending for them, is never in the ids, the filtered list or the panel; the manager who reads it is told of it; a stranger of nothing); the Samples Team filter shows exactly the member's readable team samples, `f.team=<id>` round-trips through the URL, a reload and a direct visit, and a stranger who opens the filtered URL sees nothing; the Projects Team filter shows "Loading this team's projects…" and then the project, never a "No project matches" flash; Home's My teams panel has links named "<Kind> <code>: <title>", the first 10 lines and "Show N more" by keyboard moving focus to line 11, and draws nothing (no heading) for a person in no team. Makes its own logins, people, team, 12 team-owned samples, a pending sample and a project through the API and removes them in `afterAll`. Same setup as spec 14 (ports layout); the preview overlay needs `d1-teams d1-record-access d1-people-admin d1-person-link d1-owner-default d1-access-guard`. Run: `cd tests/ui && npx playwright test specs/20-my-teams.spec.ts`. |
| `21-process-map` | The Process map (`/map`) on the preview copy, as an admin and as a Lab Member: a sample's family draws (cards, an operation container), a wire's tooltip names its sample and Ctrl+click moves the rail to its origin, ＋ on a slot adds cards, hover / a card drag / ＋ leave the viewport where it was, Open record and the Sample page's Process map button, an operation on a sample the account may not read says so, Tab reaches cards and sockets, a campaign's fan (its `sample_id.sample_code` sort), the Fz data thumbnail (draws, or falls back to its words when the file is missing), the phone's bottom sheet against the zoom controls, a recorded batch (a batch plus two operations of one sample, made through the API and removed afterwards, draws as one "Batch B-…" container). Export ▾ (a real PNG and a one-page PDF come down as files, the viewport does not move, focus returns to the button, no console error under the production CSP, and the menu works from the keyboard). Data comes from admin API queries, so a scenario skips when the copy has none; the Lab Member run lists a few family samples as "Can view" for the member (`sample_access`) in `beforeAll` and removes those rows in `afterAll`, so its scenarios run on a fresh copy. Same setup as spec 13 (`D1_ROUTES_CREDENTIALS` as an absolute path, `D1_ROUTES_STARBASE`). |
| `22-inbox` | The Inbox (found files; spec `2026-10-15-found-files-inbox-design.md`) in STARbase, against a stand-in d1-inbox (`tests/ui/starbase/stubInbox.ts`, the same in-memory fake the vitest page tests use, answered through Playwright routes): the sidebar entry under Home with the count of new files (older ones left out) in the expanded sidebar and the rail, Home's Inbox panel, the `/inbox` page (rows with the reason "short ID `…` in the file name", what the crawler read from an SEM image, a thumbnail for the two images the crawler stored a picture for (and no `/assets/` request: Directus cannot serve a pointer row), a surface-scan row whose button reads "Add a surface scan", is off and says "Surface scans can be added soon", documents collapsed under Other files with "Linking reads this file once to fingerprint it"), the full view of a picture (a click opens a dialog with the reduced-size preview, a spinner and the blurred thumbnail meanwhile, Retry after a failure, Esc / click outside / Close, focus back on the thumbnail, Tab kept inside, phone width), a thumbnail that fails leaving the icon, Link with Undo and the badge following, the record picker (Change), Accept all opening on a dry run (count, where files go, what is left) with one Undo per batch, focus moving to the next row after a Link and the one status region, Recently linked grouped by batch, tabs and filters in the URL, Dismiss and Restore, Ignore this folder (the confirm, the notice with Remove rule, the Ignored folders section with its add field and its refusals, a Lab Viewer who cannot remove, phone width), Rescan my folder and its 429 message, Settings' auto-link switch (off by default, consent text, on only through the confirm, Recently auto-linked with Undo), the Inbox crawler tab on `/crawler`, and no Inbox entry or panel when the server has no d1-inbox (404). Needs only STARbase from `vite preview` (production CSP), no Directus and no backend: `npm run build -w starbase-web && STARBASE_D1_ORIGIN=http://127.0.0.1:18057 npm run preview -w starbase-web`, then `cd tests/ui && npx playwright test specs/22-inbox.spec.ts` (`INBOX_SHOTS=<dir>` also saves screenshots). |
| `22-surface-scan` | Surface scans on inserts and edges (STARbase): the Surface scans panel with thumbnails, the 3D viewer drawn on the GPU from a made-up height grid (software WebGL in headless Chromium: the surface is on screen, the vertical-exaggeration slider and Colour by height change the picture, a drag and the wheel orbit and zoom, Reset view restores it, the legend gives the range in micrometres), an edge page that also lists its insert's scans, Render again on a failed render (the stand-in finishes a queued render by itself), the Add a surface scan dialog with its lab-wide warning and its create, and the page without WebGL. Needs only STARbase from `vite preview` (production CSP): d1-server is the stand-in `tests/ui/starbase/stubD1.ts` (+ `stubScans.ts`, `syntheticScan.ts`), no Directus, no real scan. Run: `npm run build -w starbase-web && STARBASE_D1_ORIGIN=http://127.0.0.1:18057 npm run preview -w starbase-web`, then `cd tests/ui && npx playwright test specs/22-surface-scan.spec.ts`. |

## Process map edit mode against the local stack (spec `edit-mode`)

`specs/edit-mode.spec.ts` drives `/map?edit=new` in a real browser against a **real local stack** that needs no Docker and no copy of
live: `scripts/dev/local-stack.sh` starts Postgres 16 (pgvector) with every migration, Directus 11 (from npm) with the repo's hook and
endpoint extensions (`d1-build`, `d1-owner-default`, `d1-access-guard`, ...) and the Lab Member / Lab Viewer permissions of
`scripts/access_rules.json`, and STARbase's vite dev server, with a small seeded family and three logins (admin, Lab Member, Lab Viewer).
The script's header says what it disables (Redis, MinIO, workers, Data Studio) and why. It is the check of the process map edit mode
redesign (`docs/superpowers/plans/2026-10-18-process-map-edit-redesign.md`), instead of the fake build server of the unit tests.

```bash
bash scripts/dev/local-stack.sh up        # 81 s from nothing with warm npm caches (it installs Directus and fetches dbmate); about 8 s when restarting with the data kept
bash scripts/dev/local-stack.sh status    # URLs and the three logins (also in /tmp/d1-local-stack/credentials.txt)
cd tests/ui && npx playwright test -c playwright.local-stack.config.ts          # about 10 minutes, 49 tests (9 of edit-mode.spec.ts, 28 of edit-mode-slice1.spec.ts, 12 of edit-mode-slice2b.spec.ts)
cd tests/ui && D1_SHOW_KNOWN_FAILURES=1 npx playwright test -c playwright.local-stack.config.ts   # the known failures show their real errors
bash scripts/dev/local-stack.sh down      # stop everything (data kept); `down --purge` also deletes the data
```

What it asserts: as the Lab Member, pick a seeded sample, add a CNC Turning operation from its socket menu, wire a new output sample,
press Create, then read the operation and the sample back through Directus's REST API (method, input sample, `work_state` planned, the
output sample's status planned, owner set). Each bug of the audit (spec §3 items 1 to 4) and of R11 (the server half, slice 1a, is probed: the two viewer tests are known failures only until it lands; the page half, a sidebar link a Lab Viewer should not see, is a known failure)
that reproduces today is a `test.fail()` that names its item; the slice that fixes it removes the mark. Records the tests Create are deleted
again afterwards, so the suite can be re-run. The config passes `/opt/pw-browsers/chromium` to Playwright when it exists (the cloud
container's one Chromium; never `playwright install` there).

`specs/edit-mode-slice1.spec.ts` is slice 1 of the redesign (R4 removal, R5 derived sockets, R6 layout, R10 Mark done, plain fixes, the
`d1-build` side of `test_category` and `material_id`) driven the same way, with the helpers of `starbase/mapEdit.ts` (open a draft, pick samples,
the socket menu, drags with a guard that the pointer is on the card it means, the saved draft read back from `d1-build`, card and wire
geometry). As the Lab Member (and the Lab Admin for seeding what the member may not make): Delete, X and Backspace on a new card and a wire, with
undo and redo; a planned operation and its planned output made through the API, struck through, deleted at Create and gone from the database
and the map, also by Delete on the output sample; done records locked with their reason and nothing sent; a wired input dragged off, a free
socket that never takes a wire, an input with two wires that loses neither to a drag; Dissolve and its refusal on a cut of three; derived
sockets, their absence from a sample something makes, the cards keeping their size and every wire staying on its socket through five
selections, a reload drawing the same canvas; a second piece added by connecting to the free output; no two cards overlapping after Add,
Duplicate x4, three picked samples, undo and redo, and two Adds in a row; a dragged card keeping its place through a reload, Undo of a drag
and of a Delete, Tidy leaving recorded cards where they are and one Ctrl+Z putting the draft's back; one card dragged without the selected
one following; Mark done by the owner and by a member who may edit the operation but not its output sample (R10, system rights), Back to
planned by the owner and its refusal to a second Lab Member (made by the admin and removed afterwards); and a Create with a test and an operation
read back for `test_category` and the inherited `material_id`. Everything a test makes is removed afterwards (a done operation is sent back to
planned by the admin first, a second member is deleted with their People row). One test is a known failure that says so: Back to planned by an
operation's owner who cannot edit its output sample is refused (a design gap, reported with the slice).

`specs/edit-mode-slice2b.spec.ts` is slice 2b (R9 Planned / Done at Create, R12 the project and campaign chooser, plain fixes 9 to 12), as the Lab Member:
a new operation made Done with a date and Created, read back for `work_state`, the date, `done_by_person_id`, `done_at` and its output sample `active`;
a done operation and a planned test in one draft; a done test whose required-for-done fields on the page are compared with d1-build's own `/check`
answer for the same saved draft; a done operation on a planned sample refused with the server's reason (and the same reason from the server); the
toggle's one-step undo and redo from the rail and from the card's chip; the chooser (pre-filled from the first sample, campaigns limited to the project,
a campaign cleared when the project changes, saved in the draft and kept over a reload, applied to every new record at Create, the new sample in the
campaign); My drafts listing a new draft with the list request failing; Build a process reusing an empty open draft; per-field undo; the blank-canvas
hint and the hidden Find / Reset / Clear; the "after Create" note on a new item's Data Studio field. The seed (`scripts/dev/local-stack.seed.sql`) has a
second project and a campaign in each for it. To run beside another stack, give the script and the suite the same `D1_STACK_DIR` and the three
`D1_STACK_PG_PORT`, `D1_STACK_DIRECTUS_PORT` and `D1_STACK_STARBASE_PORT` values (the Playwright helpers read the last two).

## STARbase end to end (spec 14; specs 11 and 13 run here too)

Needs the `d1-starbase` preview and STARbase served by `vite preview` (the production CSP). Specs 11 and 13
(STARbase's Force plotter and the Explorer pages) have no Directus-only mode any more, so run them with this
same setup; the last two commands below cover them. From the repo root:

```bash
npm run build:extensions && npm run build -w starbase-web
# ports layout: STARbase http://127.0.0.1:5190, Directus http://127.0.0.1:18057 (one host, plain HTTP)
D1_PREVIEW_NAME=d1-starbase D1_PREVIEW_PORT=18057 D1_PREVIEW_ENV_FILE=tests/ui/starbase/preview-ports.env \
  D1_PREVIEW_OVERLAY="d1-admin-overview d1-usage d1-campaign-ops d1-lab-dashboard d1-project-items d1-edit-frame d1-links d1-report d1-people-admin d1-record-access d1-teams d1-person-link d1-owner-default d1-access-guard" \
  bash scripts/dev/explorer_preview.sh
STARBASE_D1_ORIGIN=http://127.0.0.1:18057 npm run preview -w starbase-web     # keep running (port 5190)
CREDS="$PWD/.superpowers/preview-credentials-d1-starbase.txt"
(cd tests/ui && STARBASE_E2E_CREDENTIALS="$CREDS" npx playwright test specs/14-starbase.spec.ts --retries=0)
(cd tests/ui && D1_ROUTES_CREDENTIALS="$CREDS" D1_ROUTES_STARBASE=http://127.0.0.1:5190 npx playwright test specs/13-explorer-routes.spec.ts --retries=0)
(cd tests/ui && STARBASE_E2E_CREDENTIALS="$CREDS" npx playwright test specs/11-force-dashboard.spec.ts --retries=0)
```

The hosts layout is the production shape: two tailnet hostnames mapped to loopback in the test browser, HTTPS
with a throwaway certificate (made with `openssl`), a Secure session cookie. Restart the preview with
`D1_PREVIEW_ENV_FILE=tests/ui/starbase/preview-hosts.env D1_PREVIEW_PUBLIC_URL=https://d1-server.tail54eeb6.ts.net:18443`
(same name, port and overlay), restart `vite preview` with
`STARBASE_D1_ORIGIN=https://d1-server.tail54eeb6.ts.net:18443`, then run spec 14 with `STARBASE_E2E_MODE=hosts`.
The spec starts its own HTTPS proxies on 5191 and 18443. Spec 14 turns Playwright's trace off: FAST's plot page
lists 10,000+ runs and the trace snapshots stall it.

## Ad-hoc verification scripts

The `verify_*.mjs` files are standalone Playwright scripts, each written to check one feature
while it was being built. Run them from the repo root (`node tests/ui/verify_<name>.mjs`): they
print what they find and save screenshots to `tests/ui/` (git-ignored), and about half also exit
non-zero when a check fails. Most target the force-app dev server (`http://localhost:5180`,
`npm run dev -w force-app-web`). They are not
part of `npx playwright test`.

## Prerequisites

- The full stack is up (`docker compose up -d`) and Directus is reachable at
  `http://localhost:8055`.
- `scripts/configure_directus.sql` has been applied and Directus restarted
  so the latest field config is served.

## Run

```bash
cd tests/ui
npm install                  # first time only
npx playwright install chromium   # first time only
npx playwright test          # run everything
npx playwright test 01-mfg   # run one spec
npx playwright show-report report   # open the HTML report
```

### Config / credentials

Overridable via env vars (defaults in parentheses):

- `D1_BASE_URL` (`http://localhost:8055`)
- `D1_ADMIN_EMAIL` (`admin@example.com`)
- `D1_ADMIN_PASSWORD` (**required**, no default: use the `DIRECTUS_ADMIN_PASSWORD` from your `.env`;
  the specs throw a clear error when it is unset)

Each test logs in fresh via the `fixtures.ts` `page` fixture. We deliberately do
**not** share one stored session: Directus rotates refresh tokens, so a session
shared across browser contexts gets invalidated when the first context refreshes
it (which silently logged out later tests and made the suite flaky).

## Notes

- Typed parameters are **inline columns** on `test_sessions` /
  `manufacturing_operations` (prefixed per type, e.g. `hardness_load_gf`),
  conditionally shown by the scalar discriminator (`test_type` /
  `process_category`). They were flattened out of the old per-type param tables
  by `db/migrations/20260623000032_inline_param_fields.sql` +
  `scripts/flatten_param_fields.py`. Directus field conditions do **not**
  evaluate against the `method_id` M2O relation — hence the scalar
  `process_category` (migration 031).
- Run order after a config change: `configure_directus.sql` **then**
  `scripts/configure_inline_params.sql` (the latter registers the inline fields
  and is idempotent).
- After changing `configure_directus.sql`, always restart Directus
  (`docker compose restart directus`) before re-running, or the UI serves stale
  field metadata. Directus caches it in memory, not in Redis; do not `FLUSHALL`
  Redis, which holds the worker job queues.
- `report/`, `test-results/`, `artifacts/`, `.auth/`, and `node_modules/` are git-ignored.
