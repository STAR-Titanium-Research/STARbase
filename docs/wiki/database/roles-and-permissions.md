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

### What Lab Member cannot do (as configured in the repository)

Building the stack from the repository and signing in as a Lab Member shows two gaps. Both matter
for the Force App:

- **No access to files.** No policy gives Lab Member any permission on `directus_files`, so a Lab
  Member cannot upload files or read stored assets. In the Force App that means **saving a cut
  fails** at the upload step, leaving the operation row behind. Every view that reads a cut's live
  cache (Lite FRM, Power, Spectro, Waterfall, filters) is also refused.
- **Cannot create force-analysis rows.** Lab Member can read and update `machining_force_analysis`
  (`20260911000111_lab_member_force_analysis_update.sql`) but not create rows, which saving a cut
  also needs.

The production server may have been adjusted in the UI since. If Lab Members there can record,
record those permissions in a migration so a rebuild keeps them. Until then, use a Lab Admin
account on the acquisition PC. This is listed in [Known issues](known-issues.md).

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
