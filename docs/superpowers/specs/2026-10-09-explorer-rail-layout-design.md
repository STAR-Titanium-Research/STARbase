# Explorer record pages: a side rail beside panels

Status: **all questions answered; awaiting the maintainer's approval** (2026-10-09). Stream L1 of
[`docs/superpowers/plans/2026-10-09-explorer-round-2.md`](../plans/2026-10-09-explorer-round-2.md).
Builds on [the Explorer pages design](2026-10-06-explorer-pages-design.md) and on the restyle
(`feat/explorer-restyle`).

## Why

The restyle put every record page in one column of panels. On the lab's wide screens that wastes
the width and, as the maintainer put it, the panels "add some clutter and reduce clarity and info
density". Three faults, each visible on an Operation page with thirteen values:

- **Nothing stays put.** Scroll to the force files and the page no longer says which operation it
  is, who owns it, or how to edit it.
- **Tiles for parameters.** A boxed tile per value suits four or five headline numbers. For ten to
  thirty parameters that are looked up by name it is slower to read and takes about three times
  the height of a list.
- **Width is filled by stretching**, not by showing more: a three-value Overview beside a ten-value
  Parameters panel.

The maintainer chose "rail and panels" from three mockups of the same operation
(`layout-options.html`, option C): a sticky side rail, and a main column that keeps its panels.

## Goals

- Every record page (Sample, Operation, Test, Campaign, Project) has a **rail that stays in view**
  with what the record is, its status, its actions, its key facts, who is on it, and the page's
  contents.
- The main column **keeps panels** (`Section`), and inside them values are a **dense label/value
  list**, not tiles.
- More of the record is visible on one 1440 x 900 screen than today, with nothing cut or hidden
  behind a click that is visible now.
- One layout component and one fact list in the kit, so the five pages cannot drift apart.

## Non-goals

- **Who has access** beyond what the page already reads (stream A1). The rail reserves the place
  and shows an honest first version (below).
- The Home page's "frequently used" panel (U1) and the lineage graph (G1).
- Home, the Projects index, People and Register a Sample keep their current frames. Two density
  fixes on Home are in scope because they are the same fault (below).
- No change to what is fetched, to permissions, to links or to editing.

## Layout

```
+-- header bar (Directus) ------------------------------------------------+
| breadcrumb: Home > Project 10 > Campaign 6 > Sample ...                 |
| +-- rail, 300px, sticky --+  +-- main column ------------------------+ |
| | kind · status           |  | [Details                      13]     | |
| | CODE                    |  |  label ........ value   label ... val | |
| | title                   |  | [Samples                       1]     | |
| | [Edit] [Report] [...]   |  | [Force analysis                1]     | |
| | key facts               |  | [Files                         2]     | |
| | People on this record   |  |                                       | |
| | On this page            |  |                                       | |
| +-------------------------+  +---------------------------------------+ |
+-------------------------------------------------------------------------+
```

- **Breadcrumb** is one line above both columns.
- **Rail:** 300px, on the left, `position: sticky` under the Directus header bar. If it is taller
  than the window it scrolls on its own, so its last block is always reachable.
- **Main column:** the rest of the width, panels stacked with the page frame's 16px gap. Two short
  panels may share a row (`.d1-cols`, each keeping its own height).
- **Narrow window** (the page's own width under about 1000px, measured with a container query, not
  the viewport, so it also holds with the Directus sidebar open): the rail becomes a block at the
  top of the page, not sticky, with its facts in two or three columns; "On this page" is hidden.
- The page still sets the header-bar title ("Operation 10-AA-...").

## The rail, block by block

1. **Identity.** Kind and sub-kind ("Operation · Machining"), the status badge, the code in
   monospace (or the plain derived label when there is no code), the title or nickname under it.
2. **Actions.** Edit (primary, only when the user may edit, as now), then the page's other actions
   as secondary buttons. They wrap to a second row; none is hidden in a menu.
3. **Key facts.** A one-column label/value list of the facts that identify the record: the ones in
   today's header "meta" line plus the links up the tree (project, campaign, sample). Links use
   `RecordLink`; a hidden target shows `HiddenLink`, as now.
4. **People on this record.** *Not built in this stream: the maintainer chose to leave this place
   empty until the access view (A1) is designed. Kept here as the fallback that was considered.*
   First version, from fields the page already reads and nothing else:
   owner, co-owners, operator, the project's PI and investigators where the page has them, each
   with its role, then one line saying what the signed-in user can do ("You can edit this record" /
   "You can view this record", from `useCanUpdate`). It does not claim to be the complete list of
   who has access: its heading is "People on this record", not "Access". Stream A1 replaces it
   with the rule-derived list.
5. **On this page.** The main column's sections with their counts. A click scrolls to the section;
   the section in view is marked. Empty sections are listed dimmed.

| Page | Key facts in the rail | Stays in the main column |
|---|---|---|
| Operation | date, method, machine, sample, project, campaign | Details (every other value and parameter, one list), Samples in and out, Force analysis or FAST run, Files |
| Test | date, category, machine, sample, project, campaign | Details, Subject, Results, Files |
| Sample | the drawing, material, form and dimensions, mass, location, project, campaigns | Material and details (composition bar, remaining facts, condition notes), Life of the sample, Operations, Tests, Files |
| Campaign | type, dates, default machine and material, project; counts (samples, operations, tests); the three progress bars | Notes, Samples and steps (matrix), Samples, Test sessions, Operations |
| Project | dates, PI, investigators, document number; counts (samples, operations, tests, campaigns) | Description, Campaigns, the three "not in a campaign" lists, Activity, Equipment used |

