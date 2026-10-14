# `/core` — Directus configuration-as-code

Directus is the **swappable adapter** over the Postgres core: it provides the
admin UI, REST/GraphQL API, RBAC, and file handling, but owns **no business
logic the system depends on**
(see [`../docs/adr/0002-directus-as-swappable-adapter.md`](../docs/adr/0002-directus-as-swappable-adapter.md)).

Directus configuration is version-controlled so it is reproducible and
reviewable. Directus **introspects** the schema; it must never alter structure.
The configuration lives in two places:

| Where | What | Applied by |
|---|---|---|
| [`../scripts/configure_*.sql`](../scripts/README.md#directus-configuration) | Collections, fields, relations and presets; the Lab Admin / Lab Member roles and user accounts | `../scripts/configure_all.sh`, plus `configure_users_and_policies.sql` |
| `extensions/` | Hooks, endpoints, modules and interfaces (below) | Bind-mounted into the Directus container |

## Applying it

```bash
# 1. Stack must be up and migrations applied
make up && make migrate && make seed

# 2. Collections, fields and relations, then a Redis flush + Directus restart
bash scripts/configure_all.sh
```

Machine users (the workers, the force crawler, equipment nodes) are Directus users on the
**Administrator** role with a static token created by hand (Settings, User Directory); store the
token in your secrets manager. The Phase 3 `roles.json`, `permissions.json` and `apply.sh`
(Operator and Researcher roles) were deleted with the record-access work
([ADR-0013](../docs/adr/0013-record-access.md)); use `npx directus schema snapshot` if you want a
schema snapshot to diff.

## Extensions (`core/extensions/`)

Mounted read-only at `/directus/extensions` (see `docker-compose.yml`). The
Vue/TypeScript extensions are built in place (`npm install && npm run build` in
the extension's folder; `dist/` is git-ignored). Five of them are npm workspaces of the repo root
because they import shared source: `d1-edit-frame`, `d1-lab-dashboard`, `d1-composition-bar`,
`d1-campaign-ops` and `d1-project-items` (use [`packages/d1-ui`](../packages/d1-ui/), the Explorer
pages' kit). They have no `package-lock.json` of their own: run `npm ci` at the repo root, then
`npm run build:extensions`. The Home page, every index and record page, Labels and the Force and FAST
plotters are STARbase's (`apps/starbase/web`, pages in `packages/starbase-pages`), not Directus modules.
Restart the Directus container
after a rebuild — on the Windows host `EXTENSIONS_AUTO_RELOAD` does not pick up
changes across the bind mount (ADR-0010).

| Type | Extensions |
|---|---|
| **hook** — server-side logic | `actor-identity` (sets the audit actor for API writes; update/delete fall back to `directus_activity`, see below), `campaign-inherit`, `d1-access-guard` (ADR-0011, ADR-0014: refuses co-owner, investigator and campaign-sample rows the caller may not grant, and owner and Restricted changes by anyone but the owner; Restricted is admin-only until A1b), `d1-default-owner` (defaults the owner, or a project's PI, to the creator), `d1-equipment-code` |
| **endpoint** — custom API routes | `d1-ask-endpoint` (`/d1-ask`), `d1-report` (`/d1-report`: printable sample, operation and test reports; `/label` and `/labels` redirect to the labels page (STARbase's once `STARBASE_URL` is set)), `d1-next-number` (`/d1-next-number/sample`: preview of the next sample number), `d1-admin-overview` (`/d1-admin-overview`, admin only: the counts behind the admin Home panels: missing files, fingerprints, force crawler queue, ownerless records), `d1-record-access` (`/d1-record-access/...`: the Who has access list of a record, add, change, remove, transfer, with the email), `d1-people-admin` (`/d1-people-admin`, admin only: `/people` the people with their login status, role and last access plus the logins without a person, `/attention` the counts of what needs attention, `/people/:id/access?list=owns|shared|investigator` what a person owns, was shared and investigates; the person themselves may read their own access; `PATCH /logins/:user_id` changes a login's account role or suspends / reactivates it (account administrators only, never the last one); `POST /invite` and `/invite/resend` e-mail an invite to a person's login, `STARBASE_URL` + `/accept-invite`), `d1-trace` (`/d1-trace/sample/:id`: a sample's lineage and event timeline, filtered to what the caller may read; hidden groups are booleans, never counts), `d1-usage` (`/d1-usage`: per-user "Frequently used" scores for the Explorer Home, stored in `d1_private.user_usage`; each route touches only the signed-in user's own rows), `d1-links` (`/d1-links`: `{ starbaseUrl }`, STARBASE_URL or null; the edit frame's postMessage target) and the public permanent links `/d1-links/go`, `/d1-links/go/r/<collection>/<id>` and `/d1-links/go/p/<path>`, which redirect to STARbase (503 while `STARBASE_URL` is unset) |
| **module** — full-page apps | `d1-lab-dashboard`, `d1-ask-db` (Ask the Database), `d1-force-crawler` (drives `scripts/force_orchestrator.py --daemon`), `d1-edit-frame` (hidden; `/admin/d1-edit/<collection>/<id>`, one record's form with Save and Cancel and no navigation, framed by STARbase) |
| **interface** — form fields | code builders (`d1-sample-code`, `d1-operation-code`); inherit-from-parent pickers (`d1-material-inherit`, `d1-project-inherit`, `d1-edge-new-toggle`); category display (`d1-process-category` reads `manufacturing_methods.process_category`; Postgres applies it on save; `d1-test-category`); `d1-machine-picker`, `d1-campaign-ops`, `d1-project-items`, `d1-composition-bar`, `d1-geometry-preview`, `d1-file-link`, `d1-archive-links`, `d1-report-button` (report and label buttons on sample / operation / test forms) |

Operation numbers and operation codes are assigned by Postgres, not by an extension: a trigger on
`manufacturing_operations` fills `operation_sequence` (max+1 per sample, locked) and replaces the
`{seq}` and `{mf}` placeholders that the `d1-operation-code` interface leaves in a new record's code
(migration `20261003000126`). The interface shows a preview; the database decides. Sample numbers
work the same way (`{seq}-` in `sample_code`, migration `20261003000127`). Migration
`20261003000129` also moved two former hooks into Postgres: the process category now comes from
`manufacturing_methods.process_category`, and copying a prep recipe's steps (formerly
`d1-apply-prep-recipe`) is a trigger that rejects a recipe on a non-Sample-Preparation operation.

Audit actor: `actor-identity` sets `d1.actor_identity` only when Directus hands the hook the write's
transaction (create does; update and delete are believed not to). Migration `20261003000128` adds a
trigger on `directus_activity` that attributes the audit rows of the same transaction, so read the
actor through `v_audit_logs_with_actor`. Run `node --test core/extensions/actor-identity/index.test.mjs`.

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

Machine users are Directus users on the **Administrator** role with a static bearer token. The
Phase 3 Operator and Researcher roles of [ADR-0005](../docs/adr/0005-directus-rbac-structure.md)
no longer exist in the repo (`roles.json`, `permissions.json` and `apply.sh` were deleted, ADR-0013).

Who can read, change and share each record is described in
[ADR-0011](../docs/adr/0011-row-level-visibility.md) and [ADR-0013](../docs/adr/0013-record-access.md)
(the Who has access list and Restricted records).

See also the [API contract](../docs/api-contract.md), and the [D1 Database wiki](../docs/wiki/database/README.md)
for an illustrated guide to what these extensions look like in use.
