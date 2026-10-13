#!/usr/bin/env bash
# Two previews (two sessions) must never touch each other's files: every per-preview path depends
# on D1_PREVIEW_NAME, and the default name keeps today's paths. Starts nothing.
set -euo pipefail
cd "$(dirname "$0")/../.."
S=scripts/dev/explorer_preview.sh
bash -n "$S"
fail() { echo "FAIL: $1"; exit 1; }
grep -qF 'if [[ "$NAME" == d1-preview ]]; then SUFFIX=""; else SUFFIX="-$NAME"; fi' "$S" || fail "no per-name suffix"
grep -qF 'CREDS=.superpowers/preview-credentials${SUFFIX}.txt' "$S" || fail "credentials path is not per name"
grep -qF 'EXT_DIR=.superpowers/preview-extensions${SUFFIX}' "$S" || fail "extensions path is not per name"
grep -qF 'RESP=.superpowers/preview-resp${SUFFIX}.json' "$S" || fail "response path is not per name"
if grep -qF '.superpowers/preview-resp.json' "$S"; then fail "a fixed response path is left"; fi
if grep -qE '^CREDS=\.superpowers/preview-credentials\.txt$' "$S"; then fail "a fixed credentials path is left"; fi
echo "preview isolation: ok"
