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
| [0011](./0011-row-level-visibility.md) | Row-level visibility: people see the records they are involved in | Proposed (open questions for the owner) |

New ADRs: copy the structure of an existing one, take the next number, and add a
row above.
