# Runbook — Heavy-Data Pipeline (Phase 4)

**System:** D1-Database
**Scope:** Direct-to-MinIO file upload, Redis queue, heavy-data worker
**Tested against:** Phase 4 stack (docker compose)

---

## 1. Prerequisites

Before bringing up the heavy-data pipeline, confirm the following:

- Docker and Docker Compose installed and running.
- Full stack is up:

  ```bash
  make up
  ```

- MinIO is bootstrapped (bucket `d1-data` exists):

  ```bash
  make bootstrap-minio
  ```

- Phase 3 has been applied (Directus running, schema migrated, Operator machine
  user provisioned via `core/apply.sh`):

  ```bash
  bash core/apply.sh
  ```

  The script prints the `WORKER_DIRECTUS_TOKEN` value once at creation time.
  Copy it before the terminal session ends.

---

## 2. First-Time Setup

### 2.1 Set the worker token in .env

Add the token printed by `core/apply.sh` to `.env`:

```bash
WORKER_DIRECTUS_TOKEN=<paste-token-here>
```

Do not commit this value to source control. The `.env` file is listed in
`.gitignore`.

### 2.2 Bring up the worker container

```bash
docker compose up heavy-data-worker -d
```

Verify it is healthy:

```bash
docker compose ps heavy-data-worker
```

The `STATUS` column should read `healthy`. The container exposes a health
endpoint at `GET http://localhost:8080/health`; Docker Compose checks this
automatically via the `healthcheck` block in `compose.yaml`.

### 2.3 Verify the queue is connected

```bash
docker compose exec heavy-data-worker rq info --url redis://redis:6379
```

Expected output includes a `heavy-data` queue with 0 queued and 0 failed jobs
on a fresh deployment.

---

## 3. Configuring the Directus Flow

The Directus Flow fires whenever a `test_sessions` record is created and POSTs
to the worker webhook. Configure it once after Directus first starts.

1. Open the Directus admin UI (default: `http://localhost:8055`) and log in as
   an Administrator.

2. Navigate to **Settings → Flows → Create Flow**.

3. In the flow creation dialog:
   - **Name:** `heavy-data-session-webhook`
   - **Status:** Active
   - **Trigger:** Event Hook
   - **Scope:** items
   - **Collections:** `test_sessions`
   - **Event:** Create

4. Click **Save** to save the trigger, then add the first (and only) operation:
   - Click the **+** node on the trigger.
   - **Operation type:** Webhook / Request URL
   - **Name:** `notify_worker`
   - **Method:** POST
   - **URL:** `http://heavy-data-worker:8080/api/webhook/session`
   - **Request Body:** Enable "Include Payload" (this sends the full item
     payload, including `file_storage_pointer`, in the POST body).
   - Leave headers at defaults (Content-Type: application/json is set
     automatically).

5. Click **Save** on the operation, then **Save** the flow.

6. Verify the flow is active: its row in the Flows list should show a green
   status indicator.

> The worker URL uses the Docker Compose service name `heavy-data-worker` and
> is only reachable within the `d1net` Docker network. It is not exposed to the
> host machine directly.

---

## 4. Uploading a File (Python Client Example)

The upload process has four steps: presign, upload parts, complete, register.

