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
3. Move fully ticked sections to **Done** at the bottom once a month or so, so the open list stays
   short.

Item ids are the UX review's (`docs/reviews/2026-10-05-ux-utility-review.md`) or the GitHub issue
number. "Since" is the PR that shipped the code.

## A. Live Directus (local stack with real data)

Start with `make up`, apply migrations (`make migrate`) and the configure scripts
(`scripts/configure_all.sh`), restart Directus so new extensions load, then sign in as each role
named in the step.

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
  read campaigns and the lab wants them, add the read grant by migration. Since: this batch (PR TBD).

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
  location" match a hand count. Re-run `scripts/configure_directus.sql`: they are still there,
  once each. Since #125.

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
  label: text and QR sit inside each label, the `start` offset skips used labels. Since #124.
- [ ] **D4 — scan to open.** Scan a printed QR with a phone on the lab network: it asks to sign in,
  then opens that sample's record. Nothing is visible without signing in. Since #124.
- [ ] **D4 — permissions and dates.** A role that cannot read a sample gets "not found" for it in a
  label request. With `D1_TIMEZONE=Europe/London` set, a sample created just after midnight BST
  prints the right date. The picker shows "(200 of N)" when there are more than 200. Since #124.

### Plot dashboard inside Directus
- [ ] **P3 — links in the Directus module.** "Copy link" in the Directus-hosted Plot opens the same
  view in another browser. Check the browser's network tab: changing the view does not flood
  `PATCH /users/me/track/page`. Since #124.
- [ ] **P2 — PNG export in Directus.** "Save chart as PNG" and "as SVG" download a correct image
  (Directus's CSP allows the `blob:` image used for the PNG). Since #125.

### Sample timeline and campaign overview
- [ ] **D5 — timeline on a real sample with genealogy.** Restart Directus so `d1-trace` and the
  rebuilt Lab Dashboard load. Lab Dashboard > Samples > pick a sample that has a parent, a child, a
  raw stock lot, operations and tests > **Timeline** tab. Expect: stock lot, ancestors (oldest
  first), the sample, operations and tests in date order, then descendants, matching
  `SELECT * FROM f_sample_timeline('<id>')` and the `f_trace_*` functions run by hand. Every entry
  opens its record. `GET /d1-trace/sample/<id>` is 401 signed out, 403 for a user without app
  access, 400 for a bad id. Since: this batch (PR TBD).
- [ ] **D5 — hidden items for a restricted role.** Sign in as a role whose item filter hides some
  of that sample's relatives, operations or tests. Expect: the Timeline shows only what the role can
  open, with "N items are not visible to you" lines where something was dropped; no code, id or
  operator of a hidden record appears in the JSON of `/d1-trace/sample/<id>`; a sample the role
  cannot read gives "not visible to you" (404). Field level: give the role a field rule that hides
  `form` (samples), `pass_code` or `operation_date` (operations), `status` (tests), `supplier_name`
  (lots), `fraction` or `mass_used_grams` (genealogy, stock provenance): the JSON has `null` for
  that field and the Timeline shows the record without it. A role with no access to
  `sample_genealogy` still sees the relatives, just without relationship type or fraction. A raw
  stock lot reached through a hidden ancestor reads "via a sample you cannot see". Since: this batch
  (PR TBD).
- [ ] **D5 — diamond genealogy and a huge genealogy.** On a sample whose ancestors merge (two
  parents that share a grandparent) each sample appears once in the Timeline and the counts match
  `SELECT count(DISTINCT sample_id) FROM f_trace_ancestors('<id>')` minus the sample itself. On a
  real database, time `GET /d1-trace/sample/<id>` for the sample with the largest genealogy: it
  answers within the 8 s limit, or with "this sample's genealogy is too large to trace" (503)
  shown in the tab; either way Postgres is not left running the query (`pg_stat_activity`). Since
  migration 136 the functions walk samples, not paths, so the 503 should no longer happen (the 8 s
  deadline stays as a safety net; see the next item). With more than 500 ancestors, descendants
  or events the tab says only the nearest 500 relatives / newest 500 operations and tests are
  shown. Since: this batch (PR TBD).
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
  `sample_id`s and `min(depth)` per sample match. Since: this batch (PR TBD).
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
  `failed`). Since: this batch (PR TBD).
- [ ] **D11 — pickers.** In a campaign, add a sample by code, then a test session that is in no
  campaign: each appears in the overview, the counts rise, and the test session shows the campaign
  in its own form. Remove both again. A sample that only appears through an operation is marked
  "not in list" and its + button adds it. Also add and remove an operation and check the overview
  reloads. Race checks, with the campaign open in two browser tabs: add the same test session in
  both, the second gives "already in another campaign" (not an error from Directus) and the
  session stays in the first campaign; add the same sample in both, the second just reloads with no
  error. The batch `PATCH /items/test_sessions` answer lists the changed row for a role that may
  read test sessions, so a normal add never shows the "already in another campaign" note. Since:
  this batch (PR TBD).

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
  label** and **Report** open in a new tab. Operations and tests that you click open their
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
  `PUBLIC_URL` set to an address the phone can reach. Since: Explorer pages E4 (PR pending).
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

