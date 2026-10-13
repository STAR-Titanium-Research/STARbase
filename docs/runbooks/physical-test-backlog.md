# Physical test backlog

Checks that cannot be done in a cloud session or in CI. Each one needs a running Directus (the
local Docker stack with real data), the force-capture rig (NI-DAQ chassis, Lab Amp, packaged
Windows app), or `d1-server`. Code for every item below is merged and unit-tested; what is missing
is the confirmation on the real thing.

**This is a running list.** Any change whose PR says "not tested on real systems" adds its checks
here in the same PR (see `CLAUDE.md`). When you run a check:

1. Tick it (`[x]`), and add the date, who ran it and the result after the item, e.g.
   `— 2026-10-12, DP: OK` or `— 2026-10-12, DP: FAIL, see #131`.
2. If it fails, open an issue and link it; leave the box unticked until the fix is checked too.
   An issue is closed once its fix ships in a release, so its item here is what is left: if the
   check fails, reopen that issue rather than opening a new one.
3. Move fully ticked sections to **Done** at the bottom once a month or so, so the open list stays
   short.

**Running items from GitHub (rig test requests).** An item on this list can be run on the rig
without a rig day: open an issue, put a `rig-test` block in it listing the item ids, and label it
`rig-test-request`. The force app on the rig asks the operator, runs the item and comments the
result on the issue. See the
[spec](../superpowers/specs/2026-10-11-rig-test-requests-design.md). The app reads the items
from the copy of this file built into its release, so a request can only name items from that
version. Give every new rig item (§B) a bold id at the start (`**R12 — …**` or `**#240 …**`). From
phase 2 on, also add a `rig-test` step block after the item's prose. Until then, the app shows
an item's prose to the operator as one Pass/Fail/Skip question. A request's block is a fence
tagged `rig-test` containing, for example, `items: [R4, "#185"]`. No example fence is written
here, because the app parses this file.

Item ids are the UX review's (`docs/reviews/2026-10-05-ux-utility-review.md`) or the GitHub issue
number. "Since" is the PR that shipped the code.

## A. Live Directus (local stack with real data)

Start with `make up` and apply migrations (`make migrate`); on a stack that already has its Directus
configuration the migrations carry every metadata change, so there is nothing else to apply. Flush Redis and restart Directus so new
extensions load (`docker exec d1-database-redis-1 redis-cli FLUSHALL`, then
`docker restart d1-database-directus-1`), then sign in as each role named in the step.

> **Do not run `scripts/configure_all.sh` or `scripts/configure_directus.sql` on a database that
> already has migrations applied.** They delete and re-insert the field metadata of whole collections
> and silently undo what later migrations added. That happened on the live database between
> 2026-07 and 2026-09 and cost the inline parameter fields, repaired by migration
> `20261009000143_restore_inline_param_field_meta`. They are for a brand-new Directus only, or a
> scratch database you can throw away.

### Permissions and migrations
- [ ] **Migrations 133–135 on a real Directus database** (not the CI stub tables). `dbmate up`
  applies cleanly; `dbmate down` three times then `up` again. Since #123/#125.
- [ ] **X2 — a Lab Member can save a cut.** Sign in to the Force App as a Lab Member, record a sim
  cut, save with upload. Expect: the operation row, both files and the `machining_force_analysis`
  row are created; no 403. Then open that cut's live cache in Force Analysis. Since #123.
- [ ] **Configure script keeps migration grants.** Run `scripts/configure_users_and_policies.sql`
  twice; repeat the Lab Member save above. Since #123.
- [ ] **Lab Member file reads.** Confirm a Lab Member can open colleagues' live caches but note what
  else `/assets/<id>` exposes (equipment images, admin uploads). Feeds the Phase 9 export-control
  decision (ADR-0005). Since #123.

- [ ] **P10 — Diagnostics picker as a Lab Member.** Sign in to the Force App as a Lab Member and open
  Diagnostics: the list loads; campaign grouping is shown if the role can read `campaigns`, and
  otherwise *Group by* offers Sample only (no empty list). Note which it was; if Lab Member cannot
  read campaigns and the lab wants them, add the read grant by migration. Since #127.

### Sample numbers, dashboards, saved filters
- [ ] **D9 — next sample number.** `GET /d1-next-number/sample` returns a number when signed in,
  401 signed out, 403 for a user without app access. The Register-sample page and the sample-code
  interface show the same preview; a Lab Member whose role hides some samples still gets the true
  next number. Since #123.
- [ ] **D7 — dashboard links.** Every "Open in Directus" link on the Sample, Machining and FAST
  dashboards opens the right record. Since #123.
