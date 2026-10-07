# D1-Database API Contract

**Version:** Phase 3  
**Status:** Active  
**Last updated:** 2026-09-26

---

## 1. Overview and Stability Guarantee

D1-Database exposes its tracking domain through a REST API. In Phase 3 the
implementation is **Directus** running on top of the PostgreSQL schema defined
in Phase 1. Directus introspects the schema and auto-generates collection
endpoints at `/items/{collection}`.

**ADR-0002 guarantee:** Directus is a swappable adapter. If it is ever replaced
(e.g., by a FastAPI layer), the same URL paths, field names, authentication
headers, OCC pattern, and error codes documented here will be re-implemented.
Plugins and machine nodes **must not** depend on Directus-specific internals
(Flows, Directus Extensions API, Directus SDK internals). Code against this
document.

### Base URL

```
http://<host>:8055          # default local dev
https://d1.<lab-domain>     # production (TLS reverse-proxy)
```

All paths below are relative to the base URL.

---

## 2. Authentication

### 2.1 Human users — short-lived JWT

Human users (Operators, Researchers) log in through the Directus admin UI or
via the token endpoint.

```
POST /auth/login
Content-Type: application/json

{
  "email": "operator@lab.ac.uk",
  "password": "secret"
}
```

Response:

```json
{
  "data": {
    "access_token": "<JWT>",
    "expires": 900000,
    "refresh_token": "<opaque>"
  }
}
```

Use the `access_token` in subsequent requests:

```
Authorization: Bearer <access_token>
```

Tokens expire after 15 minutes by default. Refresh via:

```
POST /auth/refresh
Content-Type: application/json

{ "refresh_token": "<opaque>" }
```

### 2.2 Machine users — static tokens

Equipment nodes and automated plugins use **static bearer tokens** tied to a
dedicated machine-user account. The token never expires unless explicitly
revoked (see §9).

```
Authorization: Bearer <static-machine-token>
```

Machine users are provisioned with the Operator role. There is no login flow;
include the token directly in every request.

Example (MATLAB / curl):

```matlab
opts = weboptions('HeaderFields', ...
    {'Authorization', ['Bearer ' getenv('D1_RIG1_TOKEN')]});
response = webread([base_url '/items/physical_samples'], opts);
```

```bash
curl -H "Authorization: Bearer $D1_RIG1_TOKEN" \
     "$DIRECTUS_URL/items/physical_samples"
```

### 2.3 Actor identity for audit

Every mutating request through the API is attributed in `audit_logs.actor_identity`
**automatically** — no client header is required or trusted.

The Directus hook extension `core/extensions/actor-identity/` runs a `filter` on
`items.create` / `items.update` / `items.delete` and, **inside the same database
transaction as the write**, sets the `d1.actor_identity` PostgreSQL session
variable to the authenticated identity:

```js
SELECT set_config('d1.actor_identity', <authenticated user id>, true)
```

The audit trigger reads it back within that transaction. The hook only sets it when
Directus hands it the write's own transaction; for writes where it does not (Directus
emits the update/delete filters before it opens the transaction), migration
`…128_audit_actor_from_directus_activity` attributes the audit rows from the
`directus_activity` row Directus writes in the same transaction. That actor is kept in
`audit_log_actors` (`audit_logs` stays append-only); read **`v_audit_logs_with_actor`**
to ask who made a change. Because the identity is
taken from the authenticated Directus user / machine-token user (each rig has its
own machine user, e.g. the `Rig_1` sampling node), it **cannot be spoofed** by a
client-supplied header. This is a deliberate hardening over the original
header-based design.

> Direct-to-PostgreSQL writers that bypass the API must still set the GUC
> themselves — see §8.4.

---

## 3. Common Query Conventions

All collection endpoints accept these query parameters:

