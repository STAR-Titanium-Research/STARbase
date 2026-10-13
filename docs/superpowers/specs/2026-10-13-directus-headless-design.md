# Directus back to headless: retire the pages STARbase duplicates

- **Date:** 2026-10-13
- **Status:** Draft for maintainer review
- **Deciders:** Maintainer + Claude (headless interview, 2026-10-13)
- **Builds on:** [STARbase standalone spec](2026-10-12-starbase-standalone-design.md),
  [ADR-0013](../../adr/0013-starbase-separate-tailnet-device-shared-directus-session.md)
- **Decision record:** [ADR-0015](../../adr/0015-directus-headless-starbase-is-the-only-front-end.md)

## 1. Outcome

STARbase went live on 2026-10-13 and does everything the Directus `d1-home` module does. This round
makes **STARbase the only front end** and takes Directus back to a **headless CMS**:

- Data Studio keeps **Directus's own modules**: Content, Files, Users, Insights and Settings.
- Directus keeps **everything STARbase depends on**: the edit frame, the field interfaces (they
  render inside the framed form), the endpoints and the hooks.
- Directus loses **every custom page**: Home, the plotters, the lab dashboard, the crawler panel and
  Ask. Where STARbase lacks something, it gets it first.
- Anything printed or linked from Directus's side (report QR codes, label redirects, the Force App's
  "open record", the module bar) goes through **one permanent link on the Directus host** that
  forwards to the front end. STARbase can then move, be renamed or be replaced by changing one
  setting.

Nothing is in production use yet. There are no printed QR codes and no bookmarks to keep alive
(Q6), so no old-path redirects are needed.

## 2. Decisions

| # | Decision |
|---|---|
| Q1 | "Headless" means Data Studio keeps its built-in modules plus whatever STARbase depends on: `d1-edit-frame`, all field interfaces, the endpoints and the hooks. No custom pages. Lab members keep app access, because STARbase's framed edit form is a Data Studio page. |
| Q2 | Remove `d1-home`, `d1-force-dashboard` and `d1-fast-dashboard` (exact duplicates). |
| Q3 | Rebuild the lineage graph in STARbase with **Vue Flow + ELK** (Q11), port the lab dashboard's remaining gaps (§6.4), then remove `d1-lab-dashboard`. |
| Q4 | An **admins-only Force crawler page** in STARbase (`/crawler`), then remove `d1-force-crawler`. |
| Q5 | **Ask the database** becomes a STARbase page (`/ask`), then remove `d1-ask-db`. `d1-ask-endpoint` and the `llm-text-to-sql` plugin stay. |
| Q6 | No redirects for old `/admin/...` paths: nothing has been printed or bookmarked. |
| Q7 | Report QR codes, in-report links, label redirects, the Force App and the module bar use a **permanent link on the Directus host** (`/d1-links/go/…`), which forwards to `STARBASE_URL`. |
| Q8 | The module bar loses the custom tiles and gains one **STARbase** link tile, which points at the permanent link. |
| Q9 | Keep the package structure and the host seam. Delete only code left with no caller. |
| Q10 | One spec, two phases with a plan each. Phase 1: clear duplicates, permanent links, fallbacks, module bar. Phase 2: graph, crawler, Ask, lab-dashboard gaps, then remove those three modules. |
| Q11 | Graph library: **Vue Flow** (`@vue-flow/*`) with **elkjs** layered layout. |
| Q12 | Ask is for **everyone signed in**, as today. |

## 3. What Directus keeps and loses

| Extension | Kind | Fate | Why |
|---|---|---|---|
| `d1-home` | module | **Remove (phase 1)** | Same code as STARbase. |
| `d1-force-dashboard` | module | **Remove (phase 1)** | Same component as STARbase `/plot/force`. |
| `d1-fast-dashboard` | module | **Remove (phase 1)** | Same component as STARbase `/plot/fast`. |
| `d1-lab-dashboard` | module | **Remove (phase 2)** | After the graph and the gaps in §6.4 are in STARbase. |
| `d1-force-crawler` | module | **Remove (phase 2)** | After STARbase `/crawler`. |
| `d1-ask-db` | module | **Remove (phase 2)** | After STARbase `/ask`. |
| `d1-edit-frame` | module (hidden) | Keep | STARbase edits through it. |
| All 15 interfaces | interface | Keep | They render inside the framed form. `d1-report-button` changes (§5.3). |
| `d1-links` | endpoint | Keep, **extend** | Gains the permanent links (§4). |
| `d1-report` | endpoint | Keep, change | QR codes and label redirects use the permanent links (§5.1). |
| `d1-admin-overview`, `d1-usage`, `d1-trace`, `d1-next-number`, `d1-ask-endpoint` | endpoint | Keep | STARbase calls them. |
| Hooks | hook | Keep | Server-side rules. |