- [ ] **D12 — saved filters.** In Operations, Tests and Samples, the seven bookmarks appear for
  every role. "My operations"/"My samples" show only records whose owner person is linked to the
  signed-in user. "FAST runs, last 7 days", "Missing outcome", "Failed", "Needs analysis" and "No
  location" match a hand count. Each bookmark exists once (`SELECT bookmark, count(*) FROM
  directus_presets WHERE "user" IS NULL AND role IS NULL GROUP BY 1`). Migration
  `20261006000135_saved_filter_bookmarks` creates them; do not re-run `scripts/configure_directus.sql`
  to check this on a migrated database, it wipes field metadata (see the note at the top of section A).
  Since #125.

### Ring form (migration 162, `feat/ring-form`)
- [ ] **Ring in the record form.** Open a sample in Directus and pick Geometry → Ring. Ø, Ø Inner,
  width and thickness show; length and gauge fields hide. Round bar is in the dropdown again. The
  geometry preview draws a disc with a bore marked `Ø<inner>`. An inner Ø ≥ the outer Ø is refused
  on save (`physical_samples_inner_diameter_mm_check`).
- [ ] **Ring on the Register-sample page.** Pick Ring. The four dimension inputs appear, the
  drawing shows the bore, and the saved sample keeps `inner_diameter_mm`.
- [ ] **Ring on the Sample page and label.** The ring's Sample page shows `Ø… · ID… · t… · W… mm`,
  the drawing has the bore, and the mass estimate is π/4·(OD² − ID²)·t × density. The printed
  sample report lists `ID…` after the outer Ø.

### Ask-DB
- [ ] **D1/D2 — chips and messages.** The five example chips run and answer. A query returning more
  than the row limit shows "Showing the first N rows". Stop the `llm-text-to-sql` container: the
  chat says the model is unreachable. Set a wrong `WORKER_WEBHOOK_SECRET` in Directus: the chat
  says the server is misconfigured (not "sign in again"). Since #123.
- [ ] **D3 — export and history.** Download CSV opens cleanly in Excel (BOM, no formula runs from a
  cell starting with `=`). Copy SQL works on the plain-http host. Two users signing in one after
  the other in the same browser see only their own Recent and Saved questions. Since #124.

### Sample labels and QR
- [ ] **D4 — label sheets.** From a sample form, "Print label" and "Print several labels"; from Home,
  the "Print labels" tile. Print the A4 sheet on L7160 (63.5 × 38.1 mm, 21-up) and one 50 × 25 mm
  label: text and QR sit inside each label, the `start` offset skips used labels. Since #124. **Superseded by the Explorer labels page (PR #247).**
- [ ] **D4 — scan to open.** Scan a printed QR with a phone on the lab network: it asks to sign in,
  then opens that sample's record. Nothing is visible without signing in. Since #124. **Superseded by the Explorer labels page (PR #247).**
- [ ] **D4 — permissions and dates.** A role that cannot read a sample gets "not found" for it in a
  label request. With `D1_TIMEZONE=Europe/London` set, a sample created just after midnight BST
  prints the right date. The picker shows "(200 of N)" when there are more than 200. Since #124. **Superseded by the Explorer labels page (PR #247).**
- [ ] **#247-L1 — Label templates — own rows.** As a Lab Member, create a template in
  `label_templates`: it saves. Update and delete it: allowed. Another member's template (and the four
  seeds) can be read but not updated or deleted.
- [ ] **#247-L2 — Label templates — seeds and Default.** A Lab Member cannot edit a seed
  template, and the Default toggle (`is_default`) is not offered or not saved for them.
- [ ] **#247-L3 — Label templates — owner is forced.** After a member creates a template,
  `user_created` is that member, whatever the request body said.
- [ ] **#247-L4 — Label templates — Lab Admin.** A Lab Admin can create, edit, delete and
  set Default on any template, including the seeds.
- [ ] **#247-L5 — Label templates — permissions apply.** After the migration, flush Redis
  and restart Directus: the rules above then hold, with no 403 on reading `label_templates`.

### Plot dashboard inside Directus
- [ ] **P3 — links in the Directus module.** "Copy link" in the Directus-hosted Plot opens the same
  view in another browser. Check the browser's network tab: changing the view does not flood
  `PATCH /users/me/track/page`. Since #124.
- [ ] **P11 — loading orb in the Directus Plot.** In the Directus-hosted Plot, load a cut in Figure,
  Lite and Full: the FRM loading overlay shows the red/green/blue orb (Directus has none of the force
  app's colour tokens, so it uses the built-in fallbacks); the other Plot spinners stay Directus's own.
  Since the loading-orb PR.
- [ ] **P2 — PNG export in Directus.** "Save chart as PNG" and "as SVG" download a correct image
  (Directus's CSP allows the `blob:` image used for the PNG). Since #125.

### No-.mat force analyses (#190)
- [ ] **Plot dashboard with a no-.mat cut.** Open a Force App cut uploaded over the recorder's .mat
  size limit (its analysis row has no `directus_files_id`). Charts render from `series`, the saved
  crop is applied, Bake is disabled with the "needs the archive .mat" explanation, and Apply and
  Clear still work. Directus returns `directus_files_id` as null (not `{}`) for it. Since #198 (0.1.35).
- [ ] **Recrawl leaves no-.mat rows alone.** On the force crawler panel, "Recrawl all" and
  "Recrawl matching" don't touch rows with no `directus_files_id`. Since #198 (0.1.35).

### Sample timeline and campaign overview
- [ ] **D5 — timeline on a real sample with genealogy.** Restart Directus so `d1-trace` and the
  rebuilt Lab Dashboard load. Lab Dashboard > Samples > pick a sample that has a parent, a child, a
  raw stock lot, operations and tests > **Timeline** tab. Expect: stock lot, ancestors (oldest
  first), the sample, operations and tests in date order, then descendants, matching
  `SELECT * FROM f_sample_timeline('<id>')` and the `f_trace_*` functions run by hand. Every entry
  opens its record. `GET /d1-trace/sample/<id>` is 401 signed out, 403 for a user without app
  access, 400 for a bad id. Since #127.
- [ ] **D5 — hidden items for a restricted role.** Sign in as a role whose item filter hides some
  of that sample's relatives, operations or tests. Expect: the Timeline shows only what the role can
  open, with "N items are not visible to you" lines where something was dropped; no code, id or
  operator of a hidden record appears in the JSON of `/d1-trace/sample/<id>`; a sample the role
  cannot read gives "not visible to you" (404). Field level: give the role a field rule that hides
  `form` (samples), `pass_code` or `operation_date` (operations), `status` (tests), `supplier_name`
  (lots), `fraction` or `mass_used_grams` (genealogy, stock provenance): the JSON has `null` for
  that field and the Timeline shows the record without it. A role with no access to
  `sample_genealogy` still sees the relatives, just without relationship type or fraction. A raw
  stock lot reached through a hidden ancestor reads "via a sample you cannot see". Since #127.
- [ ] **D5 — diamond genealogy and a huge genealogy.** On a sample whose ancestors merge (two
  parents that share a grandparent) each sample appears once in the Timeline and the counts match
  `SELECT count(DISTINCT sample_id) FROM f_trace_ancestors('<id>')` minus the sample itself. On a
  real database, time `GET /d1-trace/sample/<id>` for the sample with the largest genealogy: it
  answers within the 8 s limit, or with "this sample's genealogy is too large to trace" (503)
  shown in the tab; either way Postgres is not left running the query (`pg_stat_activity`). Since
  migration 136 the functions walk samples, not paths, so the 503 should no longer happen (the 8 s
  deadline stays as a safety net; see the next item). With more than 500 ancestors, descendants
  or events the tab says only the nearest 500 relatives / newest 500 operations and tests are
  shown. Since #128.
- [ ] **Genealogy functions on the deepest real genealogy (migrations 136 and 137, f_trace_*
  visit each sample once, parent index).** Before deploying, as a restricted role, note the
  `hidden` counts and `through_hidden` flags from `GET /d1-trace/sample/<id>` for a sample with a
  diamond genealogy (two parents sharing a grandparent). After deploying, on the real database
  find the sample with the largest genealogy (most rows when walking `sample_genealogy`, or the
  deepest chain). Run `SELECT count(*), max(depth) FROM f_trace_ancestors('<id>')` and the
  descendants one, and `GET /d1-trace/sample/<id>` (and the Timeline tab). Expect: each answers
  in well under a second with `count(*) = count(DISTINCT sample_id)`, and the diamond sample's
  hidden counts and flags are as noted. To compare with the old definitions, do it on a restored
  copy, never on the live database: there, create the old bodies from the `-- migrate:down`
  section of `20261006000136` under other names (`old_trace_ancestors` / `old_trace_descendants`),
  and, if the genealogy is small enough for path enumeration, check that the distinct
  `sample_id`s and `min(depth)` per sample match. Since #128.
- [ ] **D11 — campaign overview counts.** Open a machining trial and a testing campaign that have
  real data. Expect: sample, operation and test-session counts equal a hand count in the
  collection lists; "Force analysed n / m" equals the machining operations whose
  `machining_force_analysis` rows are all `done` (operations whose files are all `skipped` are not
  counted, and "Diagnostics built" needs every file built); the per-operation force-analysis and diagnostics
  badges match the Force Analysis page, and an `error` badge shows the message on hover. As a role
  that cannot read `machining_force_analysis`, the force columns show "—" and a note, not an error.
  "Tests complete n / m" counts test sessions whose status is `processed` or `analysed` (compare
  with a status filter on the Test Sessions list), and the status chips use the real vocabulary
  (`registered`, `pending processing`, `processing`, `processed`, `analysing`, `analysed`,
  `failed`). Since #127.
- [ ] **D11 — pickers.** In a campaign, add a sample by code, then a test session that is in no
  campaign: each appears in the overview, the counts rise, and the test session shows the campaign
  in its own form. Remove both again. A sample that only appears through an operation is marked
  "not in list" and its + button adds it. Also add and remove an operation and check the overview
  reloads. Race checks, with the campaign open in two browser tabs: add the same test session in
  both, the second gives "already in another campaign" (not an error from Directus) and the
  session stays in the first campaign; add the same sample in both, the second just reloads with no
  error. The batch `PATCH /items/test_sessions` answer lists the changed row for a role that may
  read test sessions, so a normal add never shows the "already in another campaign" note. Since #127.

### Explorer pages (Home module)
Restart Directus after `npm ci` and `npm run build:extensions` at the repo root so
the rebuilt `d1-home`, `d1-lab-dashboard` and `d1-composition-bar` load, and apply migrations 138 and 139.

- [ ] **E1 — edit drawer saves through real interfaces.** On a sample page click **Edit**. Expect:
  the drawer shows the same form as Content (sample code builder, material and project pickers,
  geometry preview, linked files), with the record's values. Change the nickname and the form's
  dimensions, press the tick: the drawer closes, the page shows the new values and the geometry
  drawing redraws. Change a field through a custom interface (pick another material or machine)
  and save: it is stored (check the Content form and Revisions). Press Cancel after an edit: a
  "Discard your changes?" dialog appears. Check that `v-form` and `useFieldsStore` really are
  available: if the drawer never opens and the browser goes to the Content form instead, that is
  the guard in `EditDrawer` firing, and the spec's Editing section needs revising. Since: Explorer
  pages E1 (PR pending).
- [ ] **E1 — edit conflict and errors.** Open **Edit** on a sample, then change the same sample in
  another tab (any field) and save it there. Back in the drawer, change a field and save: a warning
  says someone else saved, with **Discard mine and reload** and **Save anyway**; both work. Clear a
  required field (the sample code) and save: the Directus error text shows in the drawer and
  nothing is saved. As a role that may not update samples: the save error is shown, not a blank
  drawer. Since: Explorer pages E1 (PR pending).
- [ ] **E1 — landing module after login.** Sign in as a Lab Member and as an admin from a fresh
  browser session. Expect: Home is the first icon on the module bar, Content (the Data Studio)
  follows the three dashboards. Note which page the app opens after login: Home (first module) or
  Content. If it is Content, Directus does not land on the first module; the spec's "app.after
  redirect" is then a follow-up decision. Check that a bar curated in Settings > Appearance that
  already listed Home keeps it, first. `dbmate down` removes Home and moves Content to the front.
  Since: Explorer pages E1 (PR pending).
- [ ] **E1 — module bar order.** After migration 138 the bar reads Home, User Directory, File
  Library, Insights, Lab Dashboard, Force Analysis, FAST Analysis, Content, Settings (for a bar
  that had the shipped order), and every icon still opens its module. On a fresh install
  (`scripts/configure_all.sh`) the same order is created. Since: Explorer pages E1 (PR pending).
- [ ] **E1 — Sample page on real data.** Open `/admin/home/samples/<id>` for a sample with a parent,
  children, a raw stock lot, machining and FAST operations, tests and linked archive files. Expect:
  the header (code, nickname, status, project and campaign links, owner), the geometry drawing at
  the right proportions, the material's composition bar equal to the material form's, a measured
  mass or an "estimated" one, the life strip in the right order (stock, parents oldest first, this
  sample centred, operations and tests by date, children) with every item a link, **View forces** on
  machining operations and **View FAST** on sintering ones opening the right run, and the file
  rows' copy-path buttons giving the same paths as the sample form. Narrow the browser below
  ~640 px wide (or open the page in a split view): the strip becomes a vertical list. **Print
  label** opens the labels page in the same tab with this sample ticked (see the labels items below) and **Report** opens in a new tab. Operations and tests that you click open their
  Explorer pages (see the E4 items below). Dark theme: the page is readable. Since: Explorer pages E1 (PR pending).
- [ ] **E1 — Sample page with hidden relatives.** As a role whose item filter hides some of that
  sample's relatives, operations or tests, open the page. Expect: the life strip shows only what
  the role can open, with dashed "N not visible to you" markers where something was dropped (and
  "via a sample you cannot see" on a relative reached only through a hidden one); the Operations
  and Tests tables show only readable rows. A sample the role cannot read, and a made-up id, both
  show "Not found or not visible to you" with a link back to Home. Since: Explorer pages E1 (PR
  pending).
- [ ] **E1 — links from Home and the dashboards.** On Home, the recent-activity sample cards and, in
  the Lab Dashboard, "Open sample" and the timeline entries open the Sample page; operation and test
  links open their Explorer pages (E4).
  FAST runs on Home still open the FAST dashboard. Since: Explorer pages E1 (PR pending).

#### Campaign page (E2)
- [ ] **E2 — Campaign page on a real campaign with force data.** Open `/admin/home/campaigns/<id>` for
  a machining trial whose operations have force files in several states (done, pending, an error,
  one with every file skipped, one with several files for one operation). Expect: the header shows
  code, name, type, project breadcrumb, owner, status, dates and, where set, default equipment and
  material; the tiles and bars equal the D11 hand counts above; in the matrix each operation cell's
  colour matches the worst of its files (`error > processing > queued > analysed > skipped`), the
  corner dot matches the Diagnostics state, hovering an error cell shows the real
  `error_message`, and clicking any cell opens that operation (or test) page. Samples are in
  natural order, a sample with no operations is an empty row, and a sample that only appears
  through an operation shows the "not in list" icon. A testing campaign shows one column per test
  type with the session status colour. As a role that cannot read `machining_force_analysis`, the
  page loads, operation cells show no state, and a note says why. A made-up id, and a campaign the
  role cannot read, show "Not found or not visible to you". Since: Explorer pages E2 (PR pending).
- [ ] **E2 — pickers on the page and on the Data Studio form.** On the page add a sample by code, a
  test session that is in no campaign, and an operation (a machining trial only offers machining
  operations); each appears in the lists and the matrix, the counts rise, and the matrix gains a
  column or row. Remove each again. Repeat on the campaign's Data Studio form (the panel there is
  the same component, without the matrix) and check the page reflects the change after a reload.
  Check the race cases of the D11 pickers item still behave. Since: Explorer pages E2 (PR pending).
- [ ] **E2 — Edit drawer on a campaign.** *Edit* opens the campaign's own form with the owner,
  project and type fields working, and without the operations panel (it is already in the page
  body); saving refreshes the header. Since: Explorer pages E2 (PR pending).
- [ ] **E2 — matrix with 50+ samples.** Open (or build in a scratch project) a campaign with 50 or
  more samples and 10 or more steps. Expect: the page renders in a second or two, the matrix scrolls
  sideways and down with the sample column and the column headings staying in place, the legend is
  readable in the light and dark themes, and the sample and operation lists show the first 200 rows
  with a note when there are more. Since: Explorer pages E2 (PR pending).

#### Projects and Home (E3)
- [ ] **E3 — Home for a user with a people row.** Sign in as a Lab Member whose `people` row has
  `user_id` set, who is PI of one project, investigator on another, owns a campaign and owns and
  co-owns samples. Expect: *My projects* lists both projects, *Campaigns I own* the campaign, *My
  latest samples* the ten most recently updated samples they own or co-own (compare with the Data
  Studio *My samples* bookmark plus a `co_owners` filter), no "not linked" notice. Since: Explorer
  pages E3 (PR pending).
- [ ] **E3 — Home for a user without a people row.** Sign in as a user with no `people` row. Expect:
  the notice that the login is not linked to a person record, empty owned lists, and projects
  where they are PI (none, since PI is a people row) or samples they co-own still shown; no error
  banner. Also as a role that cannot read `project_investigators` or `sample_co_owners`: the lists
  fall back to ownership only with a one-line note, never a blank Home. Since: Explorer pages E3
  (PR pending).
- [ ] **E3 — needs-attention counts match Data Studio filters.** Compare each Home tile with the
  same filter in the Data Studio: *Failed test sessions* equals the *Failed* bookmark on Test
  Sessions; *Force analysis errors on my operations* equals Manufacturing Operations filtered by
  owner = you and Force Analyses (`force_analyses`) any status = error; *Operations with force
  files still pending* the same with status = pending; *Samples with no owner* (admin only) equals
  Samples with Owner empty. Click each tile: the list under the tiles shows up to 10 records that
  open their Explorer pages, and "Open the full list" opens the collection. Check that the
  `$CURRENT_USER` filter resolves from the browser (the tile for your own operations is not 0 when
  an owned operation has an errored force file). The *Samples with no owner* tile must be absent
  for a Lab Member and present for an admin: if it is missing for an admin, the admin flag is not
  where `home.vue` looks (`userStore.isAdmin`, `currentUser.admin_access`). Since: Explorer pages
  E3 (PR pending).
- [ ] **E3 — Projects index.** Open `/admin/home/projects` (Home > *All projects*). Expect one card
  per readable project, with the campaign and sample counts equal to the Data Studio lists filtered
  by project, the PI name, and "You are PI" / "You are investigator" badges that match the project
  form. *My role* (PI, investigator, either), *Status* and the code/name search narrow the cards.
  Since: Explorer pages E3 (PR pending).
- [ ] **E3 — Project page.** Open a project with campaigns and loose records. Expect: tiles equal
  hand counts, each campaign card's counts and progress bar (force analysed n / m for a machining
  trial, tests complete n / m for a testing campaign) agree with the campaign's own page, the
  "not in a campaign" lists contain exactly the project's records with no campaign, *Equipment
  used* lists the equipment of the project's operations, *Edit* saves through the drawer, and a
  project the role cannot read shows "Not found or not visible to you". For a role that cannot
  read `machining_force_analysis`, `project_investigators` or `campaign_samples` only that part
  shows a note. Since: Explorer pages E3 (PR pending).
- [ ] **E3 — sparkline on real data.** On the index and on a project that has work in the last six
  months: the weekly lines match a hand count of operations (`operation_date`) and tests
  (`session_date`) per ISO week (hover a week for its numbers), weeks with nothing are 0, a project
  that spans New Year has no gap, and in dark theme both lines and the dashed test line are
  readable. With more than 5000 operations or tests in 26 weeks the "newest records only" note
  appears. Since: Explorer pages E3 (PR pending).
- [ ] **E3-fix — exact campaign counts, refusals and links.** On a project with campaigns of each
  type (machining trial, testing campaign, imaging / analysis): the cards' operation and test
  counts equal the Data Studio counts filtered by campaign (they come from `aggregate[count]`
  grouped by `campaign_id`, so they stay exact above 5000 rows); the machining trial's *Force
  analysed* bar and the testing campaign's *Tests complete* bar match the campaign's own page;
  the imaging / analysis card shows counts and no bar. As a role that cannot read
  `machining_force_analysis` the machining card says "progress unavailable (no access to the
  data)" and the counts stay. On Home as a role that cannot read `project_investigators` the
  projects list shows its own one-line note, and the samples list shows none unless
  `sample_co_owners` is also refused; a server error (stop Directus mid-load) shows the real error in
  the section, not a silently shorter list. As a role that cannot read `test_sessions` the recent
  activity feed still shows samples and operations, with a one-line note naming tests. In *Needs
  attention*, with more than 10 failed test sessions, the link under "Showing 10 of N" opens the
  Test Sessions list with the *Failed* bookmark applied, and the other tiles say "Open the
  collection in the Data Studio (unfiltered)". Since: Explorer pages E3-fix (PR pending).

#### Operation and Test pages (E4)
After `npm ci` and `npm run build:extensions` at the repo root, restart Directus: `d1-project-items`
and `d1-fast-dashboard` are now built from the root with the other workspace extensions, and
`d1-report` is rebuilt in its own folder (`npm ci && npm run build`).

- [ ] **E4 — parameters per process category on real data.** Open `/admin/home/operations/<id>` for
  one operation of each category you have (machining, FAST sintering, heat treatment, deformation,
  additive, sample preparation). Expect: the Parameters grid shows only that category's fields, with
  the same labels and values as the Content form's panel, the unit after each measured value (the
  field's suffix: mm, rpm, kN, °C ...), select fields by their label (cooling method "Water quench",
  not `water_quench`), toggles as Yes / No, and a very small number readable (not "0"). Fields left
  empty are not listed. An operation with no process category says so. Sample preparation has no
  parameter columns, so it shows the empty line. Repeat for a test of each type you have (tensile,
  hardness, charpy, compression, SEM, XRD, tribology, fatigue, CT ...) on `/admin/home/tests/<id>`.
  Since: Explorer pages E4 (PR pending).
- [ ] **E4 — operation page states.** On a machining operation with several `.mat` files in
  different states: each file shows its Analysis and Diagnostics badges, the error text of a failed
  one, and **View forces** opens the Force dashboard on that operation. On a FAST operation the FAST
  run block shows status, recipe, duration and rows, and **View FAST** opens that run. A sample that
  was cut or sintered shows as Input and, for FAST or additive steps, the new sample as Output with
  working links. Linked files show the same copy-path buttons as the sample form. As a Lab Member
  there is no error about "network-share files". **Edit** opens the operation's Content form in the
  drawer, the category's parameter fields appear, and saving refreshes the page. **Report** opens
  in a new tab. An operation the role cannot read, and a made-up id, show "Not found or not visible
  to you". Dark theme readable. Since: Explorer pages E4 (PR pending).
- [ ] **E4 — real worker summary_stats.** Open a test session that the heavy-data worker and the
  analysis worker have both processed. Expect Results with a "Basic statistics" group (samples,
  sample rate, duration, a Channels table of min, max, mean, std per channel) and an "FFT analysis"
  group (RMS, dominant frequency with Hz, a Top frequencies table, band energy rows), matching the
  JSON in the Content form; a processed-only session shows just the first group. A test still
  `registered` says the workers have not produced results. A test with older flat `summary_stats`
  shows them under "Summary". Since: Explorer pages E4 (PR pending).
- [ ] **E4 — test subject and the Sample page's Tests.** Create a test through the Content form
  (pick the sample in the Subject field, so `sample_id` stays empty). Expect: its Test page shows
  the sample under Subject and in the breadcrumb, and the **Sample page lists the test** under
  Tests (this was missed before E4). A test whose subject is an insert edge shows the edge as a
  link to its Content form. Since: Explorer pages E4 (PR pending).
- [ ] **E4 — QR scan opens the Sample page.** Print a label (Sample page > Print label, or
  `/d1-report/label`) from the rebuilt app and scan it with a phone that is not signed in. Expect:
  the sign-in page, then `/admin/home/samples/<id>` (the Explorer page, usable on a phone). An old
  printed label (encodes `/admin/content/physical_samples/<id>`) still opens the Content form. The
  QR and the sample link on an operation report and a test report open the Explorer pages. Needs
  `PUBLIC_URL` set to an address the phone can reach. Since: Explorer pages E4 (PR pending). **Superseded by the Explorer labels page (PR #247).**
- [ ] **E4 — Force and FAST dashboards land on the Explorer.** In the Force dashboard use the "open
  record" action on an operation and on a sample: both open `/admin/home/operations/<id>` and
  `/admin/home/samples/<id>`, and Back returns to the dashboard. In the FAST dashboard **Open** on
  a run opens the Operation page; opening the recipe still opens its Content form. Since: Explorer
  pages E4 (PR pending).
- [ ] **E4 — project items links and lineage graph.** In a project's Content form, the Project
  items panel shows operation and sample codes as links to their Explorer pages (equipment, tools,
  inserts and materials open their Content forms); as a role that cannot read some of the
  operations, those rows stay plain text and the panel still lists them. On a Sample page,
  **Open lineage graph** opens the Lab Dashboard graph centred on that sample, with its operations,
  tests and neighbours, and reloading the graph URL (`?sample=<id>`) does the same. Since:
  Explorer pages E4 (PR pending).
- [ ] **E4-fix — the subject trigger on real data (migration 139).** Apply the migration to the
  real database (`dbmate up`) and check the back-fill: `SELECT count(*) FROM test_sessions t WHERE
  t.sample_id IS NULL AND EXISTS (SELECT 1 FROM test_sessions_subject s WHERE s.test_sessions_id =
  t.session_id AND s.collection = 'physical_samples')` returns 0 (unless such a subject names a
  sample that no longer exists). Then create a test through the Content form, picking a sample in
  Subject. Expect, for that new test: `sample_id` is filled in the table; it appears in the
  campaign's matrix on the Campaign page (if the sample is in the campaign); the sample report
  (Generate PDF) lists it under tests; the Lab Dashboard lineage graph and the Sample dashboard
  show it; the sample's timeline (`f_sample_timeline`) has its entry; and the Tests panel search by
  the sample code finds it. Add a second sample to the same test: nothing changes in those views
  (only the first sample is primary), but the Sample page of the second sample lists the test.
  Remove the first subject: the second takes over. Changing a subject adds no extra audit row on
  the test besides the one `sample_id` update. Deleting subjects (also migration 139): delete the
  first sample of a test that has two samples. Expect the test to survive, the second sample to be
  its `sample_id` and the Sample page of the second sample to list it. Delete a test's only sample
  in a scratch project: the test goes with it. Try deleting an insert edge that a test lists under
  Subject (or the cutting insert or tool box above it): Directus shows the error "insert edge ...
  is the subject of test ...; remove it from the test first", and after removing the edge from the
  test the delete works. Back-fill on a real database (E4-mig2, same migration, so before it is
  applied): list tests whose `sample_id` is no longer in their junction samples (`SELECT t.session_id
  FROM test_sessions t JOIN test_sessions_subject s ON s.test_sessions_id = t.session_id AND
  s.collection = 'physical_samples' WHERE t.sample_id IS NOT NULL AND lower(s.item) <>
  t.sample_id::text`): those are swapped samples; after `dbmate up` none of them gains a junction
  row for the old sample and each one's `sample_id` equals its junction sample. Since: Explorer
  pages E4-fix (PR pending).
- [ ] **E4-fix — project items link by row_id.** In a project whose operations include two with the
  same pass code (or any project with many operations), open the Project items panel. Expect every
  operation and sample row to link to the right record (hover or click: the Operation page of that
  very operation, not another with the same code), tools, edges, inserts, materials and equipment
  open their Content forms, and a project with more than 1000 operations still links its rows.
  Rows from a campaign-only operation (operation has no project, campaign has) link too; an
  operation of another project does not appear. Since: Explorer pages E4-fix (PR pending).
- [ ] **E-final: campaign pickers set the project; project counts agree with campaign cards.** In
  a campaign that belongs to a project, add an operation, a test session and a sample that have no
  project (Operations, Tests and Samples panels). Expect each record's `project_id` to become the
  campaign's project (check in the Content form). Add one that already has another project:
  it keeps its own. Open the Project page: the Operations, Tests and Samples tiles, the Equipment
  used list and the Activity sparkline include those records even for ones added before this
  change (project empty, campaign set), and the totals are not smaller than the campaign cards'
  sums. Add an operation that someone else just added elsewhere (two tabs): the panel says
  "... is already in another campaign." and nothing changes. Since: Explorer pages E-final (PR pending).

- [ ] **E5-fix-ui: Edit is hidden where you may not change the record.** Use user **A** (owner of a
  sample, an operation, a test, a campaign and a project, or PI of the project) and user **B** (an
  investigator of A's project, not an owner or co-owner). As B open A's sample, an operation or test
  of A's, A's campaign and the project. Expect: the page opens, but there is no **Edit** button
  (Report, Data Studio and the other buttons remain); as A the **Edit** button is there. As B, the
  campaign page has no **Add samples** picker or "add" button on samples listed only through an
  operation or test, and says "Only the campaign's owner can add samples here. Operations and tests
  are moved by their own owner." (campaigns have no co-owners); the operation and test pickers
  stay (see the next item). Force an edit anyway (open the Data Studio form and
  save, or `PATCH` the sample): the error reads as a refusal in plain words, not a generic or
  developer text. Add B as a co-owner of the sample: B now
  sees **Edit**. Since: Explorer pages E5-fix-ui (PR pending).
- [ ] **E5-fix-ui: pickers by a non-owner give the right message.** As user B on a campaign B owns,
  search the Samples picker for a sample B can read but neither owns nor co-owns (one B sees only as
  an investigator) and add it. Expect the create guard's refusal to read "You can only add this to a
  sample you own or co-own.", not a generic Directus error, not a table name or id, and not "already
  in another campaign". Do the same with an operation or test that B can read but not update (it is
  an update of that operation or test, not of the campaign): "Only the owner of <code> (or of its
  sample) can move it.", for add and for remove. As B on a campaign A owns, adding a sample says
  "Only the campaign's owner can add samples to it."; removing a sample B neither co-owns nor owns the
  campaign of says "Only the campaign's owner, or the sample's owner or a co-owner, can remove it."
  As B on A's campaign, an operation B owns can still be added and removed (the picker is there).
  Two tabs adding the same free operation as its owner still says "... is already in another
  campaign." Since: Explorer pages E5-fix-ui (PR pending); wording E5-r3.
- [ ] **E5-r2-ui: a refused save shows the server's reason.** As a co-owner (not owner) of a sample,
  open the sample page, **Edit**, change the **Owner** and save. Expect "Only the sample's owner can
  hand it to someone else." (the same for an operation or test: "Only the operation's owner ..."),
  not the generic "Only the owner or a co-owner can change this record." and not Directus's own
  "You don't have permission to perform "update" for collection ..." text. As B, an investigator who
  cannot edit, force a save on a campaign (Data Studio form) and on a project: Directus's own 403
  is replaced by "Only the campaign's owner can change it." / "Only the project's PI can change
  it." (in the browser's Network tab the response is the stock 403 with `extensions.reason`; the
  page must not show it). In the Network tab the guard's 403 carries `extensions.source:
  "d1-access-guard"`, `kind` and `parent`. Since: Explorer pages E5-r2-ui (PR pending); wording E5-r3.
- [ ] **E5-r2-ui: Edit follows the record, one permissions request per page.** As a co-owner (not
  owner) of a sample, open it, **Edit**, set the Owner to someone else and save: the **Edit** button
  disappears without a reload. Open a record you can change, then follow a link to one you cannot
  (browser Network tab): Edit does not carry over from the first. On a Campaign page there is a
  single `GET /permissions/me/campaigns/<id>`, and the pickers vanish after you hand the campaign
  over. Since: Explorer pages E5-r2-ui (PR pending).
- [ ] **E5-fix-ui: hidden relatives are named, not shown as empty.** As B (sees one sample of A's
  campaign through a test, not A's other samples): open an operation whose input sample B cannot
  see. Expect "Not visible to you" next to **Input**, not "No sample is linked". A test whose sample
  B cannot see shows "1 subject not visible to you". An operation or test in a project or campaign
  B cannot read has a dashed "Project (not visible to you)" or "Campaign (not visible to you)" crumb.
  On the campaign page, when the campaign has samples B cannot see, a line reads "N samples not
  visible to you" under the tiles and in the Samples list, and N plus the visible samples equals the
  count on the campaign's card. Since: Explorer pages E5-fix-ui (PR pending).
- [ ] **E5-fix-ui: project items for a non-investigator.** As a user who owns one sample in a project
  but is neither PI nor investigator, open the project's Content form and the *Project items* list.
  Expect "Only the project's PI and investigators can see this list." For the PI, and for an admin,
  the list shows; for a PI of a project with nothing assigned it still reads "No items assigned to
  this project yet." Since: Explorer pages E5-fix-ui (PR pending).
- [ ] **E5-fix-ui: People page and register-sample.** As a Lab Member open People: the **App login**
  field is read-only with "An admin links logins." and saving a person does not change the login;
  as an admin the login picker works. Opening an existing person as a member shows no **Delete**
  button (admin only; Since: E5-r2-ui). As a member whose login has no People row open **Register a
  Sample**: it says up front that the login is not linked and the button refuses; as an admin
  without a People row it still registers. If the server answers the create with 204 (a member
  with a People row that somehow cannot read the sample) the page says "Created, but you can't see
  it. Ask an admin to link your login to a People row." Since: Explorer pages E5-fix-ui (PR pending).
- [ ] **E5-fix-ui: counts under relational filters return numbers.** As user B (member) open Home:
  *At a glance* and *Needs attention* show numbers, not dashes; a project's tiles, the Projects index
  cards and a campaign's tiles show numbers. These use `aggregate[count]` (and a `groupBy`) under the
  row-level filters, which reach through other collections; a dash means Directus refused the
  aggregate under that filter and the page needs another read. Since: Explorer pages E5-fix-ui (PR
  pending).

#### Row-level visibility (E5, ADR-0011)

Setup for every item: migrations 140 and 141 applied and Directus **restarted right after applying them**
(`docs/runbooks/upgrade-2026-10-row-level-visibility.md`; flush Redis, `docker restart`) (it reads relations
at start-up, and 141 adds the hidden `projects.samples`, `operations` and `sessions` aliases, and the
`d1-access-guard` hook is loaded at start-up too). Two Lab Member users with a People
row each (`user_id` set): **A** and **B**, unrelated, plus a Lab Admin. Note the NOTICE that
migration 141 prints about ownerless records.

- [ ] **E5 — migrations 140 and 141 on the real database.** `dbmate up` applies cleanly and prints
  `ADR-0011 ownerless records ...`; `dbmate down` twice then `up` again; before the `down`, copy the Lab Member rows (`SELECT * FROM
  directus_permissions WHERE policy = '20000002-0000-0000-0000-000000000002' ORDER BY id`) and after it
  compare: the same rows come back (ids, filters, fields), and the table
  `d1_private.lab_member_permissions_backup` and its schema are gone (they exist while 141 is applied; they
  are not a Data Studio collection and not in `v_schema_dictionary`). In Settings → Access
  Policies → Lab Member, `physical_samples` read shows the filter (owner, co-owners, project PI and
  investigators, campaign owner) and `materials` read has none. On a database that already dropped
  `physical_samples.co_owners` (the 2026-09 snapshot has no such column) nothing is renamed and
  nothing fails. Since: Explorer pages E5 (PR pending).
- [ ] **E5 — the NULL-owner rows.** Record the counts the migration printed (samples, operations,
  tests, campaigns, projects without a PI) and assign owners
  (`scripts/transfer_sample_ownership.py` or the *Owner* field) before members rely on the filter.
  Until then those records are visible only through a project, campaign or co-owner. Since:
  Explorer pages E5 (PR pending).
- [ ] **E5 — owner A sees it, unrelated B does not (every rule).** As A create a project (A as PI),
  a campaign in it, a sample in the campaign (project set) and an operation and a test on the sample.
  Each shows *Owner: A* without A choosing it (the `d1-default-owner` hook). As B (never added to
  anything): the Home counts, the Projects index, the Data Studio lists (samples, operations, tests,
  campaigns, projects) and the Explorer pages by direct URL all show none of them (*Not found or not
  visible to you*); `GET /items/physical_samples/<id>` as B answers 403 or an empty result. As the
  admin all are visible. Also check the child lists: the sample's co-owners, genealogy, stock
  provenance, linked files, the operation's force analyses and the test's results are not readable
  by B. Since: Explorer pages E5 (PR pending).
- [ ] **E5 — B gains access.** Add B as a **co-owner** of the sample: B now sees the sample, its
  operations and tests (Explorer pages and Data Studio) and can edit them. Remove B and add B as an
  **investigator** of the project: B sees the project, its campaigns, samples, operations and tests
  but **Save** in the Edit drawer fails with a permission error, and so does a PATCH. Remove B and
  make B the **owner of a campaign** that contains the sample: B sees the sample and its
  operations and tests (read only) and the project (via the campaign). Make B the owner of a
  different sample in the project: B sees the project, but only B's own sample in its counts.
  Since: Explorer pages E5 (PR pending).
- [ ] **E5 — operator co-owner records a cut from the Force App.** A owns sample S. As A, add the rig
  operator B as co-owner of S. In the Force App signed in as B, the sample list offers S; record a
  cut and save with upload. Expect: no 403 on the operation, the two files or the
  `machining_force_analysis` row; the operation is owned by B; A (owner of S) sees the operation,
  its force analysis and the live cache; an unrelated user C does not. Before B is a co-owner, S is
  not offered to B. Since: Explorer pages E5 (PR pending).
- [ ] **E5 — update and delete are limited to owners.** For each of sample, operation, test,
  campaign and project: the owner (PI for a project) can edit and delete; a co-owner of the sample
  can edit the sample and its operations and tests but cannot delete the sample; an investigator
  (read access through the project) gets a permission error on edit and delete; an admin can do
  everything. Deleting a sample as its owner removes it and its dependent rows cleanly. Since:
  Explorer pages E5 (PR pending).
- [ ] **E5 — `co_owners._some` works after the rename.** The sample form still shows the *Co-owners*
  field with names (not ids or an old comma list); adding B there is what grants B access above.
  `physical_samples.co_owners_legacy` is not shown in the form. `GET
  /items/physical_samples?fields=co_owners.user_id` as the admin returns the junction rows. Since:
  Explorer pages E5 (PR pending).
- [ ] **E5 — `projects.samples`, `operations` and `sessions` aliases.** After the Directus restart, `GET
  /items/projects?fields=samples,operations,sessions` as an admin lists ids of each, and a user who owns only a sample, or
  only an operation or a test, in a project (no PI or investigator role) can open that project's page. If the project is invisible
  to that user, Directus has not picked up the alias: restart it or clear its cache
  (`POST /utils/cache/clear`). Since: Explorer pages E5 (PR pending).
- [ ] **E5 — project rollup.** As the project's PI the Project rollup list (the `d1-project-items`
  panel in the Data Studio form) shows the items; as an unrelated co-owner of one sample in it,
  the panel is empty or reports it cannot read it. Since: Explorer pages E5 (PR pending).
- [ ] **E5 — Ask-DB still answers over all data (known gap).** As B, ask "how many samples are
  there?": the answer is the lab total, not B's visible count. This is the accepted gap in ADR-0011;
  record the result so the owner can decide when to restrict Ask-DB. Since: Explorer pages E5 (PR
  pending).
- [ ] **E5 — the configure script keeps the filters.** Run `scripts/configure_users_and_policies.sql`
  twice against the real database: the Lab Member rows still carry the filters (Access Policies →
  Lab Member → `physical_samples` read), `directus_files` create/read and the Force App save from
  the X2 item above still work. Since: Explorer pages E5 (PR pending).
- [ ] **E5 — speed with real data.** As a member with many involved records, the Data Studio sample
  list, Home and the Projects index load in a few seconds (the filters add relational subqueries
  and the migration added the indexes behind them). If a list is slow, `EXPLAIN ANALYZE` the query
  and note which filter path costs. Since: Explorer pages E5 (PR pending).
- [ ] **E5 — a member without a People row.** Create a Lab Member whose People row is missing or has
  no user: their new sample has no owner, and they cannot see it afterwards (the hook cannot fill
  the owner). The member can create their own People row in the Data Studio (leave *User* empty, or
  pick themselves) and an admin can link it; linking fixes the records they make from then on.
  Decide whether sign-up should create the row. Since: Explorer pages E5 (PR pending).
- [ ] **E5 fix — nobody can grant themselves access (d1-access-guard).** Setup: A owns sample S and
  project P (A is PI) and campaign C; B is unrelated, then made an **investigator** of P (so B can read S
  if S is in P, but not edit it). As B, each of these answers **403 FORBIDDEN** and creates nothing:
  `POST /items/sample_co_owners {"sample_id": S, "user_id": B}`; `POST /items/project_investigators
  {"project_id": P, "user_id": B}`; `PATCH /items/sample_co_owners/<a row of another sample B can edit>
  {"sample_id": S}`. Then B owns campaign C2: `POST /items/campaign_samples {"campaign_id": C2,
  "sample_id": S}` is 403 (B cannot edit S), and works for a sample B owns. As A all of them work;
  as the admin all of them work. Also: A creates a new sample with a co-owner in the **same form
  save** (the Data Studio *Co-owners* field on a new sample), and a new project with an investigator,
  and a new campaign with samples A owns: none is refused (the guard reads the parent inside the
  request's transaction; if a nested create is wrongly refused, the hook's `database` is not the
  transaction and that needs fixing; see the next item for the owner-is-someone-else case). Remove B as investigator and re-add via A: works. Since:
  Explorer pages E5 fix (PR pending).
- [ ] **E5 r2 — nobody can attach their sample to someone else's test (`test_sessions_subject`).** A
  owns test T (on A's sample SA); B owns sample SB and is unrelated to T. As B: `POST
  /items/test_sessions_subject {"test_sessions_id": T, "collection": "physical_samples", "item": SB}`
  answers **403 FORBIDDEN** ("You can only change the samples of a test you own, or of a test on a sample you own or co-own."), no row is created, and B still cannot read T.
  The same POST by A, or by the admin, works. A creating a **new test with a sample in the form** (the
  *Subject* field) still works. Naming a sample A cannot read on A's own test is allowed (A reads
  the test; SB's owner can then read and edit it): confirm and record that this is what you want
  (ADR-0011 decision 5). Since: Explorer pages E5 r2 (PR pending).
- [ ] **E5-r3 — a parent merely updated in the request does not count as "created here".** As B,
  create a *new* sample with a co-owner in the form (it works), a new project with investigators
  (works) and a new campaign with samples (works): the guard now requires the parent to be
  inserted by the request **and still at OCC version 1**. Then `POST /items/sample_co_owners
  {"sample_id": <a sample of A's that B cannot update>, "user_id": <B's user>}` still answers 403
  "You can only add this to a sample you own or co-own.". The "updated in the same transaction"
  case itself is proven at SQL level in phase1 and in the node tests; this checks that the real
  Directus nested create still passes the new `version = 1` condition. Since: Explorer pages E5-r3
  (PR pending).
- [ ] **E5 r2 — the creator owns what they make in someone else's campaign.** A owns campaign C in
  project P (PI: PI). As B (a co-owner of a sample in C, so B may add an operation to it) create an
  operation and a test with *Campaign* = C: both show *Owner: B* (not A, not PI), inherit the project,
  and B can open and edit them afterwards; A sees them through the campaign. A new campaign created
  by B under P shows *Owner: B*, not the PI. Choosing another owner explicitly in the form is kept.
  Since: Explorer pages E5 r2 (PR pending).
- [ ] **E5 r2 — creating a parent with junction rows in one save, owner = someone else.** As A (a
  Lab Member): (1) Data Studio, new **project**, *Principal Investigator* = B, *Investigators* = C, Save.
  (2) New **sample**, *Owner* = B, *Co-owners* = C, Save. (3) New **campaign**, *Owner* = B, with
  *Samples* = a sample A owns, Save. (4) New **test**, *Owner* = B, with a *Subject* sample. Each saves
  with no 403 (the guard recognises the parent as created in this request: `xmin =
  pg_current_xact_id()::xid`). A then loses the record (it is B's). Then, as A, the same saves with a
  **sample A cannot edit** in (3), or `POST /items/sample_co_owners` for an **existing** sample A
  cannot edit, are still 403. If (1) to (4) are refused, Directus runs the nested junction create
  outside one transaction (or in a savepoint) and the hook needs another way to know the parent is
  new. Since: Explorer pages E5 r2 (PR pending).
- [ ] **E5 r2 — repointing a `campaign_samples` row needs both sides.** B owns campaign C1 and a
  sample S in it, and owns a second campaign C2; A owns sample T. `PATCH /items/campaign_samples/<row of
  C1, S> {"sample_id": T}` answers 403 (B cannot edit T). Now a row (C1, S2) where B owns C1 but S2
  belongs to A and B is not its co-owner: `PATCH {"campaign_id": C2}` answers 403 (the sample half is
  checked on the moved row; before this fix only the campaign was). As A (owner of S2 and of the target
  campaign) both PATCHes work. Since: Explorer pages E5 r2 (PR pending).
- [ ] **E5 fix — a PI sees the project's campaigns' records.** B is PI of project P2 and owns nothing
  else. A creates a campaign in P2, a sample in that campaign (the sample's own project left empty)
  and an operation and a test on it with no project of their own. B sees the campaign, the sample, the
  operation and the test (read only, Save fails), and the Project page counts them. An operation
  whose own project is empty but whose campaign is in P2 is visible to B too. Since: Explorer pages E5
  fix (PR pending).
- [ ] **E5 fix — an operation owner can open the project.** A owns an operation (or test) in project P
  and nothing else there. A opens the operation: the breadcrumb's project link opens the Project page
  (not "not visible to you"); A sees the project row but only A's own records in its counts. Since:
  Explorer pages E5 fix (PR pending).
- [ ] **E5 fix — a new project's PI is its creator.** As A (with a People row) create a project in the
  Data Studio or the Explorer: *Principal Investigator* shows A without A choosing it, A can edit it
  and sees it in the Projects index. Choosing another PI explicitly is kept. Since: Explorer pages E5
  fix (PR pending).
- [ ] **E5 fix — the audit log is admins only.** As B, `GET /items/audit_logs` answers 403 and the
  Audit Logs collection is not in B's Data Studio navigation; as the admin it lists rows. Home,
  the Explorer pages and `d1-trace` still work for B (nothing reads the log as a member). Since:
  Explorer pages E5 fix (PR pending).
- [ ] **E5 fix — nobody can take over another person's People row.** A has a People row linked to A's
  login; B has one linked to B's. As B: `PATCH /items/people/<A's row> {"user_id": "<B's user id>"}`
  and `{"user_id": null}` and `PATCH /items/people/<B's row> {"user_id": "<A's user id>"}` all answer
  403, and neither login changes; `PATCH /items/people/<A's row> {"notes": "x"}` works (other
  columns stay editable); `DELETE /items/people/<A's row>` is 403; `POST /items/people {"full_name":
  "Z", "user_id": "<A's user id>"}` is 403 while `POST ... {"full_name": "Z"}` and `{"full_name": "Z",
  "user_id": "<B's user id>"}` (only if B has no row yet) work. The People page's login picker is
  hidden for B and shown for the admin, who can link and relink. As the admin none of the above is
  refused. Since: Explorer pages E5 fix (PR pending).
