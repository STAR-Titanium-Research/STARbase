# `/core` — Directus configuration-as-code

Directus is the **swappable adapter** over the Postgres core: it provides the
admin UI, REST/GraphQL API, RBAC, and file handling, but owns **no business
logic the system depends on**
(see [`../docs/adr/0002-directus-as-swappable-adapter.md`](../docs/adr/0002-directus-as-swappable-adapter.md)).

Directus configuration is version-controlled so it is reproducible and
reviewable. Directus **introspects** the schema; it must never alter structure.
The configuration lives in three places:

| Where | What | Applied by |
|---|---|---|
| `roles.json`, `permissions.json` | The Phase 3 Operator / Researcher / Administrator roles and their permission matrix | `apply.sh` |
| [`../scripts/configure_*.sql`](../scripts/README.md#directus-configuration) | Collections, fields, relations and presets; the Lab Admin / Lab Member roles and user accounts | `../scripts/configure_all.sh`, plus `configure_users_and_policies.sql` |
| `extensions/` | Hooks, endpoints, modules and interfaces (below) | Bind-mounted into the Directus container |

## Applying it

```bash
# 1. Stack must be up and migrations applied
make up && make migrate && make seed

# 2. Phase 3 roles + the Rig_1 machine user
DIRECTUS_URL=http://localhost:8055 \
DIRECTUS_ADMIN_EMAIL=admin@example.com \
DIRECTUS_ADMIN_PASSWORD=your_password \
bash core/apply.sh

# 3. Collections, fields and relations, then a Redis flush + Directus restart
bash scripts/configure_all.sh
```

`apply.sh` is idempotent — roles and machine users it finds already existing
are skipped. The Rig_1 machine token is printed once to stdout; store it in
your secrets manager (1Password, Vault, etc.). It also writes a Directus schema
snapshot to `core/schema-snapshot.yaml` for diffing; the snapshot is not
committed.

## Extensions (`core/extensions/`)

Mounted read-only at `/directus/extensions` (see `docker-compose.yml`). The
Vue/TypeScript extensions are built in place (`npm install && npm run build` in
the extension's folder; `dist/` is git-ignored). Restart the Directus container
after a rebuild — on the Windows host `EXTENSIONS_AUTO_RELOAD` does not pick up
changes across the bind mount (ADR-0010).

| Type | Extensions |
|---|---|
| **hook** — server-side logic | `actor-identity` (attributes API writes in the audit log), `owner-cascade`, `box-intake`, `campaign-inherit`, `d1-default-owner`, `d1-equipment-code`, `d1-operation-sequence`, `d1-apply-prep-recipe` |
| **endpoint** — custom API routes | `d1-ask-endpoint` (`/d1-ask`), `d1-report` (`/d1-report`: printable sample, operation and test reports) |
| **module** — full-page apps | `d1-home`, `d1-lab-dashboard`, `d1-ask-db` (Ask the Database), `d1-force-dashboard` (force analysis, built on [`packages/force-plotting`](../packages/force-plotting/)), `d1-force-crawler` (drives `scripts/force_orchestrator.py --daemon`), `d1-fast-dashboard` (FAST sintering traces) |
| **interface** — form fields | code builders (`d1-sample-code`, `d1-operation-code`); inherit-from-parent pickers (`d1-material-inherit`, `d1-project-inherit`, `d1-edge-new-toggle`); category inference (`d1-process-category`, `d1-test-category`); `d1-machine-picker`, `d1-campaign-ops`, `d1-project-items`, `d1-composition-bar`, `d1-geometry-preview`, `d1-file-link`, `d1-archive-links`, `d1-report-button` |

`d1-ask-endpoint` is the server-side proxy for the **Ask the Database** page: it
requires a logged-in user and forwards questions to the guarded
`llm-text-to-sql` plugin, injecting the worker secret so it never reaches the
browser. See [`../docs/runbooks/text-to-sql.md`](../docs/runbooks/text-to-sql.md).

## Roles

Human accounts use two roles, created with the lab's user accounts by
`scripts/configure_users_and_policies.sql`:

| Role | Access |
|---|---|
| **Lab Admin** | Full administrative access |
| **Lab Member** | App access + CRUD on the lab collections; later migrations (`*_lab_member_*.sql` and others) extend it per collection |

The Phase 3 role model from [ADR-0005](../docs/adr/0005-directus-rbac-structure.md)
is still defined in `roles.json` / `permissions.json`, and machine users are
provisioned on it:

| Role | Access |
|---|---|
| **Operator** | Create + update samples, operations, test sessions, tooling; read reference tables; no audit_logs. Machine users (e.g. `Rig_1_Fast_Sampling_Node`) use this role with a static bearer token |
| **Researcher** | Read everything, including audit_logs; no writes |
| **Administrator** | Full access + system settings |

See also the [API contract](../docs/api-contract.md), and the [D1 Database wiki](../docs/wiki/database/README.md)
for an illustrated guide to what these extensions look like in use.