Shared packages after both phases:
- `@d1/starbase-pages` and `@d1/fast-plotting` are used only by STARbase.
- `@d1/force-plotting` is used by STARbase and the Force App.
- `@d1/ui` is used by everything.
- `@d1/directus-host` is still used by the `d1-campaign-ops` and `d1-project-items` interfaces, so it stays.

## 4. Permanent links (`d1-links`)

New routes on the existing `d1-links` endpoint:

| Route | Redirects (302) to |
|---|---|
| `GET /d1-links/go` | `${STARBASE_URL}/` (Home) |
| `GET /d1-links/go/r/:collection/:id` | The record's STARbase page, `${STARBASE_URL}/<page>/<id>`, for the five collections with a record page (samples, operations, tests, campaigns, projects, using the same map as `d1-report`'s `EXPLORER_PAGES`). Any other collection goes to its Data Studio form, `${PUBLIC_URL}/admin/content/<collection>/<id>`. |
| `GET /d1-links/go/p/*` | `${STARBASE_URL}/<rest>`, query string kept. Used for plots, labels and any other STARbase page (`/d1-links/go/p/plot/force?operation=…`). |

Rules:
- **Public.** No sign-in is needed for the redirect: a phone scanning a QR code is not signed in. The
  redirect reads nothing from the database, so it reveals nothing. The STARbase page it lands on asks
  for sign-in and returns to the page afterwards (`/signin?next=`, already built).
- **No open redirect.** The target is always `STARBASE_URL`'s origin, or `PUBLIC_URL` for the Data
  Studio fallback.
  - `:collection` must match `^[a-z][a-z0-9_]*$`.
  - `:id` is URL-encoded as one path segment.
  - The `p/*` rest is a path made only of segments (no `//`, no `..`, no backslash, no scheme). It
    is rebuilt with `new URL(rest, STARBASE_URL)` and its origin is checked against `STARBASE_URL`'s.
  - Anything else answers `400`.
- **`STARBASE_URL` unset or not http(s)** (same check as `starbaseUrlFrom`): answers `503` with a
  short plain page, "The STARbase address is not configured on this server." From now on
  `STARBASE_URL` is required (§5.1).
- `Cache-Control: no-store` on every answer, so a change of `STARBASE_URL` takes effect at once.
- `GET /d1-links` (the JSON answer the edit frame reads) is unchanged. It stays signed-in only.

## 5. Phase 1: remove the duplicates, route everything through the permanent links

### 5.1 `d1-report`
- `adminRecordUrl` is replaced by `recordLink(publicUrl, collection, id)`, which returns
  `${PUBLIC_URL}/d1-links/go/r/<collection>/<id>`.
  - Report QR codes and in-report links use it.
  - The printed address names d1-server, the system of record, and never the front end (Q7).
- `/d1-report/label` and `/d1-report/labels` redirect to `${PUBLIC_URL}/d1-links/go/p/labels`,
  keeping `ids` and `codes`. The `/admin/home/labels` fallback goes.
- `d1-report` no longer reads `STARBASE_URL`; only `d1-links` does. The compose entry stays, because
  `d1-links` lives in the same Directus.
- Tests: the `/admin/home/...` assertions in `src/index.test.mjs` become permanent-link assertions.

### 5.2 Force App
- `openRecord` opens `${directusUrl}/d1-links/go/r/<collection>/<id>`. It needs no new setting,
  because the Force App already knows `directusUrl`.
- `recordRoute` is no longer imported by the Force App.
- This ships in its own Force App release (P-tier), after the phase-1 deploy is live.

### 5.3 `d1-report-button` (interface)
- "Force analysis" and "FAST analysis" open
  `/d1-links/go/p/plot/force?operation=<id>` (and the `fast` equivalent) in a **new tab**.
- They do this with `window.open(…, '_blank', 'noopener')`, not `router.push`. The button runs in
  Data Studio and inside STARbase's framed editor, and in the frame a push would navigate the frame.

### 5.4 `@d1/ui` links on the Directus side
- In Data Studio, the interfaces that link to records (`d1-project-items`, `d1-campaign-ops`) resolve
  links through `directusLinks`.