- [ ] **E5 fix — Lab Member reads still work after `configure_all.sh`.** Run
  `scripts/configure_all.sh` against the real database (it restarts Directus), then as A and B
  repeat a quick pass: A sees A's sample, operation, test, campaign and project in the Data Studio and
  Explorer; B sees none of them; the sample form still shows *Co-owners* and the campaign form
  *Samples*, and a sample's *Campaigns* field and the hidden `co_owners_legacy` stay as before.
  Settings -> Data Model -> `physical_samples` shows `owner_person_id` -> People, `campaigns` ->
  `owner_person_id`, and `campaign_samples` -> `campaigns` relations. (A re-run used to delete the
  owner relations and every filter then failed.) Since: Explorer pages E5 fix (PR pending).
- [ ] **E5 owner — only the owner can change a record's owner.** Setup: A owns sample S; B is
  a co-owner of S (so B can edit but not delete it); the hook loaded at Directus start-up. As B:
  `PATCH /items/physical_samples/<S> {"owner_person_id": "<B's person id>"}` answers **403
  FORBIDDEN** and the owner is unchanged; the same through the Data Studio sample form (change
  *Owner*, Save) shows the error; `PATCH ... {"notes": "x"}` works, and saving the form without
  touching *Owner* works. A `PATCH /items/physical_samples {"keys": [S, <a sample B owns>], "data":
  {"owner_person_id": "<A's person id>"}}` is refused as a whole. Repeat for an operation and a test
  that B co-edits through the sample (403). As A: handing S to B works, after which A can no longer
  delete S and B can; as the admin changing the owner always works. Campaigns and projects are
  unaffected (only their owner or PI can edit them at all). Since: Explorer pages E5 owner (PR pending).
