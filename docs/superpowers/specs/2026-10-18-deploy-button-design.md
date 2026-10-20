# Deploy button in Data Studio

**Status:** approved in chat 2026-10-18 (two buttons, host-side agent). **Goal:** an admin pulls the latest `origin/main` onto
d1-server and restarts what changed from a Data Studio page, with no command prompt.

## Decisions

- **Two buttons.** *Check for updates* changes nothing. *Deploy* runs the safe subset of `/starbase-deploy`.
- **Host-side agent**, not `docker.sock` in Directus: git, npm builds and `docker compose` run on the Windows host, and the deploy
  recreates Directus itself. Root-equivalent socket access and a request that kills its own server are both rejected.
- **Safe subset.** The button never resolves judgement calls. It stops, changes nothing beyond a backup, and says why. Those cases
  stay a `/starbase-deploy` job for Claude or the maintainer.
- **One source of truth.** The deploy logic lives in `scripts/deploy/` and the skill's step 1 calls it.

## Components

| Piece | Path | Runs | Role |
|---|---|---|---|
| Deploy logic | `scripts/deploy/lib.mjs`, `scripts/deploy/deploy.mjs` | host, Node 24 | `check` and `run` commands, pure helpers |
| Deploy agent | `infra/deploy-agent/agent.mjs`, `install.ps1` | host, Windows Scheduled Task | HTTP on `127.0.0.1:8212`, single-flight, log files |
| Directus endpoint | `core/extensions/d1-deploy-endpoint/` | Directus | admin-only proxy to the agent, mounted at `/d1-deploy` |
| Directus module | `core/extensions/d1-deploy/` | browser | the *Deploy* page (workspace extension) |

## Agent API (`infra/deploy-agent`)

