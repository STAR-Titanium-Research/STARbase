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
configuration the migrations carry every metadata change, so there is nothing else to apply. Restart Directus so new
extensions load and its cache is fresh (`docker compose restart directus`), then sign in as each role named in the step.
Directus here caches schema and permissions in memory (no `CACHE_*`/Redis settings), so a restart clears them; Redis holds the rq queues of heavy-data-worker and analysis-worker, so do not `FLUSHALL` it.

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

### Form blockers (migration 173, `fix/form-qa`)
- [ ] **F1 — Test session saves from the form.** As a Lab Member, in STARbase (the framed form) and in
  Data Studio: new Test Session, pick a Test Type, Subject → Add Existing → one of your samples, Save.
  It saves (before: "Sample / Workpiece (Hidden): Value is required"), and the saved test's sample is
  the subject.
- [ ] **F2 — Imaging / Analysis campaign.** New Campaign, Campaign Type → Imaging / Analysis, a name,
  Save. It saves (before: "An unexpected error occurred", HTTP 500).
- [ ] **F3 — Owner shows a name.** Open any sample, operation, test, campaign, tool box, insert, recipe
  and a project. Owner (Principal Investigator on a project) shows the person's name in a dropdown,
  not a UUID in a text box; changing it as the owner saves. The dropdown has no "create new" (a new
  login-less owner locked the creator out of the record). The Directus log has no warning about
  `d1-owner-picker` after the leftover `core/extensions/d1-owner-picker` folder (no package.json,
  empty dist) is deleted from the live checkout.
- [ ] **F4 — Machining sub-type.** Open an operation imported from the experiment sheets (sub-type
  MT-F). Operation Sub-type shows "Turning – Facing", not blank. A new milling operation offers the
  Milling – … choices and its code keeps the bare letter (…-S1-…).

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
- [ ] **#247-L5 — Label templates — permissions apply.** After the migration, restart
  Directus: the rules above then hold, with no 403 on reading `label_templates`.

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

### Explorer pages (STARbase)
These checks were written when the pages were the Directus Home module (`d1-home`, removed in phase 1
of going headless); the addresses now are STARbase's. Restart Directus after `npm ci` and
`npm run build:extensions` at the repo root so the rebuilt `d1-lab-dashboard` and
`d1-composition-bar` load, and apply migrations 138 and 139.

- [ ] **PP1 — Project page cards match the index; empty Activity is a lid.** Open a project with a campaign and equipment
  on its operations (for example macrozone cubes), in light and dark. Expect: the campaign card in **Campaigns** looks the
  same as on the Campaigns list in Cards view (white, rounded, shadowed); each **Equipment used** tile is white too and its
  name is a link that opens that equipment's page. On a project whose operations and tests are all undated or older than 26
  weeks, **Activity** is a single lid with a 0 and "No operations or tests in the last 26 weeks.", and "On this page" lists
  it dimmed with 0. With recent records it shows the chart, a count chip and a normal "On this page" row. Since: Project
  page visual consistency (PR pending).
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
- [ ] **E1 — landing module after login.** *Superseded by headless phase 1 (migration 171): Directus
  no longer has a Home module.* Sign in as a Lab Member and as an admin from a fresh
  browser session. Expect: Home is the first icon on the module bar, Content (the Data Studio)
  follows the three dashboards. Note which page the app opens after login: Home (first module) or
  Content. If it is Content, Directus does not land on the first module; the spec's "app.after
  redirect" is then a follow-up decision. Check that a bar curated in Settings > Appearance that
  already listed Home keeps it, first. `dbmate down` removes Home and moves Content to the front.
  Since: Explorer pages E1 (PR pending).
- [ ] **E1 — module bar order.** *Superseded by headless phase 1 (migration 171): the bar no longer
  has Home, Force Analysis or FAST Analysis, and starts with the STARbase tile.* After migration 138 the bar reads Home, User Directory, File
  Library, Insights, Lab Dashboard, Force Analysis, FAST Analysis, Content, Settings (for a bar
  that had the shipped order), and every icon still opens its module. On a fresh install
  (`scripts/configure_all.sh`) the same order is created. Since: Explorer pages E1 (PR pending).