- [ ] **E5 owner — Owner and Operator pickers survive `configure_all.sh`.** After running
  `scripts/configure_all.sh` against the real database (and Directus restarting), open a sample, an
  operation, a test, a campaign, an etchant, a prep recipe, a tool box, a cutting insert and an insert
  edge in the Data Studio: *Owner* (and *Operator* on operations and tests, *Principal Investigator*
  on a project) is a People dropdown that lists names and offers "create", not a raw UUID input.
  Since: Explorer pages E5 owner (PR pending).
- [ ] **E5 fix — the sample report hides projects the reader cannot open.** A owns sample S in project
  P and B is a co-owner of S but not an investigator of P. As B open the sample report
  (`/d1-report/sample/<S>`): the sample is there, but its Project line and the operations' and tests'
  project column show nothing for P; as A (PI) they show P. Since: Explorer pages E5 fix (PR pending).
- [ ] **E5 — a secondary sample of a multi-sample test (known gap).** B co-owns only the second
  sample of a test with two samples: B cannot see the test (it is matched through its first sample).
  Record whether this matters to the lab. Since: Explorer pages E5 (PR pending).
- [ ] **Restyle — dark theme.** Set your account's appearance to Dark and open Home, a Project, a
  Campaign, a Sample and an Operation page. Expect: panels read as panels (a hairline and a lid a
  shade off the body), the tile labels and table heads are readable, and the status pills
  (Active, Analysed, Diagnostics built, Failed) have light ink on a dark tint, not the reverse.
  Nothing is a fixed light colour except the sample drawing. Links and codes: the Dark theme is
  `Directus Default` with no overrides, so its primary is the project colour (`#18222F`),
  near-black on a near-black ground. The kit carries its own accent for its own text and fills
  (record links, tags, count chips, progress bars; see the accent item below), so those read
  without a theme change. Directus's own components still use the theme's primary: if the Edit
  button or another primary `v-button` is unreadable, that needs a dark-theme primary in Settings,
  not a change to the pages. Checked in the Light theme only on 2026-10-09 (the test account's
  appearance is pinned to Light). Since: Explorer fixes F1, not yet in a PR.
- [ ] **Restyle — Test page.** Open a test session that has parameters, subjects and results. Expect:
  Overview and Parameters side by side as readout tiles (value above label, nothing cut with an
  ellipsis), the Subject rows, and each results table only as wide as its figures with the first
  column left-aligned and the rest right-aligned. The database had no test session on 2026-10-09,
  so this page was not seen. Since: Explorer restyle, not yet in a PR.
- [ ] **Restyle — Home as a member with work.** Sign in as a member who is PI on a project, owns a
  campaign and owns samples. Expect: "My projects", "Campaigns I own" and "My latest samples" are
  three panels in one row (stacked on a narrow window), each holding cards with the code, a tag at
  the right, the name and one line of meta. Only the empty state was seen on 2026-10-09 (admin
  account). Since: Explorer restyle, not yet in a PR.
- [ ] **Explorer fixes F1 — an operation without a pass code.** Find an operation whose pass code
  is empty and that has an input sample and a step number (Data Studio: `manufacturing_operations`
  filtered `pass_code` is empty) and open `/admin/home/operations/<id>`. Expect: the heading reads
  like `10-AA-MF-2023-3-31 · step 27` (its input sample and step) in the normal font, not
  monospace; the tab title is the same text; nothing says just "Operation" as if it were a code.
  The same text is the link text in the Sample page's Operations table, the Project page's
  "Operations not in a campaign", Home's Recent activity and Needs attention (where no second
  line repeats the sample), and the campaign page's Operations list and picker. In the sample's
  life strip it is the card's label in the normal font (a pass code, a sample code and a lot code
  stay monospace; a test's type does not) with no `#27` line under it, while an operation with a
  pass code keeps its `#27` line. In the campaign matrix an uncoded operation that has a step is
  in the column headed `#27`, which other samples' operations share only when they have the same
  step and the same process category (a machining and a heat-treatment step 27 get two columns).
  Hovering its cell shows `10-AA-MF-2023-3-31 · step 27` on the first line, with the sample named
  once, and `Force analysis: <state>` on the next (a TEST cell is the one-line
  `<sample> · <test type>: <state>`); an uncoded one without a step has a column of its own, even
  when several samples have one. In the campaign's operation picker, typing a sample code (or part
  of one) finds its uncoded operations, and typing a pass code still finds coded ones. Run the
  picker check as a Lab Member as well as an admin: the search is a relational filter on
  `sample_id.sample_code`, which a member's permissions can break. Since: Explorer fixes F1,
  not yet in a PR.
- [ ] **Explorer fixes F1 — an uncoded operation whose input sample you cannot see.** As a member
  who can read an operation but not its input sample (the operation is in your project or
  campaign, the input sample belongs to someone else and is outside your projects), open it.
  Expect: the heading and tab title read `Uncoded operation · step N`, the same text the lists
  give for it, never `<the output sample's code> · step N` (the step is numbered on the input
  sample); the Samples section marks the input sample as not visible to you.
  For an uncoded operation with no input sample at all and a visible output sample, the heading
  reads `Operation on <output code>` with no step. No such record exists in the lab database, so
  create one first: in the Data Studio add a `manufacturing_operations` record with a step number,
  an Output sample, no Sample (input) and no pass code, then open it. Edit it (change the notes)
  and save: the heading and tab title stay `Operation on <output code>` throughout, they do not
  switch to `Uncoded operation · step N` and back. With the Output sample cleared as well, the
  heading reads `Uncoded operation · step N`, as the lists do. Since: Explorer fixes F1, not yet
  in a PR.
- [ ] **Explorer fixes F1 — Projects count in "At a glance".** On Home, the strip has a Projects
  tile between Tests and Campaigns, with a number, not a dash. Expect: as an admin it is every
  project, as a member the number of projects you can read;
  the tile opens the Explorer's Projects index (`/admin/home/projects`), not the Projects
  collection in the Data Studio. Since: Explorer fixes F1, not yet in a PR.
- [ ] **Explorer fixes F1 — Test page result tables.** Open a test session with processed results
  that have a list of records ("Channels", "Top frequencies"). Expect: each table is only as wide
  as its columns (not the whole page), the first column left-aligned and every other column,
  heads included, right-aligned over its figures. Other tables (Sample page Operations, Home
  Recent activity) are still full width with left-aligned heads. Since: Explorer fixes F1, not yet
  in a PR.
- [ ] **Explorer fixes F1 — accent colour on the dark theme.** Set the appearance to Dark and open
  Home, a Project, a Campaign, a Sample, an Operation, People and Register a Sample. Expect:
  breadcrumb and record links, the kind pill, section count chips, tags, the quick-action and
  stat icon chips, progress bars, the activity sparkline and the buttons that look like links are
  a visible grey-blue (about `#8b949e`), not near-black; the active People tab and the numbered
  steps of Register a Sample have dark text on the light accent. In the campaign matrix, the
  info-coloured cells and the picker's hover (they keep Directus's `primary-background`) are still
  readable. Then switch to Light: the colours are the project's primary exactly as before. Since:
  Explorer fixes F1, not yet in a PR.
- [ ] **Explorer fixes F1 — side-by-side panels keep their own height.** Open an Operation with
  few overview values and many parameters, and a Campaign with a short sample list beside a long
  test list. Expect: each panel is only as tall as its content, the shorter one ends early with
  the page background under it, not a half-empty panel. Since: Explorer fixes F1, not yet in a PR.
