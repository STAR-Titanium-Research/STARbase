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

## STARbase end to end (spec 14; specs 11 and 13 run here too)

Needs the `d1-starbase` preview and STARbase served by `vite preview` (the production CSP). Specs 11 and 13
(STARbase's Force plotter and the Explorer pages) have no Directus-only mode any more, so run them with this
same setup; the last two commands below cover them. From the repo root:

```bash
npm run build:extensions && npm run build -w starbase-web
# ports layout: STARbase http://127.0.0.1:5190, Directus http://127.0.0.1:18057 (one host, plain HTTP)
D1_PREVIEW_NAME=d1-starbase D1_PREVIEW_PORT=18057 D1_PREVIEW_ENV_FILE=tests/ui/starbase/preview-ports.env \
  D1_PREVIEW_OVERLAY="d1-admin-overview d1-usage d1-campaign-ops d1-lab-dashboard d1-project-items d1-edit-frame d1-links d1-report" \
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
  (after a Redis flush) so the latest field config is served.

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
- After changing `configure_directus.sql`, always flush Redis
  (`docker exec d1-database-redis-1 redis-cli FLUSHALL`) and restart Directus
  before re-running, or the UI serves stale field metadata.
- `report/`, `test-results/`, `artifacts/`, `.auth/`, and `node_modules/` are git-ignored.
