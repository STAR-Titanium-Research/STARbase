# Plugin Template — Authoring Guide

This document explains how to create a new D1-Database plugin using
`plugins/plugin-template/` as the starting point.

---

## 1. What this template is

The template is a fully working, CI-tested scaffold for a D1-Database plugin
container. It honours every requirement in `docs/plugin-contract.md` before
any job logic is written: the health endpoint is present, the webhook handler
returns 202 immediately, the error write-back fires on any uncaught exception,
and the environment variable wiring is correct.

**Copy this template** when you need a new plugin that receives Directus Flow
webhooks, processes data from MinIO, and writes results back to the core via
the Directus REST API.

**Extend the existing `plugins/heavy-data-worker/`** only if you need to add
an endpoint or processing mode to the D1F force-file pipeline. If your job
operates on different data, a different collection, or a different algorithm
entirely, start from this template.

---

## 2. Scaffold contents

```
plugins/plugin-template/
  Dockerfile                    # Python 3.12-slim image; builds + runs tests
  requirements.txt              # Baseline dependencies; add job-specific ones below the marker
  entrypoint.sh                 # Starts gunicorn + rq worker; handles SIGTERM/SIGINT
  app/
    __init__.py                 # Empty; marks app as a Python package
    webhook.py                  # Flask app: GET /health, POST /api/webhook/session
    jobs/
      __init__.py               # Empty
      example_job.py            # The job function to adapt; delete and replace with your logic
    lib/
      __init__.py               # Empty
      directus_client.py        # patch_item / get_item write-back + read helpers
      minio_client.py           # boto3 wrapper: download_file + put_object
      security.py               # webhook shared-secret auth + object_key validation
      statuses.py               # canonical test_sessions.status vocabulary
  tests/
    __init__.py                 # Empty
    conftest.py                 # Pytest fixtures (Flask test client, env var defaults)
    test_example.py             # Smoke tests: /health + the example job write-back
```

### File-by-file notes

**`Dockerfile`**
Builds a `python:3.12-slim` image, installs `requirements.txt`, copies
`app/` and `tests/`, and declares the `HEALTHCHECK` against `GET /health`.
The `CMD` is `./entrypoint.sh`. Do not modify the `HEALTHCHECK` line; it is
required by Docker Compose for readiness signalling.

**`requirements.txt`**
Pins the baseline runtime: Flask, gunicorn, redis, rq, boto3, requests,
pytest. Add your job-specific dependencies (e.g., `numpy`, `scipy`) below the
`# --- job-specific ---` comment marker so they are easy to identify during
template updates.

**`entrypoint.sh`**
Starts gunicorn bound to `0.0.0.0:${WORKER_HTTP_PORT:-8080}` and an rq
worker pointing at `${REDIS_URL:-redis://${REDIS_HOST:-redis}:${REDIS_PORT:-6379}}`. Both
processes run in the background; a `trap` catches `TERM` and `INT` and kills
both before the container exits. The script then does `wait -n`: if either process dies the other is stopped and the container exits non-zero (so a crashed rq worker cannot leave `/health` green). The only line you must change is the rq queue
name (see step 3 below).

**`app/webhook.py`**
Declares the Flask application. `app.before_request(check_secret)` enforces the
shared-secret header on every endpoint except `GET /health`. `GET /health`
returns `{"status": "ok"}` with HTTP 200. `POST /api/webhook/session` extracts
`session_id` and `object_key` from the Directus webhook payload, validates the
key, enqueues your job function, and returns HTTP 202. A session with no
`file_storage_pointer` (or one into another store) is answered `200 {"status": "skipped"}`
without enqueueing, so a Flow that fires on every create logs no failures. The queue name is read
from the `QUEUE_NAME` env var (default `plugin`); import your job function in
place of `example_job`.

**`app/jobs/example_job.py`**
Contains a single function `example_job(session_id, object_key)` with the
required error-handling envelope (use the status constants from
`app.lib.statuses`):

