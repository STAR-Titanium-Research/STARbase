#!/usr/bin/env bash
# The isometric geometry engine (sample shape drawing) is vendored into three Directus
# extensions because each is built as an independent package:
#   d1-geometry-preview  (canonical source — edit this one)
#   d1-home              (guided sample creator; the Sample page reuses it, not a fourth copy)
#   d1-report            (printed report)
#
# Usage:
#   bash scripts/sync_geometry.sh           copy the canonical geometry.ts into the other two
#   bash scripts/sync_geometry.sh --check   fail if a copy has drifted, or a stylesheet that
#                                           renders the SVG lacks one of the drawing classes
#                                           (pre-commit + CI run this)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

EXT=core/extensions
SRC=$EXT/d1-geometry-preview/src/geometry.ts
COPIES=("$EXT/d1-home/src/geometry.ts" "$EXT/d1-report/src/geometry.ts")
# Files whose CSS styles the generated SVG, and the classes geometry.ts emits. A class counts
# as styled only if it heads a rule (`.cls {`, `.cls,` or `:deep(.cls) {`), not merely appears.
STYLES=("$EXT/d1-geometry-preview/src/GeometryPreview.vue" "$EXT/d1-home/src/register-sample.vue" "$EXT/d1-home/src/pages/sample/SampleOverview.vue" "$EXT/d1-report/src/render.js")
CLASSES=(gt gl gr gh gdim gext gdimt gsupport gload)

if [[ "${1:-}" != "--check" ]]; then
    for c in "${COPIES[@]}"; do cp "$SRC" "$c"; echo "synced $c"; done
    exit 0
fi

rc=0
for c in "${COPIES[@]}"; do
    cmp -s "$SRC" "$c" || { echo "DRIFT: $c differs from $SRC — run: bash scripts/sync_geometry.sh" >&2; rc=1; }
done
for f in "${STYLES[@]}"; do
    for cls in "${CLASSES[@]}"; do
        grep -Eq "\.${cls}\)?[[:space:]]*[{,]" "$f" || { echo "MISSING CSS: .$cls in $f" >&2; rc=1; }
    done
done
[[ $rc -eq 0 ]] && echo "geometry copies in sync"
exit $rc
