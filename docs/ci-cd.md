# CI and releases

How the repository is checked on every change and how the force app ships. The workflows are in
[`.github/workflows/`](../.github/workflows/); the `ci-local` skill runs the same checks before a
push.

## Releasing the force app

**One instruction:** ask Claude to *"release the force app"*. The `force-app-release` skill bumps
`apps/force-app/desktop/package.json`, writes the operator-facing entry in
`apps/force-app/web/src/changelog.ts`, runs the preflight and opens a PR. **Merging that PR is the
release.** Nothing else to run.

**One button:** *Actions → force-app-release → Run workflow* on `main` (or `make
release-force-app` with the GitHub CLI). It releases the version on `main` if that version has
no GitHub Release yet. Use it to retry a release that failed, or to ship a version that was
bumped but never released. Tick **Dry run** to build and test any branch without publishing.

Either way, `force-app-release.yml`:

1. **Plans** ([`release_plan.py`](../.github/scripts/release_plan.py)). Decides whether there is
   anything to release, and checks that the lockfile and the changelog's top entry match the
   version. A version counts as released once a GitHub Release exists for
   `force-app-v<version>`.
2. **Builds and tests on Windows.** Backend and backup-server tests (with the `nidaq` extra, as
   shipped), PyInstaller freeze, desktop unit tests, the NSIS installer, then Playwright against
   the packaged app.
3. **Publishes**, after main's CI on that same commit has passed. It creates the tag and the
   GitHub Release with `ForceApp-Setup-<version>.exe` and `latest.yml`, and uses the changelog
   entry as the release notes.

d1-server's `force-app-auto-publish-release` task picks the Release up within about five minutes
and copies it into the update feed. Rigs then offer the update. For that task, and for what to
check when no update is offered, see
[force-app-operations.md](force-app-operations.md#deploying-the-auto-publish-task).

Things worth knowing:

- **Merging a version bump ships it.** Bump the version only in a PR that is meant to release.
- A PR that changes the version or the packaging (`electron-builder.yml`,
  `force-app-backend.spec`, the backend's `pyproject.toml`) runs the whole Windows build as a
  **dry run**. Its installer is kept for 5 days as the run's `force-app-release-files` artifact,
  to try on a rig before merging.
- **If the release fails** after the merge, fix it in a new PR. The next push to `main` retries
  the release, or press the button. A tag left by a failed run has no Release behind it, so
  nothing shipped from it; the next successful run moves it to the commit it releases.
- **A shipped release cannot be pulled back from rigs** that already updated. Fix a bad release
  with a new patch release.
- Pushing a `force-app-v*` tag by hand still works. The tag must equal `package.json`'s version.

## What CI checks

[`ci.yml`](../.github/workflows/ci.yml) runs on every PR, on every push to `main`, and on demand
(*Run workflow*, any branch). A newer push to the same PR cancels its run still in progress.

| Job | What it proves | Runs on a PR when it touches |
|---|---|---|
| Lint and quick checks | The hooks in `.pre-commit-config.yaml` (whitespace, YAML/JSON, ruff, sqlfluff, hadolint, geometry copies in sync), geometry unit tests and every extension's `index.test.mjs`, the CI-plan tests, and `tests/phase0_smoke.sh` including `docker compose config` | always |
| Schema migrations | Migrations and seed apply. Then the phase 1/6/7 schema tests run. Then [`migration_roundtrip.sh`](../scripts/ci/migration_roundtrip.sh) rolls back **every** migration (each down must succeed), fails on any table, view, function, type or schema left behind, and applies them all again | `db/`, `scripts/`, `tests/`, `d1-access-guard`, `d1-inbox` (its SQL is prepared against the real schema in phase 1) |
| Scripts and diagnostics | `tests/scripts` against a real database, including the diag goldens. A skipped DB test fails the job | the same, plus the force app's changelog |
| Service images | Each selected Dockerfile in `docker-compose.yml` builds, and its tests run inside the image (diag-service and filter-service tests read files outside their image, so Python services runs them) | that image's directory |
| Directus extensions | Each selected extension with its own lockfile installs, builds and passes its own tests, exactly as on the server | that extension's directory |
| Force app JS | `@d1/force-plotting`, `force-app-web` and `force-app-desktop` tests, typechecks and builds | the force app's web/desktop, either `packages/`, the force dashboard, the root `package*.json` |
| Explorer UI | `@d1/ui` tests, typechecks of the Explorer pages, the lab dashboard and the campaign interface, and the workspace extension builds | `packages/d1-ui`, the workspace extensions, the root `package*.json`, `tests/fixtures/d1-inbox/` and `d1-inbox` (its contract fixtures are replayed through the client) |
| Force app Python (recorder backend) | Backend tests on Python 3.11 with the `nidaq` extra, as the release freezes it | `apps/force-app/backend/` |
| Python services | Backup server, bug-report relay, filter service and diag service on Python 3.12 (as their images run), each in its own venv | that service (filter: also the backend's `d1lc.py`; diag: also `scripts/diag/`) |
| **CI passed** | Every job above passed or was not needed | always |

A push to `main`, a manual run, or a PR that changes anything under `.github/` runs every job.
[`ci-plan.mjs`](../.github/scripts/ci-plan.mjs) decides (its tests are `ci-plan.test.mjs`); run
`node .github/scripts/ci-plan.mjs $(git diff --name-only origin/main...HEAD)` to see what your
branch would run. A job that reads a new path needs that path in `ci-plan.mjs`'s `JOBS`, or a PR
touching only that path will skip it. Adding an extension with its own `package-lock.json` adds it
to CI automatically. A new service image needs a line in `ci-plan.mjs`'s `IMAGES` (the
`new-plugin` skill does this).

Not in CI, because they need the full running stack: `tests/phase3_api.sh`,
`tests/phase4_heavy_data.sh` and `tests/ui/`. Anything that needs a rig or real Directus data
goes in [the physical test backlog](runbooks/physical-test-backlog.md).

## Repository settings

These can only be set in GitHub's settings, not from a file:

- **Branch protection on `main`** (*Settings → Branches*): require the **CI passed** check and a
  PR. Requiring that one check covers every job, including ones the plan skips or adds later.
- **Dependabot security updates** (*Settings → Code security*). Version updates are configured in
  [`.github/dependabot.yml`](../.github/dependabot.yml): grouped, monthly, minor and patch only.

## Cost

The repository is private, so Actions minutes count against the plan, and Windows minutes count
double. Every job is billed rounded **up** to a whole minute, so many short jobs cost far more
than their run time: before 2026-10-08 a full run was 37 jobs, about 22 minutes of work billed as
about 45. Hence the layout above:

- Small components run as loops inside one job (extensions, images, Python services), and the
  quick checks share the lint job. A full run (`main`, `.github/` changes) is about 11 jobs.
- On a PR every job is gated on the paths it reads. A docs-only push (plans, backlog, runbooks)
  costs the plan, lint and CI passed jobs: about 3 minutes.
- The Windows release build (about 18 minutes, so about 36 billed) runs for a release, and as a
  PR dry run only when the PR changes the version, the packaging files, the desktop package's
  runtime dependencies or the installer tools (electron, electron-builder, electron-updater,
  Playwright), also when only the lockfile moves them (`release_plan.py`
  `pr_packaging_changes`). A Dependabot bump of anything else skips it.
- Each push to an open PR runs CI again (a newer push cancels the older run). Batch doc and
  status-table commits into the next code push once a PR is open.
