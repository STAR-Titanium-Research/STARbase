#!/usr/bin/env bash
# Phase 0 smoke test: validates the repository foundation.
# Exits non-zero on any failure so CI fails loudly. Run: bash tests/phase0_smoke.sh
set -uo pipefail

# Resolve repo root (parent of this script's dir) regardless of CWD.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

pass=0
fail=0
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }

echo "== Required files =="
for f in \
  README.md plan.md system_requirements_specification.md NOTICE.md \
  CONTRIBUTING.md SECURITY.md Makefile docker-compose.yml .env.example \
  .gitignore .editorconfig .pre-commit-config.yaml \
  docs/adr/0001-postgres-as-durable-core.md \
  docs/adr/0002-directus-as-swappable-adapter.md \
  docs/adr/0003-trigger-based-immutable-audit.md \
  docs/legacy-data-analysis.md docs/experiment-sheets-and-naming.md
do
  [[ -f "$f" ]] && ok "$f" || bad "missing file: $f"
done

echo "== Required directories =="
for d in db db/migrations db/seeds core plugins infra infra/backup \
         docs docs/adr docs/runbooks tests \
         plugins/heavy-data-worker plugins/llm-text-to-sql \
         plugins/plugin-template plugins/analysis-worker
do
  [[ -d "$d" ]] && ok "$d/" || bad "missing dir: $d/"
done

echo "== .env.example covers compose variables =="
# Every ${VAR...} referenced in compose must be documented in .env.example.
# Strip comment lines first so example vars in comments aren't counted.
compose_vars="$(grep -vE '^[[:space:]]*#' docker-compose.yml \
  | grep -oE '\$\{[A-Z0-9_]+' | sed 's/^..//' | sort -u)"
for v in $compose_vars; do
  if grep -qE "^${v}=" .env.example; then ok ".env.example documents $v"
  else bad ".env.example missing $v"; fi
done

echo "== No secrets committed =="
if [[ -f .env ]] && git ls-files --error-unmatch .env >/dev/null 2>&1; then
  bad ".env is tracked by git (must be ignored)"
else
  ok ".env is not tracked"
fi

echo "== docker-compose.yml validates =="
if command -v docker >/dev/null 2>&1; then
  # Required secrets use ${VAR:?} in compose, so validate against a throwaway env file
  # (never a real .env) holding a dummy value for each of them.
  tmp_env="$(mktemp)"
  trap 'rm -f "$tmp_env"' EXIT
  for v in POSTGRES_PASSWORD MINIO_ROOT_PASSWORD DIRECTUS_KEY DIRECTUS_SECRET \
           DIRECTUS_ADMIN_PASSWORD WORKER_WEBHOOK_SECRET REDIS_PASSWORD; do
    echo "$v=smoke-test-dummy-value" >> "$tmp_env"
  done
  if docker compose --env-file "$tmp_env" config -q >/dev/null 2>&1; then ok "docker compose config -q (test env)"
  else bad "docker compose config failed with a complete test env"; fi
  # Fail closed: with no secrets set, compose must refuse rather than fall back to defaults.
  if docker compose --env-file /dev/null config -q >/dev/null 2>&1; then
    bad "docker compose config succeeded with no secrets (a \${VAR:?} guard is missing)"
  else ok "docker compose config fails closed without secrets"; fi
else
  echo "  SKIP docker not available"
fi

echo
echo "Results: $pass passed, $fail failed"
[[ $fail -eq 0 ]] || exit 1
echo "Phase 0 foundation OK."
