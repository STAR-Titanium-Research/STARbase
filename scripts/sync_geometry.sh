#!/usr/bin/env bash
# The isometric geometry engine (sample shape drawing) is vendored into three Directus
# extensions because each is built as an independent package:
#   d1-geometry-preview  (canonical source — edit this one)
#   starbase-pages       (packages/starbase-pages; guided sample creator; the Sample page reuses it via pages/sample/SampleGeometry.vue, not a fourth copy)
#   d1-report            (printed report)
#
# It also keeps the choice labels table (Geometry, Surface Finish, Equipment Type, sub-type) in step:
# packages/d1-ui/src/choiceLabels.ts is canonical, and d1-report (not a workspace, so it cannot
# import @d1/ui) gets a byte-identical copy.
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
COPIES=("packages/starbase-pages/src/geometry.ts" "$EXT/d1-report/src/geometry.ts")
LABELS_SRC=packages/d1-ui/src/choiceLabels.ts
LABELS_COPY=$EXT/d1-report/src/choiceLabels.ts
# Files whose CSS styles the generated SVG, and the classes geometry.ts emits. A class counts
# as styled only if it heads a rule (`.cls {`, `.cls,` or `:deep(.cls) {`), not merely appears.
STYLES=("$EXT/d1-geometry-preview/src/GeometryPreview.vue" "packages/starbase-pages/src/register-sample.vue" "packages/starbase-pages/src/pages/sample/SampleGeometry.vue" "$EXT/d1-report/src/render.js")
CLASSES=(gt gl gr gh gdim gext gdimt gsupport gload)

if [[ "${1:-}" != "--check" ]]; then
    for c in "${COPIES[@]}"; do cp "$SRC" "$c"; echo "synced $c"; done
    cp "$LABELS_SRC" "$LABELS_COPY"; echo "synced $LABELS_COPY"
    exit 0
fi

rc=0
for c in "${COPIES[@]}"; do
    cmp -s "$SRC" "$c" || { echo "DRIFT: $c differs from $SRC — run: bash scripts/sync_geometry.sh" >&2; rc=1; }
done
cmp -s "$LABELS_SRC" "$LABELS_COPY" || { echo "DRIFT: $LABELS_COPY differs from $LABELS_SRC — run: bash scripts/sync_geometry.sh" >&2; rc=1; }
for f in "${STYLES[@]}"; do
    for cls in "${CLASSES[@]}"; do
        grep -Eq "\.${cls}\)?[[:space:]]*[{,]" "$f" || { echo "MISSING CSS: .$cls in $f" >&2; rc=1; }
    done
done
[[ $rc -eq 0 ]] && echo "geometry and choice-label copies in sync"
exit $rc