## B. Force rig (NI-DAQ, Lab Amp, packaged Windows app)

Install the current release from the update feed on the acquisition PC. Use a real sample and
tool; a test cut on scrap stock is fine.

### Recording
- [ ] **R4 — pre-flight chips.** With the Lab Amp in MEASURE: Amp chip OK. In RESET: OK (Start
  cycles it). Unplugged/unreachable: warning. Channels chip checks the saved NI-DAQ model and goes
  to "fail" when a configured channel is missing from the chassis. Disk chip's "~N min" roughly
  matches free space ÷ data rate. Since #124.
- [ ] **R5 — live clipping.** Drive one channel to its rail (lower the amp range, or a known
  overload) at a Lab Amp full scale of 10 V, then 5 V. Expect the red banner naming that channel,
  the tile and badge, and after the cut `channels_ranging.clipped` true for the same channel only.
  Since #124.
- [ ] **R6 — alarms on hardware.** Early warning at 80 % of the force limit (amber, no tone). With
  "Stop the recording when the force alarm trips" on, a trip stops the cut, the alarm stays on top
  of the save dialog and A acknowledges it. With a tone volume set, Windows volume is not changed.
  Since #125.
- [ ] **R10 — shortcuts in the packaged app.** Ctrl+Enter starts (through the pre-flight and alarm
  test), Ctrl+. stops, A acknowledges, Ctrl+N starts a new cut, Enter saves. Press Alt once, then
  A during an alarm: A must still acknowledge (Alt opens menu mode on Windows). Since #125.
- [ ] **R1/R3 — remembered setup.** Quit and relaunch: Sample, Machine, Operator, op type and cut
  parameters are back. Open a cut in Replay, then switch to NI-DAQ: the form shows your setup, not
  the archived cut's sample, edge or sequence. New steps the sequence. Since #123.
- [ ] **Leaving the page mid-cut.** Start a cut, go to Plot, come back after it ends: the save dialog
  offers to save it. Since #123 (doc fix).

### Captures list (thousands of captures on the real drive)
- [ ] **R9 — browse speed on the real capture drive.** With the capture drive holding about 1,000
  or more captures (a network drive if that is what the lab uses; copy old captures in if needed),
  open Settings > Local Captures. Expect the first 200 rows within a few seconds, "Showing 200 of
  N" with the true N, and Load more adding the next page. Press Refresh again: a warm scan should
  be clearly faster than the first. Note both times and the drive type here. Since: this batch (PR
  TBD).
- [ ] **R9 — search, sort and filters at scale.** Search a sample name, a date (`2026-10-02`) and an
  id fragment: results match a hand check in File Explorer. Sort by Largest first: the top rows are
  the biggest folders. The Not uploaded and Uploaded chips keep loading pages and the footer's
  "checked" count makes sense. Needs a real Directus so the uploaded state is real. Since: this
  batch (PR TBD).
- [ ] **R9 — bulk delete frees the space.** Select a handful of uploaded captures and Delete
  selected: the confirm's space total matches the drive's free space gained (Explorer or the
  "Free on drive" figure after Refresh), the folders are gone, and the remote backup copy is marked
  deleted rather than removed. Include one not-uploaded capture: the only-copy warning appears.
  Cancel mid-run: the rest are untouched. Since: this batch (PR TBD).
- [ ] **R9 — cleanup never touches unsynced captures.** With real uploaded and not-uploaded
  captures older than N days, Free up space > Preview lists only captures that have a real
  `manufacturing_operations` row AND a `machining_force_analysis` row with `live_cache_file` (and
  `directus_files_id` when a `.mat` exists); cross-check three in Directus. Make one orphan: in
  Directus delete the analysis row of an old uploaded capture (or stop an upload after the run row
  is created); it must show "partial upload", keep its Upload button, be absent from the preview,
  and get the only-copy warning in a bulk delete. Not-uploaded, incomplete and
  queued ones are absent at any N. Run it and confirm those are still on disk. Repeat with Directus
  stopped: the preview must refuse. Since: this batch (PR TBD).
- [ ] **R9 — upload-all progress and cancel against the real Directus.** With three or more
  not-uploaded captures, Upload N unsynced: the bar shows "Uploading n of m" and the capture name,
  Cancel stops after the current one and says how many were not attempted, and each uploaded
  capture has exactly one operation row (no duplicates after cancelling and running again). While
  it runs, Delete selected, Free up space and the row Upload buttons are disabled; click a row's
  Upload just before Upload N unsynced: that capture is still uploaded once. Open a row's Delete
  confirm, leave it open until Upload all reaches that row, then confirm: nothing is deleted and
  the row says it was busy. Since: this batch (PR TBD).