| Parameter | Purpose | Example |
|-----------|---------|---------|
| `fields` | Comma-separated fields to return | `?fields=sample_id,sample_code,current_status` |
| `filter` | Filter expression (see §3.1) | `?filter[current_status][_eq]=active` |
| `sort` | Sort by field(s), prefix `-` for DESC | `?sort=-updated_at` |
| `limit` | Max records per page (default 100, max 1000) | `?limit=50` |
| `offset` | Pagination offset | `?offset=100` |
| `search` | Full-text search across string fields | `?search=Ti6Al4V` |
| `aggregate` | Aggregate functions | `?aggregate[count]=*` |

### 3.1 Filter syntax

```
?filter[<field>][<operator>]=<value>
```

Common operators:

| Operator | Meaning |
|----------|---------|
| `_eq` | equals |
| `_neq` | not equals |
| `_lt` / `_lte` | less than / less than or equal |
| `_gt` / `_gte` | greater than / greater than or equal |
| `_in` | value in list: `?filter[status][_in]=active,consumed` |
| `_null` | field is null: `?filter[notes][_null]=true` |
| `_contains` | substring match (case-sensitive) |
| `_icontains` | substring match (case-insensitive) |

### 3.2 Pagination

```
GET /items/physical_samples?limit=50&offset=0   # page 1
GET /items/physical_samples?limit=50&offset=50  # page 2
```

The response includes a `meta.total_count` when `?meta=total_count` is added.

### 3.3 Selecting fields

Use `fields=*` to request all top-level fields. Nested relational fields are
not supported in the adapter-agnostic contract; join using separate requests or
the views listed in §8.

---

## 4. physical_samples

The canonical record of every physical specimen in the lab.

### 4.1 List samples

```
GET /items/physical_samples
```

Optional filters:

```
GET /items/physical_samples?filter[current_status][_eq]=active&sort=-updated_at
```

### 4.2 Get a single sample by primary key

```
GET /items/physical_samples/{sample_id}
```

### 4.3 Get a sample by sample code (MATLAB pre-test query)

The canonical pre-test lookup. Plugins and MATLAB scripts use this to retrieve
the full sample profile before starting a test session.

```
GET /items/physical_samples?filter[sample_code][_eq]={code}&fields=*
```

Response shape:

```json
{
  "data": [
    {
      "sample_id": "550e8400-e29b-41d4-a716-446655440000",
      "sample_code": "10-AA-MF-2024-03-15",
      "current_status": "active",
      "version": 3,
      "updated_at": "2024-03-15T14:22:00Z",
      "notes": null,
      "export_controlled": false
    }
  ]
}
```

If `data` is an empty array, the sample code does not exist — abort the test.

### 4.4 Create a sample (Operator only)

```
POST /items/physical_samples
Content-Type: application/json
Authorization: Bearer <token>

{
  "sample_code": "10-AA-MF-2024-03-15",
  "current_status": "active",
  "notes": "First FAST batch",
  "export_controlled": false
}
```

Fields `sample_id` (auto UUID), `version` (starts at 1), `updated_at`, and
`created_at` are system-managed and must not be supplied.

Successful response: `200 OK` with `{ "data": { ...created record... } }`.

### 4.5 Update a sample — OCC pattern (Operator only)

See §6 for full OCC details. Short form:

```
PATCH /items/physical_samples/{sample_id}?filter[version][_eq]={current_version}
Content-Type: application/json
Authorization: Bearer <token>

{
  "current_status": "consumed",
  "notes": "Used in op 42"
}
```

If `data` in the response is `null` or the `data` array is empty, a concurrent
write incremented the version — read the record again and retry.

### 4.6 Delete

Deletion is not permitted for Operators or Researchers. Only Administrators can
delete physical samples, and only when no downstream records reference them.

---

## 5. manufacturing_operations

One row per machining pass (FAST, milling, turning, etc.).

### 5.1 List operations for a sample

```
GET /items/manufacturing_operations?filter[sample_id][_eq]={sample_id}&sort=operation_date
```

### 5.2 Create an operation (Operator / machine user)

