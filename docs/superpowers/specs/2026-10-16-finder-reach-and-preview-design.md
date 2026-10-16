# Ctrl+K finder: wider reach and a preview pane

Date 2026-10-16. Status: agreed with the maintainer in conversation (design Q&A, rounds 1 and 2); implemented as two stacked PRs.

## Why

The finder (`packages/d1-ui/src/finder/`) is the Ctrl+K search. The maintainer's last failure with it was "couldn't find a thing": it never searched `equipment` (fixed in #349), materials or files, and it matches only a code and a name, so a note, a location or an owner never finds anything. They also want a Spotlight-style preview card beside the results while they arrow through them, and it must stay as fast as it is now.

Out of scope here (later sub-projects): `e:`/`@` prefixes and recents (B), actions and commands (C), fuzzy/typo matching and a server search endpoint.

## What it does today

- Pages and saved views match in the browser on every keystroke.
- Records: one `GET /items/<collection>` per readable source (`FINDER_SOURCES`), all in parallel, after a 200 ms debounce (`useFinder.ts`). `Promise.all` waits for the slowest before anything shows.
- A source matches `_icontains` on its `match` fields (plus an exact `short_id`). 5 hits per group, groups in a fixed order, hits ranked 0 short id, 1 exact, 2 prefix, 3 contains.
- A USB/camera label scan bypasses search (unchanged).

## PR 1: reach, ranking, streaming

### New sources
- **Materials** (`materials`): match `alloy_code`, `common_name`; label alloy code, detail common name; opens the Materials Explorer drawer (`rowTarget` per indexConfig). Group "Reference" (new `FinderGroup`).
- **Files and SEM images** (`directus_files` through `/files`): match `filename_download`, `title`; label the filename, detail the owner/kind. Visibility is whatever Directus returns, which since migration 196 is owner-only; the finder adds no rule of its own so it can never show more than the Files page. Enter opens the Files/Inbox page with the file selected; when the file is linked to a record the preview card offers the record as a second action. Group "Files" (new). The implementer must verify the exact field that holds the share path (`archive_path` is a pointer-row attribute; check the `directus_files` columns and `linkedFiles.ts`) and match on it only if it is a real column.
- Equipment already added in #349.

### Wider matching (narrow list, per decision)
Matching also reads: samples `notes`, `legacy_notes`, `location`, `project_id.project_code`, `owner_person_id.full_name`; equipment `notes`, `location`; operations `outcome_notes`; files path (above). Nothing else.

**Implemented differently (PR 1):** `project_id.project_code` was dropped from the samples fields: a many-to-one filter joins `projects` without the projects row rule, so searching a project code would reveal which readable samples belong to a project the user may not read. A follow-up could first `GET /items/projects` (which applies the rule) and then filter samples by `project_id` `_in` those ids. The files path is not matched: it is not a column (`directus_files` keeps it in `metadata.archive_path`, JSON that a filter cannot reach).

### Two passes
- **Pass 1** (as today): code/name fields (+ short id). The first group to answer shows at once.
- **Pass 2**: the notes/location/owner/project fields, a second `GET` per source that has any, issued in parallel with pass 1 but merged as it arrives. A pass-2 row already in pass 1 is dropped; a pass-2 hit is labelled "matched in <field>" (`FinderHit.matchedIn`) and ranks 4, below every pass-1 hit.
- **Streaming:** `useFinder.run` stops using `Promise.all`; each source's answer is merged into `remote` as it arrives (still gated per query by `useRequestGate`; a stale answer is dropped). `loading` stays true until every request has settled.
- **Relational filters** (`project_id.project_code`, `owner_person_id.full_name`) are subject to the Directus 11.17 permission-filter quirks (see the repo's directus-filter-quirks notes): each one is checked against live data. A filter that errors or returns wrong rows is dropped from that source rather than worked around.

### Multi-word queries
The query is split on whitespace; a row must match every word, each word on any of the source's fields (`_and` of `_or`s). A single-word query builds exactly the filter it builds today.

### Ranking and caps
Order within a group: 0 exact short id, 1 exact code/label, 2 prefix, 3 contains (pass 1), 4 pass-2 match. Groups keep today's order (Pages, Saved views, Samples, Operations, Tests, Campaigns, Projects, People, Inventory, then the new Reference and Files). 5 hits per group, and the whole record list is capped at 12 rows (Pages and Saved views excluded): the best-ranked across groups, kept in group order. A capped group ends with a "more in <Page>..." row that opens that Explorer page with the query as its search (`indexRoute(collection, { q })`; the implementer confirms the Explorer's search param name).