- [ ] **R9 — a partial upload is completed, not skipped.** In Directus, clear `directus_files_id`
  on the `machining_force_analysis` row of a capture that has a `capture.mat` (it then shows
  "partial upload"). Press its Upload: expect no second operation row, no second analysis row, the
  `.mat` uploaded once and its link filled in on the same row (the live cache file link and file
  are untouched), and only then the row shows "Uploaded". Repeat clearing `live_cache_file`
  instead. Then Upload on a complete one is not offered. Also stop Directus right after an upload
  returns: the row must not show as uploaded without the check. Since: this batch (PR TBD).

### Desktop shell
- [ ] **R11 — Restart recorder.** Kill the backend (Task Manager): the Doctor's "Restart recorder"
  brings it back and the doctor goes green. While recording: it refuses. With the backend hung
  (not answering, still running): it asks first, default "Don't restart". The port is free after
  restart (no "address in use"). Since #125.
- [ ] **R13 — update prompt and Help menu.** Publish a test release with notes: the prompt shows them
  as plain text with the releases link. Alt shows the menu bar; Help → Check for Updates, Report a
  Bug, Open Captures Folder (opens the capture drive), About all work; Ctrl+Shift+L/B/O work.
  Since #125.

### Diagnostics page in the packaged app
- [ ] **P10 — recipe dialogs and import/export.** In the packaged app, Save as (name + notes),
  Rename and Delete use the in-app dialog (Escape closes, focus returns to the button). Export a
  recipe, Import it back: it opens in the Save dialog; importing a hand-broken file is refused with
  a reason. The "modified since loaded" badge appears after editing an applied recipe.
  Since: this batch (PR TBD).
- [ ] **P10 — searchable picker on real data.** With the full campaign list, search, the Needs
  build / Built / Error chips and Group by (sample, campaign) work; campaign names appear for
  cuts that belong to one; Open in Plot lands on that cut and Directus opens the analysis record.
  Since: this batch (PR TBD).

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
  still works as before (and may drift after the edit). Since this PR.
- [ ] **Touch long-press on a touchscreen.** On a touchscreen laptop or tablet: hold one finger on
  the map (Lite 2D, Lite 3D, Full) and on a Force chart for ~0.5 s. Expect the menu to open once, a
  little down-right of the finger (not under it), with the pick under the finger. A drag or
  two-finger pinch must still pan/zoom and never open the menu. Android Chrome: the menu opens once
  (no second browser menu); iOS Safari: no text callout or magnifier. Since this PR.
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
  memory: this batch, PR TBD).

### Earlier issues that need the rig (from the 2026-10-02 batch)
- [ ] **#84** Real DAQmx error text and codes (‑200077); whether the chassis or the module limits the
  rate; coerced rates on discrete-rate modules.
- [ ] **#86** NI-DAQ hot-plug, and whether NI MAX simulated devices count as "present".
- [ ] **#109** Real Lab Amp latency.
- [ ] **#96, #101** Explorer reveal and network-drive behaviour on Windows.
- [ ] **#81** DAQ buffer overruns while a 12 GB finalize runs beside a live acquisition (held back:
  needs the chassis).
- [ ] **#90** Packaged NSIS build and the Tailscale update feed (held back).

## C. d1-server and infrastructure

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
  shows the saved window, matching the charts. Since this PR.

- [ ] **Diag clustering is CPU-independent.** Rebuild a diagnostics analysis on `d1-server` for a cut
  built before 2026-10-06: cluster ids match the old result. (`scripts/diag/spatial.py` pins
  HDBSCAN's tie order; the goldens pass with and without AVX-512, but the server's CPU decides
  which side old results were built on.) Since #123.
- [ ] **filter-service `/fft` change deployed.** After redeploying the plugin, the Plot overlay reads
  in N rms (see the FFT check above). Since #125.
- [ ] **P10 — batch diagnostics build on d1-server.** In Diagnostics, tick 3 or more analysed cuts
  (at least one already built with the default recipe), Apply recipe to selected with a library
  recipe. Expect: the summary says queued / skipped; the orchestrator daemon processes every
  queued cut in turn until each shows built; no cut is queued twice. Since: this batch (PR TBD).
- [ ] **P10 — skipped cuts really match.** Apply the same recipe again to the same selection:
  everything is skipped as "already built with this recipe" and `diag_recipe_hash` /
  `updated_at` on those rows do not change. Then tick *Rebuild*: they requeue. Since: this batch (PR TBD).
- [ ] **P10 — build permissions by role.** As a Lab Member, Apply recipe to selected queues builds
  (Lab Member can update `machining_force_analysis`, migration 111). As a role with read-only access
  to analyses, it stops on the first item with "your role can't request builds" and nothing is queued. Since: this batch (PR TBD).
- [ ] **#80** MATLAB run on the d1-server orchestrator and Directus asset download (held back).
- [ ] **#10** Figure-mode PNGs re-baked by MATLAB for cuts with a saved crop (held back).
- [ ] **#97** Tailscale serve, phone access, live-DAQ load (held back; security model is an owner
  decision).

## Done

(Move ticked items here with their date and result.)
