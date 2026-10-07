#!/usr/bin/env bash
# Run what force-app-release.yml runs, as far as Linux allows, before a force-app-v* tag is
# pushed. The Windows-only steps (PyInstaller freeze, NSIS packaging, Playwright against the
# packaged app) are listed as not run. Exit 0 = nothing here would fail the release job.
#
# Usage: preflight.sh [--fast]    (--fast: version checks only, no test runs)
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

fail=0; notrun=()
ok()  { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
run() { local name="$1"; shift; if (cd "$1" && shift && eval "$@") >/tmp/fa-preflight.log 2>&1; then ok "$name"; else bad "$name (log: /tmp/fa-preflight.log)"; tail -15 /tmp/fa-preflight.log; fi; }

v="$(node -p "require('./apps/force-app/desktop/package.json').version")"
echo "== version $v"
lock="$(node -p "require('./package-lock.json').packages['apps/force-app/desktop'].version")"
[[ "$lock" == "$v" ]] && ok "package-lock.json agrees ($lock)" || bad "package-lock.json has $lock: run npm install --package-lock-only"
top="$(grep -m1 -oE "version: '[^']+'" apps/force-app/web/src/changelog.ts | cut -d"'" -f2)"
[[ "$top" == "$v" ]] && ok "changelog.ts top entry is $v" || bad "changelog.ts top entry is $top, not $v"
if git ls-remote --exit-code --tags origin "force-app-v$v" >/dev/null 2>&1 || git rev-parse -q --verify "refs/tags/force-app-v$v" >/dev/null; then
  bad "tag force-app-v$v already exists: bump the version"
else ok "tag force-app-v$v is free"; fi
eb="$(grep -oE 'electronVersion:\s*[0-9.]+' apps/force-app/desktop/electron-builder.yml | grep -oE '[0-9.]+$')"
inst="$(node -p "require('electron/package.json').version" 2>/dev/null || echo '?')"
[[ "$eb" == "$inst" ]] && ok "electron-builder electronVersion matches installed electron ($eb)" \
  || bad "electron-builder.yml electronVersion $eb vs installed electron $inst"
[[ -z "$(git status --porcelain -- apps/force-app packages/force-plotting package-lock.json)" ]] \
  && ok "no uncommitted force-app changes" || bad "uncommitted changes under apps/force-app or packages/force-plotting"

[[ "${1:-}" == "--fast" ]] && { echo; echo "$fail failed (version checks only)"; exit $((fail>0)); }

echo "== tests and builds (the Linux-runnable part of the release job)"
py=apps/force-app/backend/.venv/bin/python
[[ -x "$py" ]] || { python3 -m venv apps/force-app/backend/.venv && apps/force-app/backend/.venv/bin/pip install -q -e "apps/force-app/backend[dev]"; }
py="$PWD/$py"
run "build:web:desktop"            .                              npm run build:web:desktop
run "backend pytest"               apps/force-app/backend         "$py" -m pytest -q
run "backup-server pytest"         apps/force-app/backup-server   "$py" -m pytest -q
run "desktop build (tsc)"          apps/force-app/desktop         npm run build
# The sidecar stop() test is skipped off Windows (it needs taskkill); the release runner runs it.
run "desktop vitest + typecheck"   apps/force-app/desktop         "npm test && npm run typecheck"
# Not in the release job (ci.yml's force-app-js runs them on PRs): check them here too.
run "web vitest + typecheck + theme lint" . "npm test -w force-app-web && npm run typecheck -w force-app-web && npm run lint:theme -w force-app-web"
run "force-plotting vitest + typecheck"   . "npm test -w @d1/force-plotting && npm run typecheck -w @d1/force-plotting"

notrun+=("PyInstaller freeze (force-app-backend.spec)" "electron-builder --win (NSIS)" "npm run test:e2e against the packaged app" "desktop sidecar stop() test (taskkill)")
echo; echo "Not run here (Windows release runner only):"; printf '  - %s\n' "${notrun[@]}"
echo; echo "$fail failed"
exit $((fail>0))
