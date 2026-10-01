# ADR-0005 — Directus RBAC Structure

- **Status:** Accepted
- **Date:** 2026-06-18
- **Deciders:** Maintainer + Claude (Phase 3 planning)
- **Update (2026-07-02):** human accounts now use two roles, Lab Admin and Lab
  Member (`scripts/configure_users_and_policies.sql`). The three roles below
  remain defined and are what machine users are provisioned on — see
  [`core/README.md`](../../core/README.md#roles).

## Context

Phase 3 introduces the Directus application layer on top of the Phase 1
PostgreSQL schema. We need a Role-Based Access Control (RBAC) structure that:

- Enforces the access boundaries described in the spec (operators write, researchers
  read, administrators manage)
- Is version-controlled and re-applicable from a script (`core/apply.sh`)
- Survives the adapter-swap escape hatch described in ADR-0002 (i.e., is
  documented in terms of intent, not Directus internals)
- Does not expose audit history to lab operators (separation of concerns)
- Supports static-token machine users for equipment nodes running MATLAB /
  plugin software

## Decision

### Three roles, not more fine-grained

We implement exactly **three roles**: Operator, Researcher, Administrator.

Alternative structures considered:

- **Per-project roles** (e.g., Project_A_Operator): rejected. The number of
  projects will grow; maintaining one Directus role per project creates
  combinatorial complexity in `permissions.json` and the apply script. Project-
  level access restriction is deferred to Phase 9 where it will be implemented
  as a row-level permission filter on `physical_samples.project_id`, not as
  separate roles.

- **Separate read/write sub-roles per collection** (e.g., SampleWriter,
  SessionWriter): rejected. Over-engineering for the current number of users
  and collections. The two meaningful boundaries are human-vs-read-only and
  operator-vs-administrator; a third role dimension adds friction without
  material security benefit at this stage.

- **Single "lab" role**: rejected. The spec explicitly separates write capability
  (Operator) from read-only analytics access (Researcher). Conflating them would
  violate principle of least privilege.

The three-role structure maps cleanly to real actors: equipment operators, data
analysts/academics, and system administrators. It can be extended (e.g., a
ProjectLead role) without restructuring.

### Machine users use static tokens, not OAuth or short-lived JWTs

Equipment nodes (FAST rig, tribometer, NMR, SEM) authenticate with **static
bearer tokens** stored as environment variables on the node.

Reasons:

1. **Client capability**: MATLAB's `webread`/`webwrite` and typical Python
   scripts do not have a built-in OAuth 2.0 client. Implementing token-refresh
   logic in MATLAB, LabVIEW, or embedded acquisition software adds significant
   fragile code that must be maintained per-instrument.

2. **Revocability without rotation complexity**: A static token can be revoked
   immediately by suspending the machine user account (`PATCH /users/{id}`
   `{"status":"suspended"}`). This is simpler and faster than managing OAuth
   client credentials across equipment nodes.

3. **Per-device isolation**: Each physical node has its own machine user (e.g.,
   `rig1@d1-internal.local`, `tribometer@d1-internal.local`). Revoking one
   node's token does not affect others. The `actor_identity` field in
   `audit_logs` records which node performed each write.

4. **Air-gapped / offline tolerance**: Some equipment operates in partially
   network-isolated environments. A token that does not require round-trips to
   an auth server is more robust.

Trade-off accepted: static tokens are a long-lived credential and must be stored
securely (secrets manager, not committed `.env`). The mitigation is per-device
tokens with easy revocation, and a Phase 9 review of the token rotation policy.

### Audit log is PostgreSQL-trigger-based, not Directus revisions

See ADR-0003 for the full rationale. Summary as it relates to RBAC:

- Directus revisions are scoped to writes via the Directus API. Direct database
  writes (migration scripts, plugin bulk-imports, machine nodes with direct DB
  access) would be invisible to Directus revisions.
- The trigger fires for **all** writes regardless of source, maintaining the
  chain of custody required for the lab's traceability obligations.
- Directus revisions are not version-controlled or re-creatable; the trigger
  schema is in `db/migrations/` and survives any adapter replacement.
- Researchers need read access to audit history. Granting them `SELECT` on
  `audit_logs` via the Directus Researcher role permission (in
  `core/permissions.json`) is straightforward. Replicating this via Directus
  revisions would require a custom extension.

### export_controlled field-level permissions deferred to Phase 9

`physical_samples.export_controlled` is included in the schema now (Phase 1)
as a boolean flag. Full field-level access control (hiding the field from users
without export-control clearance, restricting which samples appear in query
results for uncredentialled researchers) is deferred to Phase 9 because:

- The user base in Phases 3–8 consists entirely of in-lab personnel who already
  hold the required clearances.
- Implementing row-level security for export-controlled samples in Directus
  requires a permissions filter `{"export_controlled":{"_eq":false}}` on the
  Researcher role, or a custom hook that injects the filter based on a
  user-level attribute. Both approaches require a clear policy specification
  that has not yet been finalised.
- The flag is captured and stored correctly from day one; the access restriction
  is a permissions-layer change that does not require schema migration.

In Phase 9, the implementation will add a `clearance_level` field to the
Directus user profile and a conditional `permissions.filter` on
`physical_samples` for the Researcher role.

## Consequences

### Positive

- Simple, auditable RBAC: three roles means three sections in
  `core/permissions.json` and a straightforward mental model for all team members.
- Version-controlled permissions: `core/apply.sh` re-applies the full RBAC
  state from source control, making configuration drift detectable and
  recoverable.
- Machine-user isolation: per-device tokens allow targeted revocation without
  disrupting the rest of the lab.
- Audit survives any write path: trigger-based audit captures all mutations
  regardless of whether they came through Directus, a direct PSQL session, or
  a future replacement API layer.

### Negative / Costs

- Static tokens require an out-of-band secure distribution channel (secrets
  manager or hand-delivery for lab equipment). This is operational overhead.
- Three roles may prove too coarse if, for example, a graduate student needs
  write access to `test_sessions` but not `physical_samples`. The current answer
  is "that level of granularity is not in scope"; it will require a role addition
  if the need arises.
- `core/apply.sh` is idempotent for role creation (skip-if-exists) but not for
  permissions: running it twice will create duplicate permission rows. A future
  improvement should `DELETE` existing permissions for the roles before
  re-inserting. For now, run `apply.sh` once at initial bootstrap; subsequent
  changes are applied by the Administrator via the Directus UI or a targeted
  curl one-liner.

## References

- ADR-0001: PostgreSQL as durable core
- ADR-0002: Directus as swappable adapter
- ADR-0003: Trigger-based immutable audit log
- `core/roles.json` — role definitions
- `core/permissions.json` — permission matrix
- `core/apply.sh` — bootstrap script
- `docs/api-contract.md` — stable API contract (§13 covers machine user tokens,
  §15 covers export_controlled)