All routes except `GET /health` need header `X-Deploy-Token` equal to `DEPLOY_AGENT_TOKEN` (compared with `crypto.timingSafeEqual`;
the agent refuses to start without the token). Binds `127.0.0.1` only (`DEPLOY_AGENT_PORT`, default 8212). The repo root is
`DEPLOY_REPO_DIR` (default: the agent's grandparent directory). The agent reads `.env` from the repo root.

| Route | Result |
|---|---|
| `GET /health` | `{ok:true}` |
| `GET /state` | `{running, current:{id,startedAt,actor,step}\|null, last:Summary\|null, repo:{branch,head,dirty:string[]}}` |
| `POST /check` | runs `node scripts/deploy/deploy.mjs check --json`, returns the **Check result** below (timeout 90 s) |
| `POST /deploy` body `{ack?: string[]}` + header `X-Deploy-Actor` | starts `deploy.mjs run --json --ack <files>` detached. `202 {id}`. `409 {code:"busy"}` if a run is active |
| `GET /runs` | the last 20 `Summary` objects, newest first |
| `GET /runs/:id?offset=N` | `{id, done, result:Result\|null, log:string, nextOffset:number}`; `log` is the file from byte `N` |

Run files: `logs/deploy/<id>/run.log` and `result.json` (`logs/` is gitignored); `<id>` is `YYYYMMDDTHHMMSSZ`. Keep 20 runs,
delete older ones. A single `logs/deploy/.lock` file (created exclusively) enforces one run at a time; a lock whose process
no longer exists is stale and is removed. If the agent starts and finds a run with no `result.json` and a dead pid, it writes
`{ok:false, failedStep:"interrupted"}`.

If `agent.mjs` itself changed during a run (hash before vs after), the agent exits with code 75 once the run is recorded, so the
Scheduled Task's restart-on-failure picks up the new code.

## Check result (`deploy.mjs check --json`)

```json
{
  "upToDate": false,
  "branch": "feat/tooling-motion", "head": "889645e3", "target": "68a56c50",
  "commits": [{"sha":"…","subject":"…"}],
  "changedCount": 42,
  "steps": ["migrate","install","build:extensions","build:starbase","recreate:directus","recreate:proxy"],
  "migrations": [{"file":"db/migrations/202610180900_x.sql","destructive":["DROP COLUMN"]}],
  "dirty": ["docker-compose.yml"],
  "overlap": ["docker-compose.yml"],
  "conflicts": ["core/extensions/foo/index.js"],
  "blockers": [{"code":"overlap","message":"…"}],
  "needsAck": ["db/migrations/…"]
}
```

- `git fetch -q origin`; `commits` = `HEAD..origin/main`; `changedCount`/paths from `git diff --name-only HEAD...origin/main`.
- `steps` come from the skill's table (changed path → step). Compose `build:` services are mapped from
  `docker compose config --format json` (service `build.context`; when the context is `.`, use the dockerfile's directory);
  a changed path under that directory adds `recreate:<service>` with a build. A changed compose file adds `compose-up`.
- `dirty` = `git status --porcelain --untracked-files=no`; `overlap` = dirty ∩ changed paths. Overlap is a **blocker**.
- `conflicts` from `git merge-tree --write-tree HEAD origin/main` (exit 1 lists conflicted paths). Any conflict is a **blocker**.
  If git is too old for `--write-tree`, `conflicts` is `null` and nothing is claimed.
- `migrations`: migration files added or changed by the update; `destructive` lists the statements found in the `migrate:up`
  section only (comments stripped): `DROP TABLE|COLUMN|SCHEMA|TYPE|FUNCTION|VIEW|INDEX`, `TRUNCATE`, `DELETE FROM`, `UPDATE … SET`,
  `ALTER … DROP`. Files with a non-empty `destructive` are `needsAck`.
- `upToDate` is true when there are no commits. A `blockers` entry stops *Deploy*; `needsAck` only needs the user's tick.

## Deploy (`deploy.mjs run`)

Each step prints `##STEP <name>` then its output; `result.json` is `{id, ok, startedAt, finishedAt, actor, branch, fromSha,
toSha, steps:[{name,ok,ms}], backup:string|null, failedStep:string|null, message}`.

1. **preflight**: same as check; refuses when `blockers` is non-empty or a `needsAck` file is not in `--ack`
   (`failedStep:"preflight"`, nothing touched).
2. **worktree**: `git worktree add -q --detach .claude/worktrees/deploy-main origin/main` (remove a stale one first); removed at the end.
3. **migrate**: dbmate via `docker run --rm --network ${DEPLOY_DOCKER_NETWORK:-d1-database_d1net}` with `DATABASE_URL` from `.env`
   (host `localhost`/`127.0.0.1:port` rewritten to `postgres:5432`), `db/` of the worktree mounted at `/db`, image
   `ghcr.io/amacneil/dbmate:2`. Run `status`; if migrations are pending, run `bash infra/backup/backup.sh` first (bash path
   `DEPLOY_BASH`, default `C:\Program Files\Git\bin\bash.exe`; record the dump name in `backup`), then `--no-dump-schema up`.
4. **merge**: `git merge --no-edit origin/main`. On any failure run `git merge --abort` and fail with the conflicting paths.
5. **install**: `npm install --no-audit --no-fund` when `package.json` or the lockfile changed. Never `npm ci`.
6. **build**: `npm run build:extensions`, `build:starbase`, `build:web` for the steps that need them.
7. **restart**: `docker compose up -d` (recreates only what changed), then `--force-recreate directus` when extensions
   changed, `--force-recreate proxy` when STARbase or the web app was rebuilt, and `up -d --build <svc>` for each mapped
   build service. Only `d1-database-*` services; never other sessions' containers.
8. **verify**: poll `docker compose ps --format json` (≤ 180 s) until every service touched is `running` and healthy-or-no-healthcheck.
9. **notes**: list `.env.example` keys missing from `.env` (report, never invent values).

Never: `git stash`, `redis-cli FLUSHALL`, `npm ci`, `git push`, touching other containers. A failure stops the run, records
`failedStep`, and leaves any applied migration in place (the message names the backup).

## Directus endpoint (`d1-deploy-endpoint`, mounted at `/d1-deploy`)

Plain ESM `index.js` plus `index.test.mjs`, shaped like `d1-ask-endpoint`. Requires `req.accountability.admin === true`
(401 without a user, 403 otherwise). Routes: `GET /state`, `POST /check`, `POST /deploy`, `GET /runs`, `GET /runs/:id`
mapping 1:1 to the agent. `POST /deploy` forwards `{ack}` (array of at most 50 strings of at most 300 characters; anything else is
a 400) and `X-Deploy-Actor: <user id>`. `:id` must match `^\d{8}T\d{6}Z$`; `offset` must be a non-negative integer.
`DEPLOY_AGENT_TOKEN` unset: `503 {code:"not_configured"}`. Agent unreachable: `502 {code:"agent_unreachable"}`. The agent's status
and JSON are relayed otherwise. Env: `DEPLOY_AGENT_URL` (default `http://host.docker.internal:8212`), `DEPLOY_AGENT_TOKEN`. Both go
into the `directus` block of `docker-compose.yml` and `.env.example`.

## Directus module (`d1-deploy`)

A workspace extension (`directus-extension-d1-deploy`, `type: module`, Vue, no `@d1/ui`) added to the root `workspaces` and
`build:extensions`. `preRegisterCheck` hides it unless the user has admin access (the endpoint is the real gate). One page,
`<private-view title="Deploy">`, theme variables only:

- **Status card**: live branch, HEAD, uncommitted-file count, agent reachable, last deploy (time, who, result).
- **Check for updates** → commits, step chips, migrations (destructive ones flagged, each with an "I've read this" checkbox),
  blockers in red, `Up to date` when nothing is new.
- **Deploy** → confirm dialog naming the commit count and steps; disabled while a blocker exists, an ack is missing, or a run is active.
- **Run view**: polls `/runs/:id?offset=` every 2 s, shows step progress and the log (`<pre>`), keeps polling through Directus
  restarts (a failed poll shows "Directus is restarting…" and retries), and on success says "Reload this page to load the new
  extensions".
- Errors show the endpoint's message; `not_configured` and `agent_unreachable` get a one-line fix hint.

## Docs and wiring

- `.env.example`: `DEPLOY_AGENT_TOKEN`, `DEPLOY_AGENT_URL`, `DEPLOY_AGENT_PORT`, `DEPLOY_DOCKER_NETWORK`, `DEPLOY_BASH` (commented, with defaults).
- `infra/deploy-agent/install.ps1`: registers the Scheduled Task `D1 Deploy Agent` (at startup, run whether or not logged on is
  **not** attempted: current user, at logon and at startup, restart on failure every minute, no time limit), and prints the token step.
- `docs/runbooks/deploy-button.md`: install, token, how it works, what it refuses, how to recover.
- `docs/runbooks/physical-test-backlog.md`: live checks (Check on a real update; Deploy of a trivial commit; conflict refusal).
- `.github/workflows/ci.yml`: run `node --test scripts/deploy/*.test.mjs infra/deploy-agent/*.test.mjs` in the lint job.
- `.claude/skills/starbase-deploy/SKILL.md`: step 1 says to start with `node scripts/deploy/deploy.mjs check`.

## Testing

`node --test` for every new `.mjs`: pure helpers (path→step mapping, destructive-SQL scan, overlap, build-service mapping),
the orchestrator against a fake `exec` (step order, ack gate, merge-abort on conflict, skip-backup when nothing pending, never
`npm ci`), the agent on an ephemeral port with a fake runner (token, single-flight 409, offset reads, stale lock), the endpoint
with a fake `fetch` (admin gate, validation, error mapping). The module passes `vue-tsc` and `directus-extension build`.

## Out of scope

Auto-deploy on merge, rollback, restoring a database, the judgement steps (conflicts, overlapping local edits, unexplained
migrations), restarting other sessions' containers, and deploying a branch other than `origin/main`.
