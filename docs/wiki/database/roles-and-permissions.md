# Roles, permissions and the audit log

[← D1 Database wiki](README.md)

## How access works in Directus 11

A **user** has a **role**. A role, or a user directly, carries **policies**. A policy is a set of
permissions (create, read, update or delete, per collection, optionally per field or per row) plus
two switches: **app access** (can use the Directus web app) and **admin access** (bypasses all
permissions). Manage them in **Settings → User Roles** and **Settings → Access Policies**, and
manage people in the **User Directory**.

| User roles | Access policies |
|---|---|
| ![User roles](../images/database/roles.png) | ![Access policies](../images/database/policies.png) |

## The roles in use

| Role | Policy | What it can do |
|---|---|---|
| **Administrator** | Administrator (admin access) | everything, including settings and the data model |
| **Lab Admin** | Lab Admin (admin access) | full administrative access. For the people who run the lab database. |
| **Lab Member** | Lab Member (app access) | uses the app; creates, reads, updates and deletes the lab collections (samples, operations, tests, tooling, campaigns…); reads the audit log. Later migrations named `*_lab_member_*.sql` widen it collection by collection. |
| **Public** | Public | nothing (not signed in) |

The roles and policies, and the lab's real user accounts, are created by
`scripts/configure_users_and_policies.sql`. A local or demo stack should apply only the role and
policy parts of that script, not the real accounts (see the [developer guide](developer-guide.md)).

![The User Directory](../images/database/users.png)

### Machine users and the Phase 3 roles

`core/roles.json` and `core/permissions.json` define an older role model from
[ADR-0005](../../adr/0005-directus-rbac-structure.md):

- **Operator:** writes samples, operations, tests and tooling;
- **Researcher:** reads everything, including the audit log;
- **Administrator**.

`core/apply.sh` creates them. Machine users such as the rig's `Rig_1_Fast_Sampling_Node` use
the Operator role with a static token. See the [API contract](../../api-contract.md).

### Lab Member and files

A Lab Member can record and save a cut from the Force App. Saving a cut uploads two files
(`POST /files`: the `.mat` and the live cache), then creates the `machining_force_analysis` row.
Force Analysis fetches each live cache with `GET /assets/<id>`. Migration
`20261005000133_lab_member_force_app_save.sql` grants exactly that:

| Collection | Lab Member actions | Why |
|---|---|---|
| `directus_files` | create, read | upload a capture. Directus answers an upload with the new file row, so create without read gives the app no file id. Read is not limited to the uploader: Force Analysis opens caches that colleagues uploaded. |
| `machining_force_analysis` | create (read and update already granted) | link the capture to its operation |

Lab Member cannot update or delete files, so a file cannot be replaced or removed from the app
(use a Lab Admin). Before that migration, saving a cut failed at the upload step and left the
operation row behind.

**The `directus_files` read grant is unfiltered.** Any Lab Member can read any file, and
`/assets/<id>` serves the bytes. **Phase 9 follow-up:** when the export-control row filter on
`physical_samples` lands ([ADR-0005](../../adr/0005-directus-rbac-structure.md)), file reads must be
filtered the same way, or `/assets/<id>` bypasses it.

The production server may have been adjusted in the UI. If a rebuild loses a permission you rely
on, record it in a migration.

## The audit log

Every insert, update and delete on the lab tables is recorded by a **Postgres trigger** in
`audit_logs`: which table and record, the old and new values, when, and who. The trigger runs in
the database, so it catches changes from Directus, importers, orchestrators and `psql` alike
([ADR-0003](../../adr/0003-trigger-based-immutable-audit.md)).

- **Who:** Directus connects to Postgres as one database user, so on its own the trigger would
  only see that user. The `actor-identity` hook passes the signed-in Directus user to Postgres
  (the `d1.actor_identity` setting) for each API write, and the trigger records it.
- **Immutable:** the table is append-only. Postgres rules turn any `UPDATE` or `DELETE` on
  `audit_logs` into a no-op, so an entry cannot be changed or removed through SQL.

![The audit log](../images/database/audit-logs.png)

Lab Members and Researchers can read it. Directus's own **Revisions** panel on each record shows
the same history for changes made through Directus.