```
POST /items/manufacturing_operations
Content-Type: application/json
Authorization: Bearer <static-machine-token>

{
  "sample_id": "550e8400-e29b-41d4-a716-446655440000",
  "method_id": "<uuid of manufacturing_method>",
  "equipment_id": "<uuid of equipment>",
  "insert_edge_id": "<uuid of insert_edge or null>",
  "operator_name": "J. Smith",
  "operation_date": "2024-03-15T10:30:00Z",
  "pass_code": "10-AA-MF-2024-03-15-F1",
  "force_file_id": "10-AA-MF-2024-03-15-F1-20MPM_0.05feed_0.1DoC",
  "capture_software": "ABFP v2.3",
  "capture_frequency_khz": 20,
  "file_storage_pointer": "s3://d1-data/forces/10-AA-MF-2024-03-15-F1.tdms",
  "recorded_metadata": {
    "spindle_speed_rpm": 1200,
    "feed_mm_per_rev": 0.05,
    "depth_of_cut_mm": 0.1
  }
}
```

`operation_id`, `version`, and `updated_at` are system-managed.

### 5.3 Update an operation — OCC

```
PATCH /items/manufacturing_operations/{operation_id}?filter[version][_eq]={N}
```

Same OCC semantics as §6.

### 5.4 Large file reference

The `file_storage_pointer` field holds a URI (MinIO/S3 object path). The file
itself is not stored in the database. See §7 for the file storage contract.

---

## 6. test_sessions

One row per test run (tribology, hardness, SEM, etc.).

### 6.1 List sessions for a sample

```
GET /items/test_sessions?filter[sample_id][_eq]={sample_id}&sort=-session_date
```

### 6.2 Get sessions by type

```
GET /items/test_sessions?filter[test_type][_eq]=tribology&filter[status][_eq]=processed
```

### 6.3 Create a test session

```
POST /items/test_sessions
Content-Type: application/json
Authorization: Bearer <token>

{
  "sample_id": "550e8400-e29b-41d4-a716-446655440000",
  "insert_edge_id": null,
  "session_date": "2024-03-16T09:00:00Z",
  "operator_name": "J. Smith",
  "test_type": "tribology",
  "summary_stats": {
    "mean_friction_coeff": 0.42,
    "wear_volume_mm3": 0.003
  },
  "plot_uris": [
    "s3://d1-data/plots/session-abc123-friction.png"
  ],
  "file_storage_pointer": "s3://d1-data/raw/session-abc123.tdms",
  "status": "registered"
}
```

Since migration `20260703000063_test_subject_m2a.sql`, what a test targets is
recorded in the `test_sessions_subject` many-to-any junction (the `subject`
field in Directus). `sample_id` and `insert_edge_id` remain as nullable columns
but are not synced into it, so a session that should show its subject in the
admin UI also needs
`"subject": [{ "collection": "physical_samples", "item": "<sample_id>" }]`.

### 6.4 Update session status

```
PATCH /items/test_sessions/{session_id}?filter[version][_eq]={N}
Content-Type: application/json

{ "status": "pending_processing" }
```

`status` must be one of `registered`, `pending_processing`, `processing`,
`processed`, `analysing`, `analysed` or `failed` (a CHECK constraint since
migration `20260619000013`); see the lifecycle in
[`plugin-contract.md`](./plugin-contract.md).

---

## 7. Optimistic Concurrency Control (OCC)

### 7.1 Rationale

`physical_samples`, `manufacturing_operations`, and `test_sessions` have a
`version` column maintained by a PostgreSQL trigger. Every `UPDATE` increments
`version` atomically. This prevents lost-update races between concurrent writers
(human + machine, or two operator tabs).

### 7.2 PATCH with version guard

Append a version filter to every `PATCH` request:

```
PATCH /items/{collection}/{id}?filter[version][_eq]={version_you_read}
```

**If the version matches** (no concurrent update), the patch succeeds and the
trigger increments `version` by 1. The response contains the updated record.

**If the version does not match** (a concurrent update incremented it first),
Directus finds no matching record and returns:

