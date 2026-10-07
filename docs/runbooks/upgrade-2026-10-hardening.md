# Runbook: Upgrading an existing deployment to the 2026-10 hardening

**System:** D1-Database
**Scope:** an already-running compose stack (data in `pgdata`, `minio-data`, `directus-uploads`)
**Applies to:** the review-fix batch of 2026-10-03 (migrations `…000118` to `…000132`)

A fresh install needs none of this: follow the quick start in [`infra/README.md`](../../infra/README.md).
An existing install **will break** if you only `git pull` and `docker compose up`. Work through
the steps below in order. Budget about 30 minutes and a short window with no one recording or
uploading.

What changed, in one paragraph: compose now binds every published port to `127.0.0.1` (or
`D1_BIND_ADDR`), refuses to start without its secrets (`${VAR:?}`), protects Redis with a
password, and lets Directus Flows read `WORKER_WEBHOOK_SECRET`. The heavy-data and analysis
workers and the text-to-SQL API reject every request without the `X-Worker-Secret` header. The
text-to-SQL role is an allow-list (`d1_llm_app`, created `NOLOGIN` by migration 132). Four
Directus hooks (`box-intake`, `owner-cascade`, `d1-operation-sequence`, `d1-apply-prep-recipe`)
were replaced by database triggers (migrations 124, 125, 126, 127, 129). The recorder refuses
non-loopback `Host` and `Origin` headers.

---

## 1. Back up first

```bash
make backup
ls -l backups/ | tail -4
```

`make backup` now also writes `d1globals_<ts>.sql.gz` (roles and password hashes). If your
checkout is still the **old** one, the script only dumps the database, so add the roles dump
by hand:

```bash
umask 077
docker compose exec -T postgres pg_dumpall -U d1 --globals-only | gzip > backups/d1globals_pre-upgrade.sql.gz
gzip -t backups/d1globals_pre-upgrade.sql.gz && echo OK
```

The Directus uploads volume is not in these dumps (see `backup-restore.md`).

## 2. Edit `.env`

Do this **before** `git pull`, while the old stack is still running, so you can read the values
it uses. Back the file up first: `cp .env .env.pre-upgrade`.

Compose now refuses **every** command, even `down`, `ps` and `logs`, until all required
variables are set (`Set X in .env`). That is the intended behaviour, not a bug.

### 2a. New variables (generate fresh values)

```bash
echo "REDIS_PASSWORD=$(openssl rand -hex 32)"
echo "WORKER_WEBHOOK_SECRET=$(openssl rand -hex 32)"
```

Add both lines to `.env`. Add `D1_BIND_ADDR`:

- Keep **`D1_BIND_ADDR=127.0.0.1`** (the default) if Tailscale Serve on the host forwards to
  `localhost`. Check with `tailscale serve status`: a target of `http://127.0.0.1:80` (or any
  `localhost` target) means keep the default.
- Set it to the tailnet IP (`tailscale ip -4`) only if clients reach the ports directly. The
  stack then fails at boot if Tailscale is not up yet, and a `localhost` Serve target stops
  working. Never `0.0.0.0`.

### 2b. Secrets the running system already uses (do not generate new ones)

These were optional with insecure defaults before. Use the value the running containers have.
If you never set one in `.env`, the old default is in the second column.

| Variable | Old default | Effect of changing it |
|---|---|---|
| `POSTGRES_PASSWORD` | `change_me` | Postgres reads it only at first init; changing `.env` alone breaks Directus and every DSN (see below) |
| `MINIO_ROOT_PASSWORD` | `change_me_too` | MinIO re-reads it at start; backup and the workers must use the same value |
| `DIRECTUS_KEY` | `replace-with-random-key` | Invalidates every session and token hashed with it |
| `DIRECTUS_SECRET` | `replace-with-random-secret` | Invalidates every session and static token |
| `DIRECTUS_ADMIN_PASSWORD` | `change_me_admin` | Read only on first bootstrap; the existing admin keeps its password, but compose needs a non-empty value |

