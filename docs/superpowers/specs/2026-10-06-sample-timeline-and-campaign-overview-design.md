# Sample timeline and campaign overview

**Date:** 2026-10-06
**Status:** Implemented (stream M of the 2026-10-06 larger-UX-items batch; UX review rows D5 and D11). Code: `core/extensions/d1-trace/`, `d1-lab-dashboard/src/views/SampleTimeline.vue`, `d1-campaign-ops/src/CampaignOverview.vue` and `overview.js` (since the Explorer pages, the roll-up and panels live in `packages/d1-ui/src/campaign/`, `rollup.ts` and `CampaignWorkbench.vue`; the rules below are unchanged).
**Scope:** `d1-lab-dashboard` (Sample dashboard), a new `d1-trace` endpoint extension, and
`d1-campaign-ops` (campaign form panel). No schema change.

## Why

- **D5.** Postgres already answers "where did this sample come from and what happened to it"
  (`f_trace_ancestors`, `f_trace_descendants`, `f_trace_stock_origins`, `f_sample_timeline`, in
  `20260619000014_traceability.sql`), but the only way to see the answer was SQL or the report.
  `plan.md` deferred the UI. The Sample dashboard shows operations and tests as two separate lists
  and says nothing about lineage.
- **D11.** `CampaignOps.vue` lists a campaign's operations and nothing else. A campaign's real
  question, "which samples are in it, what has been cut and tested, and has the force data been
  analysed", needs five tabs today.

## D5: options

1. **Browser composes it from `/items` calls.** Permission-safe by construction, but the ancestor
   and descendant walks are recursive, so it is N round trips per generation, and it cannot
   reproduce the cycle guard. Rejected.
2. **Call the functions from the browser** (a Directus flow or a view). The functions are
   `STABLE` SQL run as the database owner, so they ignore Directus permissions and would leak
   samples a role cannot read. Rejected on its own.
3. **Endpoint runs the functions, then filters through Directus permissions.** One round trip,
   one correct recursion, and every record is checked against the caller's role. **Chosen.**

## D5: decision and data flow

A new endpoint extension `d1-trace` (same conventions as `d1-next-number`) mounted at
`GET /d1-trace/sample/:id`.

1. **Auth.** No signed-in user: 401. Signed in without app access (and not admin): 403. `:id` must
   be a UUID: 400.
2. **Root check.** Read the sample through `ItemsService('physical_samples', { schema,
   accountability: req.accountability })`. Not readable or not present: the same 404, so existence
   is not revealed.
3. **Find the related records.** Four queries over the functions, in one transaction with
   `SET LOCAL statement_timeout = 8000`, on the shared `database` knex (they bypass permissions,
   which is why step 4 exists). The functions return one row per *path*, so the queries collapse
   them in SQL: ancestors and descendants `GROUP BY sample_id` (shallowest depth, plus the distinct
   steps each sample was reached from), stock origins `GROUP BY (via sample, lot)`, events newest
   first. Each has `LIMIT 501` and is flagged `truncated` if cut: the 500 *nearest* relatives, the
   500 *newest* events (undated events are dropped first, and the list is shown oldest first).
   **Limit:** the recursion inside the functions still enumerates every path (a ladder of N
   diamonds has 2^N), and a `GROUP BY`/`LIMIT` outside cannot stop that. Measured on Postgres 16
   with a 24-level ladder: not finished after two minutes and over 10 GB of temp files. The timeout
   is therefore the guard; a cancelled query is a 503 "too large to trace". Fixing it properly
   means making the functions walk nodes rather than paths (a new migration, out of scope here).
4. **Permission filter.** Every value in the response is read through
   `ItemsService.readByQuery` with the caller's accountability and `fields: ['*']`, never taken from
   the SQL rows: `physical_samples`, `manufacturing_operations`, `test_sessions` and
   `raw_stock_lots` by primary key, and `sample_genealogy` (relationship type, fraction) and
   `sample_stock_provenance` (mass used) by their composite key pairs. Directus applies the role's
   item filters and field rules, so a record comes back only if the caller can read it, and a field
   the role cannot read is absent from it (output `null`). (`'*'` rather than an explicit field list
   because Directus refuses the whole read if a listed field is restricted.) Records not returned
   are dropped and counted once each; a forbidden `sample_genealogy` or `sample_stock_provenance`
   just means no relationship type, fraction or mass.