```python
from app.lib.statuses import STATUS_FAILED, STATUS_PROCESSED, STATUS_PROCESSING


def example_job(session_id: str, object_key: str) -> None:
    _mark(session_id, STATUS_PROCESSING)
    try:
        # --- your logic here ---
        directus_client.patch_item(
            "test_sessions",
            session_id,
            {"status": STATUS_PROCESSED, "summary_stats": result},
        )
    except Exception:
        _mark(session_id, STATUS_FAILED)
        raise
```

Delete this file and create `app/jobs/<your_job>.py` with the same envelope.
Do not remove the `except` block or the re-raise; both are required by the
contract (`docs/plugin-contract.md` §9). Emit only statuses from
`app.lib.statuses.ALLOWED_STATUSES` — they mirror the DB CHECK constraint.

**`app/lib/directus_client.py`**
Wraps `PATCH /items/{collection}/{id}` (`patch_item`) and
`GET /items/{collection}/{id}` (`get_item`) with the `Authorization: Bearer
<WORKER_DIRECTUS_TOKEN>` header. Use `get_item` for read-merge-write when
several plugins share a JSONB column (e.g. `test_sessions.summary_stats`) so
you don't clobber another plugin's contribution. Copy verbatim.

**`app/lib/minio_client.py`**
Minimal boto3 wrapper providing `download_file` and `put_object`. Both read
their configuration from environment variables at call time (no module-level
connection). If your plugin needs presigned multipart upload, copy those
helpers from `plugins/heavy-data-worker/app/lib/minio_client.py`.

**`app/lib/security.py`**
Provides `check_secret` (a Flask `before_request` hook enforcing the
`X-Worker-Secret` header against `WORKER_WEBHOOK_SECRET`) and
`valid_object_key` (rejects path traversal and unsafe characters). Copy
verbatim and keep `app.before_request(check_secret)` wired in `webhook.py`.

**`app/lib/statuses.py`**
The canonical `test_sessions.status` vocabulary, mirroring the DB CHECK
constraint in `db/migrations/...status_vocabulary.sql`. Import the status
constants from here rather than hard-coding strings.

**`tests/`**
`conftest.py` sets the required environment variables to safe test defaults
before importing the Flask app, so pytest does not require a running stack.
`test_health.py` verifies the health endpoint. Add your job unit tests here;
mock `directus_client` and `minio_client` at the module level using
`unittest.mock.patch`.

---

## 3. Step-by-step: creating a new plugin

### Step 1 — Copy the template

```bash
cp -r plugins/plugin-template plugins/your-plugin-name
```

Choose a name that matches the Docker Compose service name you will add
(e.g., `analysis-worker`, `equipment-bridge`). Hyphens are preferred over
underscores for service names; underscores are preferred for Python package
names. The directory name becomes the Docker Compose service name.

### Step 2 — Set the rq queue name

The queue name identifies this plugin's job stream in Redis. It must be
unique across all plugins in the stack.

Both `entrypoint.sh` and `app/webhook.py` read the queue name from the
`QUEUE_NAME` environment variable (default `plugin`), so you do **not** edit
code — set it once in the Docker Compose `environment:` block:

```yaml
    environment:
      QUEUE_NAME: your-plugin-name
```

`entrypoint.sh` uses `"${QUEUE_NAME:-plugin}"` and `webhook.py` uses
`os.getenv("QUEUE_NAME", "plugin")`; they will always agree. Keeping the
service name, queue name, and directory name consistent makes operations
easier.

### Step 3 — Implement your job logic

Delete `app/jobs/example_job.py`. Create `app/jobs/your_job.py` with a
function that follows the error-handling envelope shown in section 2.

Update the import and `enqueue` call in `app/webhook.py`:

```python
from app.jobs.your_job import process  # replace example_job import

# in webhook_session():
job = _queue.enqueue(process, session_id, object_key)
```

Add any job-specific dependencies to `requirements.txt` below the
`# --- job-specific ---` marker.

### Step 4 — Build and test locally

