# Known issues

[← D1 Database wiki](README.md)

Problems found while building a fresh stack from the repository and writing this wiki
(September 2026). Each was reproduced on that stack. Production may differ where it was changed
by hand in the Directus UI.

## Fixed alongside this wiki

| Issue | Fix |
|---|---|
| The Directus **module bar was empty** on a freshly configured database: `configure_directus.sql` wrote the entries without `"enabled": true`, which Directus requires | the script now writes enabled entries, including Force Analysis and FAST Analysis, and repairs a bar written by the old version |
| **Lab Dashboard → Samples** showed no operations and no test sessions for any sample: it sorted test sessions by `test_date`, which does not exist (the column is `session_date`), and the failed request took the operations list down with it | the query and the date display use `session_date` |
| **Force App: the live FFT / Power panel stayed blank** until a channel chip was clicked, and Spectrogram / Waterfall kept their first channel | the live views track spectrum updates. The Force App interface refresh (PR #73) made the same fix, for all three views. |
| **Lab Dashboard Node Graph** asked for fields that do not exist (`manufacturing_operations.operation_type`, `tool_boxes.box_code`, `insert_types.insert_type_code`), so expanding a sample, machine, edge, insert or box returned nothing; the full-page Node Graph tab also had no search box, so there was nothing to click | the graph uses the real columns (operations are labelled by method, and searched by code), requests the ids it needs to draw material and project nodes, and the Node Graph tab gets its search box |
| **Force App Local Captures showed "upload state unknown"** for every capture, so its **Upload** buttons never appeared: the check filtered on `recorded_metadata.capture_id`, a key inside a JSON field, which Directus refuses | the app fetches the candidate rows (bounded by `created_at`) and matches capture ids itself |
| **Force App: editing an uploaded capture's metadata** failed to load its database row: it asked for `people.first_name`/`last_name`, `equipment.name` and `tools.name` | it uses `full_name`, `equipment_name` and `tool_name` |
| **Two extension lock files were stale** (`d1-material-inherit`, `d1-report`), so `npm ci` failed with `EUSAGE` | refreshed (only the missing optional `@emnapi/*` entries change) |
| **Seeded machines had no capabilities** (`db/seeds/001_reference_data.sql`), so on a dev stack the machine picker offered none of them | the seed sets them |
| **Force App Connectivity Doctor sent you to the wrong tab**: its hints said to fix a service URL "in Settings > General", but the URLs are edited on the Connectivity tab itself, and General has no purge for crashed recordings | the hints name *Settings > Connectivity* (or *Service endpoints* on that page), and the crashed-recordings hint points at its own **Fix now** button |
| **Lab Member could not save a cut from the Force App**: no `directus_files` access and no create on `machining_force_analysis`, so the operation row was created and the upload then failed (live caches in Force Analysis were also refused) | migration `20261005000133_lab_member_force_app_save.sql` grants Lab Member create and read on `directus_files` and create on `machining_force_analysis`. A production database that was adjusted by hand needs the migration applied once. |

## Open

| Issue | Effect | Workaround |
|---|---|---|
| **Force App cuts are never host-processed**: the orchestrator only handles `.mat` files indexed from the archive | no stored FFT, FRM *Figure*, *Full* octree or diagnostics for cuts saved from the app | copy the capture into the archive and index it. See [Force data](force-data.md#two-ways-in). |
| **Migrations 057 and 066 fail on a fresh real Directus database** (foreign keys to rows that the configure scripts create later) | a from-scratch rebuild stops part-way | see the [developer guide](developer-guide.md#problems-you-will-hit) |
| **`configure_directus.sql` removes migration-added metadata** for the core collections | re-applying it loses about a hundred field interfaces and relations; `fast_recipes` then errors | see the [developer guide](developer-guide.md#problems-you-will-hit) |