Moving the counts into the rail removes the stat-tile rows on the Project and Campaign pages.

## Inside the panels

- **Fact list replaces tiles.** Label on the left in the secondary colour, value on the right in
  the text colour at weight 600, the unit after the value in the secondary colour, tabular figures,
  a hairline under each row. Rows are about 28px. Columns: as many as fit at 260px minimum, so a
  wide panel shows three or four columns and the rail shows one. Long values wrap; nothing is cut
  with an ellipsis. Empty values are left out, as now.
- **Overview and Parameters become one "Details" panel** on the Operation and Test pages. The
  facts that moved to the rail are not repeated.
- **An empty section is its lid only**: the title, a zero count, and its "nothing recorded" text
  on the same line, about 38px high instead of a lid and a body.
- **Tables, cards, the life strip and the matrix are unchanged.**

## Two Home fixes in the same spirit

- "At a glance" wraps its sixth tile onto a second row at 1440px. The tiles get a smaller minimum
  so six fit in one row.
- "My work" shows one card per row in three narrow columns (25 cards deep with real data). Each
  group becomes a compact list: code, name, tag, one line per record.

## Components (kit, `packages/d1-ui`)

- `RecordLayout`: the two-column grid, the sticky rail, the container query. Slots: `crumbs`,
  `rail`, default.
- `RecordRail`: the rail's frame and its blocks. Takes over from `RecordHeader` on these five
  pages (`RecordHeader` stays for anything else that uses it; today nothing else does, so it is
  removed if still unused at the end).
- `FactList`: the label/value list, used in the rail (one column) and in panels (many). It takes
  the same items `KeyValueGrid` takes, so call sites change one tag. `KeyValueGrid` is removed.
- `PageContents`: the "On this page" list. The model (sections, counts, which is current) is a
  pure function with tests; the component only renders it.
- `Section`: gains an `id` for the contents list to target, and the lid-only empty state.

Each page file stays thin: it builds the rail's facts and people from the record it already has.
No file over about 400 lines.

## Risks and how each is checked

- **Sticky inside Directus.** The page scrolls inside the Data Studio's own container; `sticky`
  must be measured against it and offset by the header bar's height. Only a real Directus shows
  this: a physical-test item, and the coordinator checks it live before the stream is called done.
- **The Data Studio's global `dl` / `dt` / `dd` rules** broke the old grid (values cut with an
  ellipsis). `FactList` either avoids those elements or re-sets every leaked property, with a
  comment saying which.
- **A long rail on a short window** (a Sample with many campaigns, a Project with many
  investigators): the rail scrolls on its own; lists longer than six entries show six and "N more".
- **Dark theme:** only the kit's tokens, no new literal colours.
- **Row-level visibility:** the rail shows nothing the page does not already show. A hidden owner
  or project reads "not visible to you", never blank and never a guess.

## Testing

- Vitest in the kit for the pure parts: the contents model, the people list builder (roles,
  duplicates such as an owner who is also PI, hidden entries), the fact filter.
- Typecheck and build of the kit and the extensions, the geometry sync check.
- Live, by the coordinator, on the real Directus in Light and Dark at 1440 and 1920 wide and at a
  narrow width: one page of each of the five kinds, plus a record with a hidden parent.
- Physical-test backlog items for what only a member account or real data can show.

## Stages

1. **L1a, kit:** `RecordLayout`, `RecordRail`, `FactList`, `PageContents`, the `Section` changes,
   with tests. One worker.
2. **L1b to L1d, pages**, in parallel once L1a is merged: Operation and Test; Sample; Project and
   Campaign. One worker each.
3. **L1e:** the two Home fixes.
4. Opus review of the whole stream, fixes, then the coordinator's live check.

## Decided by the maintainer (2026-10-09)

1. **The rail is on the left.**
2. **Sample page: the drawing is in the rail**, always visible, about 265px wide.
3. **"People on this record" is not built here.** The rail keeps the place for the access view
   (stream A1), which is to show the full list to the record's owner in the manner of Google
   Drive's "Manage members" dialog.

4. **Counts on the Project and Campaign pages are in the rail, and each one is a link** (chosen
   from `layout-counts.html`, variant 1). The tile row goes. A count links to the list of those
   records for this project or campaign: the Explorer index pages of stream N1, filtered. A count
   whose index page does not exist yet is plain text; it never links to an unfiltered list, which
   would show a different number from the one clicked. "Campaigns" on a Project page scrolls to the
   Campaigns panel on the same page.

No question is open. Awaiting the maintainer's approval of this design before the implementation
plan is written.

## What the standalone direction asks of this stream

The Explorer is to become its own web app (plan, stream N1). This stream therefore:
- puts nothing in the rail that depends on the Directus header bar except the sticky offset, which
  is one CSS variable;
- keeps `RecordLayout`, `RecordRail`, `FactList` and `PageContents` free of Directus components
  (`v-icon`, `v-button`): icons and buttons are passed in through slots by the page, so a
  standalone shell can supply its own;
- leaves room to the left of the rail for the app's own navigation.
