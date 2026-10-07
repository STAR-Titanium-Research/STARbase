---
name: force-app-release
description: Cut a force-app desktop release. Bumps apps/force-app/desktop/package.json and the lockfile, writes the user-facing changelog.ts entry from the commits since the last tag, runs the release job's checks locally, commits, and hands the tag push to the user. Run only when asked to release.
disable-model-invocation: true
argument-hint: [version, default next patch]
---

# Force-app release

## Where things stand

- `package.json` version: !`node -p "require('./apps/force-app/desktop/package.json').version"`
- Latest release tags: !`git ls-remote --tags origin 'force-app-v*' 2>/dev/null | sed 's|.*refs/tags/||; s|\^{}||' | sort -uV | tail -2 | tr '\n' ' '`
- Top changelog entry: !`grep -m1 -oE "version: '[^']+'" apps/force-app/web/src/changelog.ts`

If `package.json` is already ahead of the latest tag (bumped but never tagged), **don't bump again**.
Release that version, adding any newer changes to its changelog entry.

Commits touching the app since the last tag:
!`t=$(git ls-remote --tags origin 'force-app-v*' 2>/dev/null | sed 's|.*refs/tags/||; s|\^{}||' | sort -uV | tail -1); git fetch -q --deepen=200 origin "refs/tags/$t:refs/tags/$t" 2>/dev/null; git log --no-merges --format='%h %s' "$t"..HEAD -- apps/force-app packages/force-plotting core/extensions/d1-force-dashboard 2>/dev/null | head -40 || echo "(tag not reachable in this clone)"`

## Steps

1. **Version.** Use the argument (`$ARGUMENTS`) or the next patch. Set it in
   `apps/force-app/desktop/package.json`, then `npm install --package-lock-only` so
   `package-lock.json` agrees. Don't hand-edit the lockfile.
2. **Changelog.** Add an entry at the top of `CHANGELOG` in `apps/force-app/web/src/changelog.ts`:
   `{ version, date: 'YYYY-MM-DD', notes: [...] }`. Operators read this in Settings → About →
   What's new. Match the existing entries:
   - Plain language about what the operator sees or can now do, not code. "The live FFT stayed
     blank until a channel chip was clicked", not "fixed RecordClient reactivity".
   - Features first, then `Fixed: …` lines. Name the screen or button.
   - Leave out internal-only changes (refactors, tests, CI, docs).
3. **Preflight.** `bash .claude/skills/force-app-release/scripts/preflight.sh` (~2.5 min). It checks
   that the version, lockfile, changelog, free tag and `electronVersion` agree, and runs every
   Linux-runnable step of `force-app-release.yml`, plus the web/plotting suites that `ci.yml`'s
   `force-app-js` job runs. Fix everything red before going on.
4. **Commit** as `chore(force-app-desktop): bump version to X.Y.Z` (the repo's convention), on a
   branch, and get it to `main` the usual way (PR).
5. **Tag: the user's call.** The tag push publishes to every rig within about five minutes. Give the
   user the exact commands and let them run them:
   ```sh
   git tag force-app-vX.Y.Z <commit-on-main> && git push origin force-app-vX.Y.Z
   ```
   (`/careful` blocks these on purpose.)

## After the tag

- The `force-app-release` workflow (Windows runner) freezes the backend, builds the NSIS
  installer, runs the Playwright e2e suite against it and creates the GitHub Release with `*.exe`
  and `latest.yml`. If it fails, read the job log. A failure in the e2e step uploads
  `playwright-test-results`.
- On d1-server, the `force-app-auto-publish-release` scheduled task polls every 5 minutes and copies
  the release into `infra/force-app-updates/`. It tracks state in `.published-tag` and logs to
  `auto-publish.log`. Rigs update from that feed through electron-updater. "No update offered"
  after more than 10 minutes means checking `auto-publish.log` first
  (`docs/force-app-operations.md`).

## Gotchas

- **The tag must equal `package.json`'s version** (`force-app-v` + version) or the workflow fails
  in its first step.
- **The installer filename must not contain spaces** (`artifactName` in `electron-builder.yml`).
  A space broke the update feed once (6f259ab).
- **`electronVersion` in `electron-builder.yml` is pinned.** When Electron is upgraded, update it in
  the same commit (preflight checks this).
- The workflow's last comment says populating the feed is manual. That's stale: the auto-publish
  task does it (ADR-0010, ops doc).
- A release can't be un-shipped from rigs that already updated. A bad release is fixed by a new
  patch release, never by deleting the tag or the GitHub Release.
- Hardware-dependent fixes in the changelog (NI-DAQ, Lab Amp, real-rate behaviour) are only proven
  on the rig. Ask the user whether they were checked there before the release goes out.
