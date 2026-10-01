# Plugin Contract — Core ↔ Plugin Interface

**Version:** Phase 4
**Status:** Active
**Last updated:** 2026-06-18

---

## 1. Overview

This document specifies the interface that any heavy-data plugin must honour in
order to interoperate with the D1-Database LIMS core. It is written in
Directus-agnostic terms (plain HTTP and JSON) so that the contract survives an
adapter swap (see ADR-0002).

A "plugin" in this sense is a worker container that:

- Accepts presigned-upload requests from clients.
- Receives webhook notifications from the core when a new `test_sessions` record
  is created with a `file_storage_pointer`.
- Processes the referenced file asynchronously via a Redis job queue.
- Writes results back to the core via the standard REST API.

The reference implementation is `plugins/heavy-data-worker/`. A conforming
replacement may be written in any language provided it satisfies every endpoint
and behaviour defined here.

---

## 2. Authentication

### 2.1 Plugin-to-core authentication

The plugin authenticates all write-back requests to the core API using a static
Operator machine token. This is the same token pattern used by equipment nodes
(see `docs/api-contract.md` §2.2 and ADR-0005).

The token is supplied as an environment variable:

```
WORKER_DIRECTUS_TOKEN=<static-bearer-token>
```

All requests from the plugin to the core include:

```
Authorization: Bearer <WORKER_DIRECTUS_TOKEN>
```

The associated machine user must hold the Operator role in the core's RBAC
structure. It must have `PATCH` permission on the `test_sessions` collection.

### 2.2 Actor identity header

The plugin should set the actor identity header on all mutating requests so
that the audit log records an identifiable actor:

```
X-Actor-Identity: heavy-data-worker
```

### 2.3 Webhook authentication

The Directus Flow POSTs to the plugin's webhook endpoint. The endpoint is
reachable only within the Docker network (`http://heavy-data-worker:8080`) and
is not exposed to the public internet. No additional token is required on the
webhook path; network isolation is the control.

If the deployment topology changes (e.g., the worker is exposed externally),
a shared secret header (`X-D1-Webhook-Secret`) should be added to the Flow
configuration and validated by the handler.

---

## 3. Queue Message Shape

When the webhook fires, the handler enqueues a job on the Redis queue using the
`rq` library. The queue is named `heavy-data`.

The job is enqueued by calling the worker function with the following keyword
arguments (serialised by rq as JSON):

```json
{
  "session_id": "<uuid of the test_sessions record>",
  "object_key": "<MinIO object key, e.g. 10-AA-MF-2024-03-15/F1/10-AA-MF-2024-03-15-F1.d1f>",
  "collection": "test_sessions"
}
```

| Field | Type | Description |
|---|---|---|
| `session_id` | string (UUID) | Primary key of the `test_sessions` record to update on completion. |
| `object_key` | string | MinIO object key extracted from `file_storage_pointer` (everything after `minio://{bucket}/`). |
| `collection` | string | Always `test_sessions` in Phase 4. Reserved for future multi-collection support. |

The `object_key` is derived from the `file_storage_pointer` field of the
`test_sessions` record. See §7 for the storage pointer convention.

---

## 4. Presigned Upload API

The plugin exposes two endpoints to support direct-to-MinIO multipart upload.
These are called by the client before the file reaches MinIO; the plugin never
touches the file contents at this stage.

### 4.1 Initiate multipart upload

```
POST /api/presign-upload
Content-Type: application/json
Authorization: Bearer <WORKER_DIRECTUS_TOKEN>
```

Request body:

```json
{
  "object_key": "10-AA-MF-2024-03-15/F1/10-AA-MF-2024-03-15-F1.d1f",
  "n_parts": 12,
  "content_type": "application/octet-stream"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `object_key` | string | yes | Destination key in the configured MinIO bucket. Must follow the naming convention in §7. |
| `n_parts` | integer | yes | Number of parts. Each part except the last must be at least 5 MB. |
| `content_type` | string | no | MIME type. Defaults to `application/octet-stream`. |

Response (`200 OK`):

```json
{
  "upload_id": "VXBsb2FkIElE...",
  "presigned_urls": [
    {
      "part_number": 1,
      "url": "http://minio:9000/d1-data/10-AA-MF-2024-03-15/F1/10-AA-MF-2024-03-15-F1.d1f?partNumber=1&uploadId=VXBsb2FkIElE...&X-Amz-Signature=..."
    },
    {
      "part_number": 2,
      "url": "http://minio:9000/d1-data/..."
    }
  ],
  "expires_at": "2026-06-18T14:00:00Z"
}
```

The client PUTs each part to the corresponding `url`. The server returns an
`ETag` header in each part response; the client must collect these for the
complete-upload call.

### 4.2 Complete multipart upload

```
POST /api/complete-upload
Content-Type: application/json
Authorization: Bearer <WORKER_DIRECTUS_TOKEN>
```

Request body:

```json
{
  "object_key": "10-AA-MF-2024-03-15/F1/10-AA-MF-2024-03-15-F1.d1f",
  "upload_id": "VXBsb2FkIElE...",
  "parts": [
    { "part_number": 1, "etag": "\"d8e8fca2dc0f896fd7cb4cb0031ba249\"" },
    { "part_number": 2, "etag": "\"58e53d1324eef6265fdb97b08ed9aadf\"" }
  ]
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `object_key` | string | yes | Must match the key used in presign-upload. |
| `upload_id` | string | yes | The `upload_id` returned by presign-upload. |
| `parts` | array | yes | Ordered list of `{part_number, etag}` objects. ETags are the values returned by MinIO in the `ETag` response header for each part PUT. |

Response (`200 OK`):

```json
{
  "object_key": "10-AA-MF-2024-03-15/F1/10-AA-MF-2024-03-15-F1.d1f",
  "size_bytes": 12884901888,
  "etag": "\"abc123-12\""
}
```

On error the plugin returns a standard JSON error body:

```json
{
  "error": "UPLOAD_ASSEMBLY_FAILED",
  "message": "MinIO returned 400 for CompleteMultipartUpload: EntityTooSmall"
}
```

---

## 5. Webhook Endpoint

The Directus Flow calls this endpoint on every `test_sessions` item creation.

```
POST /api/webhook/session
Content-Type: application/json
```

Request body (Directus webhook payload shape):

```json
{
  "event": "items.create",
  "collection": "test_sessions",
  "key": "<session_id>",
  "payload": {
    "file_storage_pointer": "minio://d1-data/10-AA-MF-2024-03-15/F1/10-AA-MF-2024-03-15-F1.d1f",
    "status": "pending_processing",
    "sample_id": "<uuid>",
    "session_date": "2026-06-18T10:00:00Z"
  }
}
```

The plugin uses `key` as `session_id` and parses `payload.file_storage_pointer`
to derive the `object_key` (see §7).

**The webhook handler must return HTTP 202 immediately**, before any processing
begins. All processing happens asynchronously via the queue (§3). A synchronous
response ensures the Directus Flow does not time out on large files.

```
HTTP/1.1 202 Accepted
Content-Type: application/json

{ "queued": true, "session_id": "<session_id>" }
```

If the `file_storage_pointer` is absent or does not begin with `minio://`, the
handler logs a warning and returns 200 without enqueuing (the session does not
have a heavy-data file to process).

---

## 6. Write-Back API

On completion (or failure) the worker PATCHes the `test_sessions` record via
the core REST API.

```
PATCH /items/test_sessions/{session_id}
Content-Type: application/json
Authorization: Bearer <WORKER_DIRECTUS_TOKEN>
X-Actor-Identity: heavy-data-worker
```

### 6.1 Success write-back

```json
{
  "status": "processed",
  "summary_stats": {
    "n_samples": 40000000,
    "sample_rate_hz": 20000,
    "duration_s": 2000.0,
    "channels": {
      "Fx": { "mean_N": 120.4, "std_N": 8.2, "min_N": 89.1, "max_N": 154.7 },
      "Fy": { "mean_N": -3.1, "std_N": 1.4, "min_N": -7.2, "max_N": 0.8 },
      "Fz": { "mean_N": 950.2, "std_N": 22.6, "min_N": 880.0, "max_N": 1020.3 },
      "Mx": { "mean_Nm": 0.12, "std_Nm": 0.04, "min_Nm": 0.01, "max_Nm": 0.28 },
      "My": { "mean_Nm": -0.08, "std_Nm": 0.03, "min_Nm": -0.19, "max_Nm": 0.02 },
      "Mz": { "mean_Nm": 0.33, "std_Nm": 0.09, "min_Nm": 0.11, "max_Nm": 0.61 }
    }
  },
  "plot_uris": [
    "minio://d1-data/plots/10-AA-MF-2024-03-15/F1/10-AA-MF-2024-03-15-F1-forces.svg"
  ]
}
```

### 6.2 Error write-back

```json
{
  "status": "failed",
  "summary_stats": {
    "error": "D1F_HEADER_INVALID",
    "message": "Magic bytes mismatch: expected 44314f524345 got 504b0304"
  },
  "plot_uris": []
}
```

### 6.3 Status lifecycle

```
pending_processing  →  processing  →  processed  →  analysing  →  analysed
                                   ↘  failed                   ↘  failed
```

| Status | Set by | Meaning |
|---|---|---|
| `pending_processing` | Client (on session create) | File uploaded; worker not yet started. |
| `processing` | Worker (on job start) | Worker has dequeued the job and begun reading the file. |
| `processed` | Worker (on success) | Statistics and plot URI written; session is complete. |
| `analysing` | Analysis plugin (on job start) | A processed session is being analysed (e.g. `analysis-worker`'s FFT). |
| `analysed` | Analysis plugin (on success) | Analysis results written into `summary_stats`. |
| `failed` | Worker (on failure) | Processing or analysis failed; `summary_stats` contains error detail. |

`registered` is the column default for a session with no file to process. The
full set is enforced by a CHECK constraint (migration
`20260619000013_status_vocabulary.sql`) and mirrored by each plugin's
`app/lib/statuses.py`; a status outside it is rejected by the database.

The worker sets `status = processing` as its first write-back, before streaming
the file. This provides a visible signal that the job has been picked up.

---

## 7. File Storage Pointer Convention

The `file_storage_pointer` field in `test_sessions` (and `manufacturing_operations`)
follows this URI scheme:

```
minio://{bucket}/{object_key}
```

The `object_key` for D1F force files must follow the D1 naming convention:

```
{sample_code}/{pass_code}/{filename}.d1f
```

Example:

```
minio://d1-data/10-AA-MF-2024-03-15/10-AA-MF-2024-03-15-F1/10-AA-MF-2024-03-15-F1-20MPM_0.05feed_0.1DoC.d1f
```

Plot URIs generated by the worker follow:

```
minio://d1-data/plots/{sample_code}/{pass_code}/{filename}-{channel}.svg
```

The plugin must parse the URI by stripping the `minio://{bucket}/` prefix to
obtain the raw object key. The bucket name is taken from the worker's environment
(`MINIO_BUCKET`, default `d1-data`); it must not be hard-coded.

---

## 8. Summary Stats JSON Schema

The `summary_stats` column is `JSONB`. On success the worker writes an object
conforming to the following structure:

```json
{
  "n_samples": "<integer — total sample count across all channels>",
  "sample_rate_hz": "<integer — from D1F header>",
  "duration_s": "<float — n_samples / sample_rate_hz>",
  "channels": {
    "<channel_name>": {
      "mean_<unit>": "<float>",
      "std_<unit>":  "<float>",
      "min_<unit>":  "<float>",
      "max_<unit>":  "<float>"
    }
  }
}
```

Channel names and units:

| Channel | Unit suffix |
|---|---|
| `Fx` | `_N` |
| `Fy` | `_N` |
| `Fz` | `_N` |
| `Mx` | `_Nm` |
| `My` | `_Nm` |
| `Mz` | `_Nm` |

All statistical values are computed in streaming chunks; the worker must not
load the full float32 array into memory. Chunk size is determined by
`WORKER_MEMORY_LIMIT_MB` (see `docs/runbooks/heavy-data-pipeline.md` §8).

On error the `summary_stats` object contains at minimum:

```json
{
  "error": "<machine-readable code>",
  "message": "<human-readable explanation>"
}
```

---

## 9. Error Handling

- **The worker must PATCH `status = failed`** if any stage of processing fails
  (header parse error, MinIO read error, arithmetic exception, etc.). Leaving
  the session in `processing` with no write-back is not acceptable; it leaves
  the record in an indeterminate state with no recovery path.
- **The webhook must return 202 before any processing.** Synchronous processing
  inside the webhook handler is forbidden. If the Redis queue is unavailable the
  handler should return 503 with a descriptive body; the Directus Flow will retry
  according to its configured retry policy.
- **Partial uploads.** If the client aborts after `presign-upload` but before
  `complete-upload`, the multipart upload remains open in MinIO. The worker
  should not encounter this (no session is registered), but operators should
  abort stale multipart uploads periodically. There is no Makefile target for
  it yet; a MinIO lifecycle policy is the preferred long-term solution.
- **Missing file.** If the worker cannot find the object in MinIO (404), it must
  PATCH `status = failed` with `error = OBJECT_NOT_FOUND`. It must not retry
  indefinitely.

---

## 10. Adding a New Plugin

To register a new plugin against the D1-Database core:

1. **Provision a machine user.** Create a Directus user with the Operator role
   and a static token. Follow `docs/api-contract.md` §13.3. Use the email
   convention `<plugin-name>@d1-internal.local`.

2. **Set the environment variable.** Add `WORKER_DIRECTUS_TOKEN=<token>` to the
   plugin container's environment (via `.env` or Docker Compose `environment:`
   block). Never commit the token to source control.

3. **Configure the Directus Flow.** In Directus: Flows → Create Flow →
   Trigger: Event Hook → Collection: `test_sessions` → Action: Create →
   Operation: Webhook/Request → URL:
   `http://<plugin-container-name>:8080/api/webhook/session` → Method: POST →
   Body: Include Payload. See `docs/runbooks/heavy-data-pipeline.md` §3 for the
   step-by-step walkthrough.

4. **Expose a `/health` endpoint.** The plugin must respond to
   `GET /health` with HTTP 200 and `{ "status": "ok" }`. This is used by
   Docker Compose readiness checks and monitoring tooling.

5. **Implement all endpoints in §4 and §5.** The core does not care about
   implementation language; it cares about the HTTP contract.

6. **Validate write-back.** After deployment, create a test session with a known
   `.d1f` file and confirm that `status` transitions to `processed` and
   `summary_stats` is populated. Use `make phase4-test` for the integration
   harness.