- [ ] **Explorer fixes F1 — Ask the database and Dashboards have no entry on Home.** By the
  maintainer's decision of 2026-10-09 Ask the database is hidden from Home for now, so on this
  install it has no entry in the UI at all (its module is off in the module bar), and the
  Dashboards module is being retired (its lineage graph is to be rebuilt). Expect: Home's quick
  actions show no tile for either; on this install the lab dashboard is reachable only from a
  Sample page's "Open lineage graph" until it is replaced (its module bar has `d1-lab-dashboard`
  and `ask-db` disabled). A fresh install differs: `scripts/configure_directus.sql` enables
  `d1-lab-dashboard` in the module bar, so there it is also in the bar; do not fail this item for
  that. Check that the link still opens the graph for the sample. Since: Explorer fixes F1, not
  yet in a PR.
- [ ] **Migration 20261010000160 on live: Lab Member queries stop returning 400.** Before applying,
  record `SELECT md5(string_agg(id||coalesce(permissions::text,'~'), ',' ORDER BY id)) FROM
  directus_permissions`. Apply, then flush Redis and `docker restart` Directus (it caches permissions,
  see `docs/runbooks/upgrade-2026-10-row-level-visibility.md`). Expect `UPDATE 36`
  and 36 rows in `d1_private.lab_member_some_fix_backup`. As jsmcgowan1 (or any Lab Member), open
  Home, Samples, Projects, Campaigns and Tests, and in the Data Studio open `physical_samples`,
  `manufacturing_operations`, `equipment` and `materials`. Nothing returns `"_some" can only be used
  with top level relational alias field`, and `docker logs d1-database-directus-1` shows no new 400 on
  `/items/*`. A sample the user co-owns (not owns) and its operations and tests are visible. Editing
  them saves. Deleting the sample is refused. They can create a sample and an operation on it. A
  sample of a project where they are only a secondary investigator is visible. Junction creates go
  through d1-access-guard: adding a co-owner to a sample they own saves, adding one to someone else's
  sample is refused by d1-access-guard, and linking their own sample to their own campaign saves.
  Then run `dbmate down`
  once: the md5 matches the value recorded before applying, and the backup table is gone. Run
  `up` again and restart Directus. Since: fix/lab-member-legal-some (PR pending).
- [ ] **#247-L6 — Labels page — A4 4×5 sheet on the office laser.** Open
  **Print labels** (sidebar), tick 6 samples, keep the **A4 4×5** template, press **Print**. In the
  browser's print dialog choose A4, **100% scale** (not "fit to page") and no margins or headers. On
  a plain sheet laid over the die-cut A4 4 × 5 sheet, each label (52.5 × 59.4 mm) has its QR code
  and text inside its cell. Set **Start at label** to 3: the first two cells stay empty. Scan one QR
  code with any phone camera: it reads as plain text (`D1 SAMPLE`, the code and short ID, ...). The
  page itself follows light and dark mode, the labels stay white.
- [ ] **#247-L7 — Labels page — QL-700 with DK-22205 through the Windows driver.** On
  the PC the QL-700 is plugged into, open the labels page, tick 3 samples, choose **Brother DK-22205
  62 mm** and press **Print**. In the print dialog pick the QL-700, paper **62 mm continuous** (the
  driver's DK-22205 entry), **100% scale**. Expect: three labels, each its own page, 62 mm wide and
  30 mm long, the QR code on the left and the code, short ID and nickname on the right, none cut off.
  Scan one QR code. If the driver shrinks or crops the label, record the driver settings that work in
  the wiki page on labels.
- [ ] **#247-L8 — Labels page — template editor as a non-admin.** Sign in as a Lab
  Member (not an admin), open the labels page, press **Edit template** on a seeded template: there is
  **no Default switch**, **Save** is disabled, **Delete** is absent, and a line says the template is
  not yours; **Save as new** with a new name works and selects the new template. On that template
  **Save** and **Delete** are offered: change the padding and Save, then Delete it. Saving a template
  under a name that already exists shows "A template with that name already exists" inside the editor.
  Another member's template shows the same read-only state. Sign in as an admin: the Default switch
  is there, and ticking it on another template moves the default.
- [ ] **#247-L9 — Labels page — preselection from the record pages.** From a Sample
  page (real data) press **Print label**: the labels page opens in the same tab with that sample
  ticked. From **Samples**, tick two rows and press **Print labels for selected**: both are ticked
  on the labels page. Open `/admin/home/labels?codes=<a real code>,NOPE`: the real one is ticked and
  "Not found, or not visible to you: NOPE" is shown. The Print label button on a sample form (the
  `d1-report-button` interface) goes to the same page.
- [ ] **#247-L10 — Default swap is one write.** As an admin, on the labels page open a template that is not the
  default, tick **Default template** and Save: it becomes the only default (check the Template list: only one
  says "(default)"; reload to confirm). Then "Save as new" on a template with Default ticked and a name that already
  exists: the save is refused with "A template with that name already exists" and the old default is still the
  default. Save as new with a fresh name and Default ticked: the new template is the only default. "Save as new" on the
  current default template (new name, Default left ticked as it was): the default does not move. Check
  `v_audit_logs_with_actor` (`table_name = 'label_templates'`): the swap shows an UPDATE of the old default row turning
  is_default off, with you as the actor, next to the INSERT or UPDATE of the new default.
- [ ] **#247-L11 — Start at and Copies can be typed.** On a sheet template, click into **Start at label**, clear it
  and type 4: it reads 4 (not 14), and the preview starts at the 4th cell. Type 99: it settles on the number of
  cells on the page. Do the same with **Copies of each sample**: clear and type 4 gives 4; 5000 settles on 100; an
  empty field becomes 1 when you leave it. While editing a template, a half-typed grid (empty Columns) does not
  change Start at or show NaN anywhere.
- [ ] **#247-L12 — Copies per sample.** Tick three samples. Each chip has its own number. Change the global
  "Copies of each sample" to 2: every chip shows 2. Type 5 on one chip, then change the global value to 3: that
  chip stays 5 and the others become 3. The summary line totals every copy (5 + 3 + 3 = 11 labels), the preview
  shows the right number of labels for each sample, and the printed sheet matches. A chip with its own number is marked (a dot and an accent border); clearing its
  number puts it back on the global value and the mark goes. Removing a chip and ticking it again starts from the
  global value.
- [ ] **#252-L1 — Scan a label with a phone (iPhone Safari).** On an iPhone on the lab network or Tailscale,
  sign in at `https://d1-server.tail54eeb6.ts.net/admin`. Open **Home** and press **Scan a label**; allow the
  camera when Safari asks. The rear camera shows. Hold it over a printed label's QR code: the dialog closes and
  that sample's page opens. Open the Finder (the search box in the sidebar) and press **Scan**: the same dialog
  opens. Close the dialog (Close, or tap outside it): the camera light goes off. Now scan a label for a sample
  that was deleted, or one you may not see: the dialog stays open and shows the code, the short ID and the
  other label lines with "No sample matches this label...", and **Scan again** restarts the camera. Scan a
  non-D1 QR code (a web address, say): its text is shown as plain text, not as a link. In Safari's Settings
  deny the camera for the site and open the dialog: it says permission was denied. Open the plain-HTTP
  address instead (`http://d1-server...`): it says the camera needs the HTTPS address. Open the dialog and
  lock the phone, then unlock it: the camera comes back and scanning resumes without reopening the dialog. Open the
  dialog, then switch to the phone camera app and back: the dialog shows "The camera stopped..." (or, if it
  had only been hidden, resumes), and **Try again** restarts it. Since #252.
- [ ] **#252-L2 — Scan a label with a phone (Android Chrome).** The same checks as #TBD-L13 on an Android phone
  in Chrome: the rear camera (not the front one) opens, a label scans from about 15 cm, a label printed on the
  QL-700 62 mm roll scans too, and the camera light goes off when the dialog is closed. Lock/unlock mid-scan
  resumes scanning, and opening the camera app and returning shows the "stopped" message or resumes, as on the
  iPhone. Since #252.
- [ ] **#252-L3 — Scan a label with a USB scanner.** Plug a USB (keyboard-mode) barcode scanner into a PC, open
  any Explorer page, press Ctrl K (or click the sidebar search box) and scan a label's QR code, once with a label
  printed after this change (its lines are separated by ` | `) and once with an older one (separated by `·`, which a
  scanner cannot type: it types some other character or none). Expect: the Finder opens that sample within about a
  quarter of a second after the scan, without pressing anything, and the box keeps the label's line breaks (it does
  not become one run-on line). Turn Caps Lock on and scan again: the sample still opens. If the scanner sends no
  Enter after the last line, a label with only a code line waits: press Enter and it opens. Scan a label for a
  deleted sample: the Finder stays open and shows the decoded label with the reason; scan a second label straight
  after (without clearing the box): it replaces the first and opens, it does not re-read the old one. Scan a label
  whose short ID is wrong but whose code is right: a card offers the sample with "Open sample", and nothing opens
  until you press it. Paste the label's text (copy it from a phone's QR reader) into the box: it opens the sample at
  once. Then type an ordinary search such as `S-01` and check the results list still works; paste a few lines of
  ordinary text: they become one line. Since #252.

- [ ] **#247-L13 — Rich QR scans on a phone.** Set a lab contact on the labels page (admin, under Template:
  "Contact on labels"), then print one label of a sample that has a nickname, a material and an owner with an email
  on the A4 4×5 sheet, the 50×25 single and the Brother DK-22205 roll. Scan each with the stock camera of an iPhone
  and of an Android phone. Each shows the whole text: `D1 SAMPLE`, the code and short ID, material and nickname,
  date and owner initials, the owner's email and `Contact: <the lab email>`, with no login and no network. The
  preview shows no "QR may be hard to scan" warning on A4 4×5 and the DK-22205. For the 50×25 use a sample with a
  long code (about 22 characters) and an owner with a Sheffield-length email: the QR grows to the full label
  height and the text beside it may shrink or be cut (the label is flagged as clipped), and it still scans; if
  the preview does warn, the QR is too small for that payload on that label and the template needs a bigger label
  or fewer QR extras. Also scan a label of a template with
  "All (default)" unticked and only Date chosen: it shows just the code, short ID and date. A label of a sample
  whose owner has no email scans without an email line. Since #247.

- [ ] **#247-L14 — P-touch .lbx export.** Pick the Brother DK-22205 template on the labels page, tick 3 samples and
  click "Download for P-touch (.lbx)": a `labels-<date>.zip` with one `.lbx` per sample (three files), a sample with
  more than one copy named `<code> (xN).lbx` (set 3 copies on one to see `(x3)`; one sample ticked downloads a bare
  `.lbx`, still with `(xN)` in the name). A file carries no copy count: set the copies in P-touch Editor's Print
  dialog. Unzip it and open one `.lbx` in P-touch Editor on the PC with the QL-700 (62 mm
  roll loaded). It opens without an error, with the QR on the left and the code (bold), short ID and nickname to its
  right, the label 62 mm wide and about 30 mm long, and P-touch keeps the QL-700 and the 62 mm continuous roll.
  Print it. Scan the QR with a phone: the whole payload as in L13, with a non-ASCII letter (for example "é" in a
  nickname) intact. The text on the label matches the preview, and nothing is cut at the edges. Not checked here:
  there is no Brother driver on the dev PC, so P-touch Editor re-targeted the file to another printer and the paper
  size and orientation (portrait, `format="259"`, QL-550 `printerID`) are unconfirmed. If P-touch asks to change the
  paper, or the label comes out rotated, report it. Since the .lbx PR.

