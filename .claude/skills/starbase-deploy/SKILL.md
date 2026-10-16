---
name: starbase-deploy
description: Deploy the latest origin/main to the live stack on d1-server (STARbase, Directus, the Force App web, the services). Backs up and migrates when main brings migrations, merges main into the live checkout without touching the maintainer's uncommitted edits, builds what changed, restarts only the services that need it, and verifies. Run only when asked to deploy or update the live setup.
disable-model-invocation: true
argument-hint: [git ref to deploy, default origin/main]
---

# Deploy the latest main to d1-server

Invoking this skill is the maintainer's go-ahead to deploy `origin/main` (or the ref given as the argument) to live, including
applying pending migrations. Anything outside that, such as pushing the live branch, deploying an unmerged branch, or a database
restore, still needs its own yes.

The live checkout is `D:\Users\CMBE Admn 3214022001\Documents\GitHub\D1-Database` (bash: `/d/Users/CMBE Admn 3214022001/Documents/GitHub/D1-Database`).
Run every step there, unless a step says to use the temporary worktree.

## Where things stand

- Live branch: !`git -C "/d/Users/CMBE Admn 3214022001/Documents/GitHub/D1-Database" branch --show-current`
- Uncommitted tracked edits: !`git -C "/d/Users/CMBE Admn 3214022001/Documents/GitHub/D1-Database" status --short --untracked-files=no`

## Never

- `git stash`. The maintainer's stashes must stay as they are.
- `redis-cli FLUSHALL`. Redis holds the rq job queue. Directus has no Redis cache to clear, so restart it instead.
- `npm ci` on the live checkout. A vite dev server from another session can lock `node_modules`, and `ci` then fails halfway with
  `node_modules` wiped. Use `npm install`.
- Push the live branch, or commit the maintainer's uncommitted edits.
- Touch other sessions' containers (`d1-formqa-*`, `d1-scratch-*`, `d1-starbase-*` previews). Live is the `d1-database-*` project only.

## 1. See what main brings

```bash
git fetch -q origin
git log --oneline HEAD..origin/main
git diff --name-only HEAD...origin/main
```

If nothing is new, say so and stop. Otherwise work out the steps from the changed paths:

| Changed path | Then |
|---|---|
| `db/migrations/` | Step 2 (backup) and step 3 (migrate) |
| `package-lock.json`, any `package.json` | `npm install` (step 5) |
| `packages/d1-ui/`, `extensions/`, `core/extensions/` | `npm run build:extensions`; recreate `directus` |
| `apps/starbase/`, `packages/starbase-pages/`, `packages/d1-ui/` | `npm run build:starbase`; recreate `proxy` |
| `apps/force-app/web/`, `packages/force-plotting/` | `npm run build:web`; recreate `proxy` |
| `docker-compose.yml` | Read the diff. Recreate each service whose block changed. New `${VAR}`s: compare with `.env` (step 4b) |
| `.env.example` | Step 4b |
| `scripts/inbox_crawler/` | Recreate `inbox-crawler` (`--profile archive`) |
| A service with a `build:` in compose (relay, workers, diag) | `docker compose up -d --build <service>` |

When unsure whether a service needs it, recreating it is cheap. Rebuilding everything is also safe, just slower.

## 2. Back up (when main brings migrations)

```bash
bash infra/backup/backup.sh
```

Note the dump name it prints, for the report.

## 3. Migrate (when main brings migrations), BEFORE merging

Directus hot-loads extensions and core changes, so the schema has to be ready before the code lands. Run dbmate from a clean,
detached copy of main. `make` doesn't exist on d1-server.

```bash
git worktree add -q --detach .claude/worktrees/deploy-main origin/main
DBURL=$(grep '^DATABASE_URL=' .env | cut -d= -f2- | tr -d '"\r' | sed -E 's#@(localhost|127\.0\.0\.1):[0-9]+/#@postgres:5432/#')
cd .claude/worktrees/deploy-main
MSYS_NO_PATHCONV=1 docker run --rm --network d1-database_d1net -e DATABASE_URL="$DBURL" -v "$(pwd -W)/db:/db" ghcr.io/amacneil/dbmate:2 status
```

Read each pending migration's header. If one deletes or rewrites data in a way its header doesn't explain, stop and ask. Then run
the same command with `--no-dump-schema up` in place of `status`. Remove the worktree at the end:
`git worktree remove --force .claude/worktrees/deploy-main`.

## 4. Merge main into the live checkout

**a. Branch.** If the live branch is `main`, run `git pull --ff-only`. If it's a feature branch (often), merge main into it as a
local commit. Don't switch branches without asking: live may depend on that branch's unmerged work.

**Uncommitted edits.** Main may touch files the maintainer has uncommitted edits in (`docker-compose.yml` with the `EMAIL_*`
lines, for example). Git then refuses the merge. Keep the edits without stashing:

```bash
git diff -- <file> > .<file>-local-$(date +%F).patch      # save the edits
git checkout -- <file>                                     # clean the file
git merge --no-edit origin/main
git apply --3way .<file>-local-$(date +%F).patch           # put the edits back
git apply --cached -R .<file>-local-$(date +%F).patch      # ...but keep them out of the index
```

Then check that `git diff --cached -- <file>` no longer shows the edits.

**Conflicts.** The live branch sometimes has a commit that also landed on main in a slightly different form, for example the
same migration file. Compare the two sides (`git diff :2:<path> :3:<path>`). If they have the same effect, take main's
(`git checkout --theirs <path>`). Otherwise stop and ask. Commit the merge with `git commit --no-edit`.

**b. New settings.** List `.env.example` keys missing from `.env`:

```bash
comm -13 <(grep -oE '^[A-Z_]+=' .env | sort -u) <(grep -oE '^[A-Z_]+=' .env.example | sort -u)
```

Report the missing keys and their defaults. Don't invent secrets. A key with a working compose default can wait.

## 5. Build

Run the steps from step 1, in this order:

```bash
npm install --no-audit --no-fund
npm run build:extensions
npm run build:starbase
npm run build:web
```

## 6. Restart what changed

Restart Directus first and wait until it's healthy, then the rest:

```bash
docker compose up -d --force-recreate directus
until [ "$(docker inspect -f '{{.State.Health.Status}}' d1-database-directus-1)" = healthy ]; do sleep 5; done
docker compose up -d --force-recreate proxy
docker compose --profile archive up -d --force-recreate inbox-crawler   # if it changed
docker compose up -d --build <service>                                  # services built from source, if they changed
```

## 7. Verify

- `docker compose --profile archive ps`: every service is up and healthy.
- `curl -s -o /dev/null -w '%{http_code}' http://localhost/server/health` returns 200.
- `docker compose logs --since 3m directus | grep -iE 'error|fail'` shows no new extension or startup errors.
- A string unique to the new code is in the built files, for example `grep -l '<marker>' apps/starbase/web/dist/assets/*.js`.
- New compose environment values reached their container: `docker compose exec -T <service> sh -c 'echo $VAR'`.
- `git status --short --untracked-files=no` shows only the maintainer's own uncommitted edits.

## 8. Report

In a few lines:
- the commit deployed and the PRs it covers;
- the backup file, and the migrations applied;
- what was rebuilt and restarted;
- any missing `.env` keys;
- the merge commit left unpushed on the live branch;
- anything you skipped.
