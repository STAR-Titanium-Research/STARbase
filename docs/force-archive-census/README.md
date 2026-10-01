# Force archive census

Snapshots of the machining force archive (`Z:\star_group1\Shared\Machining\FRM`), produced by
[`scripts/matlab/crawl_force_structure.m`](../../scripts/matlab/crawl_force_structure.m). The
crawler reads only file headers and the small `metadata` / `VariableNames` variables, and grades
each file against the layouts in [`docs/force-file-standards.md`](../force-file-standards.md).

| File | Rows | Contents | Cited by |
|---|---:|---|---|
| `force_structure_inventory.csv` | 288 | Every `.mat` under the archive root — the 2026-07-24 census | [`force-file-standards.md`](../force-file-standards.md) (archive census) |
| `force_captures_inventory.csv` | 262 | The same crawl minus the 26 files that are not force captures (SRAS, ToF, workspace dumps, tap tests) | [force capture v2.0 spec](../superpowers/specs/2026-07-27-force-capture-v2-schema-design.md) (migration counts) |

These are point-in-time records, not live data: re-run the crawler for the archive's current
state.
