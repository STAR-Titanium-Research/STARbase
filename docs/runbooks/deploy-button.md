# Deploy button (Data Studio)

An administrator pulls the latest `origin/main` onto d1-server and restarts what changed from the **Deploy** page in Data
Studio, with no command prompt. Design: [spec](../superpowers/specs/2026-10-18-deploy-button-design.md). The same logic is
what the `/starbase-deploy` skill starts with (`node scripts/deploy/deploy.mjs check`).

## How it works

```
Data Studio "Deploy" page  ->  Directus endpoint /d1-deploy (admins only)  ->  deploy agent on the host (127.0.0.1:8212)
                                                                                   |
                                                                  node scripts/deploy/deploy.mjs check | run
```

The agent runs on the **host**, not in a container, because the deploy runs `git`, `npm` and `docker compose` there and
recreates Directus itself. Directus never gets `docker.sock`.

- **Check for updates** only runs `git fetch`. It lists the new commits, the steps a deploy would run, the migrations (with the
  destructive statements found in their `migrate:up` section) and anything that would stop a deploy.
- **Deploy** runs, in order: preflight (which resolves `origin/main` to one commit and uses that commit for everything after), a
  temporary worktree of it, migrate (backup first, only when migrations are pending), `git merge --no-edit <that commit>`,
  `npm install` (only when a `package.json` or the lockfile changed), the builds the changed paths need, the restarts (a plain
  `docker compose up -d` only when `docker-compose.yml` changed, otherwise just the services that need it: Directus for extensions,
  the proxy for the built apps and `infra/caddy/`, rebuilt services such as diag-service (also for `scripts/diag/`). Every recreate
  uses `--no-deps`, so Postgres and friends are never recreated with it. Opt-in services (inbox-crawler, the `starbase` tailnet
  device for `infra/tailscale/`) are recreated only if they are already running), a health check (up to
  180 s), and a note listing `.env.example` keys missing from `.env`. Right before the migration and the merge it checks that the
  live checkout is still on the same branch and commit as at preflight. Never `npm ci`, `git stash`, `redis-cli FLUSHALL`,
  `git push`, or another session's containers.
- Every command has a time limit (git fetch 2 min, local git 30 s, compose 5 min, `npm install` and each build 15 min, dbmate
  10 min, backup 15 min) and git never prompts for credentials. The whole run is killed after `DEPLOY_RUN_TIMEOUT_MIN` (default 60) and
  recorded as `failedStep: "timeout"`.
- One run at a time (`logs/deploy/.lock`). The agent takes it for a button run; a `deploy.mjs run` started by hand takes it itself and
  refuses ("Another deploy is running") while another run is live. A lock counts as live only if its process exists **and** the file
  was refreshed in the last 3 minutes (a running deploy refreshes it every 20 s), so a process number reused after a crash or reboot
  cannot block deploys. Logs and results are kept for the last 20 runs under `logs/deploy/<id>/`
  (`run.log`, `result.json`); `<id>` is `YYYYMMDDTHHMMSSZ` in UTC.

## What it refuses (and what to do)

The button never resolves a judgement call. It stops, changes nothing beyond a backup, and says why.

| Refusal | Why | What to do |
|---|---|---|
| `overlap` blocker | Files with uncommitted edits on d1-server are also changed by the update | Run `/starbase-deploy` (it keeps the edits without stashing) |
| `untracked_overlap` blocker | Untracked files here would be overwritten by files the update adds | Move or delete them (or `/starbase-deploy`) |
| `conflict` blocker | `git merge-tree` says the merge would conflict | `/starbase-deploy`; compare both sides, take main's only if the effect is the same |
| A pending migration is not part of the update | `dbmate status` lists a migration the update did not add or change (it was never scanned) | `/starbase-deploy`; nothing was applied and no backup was taken |
| The checkout moved | The live branch or HEAD changed between preflight and the migration or merge | Look at what changed it, then deploy again |
| A migration needs an acknowledgement | Its `migrate:up` has `DROP ...`, `TRUNCATE`, `DELETE FROM`, `UPDATE ... SET` or `ALTER ... DROP` | Read the migration. If it is meant, tick *I've read this* on the page (or pass `--ack <file>` on the command line) and deploy again |
| `compose_config` blocker | `docker compose config` failed, so the services to rebuild cannot be worked out | Fix `.env` / the compose file, then check again |
| A step failed | See the log; the run records `failedStep` and `message` | Below |

Not covered at all: rollback, restoring a database, deploying a branch other than `origin/main`, auto-deploy on merge.

## Install (once, on d1-server, as the maintainer)

1. Make sure the live checkout has this code (merge or deploy the PR that added it once by hand, with `/starbase-deploy`).
2. Make a token and put the **same** value where both sides read it, in `.env`:
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
   `DEPLOY_AGENT_TOKEN=<value>`. The agent reads `.env` from the repo root; Directus gets it through `docker-compose.yml`.
3. Register the Scheduled Task (an ordinary PowerShell; if it reports access denied for the startup trigger, use an elevated one):
   ```
   powershell -ExecutionPolicy Bypass -File infra\deploy-agent\install.ps1
   ```
   It registers **D1 Deploy Agent**: the current user, **whether or not anyone is logged on** (logon type S4U: no password stored),
   at startup and at logon, restart on failure every minute, no time limit, and starts it. The task runs `run-agent.ps1`, which
   restarts the agent after every exit (at once for code 75, otherwise after 2 s doubling up to 60 s, back to 2 s after 5 minutes of
   uptime). The agent refuses to start without `DEPLOY_AGENT_TOKEN` and listens on `127.0.0.1` only.

   An S4U task cannot read the user's saved credentials (Windows Credential Manager). If `git fetch` works in your terminal but
   fails in the task, reinstall with `-StorePassword` (Task Scheduler then keeps your Windows password and the task runs with the
   full profile).
   **After the first unattended reboot** (nobody logs on) check: `curl http://127.0.0.1:8212/health` answers; Docker Desktop is up
   (the deploy needs `docker compose`; set Docker Desktop to start at boot); the Deploy page's Check works (git fetch with nobody
   logged on).