5. **Response.** `{ sample, stock_origins, ancestors, events, descendants, hidden: {...counts},
   truncated }`. Each sample appears once however many routes lead to it. An ancestor or
   descendant is marked `through_hidden: true` only when *every* route from the root passes an
   unreadable sample (checked by walking the reachable graph over readable samples only), so the UI
   can show a gap marker instead of implying a direct link; its relationship type and fraction are
   then `null`, since they would describe an edge to the hidden sample. A stock lot reached through
   such an ancestor carries `through_hidden` too. Under truncation the marker is conservative (a
   relative whose route lies beyond the cut may read as hidden). The path arrays are never sent.
   Errors are Directus-shaped (`{ errors: [{ message, extensions: { code } }] }`) so the panel
   shows their text: 400, 401, 403, 404, 500 and 503.

What the endpoint passes on is limited to identifiers, the sample code and form, relationship type,
fraction, operation pass code, sequence and date, test type, status and date, and the lot's code,
type, supplier and mass used. Operator names and file pointers are never selected or passed on.

**UI.** A "Timeline" tab beside the sample detail on `SampleDashboard.vue` renders: stock lots,
ancestors (oldest first), this sample, its operations and tests by date, then descendants. Every
node is a `router-link` to `/content/<collection>/<id>`. Hidden items collapse into a single
"N items not visible to you" line per section. Loading, empty and error states are explicit; a
latest-request-wins gate drops stale responses.

## D11: options and decision

Schema check (`20260628000047_campaigns.sql`, `20260710000087_campaign_redesign.sql`):

- `manufacturing_operations.campaign_id` and `test_sessions.campaign_id` are direct FKs, so a
  test session can be added to or removed from a campaign by patching `campaign_id`, exactly as
  the existing operations manager does.
- `campaign_samples (campaign_id, sample_id)` is a many-to-many junction, so samples are added by
  creating a junction row and removed by deleting it.
- Force-analysis status lives on `machining_force_analysis` (one row per operation file):
  `status` (`pending|processing|done|error|skipped`, the crawler/orchestrator queue) and
  `diag_status` (`null|pending|processing|done|error`, the Diagnostics build).
- - `test_sessions.status` is the lifecycle from `20260619000013_status_vocabulary.sql`:
  `registered | pending_processing | processing | processed | analysing | analysed | failed`
  (the old `complete` no longer exists). **Decision:** a test counts toward "Tests complete" when it
  is `processed` or `analysed` (its data has been through the heavy-data worker; analysis is an
  optional later step). The status chips list every status in lifecycle order.
- An operation can have several force files. The roll-up is worst first (`error > processing >
  pending > done > skipped`). For diagnostics a file with a null `diag_status` is unbuilt, so an
  operation is "built" only when every file is. Operations whose files are all `skipped` are left
  out of the progress denominators (they are deliberately not analysed), so the bars can reach 100%.
- There is **no planned count** on `campaigns` (only `status`, dates and notes), so progress is
  shown as "operations with a completed analysis out of operations", not "done vs. planned".

The panel's data comes from the browser via `useApi` (`/items/...`), so the signed-in user's
permissions apply and no new endpoint is needed. Decision: add an **Overview** section above the
existing operations manager with:

- counts: samples, operations, test sessions, and test sessions by status, with a "Tests complete"
  bar (`processed` + `analysed`);
- a per-sample table: code, operations count, tests count, with links to the sample;
- a per-operation list: pass code, sample, force-analysis `status` and `diag_status` badges (with
  the error text on hover), and a progress bar "analysed n / m" (`status = done`) with a second
  count for diagnostics built;
- "Add samples" and "Add test sessions" pickers (search, click to add, remove chips), because
  both links exist in the schema. Testing campaigns primarily use the test-session picker and
  machining trials the operations picker, but all are offered for every type (an imaging campaign
  may have samples only).

Queries use `limit: -1` per campaign, which is bounded by the size of one campaign.

## Out of scope

- A planned-operations count or a progress target (would need a column).
- Filtering the timeline by date or type, or exporting it. The report already prints a sample's
  life.
- Gantt-style visualisation; the first version is a vertical list.
- Changing the Campaign form's native `samples` M2M widget (it stays, hidden or not, as is).
- A project-level overview (P10 covers diagnostics across a campaign separately).
