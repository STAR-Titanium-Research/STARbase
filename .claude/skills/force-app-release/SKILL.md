---
name: force-app-release
description: Cut a force-app desktop release. Bumps apps/force-app/desktop/package.json and the lockfile, writes the user-facing changelog.ts entry from the commits since the last tag, runs the release job's checks locally, and opens the release PR. Merging that PR ships the release (force-app-release.yml). Run only when asked to release.
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
   - Start each note with the category it belongs to. Settings → About and the GitHub Release (the
     update dialog) group by it: `Fixed: …` → Fixed, `Security: …` → Fixed (the word stays in the
     text), `Improved: …` → Improved, `New: …` or no prefix → New. A prefix is exactly that
     spelling plus a colon and a space; anything else (`Plot page: …`) is part of the sentence and
     counts as New. `notes` stays a flat `string[]`: `release_plan.py` reads it with a regex, so
     don't turn the notes into objects. `web/src/changelogGroups.test.ts` fails on a misspelt
     prefix such as `Fix:` or `fixed:`.
   - Leave out internal-only changes (refactors, tests, CI, docs).
3. **Preflight.** `bash .claude/skills/force-app-release/scripts/preflight.sh` (~2.5 min). It checks
   that the version, lockfile, changelog, free tag and `electronVersion` agree, and runs every
   Linux-runnable step of `force-app-release.yml`, plus the web/plotting suites that `ci.yml`'s
   `force-app-js` job runs. Fix everything red before going on.
4. **Commit** as `chore(force-app-desktop): release X.Y.Z` on a branch, push it and open a PR
   titled the same. The PR runs a full Windows release dry run (`force-app-release` workflow:
   freeze, NSIS build, Playwright against the packaged app); its installer is kept as the run's
   `force-app-release-files` artifact, to try on a rig first if the user wants.
5. **Merging is the release.** Tell the user: once this PR is merged to `main`,
   `force-app-release.yml` builds and tests the installer again, waits for main's CI on that
   commit, then creates tag `force-app-vX.Y.Z` and the GitHub Release. Nothing else to run.
   The merge is the user's decision: it ships to every rig within about ten minutes.

## After the merge

- Watch the `force-app-release` run on `main` (Actions tab). Its summary links the Release.
- If it fails, read the job log (a failure in the e2e step uploads `playwright-test-results`),
  fix it in a new PR. The next push to `main` retries the release on its own, or the user
  presses **Actions > force-app-release > Run workflow** on `main` (`make release-force-app`
  does the same from a terminal with `gh`). A tag left by a failed run has no Release and is
  moved to the new commit; nothing shipped from it.
- On d1-server, the `force-app-auto-publish-release` scheduled task polls every 5 minutes and copies
  the release into `infra/force-app-updates/`. It tracks state in `.published-tag` and logs to
  `auto-publish.log`. Rigs update from that feed through electron-updater. "No update offered"
  after more than 10 minutes means checking `auto-publish.log` first
  (`docs/force-app-operations.md`).

## Gotchas

- **What ships is `package.json`'s version on `main`.** A version is released once a GitHub
  Release exists for `force-app-v<version>`; the workflow does nothing on main pushes after that.
  To ship again, bump. A hand-pushed tag still works but must equal that version.
- **Merging a version bump releases it.** Don't bump the version in a PR that isn't meant to ship.
- **The installer filename must not contain spaces** (`artifactName` in `electron-builder.yml`).
  A space broke the update feed once (6f259ab).
- **`electronVersion` in `electron-builder.yml` is pinned.** When Electron is upgraded, update it in
  the same commit (preflight checks this).
- A release can't be un-shipped from rigs that already updated. A bad release is fixed by a new
  patch release, never by deleting the tag or the GitHub Release.
- Hardware-dependent fixes in the changelog (NI-DAQ, Lab Amp, real-rate behaviour) are only proven
  on the rig. Ask the user whether they were checked there before the release goes out.
