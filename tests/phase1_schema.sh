#!/usr/bin/env bash
# Phase 1 schema test: verifies migrations apply, views exist, triggers fire,
# seed data loads, and code-generation functions return correct output.
# Requires a running Postgres with DATABASE_URL set, or a local stack via `make up`.
#
# The checks live in tests/schema/<NNN>-<feature>.sh, one file per feature, run in filename
# order in this one shell (so a section can rely on what an earlier one left in the database,
# and the test rows are cleaned up by 900-cleanup.sh). The harness they share is
# tests/schema/lib.sh. To add checks for a new migration, add a file; to run one file alone,
# name part of it in ONLY.
#
# Usage:  DATABASE_URL=postgres://d1:secret@localhost:5432/d1_test bash tests/phase1_schema.sh
#         ONLY=inbox bash tests/phase1_schema.sh        (only the files whose name contains "inbox")
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

# shellcheck source=tests/schema/lib.sh
source tests/schema/lib.sh

ran=0
for section in tests/schema/[0-9]*.sh; do
    [[ -z "${ONLY:-}" || "$section" == *"$ONLY"* ]] || continue
    # shellcheck source=/dev/null
    source "$section"
    ran=$((ran+1))
done
[[ $ran -gt 0 ]] || { echo "no section file matches ONLY=$ONLY"; exit 2; }

echo
echo "Results: $pass passed, $fail failed"
[[ $fail -eq 0 ]] || exit 1
echo "Phase 1 schema OK."