4. Recreate Directus so it has the token: `docker compose up -d --force-recreate directus`.
5. Check: `curl http://127.0.0.1:8212/health` answers `{"ok":true}`, and the Deploy page shows the agent as reachable.

Optional `.env` settings (all in `.env.example`): `DEPLOY_AGENT_PORT` (8212), `DEPLOY_AGENT_URL` (Directus side,
`http://host.docker.internal:8212`), `DEPLOY_DOCKER_NETWORK` (`d1-database_d1net`), `DEPLOY_BASH` (`C:\Program Files\Git\bin\bash.exe`,
used for `infra/backup/backup.sh`), `DEPLOY_REPO_DIR` (the agent's grandparent directory), `DEPLOY_RUN_TIMEOUT_MIN` (60: a run
longer than this is killed).

To rotate the token: change it in `.env`, recreate Directus, restart the task (`Stop-ScheduledTask` then `Start-ScheduledTask -TaskName 'D1 Deploy Agent'`).
To remove: `install.ps1 -Uninstall`.

## The agent's API

All routes except `GET /health` need the header `X-Deploy-Token`. Errors are `{code, message}`.

| Route | Result |
|---|---|
| `GET /health` | `{ok:true}` |
| `GET /state` | `{running, current:{id,startedAt,actor,step}\|null, last:Summary\|null, repo:{branch,head,dirty:[]}}` |
| `POST /check` | the check result (90 s limit). `409 busy` while a deploy or another check runs |
| `POST /deploy` | body `{ack?:[files]}`, header `X-Deploy-Actor`. `202 {id}`, `409 busy`, `400` for a bad `ack` |
| `GET /runs` | the last 20 `Summary` objects, newest first |
| `GET /runs/:id?offset=N` | `{id, done, result, log, nextOffset}`; `log` is the file from byte `N` |

`Summary` = `{id, ok, startedAt, finishedAt, actor, branch, fromSha, toSha, backup, failedStep, message}` (the same fields as
`result.json`, without `steps`). From the host, for example:

```
curl -s -H "X-Deploy-Token: $TOKEN" http://127.0.0.1:8212/state
```

## If something goes wrong

- **The page says "not configured"**: `DEPLOY_AGENT_TOKEN` is empty in Directus's environment. Set it in `.env`, recreate Directus.
- **The page says "agent unreachable"**: the task is not running. `Get-ScheduledTaskInfo -TaskName 'D1 Deploy Agent'`, then
  `Start-ScheduledTask -TaskName 'D1 Deploy Agent'`. Run `node infra\deploy-agent\agent.mjs` in a terminal to see why it stops
  (usually a missing token or the port already taken). Directus reaches the agent at `host.docker.internal`; if the agent is up on
  the host but the page cannot reach it, check `curl http://host.docker.internal:8212/health` from inside the Directus container.
- **A run is marked `interrupted`**: the agent or the machine restarted mid-run. Read `logs/deploy/<id>/run.log`, check
  `git status`, `docker compose ps` and (if a migration ran) the database before running again. A leftover `git merge` in progress:
  `git merge --abort`.
- **`.lock` left behind**: a lock whose process is gone, or that nobody has refreshed for 3 minutes, is replaced by the next run
  (the run it belonged to is recorded as `interrupted`). If it somehow persists and no deploy is running, delete `logs/deploy/.lock`.
- **A run seems stuck**: the Deploy page shows the last step; `logs/deploy/<id>/run.log` shows what it is doing. Every command has a
  time limit and the whole run is killed after `DEPLOY_RUN_TIMEOUT_MIN` (60) minutes, so it ends by itself. To stop it sooner there is
  no cancel button: find the run's process id in `logs/deploy/.lock` (`pid`) and kill the whole tree from PowerShell,
  `taskkill /PID <pid> /T /F`. The agent then records the run as `crashed`. Afterwards check `git status` (a merge in progress:
  `git merge --abort`), `docker compose ps` and, if a migration ran, the database.
- **Merge failed**: the merge is aborted and the working tree is as before. The message names the paths. A migration applied
  earlier stays in place (the message names the backup); finish with `/starbase-deploy`. If the message says the merge abort
  **FAILED**, the checkout may be mid-merge: `git status`, then `git merge --abort` by hand.
- **Migration failed**: the backup is named in the message (`backups/` and MinIO `d1-backups`). Restore only with the maintainer
  ([backup-restore](backup-restore.md)).
- **`npm install` fails on `node_modules`**: a vite dev server from another session holds it. Stop that server and deploy again.
- **Verify timed out**: a service is not healthy after 180 s. `docker compose ps`, `docker compose logs --since 5m <service>`.
- **The agent restarted by itself after a deploy**: if the deploy changed `infra/deploy-agent/agent.mjs`, the agent exits with
  code 75 once the run is recorded and the task's wrapper (`run-agent.ps1`) starts the new code at once. Any other exit (a missing
  token exits 1) is restarted by the same wrapper after a backoff of 2 s doubling to 60 s.
- **The page is stale after a deploy**: reload it to load the new extensions (Directus restarts when extensions changed; the page
  keeps polling through the restart).

Pending live checks are in [physical-test-backlog](physical-test-backlog.md) (items DEPLOY1 to DEPLOY7).