```python
import os
import math
import requests

WORKER_URL = "http://localhost:8080"
DIRECTUS_URL = "http://localhost:8055"
TOKEN = os.environ["WORKER_DIRECTUS_TOKEN"]

file_path = "/data/10-AA-MF-2024-03-15-F1.d1f"
object_key = "10-AA-MF-2024-03-15/10-AA-MF-2024-03-15-F1/10-AA-MF-2024-03-15-F1.d1f"
sample_id = "<uuid of physical_samples record>"

# Step 1 — presign
PART_SIZE = 64 * 1024 * 1024  # 64 MB per part
file_size = os.path.getsize(file_path)
n_parts = math.ceil(file_size / PART_SIZE)

resp = requests.post(
    f"{WORKER_URL}/api/presign-upload",
    json={
        "object_key": object_key,
        "n_parts": n_parts,
        "content_type": "application/octet-stream",
    },
    headers={"Authorization": f"Bearer {TOKEN}"},
)
resp.raise_for_status()
presign = resp.json()
upload_id = presign["upload_id"]
presigned_urls = {p["part_number"]: p["url"] for p in presign["presigned_urls"]}

# Step 2 — upload parts directly to MinIO
parts = []
with open(file_path, "rb") as fh:
    for part_number in range(1, n_parts + 1):
        chunk = fh.read(PART_SIZE)
        put_resp = requests.put(presigned_urls[part_number], data=chunk)
        put_resp.raise_for_status()
        etag = put_resp.headers["ETag"]
        parts.append({"part_number": part_number, "etag": etag})
        print(f"  uploaded part {part_number}/{n_parts}")

# Step 3 — complete the multipart upload
resp = requests.post(
    f"{WORKER_URL}/api/complete-upload",
    json={"object_key": object_key, "upload_id": upload_id, "parts": parts},
    headers={"Authorization": f"Bearer {TOKEN}"},
)
resp.raise_for_status()
print("upload complete:", resp.json()["size_bytes"], "bytes")

# Step 4 — register the session in Directus
resp = requests.post(
    f"{DIRECTUS_URL}/items/test_sessions",
    json={
        "sample_id": sample_id,
        "session_date": "2026-06-18T10:00:00Z",
        "operator_name": "J. Smith",
        "test_type": "force_sensor",
        "file_storage_pointer": f"minio://d1-data/{object_key}",
        "status": "pending_processing",
    },
    headers={"Authorization": f"Bearer {TOKEN}"},
)
resp.raise_for_status()
session_id = resp.json()["data"]["session_id"]
print("session registered:", session_id)
```

After step 4, the Directus Flow fires automatically and the worker picks up the
job. Poll `GET /items/test_sessions/{session_id}?fields=status,summary_stats`
until `status` is `processed` or `failed`.

---

## 5. Monitoring

### Live worker logs

```bash
docker compose logs -f heavy-data-worker
```

Log lines include the job ID, session ID, and timing for each processing stage.

### Redis queue status

```bash
docker compose exec heavy-data-worker rq info --url redis://redis:6379
```

Output shows:

- Queued jobs (waiting to be picked up).
- Failed jobs (examine with `rq failed-queue` for tracebacks).
- Workers connected to the `heavy-data` queue.

### Inspect a failed job

```bash
docker compose exec heavy-data-worker rq failed-queue --url redis://redis:6379 dump
```

### Check session status via the API

```bash
curl -sf \
  -H "Authorization: Bearer $WORKER_DIRECTUS_TOKEN" \
  "$DIRECTUS_URL/items/test_sessions?filter[status][_eq]=error&fields=session_id,summary_stats" \
  | jq .
```

---

## 6. Testing the Pipeline

### Integration test (full pipeline)

```bash
make phase4-test
```

This spins up the full stack, uploads a synthetic `.d1f` file, registers a
session, and asserts that the session reaches `status = processed` with a valid
`summary_stats` object within 60 seconds.

### Unit tests (worker only)

```bash
make worker-test
```

This runs the Python unit tests inside the worker container. Tests cover: D1F
header parsing, streaming statistics computation, plot generation with strided
read, and write-back formatting. No MinIO or Redis connection is required.

---

## 7. Troubleshooting

### MinIO bucket missing

**Symptom:** Worker log shows `NoSuchBucket` or `S3Error: 404`. The presign or
complete-upload call also returns an error.

**Fix:** Run `make bootstrap-minio`. This creates the `d1-data` bucket and
applies the default lifecycle policy.

---

### WORKER_DIRECTUS_TOKEN not set

**Symptom:** Worker starts but write-back calls return `401 Unauthorized`. The
worker log shows `Authorization header missing or invalid`.

**Fix:**

1. Confirm the variable is in `.env`:

   ```bash
   grep WORKER_DIRECTUS_TOKEN .env
   ```

