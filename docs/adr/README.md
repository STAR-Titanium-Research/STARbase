# Architecture Decision Records (ADRs)

Each ADR captures one significant, hard-to-reverse decision: its context, the
choice, and the consequences. They exist so a future session or reviewer can
understand *why* the system is the way it is without re-litigating it.

Format: lightweight [MADR](https://adr.github.io/madr/)-style. Status is one of
`Proposed` / `Accepted` / `Superseded by ADR-XXXX`.

| ADR | Title | Status |
|---|---|---|
| [0001](./0001-postgres-as-durable-core.md) | PostgreSQL is the durable core | Accepted |
| [0002](./0002-directus-as-swappable-adapter.md) | Directus is a swappable adapter | Accepted |
| [0003](./0003-trigger-based-immutable-audit.md) | Trigger-based immutable audit log | Accepted |
| [0004](./0004-jsonb-for-dynamic-method-params.md) | JSONB for dynamic method params | Superseded (typed parameter columns, migrations `…025`–`…039`) |
| [0005](./0005-directus-rbac-structure.md) | Directus RBAC structure | Accepted (human accounts since moved to Lab Admin / Lab Member) |
| [0006](./0006-heavy-data-pipeline.md) | Direct-to-MinIO heavy-data pipeline | Accepted |
| [0007](./0007-plugin-framework.md) | Plugin framework: shared template and extension pattern | Accepted |
| [0008](./0008-traceability-layer.md) | Cradle-to-grave traceability as Postgres functions | Accepted |
| [0009](./0009-text-to-sql-guarded-readonly.md) | Local text-to-SQL via a guarded, read-only path | Accepted |
| [0010](./0010-force-app-extraction-and-electron-packaging.md) | Force-app: shared plotting package, repo extraction, Electron packaging | Accepted (steps 0, 1, 3, 4 done; repo split not executed) |
| [0011](./0011-row-level-visibility.md) | Row-level visibility: people see the records they are involved in | Accepted (2026-10-07) |
| [0012](./0012-rig-test-requests-over-github-issues.md) | Rig test requests: GitHub issues as the command channel, a fixed action vocabulary on the rig | Proposed |
| [0013](./0013-starbase-separate-tailnet-device-shared-directus-session.md) | STARbase: its own tailnet device, sharing Directus's session | Accepted (2026-10-12) |
| [0014](./0014-record-access.md) | Record access: a Who has access list, Restricted records, materialised readers; Ask-DB row security | Accepted for A1a (2026-10-13); amends 0011 |
| [0015](./0015-directus-headless-starbase-is-the-only-front-end.md) | Directus goes headless; STARbase is the only front end, reached through permanent links | Proposed |
| [0016](./0016-teams.md) | Teams: a second kind of grantee, owner-approved joiners, team grants expanded into derived access rows | Proposed; amends 0014 |
| [0017](./0017-batches-are-recorded.md) | Batches are recorded; probable batches are only shown | Proposed (2026-10-14) |
| [0018](./0018-starbase-writes-records.md) | STARbase writes records on the process map: its own generated form and one transactional create endpoint | Proposed (2026-10-14); amends 0015 |
| [0019](./0019-operations-and-tests-can-be-planned.md) | Operations and tests can be planned; samples an operation will make are planned samples | Proposed (2026-10-14) |
| [0020](./0020-inbox-crawler-read-only-allow-listed.md) | The inbox crawler: read-only, allow-listed, and it only suggests | Proposed (2026-10-15) |
| [0021](./0021-surface-scans-on-inserts-and-edges.md) | Surface scans belong to inserts and edges, not to Tests; rendered by a read-only worker | Proposed (2026-10-15); decision 4 (lab-wide visibility) superseded by 0023 |
| [0022](./0022-files-belong-to-their-provenance-owner.md) | A file belongs to its provenance owner: only they see it, link it or read its settings | Proposed (2026-10-16) |
| [0023](./0023-surface-scans-follow-their-files-owner.md) | Surface scans follow their file's provenance owner: locked placeholder, private render data, supersedes 0021's lab-wide visibility | Proposed (2026-10-21) |
| [0024](./0024-pointer-rows-are-written-only-by-the-archive-writers.md) | A pointer row of the archive share is written only by the archive indexer and the inbox crawler | Proposed (2026-10-21) |

New ADRs: copy the structure of an existing one, take the next number, and add a
row above.
