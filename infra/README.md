# `/infra` — Infrastructure-as-code

Everything needed to bring the stack up from a clean machine and keep it safe.

> **Upgrading a running deployment?** Read
> [`docs/runbooks/upgrade-2026-10-hardening.md`](../docs/runbooks/upgrade-2026-10-hardening.md)
> first. Compose now refuses to start (even `down`/`ps`) without new secrets, the workers reject
> requests without `X-Worker-Secret`, and the Directus Flows must be edited. A plain `git pull` and
> `docker compose up` breaks an existing install.

- `../docker-compose.yml` — single-command stack (Phase 2: healthchecks, restart
  policies, Caddy reverse proxy, MinIO bucket bootstrap), plus the plugin and
  force-app services added since.
- `../.env.example` — config template; copy to `.env` (never committed).
- `caddy/Caddyfile` — the Caddy reverse proxy: plain HTTP on `:80` (TLS is
  terminated in front of it by Tailscale serve on `d1-server`). Directus is the
  default route; the other routes are below.
- `backup/backup.sh` — verified (`gzip -t`) compressed `pg_dump` + roles dump + MinIO upload.
- `backup/restore.sh` — download from MinIO, verify, then a single-transaction `psql`
  restore that asks you to type the database name (`--yes` to skip).

| Caddy route | Serves |
|---|---|
| `/app/*` | The force-app web UI build (`apps/force-app/web/dist`) — the read-only browser surface |
| `/octrees/*` | Potree octrees and diagnostics bakes, from `infra/octrees/` |
| `/filter/*`, `/diag/*` | `filter-service`, `diag-service` |
| `/recorder/*` | A recorder backend on the host (port 8200) |
| `/backup-ingest/*`, `/bug-report-relay/*` | The force-app's `backup-server` and `bug-report-relay` |
| `/force-app-updates/*` | The desktop app's auto-update feed, from `infra/force-app-updates/` |
| everything else | Directus |

`infra/octrees/` and `infra/force-app-updates/` are runtime data written on the
host, so they are git-ignored.

**Quick-start (Phase 2):**

```bash
cp .env.example .env        # fill in secrets (openssl rand -hex 32); compose refuses to start without them
make up                     # bring stack up
make bootstrap-minio        # create d1-files + d1-backups buckets (once)
make migrate && make seed   # apply schema + reference data
```

`make migrate`, `migrate-down`, `migrate-status` and `reset-db` run dbmate in a container on the
compose network and reach Postgres as `postgres:5432` (a `localhost` host in `DATABASE_URL` is
rewritten for you), so they need the stack's Postgres running (`make up` first). `make seed`,
`make schema-test` and the other `psql` targets run on the host and use `DATABASE_URL` as written.

**Network exposure.** Every published port (Directus, proxy, Postgres, MinIO, the
workers, llm-text-to-sql, Ollama) binds to `D1_BIND_ADDR`, default `127.0.0.1`. Leave the
default: on `d1-server` Tailscale Serve forwards to `localhost`, so the tailnet reaches the
stack through it and nothing else is exposed. Set `D1_BIND_ADDR` to the host's tailnet IP
(`tailscale ip -4`) **only** if clients must reach the ports directly, and know the cost: a
`localhost` Tailscale Serve target stops working, and the containers fail to start if
Tailscale is not up yet when Docker brings them up. Never `0.0.0.0`. Redis is not published at
all (use `docker compose exec redis redis-cli`, which is already authenticated).

**Backup / restore:**

```bash
make backup                                               # create and upload
BACKUP_FILE=d1_<ts>.sql.gz make restore                  # restore from MinIO
```

See `docs/runbooks/backup-restore.md` for the full runbook — including the
separate nightly backup that protects the production database on `d1-server`.
Deploying and troubleshooting the force-app services is covered in
[`docs/force-app-operations.md`](../docs/force-app-operations.md).

Target runtime: **Docker on Windows** (Docker Desktop / WSL2), Linux-portable.