```json
{ "data": null }
```

or an empty data array, depending on the Directus version. In either case, the
caller must:

1. Re-fetch the record with a `GET`.
2. Re-apply the intended change to the fresh data.
3. Retry the `PATCH` with the new `version`.

### 7.3 Version field is read-only to callers

Never include `"version"` in a `POST` or `PATCH` body. It is exclusively
managed by the trigger. Supplying it will be rejected with `400 Bad Request`.

### 7.4 MATLAB example

```matlab
function sample = safeUpdateStatus(base_url, token, sample_id, new_status)
    opts = weboptions('HeaderFields', {'Authorization', ['Bearer ' token]}, ...
                      'RequestMethod', 'get');
    r = webread([base_url '/items/physical_samples/' sample_id], opts);
    sample = r.data;
    v = sample.version;

    patch_opts = weboptions('HeaderFields', {'Authorization', ['Bearer ' token]}, ...
                            'MediaType', 'application/json', ...
                            'RequestMethod', 'patch');
    url = [base_url '/items/physical_samples/' sample_id ...
           '?filter[version][_eq]=' num2str(v)];
    result = webwrite(url, struct('current_status', new_status), patch_opts);
    if isempty(result.data)
        error('D1:OccConflict', 'Version conflict on sample %s — retry', sample_id);
    end
    sample = result.data;
end
```

---

## 8. Audit Log

### 8.1 Architecture

Every `INSERT`, `UPDATE`, and `DELETE` on core tables is captured by a
PostgreSQL trigger (`audit_fn`) that writes to `audit_logs`. This is
independent of the application layer — direct database writes by machine nodes
are captured identically to API writes.

`audit_logs` is **append-only**. `UPDATE` and `DELETE` on `audit_logs` are
blocked by a database rule. There is no API endpoint to delete audit entries.

### 8.2 Reading audit logs (Researcher / Administrator only)

```
GET /items/audit_logs?filter[table_name][_eq]=physical_samples&sort=-created_at&limit=50
```

Response fields:

| Field | Type | Description |
|-------|------|-------------|
| `log_id` | BIGINT | Auto-incrementing primary key |
| `table_name` | TEXT | Affected table |
| `action_type` | TEXT | `INSERT`, `UPDATE`, or `DELETE` |
| `row_id` | TEXT | Primary key of affected row (as text) |
| `row_before` | JSONB | State before the change (null for INSERT) |
| `row_after` | JSONB | State after the change (null for DELETE) |
| `actor_identity` | TEXT | Authenticated Directus user id, set by the actor-identity hook |
| `created_at` | TIMESTAMPTZ | When the change occurred |

### 8.3 Setting actor identity

API writes are attributed automatically (see §2.3): the `actor-identity` hook
sets `d1.actor_identity` from the authenticated user inside the write
transaction, with the `directus_activity` fallback described there (query
`v_audit_logs_with_actor`). Machine nodes therefore only need to authenticate with their own
static token — each rig's machine user uniquely identifies it in the audit log.
No client-supplied header is required or trusted.

### 8.4 Audit for direct DB writes

For scripts that write directly to PostgreSQL (bypassing the API):

```sql
SET LOCAL "d1.actor_identity" = 'migration_script_v8';
INSERT INTO physical_samples ...;
```

This sets the session variable for the duration of the transaction so the
trigger captures the correct actor.

---

## 9. Reference Table Endpoints

Reference tables are read-only via the API for Operator and Researcher roles.

| Collection | Description |
|-----------|-------------|
| `/items/materials` | Alloy definitions (alloy_code, name, nominal_composition) |
| `/items/alloying_elements` | Elements that make up alloys |
| `/items/material_iso_classifications` | ISO 513 material group codes |
| `/items/manufacturing_methods` | FAST, milling, turning, etc. |
| `/items/equipment` | Machine catalogue (NLX-2500, FAST rig, etc.) |
| `/items/tools` | Tool holder definitions |
| `/items/insert_types` | Insert type catalogue (ISO grade, geometry) |
| `/items/projects` | Project codes for grouping samples |
| `/items/raw_stock_lots` | Incoming material lot traceability |

