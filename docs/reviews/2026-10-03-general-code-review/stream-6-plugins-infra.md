# Stream 6 — `plugins/`, `infra/`, `.github/`, compose, Makefile, env (raw reviewer report)

The reviewer checked findings against the code and ran ad-hoc repros (SQL-guard fuzz, FFT
aliasing, Hampel memory, httpx path collapse, rq default timeout, bash `wait`) from the
scratchpad. The coordinator's checks are recorded in the consolidated report.

## Blocking

1. **Redis unauthenticated, published on all interfaces; rq jobs are pickled.**
   `docker-compose.yml:35-36` publishes `6379:6379`, no `requirepass`; rq 1.16.2 pickles by
   default, so anyone reaching 6379 can run code in heavy-data-worker / analysis-worker (which
   hold MinIO root credentials and the Directus token). Fix: drop the host port (or bind
   `127.0.0.1`) and set a Redis password.
2. **All service ports on 0.0.0.0, secrets fail open, default passwords work.** Postgres 5432
   (`:17-18`), MinIO 9000/9001 (`:54-56`), workers 8080/8081, llm-text-to-sql 8082 (`:271-272`),
   Directus 8055, proxy 80. `WORKER_WEBHOOK_SECRET` is blank by default (`.env.example:69`) and
   `check_secret` (`heavy-data-worker/app/lib/security.py:24`) then disables auth on every worker
   route and the text-to-SQL API — contradicting `docs/plugin-contract.md` §2.3 ("Docker-internal
   only"). Fallback values (`change_me`, `minioadmin`, `replace-with-random-key`) work if `.env` is
   copied unedited. Caddy's `/backup-ingest`, `/bug-report-relay`, `/octrees` rely on
   tailnet-only. With auth off, `/api/presign-upload` can overwrite any matching key. Fix: bind to
   `127.0.0.1`/tailnet IP, `${VAR:?}` for secrets, fail closed.
3. **analysis-worker FFT aliases on large files.** `analysis-worker/app/lib/d1f_reader.py:51-69`
   strided read (every Nth sample, no anti-alias filter) with `analyse_session.py:105-108`
   `N = n_samples // 131072`. For 40M samples at 20 kHz the effective Nyquist is 33 Hz; a 1 kHz
   tone was reported as 16.4 Hz; the `500_2000_hz` and `2000_plus_hz` bands are structurally zero
   above ≈1M samples. Also no window, `top_frequencies` returns adjacent leakage bins, Nyquist bin
   gets 2/n (`fft_analysis.py:293-311`). Fix: contiguous blocks + Welch, or proper decimation;
   report the effective Nyquist.

## Should fix

4. **SQL guard bypassable; the DB role is the only real boundary and it's broad.**
   `llm-text-to-sql/app/lib/sql_guard.py:200` collects CTE names tree-wide, so a CTE named
   `directus_users` in a subquery exempts the real table elsewhere (passes `guard()`; also
   `pg_authid`). `query_to_xml`, `database_to_xml`, `pg_read_file`, `set_config`, `pg_sleep`,
   `FOR UPDATE` all pass. Read-only rests on `conn.read_only = True` (`db.py:280`); the login role
   `d1_llm_app` is created by hand (runbook §1), not by a migration. No per-user control (see
   stream 4 #2, stream 5 #8). Fix: per-scope CTE resolution, function allow-list, a migration for
   the login role with an explicit grant list.
5. **Long jobs time out; dead workers go unnoticed.** `heavy-data-worker/app/webhook.py:116`,
   `analysis-worker/app/webhook.py:52` enqueue without `job_timeout` (rq default 180 s); a hard
   kill leaves `status='processing'` forever (contract §9). `entrypoint.sh` uses
   `wait "$WEBHOOK_PID" "$WORKER_PID"`, so a crashed rq worker keeps `/health` green. Fix:
   `job_timeout`, a stuck-row reaper, `wait -n`.
6. **Write-backs to `test_sessions` ignore OCC.** `process_session._merge_outputs`,
   `analyse_session._merge_outputs` GET-merge-PATCH without `filter[version][_eq]`
   (`docs/api-contract.md` §7.2); on GET failure (`process_session.py:95-97`,
   `analyse_session.py:116-118`) they overwrite all of `summary_stats`; status is
   last-writer-wins.
7. **diag-service serves stale data after a rebake.** `diag-service/app/main.py` LRUs keyed on
   `diag_path` only; a rebake rewrites the same path. Key on mtime/size too.
8. **filter/diag services block the event loop; one request can OOM them.** `async def` handlers
   run sync scipy/numpy/HDBSCAN (`filter-service/app/main.py:141,169,194`); `despike.window` is
   unbounded (`filters.py:42-44`; `window=2001` on 200k samples: 36 s, 6.1 GB RSS); no compose
   `mem_limit`.
9. **Compose / Makefile.** Workers mount `archive_share` cifs (`docker-compose.yml:160,203`) that
   no plugin reads and whose credentials are empty by default (uncertain whether `up` fails);
   `:22` healthcheck uses `$POSTGRES_USER` (host-interpolated; renders `pg_isready -U  -d ` with
   no `.env`) — use `$$`; `infra/backup/restore.sh` lacks `ON_ERROR_STOP` /
   `--single-transaction` and reports success after errors; Makefile doesn't load `.env`
   (`reset-db` drops against whatever `DATABASE_URL` is); `EMBED_DATABASE_URL` uses the `d1`
   superuser in the container that runs LLM-authored SQL.
10. **GitHub Actions.** No `permissions:` in `ci.yml`, `force-app-cache-warm.yml`;
    `force-app-release.yml:97` gives the whole job `contents: write` and checkout persists it
    through `npm ci`; pwsh multi-line steps only check the last native exit code (a failed `npm run
    build` can still ship); actions pinned by tag; dbmate download unchecksummed; filter/diag
    images never built in CI; plugin-template tests not in CI; Python 3.11 in CI vs 3.12 in images.
    No `pull_request_target`, no `${{ github.event.* }}` in `run:`, no `|| true`.
11. **Plugin contract drift.** presign/complete-upload field names; webhook returns 400 on a
    missing pointer (`heavy-data-worker/app/webhook.py:111-112`) where the contract says 200;
    `summary_stats` shape and `duration_seconds` vs `duration_s`; bucket `d1-data` vs `d1-files`;
    webhook secret.

## Nits

`filter-service/app/main.py:93`, `diag-service/app/main.py:121` interpolate ids into Directus URLs
unvalidated (`../users/me` collapses; caller's own creds, not escalation); `llm-text-to-sql/app/
api.py:488,525,610` unbounded `row_limit`/`limit`; filter-service `/fft` returns N/√Hz
(uncertain mismatch); `heavy-data-worker/app/lib/plotter.py:449` stride recomputation halves the
time axis for 20k–30k samples; NaN min/max in `streaming_stats`; a boto3 client per presigned
part; presigned URLs use internal `http://minio:9000`; gunicorn 22.0.0 (pre request-smuggling
fix), `minio:latest`/`ollama:latest` unpinned.

## Test gaps

`sql_guard` bypass cases; `conn.read_only` actually blocking writes with the real role;
`check_secret` fail-open and `valid_object_key`; `_merge_outputs` failure/concurrency; FFT
aliasing above Nyquist; diag cache invalidation on rebake; huge `despike.window`; `restore.sh`
and `reset-db`.

## Checks run

pytest per plugin: llm-text-to-sql 91, plugin-template 2, heavy-data-worker 12, analysis-worker 11,
filter-service 6, diag-service 41 — all passed. `ruff check plugins` clean. `docker compose config
-q` rc 0 with unset-variable warnings. No Docker daemon.
