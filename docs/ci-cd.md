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

| Job | What it proves |
|---|---|
| Lint (pre-commit) | The hooks in `.pre-commit-config.yaml`: whitespace, YAML/JSON, ruff, sqlfluff, hadolint, geometry copies in sync |
| Sample geometry engine | Geometry unit tests and every extension's `index.test.mjs` |
| Foundation smoke test | `tests/phase0_smoke.sh`, including `docker compose config` |
| Schema migrations | Migrations and seed apply. Then the phase 1/6/7 schema tests run. Then [`migration_roundtrip.sh`](../scripts/ci/migration_roundtrip.sh) rolls back **every** migration (each down must succeed), fails on any table, view, function, type or schema left behind, and applies them all again |
| Scripts and diagnostics | `tests/scripts` against a real database, including the diag goldens. A skipped DB test fails the job |
| Service images | Each Dockerfile in `docker-compose.yml` builds, and its tests run inside the image (diag-service and filter-service tests read files outside their image, so Force app Python runs them) |
| Directus extension *name* | Each extension with its own lockfile installs, builds and passes its own tests, exactly as on the server |
| Force app JS | `@d1/force-plotting`, `force-app-web` and `force-app-desktop` tests, typechecks and builds |
| Explorer UI | `@d1/ui` tests, typechecks of the Explorer pages, the lab dashboard and the campaign interface, and the workspace extension builds |
| Force app Python | Backend (Python 3.11 with the `nidaq` extra, as the release freezes it), backup server, bug-report relay, filter service and diag service (Python 3.12, as their images run) |
| **CI passed** | Every job above passed or was not needed |

On a PR, the extension and image matrices only build what the PR touches. A push to `main`, or a
change under `.github/`, builds everything. [`ci-plan.mjs`](../.github/scripts/ci-plan.mjs)
decides; run `node .github/scripts/ci-plan.mjs $(git diff --name-only origin/main...HEAD)` to see
what your branch would build. Adding an extension with its own `package-lock.json` adds it to CI
automatically. A new service image needs a line in `ci-plan.mjs`'s `IMAGES` (the `new-plugin`
skill does this).

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
double. A normal PR uses about 25 Linux minutes. The Windows release build (about 15 minutes, so
about 30 billed) runs only for a release, or for the dry run of a PR that touches the version or
packaging.