- [ ] **E1 — Sample page on real data.** Open `https://starbase.tail54eeb6.ts.net/samples/<id>` for a sample with a parent,
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
- [ ] **E1 — life strip grouped by day on a busy sample.** Open the Sample page of a sample with
  20 or more operations (e.g. `10-AA-MF-2023-3-31`). Expect: the life strip has one node per day
  for the operations and tests, labelled with the date and "N operations · M tests". Each node
  holds a chip per record, operations as `#<step>` in step order and then tests by type. Hovering a
  chip shows the full pass code (or the test's type and status), and clicking it opens that record's
  page. A day with more than 16 records shows "+N more", which expands to all of them and back with
  "Show fewer". Parents, this sample and children still have a node each. Operations with no date
  sit in one "Undated" node at the end. Check that the days are in date order and that the
  operation and test counts match the Operations and Tests tables. Check below ~640 px wide and in
  the dark theme too. Since: compact life strip (PR pending).
- [ ] **E1 — life strip folds the middle steps.** On the same busy sample, or one with a dozen
  days of operations, open the Sample page at full width. Expect: when the steps would not fit, the
  strip shows the start (stock, parents, this sample) and the latest steps without scrolling, with a
  dashed "N more steps" node between them. That node gives the hidden operation and test counts and
  their date range. Click it: every step shows, the first hidden one where the split node was, and
  the strip scrolls sideways. **Fold the steps in between** puts the split back. Resize the window:
  the split re-fits. Below ~640 px wide the vertical list shows at most 8 steps the same way. A
  sample whose steps fit shows no split. On a sample blended from many parents (six or more), the
  oldest parents fold into their own split and **This sample** stays visible. With the keyboard, Tab
  to a split and press Enter: focus lands on the first step it showed. Press Enter on **Fold the
  steps in between**: focus returns to the split. A screen reader reads each chip as its pass code
  (or test and status), not as "#17". Since: compact life strip (PR pending).
- [ ] **E1 — links from Home and the dashboards.** On Home, the recent-activity sample cards and, in
  the Lab Dashboard, "Open sample" and the timeline entries open the Sample page; operation and test
  links open their Explorer pages (E4).
  FAST runs on Home still open the FAST dashboard. Since: Explorer pages E1 (PR pending).

#### Campaign page (E2)
- [ ] **E2 — Campaign page on a real campaign with force data.** Open `https://starbase.tail54eeb6.ts.net/campaigns/<id>` for
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
- [ ] **E3 — Projects index.** Open `https://starbase.tail54eeb6.ts.net/projects` (Home > *All projects*). Expect one card
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
is built from the root with the other workspace extensions (`d1-fast-dashboard`, which this note once
named, was removed in phase 1 of going headless), and `d1-report` is rebuilt in its own folder (`npm ci && npm run build`).

- [ ] **E4 — parameters per process category on real data.** Open `https://starbase.tail54eeb6.ts.net/operations/<id>` for
  one operation of each category you have (machining, FAST sintering, heat treatment, deformation,
  additive, sample preparation). Expect: the Parameters grid shows only that category's fields, with
  the same labels and values as the Content form's panel, the unit after each measured value (the
  field's suffix: mm, rpm, kN, °C ...), select fields by their label (cooling method "Water quench",
  not `water_quench`), toggles as Yes / No, and a very small number readable (not "0"). Fields left
  empty are not listed. An operation with no process category says so. Sample preparation has no
  parameter columns, so it shows the empty line. Repeat for a test of each type you have (tensile,
  hardness, charpy, compression, SEM, XRD, tribology, fatigue, CT ...) on `https://starbase.tail54eeb6.ts.net/tests/<id>`.
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
  the sign-in page, then `https://starbase.tail54eeb6.ts.net/samples/<id>` (the Explorer page, usable on a phone). An old
  printed label (encodes `/admin/content/physical_samples/<id>`) still opens the Content form. The
  QR and the sample link on an operation report and a test report open the Explorer pages. Needs
  `PUBLIC_URL` set to an address the phone can reach. Since: Explorer pages E4 (PR pending). **Superseded by the Explorer labels page (PR #247).**
- [ ] **E4 — Force and FAST dashboards land on the Explorer.** In STARbase's Force plotter (`/plot/force`) use the "open
  record" action on an operation and on a sample: both open `https://starbase.tail54eeb6.ts.net/operations/<id>` and
  `https://starbase.tail54eeb6.ts.net/samples/<id>`, and Back returns to the dashboard. In the FAST plotter (`/plot/fast`) **Open** on
  a run opens the Operation page; opening the recipe still opens its Content form. Since: Explorer
  pages E4 (PR pending).
- [ ] **E4 — project items links and Process map.** In a project's Content form, the Project
  items panel shows operation and sample codes as links to their Explorer pages (equipment, tools,
  inserts and materials open their Content forms); as a role that cannot read some of the
  operations, those rows stay plain text and the panel still lists them. On a Sample page,
  the rail's **Process map** button opens the Process map (STARbase `/map`) on that sample, with its operations,
  tests and neighbours, and reloading the `/map?focus=physical_samples:<id>` URL does the same. Since:
  Explorer pages E4 (PR pending).
- [ ] **E4-fix — the subject trigger on real data (migration 139).** Apply the migration to the
  real database (`dbmate up`) and check the back-fill: `SELECT count(*) FROM test_sessions t WHERE
  t.sample_id IS NULL AND EXISTS (SELECT 1 FROM test_sessions_subject s WHERE s.test_sessions_id =
  t.session_id AND s.collection = 'physical_samples')` returns 0 (unless such a subject names a
  sample that no longer exists). Then create a test through the Content form, picking a sample in
  Subject. Expect, for that new test: `sample_id` is filled in the table; it appears in the
  campaign's matrix on the Campaign page (if the sample is in the campaign); the sample report
  (Generate PDF) lists it under tests; the Process map (STARbase `/map`) and the Sample dashboard
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
(`docs/runbooks/upgrade-2026-10-row-level-visibility.md`; `docker compose restart directus`) (it reads relations
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
  filtered `pass_code` is empty) and open `https://starbase.tail54eeb6.ts.net/operations/<id>`. Expect: the heading reads
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
  the tile opens the Explorer's Projects index (`https://starbase.tail54eeb6.ts.net/projects`), not the Projects
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
  Dashboards module is being retired (the Process map in STARbase `/map` replaces its lineage graph). Expect: Home's quick
  actions show no tile for either; on this install the lab dashboard is reachable only from its
  module URL until it is replaced (its module bar has `d1-lab-dashboard`
  and `ask-db` disabled). A fresh install differs: `scripts/configure_directus.sql` enables
  `d1-lab-dashboard` in the module bar, so there it is also in the bar; do not fail this item for
  that. Check that the Sample page's Process map button opens the map for the sample. Since: Explorer fixes F1, not
  yet in a PR.
- [ ] **Migration 20261010000160 on live: Lab Member queries stop returning 400.** Before applying,
  record `SELECT md5(string_agg(id||coalesce(permissions::text,'~'), ',' ORDER BY id)) FROM
  directus_permissions`. Apply, then `docker compose restart directus` (it caches permissions in memory,
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
  on the labels page. Open `https://starbase.tail54eeb6.ts.net/labels?codes=<a real code>,NOPE`: the real one is ticked and
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

- [ ] **A1a-D1 — Who has access dialog on real Directus.** Needs migrations 165 to 169, the `d1-record-access` and
  `d1-access-guard` endpoints and the rebuilt `d1-home`. As a Lab Member who owns a sample: **Who has access**
  opens, the add box finds people by name, a person with no login shows "can't sign in yet" and can still be added,
  a role change and Remove work, Transfer asks for confirmation and, once done, the Edit button and the rail owner
  follow the new owner. As a co-owner the list is read-only ("Only <owner> can change who has access."). On an
  operation or test of an unrestricted sample the sample's people appear read-only under "Also through". No page
  draws a Restrict switch. With no mail server the add says "Added. The email could not be sent." Then Home's
  "Your samples" and "Your projects" still list the records where you are a co-owner or Secondary investigator
  through the new access rows (the `mine.ts` filters send `access` as two bare paths; if Directus answers 400 or 500
  there, say so). Campaign pages say "Some samples in this campaign are hidden from you." with no number.

- [ ] **A1a-P1 — Two-user record access check (after the cutover).** Needs two Lab Member accounts (call them
  Ada and Ben, with working mailboxes) and an admin, the A1a migrations applied, Directus restarted, and mail set up.
  1. As Ada create a scratch sample; Ben cannot see it unless he is in its project. As Ada open **Who has access**, add Ben
     as **Can view**: an email reaches Ben naming the sample and Ada, with a link that opens the sample page; the dialog lists
     Ben. Ben sees the sample and cannot edit it; Ben's dialog shows the list read-only. Change Ben to **Can edit**: Ben can
     edit, no second email. Remove Ben: he loses the sample at once (refresh), no email.
  2. Add a person who has no login: the dialog says "can't sign in yet" and still lists them. An admin links their login
     in People; they can now see the sample. Their grant needed no new entry.
  3. **Transfer** the sample to Ben: the confirm step names who stays; Ben gets the "transferred to you" email; Ada keeps
     access as Can edit; Ada can no longer add people.
  4. A co-owner can no longer add, change or remove co-owners (a deliberate change): try it and read the message.
  5. API only (no screen turns it on in A1a): until A1b only an admin can restrict. `PATCH /items/physical_samples/<id>
     {"restricted": true}` as the owner and as a Can edit person is refused (403, "Restricting a record is not available
     yet"); as an admin it works, and a stranger no longer finds the sample or its operations; Home counts and the
     Projects index drop it for the stranger, and the admin overview's **readers drift count is 0** afterwards. Clear the
     flag again (as an admin). A member can edit their own People row and gets a 403 on someone else's.
  6. **Ask the database**: ask for the scratch sample by code while it is restricted (no rows, as if it did not exist), then
     unrestricted (rows). Ask for a count of samples: it never includes restricted ones.
  7. The Force App still records and saves a cut on a sample you can see, and nothing in any UI shows the Restrict switch.
  Known and expected until A1b: a restricted operation's files and octrees can still be opened by anyone with their id.

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

- [ ] **FL-1 — Coupon Standard picker, in the form and on Register sample.** Rebuild and load `d1-geometry-preview`
  (`npm run build` in its folder), then open a new Sample in Data Studio and pick Geometry = Tensile coupon: the
  preview shows a **Standard** picker above the drawing (ASTM E8/E8M sheet, ASTM E8/E8M subsize, ISO 6892-1 type 1,
  type 2). Pick one: Length, Width, Gauge length and Gauge width fill in the form (the preview interface asks the form
  for it with `emit('setFieldValue', ...)`; check this works from inside the Geometry field group) and the drawing
  redraws; Thickness stays as it was. Edit a dimension: the picker goes back to the placeholder (Custom). Reload a saved
  record whose dimensions equal a standard: the picker shows it. Fatigue specimen offers ASTM E466 / ISO 1099 flat (typical values: check
  them against the lab drawings); Charpy specimen offers full size and the 7.5 / 5 / 2.5 sub-sizes, which also set
  Thickness; Bend bar offers the plain bar. Other geometries show no picker. Then the same on STARbase's Register sample screen (no longer auto-fills on picking the
  geometry). Save a sample after picking a standard: the values are stored. Since form layout stream C.
- [ ] **FL-2 — Labels, not codes, in STARbase and the PDF.** On a sample with Geometry Tensile coupon, Surface finish
  Medium machined (or As produced) and a machining operation with a sub-type: STARbase's Samples list, the Sample page
  (kind line, Surface finish), life strip, Home lists and the Equipment list (Type column and filter) show
  "Tensile coupon (ISO 6892)", "Medium machined", "Sample prep" and the like, never `tensile_coupon` or
  `Sample_Prep`; the sample and operation PDF reports (/d1-report/sample/<id>, /operation/<id>) do too, including the
  "Turning – Facing" sub-type cells. Since form layout stream C.
- [ ] **C-card-1 — Campaign cards match the project cards.** In STARbase open **Campaigns**, switch to **Cards**, and
  open **Projects** in another tab. The campaign cards sit on the page ground (no white panel around the grid), raised
  and as wide as the project cards, with the type tag and a coloured status pill beside the code, "Owner: …" (or
  "not set") and the dates (or "No dates set") on the meta line, then the counts and the progress bar. While the
  counts load they show dashes. Cards of one row share a height and rows do not overlap. Open a project with
  campaigns: its Campaigns panel shows the same card as a tile inside the panel. Check light and dark. Since
  branch `claude/serene-fermi-6nxf5e` (campaign cards follow the Projects design).

- [ ] **TOOL-1 — Tooling pages on real data.** In STARbase open **Tool boxes**, then a real box with inserts and
  edges. Expect: the box page with its insert type facts (ISO designation, manufacturer, coating, substrate, edges per
  insert), the four state counts (fresh, partly used, used, depleted) adding up to the inserts list, and a **Next fresh
  edge** card that links to the right edge (the lowest-numbered part-used insert's first fresh letter). Click an insert
  in the stage (or the inserts list): the page becomes that insert, with its details, notes and edge list. Click an
  edge: the page becomes that edge, with its tests and operations merged newest first, each opening its own page, and
  **View forces** on machining operations opening the Force plotter for that operation. Open **Cutting inserts** and
  **Insert edges** from the index pages: the rows open these pages. An edge marked fresh that has a test or operation
  shows "Marked fresh, but N tests or operations used this edge." (check one in the Data Studio first). On the box,
  the inserts list's last column shows "N marked fresh, but used" for an insert with such edges, and the insert page's
  Edges list shows the same warning per edge. Create a test whose subjects are **two edges of the same insert** (the
  Data Studio's test form, two insert edges as subjects): it must appear in the history of **both** edges, and count
  once for each in the box's warnings (an edge marked fresh with only that test still warns). Edit opens the
  collection's own form in the drawer and saving refreshes the page. Check light and dark. Since: tooling pages, S3;
  review fixes (test subjects through the junction).
- [ ] **TOOL-2 — Moving inside a box keeps the page.** On a real box, click insert, edge, then use the browser Back and
  Forward buttons. Expect: the address changes each time, the 3D view stays on screen and only the camera moves (no flash,
  no reload of the stage, the network tab shows no new read of the box's inserts or edges, only the clicked record and,
  for an edge, its history), and Back returns to the previous insert or the box. Going to another box (a link, or the
  address bar) loads that box. A box, insert or edge id you may not read (or made up) shows "Not found or not visible to
  you". Since: tooling pages, S3.
- [ ] **TOOL-3 — The 3D stage on a real GPU.** On a lab PC (light and dark theme) open a real box. Expect: the tray
  and inserts draw crisply with no jagged edges; the camera eases (about 0.4 s) to an insert and to an edge; the focused
  insert lifts out of its pocket; edge letters on the hidden underside are faded; the next fresh edge glows, pulses for
  about 2.4 s after each move and then rests at full strength (and does not pulse in a hidden tab); with the OS set to reduce motion, moves are instant and nothing pulses. The fan stays
  quiet when the page sits idle (no render loop at rest). Then turn WebGL off (Chrome `chrome://flags` → disable
  WebGL, or Firefox `webgl.disabled`) and reload: the 2D slot grid shows, with the same clicks and addresses. The
  stage is a tall tile in the left rail (about 360 px wide, up to 560 px tall); with a very short browser window it
  shrinks but stays at least 380 px, and under 1000 px of page width it sits above the panels. Since: tooling pages, S2;
  rail stage in #286.
- [ ] **TOOL-4 — Edge letters match the physical insert.** Take a used CNMG from a real box, hold it with the reference
  mark up, and compare with its insert page. Expect: A is the corner nearest the mark, B the next cutting corner
  clockwise, C directly under A and D under B, and the edges marked used on the page are the worn ones. Repeat with a
  single-sided insert (CCMT): only A and B. Since: tooling pages (lettering rule in `CONTEXT.md` › Tooling).
- [ ] **TOOL-5 — A real PCD box: one insert, one edge.** Open a real PCD (or PCBN) tool box that holds one tipped
  insert with one edge. Expect: the box is a small single case with the insert filling about 60 % of the stage; a
  lighter, shiny tip pad (silver for PCD, warm dark gold-grey for PCBN) shows on corner A, covering the nose and about
  3 mm of each side; there is no edge B and no other tipped corner; click the insert, then edge A: both work, and
  the next-fresh card points at A while it is fresh. Compare the pad with the real tip (which corner, how far along the
  sides). Check light and dark. Also open a normal 10-insert box: the grid is 2 columns by 5 rows, numbered left to
  right then down, filling the rail's tall stage. Since: #286 (tipped inserts and the tall side-rail stage).
- [ ] **SCAN-UI1 — Surface scans panel and Add dialog on real data.** As a Lab Member, open a real cutting insert and
  its edge in STARbase. Expect: a **Surface scans** panel under Details (empty at first: "No surface scan of this
  insert."). Press **Add a surface scan**: the dialog warns that the file becomes visible to every lab member; the
  file list shows real `.al3d` files from the library (an archive file also shows its path on the share), a file that
  is already a scan of this item is greyed out, and Add is disabled until a file and a condition are chosen (and a
  note when the condition is *other*). Save one scan of an edge, with a date and one of its operations: the dialog
  closes, the row appears as *Waiting to render*, then *Rendering*, then *Ready* without a reload, and its thumbnail
  loads (a height map, not a broken image). The insert page lists only the insert's scans; the edge page lists its
  own and the insert's, the latter tagged *Insert*. Add the same file to the same edge again from another tab: the
  dialog says it is already a scan of this item. Add a file that cannot be read (a renamed text file with an
  allowed ending): the scan shows *Render failed* with the reason, and **Render again** puts it back to *Waiting to
  render*. As a Lab Viewer, the panel shows the scans but no Add and no Render again. Check light and dark and a phone
  width. Since: surface scans, S3 (PR pending).
- [ ] **SCAN-UI2 — The surface viewer on a real scan and a real GPU.** On a lab PC, open a rendered real `.al3d` scan
  with **Open in 3D**. Expect: the surface draws within a second or two, with no jagged edge; dragging turns it
  smoothly and the wheel zooms (no panning, no way to lose the surface); the **vertical exaggeration** slider
  stretches the relief and Reset view restores the opening view; **Colour by height** switches between the ramp and
  grey; the legend's lowest and highest heights match the instrument's own (or the file's) values in micrometres; the
  size and pixel pitch under the view match the scan; cells the instrument did not measure show as holes (and are
  counted under the view). Compare the shape with the Alicona software's view of the same file. The fan stays
  quiet when the page sits idle. Turn WebGL off in the browser and reload: the view says it cannot draw and the facts
  remain. Since: surface scans, S3 (PR pending).

#### Process map card tweaks (plan `2026-10-14-process-map-4-card-tweaks.md`)

- [ ] **PM4-1 — Cards on a real turning sample.** Open `/map` on a sample with several turning passes (the
  `10-AA-MF-2023-03-31-F…` series). Expect: the passes in a row with the same method and machine are one card drawn as
  a deck (`×N` in the title bar, "N passes", first – last date); the title bar says "Machining | Turning" and never runs
  out of the card; a single operation's full code wraps inside the card under the title bar; there is no "Inside"
  label; Tool shows the tool's name (not `6576cc99`); Owner, Campaign and Material are chips like Machine and Tool.
  Since: Process map card tweaks (PR pending).
- [ ] **PM4-2 — Force data preview on its chip.** Hover anywhere on a Force data chip (icon, label or code). Expect:
  after a moment the card shows that pass's Fz figure, square and filling the card's width; hovering the operation
  card itself raises no card. Select the Force data chip: the rail shows the same square figure. Since: Process map
  card tweaks (PR pending).
- [ ] **PM4-3 — Unstack, ＋/− and Reset.** On the stacked card press **Unstack N passes**: each pass becomes its own
  card, in order, wired one into the next. Turn the **Stack passes** Show chip off and on: the stack comes back.
  Press ＋ on a Tool chip: the tool's other operations appear and the button turns to −; press −: they go and the
  map is as before. Press ＋ on a sample card, then **Reset**: the map is back as first opened, with no new request
  in the network panel. The map uses the full width of the window and its full height. Since: Process map card
  tweaks (PR pending).
- [ ] **PM4-4 — Hover follows the chain choice; dashed outlines at any zoom.** Right-click a card, pick **Show
  upstream**, then hover other cards: each lights only what its samples came from. Pick **Show downstream**: hovering
  lights only what came after. Zoom all the way out and all the way in on a map with a probable batch and a project
  frame: their dashed outlines look the same thickness on screen at every zoom. Since: chain hover and outline fix
  (PR pending).

- [ ] **PM4-5 — Wires in the PNG and PDF export of a large map.** Open `/map` on a campaign with many samples (for example
  Campaign 10), where the export used to show wires cut along a straight horizontal or vertical line (top and left of
  the picture's map origin, or past its right and bottom). Export ▾ → PNG and PDF. Expect: every wire is drawn from its
  start to its end, including the fan from the campaign card. Do it once with a card selected (the unrelated cards and
  wires dimmed): the dimmed wires show faintly, not missing. Since: process map export clips wires (PR pending).

#### Process map edit mode (plan `2026-10-14-process-map-edit-mode.md`)

- [ ] **PME-B1 — STARbase's generated form on real field definitions.** In edit mode, select a draft operation, a
  draft test and a draft sample in turn (the rail's form). Expect, for each: the Field groups of Data Studio's own
  form as headed sections in the same order (What, Who & where, then the type groups), only the groups of the chosen
  process category / test type / geometry, Related records and Legacy / system hidden on a new item, required fields
  starred, units after the numbers (rpm, mm, °C), choices with their readable text (Machining sub-type "Turning –
  Facing"); Material, Method, Equipment, Owner and Input sample are pickers that show the code or name (not an id),
  search as you type and list only what your role may read; a field the form cannot draw (data file links)
  shows its value and **Open in Data Studio**; Process Category and the operation code show as read-only text. Change the category: the groups
  swap live. Check light and dark. Since: Process map edit mode, stream B (PR pending).
- [ ] **PME-B2 — Sample picker over the map.** Press **Pick samples** in edit mode. Expect: the Samples list opens
  over the canvas with its search, saved views, filters and paging; typing, filtering and paging do not change the
  map's address (`edit=` stays); a click on a row ticks it and opens nothing; a sample already on the canvas is
  greyed "already added"; select all ticks the page (not the added ones); the button reads "Add N samples". Confirm:
  the picked samples arrive on the canvas (the rows' on-screen positions are what the fly-in starts from). Since:
  Process map edit mode, stream B (PR pending).
- [ ] **PME-D2-1 — My drafts on Home and Build a process in the sidebar.** With `d1-build` deployed and two drafts of
  yours (and one of someone else's): Home shows **My drafts** under "Waiting for you" with only your two, newest
  first, each with its name, "2 operations, 4 samples" and the date; a click opens `/map?edit=<id>` in edit mode.
  With no drafts, or on a server without `d1-build` (before the migration), the block is not there at all and Home
  is otherwise unchanged. In the sidebar, Analysis lists **Build a process** under Process map: it is lit only while
  the map is in edit mode (and Process map is not lit then), a click opens a blank canvas, and it can be pinned.
  After opening it, **Frequently used** lists it (the usage endpoint accepts the `build-process` key). Since: Process
  map edit mode, stream D2 (PR pending).
- [ ] **PME-D2-2 — Mark done dialog on real records.** On a planned operation (a cut with 4 rows) and a planned test,
  press Mark done. Expect: the date is today and **Done by** is your own People row, with a picker that lists only
  the people your role may read; Tab and Shift+Tab stay inside the dialog, Escape closes it and focus returns to the
  button; Mark done sends one request for every row of the card. On a done-required field left empty (a required field
  of the form) the server's refusal is listed in the dialog, nothing is marked, and the dialog stays open. Since:
  Process map edit mode, stream D2 (PR pending).
- [ ] **PME-D2-3 — Rail form details on real field definitions.** Select a draft operation, a new draft sample and an
  existing (planned) operation. Expect: the Process Category and, on the existing record, the operation code show as
  read-only text (not "Open in Data Studio"); no code, wire, work-state or batch field is asked for on a new item;
  values a new output sample inherits (material, form) show greyed with an "inherited" tag and typing replaces them;
  the compact form of a container shows only its key settings (machining: cutting speed, feed, depth of cut,
  coolant). Clear a field you filled (a feed rate) on a new item: it is empty and Create does not send it. Clear a
  field of an existing planned operation: it shows empty, and after Create the record's field is empty too. An
  existing sample's Status is not offered (d1-build refuses it), and the date done is not offered on a planned
  operation or test. Since: Process map edit mode, stream D2 (PR pending).
- [ ] **PME-D1-1 — Build a cut on the canvas, with the mouse.** Open a real sample's map and press **Edit**. Click the
  sample's output socket: the menu lists the manufacturing methods by process category (as in `manufacturing_methods`)
  and the test types; type "wire", Enter. Expect: a Wire cut container appears wired from the sample, with a free
  output; **＋ output** adds rows (3 clicks, 4 rows); dragging each row's output into empty canvas offers New sample /
  Same sample / Existing sample…; New sample makes a draft sample card. Drag a wire onto a socket that does not fit
  (an input that already has a sample): the socket goes red with the reason as a tooltip and nothing is wired; onto one
  that fits: green, and the wire is made. Cards you drag stay where you drop them after the next addition and after
  reload of the draft; **Re-layout** moves them all back (one undo step). Right-click on empty canvas and the lid's
  **Add** open the same menu with Templates (empty until the templates slice), methods and tests, New sample and Pick
  samples. Since: Process map edit mode, stream D1 (PR pending).
- [ ] **PME-D1-2 — Pick samples and the fly-in on a real list.** **Pick samples** with a saved view applied, tick 4 rows
  (one of them on page 2), Add. Expect: the cards fly from their rows to a column at the top left of the canvas, 40 ms
  apart, the one picked on another page only fades in; the draft's project becomes the first sample's project (shown as
  the project frame). Ctrl/⌘+Z plays it backwards and takes all 4 away in one step, Ctrl/⌘+Shift+Z brings them back. With
  the OS setting "reduce motion" the cards only fade (150 ms). A sample already on the canvas is greyed in the picker.
  Since: Process map edit mode, stream D1 (PR pending).
- [ ] **PME-D1-3 — Keyboard only.** Without the mouse: Tab to a sample's output socket, Enter opens the menu (arrows,
  Enter choose), **C** opens Connect to… (type a code, Enter wires); Shift+A opens the menu at the pointer; select a
  draft card and press Shift+D (a copy), Shift+Ctrl/⌘+D (asks how many, Enter), Delete (the card and its wires go); the
  keys do nothing while typing in a field of the rail form. Existing records: Shift+D on an existing sample makes a
  new sample with the same details and no code. Since: Process map edit mode, stream D1 (PR pending).
- [ ] **PME-D1-4 — Create, the toast and Mark done in view mode, on real data.** Build a cut with 4 planned outputs
  (project defaulted from the sample), fix what Checks lists, press **Create 1 operation, 4 samples** (the button says
  what it will make, and "N things missing" while something blocks). Expect: edit mode closes, the first new sample is
  focused (planned, ghosted), the toast offers **Print labels for 4 new samples** (`/labels?ids=…` lists the four) and
  the draft is gone from My drafts. A Create that the server refuses with Checks leaves the draft, shows the reason under
  the button and marks the empty required fields. Then, in view mode (and in a window under 768 px), select the planned
  cut: **Mark done** is in the rail, asks the date and who, marks all 4 rows in one request and the map reloads with
  solid cards. Open `/map?edit=new` on a server where `d1-build` is not deployed: the panel says "Building processes
  isn't available on this server yet." and the map still works. Since: Process map edit mode, stream D1 (PR pending).
- [ ] **PME-D1-5 — Edit mode in a real browser: typing, zoom, focus, lost connection.** On a real sample's map in edit
  mode: (a) type a long value into a field of a new operation's rail form: the map does not re-lay out or flicker while
  you type (cards keep their places), and a value that makes the card taller (a long note shown in the card) makes room
  once you pause. (b) Zoom the map out to about 50 % and use **Pick samples**: the cards still fly in from their rows (not
  from far off). (c) Create, with a screen reader or just Tab: focus lands on the toast (its labels link), the toast stays
  while the map reloads, and Dismiss puts focus back on a card. (d) Delete a draft card with the keyboard: focus stays on
  the map. (e) With the Mark done dialog or the Finder (Ctrl+K) open, Delete, Shift+A and Ctrl+Z do nothing to the draft.
  (f) Turn the network off (DevTools offline) after a change, press **Done editing**: you stay in edit mode and the page
  says "Your last changes are not kept yet"; turn it on and **Done editing** again leaves, with the change kept (see it in
  My drafts). Press Space on a free socket button and on a wired socket: the menu opens each time. A card with only a
  warning (no machine yet) wears an amber badge, a card with a blocking check a red one. Since: Process map edit mode,
  stream D1 review fixes (PR pending).

#### Process map edit mode, server side (migrations 189 and 190, `d1-build`; plan `2026-10-14-process-map-edit-mode.md`, stream A)

The `d1-build` endpoint has unit tests with a fake database and a fake ItemsService; what they cannot show is Directus
itself (its permissions, hooks and the real code triggers inside one transaction). Run these on the local stack with a copy
of the live data, after `dbmate up` and a Directus restart. The calls below use the API (replace `$TOKEN` with a Lab
Member's static token, or sign in through STARbase and copy the session cookie); once the canvas editor is merged, the same
checks can be run from `/map?edit=new`.

- [ ] **PM5-1 — Migrations 189 and 190 on a copy of live.** `dbmate up` applies both; `dbmate down` twice, then `up`.
  Expect: every existing operation and test has `work_state = 'done'` (`SELECT work_state, count(*) FROM
  manufacturing_operations GROUP BY 1`, same for `test_sessions`); in Data Studio an operation form shows **Work state**
  (read-only, Done), **Planned date**, **Done by** and **Marked done at** in "Who & where", and the sample **Status**
  dropdown has a blue **Planned** choice. After the `down`, a planned sample reads Archived and the Planned choice is gone.
  `d1_private.process_drafts` and `process_templates` exist and the Ask-DB role cannot read them. Since: edit-mode
  stream A (PR pending).
- [ ] **PM5-2 — Build and create a cut with four planned outputs, as a Lab Member.** `POST /d1-build/drafts` with a draft
  that has one existing sample, one planned operation (a cutting method, four rows) and four new samples wired to the rows
  (sample codes `{seq}-<alloy>-<method>-<date>`), then `POST /d1-build/drafts/<id>/check` (no blocking check) and
  `POST /d1-build/drafts/<id>/create`. Expect: 200 with four sample ids; four new samples with status `planned` and
  consecutive numbered codes; four operations with `work_state = 'planned'`, the same input sample and each its own output;
  one new batch (`B-nnnn`) shared by the four operations; `operation_sequence` and codes assigned; four `sample_genealogy`
  rows (`cut_from`); owner of every new record is your person; the project and campaign you put on the draft are on the
  operations and (campaign) the samples; the draft is gone from `GET /d1-build/drafts`; you can open every new record in
  STARbase; the audit log names you (not the system) as the actor of all of them. Print the labels (`/labels?ids=…`
  with the four ids): the codes print before the cut. Since: edit-mode stream A (PR pending).
- [ ] **PM5-3 — Mark done.** `POST /d1-build/mark-done` with `ids` of all four planned operations of the cut (date today).
  Expect: all four are `done` with `operation_date`, `done_by_person_id` (you) and `done_at` set, and all four output samples
  `active`, in one go (if one is refused, none changes); Data Studio shows the work state as Done. Mark them done again: 409
  `ALREADY_DONE`. A planned output with an empty required field (material, form) refuses with a `CHECKS` entry keyed by the
  sample's id; an operation on a sample that is still planned refuses with "Its sample is still planned; mark the operation
  that makes it done first." On a planned operation whose method has a field the form marks required and that is empty, the call is
  409 `CHECKS` naming the field and nothing changes. Since: edit-mode stream A (PR pending).
- [ ] **PM5-4 — Create rolls back as a whole when one record is refused.** Build a draft whose last operation is on a sample
  you may read but not edit (another person's sample), or whose method is refused by a Directus rule. `create` answers an
  error with `code: WRITE_FAILED` and the `key` of that card; afterwards no new sample, operation, batch or genealogy row
  exists (compare the counts before and after), and the draft is still listed with the same version. A draft with a blocking
  check (an operation without a method) answers 409 `CHECKS` and writes nothing. Since: edit-mode stream A (PR pending).
- [ ] **PM5-5 — Back to planned is the owner's call.** On a done operation owned by someone else that you can edit, set
  `work_state` to `planned` through Directus (`PATCH /items/manufacturing_operations/<id>`). Expect 403 "Only the owner can set
  a done record back to planned." and no change. As the owner, and as an administrator, the same call works; the audit log
  keeps both changes. A planned operation you can edit may still be set to done by you. Repeat for a test. Since: edit-mode
  stream A (PR pending).
- [ ] **PM5-5b — Mark planned.** As the owner, `POST /d1-build/mark-planned` with `ids` of the done cut: the four operations
  are planned again with no operation date, done by or done at, and their outputs are `planned` again. With a done hardness
  test on one of the outputs first, the call is refused (`REMOVE_BLOCKED`, naming the sample only if you can read it) and
  nothing changes. As a non-owner editor it is a 403 "Only the owner can set a done record back to planned."; as an
  administrator it works. Since: edit-mode stream A (PR pending).
- [ ] **PM5-6 — Drafts are private and versioned.** A draft made by one Lab Member is a 404 (not a 403) for another on
  `GET`, `PATCH`, `DELETE`, `check` and `create`, and is not in their `GET /d1-build/drafts`. Two `PATCH` calls with the same
  `version`: the second is 409 `CONFLICT` and the stored draft is the first one's. A draft that was created cannot be created
  again (404). Since: edit-mode stream A (PR pending).
- [ ] **PM5-7 — Removing planned work.** From the cut of PM5-2 (before marking anything done), a draft with the planned
  operation marked `remove` and `create`: the operation and its planned output samples are deleted, the others stay. With a
  test created on one of the outputs first (done), the same removal is refused with a blocking check naming the sample's
  code, and nothing is deleted. A done operation cannot be removed. Since: edit-mode stream A (PR pending).
- [ ] **PM5-8 — Templates in three scopes.** As Lab Member A save an operation template as private, one for your role and one
  for everyone. Lab Member B (same role) sees the role and global ones but not the private one; a user with another role sees
  only the global one. B cannot edit or delete A's templates (403); an administrator can. A template whose `method_id` is not
  a method is refused (400). Since: edit-mode stream A (PR pending).
- [ ] **PM5-10 — Form conditions of migration 191.** Open a **new** sample, a **new** operation and a **new** test in Data
  Studio (Create item). Expect: the **Related records** group is not shown on any of the three until the record is saved; after
  saving it appears (closed). On an operation form, the six legacy and capture fields (Legacy insert edge, Legacy machining UID,
  File storage pointer, Capture software, Capture frequency, NC program text) show only when they hold a value, and stay hidden
  when empty, including after you clear one and save. `dbmate down` once, reload the forms: the 174 behaviour is back (the group
  shows on new records, the six fields always show). Since: edit-mode stream A (PR pending).
- [ ] **PM5-9 — A large create is fast enough.** Create a draft of one cut with 20 rows and 20 planned outputs plus a
  hardness test on each (about 60 records). Expect `create` to answer in a few seconds, with the same checks as PM5-2, and the
  Directus data cache (if enabled) showing the new records straight away. Since: edit-mode stream A (PR pending).

#### Process map edit mode redesign, slice 1 canvas (`pm-redesign/1b-canvas`; plan `2026-10-18-process-map-edit-redesign.md`)

The canvas rules (removal, derived sockets, placement) are unit-tested against fake servers and a fake canvas. What needs a real
browser and the real stack (Postgres, Directus, the repo's extensions, STARbase) is pointer work, measured sizes and the server's
own answers. Run these on the slice-0 stack.

- [ ] **PM6-1 — Delete, X, Backspace take a new card or a wire.** In `/map?edit=new` add a sample and an operation, wire them.
  Select the operation, press Delete: it goes with its wire. Undo brings both back. Click the wire (it turns dashed), press X: only
  the wire goes. Expect the keys to do nothing while typing in a form field, and the Remove button in the lid to do the same as
  Delete. Since: edit-mode redesign slice 1 (PR pending).
- [ ] **PM6-2 — A planned record that exists is struck through and deleted at Create.** Open a map with a planned operation (and
  its planned output sample), choose Edit, select the operation, press Delete. Expect the card struck through with a "Will be
  deleted" pill (the planned sample too), the Create button saying "delete 1 planned record", and Undo bringing the card back.
  Create it: the operation and its planned output are gone after the map reloads. With something planned still hanging off the
  output Create answers with the server's check on the card; with something done hanging off it the card shows the lock at once.
  Since: edit-mode redesign slice 1 (PR pending).
- [ ] **PM6-3 — A done record cannot be removed.** Select a done sample or a done operation on an edit map and press Delete, X,
  Backspace or Remove. Expect a lock on the card, the line "Done records can't be removed from the map" under the lid, and nothing
  changed. Click a wire between two done records and press Delete: "Done records' wires can't be removed from the map", the
  wire wears a padlock. Since: edit-mode redesign slice 1 (PR pending).
- [ ] **PM6-4 — Drag a wire end off its input.** Drag from a wired input socket onto empty canvas and let go: the wire goes and
  the menu does not open; Undo puts it back. Drag from a free input onto empty canvas: the Add menu opens as before. Drop a wire
  end on another card that does not fit: nothing changes and the reason shows. Since: edit-mode redesign slice 1 (PR pending).
- [ ] **PM6-5 — Dissolve.** Build sample A, a cut (one row), sample B, a polish on B. Select the cut and press Ctrl/⌘+Delete (or use
  Dissolve in the lid or the card's right-click menu). Expect the cut and B gone and A wired straight into the polish; Undo
  restores all three. On a cut with three pieces, a test, or a card with no input sample, Dissolve says why and changes nothing.
  Since: edit-mode redesign slice 1 (PR pending).
- [ ] **PM6-6 — Sockets are derived.** A new sample shows one free socket on each side and nothing else. Wire it to an operation:
  the sample keeps its wired socket and shows no free output until you select it. Select the operation: a free output appears
  beside nothing else; connect it to a new sample, select the operation again and drag a second wire to its free output: it
  gets a second piece (a second row), sharing the input sample. Take the wire off the second piece's sample: the piece goes with
  it. Reload the draft: the canvas shows the same sockets (nothing about them was saved). Cards must not change size when
  selected. Since: edit-mode redesign slice 1 (PR pending).
- [ ] **PM6-7 — New cards never land on others.** Add, duplicate (Shift+D, and ×4), pick samples and attach cards on a crowded
  history map. Expect no two cards to overlap after any of them, the new ones beside what they came from, and undo and redo to
  leave no overlap either. Drag a card on top of another on purpose, add something, reload the draft: the dragged card is still
  where you left it. Since: edit-mode redesign slice 1 (PR pending).
- [ ] **PM6-8 — Tidy.** Make a mess of the draft's own cards (drag them over each other), press Tidy in the lid. Expect only the
  draft's cards to glide to ELK's arrangement beside the history, the history cards not to move, nothing to overlap, and Undo to
  put every card back in one step. Since: edit-mode redesign slice 1 (PR pending).
- [ ] **PM6-9 — Plain fixes against live data.** (a) Create a draft of one operation and two outputs: the toast says "Created 3
  records", not 5. (b) Open the history of a sample, choose Edit: a card's Open record, Process map of it, Expand and the plus on
  the card are missing for a draft card and present for a recorded one. (c) A draft of only picked samples: Create is disabled and
  says what to add. (d) A free new sample (no operation) with material and method can be created on live (`current_status` is
  required there and is not asked for). (e) A planned pass after done passes of one sample is its own card and its Mark done
  works. (f) Duplicate a team-owned sample and create the copy: it is created, owned by you. (g) On a done operation you own,
  the rail's Back to planned works; as someone else it shows the server's refusal. (h) Sign in as a Lab Viewer: no Edit toggle,
  no My drafts, and `/map?edit=new` says "Your account may not build processes." Since: edit-mode redesign slice 1 (PR pending).

The slice 1 behaviours above were also driven in a real browser on the local stack (real Postgres, Directus and the repo's extensions) by
`tests/ui/specs/edit-mode-slice1.spec.ts` and `edit-mode.spec.ts` (slice 1c, 2026-10-18): PM6-1, PM6-2, PM6-3, PM6-6, PM6-7 and PM6-8 in
full; PM6-4 for a wired input dragged off, a free one, and one with two wires (not "drop a wire end on a card that does not fit"); PM6-5
for the join and the refusal on a cut of three (not the refusals on a test or a card with no input); PM6-9 (a), (c), (d) and the page's
message for a Lab Viewer in (h). They stay unticked: this list is for what live data, real pointers on a real history and the real accounts
confirm. Not run anywhere yet: PM6-9 (b), (e), (f), (g) beyond the second Lab Member's refusal, and the Lab Viewer's missing Edit toggle and
My drafts in (h) (a known failure of `edit-mode.spec.ts`), a phone, and Tidy on a map of hundreds of cards.

#### Process map edit mode redesign, slice 2b draft controls (`pm-redesign/2b-draft-controls`; plan `2026-10-18-process-map-edit-redesign.md`)

The Planned / Done toggle, the project and campaign chooser and plain fixes 9 to 12 are unit-tested and were driven in a real browser on the local
stack by `tests/ui/specs/edit-mode-slice2b.spec.ts` (2026-10-19). What only live confirms is the field definitions, the project and campaign
lists and the accounts of the real lab.

- [ ] **PM7-1 — Done at Create asks for what live's forms require.** On live, build an operation of each process category you use (machining,
  sintering, heat treatment, sample prep) and a test of each type on a real sample, and press **Done** on each. Expect the rail to ask for the
  date it happened (today by default) and for exactly the fields the form of that method or test marks required, in the key settings; the
  Checks list the same fields (and the server agrees: Create is refused with the same fields until they are filled). Fill them, Create. Read
  the records: `work_state` done, the date, `done_by_person_id` (you), `done_at`, and the operation's output sample `active`. A required field
  that live has and the local stack does not (a hand-added one) must show here, not first as a refusal at Create. Since: edit-mode redesign slice 2b (PR pending).
- [ ] **PM7-2 — Planned and done in one draft, a planned input.** One draft with a done cut, a planned polish on its output and a done test on
  the polished piece: the test and the polish say "Its sample is still planned; mark the operation that makes it done first." until the
  operation before them is Done too; set the whole chain Done (the chip on each card) and Create: every record is done and every output active.
  Undo steps back one toggle at a time. Since: edit-mode redesign slice 2b (PR pending).
- [ ] **PM7-3 — Project and campaign chooser on live's lists.** In a draft, pick a sample of a real project: the Project box takes it. Open
  Campaign: only that project's campaigns are listed; change the project to another: a campaign of the first is cleared. Pick a campaign with
  no project: its project is set. As a Lab Member with a long project list (over 500) the box says it shows the first 500. Create: every new
  operation, test and sample carries the project, the campaign is on the operations and tests, and the new samples are in the campaign (Campaign
  page, Samples). Since: edit-mode redesign slice 2b (PR pending).
- [ ] **PM7-4 — My drafts, Build a process, undo and the blank canvas on real accounts.** (a) Press **Build a process** twice in a row: one draft
  in My drafts, not two. (b) In a form field of a new operation, change the feed, then the speed, then the feed again within a second or two:
  Undo takes them back one at a time. (c) A blank canvas says "Pick samples, or press Shift+A…" and has no Find, Reset or Clear until something is
  on it. (d) In the rail's all-fields form of a new sample, a field the form cannot draw (Co-owners, Files) says "Opens in Data Studio after
  Create", with no link; on a record that exists it still offers Open in Data Studio. Since: edit-mode redesign slice 2b (PR pending).

#### Process map edit mode redesign, slice 2a adding (`pm-redesign/2a-adding`; plan `2026-10-18-process-map-edit-redesign.md`)

The palette, the add search, the drops and insert (with its refusal before a recorded sample) are unit-tested and were driven in a real browser on the local stack by
`tests/ui/specs/edit-mode-slice2a.spec.ts` (a seeded family of four samples, eight methods). What only live data, other browsers and real
touch confirm:

- [ ] **PM8-1 — The palette on the live catalog.** In `/map?edit=new` on live: the palette lists every manufacturing method under its
  process category (no method missing, none twice, methods with no category under "Other methods"), every test type, and the two
  samples entries; the list scrolls inside the dock and the dock never pushes the canvas off the page at 1280 and 1920 px. Fold it,
  reload: still folded; sign in as someone else in the same browser: open. Add things from the palette and the add search, close the
  tab, come back: what you added lately is first in both. Since: edit-mode redesign slice 2a (PR pending).
- [ ] **PM8-2 — Drops on a real draft.** Pick a real family's sample, build an operation from its output, then drag a method from the
  palette (a) onto empty canvas (a floating card where you let go), (b) onto a free socket (connected), (c) onto a wire the draft made
  (the card goes between, one Ctrl+Z puts it all back), (d) onto a wire between two done records of the real history (the wire shows
  red, the reason "Done records' wires can't be removed from the map" follows the pointer, nothing changes), (e) onto a wire of a
  planned record that exists (refused: remove the planned record instead). No two cards overlap after any of them. Since: edit-mode
  redesign slice 2a (PR pending).
- [ ] **PM8-3 — Insert before a real recorded sample is refused.** Open the map of a real done sample (and, separately, a real planned
  sample that is saved), select it, press Shift+I. Expect: the banner says "Its history is recorded and can't change from the map. Start
  from a new sample instead.", no add search opens, no card is added, Undo stays disabled and Create stays disabled ("Add an operation,
  test or new sample to create"). Right-click it: **Insert before…** is shown greyed out and hovering it shows the same reason; **Insert
  after…** still opens the search. Select a new sample and Shift+I opens the search as before. Expect the done sample, its maker and its
  lineage rows unchanged (same `version` and `date_updated`; `sample_genealogy` has no new row naming it). There is no "Add an earlier
  step" any more: a missing earlier step is recorded by asking an admin to fix the lineage. Since: edit-mode redesign slice 2a (PR pending),
  rewritten for the R3 decision (refusal).
- [ ] **PM8-4 — Ctrl/⌘+K in each browser.** On Windows (Chrome, Edge, Firefox) and macOS (Safari, Chrome, Firefox) press Ctrl/⌘+K in edit
  mode with the pointer over the canvas: the add search opens at the pointer, the browser's own search bar and STARbase's Finder do not.
  With the focus in the draft's name field, in a form field of the rail, or with a dialog open, the same keys do not open the add
  search (the Finder opens where it did before, except over a dialog). Since: edit-mode redesign slice 2a (PR pending).
- [ ] **PM8-5 — Dragging from the palette with a finger or a pen.** On a tablet at least 768 px wide (and a pen on a Windows touch
  screen): drag a palette entry onto the canvas, a socket and a wire. Expect it to follow the finger, mark the target, drop, and the
  page not to scroll or pan during the drag. A finger must also be able to **scroll the palette** by swiping up and down on its
  entries (the list moves, nothing is carried); an entry is carried by a long press (about a third of a second) or a clear sideways
  swipe, and a mouse or pen drag is unchanged. Switching to another app or window mid-drag (or locking the screen) lets the drag go
  with nothing dropped. Since: edit-mode redesign slice 2a (PR pending); the scroll and the let-go: slice 2c fixes.

#### Process map edit mode redesign, slice 4 templates (`pm-redesign/4-templates`; plan `2026-10-18-process-map-edit-redesign.md`)

Templates (R7) are unit-tested and were driven in a real browser on the local stack by `tests/ui/specs/edit-mode-slice4.spec.ts` (one seeded
machine, a tool made for the run, two Lab Members, an administrator and a Lab Viewer; the three scopes; rename, who can use it, replace, delete;
a stale version; a retired tool). What only live data, live roles and real people confirm:

- [ ] **PM9-1 — A template on real tools, edges, operators and lists, and what it must NOT carry.** On live, build an operation of each process
  category you use, fill in the machine, the tool, the cutting edge, the operator, the typed settings and anything that is a list or a choice
  on that method's form, and **Save as template** (card right-click menu and the rail's Template section). The dialog's "Keeps" line must name
  what you filled in. Drop the template on an empty canvas: every setting you filled is on the new card (open "all fields"), and Create writes
  them (read the operation in Data Studio). Note every field that did NOT come back: a template keeps only the setup and the form's process
  settings (an allow-list read from the form's groups), and a many-to-many such as additional operators is left out by design. Then the
  negative cases, on a RECORDED, finished record of each kind: save it as a template and open it in Data Studio's API or look at
  `GET /d1-build/templates`: (a) a done **tensile, hardness, Charpy, compression, tribology, fatigue, creep, CLEMX and optical** test: only the
  type, the machine, the operator and the test parameters are there, no result (UTS, yield, hardness, absorbed energy, cycles, grain size...),
  no `status` (analysed...), no data file, plot or summary, no owner, no test code column; (b) a **FAST/SPS** operation with a run number: no
  `sintering_run_number`, batch, mass, recipe, `source_system` or `recorded_metadata`, and two operations made from the template on two samples
  are both created (the second is not refused as "That code or value is already used"); (c) an operation with a g-code file or an owner other
  than you: no `gcode_file`, no `owner`. (d) A **restricted** record (one only some people may read): the dialog offers only Only me and says
  why. (e) A column renamed or dropped by a later migration: an old template still adds a card and the draft still saves. Since: edit-mode
  redesign slice 4 (PR pending); the negative cases: slice 4 review fixes.
- [ ] **PM9-2 — Sharing with a real account role.** As a Lab Member save one template for **My account role** and one for **Everyone**.
  Sign in as another Lab Member: both are in the palette (Templates first) and in Shift+A, and neither has the ⋯ controls. Sign in as an
  administrator (another role): only the one for everyone is listed; the administrator can still rename and delete the role one if they
  reach it by id (`GET /d1-build/templates/<id>`). If your accounts use nested roles (a child of Lab Member), check a member of the child role
  sees the role template. A Lab Viewer gets 403 from `/d1-build/templates` and no edit mode. Since: edit-mode redesign slice 4 (PR pending).
- [ ] **PM9-3 — Retired and used-up gear.** Retire a tool (Tools list, `is_active` off) or mark an edge used that a saved template names. Open
  `/map?edit=new`: the template is greyed with "The tool … is retired." / "The cutting edge … is used up." under it in the palette and the
  add search, it can still be chosen, and the card made from it has the same warning in Checks (a warning only, Create is not blocked). Turn the
  tool back on, reload: no warning. Check that a machine set inactive in Equipment does the same. Since: edit-mode redesign slice 4 (PR pending).
- [ ] **PM9-4 — Many templates.** With about 100 templates visible (a few people, all three scopes): the palette's Templates group scrolls inside
  the dock without pushing the canvas, typing narrows by name and by method, the add search lists them first and finds one by name in a keystroke
  or two, and opening the palette or the page does not wait on the template list (the list is read once when edit mode starts). Since:
  edit-mode redesign slice 4 (PR pending).
- [ ] **PM9-5 — Replace, rename and delete on real shared templates.** Replace a role template with the settings of a card on the map (confirm
  twice-asked), rename it, change its scope to Everyone and back, delete it: each says what it did, another member's open palette keeps listing
  the old one until their page reads again, and renaming it from there answers "changed since you opened it" and reloads. What was made
  from the template (cards already on a draft, records already created) is unchanged by every one of these. Since: edit-mode redesign slice 4 (PR pending).

#### Process map edit mode redesign, slice 3 attach from the database (`pm-redesign/3-attach`; plan `2026-10-18-process-map-edit-redesign.md`)

"From database…" lists the recorded operations that have no input sample and attaches one to a sample's output. It is unit-tested and was driven in
a real browser on the local stack by `tests/ui/specs/edit-mode-slice3.spec.ts` (orphan operations made through the API, one extra Lab Member). What only
live data and the real accounts confirm:

- [ ] **PM10-1 — The orphan operations of live data.** On live, open `/map?edit=new`, pick a sample and open **From database…** from its output
  socket (also from the palette and Shift+A). Expect the list to hold exactly the operations with no input sample that your account may read
  (ask an admin for the count: `SELECT count(*) FROM manufacturing_operations WHERE sample_id IS NULL`, and compare as yourself and as an admin: a
  Lab Member sees fewer, never more). Each row shows a code (or "Operation on <sample>" when it has no pass code), the method, Planned or Done, the
  day, the owner and the sample it made. Typing a method name, part of a code and part of the code of the sample it made each narrow the list; **Show
  more** pages on without repeating a row; the list does not take more than a moment on the real table. Since: edit-mode redesign slice 3 (PR pending).
- [ ] **PM10-2 — Attach a real orphan to a real sample, read it back.** Pick an orphan that is **done** and one that is **planned** (separately), attach
  each to a real active sample whose history you know, press Create ("Attach 1 operation"). Read the operation, the sample it made and `sample_genealogy`
  as an admin. Expect: `sample_id` is the sample you chose, `version` up by one, `work_state`, dates, method, owner and output unchanged; **its step number
  and pass code now follow the new sample** (a code that was typed, or an operation imported from an experiment sheet, keeps its code: say which you
  saw); one new genealogy row (output sample as child, your sample as parent; `cut_from`, `sintered_from` or `derived_from` by the method); the sample it
  made has the same fields as before; no new sample anywhere. The map of the output sample now shows the new input. Since: edit-mode redesign slice 3 (PR pending).
- [ ] **PM10-3 — Who may attach.** Attaching updates the operation, which the access rules allow its **owner** (or an owner or co-owner of the sample it
  acts on: an orphan has none). As a Lab Member who can **read** an orphan only through a project or campaign (PI or investigator, campaign owner) and
  does not own it, pick it and Create. Expect the picker to refuse it at the pick ("You can see this operation but not change it.": the page asks Directus's `/permissions/me` for the record) and
  nothing to join the draft; if the owner changes between the pick and Create, the check "Changed since you added it..." (a change of owner bumps the version), the operation
  unchanged, and the draft kept. (Create also answers a bare "You are not allowed to write that record." under the button for a refusal the page did not
  foresee; it could not be reached on the local stack, where every change moves the version first.) As a Lab Viewer the Edit toggle is not there. As an admin it works. Check `/permissions/me` answers `update.access` the same way for real rules (a co-owned sample, a campaign owner). Since: edit-mode redesign slice 3 (PR pending).
- [ ] **PM10-4 — Greyed rows on a real map.** Open the map of the sample an orphan made (the orphan is drawn as its maker) and open **From database…** from a
  sample's output: that orphan is greyed "Already on the canvas." On a **planned** sample every **done** orphan is greyed "Its sample is still planned;
  mark the operation that makes it done first." and a planned one is not. Attach an orphan, open the picker again from another sample: it is greyed
  "Already attached in this draft." An orphan that made a sample the target comes from (as far as the loaded lineage goes) is greyed as a circle. Greyed rows
  cannot be chosen by click or Enter. Since: edit-mode redesign slice 3 (PR pending).
- [ ] **PM10-6 — Lineage loops, own output, second origin, on real lineage.** Needs real lineage depth (the local stack has two levels). On live: (a) pick the
  sample an orphan made and open **From database…** from the output of a **descendant** of it three or more steps down, in a draft that picked only that
  descendant from the Samples list (the map has no history loaded): the picker cannot see the loop, so attach the orphan and press Create. Expect the
  blocking check "It made <code>, which the sample you attached it to comes from: that would run in a circle." (the server read the lineage), nothing written.
  (b) An orphan whose output sample already has a genealogy parent that is not the sample you attach it to is greyed "already comes from another sample", and
  if you get it onto the draft some other way Create refuses it with the same words. (c) Attach an orphan to the sample it made (drag the output's wire onto
  its own input): Create is refused with "cannot be an input of the operation that made it". Check the time the server takes on a deep lineage (the recursion
  is bounded at 100 levels and visits each sample once per path) and that a sample you may not read is named "the sample it made", not by its code.
  Since: edit-mode redesign slice 3 review fixes (PR pending).
- [ ] **PM10-5 — Changed, gone or given an input while the draft is open.** Attach a real orphan in a draft and leave it open; as another account (or in
  Data Studio) (a) give that operation an input, (b) edit it (any field), (c) delete it, one case per draft. Reload the draft and press Create. Expect
  (a) a blocking check "It got an input in the meantime, so it cannot be attached any more.", (b) "Changed since you added it. Your edits were made against
  an older version, so review it first.", (c) "This record no longer exists, or you can no longer see it."; nothing is written in any case and the draft is
  kept. Since: edit-mode redesign slice 3 (PR pending).

#### Bulk actions, STARbase side (`feat/bulk-actions`, PR 1; spec `2026-10-20-bulk-actions-design.md`)
Needs migration 204 and the `d1-bulk-actions` endpoint on the live stack, then `npm run build:starbase`. Use a copy of the data.

- [ ] **BA1 — ticks and the With-selected menu on every list.** Open Samples, Operations, Tools and Equipment. Expect: a tick column on every list; with nothing ticked Samples, Operations, Tests and Campaigns show a disabled **With selected ▾** and Tools and Equipment show no menu; tick 4 samples and it reads **With 4 selected ▾**. The menu opens with the mouse and the keyboard (Enter or the down arrow, then the arrows, Escape closes and gives focus back to the button, a click elsewhere closes it). Samples: Print labels, Restrict…, Unrestrict…, Edit status…, Edit project…, Edit export control…. **Print labels** opens the labels page with the same 4 samples as before. A Lab Viewer sees only Print labels (Samples) and no menu elsewhere.
- [ ] **BA2 — edit a field: preview, apply, undo toast.** Tick 38 samples across two pages (the tick survives the page change), **Edit status…**, choose Archived. Expect: the dialog says "Edit status for 38 samples"; the check runs by itself and says "N can be changed" (rows already archived are "need no change"), skipped rows (ones you may not edit) are folded under "Why are N skipped?" with their reasons; **Apply to N** is off at 0. Apply: the dialog closes, the list reloads with the new status, the ticks clear except the skipped rows, and a toast bottom right says "Set status to Archived on N samples" with a ring that empties over 60 s and **Undo**. Undo puts the old statuses back ("Undone"); a sample edited by someone else in between is left alone and listed under "left as they are". Let the ring run out instead: "Done", and the toast goes after a few seconds. A second action inside the 60 s gets its own toast and both can be undone.
- [ ] **BA3 — link and yes / no fields; clear.** **Edit project…**: the picker lists the projects you can read; **Clear project instead** shows "will be emptied" and the preview counts; apply, then Undo restores each sample's own project. **Edit export control…**: Yes / No, no clear option. A role that cannot read projects: the dialog says the list could not be loaded and Apply stays off.
- [ ] **BA4 — Restrict and Unrestrict as a member and as an administrator.** As a Lab Member tick samples you own, **Restrict…**: every row is skipped with "Only administrators can restrict records yet" and Apply is off. As an administrator the rows apply, the toast says "Restricted N samples", Undo works, and the Who has access dialog of one sample shows it restricted.
- [ ] **BA5 — toast and dialog accessibility.** Screen reader on: the toast announces the result once, then "Done" or "Undone", and does not read the seconds. With the operating system set to reduce motion: the ring is full and still and "N s left to undo" is written under the result. Tab stays inside the dialog, Escape closes it, focus returns to the With-selected button (also after Apply, when the ticks have cleared and the button is disabled). Dark theme: ring, card and dialog are readable.
- [ ] **BA6 — failure wording.** Stop Directus's endpoint (or cut the network) with the dialog open: the check says "The check failed: …Nothing has been changed. Close this and try again." Press Undo after the 60 s have passed (change the clock or wait): the toast keeps its card and shows the server's message in red instead of "Done" without a word.

#### Bulk actions, STARbase side, PR 2 (assign team, change owner, share, remove access; stacked on PR 1)
Needs the server half of PR 2 (the four kinds in `d1-bulk-actions`). Use a copy of the data, as an owner of the records, as a team manager and as an administrator.

- [ ] **BA7 — menu entries per list.** Samples, Operations, Tests and Campaigns: the menu reads Assign to team…, Change owner…, Share or change access…, Remove access…, then Restrict… / Unrestrict… and the field edits (Samples also has Print labels first). Tools, Equipment and the other lists: none of the four. A Lab Viewer sees none of them.
- [ ] **BA8 — Assign to team: the tiles and the real teams.** Tick 5 operations you own, **Assign to team…**. Expect: every team (the same list as the Teams page) with its tile or logo and "Team · N members"; nothing is asked of the server until one is chosen; the check then says "5 can be changed" and "Assign 5 operations to Team X". A team with no manager: every row skipped with "That team has no manager yet" (or the server's own words) and Apply to 0 is off. Apply: the toast says "Assigned 5 operations to Team X"; the Who has access dialog of one operation shows Team X as the owner and you as Can edit; **Undo** puts you back as owner.
- [ ] **BA9 — Change owner and the person search.** **Change owner…** on 3 samples: the search finds People by name (people with no login are marked "can't sign in yet" in the list), choosing one writes the name with **Change** and runs the check at once; Change empties the check and puts the cursor back in the box. A sample you do not own is skipped with "You are not the owner". Apply: "Changed the owner of 3 samples to Ann Lee"; Undo gives each sample its old owner back.
- [ ] **BA10 — Share or change access: person, team, level.** **Share or change access…** on 12 operations. The box finds people and teams. The level starts at Can view; changing it runs the check again and the sentence reads "Share 12 operations with Ann (Can edit)". Operations Ann already has at that level need no change; the others change (added, or the level changed). Apply: "Shared 12 operations with Ann"; the Who has access dialog shows her at the chosen level; Undo removes new grants and restores old levels. Repeat with a team.
- [ ] **BA11 — Remove access.** **Remove access…**, pick a person (and again a team): rows where they are not listed need no change; the owner and a team that owns the record are skipped with the server's reason. Apply: "Removed access for Ann on N operations"; Undo puts the grants back at their levels.
- [ ] **BA12 — Warnings before Apply (Ruling O5).** As a manager of Team A, tick operations owned by Team A and **Assign to team…** Team B, or **Change owner…** to a person. The dialog says "Read before you apply: N have a warning." with the server's sentence under it, and **Which N have a warning?** lists the operations. Apply: the toast says "N had a warning" and the fold keeps them listed (the toast stays until closed); an Undo that is refused for the same reason shows under "left as they are". Rows without a warning are not in the list.
- [ ] **BA13 — the person box inside the dialog.** In the Share dialog, type two letters: the list opens under the box without being cut off or making the dialog jump; the arrow keys and Enter pick; the first Escape closes the list, the second closes the dialog; focus lands on **Change** after a pick. Tab and Shift+Tab stay inside the dialog, through the team radios (arrow keys move between teams) and the level select. Dark theme and a phone-width window: team tiles, chip and level select are readable and nothing scrolls sideways.

### Surface scans on inserts and edges (migration 192, ADR-0021)
- [ ] **SS1 — Render a real `.al3d` from the share.** Needs the stack with the `surface-scan-worker`, MinIO and the archive
  share mounted read-only. In STARbase add a surface scan (condition Worn) to a real edge, picking a real Alicona `.al3d` from
  the file library. Expect: the scan goes pending, rendering, done within about a minute, and the row shows a grid of at most
  1024 cells on the longer side, a pixel pitch and a height range that agree with the Alicona software's own numbers for that
  file (the range will not match Sz exactly: it is the file's extremes, not a roughness value). In MinIO,
  `mc ls local/d1-files/surface-scans/<cache_key>/` lists `grid.bin`, `meta.json` and `thumb.png`. With a session cookie,
  `GET /d1-surface-scan/<scan_id>/grid` answers 200 with an `ETag` equal to the cache key and `Cache-Control: private, no-cache`; the
  same request with `If-None-Match` answers 304; `/meta` and `/thumb` answer too; a user who may not read the scan, and a request
  without a session, are refused. The archive share is unchanged afterwards (no new file, same modification time on the `.al3d`; the
  volume is mounted `:ro`). Then add a scan whose file is not a topography (a PDF): it ends failed with a readable `render_error`
  and never opens a document; Render again on it queues it once. A file the crawler has hashed gets its `content_sha256` as cache
  key, one it has not gets `p-<file id>-<size>-<mtime>`. Also check the least-privilege reader on the real MinIO: set
  `MINIO_SURFACE_READER_PASSWORD` in `.env`, run `make bootstrap-minio` (creates the user `surface-reader` and its policy) and restart
  Directus, which must not hold the root credentials (`docker compose exec directus env | grep MINIO` shows no `MINIO_ROOT_*`). As
  that user (`mc alias set reader http://localhost:9000 surface-reader <password>`): `mc cat reader/d1-files/surface-scans/<cache_key>/meta.json`
  works; a key under `surface-scans/` that does not exist answers 404 NoSuchKey, **not** 403 (this needs the `s3:ListBucket` statement
  with the `surface-scans/*` prefix condition; the viewer's "render again" message depends on it); `mc cp` of any file into
  `d1-files/surface-scans/`, `mc rm` of an object there, `mc ls reader/d1-files/` (no prefix), `mc cat` of an object under another prefix
  and any access to `d1-backups` are all refused (403). With the password empty, `GET /d1-surface-scan/<id>/grid` answers 503, not a
  crash. Since: surface scans PR (pending).
- [ ] **SS2 — The viewer on a real GPU.** Open the scan from SS1 on the lab PC's real browser and GPU (note which). Expect a lit 3D
  surface of the edge, smooth orbit and zoom with a 1024-cell grid, the exaggeration slider and colour by height responding at once, a
  legend in micrometres that matches the row's range, holes where the file has no data (not spikes or zero), and the thumbnail on
  the insert and edge pages. Also open it on a laptop with only an integrated GPU: it must still draw (slower is fine), and where
  float textures are missing it says so instead of showing a blank canvas. Same check as **SCAN-UI2**; tick both together. Since: surface scans PR (pending).
- [ ] **SS3 — Count the Alicona Tests whose subject is an edge (dry run, before any migration).** Nothing is migrated by this PR.
  On the live database, in a read-only transaction (`BEGIN READ ONLY;` ... `ROLLBACK;`), run
  `SELECT count(*) FROM test_sessions t WHERE t.test_type = 'alicona' AND (t.insert_edge_id IS NOT NULL OR EXISTS (SELECT 1 FROM
  test_sessions_subject s WHERE s.test_sessions_id = t.session_id AND s.collection = 'insert_edges'));`
  and the same count of those that have a linked file. Write both numbers after this item. They size the later script that
  proposes surface scans for them (follow-up F1 of the plan): a handful can be done by hand, hundreds need the guarded script. Since:
  surface scans PR (pending).

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

- [ ] **#345 Operation detail Cut parameters layout.** In the Plot page's Operation detail (narrow
  column, a real operation with a capture): Cut parameters sits at the top, above Operation record,
  and both use the same field style; every number field shows two decimals when idle (60.00, 0.05;
  Pulses/rev stays whole) and the full stored value, e.g. 0.055, while you edit it; the capture's fields read "Spiral feed", "Spiral Ø", "Inner Ø", "Pulses/rev",
  "Sample rate" and nothing overflows. Edit each: its box gets the blue ring and Cut parameters'
  Reset appears (including for Sample rate alone) and clears it. On an operation whose capture
  surface speed or depth of cut differs from the record, that field shows full-width with a blue
  border. From the 345 PR.

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

### Depth of cut and force limit (2026-10-14, #288, #289)
- [ ] **#288 depth of cut on the Record page.** With NI-DAQ selected, the cut-parameter grid shows
  Depth of cut and Axial DoC next to Spindle and Feed. Type 0.5 and 2, record and save a cut: the
  Directus run row has `machining_radial_depth_of_cut_mm` 0.5 and `machining_axial_depth_of_cut_mm`
  2, and the capture's summary.json `extra_metadata` has `radial_doc`/`axial_doc`. Both survive an
  app restart; a cleared tile saves as empty, not 0. Since the #288/#289 fix branch.
- [ ] **#289 force alarm at the limit.** Settings > Safety Alarms: set the limit to 400 N, then
  clear the field and click away: it goes back to 400. Start a cut with no load on the dyno: the
  alarm stays quiet. If it still trips at once, note the axis and value on the alarm banner and keep
  that capture folder (its first second of raw data is what #289 needs). Then press the tool against
  the dyno past 400 N: the alarm trips, and the amber warning showed first at 320 N. Since the
  #288/#289 fix branch.

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

### Inbox crawler and found files (2026-10-15, PR #310 and its follow-ups)

Needs the real share (`archive_share` mount on d1-server) and real Directus data. Spec:
[found files and the Inbox](../superpowers/specs/2026-10-15-found-files-inbox-design.md), ADR-0020.

- [ ] **IF1 — The crawler cannot write to the share.** From inside the `inbox-crawler` container, try
  `touch /mnt/archive/star_group1/Users/<your alias>/x` and `rm` on a throwaway file. Expect both to fail.
  Record that the SMB account in `.env` is the maintainer's personal admin one and can write; follow-up:
  create a read-only SMB account for the service and re-run this check with it.
- [ ] **IF2 — Folder mtimes move on the real share.** Create a file two folders deep in a test folder, then
  `stat` its parent and grandparent through the mount. Expect the parent's mtime to change (the grandparent's
  need not). If the parent's does not, the incremental scan misses files; report before enabling it.
  Also compare the share's clock with the server's: the crawler lists a directory again at every scan while
  its mtime is less than 2 seconds old or in the future, so a share clock running ahead makes every scan list
  everything (correct, but slow: IF4 would show it).
- [ ] **IF3 — Baseline and new files.** Set one person's `uni_alias`, run a scan. Expect everything already
  there to appear under *Older* (backlog) and the badge to stay 0. Save a new image in that folder; within 30
  minutes (or, with *Rescan my folder*, once the scan running at the moment has finished and the daemon's next
  30-second tick has claimed the request) expect it under *New* and the badge to read 1. A file saved in
  the last 5 seconds before a scan is left for the next one (it may still be being written).
- [ ] **IF4 — Load on the share.** Time a first scan of a real personal folder tree and an incremental one;
  watch the share for impact (read rate stays under the `read_mb_per_s` cap). Record both durations.
- [ ] **IF5 — Documents are never opened.** With a document in a scanned folder, confirm from the crawler's
  log (put `INBOX_LOG_LEVEL=DEBUG` in `.env`, run `docker compose --profile archive up -d inbox-crawler`
  to recreate the service with it, which logs every file it opens, then `docker compose logs inbox-crawler`) and the file server's open-file list if available, that it is only listed, not opened, until
  it is linked; then that linking it produces one read (an INFO line `reading <path> once to fingerprint it`)
  and a `file_fingerprints` row with its size and mtime. Undo the link and confirm no further read.
- [ ] **IF6 — Short-ID links on real records.** Save an image whose name contains a real sample's short ID.
  Expect it flagged with the reason *short ID … in the file name*; link it; open the sample page and see it.
  Try *Accept all* on a filtered list and *Undo* the batch. Try a view-only person: Link must be refused.
- [ ] **IF7 — Auto-link.** For a test person with auto-link on, save an image with an exact short ID; expect it
  linked, listed under *Recently auto-linked*, and undoable. With auto-link off, expect no link. The
  crawler and Directus must have the same `D1_INBOX_CRAWLER_SECRET`; with it empty the crawler logs
  "auto-link is off" and makes no call, with a wrong one it logs "auto-link refused" (never the secret). Only
  images are auto-linked: an exact short ID on an `.al3d` surface scan or a document must stay in the Inbox. A
  file the person cannot edit the record of is refused by d1-inbox and offered again about an hour later.
- [ ] **IF8 — SEM tagging on JEOL images.** Run the maintainer's JEOL sample images through the crawler;
  record how many are tagged *possible SEM image*, any misses and any false positives (screenshots,
  photos). Also note which TIFF tags the real files carry (the crawler reads a JEOL name, kV and magnification
  from the text tags when present; the layout is a guess until seen). JEOL text OCR no longer has a default
  (pytesseract was never installed or validated): only JEOL metadata claims a JEOL image, and the FEI data-bar
  reader (`INBOX_OCR=1`, **SEM1**, **SEM2**, **SEM4** and **SEM7** below) does not read JEOL bars.
- [ ] **IF9 — Alicona `.al3d` tagging and hand-off.** Needs real `.al3d` files and the `surface_scans`
  migration (192) applied. Expect tag `surface_scan`; the hand-off is an add, not a link:
  `POST /d1-inbox/link` with `{candidate_id, collection:'surface_scans', insert_id | edge_id, condition, ...}`
  (see **IF23**). Check the pointer
  row has `storage = 'star'` and `metadata.archive_path`, and that its `file_fingerprints` row is `done` with
  `size_bytes` and `source_mtime` equal to the file's (the renderer trusts the hash only then). A scan is
  never auto-linked or accepted in bulk, whatever its name says, and linking it to a sample, operation or
  test answers 409 `SURFACE_SCAN`.

- [ ] **IF10 — A share that drops mid-scan loses nothing.** While a scan of a large folder runs (or with a
  candidate waiting in a folder that changes), disconnect the share from the server (stop the CIFS mount or
  the VPN). Expect the log to say `scan aborted`, no candidate to become `gone`, `last_scan_finished_at` not to
  advance, the admin tab to show the error, and the next scan after the share is back to carry on without
  re-registering anything. A first scan that was interrupted stays *Older* (backlog) when it completes. After
  the share is back, a file deleted while it was down is found *gone* by a later scan (no decision is lost).
  Also make one person's folder unreadable (a permission change by the file server's owner) and confirm the
  other people's folders are still scanned and the admin tab shows the error.
- [ ] **IF11 — Snapshot and hidden folders are not entered.** If the share exposes `.snapshot`, `~snapshot` or
  similar directories inside personal or team folders, confirm the crawler never lists them (DEBUG log, or
  the file server's access log) and no found file comes from them. Also confirm folders under `Users/` and
  `Shared/` with no alias or share folder appear in the admin tab's unmatched list and are not scanned.
- [ ] **IF12 — The indexer and the crawler agree on the pointer rows.** Run `make index-archive` after the
  crawler has registered files in a personal folder. The crawler also registers file types the indexer's
  `ALLOWED_EXT` does not cover (`.al3d`, unknown types); the indexer's missing-file sweep now judges only the
  types it walks, so expect those rows NOT to be flagged `metadata.missing` (rows flagged by an older run stay
  flagged: clear them), while an indexed file deleted from the share still is. Move a found image to another
  folder under the same name, run `make index-archive --fingerprint` and then a crawler scan: the candidate
  must follow the file (not turn *gone*). Found files the indexer does cover must keep one `directus_files`
  row each (same id). Since the inbox crawler PR.
- [ ] **IF13 — Links on the real share are refused.** Ask the file server's owner (or use a test folder) to
  create a symbolic link and, if the file server supports them, a junction or shortcut inside a scanned
  folder: one named `photo.tif` pointing at a `.pdf`, one pointing at a folder outside `Users/`, one pointing
  at another person's file. Through the CIFS mount, check whether each appears as a symlink (`ls -l`,
  `stat` inside the container) or as an ordinary file or folder (a server-side link the mount resolves
  for us). Expect the crawler to list and open none of the symlinks (DEBUG log shows no read of them, no
  found file). If a link shows up as an ordinary file or folder instead, record that: the crawler cannot
  tell it from a real one, and the only guard is that the mount is read-only and limited to this share.
- [ ] **IF14 — An alias change during a scan.** With the amended migration (its triggers clean up when
  `people.uni_alias` or `teams.share_folder` changes), change a person's alias while a scan of their folder
  runs (or between two scans), then give the old folder name to another person. Expect the old person's
  found files (not linked ones) to vanish from their Inbox, the new owner to get a first scan of that folder
  (everything *Older*, badge 0), and no found file of the folder in the old person's Inbox.
- [ ] **IF15 — Other tools can still read documents under `Users/` that nobody linked.**
  `index_archive.py --fingerprint` and `file_fingerprints.py` can still read documents under `Users/` that
  nobody linked: decide whether to restrict them. The crawler reads a document only after a person links it
  (ADR-0020), and `file_fingerprints.py --phase all` now skips a document or other non-image file the crawler
  found (a `d1_private.file_candidates` row of kind document or other, not linked, never adopted) until it is
  linked. The exclusion keys on that candidate row, not on `directus_files.metadata.found_by`, which the
  indexer's next run overwrites and any Lab Member can edit; a pointer row with `found_by` but no candidate
  row is read like any other file. The indexer's own walk (`make index-archive`, with or without
  `--fingerprint`, which reads 128 KB of every file it indexes) and `file_fingerprints.py --phase linked` are
  unchanged. Run `make index-archive --fingerprint` on a test folder with a document in it, check what was
  read, and decide: restrict both tools to the folders the lab agreed to index, or accept it. To check the
  exclusion: after the crawler found a document and the indexer ran over its folder, `file_fingerprints.py
  --phase all --dry-run` must not list it, and must list it once a person has linked it. Since: found files
  inbox, final review (S5), re-review fix (S3).
- [ ] **IF16 — An undone auto-link stays undone (live).** See **IF40**, which covers this check as well (the crawler restart and its log).
- [ ] **IF17 — Pausing the crawler (SQL).** There is no admin route or tab for this. On d1-server run
  `UPDATE d1_private.inbox_crawler_state SET desired_state = 'paused'` (psql in the `postgres` container).
  Within about 30 seconds expect the admin tab to show the crawler as paused but still online (the heartbeat keeps going), a file
  saved in a scanned folder to stay unfound across a scheduled scan time, and a *Rescan my folder* request to
  stay queued. Set `desired_state = 'running'` and expect the request to be claimed within about 30 seconds and
  the file to appear. Also try `interval_minutes` and `read_mb_per_s` the same way (a CHECK refuses 0).
  Since: found files inbox, final review (runbook).
- [ ] **IF18 — The heartbeat keeps beating during a long hash.** Link a large document (a few GB, or lower
  `read_mb_per_s` to 0.5 on a 100 MB one so the read takes several minutes). While it is read once to
  fingerprint it, expect the admin tab to keep showing the daemon *Online* with the activity `hashing <path>`
  and `last_heartbeat_at` never more than about 30 seconds old, then a `file_fingerprints` row. Restore the
  rate afterwards. Since: found files inbox, final review (7a).
- [ ] **IF19 — One crawler at a time.** With the daemon running, run `make inbox-crawler-once`: expect it to
  log that another crawler holds the lock and exit 1 without scanning; start a second daemon container the same
  way and expect it to exit 1. Stop the daemon and expect `make inbox-crawler-once` to run. Since: found files
  inbox, final review (7c).
- [ ] **IF20 — Auto-link acts as the person (live Directus).** Set `D1_INBOX_CRAWLER_SECRET` in `.env`, restart
  Directus. With a test person (a Lab Member, auto-link on) whose image names a sample they can edit, run a
  crawler scan or `curl -X POST /d1-inbox/auto-link -H "X-Inbox-Crawler-Secret: ..." -d '{"candidate_ids":[...]}'`.
  Expect `linked`, and in `audit_logs` the new `sample_data_files` row names that person, not an administrator.
  Repeat for a sample they can only view, and a Restricted one: expect `skipped NOT_EDITABLE`. A call without the
  header (or with a wrong one, or with a secret under 32 characters configured) must be 401/403. This is the one thing the unit tests cannot prove: that the
  accountability `d1-inbox` builds for a login (role tree and policy flags read from the database) is accepted by
  Directus's ItemsService. Since: found files inbox, stream B.
- [ ] **IF21 — A member cannot squat a uni alias.** As a Lab Member in Data Studio, create a People row and try to
  set `uni alias` or `scan while Former` (the fields should not be offered; a direct API POST with them must be
  refused 403). Apply migration 194 first and flush Redis / restart Directus (permissions are cached). Since:
  found files inbox, stream B (migration 194).
- [ ] **IF22 — A file already linked in Data Studio.** Link an image to a sample in Data Studio's file picker,
  then try to link the same found file to that sample in the Inbox: expect the refusal "already linked to that
  record. Dismiss clears it." (409 `ALREADY_ON_RECORD`) and no second row, and the Inbox badge not counting it. Since: found files inbox, stream B.
- [ ] **IF23 — Add a surface scan from the Inbox (live).** Needs the deployed `d1-inbox`, migration 192
  (`surface_scans`), the surface-scan worker running, and a found `.al3d` file (see IF9). As a Lab Member, add
  it to an insert, then (a second file) to an edge, each with a condition (try the request without one: 400
  naming `condition`; the condition is never preset). Expect: a `surface_scans` row for the file with the
  condition you chose and `owner_person_id` set to you (the `d1-owner-default` hook, not the endpoint), the
  viewer's render queued (`render_status` `pending`, then `rendering`, then `done` once the worker has it) and the
  scan open in the viewer from the insert or edge page, and the candidate under **Recently linked** (`manual`)
  naming the insert or edge. Adding the same file to the same insert again is refused 409 `ALREADY_ADDED`; a Lab
  Viewer is refused 403. Then **Undo** the batch and expect the `surface_scans` row to be gone, the candidate back
  in the new list, and the derived files in MinIO (`surface-scans/<cache key>/`) left as cache. Also undo a batch
  while its render is still `rendering`: the row goes, and the worker's final write finds no row (its job is logged
  as failed; nothing else changes). Through the STARbase form (`/inbox`, **Add a surface scan**): the dialog warns
  that the file becomes visible to every lab member, has **no condition chosen** and keeps *Add a surface scan*
  off until an insert or edge (searched by its code) and a condition are set; the operation list offers only the
  operations run with the chosen edge, or any edge of the chosen insert; after the add the notice says *Added as a
  surface scan of <code>* and **Recently linked** shows the same line with a link to the insert or edge page and
  the batch titled *Added as a surface scan*; a second add of the same file to the same insert is refused with
  *That file is already added as a surface scan of this insert or edge*; as a Lab Viewer the add is refused with
  the read-only message; make the person lose delete rights on `surface_scans` (or use another member's scan) and
  expect Undo to show *You can no longer delete that surface scan, so adding it cannot be undone.* and change
  nothing; the dialog fits a phone-width window. Since: found files inbox, streams F1 and F2.
- [ ] **IF30 — Inbox page on real data (STARbase `/inbox`).** Needs the deployed `d1-inbox` and a person with a
  `uni_alias`. Expect: rows for the found files with kind, folder, size and date and the icon of the kind (an
  image with a stored picture shows it instead, see **IF60**; the page never makes an `/assets/` request for a
  found file, because archive files are pointer rows Directus cannot serve: check the browser's network tab
  shows none); a flagged file reading *short ID `…` in the
  file name* with a link to the record. Link, Change (search by code, nickname and short ID in the picker),
  Dismiss, Restore and, after each, focus on the next row (or the status line when none is left); *Show more*
  past 50 files; the Other files section (collapsed, with its count; open it and link a document: the dialog
  says linking reads the file once); a surface-scan row whose button reads *Add a surface scan* (enabled; the
  dialog is checked in **IF23**) and which never offers *Link*. *Accept all* on a real list: the dialog opens on the server's dry run
  (Confirm waits for it), names the count and the first few *file to record* pairs and what would be left, and
  Confirm links exactly those; try it with a record you can only view (it is left, with the reason). *Rescan my
  folder* twice in a row (the second shows the rate-limit message). Since: Inbox stream D.
- [ ] **IF31 — Inbox badge and Home panel.** As a person with new found files, expect the **Inbox** entry
  under Home (rail and expanded) with the count of *new* files only (backlog excluded), the same numbers in
  Home's Inbox panel, and the page reachable from both. Link a file and expect the badge to drop at once (even
  if a poll was in flight); save a file and, without reloading, expect the badge to catch up within about three
  minutes or when the window regains focus. On a server without `d1-inbox`, the entry and the panel are absent
  and nothing errors; sign out and in as someone refused (a 403) and expect the entry to come back once the
  account can read it. Since: Inbox stream D.
- [ ] **IF32 — Uni alias and share folder fields on real Directus.** As an administrator, open a person on the
  People page: *Uni alias* and *Scan while Former* show the stored values and the note *Changing this resets
  the Inbox for this folder; linked files stay linked.* Set an alias, save, reopen: it is kept. Try `a/b`, one
  character and `.ab` (refused in the form), and an alias another person already has in a different case (the
  server refuses; the form says *That alias is already used by another person* and names no one; check Directus
  answers `RECORD_NOT_UNIQUE` with `extensions.field` naming the alias, since the page tells it by that field:
  if it names another field or none, report it). Link a login already linked to another person and expect the
  server's own words, not the alias message. Add a **new** person with an alias: the person is created and the
  alias is set by a second request (the database refuses an alias on insert); check the Directus request log
  shows a POST without it then a PATCH. On a team, set *Share folder* the same way (try `x/y`, blank, a name
  another team has; a refusal on a **new** team must leave the dialog open with the message and a second Save
  must not create a second team). Change an alias after that person has found files and confirm the undecided
  and dismissed ones are gone while linked ones stay. A Lab Member sees neither field. Since: Inbox stream D.
- [ ] **IF33 — Inbox crawler tab on `/crawler` (administrators).** With the `inbox-crawler` daemon running,
  expect *Online, running*, the interval, the last scan times and the file count, and that it never flips to
  Offline during a long scan; stop the daemon and expect *Offline* after about five minutes (the endpoint's
  rule). A scan error appears once under *Errors*. A folder created under `Users/` or `Shared/` that no alias or
  share folder names shows under *Folders no one owns*, and a person with no alias under *People without a uni
  alias* (linking to the People page); give them an alias and expect them to leave the list after the next
  scan. Press *Scan all* and expect the request to be claimed once the current scan finishes (then within about
  30 seconds; a scheduled scan, a first one especially, can run for hours), and a second press while one
  waits to say it is already queued. A Lab Member who opens `/crawler?tab=inbox` is told it is for
  administrators. Since: Inbox stream D.
- [ ] **IF40 — An undone auto-link stays undone (also the old IF16).** With auto-link on for a test person, save an image with an
  exact short ID of a sample they can edit into their folder and let the crawler auto-link it. Open **Recently
  auto-linked** and **Undo** it. Restart the crawler (`docker compose --profile archive restart inbox-crawler`, which
  forgets its in-process list of answered candidates), then run *Rescan my folder* twice (and wait for a scheduled
  scan): expect the file to stay in the **New** list, not to be linked again, no new `sample_data_files` row and no
  `auto-link:` offer for it in the crawler's log; a different exact-short-ID image saved afterwards is still
  auto-linked. Then **Link** the first file by hand: that must work. Also undo a link made by hand and expect the
  next auto-link scan to be free to link it (only an undone *auto* link is remembered, in
  `file_candidates.auto_undone_at`). Needs the migration 193 amended in place (a database that already applied the
  first 193 needs `ALTER TABLE d1_private.file_candidates ADD COLUMN auto_undone_at TIMESTAMPTZ`, or a roll back and
  re-apply). Since: found files inbox, final review fixes (server); merged with IF16 (B1).
- [ ] **IF41 — A file that vanished while linked or dismissed is marked gone after Undo or Restore.** Save an image
  in a test folder, let the scan find it, **Dismiss** it (another file: Link it). Delete the file from the share, let
  a scan run (it does not mark a decided file gone), then **Restore** (or **Undo**) it. Expect the next scan, or
  *Rescan my folder*, to list that folder again and mark the file *gone* (it leaves the New list instead of
  staying there for good). Since: found files inbox, final review fixes (server).
- [ ] **IF50 — A restored file whose whole folder was deleted is marked gone.** Like IF41, but put the file in a
  subfolder of a test folder (`Users/<alias>/old/deep/x.png`), let a scan find it, **Dismiss** it, then delete the
  whole `old` folder from the share and let a scan run (the file stays dismissed). **Restore** it. Expect the next
  scan, or *Rescan my folder*, to mark it *gone* although no folder row is left to list (the crawler stats the
  folders of every undecided file and the folders above them). Since: found files inbox, re-review fixes (S2,
  crawler).
- [ ] **IF51 — A file added as a surface scan in the Alicona dialog leaves the Inbox.** Needs migration 192 and
  a real `.al3d` the crawler found. Add that very file in the Alicona feature's own *Add surface scan* dialog (it
  lists every star `.al3d`). Expect the next scan, or *Rescan my folder*, to delete its undecided candidate (it
  leaves *New* and the badge) with no *already on record* refusal on the way, and a new `.al3d` in the folder to
  appear as usual. Since: found files inbox, re-review fixes (S5, crawler).
- [ ] **IF52 — The heartbeat has its own database connection.** While the crawler hashes a large new image or
  scan in a folder of a person whose alias you change meanwhile (People collection, a different value), expect the
  admin tab to keep showing the daemon *Online*, and after the scan that none of the folder's files registered
  before the change is in the Inbox (the alias check dropped them; the heartbeat did not commit them). In
  `pg_stat_activity` the crawler shows two sessions, the second one idle between beats. Since: found files inbox,
  re-review fixes (S1, crawler).
- [ ] **IF42 — Copies across inboxes.** Put the same image in two people's folders (or a person's and a team's). The
  one found first is the original; the other shows *Copy of ...* and is not counted by the badge. As the owner of the
  **original**, dismiss it: expect the copy in the other person's Inbox to stay and to be counted. Restore it and
  link it instead: expect the copy to disappear. When both copies are in the same person's (or team's) Inbox,
  dismissing the original hides the copy too. A copy of another person's file must not say whose Inbox holds the
  original (only your own folder and your teams are named). Since: found files inbox, final review fixes (server).
- [ ] **IF43 — The Home "older files" link and the copy wording, on real data.** With older found files in a
  personal folder (some naming a record by short ID or code, some not, some by insert edge code only), open Home and
  click *N older files match a record*: expect the Inbox on the *Older files* tab with *Match* set to **Exact
  match** and only the short-ID and record-code files listed (the count on Home equals the list's total). Choose
  *Exact short ID*, *Record code*, *Insert edge code (weaker)* and *No match* in turn: each still filters, and the
  URL carries `strength=` (a comma list for Exact match). For a copy whose original is in another person's Inbox
  that you have no part in, expect *Copy of a file someone else also has* and no name anywhere in the row; for a copy
  of a file in your own folder, a team of yours, or (as an administrator) anyone's: *Copy of a file in <name>'s
  Inbox*. Since: found files inbox, final review fixes (UI).
- [ ] **IF44 — Team folder: Undo by another member, a race, and Accept all over 500.** With two members of one team
  that has a share folder: member A links a file from the team folder; member B (who sees the row under *Recently
  linked*) presses **Undo**: expect the refusal *Only the person who linked this, or an administrator, can undo it.*
  and nothing changed (the list rows carry only the linker's name, so the button is shown to B; an administrator
  can undo). Then A and B both open the same *New* team file and press Link: the second one expects *Someone already
  dealt with that file.* (a file in a personal folder says *That file was already linked.*). With more than 500 exact
  short-ID files for records you can edit, open **Accept all**: expect the confirm to say it links about 500 at a time
  (never more than 999) and that you can run it again, the batch to link no more than 999, and a second run to take the
  rest. Since: found files inbox, final review fixes (UI).
- [ ] **IF45 — A surface scan file named after an edge arrives with that edge chosen.** Save an `.al3d` (or another
  surface scan file) whose name contains an existing insert edge code (for example `H13A-#2-fC`) into a test
  folder and let the scan find it. In the Inbox, expect the row to say it matches the edge, and **Add a surface
  scan** to open with that edge already chosen in the picker (you still choose the condition). As a Lab Viewer, or
  with a Restricted insert you cannot read, expect the dialog to open with nothing chosen and the row to name no
  edge. A document or image named like an edge is not given the edge as a suggestion. Since: found files inbox,
  re-review fixes (server, S4).
- [ ] **IF46 — A scan added through the Alicona feature's own dialog leaves the Inbox.** Save an `.al3d` into a
  test folder, let the scan find it, and add the same file as a surface scan in the Alicona (Surface scans) dialog
  instead of the Inbox. Reload the Inbox and Home: expect the file to be gone from **New** and **Older** and not counted
  in the badge (nor is it under **Recently linked**: it was never linked here). Pressing *Add a
  surface scan* on a stale row from before the reload must answer *That file is already added as a surface scan of
  this insert or edge.* A surface scan file nobody has added stays listed and counted. Since: found files inbox,
  re-review fixes (server, S5).
- [ ] **IF53 — Thumbnails of real SEM images look right.** Needs migration 198 and the crawler on the new code
  (`INBOX_THUMBNAILS` unset or `1`). Save a real JEOL 16-bit TIFF, a JEOL 8-bit TIFF, a JPEG and a PNG into a test folder
  and let the scan find them. Then, as the database owner,
  `SELECT c.rel_path, octet_length(t.thumb), octet_length(t.preview), t.thumb_width, t.thumb_height, t.preview_width, t.preview_height
  FROM d1_private.file_thumbnails t JOIN d1_private.file_candidates c USING (candidate_id)`: expect a row each, the thumbnail
  about 320 px on its long side and 10 to 25 KB, the preview about 1600 px (or the original size if smaller) and 150 to 400 KB.
  In the Inbox (stream C) or by saving `thumb` and `preview` out of the row: the 16-bit TIFF is a recognisable grey picture
  (stretched, not black), the data bar and its scale bar are readable in the preview, and a rotated JPEG (camera or phone photo)
  is upright. A multi-page TIFF shows its first frame. A PDF and an `.al3d` get no row. Since: Inbox thumbnails (stream B, crawler).
- [ ] **IF54 — The thumbnail backfill on the real share is throttled and bounded.** On the deployment, with older found files
  that have no picture (everything registered before migration 198), start the crawler and watch
  `SELECT count(*) FROM d1_private.file_thumbnails` over a few minutes: it grows by at most 25 per 30 second tick (and a tick
  hands back after 20 seconds), reads stay at or below `read_mb_per_s` (check the share's or the container's network rate while
  `docker compose --profile archive logs -f inbox-crawler` shows `thumbnails made for N images`), the admin tab's heartbeat does
  not go stale, and a scan request queued meanwhile is picked up within about a minute. Restart the service in the middle: it
  resumes where it left off and re-reads nothing that has a row. `docker stats` on the largest real image (a 50 megapixel 16-bit
  TIFF peaks at about 500 MB): the container stays within its memory. Note how long the whole backlog takes and put it in
  `docs/runbooks/inbox-crawler.md`. Since: Inbox thumbnails (stream B, crawler).
- [ ] **IF55 — The backfill reads only images and never writes to the share.** With `INBOX_LOG_LEVEL=DEBUG` (recreate the
  service), let the backfill run on the real share: every `reading ...` line it logs is a `.tif .tiff .jpg .jpeg .png .bmp` path, never
  a document, `.mat`, camera raw or `.al3d`, and a person's linked documents are not re-read for pictures. Compare the
  modification times of a few folders and files before and after (and the SMB server's audit log if there is one): nothing
  was created, changed or deleted. Since: Inbox thumbnails (stream B, crawler); read-only invariant of ADR-0020.
- [ ] **IF56 — A file that goes gone loses its picture, and `INBOX_THUMBNAILS=0` stops it all.** Delete one undecided image
  with pictures from the real share and run *Rescan my folder*: it becomes gone and its `file_thumbnails` row is deleted; put
  it back and the next idle ticks make the picture again. Set `INBOX_THUMBNAILS=0` in `.env`, recreate the service
  (`docker compose --profile archive up -d --force-recreate inbox-crawler`), save a new image: it is registered with no row, and
  the row count does not grow while older images are still missing pictures. Back to `1` and it resumes. Finally compare
  `SELECT pg_size_pretty(sum(octet_length(thumb) + octet_length(preview))), count(*) FROM d1_private.file_thumbnails` with the
  runbook's estimate (about 0.3 MB per image) and correct the estimate if it is off by more than half. Since: Inbox thumbnails
  (stream B, crawler).
- [ ] **IF57 — An image that cannot be decoded is read once, and a re-saved file keeps its old picture.** Needs migration 198 as
  amended (NULLable pictures, `failed_reason`). Put a truncated or renamed-text `.png` and a good image in a test folder
  and let the scan find them: expect a `file_thumbnails` row for the bad one with both pictures NULL and
  `failed_reason = 'not decoded'`, and a normal row for the good one. Restart the crawler with `INBOX_LOG_LEVEL=DEBUG`: the bad
  file is not opened again (no `reading ...` line for it). Then overwrite the good image in place with a different picture
  (same name) and rescan: its picture does not change (the documented limit: made once, when first seen); move it to a new
  name and the new path gets the new picture. Since: Inbox thumbnails review fixes (M2, Minor2; crawler).
- [ ] **IF58 — The backfill leaves a Former person's, an old alias's and an ignored folder's files alone.** With older images
  without pictures (switch the crawler off, delete their rows, switch it on), set a test person to Former (not *scan while
  former*), change another test person's alias after linking one of their images, ignore a folder of a third, and run the
  crawler with `INBOX_LOG_LEVEL=DEBUG`: no `reading ...` line for any file of those three, and with `INBOX_ONLY_FOLDERS` set to
  one alias none for anybody else's. Undo each and expect the pictures to be made. Since: Inbox thumbnails review fixes (M1;
  crawler).

- [ ] **IF60 — Inbox thumbnails and the full view on real data (STARbase `/inbox`, and the same page inside Data Studio).**
  Needs the deployed `d1-inbox` with the thumbnails migration and a crawler that has made the pictures (new files, and the
  backfill for older ones). Save a few real SEM images (TIFF, JPEG) into a test folder and let the scan find them. Expect:
  each image row shows a small picture in place of the icon, a shimmer for a moment first; rows far down a long list
  load their pictures only when you scroll to them (network tab: `/d1-inbox/files/<id>/thumb`, at most four in flight, none
  for rows not yet reached; each answers `image/jpeg` as a blob with the session cookie and none is an `<img src>` to the
  endpoint); a document, an `.al3d` and an image the crawler could not decode keep the icon. Click a picture (or Tab to it
  and press Enter): the dialog opens with the blurred thumbnail and a spinner, then the preview (`/preview`), shows the
  file name, folder and the kV, magnification and scale bar the row shows, and the line *Reduced-size preview. The
  original stays on the share.* Esc, a click outside and **Close** each close it, and focus is back on the picture; Tab
  stays inside the dialog. Open the same file in **both** hosts (STARbase and Data Studio's Home) and expect the same
  result. Switch the browser to *reduce motion*: the shimmer and the spinner stand still. Stop the `d1-inbox` route (or
  reload with the network blocked) after the list has loaded and expect the rows to show their icons without an error, and
  the dialog to show *The preview could not be loaded.* with **Retry**. Since: Inbox thumbnails (stream C).
- [ ] **IF61 — A person only sees pictures of files they can see.** With two people (or a person and a team) whose
  folders hold images with pictures, copy the `thumb` URL of one person's file from the network tab and request it as the
  other person (their session): expect 404, not the picture; and as a signed-out browser, expect no picture (the
  endpoint needs the session). Since: Inbox thumbnails (stream C: the client side of the server's visibility rule).
- [ ] **IF62 — Pictures inside Data Studio: look-ahead, stalled loads and focus.** On the Inbox page inside Data Studio
  (Home's Inbox, where the page scrolls in `#main-content`) with a long list of image rows: scroll slowly and expect the
  pictures a screen or so ahead to be loaded before the row arrives (network tab: `/thumb` requests start for rows just
  below the visible area, none for rows far down). Throttle the network to *Offline* after the list has loaded, scroll to a
  row and click its picture while it still shimmers: the preview opens, and after Esc focus is on the row's first button,
  not on the page. Block a `/preview` request without answering (DevTools request blocking does not stall; use a proxy
  or throttle to a very slow profile): after 30 seconds the dialog shows *The preview could not be loaded.* with **Retry**,
  and Retry puts focus on **Close**. A screen reader (NVDA or Narrator) announces *Loading preview…* when the dialog opens
  and *Preview ready.* when it is in. Since: Inbox thumbnails UI review fixes.

- [ ] **IF70 — An ignored folder is never listed, statted or opened on the real share.** Needs a test person with a
  folder tree on the lab share that has a subfolder with files (and a sibling named like it plus a suffix, for
  example `World-Ti Paper` and `World-Ti Paper 2`). Add the rule `World-Ti Paper` for that person (the Inbox's
  *Ignore this folder*, or `INSERT INTO d1_private.inbox_ignored_dirs (owner_person_id, rel_folder) ...` as the
  database owner), then run `make inbox-crawler-once` (or *Rescan my folder*) while watching the file server's
  access log, or the crawler container with `strace -f -e trace=openat,getdents64,newfstatat -p <pid>`. Expect no
  open, listing or stat of any path under `World-Ti Paper`, the lookalike `World-Ti Paper 2` scanned as before, and
  the log line `N ignored folders were not scanned`. Time the scan against the same scan without the rule (like IF4):
  it is not slower and is faster on a big ignored tree. Also try the rule spelled in another case
  (`world-ti paper`): the real share is case-insensitive, so it must cover the folder the same. Since: ignored
  folders (crawler, IB).
- [ ] **IF71 — Not scanned is not gone, and removing a rule lists the folder again (real share).** With the rule from
  IF70 in place and a file of that person's under the ignored folder that is still *New* (add the rule by SQL, not
  the endpoint, so it is not dismissed), delete that whole folder on the share (or rename it) and scan: expect the
  file to stay *New* in the Inbox (not *gone*, not removed) and the folder's `inbox_dirs` rows to stay. Disconnect
  the share mid-scan as in IF10 with the rule in place: nothing is marked gone, as before. Then remove the rule and
  scan: expect the folder to be listed again, the vanished file to become *gone* now, and a folder that was only
  ignored (not deleted) to bring its files back in as *New* (files the rule had dismissed stay in *Dismissed*
  until restored by hand). Add and remove a rule while a long scan runs: expect each change to show from the next
  scan, not mid-scan. Since: ignored folders (crawler, IB).
- [ ] **IF72 — A linked file under an ignored folder is still tracked.** Link a document (say a PDF) from a folder, then
  ignore that folder for the person. Expect the document to be hashed once (a `file_fingerprints` row appears, as
  in IF5) even though the folder is ignored, and its *Recently linked* row to stay; a found image under the same
  folder that has a failed hash is not retried, and an exact short-ID image there is not offered to auto-link
  (the crawler log with `INBOX_LOG_LEVEL=DEBUG` shows no open of it). Since: ignored folders (crawler, IB).
- [ ] **IF80 — Ignoring a folder from the Inbox page, on real data (STARbase `/inbox`, and inside Data Studio).** As a Lab
  Member with found files in a subfolder, open *New*, choose *Ignore this folder* beside a row. Expect the confirm to name
  the folder relative to your own folder (no `Users/<alias>/`) and to say that files move to Dismissed, linked files stay
  linked and nothing on the share changes. Confirm: expect the notice to give the real count, the files to leave *New*
  and the badge to drop by that count, the files to be under *Dismissed* (Restore works), and the rule under *Ignored
  folders*. A file in a team folder: the rule is the team's, and a teammate sees it listed with the team name. *Remove
  rule* in the notice, and *Remove* in the list, both work; the next scan (or the queued rescan) lists the folder again.
  Type an ignored folder again in another letter case, a lookalike (`Name 2`), and `Users/<alias>/Name`: expect the
  first to be refused (already ignored), the lookalike to be accepted, and the last to say to give it relative to your own folder. As a Lab
  Viewer: the rules are listed, *Remove* is off with the reason, and there is no *Ignore this folder* and no add field.
  Since: ignored folders (STARbase, IC).

### SEM data-bar reader (2026-10-16, OCR tier: sem-reader plan, stream B)

Needs the real share, real FEI/Thermo images and the crawler host. Spec:
[SEM data-bar reader](../superpowers/specs/2026-10-16-sem-data-bar-reader-design.md) (section 2, tiers 1 and 2).
Cloud sessions and CI have no real bars and no Docker daemon: the unit tests prove the geometry, the parsing, the
ranges and the cross-checks on synthetic bars with a scripted recogniser, **not** that the real font reads. Never
commit a research image while doing these; look at them on d1-server only.

- [ ] **SEM1 — FEI TIFFs through the real crawler.** On d1-server, point a trial run at a folder with real FEI
  TIFFs (`INBOX_ONLY_FOLDERS=<folder>`, `make inbox-crawler-once`): at least 20 images, among them one 2048-px
  image (119-px bar), one acquired in British summer time and one in winter, one whose bar prints `40×`, and, as
  controls, a thermal-camera JPEG, a `Microscope x20` optical TIFF and an EDS map with a legend bar. Expect each
  FEI TIFF to be `kind = 'sem_image'` with `kind_confidence` 0.95 (0.9 where no bar is found), `extracted` holding
  `kv`, `spot`, `working_distance_mm`, `magnification`, `hfw_um`, `detector`, `mode`, `acquired_at` (ISO 8601 with
  offset, equal to the instrument's London clock: `+01:00` in summer, `+00:00` in winter), `sources` all
  `metadata` except `magnification` = `derived`, and `flags` empty or naming only a field the file really lacks;
  the controls stay `image` ("data-bar-like strip, no SEM evidence" or the optical-microscope reason). Check with
  `SELECT rel_path, kind, kind_confidence, extracted FROM d1_private.file_candidates WHERE ...`. Re-run with
  `INBOX_OCR=1` once **SEM7** passes: every field the bar prints must agree with the metadata, and any
  `flags.<field> = 'bar_mismatch'` is a finding to look at (the bar or the metadata is wrong), not noise. Stream E
  adds: every registered row's `directus_files.owner_person_id` (a personal folder) or `owner_team_id` (a team folder)
  must be the person or team whose folder holds the file (`SELECT f.owner_person_id, f.owner_team_id, p.uni_alias FROM
  directus_files f LEFT JOIN people p ON p.person_id = f.owner_person_id WHERE f.id IN (SELECT directus_files_id FROM
  d1_private.file_candidates WHERE ...)`), a file already linked in Data Studio before the scan stays unowned, and a second
  scan changes no stamp. Since: sem-reader plan, stream B (the stamp check: stream E).
- [ ] **SEM2 — Real PNG, BMP and JPEG exports against their TIFFs' metadata.** Needs `INBOX_OCR=1` and **SEM7**
  done. Run the crawler over SEM-named folders that hold exports, including contrast-edited `*_contrasted.PNG`
  files (white dividers about 207 instead of 255) and at least one JPEG. For every export that has a same-name
  TIFF with metadata, compare `kv`, `working_distance_mm`, `spot`, `mode` and `magnification` with the TIFF's.
  Expect `kind = 'sem_image'`, confidence 0.8, `sources` all `ocr`, and every value that is present equal to the
  TIFF's (the trial read 37 of 37 exports cleanly; one JPEG whose bar says 10 kV has a TIFF namesake that says
  20 kV, which is a different capture, not a misread). **A wrong value is a blocker; an absent one is fine** and
  must carry a flag (`hfw_mismatch`, `length_mismatch`, `out_of_range`, `not_a_number`). Expect
  `flags.check_this = true` on a bar-only export (nothing but the scale bar can vouch for it) and none when the
  scale-bar length confirmed the magnification. Charts, 256x200 EDS thumbnails and phone photos in the same
  folders must stay `image`. Record the time per file (the trial: about 0.16 s on a CPU) and the count of exports
  with no value for some field. Since: sem-reader plan, stream B.
- [ ] **SEM4 — (optional) `INBOX_OCR_DEVICE=auto` on the crawler host.** Only if the GPU is wanted: the CPU is
  fast enough for this corpus. On the host with the RTX 5080 (Docker GPU passthrough set up, `onnxruntime-gpu`
  installed in the crawler image in place of `onnxruntime`, a build that supports Blackwell), set
  `INBOX_OCR=1` and `INBOX_OCR_DEVICE=auto` and recreate the service. Expect the log line `data-bar OCR: RapidOCR
  recogniser on CUDAExecutionProvider (INBOX_OCR_DEVICE=auto)`; with no GPU or a provider that fails to load,
  expect `data-bar OCR stays on the CPU (auto): ...` and the same values as on the CPU. The GPU switch rebuilds
  RapidOCR's recogniser session by hand (RapidOCR 1.2.3 ignores its own `rec_use_cuda` option), so confirm the
  `CUDAExecutionProvider` line is true and the values equal the CPU run's. `cuda` with no GPU must warn and fall
  back, never stop the crawler. Since: sem-reader plan, stream B.
- [ ] **SEM7 — The crawler image installs and imports rapidocr and `zoneinfo`.** The plan's packaging step could
  not be run in the cloud session (no Docker daemon), so the pip lines of `docker-compose.yml` (service
  `inbox-crawler`) and the `Makefile` (`inbox-crawler-once`) do **not** install rapidocr yet, and `INBOX_OCR=1` logs
  one warning and reads no bars. On a machine with Docker: find a pip line that works in `python:3.12-slim`, which
  installs `--no-deps rapidocr-onnxruntime==1.2.3`, then its dependencies (`onnxruntime`, `numpy`, `pyclipper`,
  `Shapely`, `PyYAML`, `six`, `Pillow`) with `opencv-python-headless` in place of the non-headless
  `opencv-python` (which needs libGL), every version exact from a passing install. Prove it in a clean image:
  `docker run --rm python:3.12-slim sh -c "<the pip line> && python -c 'import zoneinfo, rapidocr_onnxruntime;
  zoneinfo.ZoneInfo(\"Europe/London\"); rapidocr_onnxruntime.RapidOCR(); print(\"ok\")'"`. Expect `ok` (the models
  ship in the wheel; nothing is downloaded at run time; the install is about 380 MB). Then put the same
  pip line in the `inbox-crawler` command of `docker-compose.yml` and in the `Makefile`'s `inbox-crawler-once` target (the two places that install it), run SEM1 and SEM2, and tick this. Also
  confirm the image has timezone data (`zoneinfo.ZoneInfo("Europe/London")` is built when the crawler imports
  `sem_meta`, with or without OCR). Since: sem-reader plan, stream B.

### SEM data-bar reader and provenance-owned files (2026-10-16, ADR-0022; migrations 196 and 197)

Needs the real Directus and database on d1-server (restart Directus after the migrations, it caches permissions and relations), the real share
and two non-administrator accounts that are each other's colleagues (a Lab Member each; one also in a team with a third person). Spec:
[SEM data-bar reader](../superpowers/specs/2026-10-16-sem-data-bar-reader-design.md) sections 3 and 4. Only the database half is in this PR; the
crawler stamping, the `d1-inbox` routes and the STARbase pages are other streams and add their own items.

- [ ] **SEM3 — Two accounts and a locked file (the owner filter on the real Directus).** First, the filter itself: after
  `make migrate` and a Directus restart, sign in as a Lab Member and open any page that lists files or shows an image (a sample photo, the
  Force App's file picker). Expect no *400* and no *"_some can only be used with top level relational alias field"* in the Directus log: Directus
  must accept the new hidden alias `directus_files.readers` over the readers table `file_readers` (it could not be tried before the
  migration was written; if it refuses, the filter must change, do not widen it). Then, with account A's personal folder holding a found
  image the crawler has registered: as A, `GET /files/<id>` and `/assets/<id>` answer 200; as B (another Lab Member) the same id answers
  403/404, and so does a Lab Viewer; as an administrator it answers 200 (administrators are not filtered). For a team folder, a member of
  the team reads it and a non-member does not; add the non-member to the team and expect access at once, remove them and expect it gone.
  A file already linked to a record before migration 196 (no owner) stays readable by every member. As A, upload a new image through Data Studio
  and the Force App: expect no 403 (the Lab Member create field list names every `directus_files` column), and expect that a Lab Member
  cannot set the owner (`PATCH /files/<id>` with `owner_person_id` answers 403). Then link A's file to a sample that B can read and open
  that sample as B: expect a link B cannot open. Then, as B, try to change or remove A's file: `PATCH /files/<id>` with a new `title` and `DELETE /files/<id>` must be refused (403), and A's file
  must be unchanged and still there; as A the same calls succeed on a throwaway owned file, and any member can still `PATCH` and `DELETE` an
  unowned file they can read. Finally an administrator reads A's file's settings and the log gains a row (that half needs
  the `d1-inbox` stream). Since: provenance owner (database, migration 196).
- [ ] **SEM5 — Migrations 196 and 197 and the back-fill on the real database (database half).** On a copy of the production database, apply
  both (`dbmate up`) and check: `SELECT count(*) FROM directus_files WHERE owner_person_id IS NOT NULL OR owner_team_id IS NOT NULL` equals
  the number of `d1_private.file_candidates` rows whose state is not `linked` **and** whose file has no row in `sample_data_files`,
  `operation_data_files`, `session_data_files` or `surface_scans` (not linked anywhere; about 82,000 when this was written, a few fewer
  than the candidates that are not `linked`), no file with such a row was stamped (a dismissed candidate whose file was linked in Data Studio is
  the case to look for), and `SELECT d1_private.file_readers_drift_count()` is 0. Time the apply (the back-fill and the readers refresh scan every file
  once). Read an SEM image's `extracted` from `file_candidates` and run `SELECT d1_private.save_sem_settings(<file id>, extracted,
  'sem-2')` for a few real rows: expect the columns to equal the printed bar and a second call to change nothing; then
  `correct_sem_setting` one value and run the save again: expect the corrected value to stay. `dbmate down` twice and `up` twice must
  also work on the real data. Down is lossy: it drops the stamps, the settings, the owners' manual corrections and the administrator
  access log, so dump `d1_private.sem_image_settings` and `d1_private.sem_settings_access_log` first if the copy holds any. Since: provenance owner and SEM settings (database,
  migrations 196 and 197). **Crawler half (`--sem-backfill`, sem-reader plan stream E):** with the daemon stopped
  (`docker compose --profile archive stop inbox-crawler`, the pass refuses to run beside it), run the pass on the real database
  (command in the runbook, `docs/runbooks/inbox-crawler.md`, "One-shot passes"; first on a copy if the settings table could not be
  dumped). Expect the log line `sem-backfill: N saved, N not an SEM image, N SEM images with no usable value, N unreadable, ...`;
  `SELECT count(*) FROM d1_private.sem_image_settings` equals N saved (plus any rows that existed); every saved file is image-typed and
  linked in a junction or `surface_scans`, owned or not (an owned file linked in Data Studio is back-filled too: `SELECT ... FROM
  d1_private.sem_image_settings s JOIN directus_files f ON f.id = s.directus_files_id WHERE f.owner_person_id IS NOT NULL AND
  s.read_by = 'backfill'` lists them, and none of them is a file nobody linked); a metadata-bearing FEI TIFF has `kv`, `spot`, `working_distance_mm`, `magnification` and `acquired_at` equal to its
  metadata (`sources` = `metadata`/`derived`). Kill the run half way (`docker stop` or Ctrl-C) and run it again: expect it to finish
  the rest without re-reading the finished ones. Correct one value as its owner, run the pass again: the corrected value stays
  (that row is not listed at all, it has settings). A PNG or JPEG export with no metadata gets no row until `INBOX_OCR=1` works
  (**SEM7**): expect it counted under "no usable value" and filled by a second run with OCR on. Record the time per file
  and the count of unreadable files. Since: SEM reader plan, stream E.
- [ ] **SEM6 — `--reclassify` on the real database.** With the detector fix deployed and the daemon stopped, run
  `python -m inbox_crawler --reclassify` (runbook, "One-shot passes"). First note `SELECT kind, count(*) FROM
  d1_private.file_candidates GROUP BY kind` and `SELECT count(*) FROM d1_private.file_candidates WHERE state IN ('new','dismissed')
  AND kind IN ('image','sem_image') AND classified_by IS DISTINCT FROM 'sem-2'` (the queue). Expect the log line
  `reclassify: N promoted, N demoted, N unchanged (...)`, with N promoted + N demoted + N unchanged + N unreadable + N too large
  + N skipped equal to that queue (less rows linked meanwhile), and the queue count equal to N skipped afterwards (a skipped file is
  missing or failed transiently: it is not marked, the next run offers it again). Then check the real files: the maintainer's six FEI
  TIFFs and their PNG exports are `kind = 'sem_image'` (the PNG exports only once `INBOX_OCR=1` works, **SEM7**; before that
  expect the TIFFs and "unchanged" for the PNGs, and once SEM7 is done and `INBOX_OCR=1` is set, run `--reclassify --force` once:
  a plain second run finds an empty queue and will NOT promote them, `--force` re-reads every eligible row), thermal-camera JPEGs, "Microscope x20" optical TIFFs and EDS maps with a legend bar are
  back to (or stay) `image`, and the previous false `sem_image` rows (about 1,586 were tagged by the first detector) now
  show as demoted. A `linked` candidate's kind must be exactly what it was (`SELECT ... WHERE state = 'linked'` compared with a copy taken
  before). Run it a second time: expect `0 promoted, 0 demoted, 0 unchanged` (a skipped row may be read again) and no other file opened
  (watch `INBOX_LOG_LEVEL=DEBUG` for `reading ...` lines). Kill a first run half way and run it again: it must finish the rest.
  Look at any `not re-classifying ...` warning: a permission error or an allow-list refusal is marked and not retried by the next
  run; a file that vanished or a transient error is skipped and offered again. Unmount or block the share part-way through a run
  (on a copy of the database): expect `reclassify aborted` in the log, exit code 1, and no row marked after that point
  (`classified_by` of the rest still not `sem-2`); run again with the share back and expect it to finish. Run
  `--reclassify --force` once and expect every eligible row to be read (the counts are the whole of `new` and `dismissed` image
  candidates) and a linked row untouched. Record the time and the
  promoted, demoted and unchanged counts. Since: SEM reader plan, stream E.
- [ ] **SEM8 — The `d1-inbox` imaging settings routes on the real Directus (two accounts and an administrator).** With **SEM3** passed, and an SEM
  image (a FEI TIFF) in account A's personal folder that the crawler has registered and stamped: as A, link it to a sample A can edit, then call
  `GET /d1-inbox/sem-settings?file=<directus_files id>` (browser address bar while signed in, or the Data Studio network tab). Expect
  `locked: false`, the printed settings, `sources`, and `can_edit: true`. As B (another Lab Member who can read that sample) the same call must answer
  `{"data":{"locked":true}}` with HTTP 200 and nothing else. As an administrator who is not A it answers the values with `can_edit: false` and
  `SELECT * FROM d1_private.sem_settings_access_log ORDER BY id DESC LIMIT 3` gains exactly one row with `reason = 'admin_read'` per call (and none
  for A's own reads). As A, `PATCH /d1-inbox/sem-settings/<id>` with `{"field":"kv","value":20}` answers 200 with `sources.kv = "manual"`; the same
  PATCH as B and as the administrator answers 403, and `{"field":"read_by","value":"x"}` as A answers 400. For a file with no owner (one linked
  before migration 196) linked to a sample B can read, B's GET answers the values (this is the first live check that the junction read as the caller
  follows the record's read rule) and a Lab Member who cannot read the sample gets `locked: true`. Then, as the administrator, try
  `POST /d1-inbox/link`, `/dismiss` and `/undo` on a file of A's: each must answer 403 *"An administrator can read other people's files but not
  change them"* and change nothing, while the Inbox list and the badge still show the administrator the rows they could see before. Last, link
  one image to a second record in Data Studio as well and undo the Inbox link: `d1_private.sem_image_settings` must still hold the file's row. Delete
  the Data Studio link, link the file in the Inbox again and undo that: the row must be gone.
  Since: `d1-inbox` imaging settings routes (stream D of the SEM reader plan).
- [ ] **SEM9 — Imaging settings in the Inbox row, from real crawler output (STARbase).** After **SEM1**, open the Inbox as the owner of a folder
  holding a real FEI TIFF, a real PNG export and a JEOL image. Expect for each FEI row a list of labelled values in this order: kV, working distance,
  magnification, spot, detector, mode, scale bar, taken (then field width, pixel size, instrument), each with a source label (`metadata`, `derived`,
  `OCR`); the scale bar as "500 µm", "3 mm" or "200 nm" to match the bar printed on the image; the time as UK time with `GMT` or `BST` that equals
  the instrument's clock (check one image taken in summer and one in winter); no OCR confidence anywhere. A PNG export read by OCR with nothing to
  cross-check shows "check this" on the values the bar alone gave; a field the reader refused shows "couldn't read <field>" with the reason. A row
  stored before the new crawler (no `sources`) and the JEOL row keep the one-line summary. Since: STARbase imaging settings (stream F of the SEM reader plan).
- [ ] **SEM10 — Imaging settings and locked files on a record page, on the real Directus (STARbase, three accounts).** With **SEM8** passed and an SEM
  image linked from account A's folder to a sample B can read: open the sample's page as A. Expect the Files section to list the image with its
  settings and an Edit control on every field (also those with no value, "not set"); change kV to 20: the field then reads `manual`, and a value
  out of range (kV 99, magnification 5000.5) shows the server's message beside the field and keeps the box open; a time typed as UK local time is
  saved with the right offset (check a summer and a winter time). As B the same page shows a lock and "A file from another person's folder" and
  nothing else (no name, no values, no download or copy-path button, no owner; the page source and network tab hold no filename), and B's Directus
  read of `/items/physical_samples/<id>?fields=data_files.id,data_files.directus_files_id.id` returns, for that file, a row with its own `id` present and
  `directus_files_id` **null** (not an object and not the bare file id; the page relies on that null to know the file is locked without asking, as `hiddenLinks.ts`
  documents for row filters); look at the page too: the lock row is shown for it and the Files count includes it (a count one short means the null row was dropped).
  The same Files section on an operation page also lists legacy share paths (`operation_files`, administrators): a `.tif` there must still show its name
  and copy-path buttons, never the lock. As an administrator the page shows the values and no Edit control, and the access log gains a row.
  For a file with no owner (linked before migration 196) a reader of the sample sees the values with no Edit control. The same Files section on an
  operation page and a test page behaves the same. Since: STARbase imaging settings and locked files (stream F of the SEM reader plan).
- [ ] **SEM11 — An alias handed to someone else, or corrected (C1, ADR-0022 D13).** On a copy of the database with two People, A and B, and a
  folder `Users/<alias>` holding a few images A's crawler scan registered: change A's `uni_alias` to something else and give the old alias to B
  (the case "alias corrected"). Run `make inbox-crawler-once` (daemon stopped) and open the Inbox as B: expect none of A's old files (also not in
  *Older files*, *Recently linked* or the badge), the log line `N file(s) stamped to another owner left out of the inbox`, and a file B adds
  afterwards listed. The scan **deletes A's undecided and dismissed candidates** under that folder (`drop_foreign_state`: the candidate table is unique on the file, so B's scan could not register
  the same files otherwise; A's linked ones stay), so none of A's candidate ids survive it: to try `POST /d1-inbox/link` with one, take its id before the scan and expect 404 (not found) after. A's own linked
  files stay linked and A's pointer rows keep A. Then run the re-stamp from the runbook ("An alias handed to someone else", including the `inbox_dirs` reset, without which the rescan skips the unchanged folder) for one folder: expect
  `file_readers_drift_count()` 0, the files in B's Inbox after the next scan and readable by B, not by A. Since: SEM reader final fix wave (C1).
- [ ] **SEM12 — A file moved inside a personal folder after migration 196 (I1: no ghost pointer row, owner kept).** On a copy of the database with
  196 applied and a person with a login whose folder holds a registered image, move the file to another subfolder on the share and run
  `make inbox-crawler-once` (daemon stopped). Expect the log line for the re-point and **no** `file_readers.directus_files_id: new file already linked`
  warning; one `directus_files` row for the file, at the new path, with the same `owner_person_id` as before; no row left for the old path
  (`SELECT count(*) FROM directus_files WHERE metadata->>'archive_path' = '<old path>'` is 0); the Inbox row (same candidate, same first-seen date)
  shows the new path; `SELECT d1_private.file_readers_drift_count()` is 0; the owner can still open the file and another Lab Member still cannot.
  Repeat for a file in a team folder. Since: SEM reader final fix wave (I1).
- [ ] **SEM13 — An owner links an SEM image in Data Studio and gets its settings after `--sem-backfill` (I2).** With **SEM3** passed, as account A
  (with the crawler having stamped a FEI TIFF in A's folder) link the file to a sample through Data Studio's file picker, not the Inbox: the file
  stays owned by A and has no `d1_private.sem_image_settings` row. Run `--sem-backfill` (daemon stopped, runbook "One-shot passes"): expect the log
  `sem-backfill: 1 saved ...`, a settings row with `read_by = 'backfill'` for that file, and the record page showing the values to A (Edit control
  present) and a lock to B (**SEM10**). A found file in A's folder that nobody linked must not be read (`INBOX_LOG_LEVEL=DEBUG`: no `reading` line for it).
  Run it again: 0 saved, nothing re-read for the finished file. Since: SEM reader final fix wave (I2).
- [ ] **SEM14 — A record with many images (STARbase, real Directus; I3).** Open a sample (or operation or test) that has 30 or more linked image files, as
  their owner and as another Lab Member. Expect the page usable at once (the Files list appears and scrolls while the settings fill in a few rows at
  a time), the browser network tab showing no more than 4 `/d1-inbox/sem-settings` requests in flight at any moment, every image ending with its
  settings (owner) or a lock (other member) and none stuck on "Reading imaging settings…". Note the load time to the last row. As an administrator
  open the same page: expect one `sem_settings_access_log` row per owned file read, so `SELECT count(*) FROM d1_private.sem_settings_access_log
  WHERE read_at > now() - interval '5 minutes'` equals the number of owned images on the page: record that count and decide whether the admin log
  volume is acceptable (every admin page view of such a record writes that many rows). Since: SEM reader final fix wave (I3).
- [ ] **SEM15 — The live upgrade and the rollback, with `EXTENSIONS_AUTO_RELOAD` on (I4).** On a restored copy of the production database and the same
  compose file (bind-mounted `core/extensions`, `EXTENSIONS_AUTO_RELOAD=true`), follow "Upgrading to the SEM reader" in `docs/runbooks/inbox-crawler.md`
  exactly. First, to see why the order matters, on a throwaway copy: leave Directus running, pull, and open the Inbox before migrating: expect 500s
  from `/d1-inbox/*` (and an undo that still works, since it checks for the settings table), then roll that copy back and start again in the right
  order. Then, in order: crawler and Directus stopped, pull, `make migrate` (time 196's back-fill and readers refresh), drift 0, Directus started once, SEM3
  passes, STARbase built, crawler started, `--reclassify`, `--sem-backfill`. Then the rollback on the copy in the documented order (crawler, extension,
  `down` 197, `down` 196, restart): expect the old Inbox working, files readable by every member again, and note what was lost (settings, owner stamps).
  Record the total time and every surprise. Since: SEM reader final fix wave (I4).
- [ ] **SEM16 — A one-shot pass started on an empty mount point.** With the real share's mount point present but the share not mounted (`umount` it, or
  stop the SMB mount, so `ARCHIVE_ROOT` is an empty directory), start `python -m inbox_crawler --reclassify` and then `--sem-backfill` on a copy of the
  database. Expect each to refuse at once: `aborted` in the log (the share root or the personal-folder base, `User` or `INBOX_PERSON_DIR`, does not answer),
  exit code 1, and no row marked (`classified_by` unchanged, no `sem_image_settings` row added). Mount the share again and expect both to run to their end.
  Since: SEM reader final fix wave.
- [ ] **SEM17 — More than 25 deleted dismissed rows do not abort `--reclassify`.** On a copy of the database, dismiss (or find) at least 30 image candidates
  whose files have since been deleted from the share (state `dismissed`, file gone). Run `--reclassify` with the share mounted: expect the log
  `reclassify: ... N skipped ...` with N at least 30, no `aborted`, exit code 0, and every other eligible row still processed (a missing file is skipped, it
  never counts toward the 25 transient errors that abort a pass). Run it again: the same rows are skipped again (they stay queued), still no abort.
  Since: SEM reader final fix wave.
- [ ] **SEM18 — Deactivating, and deleting, a person who owns files (`ON DELETE RESTRICT`).** In Data Studio, set a person who owns found files (an alias, a
  login, owned rows in `directus_files`) inactive: expect it to save, the person's folder to stop being scanned (unless "scan while Former"), their owned
  files to stay owned by them and readable by their login, and the admin tab to list nothing new as unowned. Then try to delete that person (People page, and
  `DELETE /items/people/<id>`): expect a refusal, and the person and their files unchanged. Since migration 201 the message names the person and the count ("X cannot
  be deleted: they own N found file(s) on the share. Set them inactive instead, or re-stamp their files first ..."; Directus still answers HTTP 500 with a `delete from "people" ... -` prefix; before 201 it showed
  only the raw `directus_files_owner_person_id_fkey` error). The same for a team that owns files. An administrator removes such a person by re-stamping their files first (the runbook "An alias handed to
  someone else"). Since: SEM reader final fix wave (ADR-0022 consequences); message: migration 201.
- [ ] **SEM19 — Team membership: `d1-inbox` counts active members, `file_readers` counts every member with a login (M3, ADR-0022 consequences).** With a team
  that has a share folder and a team-owned file, and a team member who is a Former (inactive) person with a login still active in Directus: as that
  person, `GET /files/<id>` of the team's file must answer 403 and the Inbox shows them no team files, badge 0 and no team in the summary (d1-inbox counts only
  `people.active` members). As an active member both work; setting the person active again gives `GET /files/<id>` 200 at once and inactive 403 again, with
  `file_readers_drift_count()` 0 (migration 201 made a team owner count active members only, and `people.active` refreshes the readers; before it the Former member got 200). A **person** owner who is inactive
  still reads their own files. Since: SEM reader final fix wave (M3); migration 201.

- [ ] **SEM20 — The indexer's own move keeps the owner (re-review finding).** On a copy of the database with 196 applied, take an owned image registered by the crawler, move it on the share out of `Users/<alias>` into a project folder, and run `make index-archive` (full run). Expect one `directus_files` row for the file at the new path with the same `owner_person_id` as before (not NULL), no row for the old path, and `file_readers_drift_count()` 0; a member who is not the owner cannot read it. Since: SEM reader final fix wave (`index_archive.carry_owner_stamp`, ADR-0022 D13).
- [ ] **SEM21 — A folder that changed hands, with thumbnails and ignored folders (merge of the SEM reader and PR #338).** With **SEM11** set up (the alias now B's; **the scan deletes A's unlinked candidates**, so after B's scan stamp one of B's registered candidates and its file to A by hand
  to stand in for "A's old candidates kept") and the crawler having stored thumbnails for some of them:
  as B, `GET /d1-inbox/files/<one of A's candidate ids>/thumb` and `/preview` answer 404 NOT_FOUND with no ETag or caching headers, while B's own images
  still show their thumbnails. Then, as B, *Ignore this folder* on a folder that holds both B's own open files and A's old ones: expect the notice's
  count to include B's files only, B's files in Dismissed, and A's old candidates untouched (still `state = 'new'`, `decided_by` NULL). As A (or an
  administrator) nothing of A's changed. Accept all as B for that filter links none of A's files. Since: merge of origin/main (ignored folders, PR #338)
  into the SEM reader branch.

- [ ] **DEPLOY1 — Install the deploy agent and reach it from Directus (deploy button).** On d1-server follow `docs/runbooks/deploy-button.md` "Install":
  set `DEPLOY_AGENT_TOKEN` in `.env`, run `infra\deploy-agent\install.ps1`, recreate Directus. Expect: the task **D1 Deploy Agent** exists (current user, logon type S4U so it runs
  with nobody logged on, at startup and at logon, restart every minute, no time limit); `curl http://127.0.0.1:8212/health` answers `{"ok":true}`; the agent does NOT answer on the machine's LAN or Tailscale
  address (it binds 127.0.0.1); with the token removed from `.env` the task fails to start and logs "Refusing to start"; from inside the Directus container
  `curl http://host.docker.internal:8212/health` answers (Docker Desktop must forward to a service on the host's loopback; if it does not, the agent has to bind another
  address and the runbook changes). A request without `X-Deploy-Token`, or with a wrong one, answers 401.
  **Unattended reboot:** reboot d1-server and do NOT log on. After a few minutes `curl http://127.0.0.1:8212/health` answers (the agent started by itself), Docker Desktop is running,
  and a Check from the Deploy page succeeds (git fetch works with nobody logged on). If the fetch fails there (an S4U task cannot read the Windows credential manager), reinstall with
  `-StorePassword` and repeat. Since: deploy button, stream A (PR: the deploy-agent branch).
- [ ] **DEPLOY2 — Check for updates on a real update.** With origin/main ahead of the live branch: `node scripts/deploy/deploy.mjs check` (and `POST /check` through the agent)
  lists the same commits as `git log --oneline HEAD..origin/main`, `changedCount` equals `git diff --name-only HEAD...origin/main | wc -l`, `steps` match the table in the
  `starbase-deploy` skill for those paths, every new migration is listed and a destructive one is flagged, and `dirty`/`overlap` match `git status --short --untracked-files=no`.
  Afterwards `git status`, `git log` and `docker compose ps` are unchanged (check only fetches). On an up-to-date checkout: `upToDate: true`. With `git` older than 2.38
  (no `merge-tree --write-tree`): `conflicts` is `null` and no conflict is claimed. Since: deploy button, stream A.
- [ ] **DEPLOY3 — Deploy a trivial commit (docs only), then one that rebuilds.** First a commit that changes only a doc: Deploy merges it and reports success with every
  other step skipped (no build, no restart, no backup). Then a commit that touches an extension under `core/extensions/`: the log shows `##STEP build` (`npm run build:extensions`),
  `docker compose up -d --force-recreate directus`, and the health check passing; the Deploy page keeps polling through the Directus restart ("Directus is restarting...") and shows
  the result afterwards. `result.json` names the actor (the admin's user id), `fromSha` and `toSha`. `git status` shows only the maintainer's own uncommitted edits and the merge commit
  is unpushed on the live branch. Since: deploy button, stream A.
- [ ] **DEPLOY4 — Refusals leave everything as it was.** Using a throwaway branch of main: (a) an update that changes a file which has an uncommitted edit on d1-server: check shows an
  `overlap` blocker and Deploy refuses at `preflight`, with no merge and no backup; (b) an update that conflicts with a local commit: `conflict` blocker naming the paths; (c) an update
  with a migration whose `migrate:up` contains `DELETE FROM` or `DROP COLUMN` (and a harmless one whose only such statement is in `migrate:down` or in a comment): only the first needs
  the acknowledgement, a Deploy without it is refused at `preflight`, with it the run proceeds. Never use the live database for the destructive one: use a clone. Since: deploy button, stream A.
- [ ] **DEPLOY5 — A deploy that carries a migration.** On a copy of the stack (not live data first): an update with a pending migration. Expect `##STEP worktree`, `##STEP migrate` running
  dbmate from `ghcr.io/amacneil/dbmate:2` on the `d1-database_d1net` network with the worktree's `db` folder mounted (the checkout path contains spaces: the mount must work on Windows),
  `backup.sh` run first through `DEPLOY_BASH` with the dump name in `result.json`'s `backup`, `up` applying the migration, then the merge; the temporary worktree
  `.claude/worktrees/deploy-main` is gone afterwards. With no pending migration (migration file already applied): no backup is taken. Since: deploy button, stream A.
- [ ] **DEPLOY6 — The agent replaces itself, and survives being killed mid-run.** (a) Deploy a commit that changes `infra/deploy-agent/agent.mjs`: after the run is recorded the agent exits
  with code 75 and `run-agent.ps1` (the task's wrapper) starts the new code within seconds; the log shows two `listening` lines. Also stop the agent with a wrong
  token (exit 1): the wrapper restarts it after 2 s, 4 s, ... up to 60 s (the log shows each wait). (b) Start a deploy, then stop the task (or the machine) mid-run: after the agent starts again the run shows `interrupted`, the lock is gone,
  and a new deploy can start. (c) With the task stopped, the Deploy page says the agent is unreachable and offers the fix hint. Since: deploy button, stream A.
- [ ] **DEPLOY7 — Failure messages are usable.** Make a build fail on a scratch branch (a syntax error in an extension) and a service fail its health check: the run stops at `build` / `verify`,
  `failedStep` and `message` say which build or which service, the log shows the output, and the page shows the message. A failed `npm install` never falls back to `npm ci`. Since: deploy button, stream A.

### Bulk actions (2026-10-20, migration 204, `feat/bulk-actions`, d1-server)

Server half of the bulk actions (docs/superpowers/specs/2026-10-20-bulk-actions-design.md). The `node --test` suite uses a fake knex and a fake
`ItemsService`; what only a live Directus can show is below. Run on a copy of the stack (not live data), as an administrator, a Lab Member who owns the
records, and a Lab Viewer, with the Directus token of each. `POST /d1-bulk-actions/<collection>/preview|apply`, bodies as in the endpoint's header.

- [ ] **BULK1 — The preview writes nothing, with real hooks.** On 5 samples run `preview` for `edit_field` (`current_status` to `archived`), then compare:
  `audit_logs`, `directus_activity`, `directus_revisions` and the samples' `updated_at` / `version` are unchanged, and no flow, `d1-project-inherit` or
  `d1-campaign-inherit` action ran (watch the Directus log). Repeat for `project_id` on samples that have operations, and for `restrict`. The same ids then `apply`:
  every record's status in the preview equals its outcome in the apply. Since: bulk actions, PR 1.
- [ ] **BULK2 — `updateOne` with a transaction, `bypassEmitAction` and `autoPurgeCache: false`.** The code relies on Directus 11.17's `ItemsService.updateOne(id, data, { bypassEmitAction,
  autoPurgeCache })` inside a caller-supplied knex transaction: filter hooks (d1-access-guard) still run and see the transaction, action events are only collected. Apply
  `edit_field` `project_id` to samples that have operations: afterwards the operations' project follows (the action hooks ran once, after the commit, and not during a preview), the sample
  list shows the new value without a cache clear in between when `CACHE_ENABLED=true`, and `audit_logs.actor` names the caller (not "public" or the system). Since: bulk actions, PR 1.
- [ ] **BULK3 — d1-access-guard decides, its text is the reason.** As a Lab Member owner, `apply` `restrict` on 3 own samples: each is `skipped` with "Restricting a record is not available yet. Ask an
  administrator." and nothing changed; as an administrator the same call is `applied`. `edit_field` `project_id` to a restricted project the member cannot read: 400 "does not exist, or you cannot see it" (no
  hint that it exists). A sample inside a restricted campaign the member does not own, edited for `project_id`: `skipped` with the guard's sentence. Another person's unreadable sample in the id list: `skipped`, code `null`.
  Since: bulk actions, PR 1.
- [ ] **BULK4 — Undo and revert on real rows.** As the owner: `apply` `edit_field` `current_status`, then `undo` inside 60 s: every record is back, `bulk_actions.state = 'undone'`, a second row with `revert_of` exists.
  After 60 s the owner's `undo` is 403 `UNDO_WINDOW_CLOSED`; an administrator's `undo` and `revert` work. Change one record by hand in Data Studio, then `revert`: that one is `changed_since`, the action is
  `partly_reverted`. Share a restricted sample with someone (Who has access), then revert the restrict: `changed_since` (the snapshot holds the access list). Dates: a sample's `manufactured_date` edited and
  undone comes back as the same day (no timezone shift; the code reads Directus' `YYYY-MM-DD`). Two `revert` calls at once: one answers 200, the other 409 `ALREADY_REVERTED` (row lock). Since: bulk actions, PR 1.
- [ ] **BULK5 — Lab Viewer, caps and the journal.** A Lab Viewer token: `preview`, `apply`, `undo` and `revert` all 403 `READ_ONLY_ROLE`. 101 distinct ids: 400; the same id 150 times: one result.
  `GET /d1-bulk-actions` as the owner lists only their actions, as an administrator every one, newest first; `GET /:id` of someone else's action is 404 for a member. Applying to 100 samples takes
  how long on the real stack (one transaction per record): note it, the toast's 60 s starts when the answer arrives. Since: bulk actions, PR 1.
- [ ] **BULK6 — The extraction changed nothing for the Who-has-access dialog.** d1-record-access's routes now call the extracted bodies. On a copy, with the Who-has-access dialog of a sample: add a person (mail
  arrives once, "gave you access"), change their level (no mail), remove them; add a team (one mail per active member with a login, "via <team>"), change its level and trust switch, remove it; transfer to a person
  (new owner mailed, `blocked_by` shown) and to a team (managers mailed once each, the previous person owner stays on as Can edit). Same answers, same mails and the same `audit_logs.actor` as before the change.
  Since: bulk actions, PR 2.
- [ ] **BULK7 — assign_team and change_owner on real rows, with the real manage rule.** As a Lab Member owner of 5 samples: `preview` `assign_team` to a team you do NOT manage: every row `ok` with the
  warning "You will no longer be able to manage this record yourself, so an undo may be refused."; to a team you manage: no warning. `apply`: `owner_team_id` set, `owner_person_id` null, you stay as Can edit,
  the database's owner grant and the team members' derived rows appear (`sample_access`, `sample_team_access`). A team with no manager: `skip` with the TEAM_HAS_NO_MANAGER wording; Projects: `skip`
  "A team cannot own this kind of record." `change_owner` to a person who cannot open the record yet (restricted parent): the warning names them; a person with no login: "has no D1 login yet". Team-owned
  record, as one of its managers, to a person or another team: the warning says the outgoing managers are not kept. Another person's record in the list: `skip` "You are not the owner of this record." (checked before
  "already the owner"). Since: bulk actions, PR 2.
- [ ] **BULK8 — share_access and remove_access, including old co-owners.** `share_access` a person as Can view to 10 samples where 3 already have them at that level (`noop`), 2 at Can edit (changed) and 1 where
  they are the owner (`skip` "That person is the owner already."). A team: add, change level, the owning team is skipped. A sample whose co-owner is only in the old `sample_co_owners` table: sharing at Can edit is
  `noop`, at Can view converts it to an access row and drops the old row (undo puts an access row back, not the old row: note the difference). `remove_access` of the owner: skipped with "Change the owner instead."; of
  a person who is only an old co-owner: applied. Since: bulk actions, PR 2.
- [ ] **BULK9 — Undo and revert of the ownership and access kinds.** Undo of `share_access`, `remove_access` and `assign_team` to a team you manage inside 60 s: the list, the team grants and the owner are exactly as
  before (compare `sample_access` and `sample_team_access` rows). Undo of `assign_team` to a team you do not manage, and of `change_owner`: `refused` "You can no longer manage this record ..." (Ruling O5: expected, the
  administrator's `revert` does it and drops the Can edit row you were given). Revert after the old owner team lost its last manager: `refused` with the no-manager reason. A person shared with since: `changed_since`.
  Nothing is mailed by a revert. Since: bulk actions, PR 2.
- [ ] **BULK10 — The summary mails with a real mail transport.** `assign_team` on 25 samples: the team's managers get ONE mail each, 62 s after the answer, listing 20 codes and "and 5 more" with links that
  open the records (STARBASE_URL or PUBLIC_URL set); the person who ran it gets none; `bulk_actions.mail_state` goes `pending` -> `sent`. `share_access` with a team: one mail per active member with an address; a login with
  an empty address, an inactive person, a member with no login and a member still waiting for approval on that record get none (a person shared with directly who has no login is mailed at their People address, with no links). Undo inside the window: no mail ever arrives and `mail_state = 'cancelled'`. A recipient who
  cannot read a record gets its code and no link. Since: bulk actions, PR 2.
- [ ] **BULK11 — The mail survives a restart.** Apply a `change_owner`, restart the Directus container inside the 60 s window: the mail still goes out about when it was due (the startup sweep re-arms it, `mail_state`
  `pending` -> `sent`); undo after the restart (still inside the window) cancels it. Apply, restart AFTER the due time without the endpoint having sent it (stop Directus before the 62 s, start it later): the
  sweep sends it on start, once. With no `getSchema`-dependent failure in the log: the timer and the sweep have no request, so `MailService` is given the schema from `getSchema()`; confirm the mail renders and
  arrives (if the transport needs the schema, this is where it would show). Since: bulk actions, PR 2.

## Done

(Move ticked items here with their date and result.)

### SEM reader: rehearsal on a copy of the live database (2026-10-16, d1-server)

Run on a throwaway stack (`sem-copy-*` containers: a `pg_dump` restore of the live database at migration 195, a Directus on
port 18061 with this branch's extensions, the crawler container with the real share mounted read-only, STARbase from `vite`
on 5191 pointed at the copy). The live stack was only read (the dump). Not ticked above because each item was run on a
**few folders** (about 60 trial images, not the whole corpus) and on a copy, not live. Test accounts were created on the copy only.

| Item | Result |
|---|---|
| SEM7 | The pip lines import in a clean `python:3.12-slim` (PR #343). Reading real bars needed two fixes (below). |
| SEM1 | `mtp23cab` (1,653 images, no OCR): 840 FEI TIFFs promoted, 50 earlier false `sem_image` rows demoted, every TIFF `kind_confidence` 0.95, all 8 fields present, `sources` all `metadata` (magnification `derived`), BST/GMT offsets all equal to London's (487 BST, 353 GMT, 0 wrong), no flags, owner stamps all the folder's person. With OCR on 57 more images in three `mtp23jjk` folders: **54 had `scale_bar_um: length_mismatch`** (bug 1). After the fix: 0 flags. Not covered: the 2,048-px image, a `40×` bar, the thermal/EDS controls by name. |
| SEM2 | 8 contrast-edited PNG exports and 2 TIFFs without metadata: every value equal to the TIFF namesake's (wd to the bar's 1 decimal), `sources` `ocr`, confidence 0.8, no `check_this` once the bar length confirms. One wrong value found: mode read `None.` from a bar that prints `None` (bug 2). No JPEG or BMP namesake pairs tried. About 0.4 s per registered image on CPU with OCR (57 images in 23 s, folder listing included). |
| SEM3 | Owner filter accepted by Directus (no `_some` error). A 200; B and a Lab Viewer 403; admin 200; unowned uploads stay open to every member; `PATCH owner_person_id` 403; B cannot patch or delete A's file (403); team folder: member reads, non-member 403, added 200, removed 403; sample link: B and the Viewer get `directus_files_id: null` with the row id present, A gets the file. Observed: deleting a file whose storage is `star` answers 500 after the row is gone (no `star` location is declared, so it is not new). |
| SEM5 | Database half: migrations 196-199 apply in **3.1 s** on 82,519 candidates / 255,346 files; stamped 82,519 = candidates not linked and not in a junction; no junction-linked file stamped; `file_readers_drift_count()` 0; four `down`s then `up` again also 0. Crawler half: `--sem-backfill` without OCR 4 saved / 5 not an SEM image (a bar-only image is not recognised as SEM without OCR, so it is counted there and not under "no usable value"); with OCR 3 more; again 0 saved. Settings values equal the metadata. Not run: the `save_sem_settings` correction check by SQL, kill half way. |
| SEM6 | On a queue cut to 90 rows: 8 promoted, 60 demoted (thermal JPEGs, "Microscope x5/x20" TIFFs, EDS spectra, charts, a TEM), 22 unchanged, 0 skipped; a second run 0/0/0 and no file opened. Not run: `--force` over the whole corpus, kill half way, share pulled mid-run. |
| SEM8 | A GET `can_edit` true; B and a Lab Viewer `{locked:true}`; admin values with `can_edit` false, one `admin_read` row per call, none for A; A PATCH `kv` 20 → `sources.kv = manual`; B and admin PATCH 403; `read_by` 400; kV 99 400. Admin link/dismiss/undo 403 with the documented message. An unowned linked file: B reads the values, no edit. Inbox link then undo drops the settings row; Data Studio link, then Inbox link, then undo keeps it. **Finding:** magnification 5000.5 is accepted and saved as 5001 (SEM10 expects a refusal; decide if non-integers should be refused). |
| SEM9 | FEI row: labelled values in the specified order with `metadata`/`derived`/`OCR` labels, "15 Apr 2026, 19:31 BST", winter rows `GMT`, no confidence shown; PNG export row all `OCR`, no "check this" (the bar confirmed). Not seen: a "check this" row, a "couldn't read" row, a JEOL row. |
| SEM10 | As the owner: values, an Edit control on every field, "not set" for empty ones. As B: 37 locks "A file from another person's folder", the count 38 includes them. Not tried: typing a UK summer/winter time, the admin page view. |
| SEM11 | First half: after handing the alias to B and a scan: B's Inbox lists none of A's files, the log says `N file(s) stamped to another owner left out of the inbox`, B's link of A's candidate 404, A's file stays A's, B 403 on it. The scan also deleted A's old candidates for that folder (`drop_foreign_state`), so "A's old candidates kept for the test" needed a hand stamp. Re-stamp half (runbook SQL for one folder, 18 files, then a scan): the 14 unlinked files registered for B, B's Inbox lists 14 and A's 0, B reads (200), A 403, drift 0. |
| SEM12 | On a new person with a folder under a fake share root (a copy of one real TIFF): moved to another subfolder, the scan logs `re-pointed ... to ...`, the candidate keeps its id and first-seen date, one pointer row at the new path with the same owner, none at the old one, drift 0, the owner reads (200), another member 403, no `already linked` warning. The same for a team folder (owner team kept). |
| SEM15 | On a second restore of the production dump (migration 195): the new extension on the old schema answers **500** on `/d1-inbox/summary`, `/files` and `/sem-settings`. The documented order (Directus stopped, `migrate`, start): 196-201 apply in 3 s in all (196 itself 2.2 s; 82,519 stamped, drift 0), the Inbox routes 200, a Lab Member gets 403 on an owned file. Rollback (previous `d1-inbox` put back, then `down`): **six** `down`s are needed, not two (201, 200, 199, 198, 197, 196: each `migrate-down` takes the newest one); afterwards the old Inbox answers 200, the owner columns and the settings table are gone and the same member reads the file again (200). The runbook said "197, then 196" (fixed). Not rehearsed: `make` (not on the host), STARbase build, the daemon's start order. |
| SEM20 | On a scratch database (schema of the copy) with a fake share: an owned file registered by the crawler, `index_archive.py --fingerprint` before and after moving it out of the personal folder to `projects/p1/`: `1 moved (links re-pointed)`, one row at the new path with the same owner, none at the old path, only the owner's login in `file_readers`, drift 0. |
| SEM14 | 38 linked images, 37 owned: 38 `sem-settings` requests in 289 ms with **at most 4 in flight**. Admin view logged 8 rows: only images that have a settings row are logged, not every owned image on the page. |
| SEM16 | Both `--reclassify` and `--sem-backfill` on an empty root: `aborted`, exit 1, nothing marked. |
| SEM17 | 35 dismissed rows with missing files: `35 skipped`, exit 0, no abort, the same 35 skipped again. |
| SEM18 | Deactivate saves; the owner still reads their file; `DELETE /items/people/<id>` answers **500 with the raw SQL** ("violates foreign key constraint directus_files_owner_person_id_fkey"). Understandable to a developer, not to a Directus admin. |
| SEM19 | Confirmed: a Former member with an active login reads the team's file by id (200) while the Inbox shows them no team and 0 files. Decision for the maintainer. |
| SEM21 | B gets 404 for thumb and preview of A-stamped candidates, the same answer as for an unknown id (no way to tell them apart); the 404 carries Express's weak ETag of its own JSON body, not a picture's. Ignore-folder half: **found a bug**: *Ignore this folder* dismissed 0 of B's 11 open files because `d1-inbox` built the folder as `Users/<alias>` while the share's is `User/<alias>` (the crawler's `INBOX_PERSON_DIR`); with the variable passed to Directus (compose) it dismisses all 11 and leaves A's 3 stamped candidates `new` with no `decided_by`. |
| Not run | SEM4 (GPU), SEM13 as written (its `--sem-backfill` effect was seen under SEM5). |

Bugs found by this run (both fixed in PR #348): (1) the FEI scale bar is drawn through its own label, so `scale_bar_length_px` measured
one half (89 px of 260) and the length check failed on nearly every real image, losing the exports' magnification; (2) the recogniser's
trailing full stop on a text cell (`None.`). Later findings, fixed in PR #350 (merged with them): former team members, the delete message,
whole-number magnification. Found in the last part: `d1-inbox` hard-coded `Users/<alias>` for *Ignore this folder* (fix: `INBOX_PERSON_DIR`
passed to Directus, default `User` in compose; redeploying needs the compose change and a Directus recreate).