```bash
make worker-build PLUGIN=your-plugin-name
make worker-test  PLUGIN=your-plugin-name
```

If the Makefile does not yet have `PLUGIN`-parameterised targets, run the
equivalent Docker commands directly:

```bash
docker build -t d1-your-plugin-name plugins/your-plugin-name/
docker run --rm d1-your-plugin-name python -m pytest tests/ -v --tb=short
```

### Step 5 — Add the service to docker-compose.yml and CI

See sections 6 and 7 below.

---

## 4. Environment variables

Every plugin container must receive the following environment variables. All
are read at runtime from the container environment; none may be hard-coded.

| Variable | Required | Default | Description |
|---|---|---|---|
| `REDIS_URL` | no | — | Full Redis URL including the password (`redis://:<pw>@redis:6379/0`). Preferred by the webhook and by `rq worker --url` when set. |
| `REDIS_HOST` | yes | `redis` | Fallback when `REDIS_URL` is unset: hostname of the Redis service inside the Docker network. |
| `REDIS_PORT` | yes | `6379` | Fallback when `REDIS_URL` is unset: Redis TCP port. |
| `MINIO_ENDPOINT` | yes | `http://minio:9000` | Full URL of the MinIO service. |
| `MINIO_ROOT_USER` | yes | — | MinIO access key (S3 `aws_access_key_id`). |
| `MINIO_ROOT_PASSWORD` | yes | — | MinIO secret key (S3 `aws_secret_access_key`). |
| `MINIO_BUCKET` | yes | `d1-files` | Bucket name for data files and output artefacts. |
| `DIRECTUS_URL` | yes | `http://directus:8055` | Base URL of the Directus instance. |
| `WORKER_DIRECTUS_TOKEN` | yes | — | Static Bearer token for the plugin's machine user. Never commit this value. |
| `WORKER_HTTP_PORT` | no | `8080` | Port gunicorn binds to inside the container. Must match the Dockerfile `EXPOSE` and the `healthcheck` URL. |
| `WORKER_MEMORY_LIMIT_MB` | no | `256` | Soft memory ceiling for streaming reads. Job code should respect this when sizing read buffers. |
| `WORKER_WEBHOOK_SECRET` | yes | — | Shared secret required in the `X-Worker-Secret` header on webhook POSTs. **Fails closed:** if unset or empty, every request except `GET /health` is rejected with 503. The Directus Flow must send the same value. |
| `QUEUE_NAME` | no | `plugin` | rq queue name for this plugin's job stream. Set to a value unique across the stack. |
| `JOB_TIMEOUT_SECONDS` | no | `21600` | rq `job_timeout` passed to `enqueue` (default 6 h; rq's own default of 180 s would kill real jobs). Rows left in a non-terminal status by a killed job must be marked `failed` (contract section 9); see the reaper in `plugins/heavy-data-worker/app/reaper.py` for a reference implementation. |

Set all required variables in your `.env` file (copied from `.env.example`)
or in the Docker Compose `environment:` block. The `WORKER_DIRECTUS_TOKEN`
value is printed once by `bash core/apply.sh` when the machine user is
created; store it immediately.

---

## 5. Directus Flow configuration

Once the plugin container is running, a Directus Flow must be configured to
call it. The step-by-step walkthrough — including screenshots, retry settings,
and verification steps — is in `docs/runbooks/heavy-data-pipeline.md` §3.

The Flow parameters specific to your plugin are:

- **Trigger:** Event Hook — Collection: `test_sessions` — Action: Create
- **Operation:** Webhook/Request
  - URL: `http://<your-plugin-name>:8080/api/webhook/session`
  - Method: POST
  - Header: `X-Worker-Secret: {{$env.WORKER_WEBHOOK_SECRET}}` (required; the
    worker answers 401/503 without it)
  - Body: Include Payload (full body)

Replace `<your-plugin-name>` with the Docker Compose service name you chose in
step 1. This hostname is resolvable only within the `d1net` Docker network; it
is not exposed to the public internet.

---

## 6. docker-compose.yml service block

Add the following service block to `docker-compose.yml`. Replace every
occurrence of `your-plugin-name` with your chosen service name and adjust
the `image` tag and host port as needed.

```yaml
  your-plugin-name:
    build:
      context: plugins/your-plugin-name
      dockerfile: Dockerfile
    restart: unless-stopped
    depends_on:
      redis:
        condition: service_healthy
      minio:
        condition: service_healthy
    environment:
      REDIS_URL: redis://:${REDIS_PASSWORD:?Set REDIS_PASSWORD in .env}@redis:6379/0
      REDIS_HOST: redis
      REDIS_PORT: 6379
      MINIO_ENDPOINT: http://minio:9000
      MINIO_ROOT_USER: ${MINIO_ROOT_USER:-minioadmin}
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD:?Set MINIO_ROOT_PASSWORD in .env}
      MINIO_BUCKET: ${MINIO_BUCKET:-d1-files}
      DIRECTUS_URL: http://directus:8055
      WORKER_DIRECTUS_TOKEN: ${YOUR_PLUGIN_DIRECTUS_TOKEN:-}
      WORKER_MEMORY_LIMIT_MB: ${WORKER_MEMORY_LIMIT_MB:-256}
      WORKER_HTTP_PORT: "8080"
      WORKER_WEBHOOK_SECRET: ${WORKER_WEBHOOK_SECRET:?Set WORKER_WEBHOOK_SECRET in .env}
    ports:
      - "${D1_BIND_ADDR:-127.0.0.1}:${YOUR_PLUGIN_HTTP_PORT:-8081}:8080"
    healthcheck:
      test:
        - "CMD"
        - "python"
        - "-c"
        - "import urllib.request; urllib.request.urlopen('http://localhost:8080/health')"
      interval: 15s
      timeout: 5s
      retries: 5
      start_period: 30s
```

Notes:

- Use a different host-side port (e.g., `8081`, `8082`) for each plugin so
  they do not conflict on the host. The container-side port is always `8080`.
- Always bind the published port to `${D1_BIND_ADDR:-127.0.0.1}:` (loopback unless the operator
  sets it) and keep the secrets `${VAR:?}`-required, as the other services do: a default such as
  `:-change_me_too` is a password that works when nobody set one. Every request except
  `GET /health` must carry `X-Worker-Secret` (the template's `check_secret` enforces it).
- Name the token variable `${YOUR_PLUGIN_DIRECTUS_TOKEN:-}` (matching the
  service name) so multiple plugins can each have their own machine token in
  `.env` without colliding.
- `depends_on` uses `condition: service_healthy` for both `redis` and `minio`.
  Do not use the bare `depends_on: [redis, minio]` form; it does not wait for
  the services to be ready.

---

## 7. CI integration

### Makefile targets

The `worker-build` and `worker-test` targets in the root `Makefile` build and
test `plugins/heavy-data-worker/`. Add equivalent targets for your plugin by
copying that pattern:

```makefile
your-plugin-build: ## Build the your-plugin-name Docker image
	docker build -t d1-your-plugin-name plugins/your-plugin-name/

your-plugin-test: your-plugin-build ## Run your-plugin-name unit tests inside Docker
	docker run --rm d1-your-plugin-name \
		python -m pytest tests/ -v --tb=short
```

Add both target names to the `.PHONY` declaration at the top of the Makefile.

### GitHub Actions job

Add a job to `.github/workflows/ci.yml` by copying the existing
`worker-build` job and updating the plugin path and image tag:

```yaml
  your-plugin-build:
    name: your-plugin-name (docker build + unit tests)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Build plugin image
        run: docker build -t d1-your-plugin-name plugins/your-plugin-name/
      - name: Run unit tests
        run: |
          docker run --rm d1-your-plugin-name \
            python -m pytest tests/ -v --tb=short
```

This job runs on every push to `main` and on every pull request, independently
of the other jobs. It requires no external services (Redis, MinIO, Directus)
because unit tests mock those dependencies.
