#!/usr/bin/env bash
# List the CI checks that the current change touches, one shell command per line,
# based on files changed against the base ref plus uncommitted work.
# Mirrors .github/workflows/ci.yml; keep the two in step.
#
# Usage: plan_checks.sh [base-ref]   (default origin/main)
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

base="${1:-origin/main}"
git rev-parse -q --verify "$base" >/dev/null || base="$(git rev-list --max-parents=0 HEAD | tail -1)"

files="$( { git diff --name-only "$base"...HEAD; git diff --name-only HEAD; git ls-files --others --exclude-standard; } | sort -u)"
[[ -z "$files" ]] && { echo "# no changes against $base"; exit 0; }

has() { grep -qE "$1" <<<"$files"; }

echo "# changed files against $base: $(wc -l <<<"$files")"
# shellcheck disable=SC2086
echo "pre-commit run --files $(tr '\n' ' ' <<<"$files")"
echo "bash tests/phase0_smoke.sh"

has '^(core/extensions/(d1-geometry-preview|d1-home|d1-report)/|scripts/sync_geometry\.sh)' && {
  echo "bash scripts/sync_geometry.sh --check"
  echo "node --experimental-strip-types --test core/extensions/d1-geometry-preview/test/geometry.test.ts"
}
has '^core/extensions/[^/]+/(index\.js|index\.test\.mjs)' && \
  echo "node --test core/extensions/*/index.test.mjs"
# Standalone extensions (own package-lock.json): CI's `extensions` job installs, builds and tests each.
for d in $(grep -oE '^core/extensions/[^/]+/' <<<"$files" | sort -u); do
  [[ -f "$d/package-lock.json" ]] && echo "(cd $d && npm ci --no-audit --no-fund && npm run build --if-present && npm test --if-present)   # CI: extensions"
done
has '^(db/|tests/phase(1|6|7)_|scripts/ci/)' && {
  echo "bash .claude/skills/db-migration/scripts/verify_migration.sh   # needs a scratch DATABASE_URL"
  echo "bash scripts/ci/migration_roundtrip.sh   # CI: migrations; rolls back ALL, checks leftovers, re-applies"
}

# Service images: CI's `images` job builds each (ci-plan.mjs) and runs its tests inside it.
for p in $(grep -oE '^(plugins|apps/force-app)/[^/]+/' <<<"$files" | sort -u); do
  [[ -f "$p/Dockerfile" ]] || continue
  n="$(basename "$p")"; ctx="$p"; [[ "$n" == diag-service ]] && ctx=.
  echo "docker build -t d1-$n -f ${p}Dockerfile $ctx   # CI: images (tests run inside it, except diag- and filter-service)"
done
has '^plugins/llm-text-to-sql/' && echo "docker run --rm d1-llm-text-to-sql python eval/run_eval.py"
for p in $(grep -oE '^plugins/[^/]+/' <<<"$files" | sort -u | cut -d/ -f2); do
  case "$p" in heavy-data-worker|analysis-worker|llm-text-to-sql) ;; *)
    [[ -d "plugins/$p/tests" ]] && echo "(cd plugins/$p && python -m pytest tests/ -q)" ;;
  esac
done

has '^scripts/.*\.py$|^tests/scripts/' && echo "python -m pytest tests/scripts -q   # CI: script-tests; *_golden_exactly may differ by machine"
# Force app: ci.yml force-app-js / force-app-python run these on PRs; run them before pushing.
has '^packages/force-plotting/' && echo "npm test -w @d1/force-plotting && npm run typecheck -w @d1/force-plotting   # CI: force-app-js"
has '^(apps/force-app/web/|packages/force-plotting/)' && \
  echo "npm test -w force-app-web && npm run typecheck -w force-app-web && npm run lint:theme -w force-app-web   # CI: force-app-js"
has '^apps/force-app/desktop/' && \
  echo "npm test -w force-app-desktop && npm run typecheck -w force-app-desktop   # CI: force-app-js"
has '^core/extensions/d1-force-dashboard/' && echo "npm run build:extension   # CI: force-app-js"
has '^(packages/d1-ui/|core/extensions/(d1-home|d1-lab-dashboard|d1-composition-bar|d1-campaign-ops|d1-project-items|d1-fast-dashboard)/)' && \
  echo "npm test -w @d1/ui && npm run typecheck -w @d1/ui && npm run typecheck -w directus-extension-d1-home -w directus-extension-d1-lab-dashboard -w directus-extension-d1-campaign-ops && npm run build:extensions   # CI: directus-ui"
has '^apps/force-app/backend/' && echo "(cd apps/force-app/backend && pip install -e '.[dev,nidaq]' && python -m pytest -q)   # CI: force-app-python, with the nidaq extra like the release"
for s in backup-server bug-report-relay; do
  has "^apps/force-app/$s/" && echo "(cd apps/force-app/$s && python -m pytest -q)   # CI: force-app-python"
done
has '^(apps/force-app/(backend|web)/|packages/force-plotting/)' && \
  echo "# then the force-app-verify skill: sim recording over HTTP + through the UI"
has '^apps/force-app/desktop/package\.json$|^apps/force-app/web/src/changelog\.ts$' && \
  echo "bash .claude/skills/force-app-release/scripts/preflight.sh --fast   # version/changelog/lockfile agree"
has '^(apps/force-app/desktop/(package\.json|electron-builder\.yml)|apps/force-app/backend/(force-app-backend\.spec|pyproject\.toml))$' && \
  echo "# the PR also runs force-app-release.yml as a Windows dry run; merging a version bump RELEASES it"
exit 0
