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
docker compose exec heavy-data-worker sh -c 'rq info --url "$REDIS_URL"'
```

Expected output includes a `heavy-data` queue with 0 queued and 0 failed jobs
on a fresh deployment.

---

## 3. Configuring the Directus Flows

**Required on every install, new or existing.** Two Flows call the workers, and both must send
the `X-Worker-Secret` header: the workers reject every request without it (401, or 503 if the
worker itself has no secret). On a new install create them once after Directus first starts. On
an existing install that predates the 2026-10 hardening, add the header to the Flows you
already have; see [`upgrade-2026-10-hardening.md`](./upgrade-2026-10-hardening.md).

Both Flows fire whenever a `test_sessions` record is created, and both POST the item to a
worker webhook. They are independent: the heavy-data worker computes statistics and plots
(`processed`), the analysis worker computes the FFT metrics (`analysed`). Directus resolves
`{{$env.WORKER_WEBHOOK_SECRET}}` only because compose sets
`FLOWS_ENV_ALLOW_LIST=WORKER_WEBHOOK_SECRET`.

### 3.1 Heavy-data Flow (`heavy-data-session-webhook`)

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
   - **Headers:** add `X-Worker-Secret` with the value
     `{{$env.WORKER_WEBHOOK_SECRET}}`. Content-Type: application/json
     is set automatically.

5. Click **Save** on the operation, then **Save** the flow.

6. Verify the flow is active: its row in the Flows list should show a green
   status indicator.

### 3.2 Analysis Flow (`analysis-session-webhook`)

Same steps as 3.1, with these differences:

- **Name:** `analysis-session-webhook`
- **URL:** `http://analysis-worker:8081/api/webhook/session`
- **Headers:** the same `X-Worker-Secret: {{$env.WORKER_WEBHOOK_SECRET}}`

The analysis worker reads the same `file_storage_pointer` from the payload, enqueues on its own
`analysis` queue and sets `analysing`, then `analysed`. It never regresses a better status
(a late `processed` does not overwrite `analysed`). A session with no file pointer is skipped
with HTTP 200 by both workers, so a Flow that fires on every create does not log failures.

> The worker URLs use the Docker Compose service names and are only reachable within the
> `d1net` Docker network. The host ports (8080, 8081) are bound to `D1_BIND_ADDR` and are for
> health checks and tests.

---

## 4. Uploading a File (Python Client Example)

The upload process has four steps: presign, upload parts, complete, register. The worker's
`/api/*` endpoints authenticate with `X-Worker-Secret` (the value of `WORKER_WEBHOOK_SECRET`);
only the Directus call in step 4 uses the Directus token.

```python
import os

import requests

BIND = os.environ.get("D1_BIND_ADDR", "127.0.0.1")
WORKER_URL = f"http://{BIND}:8080"
DIRECTUS_URL = f"http://{BIND}:8055"
TOKEN = os.environ["WORKER_DIRECTUS_TOKEN"]
WORKER_HEADERS = {"X-Worker-Secret": os.environ["WORKER_WEBHOOK_SECRET"]}

file_path = "/data/10-AA-MF-2024-03-15-F1.d1f"
object_key = "10-AA-MF-2024-03-15/10-AA-MF-2024-03-15-F1/10-AA-MF-2024-03-15-F1.d1f"
sample_id = "<uuid of physical_samples record>"

# Step 1 - presign. The worker decides the part size (UPLOAD_PART_SIZE_BYTES, default 100 MiB)
# and returns one presigned URL per part.
file_size = os.path.getsize(file_path)
resp = requests.post(
    f"{WORKER_URL}/api/presign-upload",
    json={
        "object_key": object_key,
        "file_size_bytes": file_size,
        "content_type": "application/octet-stream",
    },
    headers=WORKER_HEADERS,
)
resp.raise_for_status()
presign = resp.json()
upload_id = presign["upload_id"]
part_urls = {p["part_number"]: p["url"] for p in presign["parts"]}
# Each part but the last is exactly the worker's part size; read the same size from the file.
PART_SIZE = int(os.environ.get("UPLOAD_PART_SIZE_BYTES", 100 * 1024 * 1024))

# Step 2 - upload the parts straight to MinIO. The presigned URLs name the compose host
# `minio:9000`, which a client outside the Docker network cannot resolve; send the request to the
# published port and keep `minio:9000` as the Host header (the signature covers it).
parts = []
with open(file_path, "rb") as fh:
    for part_number in sorted(part_urls):
        chunk = fh.read(PART_SIZE)
        url = part_urls[part_number].replace("http://minio:9000", f"http://{BIND}:9000")
        put_resp = requests.put(url, data=chunk, headers={"Host": "minio:9000"})
        put_resp.raise_for_status()
        parts.append({"PartNumber": part_number, "ETag": put_resp.headers["ETag"]})
        print(f"  uploaded part {part_number}/{len(part_urls)}")

# Step 3 - complete the multipart upload. Parts use the S3 field names PartNumber / ETag.
resp = requests.post(
    f"{WORKER_URL}/api/complete-upload",
    json={"object_key": object_key, "upload_id": upload_id, "parts": parts},
    headers=WORKER_HEADERS,
)
resp.raise_for_status()
pointer = resp.json()["file_storage_pointer"]  # minio://<bucket>/<object_key>
print("upload complete:", pointer)

# Step 4 - register the session in Directus
resp = requests.post(
    f"{DIRECTUS_URL}/items/test_sessions",
    json={
        "sample_id": sample_id,
        "session_date": "2026-06-18T10:00:00Z",
        "operator_name": "J. Smith",
        "test_type": "force_sensor",
        "file_storage_pointer": pointer,
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
docker compose exec heavy-data-worker sh -c 'rq info --url "$REDIS_URL"'
```

Output shows:

- Queued jobs (waiting to be picked up).
- Failed jobs (see "Inspect a failed job" below for tracebacks).
- Workers connected to the `heavy-data` queue.

### Inspect a failed job

```bash
docker compose exec heavy-data-worker python - <<'PY'
import os
from redis import Redis
from rq import Queue
from rq.job import Job

r = Redis.from_url(os.environ["REDIS_URL"])
for job_id in Queue("heavy-data", connection=r).failed_job_registry.get_job_ids():
    job = Job.fetch(job_id, connection=r)
    result = job.latest_result()
    print(job_id, job.args)
    print(result.exc_string if result else "(no traceback)")
PY
```

### Check session status via the API

```bash
curl -sf \
  -H "Authorization: Bearer $WORKER_DIRECTUS_TOKEN" \
  "$DIRECTUS_URL/items/test_sessions?filter[status][_eq]=failed&fields=session_id,summary_stats" \
  | jq .
```

---

## 6. Testing the Pipeline

### Integration test (full pipeline)

```bash
set -a; . ./.env; set +a          # WORKER_WEBHOOK_SECRET (required), D1_BIND_ADDR
MACHINE_TOKEN=<Operator token from core/apply.sh> make phase4-test
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

r = Redis.from_url(os.environ["REDIS_URL"])
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