2. Restart the worker so it picks up the new environment:

   ```bash
   docker compose up heavy-data-worker -d --force-recreate
   ```

3. If the token was lost, issue a new one via the Directus API (Administrator
   credentials required):

   ```bash
   NEW_TOKEN=$(openssl rand -hex 32)
   curl -sf -X PATCH "$DIRECTUS_URL/users/<worker-user-id>" \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d "{\"token\": \"$NEW_TOKEN\"}"
   echo "New token: $NEW_TOKEN"
   ```

   Then update `.env` with the new value and restart the container.

---

### Job consumed memory beyond limit (OOM kill)

**Symptom:** Worker container restarts unexpectedly. `docker compose logs
heavy-data-worker` shows `Killed` or the rq job lands in the failed queue with
a `MemoryError` or no traceback at all (OOM kill produces no Python traceback).

**Fix:**

1. Check current memory limit:

   ```bash
   grep WORKER_MEMORY_LIMIT_MB .env
   ```

2. Increase the limit (see §8) and restart. If the file is genuinely larger
   than the worker can handle at any limit, verify that the streaming chunk
   logic is functioning correctly (`make worker-test` runs this path).

---

### Directus Flow not firing

**Symptom:** Sessions are created with `status = pending_processing` but the
worker never receives a webhook and the status never changes.

**Fix:**

1. Open Directus admin → Settings → Flows and confirm the
   `heavy-data-session-webhook` flow is active (green indicator).
2. Check the flow logs in Directus (Settings → Flows → click the flow →
   Activity tab) for failed webhook deliveries.
3. Confirm the worker is reachable from within the Docker network:

   ```bash
   docker compose exec directus curl -sf http://heavy-data-worker:8080/health
   ```

   Expected: `{"status":"ok"}`. If unreachable, check that `heavy-data-worker`
   is on the `d1net` network in `compose.yaml`.

---

### Job stuck in processing status

**Symptom:** A session has `status = processing` but no further updates arrive
and the worker log shows no recent activity for that session.

**Likely causes:** Worker container was restarted mid-job (rq does not
automatically re-enqueue jobs interrupted by a crash). The session is now
orphaned.

**Fix:** Manually re-enqueue the job:

```bash
docker compose exec heavy-data-worker python - <<'EOF'
import os
from redis import Redis
from rq import Queue

r = Redis.from_url("redis://redis:6379")
q = Queue("heavy-data", connection=r)
q.enqueue(
    "worker.process_session",
    session_id="<session_id>",
    object_key="<object_key>",
    collection="test_sessions",
)
print("enqueued")
EOF
```

---

## 8. Memory Ceiling

The worker streams `.d1f` files in fixed-size chunks rather than loading the
full float32 array. The chunk size is derived from `WORKER_MEMORY_LIMIT_MB`:

```
chunk_rows = floor((WORKER_MEMORY_LIMIT_MB * 1024 * 1024) / (6 channels * 4 bytes per float32))
```

**Default:** `WORKER_MEMORY_LIMIT_MB=256`

At 256 MB this yields approximately 11.2 million rows per chunk. A 50 GB file
with 20 kHz sampling (~2.78 billion rows of 6 float32 values) is processed in
roughly 249 chunks with no single allocation exceeding the ceiling.

The SVG plot is generated via a strided read: the worker reads at most
10 000 evenly spaced row indices from the file using `numpy` memory-mapped
access with an explicit stride, then discards the mapping. This adds negligible
memory overhead regardless of file size.

**To tune the ceiling:**

1. Edit `.env`:

   ```
   WORKER_MEMORY_LIMIT_MB=512
   ```

2. Restart the worker:

   ```bash
   docker compose up heavy-data-worker -d --force-recreate
   ```

Setting the ceiling above the Docker memory limit configured in `compose.yaml`
is counterproductive; the container will OOM-kill before the Python limit
applies. Ensure the `mem_limit` in `compose.yaml` is at least
`WORKER_MEMORY_LIMIT_MB + 128` MB to allow for Python interpreter and rq
overhead.