- [ ] **B2-S1 — Settings inside Directus, and as a Lab Member.** In Data Studio open **Home**, then go to
  `/admin/home/settings` (the sidebar's gear is STARbase-only, so type the address, or use More → Settings if
  Directus's sidebar lists it). The page opens with the Home crumbs and the tab title "Settings". **Appearance** says
  "Theme is set in your Directus account." and its link opens your Directus account page. **Sidebar** shows
  "Start collapsed" and "Collapse automatically on narrow windows" both greyed out, each with "Applies in STARbase".
  **Pinned** lists your pins from the Directus sidebar in order: Move up and Move down reorder them (the sidebar
  follows), Remove unpins, and **Reset to defaults** asks "Replace your pins with Samples and Projects?" and then
  leaves exactly Samples and Projects. A pin whose page you cannot read (try one on a collection your role has no
  access to) is under "No longer available" and Remove clears it. **Forget my list views** and **Clear my history**
  work (Clear asks "Clear your history? Pinned items stay." first, and Cancel sends nothing). Repeat the Pinned and history parts signed in as a Lab Member: every one of them works. Since explorer
  sidebar B2 (Settings page, PR pending).

- [ ] **B2-1 — Saved-view pins across people.** As a person with a role that shares saved views, pin a role-shared
  saved view and a personal one (open the list view, choose the saved view, press Pin). Both show under Pinned in
  your sidebar and survive a reload. Sign in as another member of the same role: only the role-shared view can be
  pinned (the personal one is not offered), and pinning it adds it to their sidebar without touching yours. Their
  pins, their order and their unpins are their own: unpin it as them and it stays pinned for you. Since explorer
  sidebar B2. PR #262.

- [ ] **B2-2 — Migration 170 on live.** Apply `20261013000170_user_pins_and_prefs` (renumbered from 165) to the live
  database. It applies without an error. Existing U1 pins are numbered newest-used first for every person (as U1's Home listed them), and each person gets
  Samples and Projects once (no duplicate rows, none for a person who already had them). Run `dbmate down` then
  `up` on a copy first if you want to see it reverse. Since explorer sidebar B2. PR #262.

- [ ] **B2-3 — Record pins after access changes.** Pin a record (a sample, say) from its page header, then remove
  that person's access to it (change the owner, or take the role's read permission away). On their next load the
  pin leaves the sidebar and appears under Settings → Pinned → "No longer available", where Remove clears it. Give
  the access back: the pin does not return by itself, and pinning the record again works. Since explorer sidebar B2.
  PR #262.

- [ ] **B2-4 — Sidebar inside Directus (d1-home).** In Data Studio open **Home**. The sidebar is always the
  expanded one, with no collapse button. It shows Pinned, the section accordion (one section open at a time) and the
  ⋯ menu to the right of each row. Pin and unpin a section and a record: the change shows at once and is still there
  after a reload. The Data Studio link in the sidebar opens Data Studio. Since explorer sidebar B2. PR #262.

- [ ] **B2-5 — Real drag and touch.** With a real mouse in Chrome and in Firefox, drag a section row into Pinned (it
  pins) and drag a pin above and below its neighbours (the order changes and survives a reload). On a phone or
  tablet, the pin and ⋯ buttons are visible without hovering, and the rail's menus open on tap and close on a tap
  elsewhere. Since explorer sidebar B2. PR #262.

- [ ] **B2-6 — Keyboard and screen reader.** In Chrome, Firefox and Safari, tab to a rail icon: its hover menu opens
  on focus and closes on Esc. In a short window (about 520 px high) tab to the lower rail icons: their menus stay
  open and fully on screen while focused. With a pin focused, Alt+↑ and Alt+↓ move it up and down. With a screen
  reader (NVDA or VoiceOver) reordering announces "Moved <name> to position N of M", and the pin button reads as
  pressed when pinned and not pressed when not (pinning has no spoken message of its own). Since explorer sidebar B2. PR #262.

- [ ] **B2-7 — STARbase layout and first paint on live.** Against live Directus data, at 1000 px wide or more, choose
  the rail, reload: it opens as the rail with no jump to the expanded sidebar and back; do the same for expanded.
  At 768 to 999 px the rail opens over the page and closes with Esc or a click outside. Under 768 px the phone sheet
  opens from the menu button. Choose Light or Dark in the sidebar (or Settings), reload and open a deep link in a
  new tab: the chosen theme shows on the first paint, with no flash of the other one. Since explorer sidebar B2.
  PR #262.

- [ ] **B2-8 — Existing STARbase e2e against the preview stack.** Start the docker preview (`d1-starbase` and
  Directus) and run `tests/ui` specs `14-starbase` and `15-starbase-polish` (they need Directus) and the new
  `16-sidebar-b2` against it. All three pass; a failure in 14 or 15 is a regression from the sidebar change. Since
  explorer sidebar B2. PR #262.

## B. Force rig (NI-DAQ, Lab Amp, packaged Windows app)

Install the current release from the update feed on the acquisition PC. Use a real sample and
tool; a test cut on scrap stock is fine.

### Recording
- [ ] **R4 — pre-flight chips.** With the Lab Amp in MEASURE: Amp chip OK. In RESET: OK (Start
  cycles it). Unplugged/unreachable: warning. Channels chip checks the saved NI-DAQ model and goes
  to "fail" when a configured channel is missing from the chassis. Disk chip's "~N min" roughly
  matches free space ÷ data rate. Since #124. — 2026-10-08, Claude (a second, isolated copy of the
  installed 0.1.34 on the rig, stub sign-in): FAIL on the Channels chip, see #213. With
  the tacho moved to a module that is not on the chassis the chip stays "ok" ("All force channels
  and the tacho have an input"), or "not checked" when the Record page's list differs from the
  model; Start then fails with DAQmx -200220. OK: Amp chip in MEASURE and in RESET (Start switched
  the amp to MEASURE); Disk chip "48.9 GB free, about 13 h at 25,000 Hz x 10 channels" (13.3 h by
  hand). The unplugged amp is still to do.
  — 2026-10-08, DP at the rig: FAIL on the unplugged amp, see #215. With the amp's network cable pulled the
  chip gave no warning; it only showed after opening the Connectivity Doctor and running it.
  Fixed in 0.1.35 (#213, #215): re-check under "Re-checks for the 2026-10-08 fixes" below.
- [ ] **R5 — live clipping.** Drive one channel to its rail (lower the amp range, or a known
  overload) at a Lab Amp full scale of 10 V, then 5 V. Expect the red banner naming that channel,
  the tile and badge, and after the cut `channels_ranging.clipped` true for the same channel only.
  Since #124. — 2026-10-08, Claude: not run (nobody loaded a channel), but it cannot pass at 10 V on
  this chassis: the force modules are NI 9234 (±5 V input), so a channel saturates at half its Lab
  Amp range and never reaches the 99 % threshold, see #200. Today's cut `20261008-132200-fdb783`
  reached 4.75 V on Fz3 with no warning possible.
  — 2026-10-08, DP at the rig (captures read by Claude): FAIL at 10 V, see #200. Fz1 set to a 10 N
  range and the dyno pushed by hand: no banner, tile or badge. In `20261008-170159-8a99b8` Fz1
  sits flat at ±5.117 V (the NI 9234 limit) for 2.4 % of the cut and `channels_ranging.clipped` is
  false for every channel. In `20261008-170349-b4c4d3` Fz2, Fz3 and Fz4 (200 N ranges) also stop
  at 5.12 V, 102 N each, with no warning. The 5 V run is still to do.
  Fixed in 0.1.35 (#200): re-check under "Re-checks for the 2026-10-08 fixes" below.
- [ ] **R6 — alarms on hardware.** Early warning at 80 % of the force limit (amber, no tone). With
  "Stop the recording when the force alarm trips" on, a trip stops the cut, the alarm stays on top
  of the save dialog and A acknowledges it. With a tone volume set, Windows volume is not changed.
  Since #125. — 2026-10-08, DP at the rig (code and captures read by Claude): FAIL, see #212.
  No early warning and no alarm, with hits saved as 308 N on Fz (more in truth, the channels
  clipped). Cause: the live stream is the summed volts with no N/V gains applied (`sum_axes(data)`
  in `session.py`), so the alarm compares volts with the newton limit. With 10 to 20 N/V gains
  the live plot, live peaks and the cut-detect threshold read 10 to 20 times low, which is the
  factor of ten DP saw between the live plot and the summary plot; only the saved files are in
  newtons. Stop-on-alarm, A and the tone could not be checked.
  Fixed in 0.1.35 (#212): re-check under "Re-checks for the 2026-10-08 fixes" below.
- [ ] **R10 — shortcuts in the packaged app.** Ctrl+Enter starts (through the pre-flight and alarm
  test), Ctrl+. stops, A acknowledges, Ctrl+N starts a new cut, Enter saves. Press Alt once, then
  A during an alarm: A must still acknowledge (Alt opens menu mode on Windows). Since #125. —
  2026-10-08, Claude (isolated copy of the installed 0.1.34, real NI-DAQ cuts, keys sent by
  automation): partly run. Ctrl+Enter starts, through "Start anyway" (a click, when no Sample is
  set) and the alarm test (once per session); Ctrl+. stops in about 1 s; Ctrl+N starts a new cut
  once the save dialog is closed; Enter saves when a save option is ticked. A does not acknowledge
  by itself: it opens "Silence this alarm?" with "Keep alerting" focused, so A then Enter keeps the
  alarm; Silence has to be chosen. Decide whether that is the intended behaviour. Alt then A was
  not run (an automated Alt does not open the menu), nor A with the save dialog open.
  — 2026-10-08, DP at the rig: Alt then A could not be run, because the force alarm never came up
  (see R6).
- [ ] **R1/R3 — remembered setup.** Quit and relaunch: Sample, Machine, Operator, op type and cut
  parameters are back. Open a cut in Replay, then switch to NI-DAQ: the form shows your setup, not
  the archived cut's sample, edge or sequence. New steps the sequence. Since #123. — 2026-10-08,
  Claude (isolated copy of the installed 0.1.34): only the cut parameters and the source were run;
  spindle, feed, diameter, sample rate, pulses per rev and NI-DAQ came back after quit and
  relaunch. Sample, Machine, Operator, op type, Replay and the sequence need a real sign-in.
  — 2026-10-08, DP at the rig (signed in): FAIL, see #216. The metadata set before
  quitting was not there after relaunch. Replay and the sequence were not run.
  Fixed in 0.1.35 (#216): re-check under "Re-checks for the 2026-10-08 fixes" below.
- [x] **Leaving the page mid-cut.** Start a cut, go to Plot, come back after it ends: the save dialog
  offers to save it. Since #123 (doc fix). — 2026-10-08, Claude (isolated copy of the installed
  0.1.34, real NI-DAQ cut of 71.5 s): OK. The cut was ended through the recorder while Plot was
  open (Ctrl+. only works on Record); back on Record the "Recording finished" dialog was there and
  saved a local copy.

### Captures list (thousands of captures on the real drive)
- [x] **R9 — browse speed on the real capture drive.** With the capture drive holding about 1,000
  or more captures (a network drive if that is what the lab uses; copy old captures in if needed),
  open Settings > Local Captures. Expect the first 200 rows within a few seconds, "Showing 200 of
  N" with the true N, and Load more adding the next page. Press Refresh again: a warm scan should
  be clearly faster than the first. Note both times and the drive type here. Since #127. — 2026-10-08, Claude (isolated copy of the installed 0.1.34; 1,208 captures in a scratch
  folder on the rig's local C: drive, 1,200 of them small synthetic copies): OK. First page 2.5 s
  cold and 0.05 s warm from the recorder, "Showing 200 of 1208", Load more to 400 in 1.1 s, Refresh
  0.8 s. Not run on a network drive or with full-size captures.
- [ ] **R9 — search, sort and filters at scale.** Search a sample name, a date (`2026-10-02`) and an
  id fragment: results match a hand check in File Explorer. Sort by Largest first: the top rows are
  the biggest folders. The Not uploaded and Uploaded chips keep loading pages and the footer's
  "checked" count makes sense. Needs a real Directus so the uploaded state is real. Since #127. — 2026-10-08, Claude (same 1,208-capture set, checked against the folder):
  partly run. A sample name gave 182 of 182, the date `2026-08-02` 13 of 13, an id fragment 1 of
  1, and Largest first put the five biggest folders on top in the right order. The Not uploaded
  and Uploaded chips need a real sign-in and were not run.
- [ ] **R9 — bulk delete frees the space.** Select a handful of uploaded captures and Delete
  selected: the confirm's space total matches the drive's free space gained (Explorer or the
  "Free on drive" figure after Refresh), the folders are gone, and the remote backup copy is marked
  deleted rather than removed. Include one not-uploaded capture: the only-copy warning appears.
  Cancel mid-run: the rest are untouched. Since #127. — 2026-10-08, Claude
  (isolated copy of the installed 0.1.34, five not-uploaded test captures): partly run. The
  confirm said "Frees about 366.7 MB", equal to the five folders on disk, with the only-copy
  warning for all five; the five folders went and the other 1,203 stayed. It took 39 s for five
  captures: each delete is instant, the waits are between them. The remote copy was not marked:
  the backup server on d1-server answers 404 on `/sessions/<id>/mark-deleted`, so redeploy it first
  (section C). Uploaded captures, the free-space figure and Cancel mid-run were not run.
- [ ] **R9 — cleanup never touches unsynced captures.** With real uploaded and not-uploaded
  captures older than N days, Free up space > Preview lists only captures that have a real
  `manufacturing_operations` row AND a `machining_force_analysis` row with `live_cache_file` (and
  `directus_files_id` when a `.mat` exists); cross-check three in Directus. Make one orphan: in
  Directus delete the analysis row of an old uploaded capture (or stop an upload after the run row
  is created); it must show "partial upload", keep its Upload button, be absent from the preview,
  and get the only-copy warning in a bulk delete. Not-uploaded, incomplete and
  queued ones are absent at any N. Run it and confirm those are still on disk. Repeat with Directus
  stopped: the preview must refuse. Since #127.
- [ ] **R9 — upload-all progress and cancel against the real Directus.** With three or more
  not-uploaded captures, Upload N unsynced: the bar shows "Uploading n of m" and the capture name,
  Cancel stops after the current one and says how many were not attempted, and each uploaded
  capture has exactly one operation row (no duplicates after cancelling and running again). While
  it runs, Delete selected, Free up space and the row Upload buttons are disabled; click a row's
  Upload just before Upload N unsynced: that capture is still uploaded once. Open a row's Delete
  confirm, leave it open until Upload all reaches that row, then confirm: nothing is deleted and
  the row says it was busy. Since #127.
- [ ] **R9 — a partial upload is completed, not skipped.** In Directus, clear `directus_files_id`
  on the `machining_force_analysis` row of a capture that has a `capture.mat` (it then shows
  "partial upload"). Press its Upload: expect no second operation row, no second analysis row, the
  `.mat` uploaded once and its link filled in on the same row (the live cache file link and file
  are untouched), and only then the row shows "Uploaded". Repeat clearing `live_cache_file`
  instead. Then Upload on a complete one is not offered. Also stop Directus right after an upload
  returns: the row must not show as uploaded without the check. Since #127.

### Desktop shell
- [ ] **R11 — Restart recorder.** Kill the backend (Task Manager): the Doctor's "Restart recorder"
  brings it back and the doctor goes green. While recording: it refuses. With the backend hung
  (not answering, still running): it asks first, default "Don't restart". The port is free after
  restart (no "address in use"). Since #125. — 2026-10-08, Claude (isolated copy of the installed
  0.1.34 with its own recorder; the restart was asked through the shell, not the button): partly
  run. During a recording and while it was being saved the restart is refused with the reason and
  the recorder is untouched; idle, it restarts in 2.4 s as a new process on the same port and the
  doctor is all green. Killing that recorder mid-recording: back in 3.1 s on the same port, the
  window was sent from Plot to Record, the banner offered the interrupted capture and Recover
  restored all 312,320 rows. The button itself was never on screen: it only shows when the doctor
  cannot reach the recorder, and the shell had already restarted it. The hung case is still to do.
- [ ] **R13 — update prompt and Help menu.** Publish a test release with notes: the prompt shows them
  as plain text with the releases link. Alt shows the menu bar; Help → Check for Updates, Report a
  Bug, Open Captures Folder (opens the capture drive), About all work; Ctrl+Shift+L/B/O work.
  Since #125. — 2026-10-08, Claude (isolated copy of the installed 0.1.34, menu items triggered
  through the menu, not with the mouse): partly run. Help has Connectivity Doctor, View Logs,
  Report a Bug, Open Captures Folder, Check for Updates and About, with Ctrl+Shift+L/B/O set.
  Check for Updates opens Settings > About and says "You're up to date"; Report a Bug and View
  Logs open their tabs. Not run: the update prompt (needs a test release), Alt, the three
  shortcuts by keyboard, Open Captures Folder and About.
  — 2026-10-08, DP at the rig (your own installed 0.1.34): Alt shows the menu bar and the keyboard
  shortcuts work. The update prompt still needs a test release.
- [ ] **R14 — loading orb in the packaged app.** Start the installed app: the "Starting the recorder
  backend…" splash shows the turning red/green/blue dotted orb, sharp (not blurred) at the PC's
  display scaling (100 % and 150 %). Sign in: the three dots of the Force App mark turn into the orb
  until the sign-in finishes, and the title doesn't move. Open a capture in Settings > Captures, load a
  cut on the Plot page and save a cut: each wait shows the orb, never the old ring. Switch
  Settings > General to light and back while something is loading: the orb's colours follow. With
  Windows "Show animations" off, the orb still turns, slowly. Since the loading-orb PR.

### Diagnostics page in the packaged app
- [ ] **P10 — recipe dialogs and import/export.** In the packaged app, Save as (name + notes),
  Rename and Delete use the in-app dialog (Escape closes, focus returns to the button). Export a
  recipe, Import it back: it opens in the Save dialog; importing a hand-broken file is refused with
  a reason. The "modified since loaded" badge appears after editing an applied recipe.
  Since #127.
- [ ] **P10 — searchable picker on real data.** With the full campaign list, search, the Needs
  build / Built / Error chips and Group by (sample, campaign) work; campaign names appear for
  cuts that belong to one; Open in Plot lands on that cut and Directus opens the analysis record.
  Since #127.

### Plot on real cuts
- [ ] **Octree pick and ring alignment on a real archived cut.** On a cut that has a live cache and
  both a Full and a Gridded octree: right-click a point in Full, then Show position in time; the
  marker lands on the matching force feature, and Show position on map from a chart puts the ring on
  the same spot (not offset or on a neighbouring turn). Repeat in Gridded. Do it with the auto crop,
  then after saving an official crop and letting both octrees rebuild, then after editing inner
  diameter or pulses per rev without rebuilding: picks and rings must stay aligned (they follow
  `d1_build.json`, not the edited row). Also on a cut whose live cache is decimated (more than
  `live_cache_points` samples) and with an official crop that starts between two cache samples, and
  one that starts before the cache's window: rings and picks must still sit on the same spot as the
  octree's points (the anchor is `revs_cs`, not a cache sample). An octree built before the manifest
  still works as before (and may drift after the edit). Since #129.
- [ ] **Touch long-press on a touchscreen.** On a touchscreen laptop or tablet: hold one finger on
  the map (Lite 2D, Lite 3D, Full) and on a Force chart for ~0.5 s. Expect the menu to open once, a
  little down-right of the finger (not under it), with the pick under the finger. A drag or
  two-finger pinch must still pan/zoom and never open the menu. Android Chrome: the menu opens once
  (no second browser menu); iOS Safari: no text callout or magnifier. Since #129.
- [ ] **X1 — Lite 3D height.** On a real cut, Lite 3D with Z = Fz shows height; picking a point and
  the linked marker land on the raised point. Since #123.
- [ ] **P2 — PNG/SVG export in the app.** Both downloads open, axes and units are right, a zoomed
  chart's ticks are distinct. Since #125.
- [ ] **P4 — difference vs reference.** Two passes of the same tool: Difference shows a sensible
  curve and mean/RMS only over the overlap of both crops. Since #124.
- [ ] **FFT overlay units.** With a filter profile on, the filtered FFT overlay sits on the main
  spectrum for an untouched band (both are "N rms" now). Since #125.
- [ ] **P6 — cutting metrics.** On a real turning cut with the operation sheet beside you: open
  Signal statistics (compute), then Cutting metrics. Check Fc, Pc and kc against a hand calculation
  from the sheet (vc = π·D·n/1000, Pc = Fc·vc/60, kc = Fc/(ap·f)) and the kc against the literature
  range for the material. Confirm the axis mapping per workholding and operation type on the rig
  (the owner's standard, the default, is Fc = Fx, Fp = Fz, Ff = Fy): pick the right mapping for
  each type and check it is remembered for that type only and the CSV `axis_map` matches (it
  holds the Fc/Ff/Fp axes as a key, e.g. `Fx/Fy/Fz` for the standard). Check that an OD cut
  (`MT-O`) uses the Diameter box unchanged for vc and that a facing cut (`MT-F`, also one with a
  saved crop) uses D at the window midpoint, matching the radial axis of the plots. Check "—"
  with a reason on an operation with no feed or depth, and on a milling op. Since #127 (new default and per-subtype
  memory: also #128).

### Re-checks for the 2026-10-08 fixes (#199, #200, #212 to #216)
Shipped in 0.1.35 (#217), so any build from 0.1.35 on will do. The issues were closed on
2026-10-11; reopen the one whose check fails.
The recorder side of #199, #200 and #214 was already checked on the rig on 2026-10-08 through the
branch's own backend; the items below are what still needs the app window and hands.

- [ ] **Before the first cut on the new build: look at the force limit and the cut-detect
  threshold.** Live values are now newtons (#212). They used to be the summed volts, 10 to 20
  times smaller on this rig, so a limit or threshold that was tuned by eye against the old live
  plot is now that much stricter. Set them from the real forces of the cut.
- [ ] **#212, #216: the force alarm trips.** Open Settings > Safety Alarms, set a limit (for
  example 100 N), turn on "Stop the recording when the force alarm trips", go back to Record,
  start an NI-DAQ cut and push on the dynamometer. Expect: the live plot and the Overview tiles
  read the same newtons as the summary plot afterwards; the amber warning at 80 % of the limit;
  the alarm at the limit; the cut stops with the alarm on top of the save dialog. Going to
  Settings first matters: the alarm used to stop working once the Record page had been left.
  Then press Alt and A during an alarm (R10).
- [ ] **#199: a rate the modules cannot run.** With the sample rate at 25,000 Hz press Start.
  Expect: no recording, a message that the modules would run at 25,600 Hz, the field changed to
  25600 and highlighted; a second Start records, and the saved cut says 25,600 Hz in Plot.
- [ ] **#200: clipping at 10 V on the NI 9234 modules (this is R5).** Set one channel to a small
  range and push it past half of that range. Expect: the red banner, tile and badge name that
  channel, and `channels_ranging.clipped` is true for it only. Then run auto-range after a cut:
  the suggested ranges put the peak at a third of the range or less (headroom 1.5, doubled
  because the modules read 5 of the amp's 10 V).
- [ ] **#213: a channel that is not on the chassis.** On the NI-DAQ page point the tacho at a
  module that is not fitted (or type such a name in the Record page's list). Expect: the Channels
  chip is red and names the input. Put it back: green.
- [ ] **#214: a folder you cannot write to.** Settings > General, choose
  `C:\Windows\System32\config` as the capture folder. Expect: refused within a second with
  "cannot write to", the folder setting unchanged.
- [ ] **#215: pulled cables.** On Record with NI-DAQ selected, pull the Lab Amp's network cable:
  the Lab Amp chip warns within about 10 seconds, and clears after plugging it back. Unplug the
  chassis: the NI-DAQ source greys out within about 10 seconds, and returns after plugging it
  back. Neither needs a visit to another page.
- [ ] **#216: remembered metadata (this is R1/R3).** Open Settings and come back to Record, then
  set Sample, Machine, Operator and operation type, quit and relaunch. Expect: all four are back,
  with the cut parameters.

### Left open by the 2026-10-08 rig run
Things the run found or could not settle, that are neither fixed by the branch above nor filed as
an issue yet. Each needs the rig, or a decision by the owner, before it becomes one.

- [ ] **A does not acknowledge on its own (R10).** A opens "Silence this alarm?" with "Keep
  alerting" focused, so A then Enter keeps the alarm; Silence has to be clicked. Decide whether
  that is wanted. If A should silence in one go, or A then Enter should, file it; if not, change
  the R10 item and the shortcut hint ("A: Acknowledge a safety alarm") to say what happens.
- [ ] **Lab Amp chip while the amp is busy.** The reachability check now gives up after 2 s
  (#215). With the amp plugged in, start and stop several cuts and switch RESET / MEASURE from the
  Lab Amp page while watching the chip. Expect: it never shows "not reachable". If it flickers,
  raise `PING_TIMEOUT_SEC` in `backend/app/labamp.py`.
- [ ] **Bulk delete is slow.** Deleting five captures took 39 s in a copy of the app with no real
  sign-in: each delete is instant and the waits (2 to 19 s) fall between them. Repeat signed in,
  on 5 to 10 real captures, and note the time. If it is still seconds per capture, file it.
- [ ] **A cut with no Sample is named SIM-CUT.** An NI-DAQ cut recorded without a Sample shows as
  "SIM-CUT" in Local Captures and on the local Plot page (the recorder's default `sample_name`),
  which reads as a simulated cut. Confirm on the rig and decide on a name ("Untitled cut", as the
  save dialog already says).
- [ ] **Tacho generator default.** `POST /nidaq/tacho/start` with no counter answers 500 on this
  chassis because the default is the device name `STAR_DAQ`; with `cDAQ1/_ctr0` it starts. Nothing
  in the app calls it today. Decide: take the chassis name from the enumeration, or remove it.
- [ ] **Lab Amp output 4 is scaled differently.** The amp's export has output 4 (y2) at 9.833 V
  for the top of its range where the other seven are at 10 V. If that is what it looks like, Fy2
  is recorded about 1.7 % low, because the app assumes one full-scale voltage for all channels.
  Look at the amp's web page (Outputs) and set it to 10 V, or tell the app per channel.
- [ ] **Tacho level above the module's range.** The tacho's high level is over 10 V: the NI 9201
  reads it pinned at 10.53 V. Edges are still clean (3,341 found in `20261008-132200-fdb783`), so
  RPM is right. Note the sensor's real output level; nothing to do unless pulses go missing.
- [ ] **The same input-range question on the tacho and aux channels.** #200 only judges the eight
  force channels against the module's input range. Check on the rig whether any aux channel can
  exceed its module's range, and if so whether it should be flagged too.
- [ ] **Free space on the acquisition PC.** C: went from 48.9 GB to 35.5 GB free during the run
  (the test data was 0.8 GB at most), and the drive is 96 % full. The recorder stops a cut below
  1 GB. Find what is using it and free space before long cuts.

Follow-up work from the review of the fixes, no issue yet (code, not rig checks; move to issues
when picked up):

- The recorder should refuse a channel that is not on the hardware itself, with a structured
  answer naming it. Today only the Channels chip knows (#213), so a direct API call still gets
  the raw DAQmx -200220 text.
- An unsupported sample rate should be flagged before Start, next to the above-maximum check
  (`/nidaq/max_rate`, `sampleRateIssue`), instead of by a refused Start that then rewrites the
  field (#199). With the default of 25,000 Hz every first Start on NI 9234 modules is refused once.
- Auto-range should take the DAQ's input limit as its own parameter rather than through a scaled
  headroom (#200).
- Done in 0.1.35's release notes: live values are newtons, so alarm limits and cut-detect
  thresholds set against the old live plot must be looked at (first item of the re-checks above).

### Earlier issues that need the rig (from the 2026-10-02 batch)
- [ ] **#84** Real DAQmx error text and codes (‑200077); whether the chassis or the module limits the
  rate; coerced rates on discrete-rate modules. — 2026-10-08, Claude (recorder API and DAQmx 24.5
  on the rig, app 0.1.34): FAIL on coerced rates, see #199. The NI 9234 runs at 51,200 / n Hz only
  and DAQmx rounds any other request up without an error (25,000 runs at 25,600), while the capture
  is stamped with the requested rate. The rest is OK: the modules limit the rate, not the chassis
  (NI 9234 1,651.6 to 51,200 Hz, NI 9201 500 kHz, chassis 26.7 MHz); rates outside that are refused
  with the structured 400 and no capture folder; raw codes are -200332 from 51,200 to 51,367 Hz,
  -200077 above, and -200220 for a channel not on the chassis, which ends as `error_kind: "start"`
  with the folder removed. The dialog and field focus in the app were not looked at. Coerced
  rates fixed in 0.1.35: re-check with the #199 item above.
- [ ] **#86** NI-DAQ hot-plug, and whether NI MAX simulated devices count as "present". —
  2026-10-08, Claude: only the plugged-in case was run. `/nidaq/devices` gives `simulated: false`,
  `hardware_present: true`, `nimax_simulated: false` for the real cDAQ-9178. Unplugging and an NI MAX
  simulated device are still to do.
  — 2026-10-08, DP at the rig: FAIL on hot-plug, see #215. With the chassis unplugged the NI-DAQ source did
  not grey out; it only changed after running the Connectivity Doctor. An NI MAX simulated device
  is still to do. Hot-plug fixed in 0.1.35 (#215): re-check it with the #215 item above. #86
  closed 2026-10-11.
- [x] **#109** Real Lab Amp latency. — 2026-10-08, Claude (through the recorder, 15 calls each):
  `/labamp/status` 0.57 s median (0.52 to 0.69; it asks the amp twice), `/labamp/sensors` 0.33 s
  (0.31 to 0.44), a MEASURE or RESET switch about 1.0 s; a plain GET to the amp takes 22 ms. The
  LabAmp page itself was not looked at.
- [ ] **#96, #101** Explorer reveal and network-drive behaviour on Windows. — 2026-10-08, Claude
  (isolated copy of the installed 0.1.34): FAIL on one case of #101, see #214. Choosing
  an existing folder the user cannot write to (`C:\Windows\System32\config`) never answers: no
  reply after 240 s, tried three times, the folder setting unchanged. Refused correctly: a missing
  drive and a new folder under `C:\Program Files` (400 with the Windows error, 0.1 s), and any
  change while a recording runs (409). #96: opening a folder outside the recording folder is
  refused with a reason. Not run: a real reveal in Explorer, the folder picker, a network drive.
  The non-writable folder is fixed in 0.1.35: re-check with the #214 item above.
- [ ] **#81** DAQ buffer overruns while a 12 GB finalize runs beside a live acquisition (held back:
  needs the chassis).
- [ ] **#90** Packaged NSIS build and the Tailscale update feed (held back). — 2026-10-08, Claude:
  the update path works (this rig took `ForceApp-Setup-0.1.34.exe` from the feed, see section C);
  the downgrade itself is still to do.

### Rig-day batch (2026-10-08, 0.1.35)
The issues were closed on 2026-10-11; reopen the one whose check fails.
- [ ] **#190 long cut links and keeps its crop.** Record a cut over ~6 min at 51.2 kHz (no .mat).
  Move both crop handles in the final summary and Save: the analysis row links with no .mat (no
  400), the status leaves "partial upload". Repeat with the network off: the dialog says the .mat
  was skipped (not "both files uploaded"); restart the app; Local Captures → the capture's plot
  shows the moved crop on the force plot and FRM; Retry upload (from the plot and from Settings →
  Local Captures) sends it. Moving the handles back to auto and saving clears it. Since #198 (0.1.35).
- [ ] **#185 leaving the Record page mid-cut.** During a real cut go to Plot and Settings for
  ~30 s and come back: the trace has no hole, the backend log shows one `/record/stream` socket.
  Let a cut end (duration or Stop from a pop-out) while on another page: on return the Save dialog
  is open with the finished trace, and the stream closes. A real gap (unplug the network briefly)
  shows as "no live data", not a straight line. Since #198 (0.1.35).
- [ ] **Safety alarms after navigating.** With a low software force limit, record once, visit
  Settings, return and record again: the alarm (and stop-on-trip, if enabled) still fires, and
  setup fields typed after the round trip are remembered after a restart. Since #198 (0.1.35).
- [ ] **#189 plots after hiding the window.** After a cut, minimise and alt-tab away for a minute,
  switch routes, come back: force, FFT, spectrogram and waterfall are drawn without touching the
  window slider. With the Save dialog open the force panel shows the whole cut and no window
  slider; it doesn't flip when the dialog closes. Since #198 (0.1.35).
- [ ] **#186 FFT on real data.** Live FFT at the real rate with 12 channels shows narrow peaks
  (tooth-pass and harmonics) and looks smooth; CPU and the UI stay responsive; spectrogram and
  waterfall keep up and hold a 60 s window. The Welch average now has fewer segments, so check the
  spectrum isn't too noisy to read. Since #198 (0.1.35).
- [ ] **#187 pop-outs reachable.** Open Live Force / FRM pop-outs, minimise them, Win+D, launch the
  app a second time: they restore. Save a pop-out on a second monitor, unplug it, relaunch: the
  pop-out and main window open centred and fully on the remaining screen. Save a window at
  2560×1440, reopen on 1920×1080: it fits, title bar reachable. A stale `/live/*` entry in
  `%APPDATA%\…\window-state.json` no longer hides pop-outs. Since #198 (0.1.35).
- [ ] **#67 RPM meter doesn't glitch.** During a real cut with the spindle speeding up and down,
  the RPM gauge's scale steps up at once and steps down only after a lower speed has held for
  about 3 s, with no flicker between scales; the sparkline doesn't jump with it. Compare with the
  screenshot in #67. Since #117 (gauge scale) and #198 (sparkline, 0.1.35). Issue closed
  2026-10-11; reopen it if the glitch is still there.
- [ ] **#188 RPM sparkline.** On a low-RPM CSS cut with a high target, the RPM panel's curve uses
  most of its box instead of a flat line at the bottom. Since #198 (0.1.35).
- [ ] **#135 backup URL.** On a rig with no saved backup URL, Settings → Backup shows the suggested
  URL with "Suggested — not saved yet"; Save with backups off does not store it (the Doctor stays
  quiet); enabling and saving stores it. A rig with a saved URL keeps it. Since #198 (0.1.35).
- [ ] **#136 move the Recording & Metadata panel.** The "move panel to the other side" button
  docks it right without panels falling below the bottom, also after resizing panels; the layout
  survives a restart. Since #198 (0.1.35).
- [ ] **#137 release notes.** After the 0.1.35 update, Settings → About and the update dialog show
  New / Improved / Fixed groups. Since #198 (0.1.35).

### Post-rig reports batch (2026-10-08, 0.1.36)
- [ ] **#192 Start next cut.** Record a cut, save it, choose Open in Plot and come back: Start reads
  "Start next cut"; the next cut has sequence +1, an empty chips ref, new-edge off and a new Cut ID.
  Press "Clear for next cut" first instead: Start reads "Start" and the sequence moves on only once.
  Since #230 (0.1.36).
- [ ] **#194 long cuts get a v7.3 .mat.** Record past the v5 limit (about 6 min at 51.2 kHz with 10
  columns) on the rig PC: finalize writes `capture.mat` as MATLAB v7.3 in acceptable time and disk;
  the save dialog says so. In MATLAB, `load('capture.mat')` and `matfile` give the same DATA,
  VariableNames and metadata as a v5 capture; `process_force.m` bakes it. Upload the multi-GB .mat
  through Directus (check `FILES_MAX_UPLOAD_SIZE`, the Caddy body limit, and that the app doesn't run
  out of memory) and Bake it from the Plot page. If the .mat upload fails (pull the network
  mid-upload), the cut still reaches the database without it and the message names the .mat; Retry
  upload sends only the .mat and links it. The frozen backend loads h5py, and still starts (long cuts
  then get no .mat and a reason) with a conflicting `hdf5.dll` on PATH. With antivirus scanning the
  captures folder, a long cut's .mat still lands (the rename is retried). Since #230 (0.1.36).
- [ ] **#184 Start FRM now.** On a real cut where the detector stays silent ("Detect cut start" on),
  press Start FRM now: the FRM spiral starts from that moment, the Cut cell shows a time and
  summary.json says `cut_start_source: "manual"`. The button disappears when the detector fires
  first; a double press shows the refusal text. Since #230 (0.1.36).
- [ ] **#195 Re-assign channels.** Unplug or swap a 9234 module: the Channels pre-flight item fails
  naming the missing ports, Re-assign maps to the real `cDAQ1ModN` ports, and is refused during a
  recording. A fresh config with no force channels bound warns the same way. Since #230 (0.1.36).
- [ ] **#197 update notifications.** Packaged app: a toast when an update has downloaded and the
  window is minimised or behind another window, and clicking it brings the app forward. After
  install, `schtasks /query /tn ForceAppUpdateCheck` shows a logon and a daily trigger with no UAC
  prompt. With the app closed and a newer version on the feed, the scheduled run shows a toast and
  no window or backend; clicking it opens the app. With the app running, the scheduled run exits
  without touching the window. Turning the toggle off in Settings > About removes the task;
  uninstalling removes it too. On a PC where policy blocks creating the task, the toggle says
  "Couldn't set up the scheduled check" and doesn't stay ticked. Since #230 (0.1.36).
- [ ] **#197 update prompt (packaged app).** With an update downloaded while the sign-in page is
  showing, typing the password shows no dialog and keeps focus. After sign-in the in-app card
  appears in the corner; Enter in a text field does not install; "Not now" hides it until the next
  launch while Settings → About still offers the install; during a recording the card stays hidden.
  "Restart and update" installs and relaunches. With the window minimised when the download
  finishes, the taskbar button flashes until the window is focused. Help → Check for updates while
  offline after a download keeps the card and "Restart and update" working. A page pop-out window
  shows the same card and its "Installing…" state. On /record the card sits bottom-centre and
  covers neither Start nor Stop with the panel docked on either side. Since #230 (0.1.36).
- [ ] **#108 pop-out settings survive a relaunch (packaged app).** Change the mode, channels or
  colour map inside a Live Force / FRM / Polar pop-out, quit, relaunch: it reopens as changed.
  Since #230 (0.1.36).
- [ ] **#193 log colours.** Settings → Logs with a real backend log: the type colours and the Type
  filter read well in light and dark. Since #230 (0.1.36).
- [ ] **#191 loading screens.** On the Plot page against d1-server, Figure, Lite, Full and a
  filtered single pane show the same centred loading veil (Full keeps a corner pill while it
  streams). Since #230 (0.1.36).
- [ ] **Electron 44 in the packaged app.** 0.1.36 is the first installer built on Electron 44
  (`electron-builder.yml` was still pinned to 43 after the dependency bump). Install it on the rig
  PC: the app starts, signs in, records a cut, opens pop-outs and updates itself. Since #230 (0.1.36).
- [ ] **#30 settings scroll.** On the rig PC, switching Settings tabs no longer animates or jumps
  (fixed in 0.1.33; issue closed 2026-10-11, reopen it if it still happens).

### Rig test requests, phase 1 (rig test requests PR)
- [ ] **First request on the rig.** Set `RIG_TEST_ALLOWED_LOGINS` on the relay (§C), install the
  release on the rig, and open an issue with a `rig-test` block naming two backlog items, then add
  the `rig-test-request` label. Within about a minute the app shows "Your admin has requested tests
  on this rig" with your login, the items and "about N min, 2 steps need you". Run now: the issue
  gets a progress comment and `rig-test:running`. Answer both questions: the result comment lists
  each item with its answer, and the label becomes `rig-test:done` (or `partial`).
- [ ] **Not during a recording.** Start a recording, then add the label to a request: only a badge
  appears on the Settings item, and the Record page is never covered. After the cut is saved, the
  dialog appears. Accepting while a capture is uploading is refused, and the prompt says why.
- [ ] **The operator can do the checks during a run.** Phase 1 does not lock the rig, so with
  a run open, ask for an item that needs a recording, such as #185. Minimise the modal: the bottom
  bar shows the step and the time left, and a recording starts and saves as normal. A question
  that arrives during the cut shows only on the bar ("Waiting for you — after this cut"). The
  modal opens once the Save dialog is closed. Throughout, keyboard focus stays in the Save
  dialog, and Tab never reaches the rig-test window.
- [ ] **Accept is refused while busy.** Accept while a large .mat is uploading to Directus: it is
  refused, and the prompt says why. After the upload, the result comment shows the operator's
  initials only (never a full name, email or Windows PC name) and the app
  version. The rig id is `FORCE_APP_RIG_ID`, or `rig` if that isn't set.
- [ ] **Pop-outs and reloads.** With a Live Force pop-out on a second monitor, a new request gives
  one prompt and one Windows notification, both from the main window. This holds after a restart
  that reopens the pop-out. Reloading the app mid-cut does not bring up a prompt over the Record
  page. Many requests in a row don't pile up notifications, and notifications clear when the app
  window gets focus.
- [ ] **Cancel and no answer.** Cancel during a question: the run ends as `cancelled`, and the
  issue says so. In a second run, leave a question unanswered past its countdown (5 min for a
  short question, 15 min for an item written only as prose): that step is `no response`, the
  steps after it still run, and the report lists it as not run. The countdown on screen matches
  when the step really ends.
- [ ] **Result kept until the relay is back.** Pull the network just before the last answer. The
  run ends, and the result comment appears on the issue within a minute or two of the network
  coming back.
- [ ] **Snooze and decline.** "In 30 min" brings the prompt back in 30 min, and the issue gets
  `rig-test:deferred`. Decline with "Someone else is using the machine": the issue gets the
  reason and `rig-test:declined`.
- [ ] **Only the rig answers.** The same release on an office PC, with no NI-DAQ hardware, never
  shows the prompt. Settings → Rig tests on that PC says why, and the relay reads "not checked
  yet". Settings → About on the rig shows the rig id.
- [ ] **Windows notification.** With the app minimised or behind another window, a new request
  flashes the taskbar button and shows a Windows notification.

### Release pipeline (CI/CD overhaul)
- [ ] **NI-DAQmx detection on a PC without the driver.** Install the packaged app on a Windows PC
  with no NI-DAQmx driver (not the rig). Connectivity Doctor / self-check shows "NI-DAQmx runtime
  not available", not "driver detected"; starting an NI-DAQ recording and *Start tacho* answer
  "not available" instead of an internal error. On the rig, the same checks still report the
  driver and record normally. Since #138 (CI/CD overhaul). — 2026-10-08, Claude: rig half OK on
  the installed 0.1.34 (doctor: "NI-DAQmx driver detected", "1 device(s) detected: cDAQ1", healthy;
  two NI-DAQ recordings ran to `done`; the tacho generator started on `cDAQ1/_ctr0`). With no
  counter given it answers 500, because the default is the name `STAR_DAQ`. The PC without the
  driver is still to do.

## C. d1-server and infrastructure

- [ ] **Rig test relay settings.** In the relay's environment on d1-server, set
  `RIG_TEST_ALLOWED_LOGINS=dpremoli,dennis-premoli-staff` (GitHub logins allowed to request rig
  tests). No token: callers sign in with D1. Remove any leftover `RIG_TEST_RELAY_TOKEN` line from
  `.env`, and delete `%LOCALAPPDATA%\force-app\rig_test_token` on any PC that has one. Redeploy
  `bug-report-relay` (`docker compose up -d --build --no-deps bug-report-relay`). Optionally set
  `FORCE_APP_RIG_ID` on a rig laptop; without it the rig id is just `rig`. Check:
  - `GET /bug-report-relay/rig-tests` over Tailscale with no `Authorization` header, or with
    `Authorization: Bearer made-up`, is refused with 403 `D1 sign-in rejected`. With a real D1
    access token (copy one from the force app's DevTools, `localStorage['force-app.auth']`) it
    returns `{"ok": true, ...}`, and the relay log names that D1 user. Treat that token as a password:
    do not paste it into chat, tickets or logs; it expires within 15 minutes.
  - Stop Directus for a moment: the same call gets 503 `D1 unavailable`. Wait more than 60 s after
    the last accepted call first, or use a freshly copied token: accepted sign-ins are cached for
    60 s, and a cached token never reaches Directus.
  - An issue that an allowlisted login both wrote and labelled is listed. One written by anyone
    else is not, even if you label it.
  - A comment through `POST /rig-tests/<n>/comment` on an issue without the label is refused.
  - An attempt to PATCH the rig's result comment is refused.
  - On a laptop plugged into the rig, signed in online: Settings → Rig tests says the PC takes
    requests. Signed in but offline: it says "Sign in to D1 online to receive rig-test
    requests", and the PC never polls. Left idle on the rig for more than 15 minutes, it keeps
    taking requests (the token is refreshed early).
  - An issue with more than 100 events, for example one with many label changes, is still
    listed, because the latest labeller is found from the last page.

  Since the rig test requests PR; sign-in check since the D1 login PR (#248).
- [ ] **#190 migration 140 on d1-server.** Apply `20261008000140_machining_force_analysis_file_nullable`
  (`dbmate up`). Directus accepts a `machining_force_analysis` POST with `directus_files_id: null`
  and the field isn't required in its form. Set such a row to `pending` by hand with the
  orchestrator daemon running: it comes back `done` with the "needs an archive .mat" message and its
  `series`, `live_cache_file`, `live_render_points` and `matlab_version` unchanged. Since #198 (0.1.35).

- [ ] **Official crop reaches the octree and grid builds; `d1_build.json` is published.** On
  `d1-server`, in the Plot page save an official crop on an archived cut that has Full and Gridded
  octrees; let the orchestrator rebuild both. Check `<OCTREE_DIR>/<op>/d1_build.json` and
  `<OCTREE_DIR>/grid/<op>/d1_build.json`: `schema` 1, `crop_source: "override"`, `cut_start_sec` /
  `cut_end_sec` equal the saved crop (index / sample rate) to a sample, and `feed`, `diam`,
  `inner_diam`, `ppr` match the row, and `revs_cs` is present (the cumulative raw revolutions at
  the window start: it equals the live cache's `revs` at that sample for an undecimated cache).
  Reverting to auto crop and rebuilding gives `crop_source: "auto"`. Save a different crop while a
  build is running: when it finishes the row goes back to `pending` and is rebuilt with the new crop
  (no stale octree left as `done`). Stop MATLAB's JSON from being written (or break the file): the
  build ends `error` with a "build manifest missing" message and the previous octree stays served. Also run `scripts/matlab/test_octree_out.m` by hand in MATLAB (it asserts
  the crop window and the JSON; the MATLAB changes have never been executed). The Full view then
  shows the saved window, matching the charts. Since #129.

- [ ] **Diag clustering is CPU-independent.** Rebuild a diagnostics analysis on `d1-server` for a cut
  built before 2026-10-06: cluster ids match the old result. (`scripts/diag/spatial.py` pins
  HDBSCAN's tie order; the goldens pass with and without AVX-512, but the server's CPU decides
  which side old results were built on.) Since #123.
- [ ] **filter-service `/fft` change deployed.** After redeploying the plugin, the Plot overlay reads
  in N rms (see the FFT check above). Since #125.
- [ ] **P10 — batch diagnostics build on d1-server.** In Diagnostics, tick 3 or more analysed cuts
  (at least one already built with the default recipe), Apply recipe to selected with a library
  recipe. Expect: the summary says queued / skipped; the orchestrator daemon processes every
  queued cut in turn until each shows built; no cut is queued twice. Since #127.
- [ ] **P10 — skipped cuts really match.** Apply the same recipe again to the same selection:
  everything is skipped as "already built with this recipe" and `diag_recipe_hash` /
  `updated_at` on those rows do not change. Then tick *Rebuild*: they requeue. Since #127.
- [ ] **P10 — build permissions by role.** As a Lab Member, Apply recipe to selected queues builds
  (Lab Member can update `machining_force_analysis`, migration 111). As a role with read-only access
  to analyses, it stops on the first item with "your role can't request builds" and nothing is queued. Since #127.
- [ ] **#80** MATLAB run on the d1-server orchestrator and Directus asset download (held back).
- [ ] **#10** Figure-mode PNGs re-baked by MATLAB for cuts with a saved crop (held back).
- [ ] **#97** Tailscale serve, phone access, live-DAQ load (held back; security model is an owner
  decision).
- [x] **First automated force-app release reaches the rigs.** After the CI/CD overhaul merges, the
  `force-app-release` run on `main` publishes Force App 0.1.34 (tag moved from the failed run's
  commit). Within ~10 minutes `auto-publish.log` on d1-server shows it published, and a rig on 0.1.31
  is offered the update and installs it. Since #138 (CI/CD overhaul). — 2026-10-08, Claude: OK,
  seen from the rig. GitHub release published 00:46:27 UTC, on the feed at 00:49:44 UTC; this rig
  downloaded the installer at 12:57 local (SHA-512 equals `latest.yml`) and runs 0.1.34.
  `auto-publish.log` and the version the rig had before were not looked at.
- [ ] **Redeploy the backup server (mark-deleted).** The `backup-server` container on d1-server is
  older than the tombstone routes: `POST /backup-ingest/sessions/<id>/mark-deleted` answers 404, so
  a capture deleted on a rig still reads as a complete backup (#91). Rebuild and restart it, then
  delete a capture on a rig: the recorder's answer has `remote_marked_deleted: true` and the remote
  list shows it as deleted. Found 2026-10-08 on the rig.
- [ ] **#223 Redeploy the bug-report relay (renamed repo).** Since the GitHub repo was renamed,
  every report failed with "GitHub rejected the report (HTTP 307) Moved Permanently" (the relay's
  own message; the Directus form in #223 isn't in this repo but reaches the same relay). Rebuild and restart `bug-report-relay` on d1-server, then
  file a test report from the app's Report a Bug screen: it answers with an issue link and the
  issue appears on the repo, and the "already reported" list loads. Since #232.
- [ ] **Branch protection requires "CI passed".** In GitHub *Settings > Branches*, `main` requires
  the **CI passed** check. A PR with a failing job cannot merge. Since #138 (CI/CD overhaul).

## Done

(Move ticked items here with their date and result.)
