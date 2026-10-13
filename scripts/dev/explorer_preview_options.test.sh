#!/usr/bin/env bash
# Checks the preview's option plumbing without starting anything: the script must parse, and its
# docker run line must carry the env file, the public-URL override and the extra extensions loop.
set -euo pipefail
cd "$(dirname "$0")/../.."
S=scripts/dev/explorer_preview.sh
bash -n "$S"
grep -q 'D1_PREVIEW_ENV_FILE' "$S"
grep -q 'D1_PREVIEW_PUBLIC_URL' "$S"
grep -q 'D1_PREVIEW_EXTRA_EXT' "$S"
grep -q '"${ENV_ARGS\[@\]}"' "$S"
grep -q 'PUBLIC_URL="$PUBLIC"' "$S"
echo "preview options: ok"