Read the live values from the running containers (the old stack, before the pull):

```bash
docker inspect "$(docker compose ps -q directus)" \
  --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep -E '^(KEY|SECRET|ADMIN_PASSWORD|DB_PASSWORD)='
docker inspect "$(docker compose ps -q minio)" \
  --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^MINIO_ROOT_PASSWORD='
```

`KEY` is `DIRECTUS_KEY`, `SECRET` is `DIRECTUS_SECRET`, `ADMIN_PASSWORD` is
`DIRECTUS_ADMIN_PASSWORD` and `DB_PASSWORD` is `POSTGRES_PASSWORD`. These commands print secrets:
do not paste the output anywhere. Put the values in `.env`. Keep `.env` values free of spaces,
quotes, `#` and `$` (make and the backup scripts source this file).

Also set `DATABASE_URL` in `.env` to use the same `POSTGRES_PASSWORD`.

### 2c. If `POSTGRES_PASSWORD` was unset (old default `change_me`)

Either keep `POSTGRES_PASSWORD=change_me` for now and rotate later, or rotate before the
upgrade. Rotation while the old stack runs:

```bash
NEW=$(openssl rand -hex 32)
docker compose exec -T postgres psql -U d1 -d d1_database -c "ALTER ROLE d1 PASSWORD '$NEW'"
echo "POSTGRES_PASSWORD=$NEW"      # put this in .env, and in DATABASE_URL
```

Directus keeps its old connection until it restarts in step 5, then uses the new one.

## 3. Know what stops working

Direct tailnet access to Postgres 5432, Directus 8055, MinIO 9000 and 9001, the proxy 80, the
workers 8080 and 8081, the text-to-SQL API 8082 and Ollama 11434 is gone unless `D1_BIND_ADDR`
is set to the tailnet IP. Access through Tailscale Serve (to `localhost`) is unaffected.
Redis is no longer published at all; use `docker compose exec redis redis-cli` (already
authenticated).

## 4. Reset stray ownership-cascade flags

Migration 124 turns `cascade_ownership = TRUE` into an action performed by the database on the
next update of that row. A row left flagged by a direct SQL insert would then cascade
unexpectedly. Reset them **before** migrating (the old hook is the only thing that consumed the
flag, so this is safe now):

```bash
docker compose exec -T postgres psql -U d1 -d d1_database <<'SQL'
UPDATE tool_boxes      SET cascade_ownership = false WHERE cascade_ownership;
UPDATE cutting_inserts SET cascade_ownership = false WHERE cascade_ownership;
SQL
```

## 5. Pull, stop Directus, migrate, rebuild

```bash
git pull
docker compose stop directus
make migrate
docker compose up -d --build
```

- **Stop Directus before migrating.** The new extension bundle and the `{seq}` and `{mf}`
  placeholder codes in `pass_code` rely on the triggers from migrations 126 and 127. Directus
  must not run the new bundle against the old schema.
- `make migrate` runs dbmate in a container on the compose network and reaches Postgres as
  host `postgres`; a `localhost` host in `DATABASE_URL` is rewritten for you. Postgres must be
  running (it is: only Directus was stopped). Use `make migrate-status` to check afterwards.
- `up -d --build` rebuilds the worker images and recreates the containers whose configuration
  changed. It **restarts Directus**, which is what unloads the removed hooks (`box-intake`,
  `owner-cascade`, `d1-operation-sequence`, `d1-apply-prep-recipe`). A stale hook stays loaded
  in a running Directus until it restarts, and would double-apply what the triggers now do.

## 6. Fix both worker Flows immediately

The workers reject every request without the secret (401, or 503 if the worker has none). Until
you do this, new test sessions stay `pending_processing`.

In Directus admin, **Settings, Flows**: open `heavy-data-session-webhook` and
`analysis-session-webhook` (the second may have another name; it is the Flow that posts to
`http://analysis-worker:8081/api/webhook/session`). In the webhook operation of **each**, add the
header:

| Header | Value |
|---|---|
| `X-Worker-Secret` | `{{$env.WORKER_WEBHOOK_SECRET}}` |

Save the operation, then the Flow. Directus resolves `$env.WORKER_WEBHOOK_SECRET` because
compose sets `FLOWS_ENV_ALLOW_LIST`. A Flow that does not exist yet is created following
[`heavy-data-pipeline.md`](./heavy-data-pipeline.md) section 3.

## 7. Text-to-SQL (skip if you do not run `llm-text-to-sql`)

Migration 132 made `d1_llm_app` a `NOLOGIN` member of the allow-listed `d1_llm_readonly`. If
the role already existed as a login, it is left as it is; the command below is then still safe.

```bash
LLMPW=$(openssl rand -hex 32); EMBPW=$(openssl rand -hex 32)
docker compose exec -T postgres psql -U d1 -d d1_database <<SQL
ALTER ROLE d1_llm_app LOGIN PASSWORD '$LLMPW';
CREATE ROLE d1_embedder LOGIN PASSWORD '$EMBPW';
GRANT CONNECT ON DATABASE d1_database TO d1_embedder;
GRANT USAGE ON SCHEMA public TO d1_embedder;
GRANT SELECT ON v_embeddings_source_notes TO d1_embedder;
GRANT SELECT, INSERT, UPDATE ON semantic_embeddings TO d1_embedder;
SQL
echo "LLM_DATABASE_URL=postgres://d1_llm_app:$LLMPW@postgres:5432/d1_database?sslmode=disable"
echo "EMBED_DATABASE_URL=postgres://d1_embedder:$EMBPW@postgres:5432/d1_database?sslmode=disable"
```

If `d1_embedder` already exists, drop the `CREATE ROLE` line and use `ALTER ROLE d1_embedder
LOGIN PASSWORD ...`. Put both DSNs in `.env`. **Replace any `EMBED_DATABASE_URL` that points at
the `d1` superuser**: that container also runs LLM-authored SQL. Then recreate it, and give
anything that calls it the secret (`X-Worker-Secret`):

```bash
docker compose --profile llm up -d --force-recreate llm-text-to-sql
```

Details and grants are in [`text-to-sql.md`](./text-to-sql.md) section 1.

## 8. Recorder PCs

The recorder now refuses a `Host` that is not loopback and an `Origin` that is not
`app://force` or listed in `RECORDER_CORS_ORIGINS`. Anything that reached a recorder by another
name (for example the Caddy `/recorder/*` route on d1-server) is refused. Either use the
desktop app on the recorder PC, or set `RECORDER_ALLOWED_HOSTS` and `RECORDER_CORS_ORIGINS`;
see [`docs/force-app-operations.md`](../force-app-operations.md).

## 9. Verify

```bash
docker compose ps                    # every service running; those with a healthcheck "healthy"
make migrate-status                  # no pending migrations
make schema-test                     # the schema suite passes
set -a; . ./.env; set +a             # load WORKER_WEBHOOK_SECRET and D1_BIND_ADDR into this shell
H="${D1_BIND_ADDR:-127.0.0.1}"
curl -s -o /dev/null -w '%{http_code}\n' -X POST "http://$H:8080/api/webhook/session"   # 401: secret required
curl -s -H "X-Worker-Secret: $WORKER_WEBHOOK_SECRET" "http://$H:8080/health"           # {"status":"ok"}
```

Then create one test session with a file through **each** Flow: it should reach `processed`
(heavy-data) and then `analysed` (analysis). Check in Directus, or with
`make phase4-test` (see `heavy-data-pipeline.md` section 6). Look for failed Flow runs in
Directus (Settings, Flows, Logs) and for 401 lines in `docker compose logs heavy-data-worker
analysis-worker`.

## Rolling back

Migrations 118 to 132 have down sections (`make migrate-down` rolls back one at a time), but the
old compose file and the old Directus hooks come back with `git checkout` of the previous
commit. Restore the database from the step 1 backup only if data was damaged
(`backup-restore.md`).