Example — look up method_id for FAST before creating an operation:

```
GET /items/manufacturing_methods?filter[method_code][_eq]=MF&fields=method_id,method_code,description
```

---

## 10. Genealogy and Provenance

### 10.1 Sample genealogy

Record parent-child relationships between samples (cut from, split from, etc.):

```
POST /items/sample_genealogy
{
  "child_sample_id": "<uuid>",
  "parent_sample_id": "<uuid>",
  "relationship_type": "cut_from"
}
```

Query the flat view for human-readable genealogy:

```
GET /items/sample_genealogy?filter[parent_sample_id][_eq]={parent_uuid}
```

### 10.2 Stock provenance

Link a sample to its raw stock lot:

```
POST /items/sample_stock_provenance
{
  "sample_id": "<uuid>",
  "lot_id": "<uuid>",
  "provenance_notes": "Bottom half of rod AR-2024-001"
}
```

---

## 11. File Storage Contract

> Note: MinIO presigned URLs are established in Phase 4. This section documents
> the contract agreed in advance.

Large binary files (force traces, TDMS, images) are stored in MinIO (S3-compatible), not in PostgreSQL. The database stores only a URI pointer in `file_storage_pointer`.

### 11.1 URI convention

```
s3://d1-data/{data-type}/{sample_code}/{filename}
```

Examples:

```
s3://d1-data/forces/10-AA-MF-2024-03-15/10-AA-MF-2024-03-15-F1.tdms
s3://d1-data/plots/10-AA-MF-2024-03-15/session-abc123-friction.png
```

### 11.2 Obtaining a presigned upload URL (Phase 4)

```
POST /d1/storage/presign-upload
Authorization: Bearer <token>

{
  "key": "forces/10-AA-MF-2024-03-15/10-AA-MF-2024-03-15-F1.tdms",
  "content_type": "application/octet-stream",
  "expires_seconds": 3600
}
```

Response:

```json
{
  "upload_url": "https://minio.lab:9000/d1-data/forces/...?X-Amz-Signature=...",
  "key": "forces/10-AA-MF-2024-03-15/10-AA-MF-2024-03-15-F1.tdms",
  "expires_at": "2024-03-15T11:30:00Z"
}
```

### 11.3 Obtaining a presigned download URL (Phase 4)

```
GET /d1/storage/presign-download?key=forces/10-AA-MF-2024-03-15/10-AA-MF-2024-03-15-F1.tdms
Authorization: Bearer <token>
```

Response contains `download_url` valid for 1 hour.

---

## 12. Error Responses

All errors follow the Directus error envelope (stable across adapter swap):

```json
{
  "errors": [
    {
      "message": "Human-readable description",
      "extensions": {
        "code": "MACHINE_READABLE_CODE"
      }
    }
  ]
}
```

### 12.1 HTTP status codes

| Code | Meaning | Common cause |
|------|---------|--------------|
| 200 | OK | Request succeeded |
| 400 | Bad Request | Validation failure, missing required field, invalid filter |
| 401 | Unauthorized | Missing or expired `Authorization` header |
| 403 | Forbidden | Authenticated but insufficient role permissions |
| 404 | Not Found | Record or collection does not exist |
| 409 | Conflict | Unique constraint violation (e.g., duplicate `sample_code`) |
| 500 | Internal Server Error | Unexpected server error — check Directus logs |

### 12.2 OCC conflict

A version conflict on `PATCH` returns `200` with `"data": null` (not 409),
because from Directus's perspective the filter simply matched no rows. Callers
must treat `data: null` on a PATCH as an OCC signal, not a general error.

### 12.3 Validation errors

