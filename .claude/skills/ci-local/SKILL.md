---
name: ci-local
description: Use before committing or pushing D1-Database changes, or when asked whether a branch is ready for a PR. Works out which CI jobs the changed files touch, runs them locally, fixes what fails, and drafts a Conventional Commit message. CONTRIBUTING requires tests to run before commit, not to be discovered in CI.
argument-hint: [base-ref, default origin/main]
---

# Run CI locally

Goal: when this finishes, pushing won't turn CI red. Every check either passed, or you say plainly
that it couldn't run here and why.

## Checks for this change

!`git fetch -q origin main 2>/dev/null; bash .claude/skills/ci-local/scripts/plan_checks.sh $ARGUMENTS`

Run each command above. Where one fails:
- Fix the cause in the change and re-run that check. Never skip, weaken or delete a test to get
  green.
- If it fails on `origin/main` as well, say so and leave it, rather than widening this change.
- If the tool is missing (no Docker daemon, no `pre-commit`, no DB), try the nearest equivalent:
  `pip install pre-commit`; run `pytest` from the plugin folder instead of in Docker; use
  `.claude/skills/db-migration/scripts/scratch_pg.sh` for a database. If nothing works, report the
  check as **not run**, not passed.

## Before you call it done

- **Tests ship with the change.** If behaviour changed and no test changed, write one. Schema
  goes in `tests/phase1_schema.sh`, plugins in `plugins/<name>/tests/`, scripts in `tests/scripts/`.
- **Docs that describe what changed are updated** in the same change: `docs/data-dictionary.md`
  for schema, the spec's Status line and its `docs/superpowers/README.md` row when a feature ships,
  the `plan.md` status tracker when a phase completes, and an ADR for a hard-to-reverse decision
  (`adr` skill).
- **Nothing that must stay out of git is staged**: `.env`, tokens, real lab data, files over 2 MB.
  Experimental data belongs in MinIO.
- **Infrastructure as code.** If the change needs a manual step (Directus UI click, `psql` edit,
  one-off script), it isn't done. Put it in a migration, `core/apply.sh` or compose.

## Commit message

Draft one in [Conventional Commits](https://www.conventionalcommits.org/) form, scoped by area.
Follow the repo's history: !`git log --no-merges --format=%s -6 origin/main 2>/dev/null`

```
feat(db): add hardness_hv column to physical_samples

<why, in a sentence or two — the incident, spec or ADR it serves>
```

Types: `feat` `fix` `docs` `chore` `refactor` `test` `ci` `build` (history also uses `style`).
Common scopes: `db`, `schema`, `seeds`, `geometry`, `force-app`, `force-plotting`, `diag`, a plugin name.

Report what ran and what passed, what was fixed, and anything not run. Don't commit or push
unless you were asked to.

## Gotchas

- `tests/scripts/**/*_golden_exactly` compare byte-for-byte with fixtures frozen on the
  maintainer's machine. A failure after a numpy/scipy version difference isn't proof of a bug.
  Read `tests/scripts/diag/regenerate_goldens.py` before regenerating anything, and never
  regenerate to hide a real diff.
- The geometry engine is vendored into `d1-geometry-preview`, `d1-home` and `d1-report`. Edit
  the canonical copy in `d1-geometry-preview`, then run
  `bash scripts/sync_geometry.sh`. A hand-edit to one copy fails the pre-commit hook and CI.
- `phase3_api.sh`, `phase4_heavy_data.sh` and `tests/ui/` need the full stack and aren't in CI. Run
  them when you change RBAC, the API or the upload pipeline and the stack is available. Otherwise
  list them as not run.