- `directusLinks.resolve` maps app paths to the permanent links instead of Directus routes:
  - `/home/<rest>` → `/d1-links/go/p/<rest>`;
  - the plot paths → `/d1-links/go/p/plot/{force,fast}`;
  - anything else is unchanged.
- These links are always external links in a new tab.
- `links.test.ts` pins this.

### 5.4a Access-notification emails (`d1-record-access`, from A1a / PR #259)
- `recordLink()` in `core/extensions/d1-record-access/index.js` links to
  `${PUBLIC_URL}/d1-links/go/r/<collection>/<id>`. Today it uses `STARBASE_URL`, with an
  `/admin/home` fallback.
- This is a one-line change. Whichever of #259 and phase 1 merges second makes it (agreed with the
  A1a session, 2026-10-13).

### 5.5 Remove the three modules
- Delete `core/extensions/d1-home`, `d1-force-dashboard` and `d1-fast-dashboard`.
- Remove them from the root `package.json` workspaces and from the `build:extension` and
  `build:extensions` scripts.
- Remove them from `.github/workflows/ci.yml` (build and typecheck) and from `.github/scripts/ci-plan.mjs`
  (path watches), along with their tests.
- Delete code left with no caller (Q9): `starbaseUrlOnce` in `links.ts`, and d1-home's
  `explorerHost.ts` and `DirectusFrame.vue` (they go with the folder).
- Comments that describe "two hosts" are corrected. The guard tests `noSdkImports` and
  `hostNeutral` stay.

### 5.6 Module bar
- A new migration, `20261013000171` (A1a holds 165–169 and side-menu B2 holds 170), removes the
  `home`, `d1-force-dashboard` and `d1-fast-dashboard` entries.
  - It keeps everything else in its order.
  - It is idempotent, and leaves a NULL bar alone.
  - Its `down` puts the three back.
- The STARbase tile needs an **absolute** address (S1, answered below), and a migration cannot read
  env. So `scripts/module_bar_starbase_link.sql` puts it first in the bar.
  - The tile is `{"type":"link","id":"starbase","name":"STARbase","url":"<PUBLIC_URL>/d1-links/go","icon":"rocket_launch","enabled":true}`.
  - It is run by `scripts/set_module_bar_starbase.sh`, which reads `DIRECTUS_PUBLIC_URL` from
    `.env`. It is idempotent: it replaces any existing `starbase` entry, and leaves a NULL bar alone.
  - The rollout runs it once. It is not part of `configure_all.sh`, which must never run on live.
- `scripts/configure_directus.sql` writes the bar without the three tiles for fresh installs.

### 5.7 Tests, preview and docs
- UI spec 11 (`11-force-dashboard`) moves to STARbase `/plot/force`.
- UI spec 13 (`13-explorer-routes`) keeps only its STARbase run (`D1_ROUTES_STARBASE`).
- `scripts/dev/explorer_preview.sh` stops building `d1-home`.
- Docs that send people to `/admin/home` or to the removed modules point at STARbase instead:
  `docs/wiki/database/*`, `docs/runbooks/physical-test-backlog.md`, `core/README.md`, and
  `docs/runbooks/starbase.md` (its "runs beside the Home module" and "Open in STARbase" lines).

## 6. Phase 2: what STARbase still lacks, then remove the last three modules

New STARbase pages live in `packages/starbase-pages/src` and reach Directus only through
`useExplorerHost()`, like every other page. They are added to `starbaseRoutes` and to `navConfig`.

### 6.1 Lineage graph, `/graph`
- **Library:** `@vue-flow/core` with its `background`, `controls` and `minimap` add-ons, and
  `elkjs`. Exact versions are pinned in the plan.
- **Entry:** `/graph?focus=<collection>:<id>`. `?sample=<id>` is kept as shorthand.
  - The Sample, Operation and Test record pages get an "Open lineage graph" button.
  - The sidebar gets "Lineage graph" (search-first, empty focus).
  - `SamplePage.vue`'s link to `/d1-lab-dashboard/graph` goes.
- **Data:** the same neighbour fetches as today's `NodeGraph.vue` (one hop per expand, through
  `host.api`). It also fills today's gaps: materials, projects and tools expand to their samples and
  operations.
  - Neighbour lists stay capped (20 by default). A capped list shows a "+N more" stub node, which
    loads the next page.
  - A soft cap of 300 nodes, after which expand asks "Show 40 more nodes?".