```json
{
  "errors": [
    {
      "message": "Value for field \"sample_code\" in collection \"physical_samples\" has to be unique.",
      "extensions": {
        "code": "RECORD_NOT_UNIQUE",
        "collection": "physical_samples",
        "field": "sample_code"
      }
    }
  ]
}
```

---

## 13. Machine User Token Management

### 13.1 Token provisioning

Machine user tokens are provisioned during initial setup by `core/apply.sh`.
The token is printed once at creation time and must be stored in a secrets
vault (e.g., HashiCorp Vault, lab password manager, or `.env` for dev).

### 13.2 Listing machine users (Administrator only)

```
GET /users?filter[email][_contains]=d1-internal.local
```

### 13.3 Creating a new machine user (Administrator only)

```
POST /users
Authorization: Bearer <admin-token>

{
  "email": "rig2@d1-internal.local",
  "first_name": "Rig_2",
  "last_name": "Tribometer_Node",
  "role": "<operator-role-uuid>",
  "token": "<openssl rand -hex 32>",
  "status": "active"
}
```

### 13.4 Revoking a token

The cleanest revocation is to disable the user:

```
PATCH /users/{user_id}
{ "status": "suspended" }
```

Or delete the user entirely:

```
DELETE /users/{user_id}
```

Token rotation (set a new token without losing user history):

```
PATCH /users/{user_id}
{ "token": "<new-token>" }
```

### 13.5 Token security notes

- Store tokens as environment variables or in a secrets manager, never in
  source code or committed `.env` files.
- Each physical equipment node should have its own dedicated machine user so
  individual nodes can be revoked without affecting others.
- Static tokens are chosen over OAuth/short-lived JWTs because MATLAB and
  similar lab clients have poor OAuth flow support (see ADR-0005).

---

## 14. Health Check

No authentication required:

```
GET /server/health
```

Response when healthy:

```json
{ "status": "ok" }
```

Useful for container readiness probes and `apply.sh` startup polling.

---

## 15. export_controlled Flag

The `physical_samples.export_controlled` boolean is set to `true` for samples
subject to export control regulations. In Phase 9, field-level permissions will
restrict visibility of export-controlled samples to credentialled users only.
Until then, all Operator and Researcher users can read this field; access
control is enforced procedurally.

Plugins and MATLAB scripts that create samples should always explicitly set this
field:

```json
{ "export_controlled": false }
```

---

## 16. API Version Discovery

The Directus server version is available at:

```
GET /server/info
```

This is implementation detail and should not be used by plugins. The stable
interface version is tracked in this document and in `docs/adr/0005-directus-rbac-structure.md`.

---

## Appendix A — Quick Reference

### Create + read a sample (bash / curl)

```bash
# Authenticate
TOKEN=$(curl -sf -X POST "$DIRECTUS_URL/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"'"$DIRECTUS_ADMIN_EMAIL"'","password":"'"$DIRECTUS_ADMIN_PASSWORD"'"}' \
  | jq -r '.data.access_token')

# Create
curl -sf -X POST "$DIRECTUS_URL/items/physical_samples" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sample_code":"TEST-001","current_status":"active","export_controlled":false}'

# Read by code
curl -sf "$DIRECTUS_URL/items/physical_samples?filter[sample_code][_eq]=TEST-001&fields=*" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

### MATLAB pre-test snippet

```matlab
base = getenv('D1_URL');          % e.g. http://localhost:8055
tok  = getenv('D1_RIG1_TOKEN');   % static machine token
code = '10-AA-MF-2024-03-15';

opts = weboptions( ...
    'HeaderFields', {'Authorization', ['Bearer ' tok]}, ...
    'Timeout', 10);

url  = [base '/items/physical_samples' ...
        '?filter[sample_code][_eq]=' urlencode(code) '&fields=*'];
resp = webread(url, opts);

if isempty(resp.data)
    error('D1:NotFound', 'Sample %s not found in LIMS', code);
end
sample = resp.data(1);
fprintf('Sample %s status: %s  version: %d\n', ...
    sample.sample_code, sample.current_status, sample.version);
```
