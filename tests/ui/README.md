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
| `03-sample-geometry-preview` | Physical Sample form: the custom **Shape Preview** interface draws a live SVG from Geometry + dimensions, including the cylinder, round bar (Ø + length) and bar shapes. |
| `04-project-investigators` | Project form: the **Secondary Investigators** M2M field and its access-notice are present. |
| `05-detail-pages-load` | Regression: opening an **existing** record (samples/projects/operations/sessions) returns the form, not a 500 / "Page Not Found". Catches alias fields missing `no-data` and M2M junctions whose tables don't exist. |
| `06-machine-filter` | Machine picker (`d1-machine-picker`): an operation or test offers only equipment capable of its process/test category, tiered by facility. |
| `07-inventory-conditional` | Inventory form: sample-only fields and per-geometry dimensions (incl. round bar and tensile-coupon gauge fields) show or hide by item type and geometry; the Shape Preview renders. |
| `08-operation-code-autogen` | Manufacturing Operation: the operation code composes live from sample, sub-type, pass and cutting parameters, and a manual edit is kept. |
| `09-campaign-inheritance` | Campaigns: a new operation inherits project, owner and equipment from its campaign (the `campaign-inherit` hook), and the form fills the project live. |
| `10-ask-db-chat` | **Ask the Database** module: a stubbed proxy response renders the SQL block, result table, and Plotly chart; the `/d1-ask/chat` endpoint rejects unauthenticated requests (401) and passes the auth gate for a logged-in session. A live end-to-end smoke runs only with `D1_LLM_LIVE=1`. |
| `11-force-dashboard` | Force Analysis module: sample → operation drill-down, signal charts and the per-axis FRM, including the Figure ⇄ Lite switch. Needs at least one processed `machining_force_analysis` row. |
| `12-force-crawler` | Force Crawler module: status, queue stats, settings and activity read from and written to `force_crawler_state`. |

## Ad-hoc verification scripts

The `verify_*.mjs` files are standalone Playwright scripts, each written to check one feature
while it was being built. Run them from the repo root (`node tests/ui/verify_<name>.mjs`): they
print what they find and save screenshots to `tests/ui/` (git-ignored), and about half also exit
non-zero when a check fails. Most target the force-app dev server (`http://localhost:5180`,
`npm run dev -w force-app-web`); the FAST and force-dashboard ones target Directus. They are not
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