- **Look:**
  - Nodes are cards: a colour band per type (the existing 10-type palette, via theme tokens so dark
    mode works), the record code, and one line of context (status, date or kind).
  - Edges carry their relation label on hover.
  - ELK `layered` runs left to right, so ancestry reads in time order: material → sample → children
    → operations → tests.
  - Re-layout after an expand is animated, and nodes already placed keep their rank.
- **Interaction:**
  - Click a card to expand it. Each card has an **Open** action: the record page, or for other kinds
    the Data Studio form through the host's editor.
  - Search covers the seven code fields searched today plus tools, materials and projects.
  - Fit, zoom, minimap, and clear.
  - Keyboard: Tab between cards, Enter expands, `o` opens.
- **Phones:** pinch and pan work, and the minimap is hidden. The page is listed as an exception to
  "phones get lists", because a graph is the point of the page.

### 6.2 Force crawler, `/crawler` (admins only)
- A port of `Crawler.vue` with the same calls, through `host.api`.
  - Status card and Start/Pause.
  - The five queue tiles.
  - The settings form, saved only when something changed.
  - Recrawl: matches or all, with a confirm.
  - The errors list, with Retry and Retry all.
  - Recent activity.
  - The daemon-offline banner.
- It polls every 5 s while the tab is visible.
- **Admins only:** the route is hidden from the nav for non-admins (`adminOnly`). A non-admin who
  opens the URL sees "Only administrators can use the crawler." Directus already refuses writes from
  non-admins (Lab Member has read only).
- Home's `AdminPanels` "Open crawler →" link and the nav entry become internal links to `/crawler`.

### 6.3 Ask the database, `/ask` (everyone signed in)
- A port of `chat.vue`, `chart-panel.vue`, `example-chips.vue` and `question-list.vue`.
  - It calls `host.api.post('/d1-ask/chat', { messages })` with the same 20-message and
    4000-character limits.
  - It handles the same 422, 401/403, 502 (`upstream_auth`) and 504 errors.
  - History and saved questions stay in the browser's localStorage, keyed by `host.user.id`. They
    are per-viewer conveniences, and every read and write is wrapped in try/catch.
- **Chart:** `plotly.js-dist-min`, loaded **only when the Ask page opens** (dynamic `import()`), so
  the rest of STARbase does not pay for it. It must render under STARbase's CSP, which has no
  `'unsafe-eval'` (step-0 check S2).
- **Nav:** an "Ask the database" sidebar entry. Home's Ask tile stays hidden (decision of
  2026-10-09).
- `d1-ask-endpoint` already accepts app users (`acc.app === true`), and a STARbase session counts as
  one. No server change.

### 6.4 The lab dashboard's other views

| Lab-dashboard feature | STARbase today | Phase 2 |
|---|---|---|
| Sample list, detail, operations, tests, timeline | Samples index, record page, `LifeStrip` | Nothing |
| Equipment list | Equipment index | Nothing |
| Operation detail | Operation record page | Nothing |
| **Operations of one machine** | Missing: the Operations index has no equipment filter | Add an **Equipment** filter to the Operations index. The equipment row's drawer gets "Operations on this machine", which opens the index filtered to it. |
| **FAST runs (sintering only)** | Operations index with a process-category filter, but no preset | A sidebar entry **FAST runs**: the Operations index with `process_category = sintering` set. Index filters can be set from the URL query; added if they cannot be today. |
| **FAST sinter-cycle fields** (max temperature, force, mould diameter, atmosphere, recipe, batch) | Not checked | Check the Operation record page's FAST section and add any missing field. |
| Connections panel (graph embedded in each view) | None | Covered by "Open lineage graph" on record pages (§6.1). It is not embedded. |

### 6.5 Remove `d1-lab-dashboard`, `d1-force-crawler` and `d1-ask-db`
- The same steps as §5.5:
  - delete the folders;
  - update the workspaces, build scripts, CI, `ci-plan` and `.github/dependabot.yml`;
  - move UI specs 10 (`10-ask-db-chat`) and 12 (`12-force-crawler`) to STARbase `/ask` and
    `/crawler`;
  - update the docs.
- A second module-bar migration removes the `d1-lab-dashboard`, `d1-force-crawler` and `ask-db`
  entries.
- `navConfig` no longer has any external `/admin/...` page links apart from Data Studio itself.

## 7. Rollout (each live step is the maintainer's, approved on its own)

`docs/runbooks/starbase.md` gains a section per phase. **The extension folders on live must be
deleted by hand**:
- Directus mounts `./core/extensions` as it is.
- `git pull` deletes a removed extension's tracked files, but leaves its git-ignored `dist/` and
  `node_modules/`, so Directus would keep loading it.