### The best match
Enter opens the active row, which starts as the first row. While a pass-1 hit exists the first row must be a pass-1 hit (pass-2 rows never displace it).

### Speed gate
Time to the first hit (first group answering) must be no worse than today; the slowest group may grow by at most 20 ms. Measured on live (median of 20, same queries, before and after, from the finder's own request timings) and recorded in the PR. A source that breaks the gate moves entirely to pass 2 or is dropped.

## Deviations recorded while implementing PR 1
- **Files open `/files/<id>`** (Directus's own file page), not the Inbox: the Inbox has no per-file selection parameter. "More in Files…" opens `/files` without the query.
- **A file's detail is its MIME type, not its owner:** `directus_files.owner_person_id` has a foreign key but no `directus_relations` row, so `owner_person_id.full_name` is not a field `/files` can read (the request would be refused).
- **"More in <Page>…" is suppressed** for a multi-word query and for a group whose lost hits were pass 2 only: the Explorer search is one `_icontains` on the page's code and name fields and would find nothing. It is kept (alone) for a group the 12-row cap emptied, when its lost hits were pass 1.
- **Form record pickers inherit multi-word matching** through `sourceParams` (it is the picker's query for the collections the finder knows). Materials and files are `finderOnly`, so the pickers keep their own template for them.
- **Files are asked only when a word has 3 characters or more**, and migration 201 adds trigram indexes on `lower(filename_download)` and `lower(title)` (the form Directus builds for `_icontains`).
- **Directus-special words:** `true`, `false` and `null` are sent capitalised and a leading `$` is dropped (Directus would otherwise turn them into a boolean, null or a variable and break the whole request); a word is cut at 100 characters. This changes the single-word filter only for words that were already broken.

## PR 2: preview pane (on top of PR 1)

- Main Explorer finder only. The Process-map host (it passes `pickRecord`) keeps today's layout, no pane.
- The dialog is 560 px until the first hit exists, then about 900 px with the list on the left and the pane on the right. Below about 720 px viewport width the pane is not rendered. An empty box shows nothing new.
- **Loading:** a card appears for the active record hit about 120 ms after the active row stops changing. Instant part: label, kind, detail, matched-in line (all from the hit). Filled in by one `GET /items/<collection>/<id>` with only the card's fields. Cached per `collection:id` for the life of the dialog; an in-flight fetch is aborted when the active row changes. A failure shows "Preview unavailable"; the row still opens.
- **Card contents (drafted here, reviewed with the PR):** header = type icon, label, kind line. Facts by type, reusing the existing helpers (`sampleFacts`, `operationFacts`, `facts.ts`):
  - Sample: material, geometry, status, owner, location, project, mass.
  - Equipment: type, manufacturer, facility, location, active.
  - Operation: method, sample, machine, operator, date.
  - Test: type, status, sample, date.
  - File: thumbnail (migration 198 inbox thumbnails, only when the user may see the candidate), owner, size, linked record.
  - Material, campaign, project, person, inventory: label, kind and two facts.
  - A pass-2 hit also shows "Matched in <field>: ...snippet...".
  - Footer: "Open ↵".
- **Keyboard and a11y:** unchanged (arrows move the active row, Enter opens, Tab cycles). The pane is `aria-live="polite"`, labelled by the active option. The scan flow is untouched.

## Testing
Unit tests for every new/changed pure function (source params incl. multi-word `_and`/`_or`, ranking incl. rank 4, merge with the 12-row cap and "more in" rows, pass-2 de-dup, streaming merge with stale answers dropped, best-match rule, preview card models and cache/abort). The two d1-ui count tests that enumerate sources and groups are updated. Component test for the pane (shown after the first hit, hidden in `pickRecord` mode, "unavailable" on a failed fetch).

## Delivery
Two stacked draft PRs: (1) `feat/finder-reach` based on #349's branch, (2) `feat/finder-preview` on top. Nothing is merged or deployed without the maintainer.