Phase 1:
1. `git pull && npm ci && npm run build:starbase && npm run build:extensions`, then
   `(cd core/extensions/d1-report && npm ci && npm run build)` and
   `(cd core/extensions/d1-report-button && npm ci && npm run build)`.
2. Delete what is left of the three removed extensions, then check:
   `rm -rf core/extensions/d1-home core/extensions/d1-force-dashboard core/extensions/d1-fast-dashboard`
   (PowerShell: `Remove-Item -Recurse -Force core/extensions/d1-home, core/extensions/d1-force-dashboard, core/extensions/d1-fast-dashboard`).
3. `dbmate up` (migration 171), then `bash scripts/set_module_bar_starbase.sh`.
4. `docker compose up -d --force-recreate directus`, then
   `docker compose exec directus ls /directus/extensions`: the three names are gone.
5. Smoke:
   - `curl -sI https://d1-server.tail54eeb6.ts.net/d1-links/go/r/physical_samples/<id>` → `302`
     to `https://starbase.tail54eeb6.ts.net/samples/<id>`;
   - `curl -sI "https://d1-server.tail54eeb6.ts.net/d1-links/go/p/a//b"` → `400`;
   - in Data Studio, the module bar's first tile is STARbase and opens it; Home and the Force/FAST
     tiles are gone;
   - a sample report's QR code opens the sample in STARbase;
   - on an operation's Data Studio form, "View Force Analysis" opens STARbase's plot in a new tab;
   - a project's items list links open STARbase.
6. Force App: ship the release that contains "open record through the permanent link".

Phase 2: the same rhythm, with `npm ci` picking up Vue Flow, elkjs and plotly. The three folders go
in step 2 and the second migration runs in step 3. The smoke covers `/graph`, `/crawler` (as admin
and as a Lab Member) and `/ask`.

Rollback for each phase: check out the previous commit, rebuild, run the migration's `down`, and
recreate. The removed folders come back with the checkout.

## 8. Step-0 checks (before the plans are final)

- **S1. Module-bar link tile with a relative URL. Answered (2026-10-13):** no. Directus's
  `module-bar.vue` turns a `url` starting with `/` into a router `to`, so it would open inside
  `/admin`. Any other `url` becomes an `href`. The tile is therefore written with the absolute
  address by a script (§5.6).
- **S2. Plotly under STARbase's CSP.** Bar, line and scatter charts render with `script-src 'self'`
  and no `'unsafe-eval'`. If they do not, the Ask chart uses Plotly's SVG-only partial bundle or a
  lighter library. That is decided in the plan, and the CSP is not loosened.
- **S3. Vue Flow and elkjs under the same CSP**, including whether elkjs needs a worker (STARbase
  allows `worker-src 'self' blob:`).
- **S4. `d1-access-guard`. Answered (2026-10-13):** it only hooks item writes on four junction
  collections, so it cannot touch an endpoint route.

## 9. Testing

- **Unit, `d1-links`:** every route in §4, the 400 cases (`..`, `//`, a scheme, a backslash, a bad
  collection), 503 when unset, query kept, `no-store` set.
- **Unit, `d1-report`:** QR and link targets are permanent links. Labels redirect with `ids` and
  `codes` kept.
- **Unit, `@d1/ui`:** `directusLinks` maps to the permanent links. The `navConfig` entries for
  `/graph`, `/crawler` and `/ask` resolve inside STARbase.
- **Unit, graph:** neighbour-fetch mapping per kind, stub "+N more" nodes, the node cap, and ELK
  input built from nodes and edges (layout output is not asserted pixel by pixel).
- **E2E on the preview (`D1_PREVIEW_NAME=d1-starbase`, port 18057):**
  - the route harness on STARbase as admin and as member;
  - `/graph` expands and opens a record;
  - `/crawler` works for an admin and refuses a member;
  - `/ask` round-trips with the endpoint stubbed at the network layer (the preview has no LLM);
  - the report button opens a new tab;
  - the module bar has one STARbase tile.
- The CI guards (`noSdkImports`, `hostNeutral`) stay green.

## 10. Out of scope

- Hiding Data Studio's built-in modules from Lab Members (Directus 11 has one global module bar).
- A custom domain for STARbase or d1-server.
- Folding `@d1/starbase-pages` into the app (Q9).
- Any change to the Force App beyond `openRecord`.
- Google sign-in.
