"""Copies the physical test backlog into the build as the rig-test catalogue.

Rig test requests (app/rig_test) resolve backlog item ids against the copy of
docs/runbooks/physical-test-backlog.md that was current when the app was built, so the release under
test carries its own items. `force-app-backend.spec` calls `sync()` and bundles the result as
app/rig_test/catalog.md. The copy goes to the (gitignored) PyInstaller build folder, so no second
copy of the backlog is ever committed.

    python scripts/sync_rig_catalog.py [dest_dir]    # default: build/rig_test
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
BACKLOG = BACKEND.parents[2] / "docs" / "runbooks" / "physical-test-backlog.md"


def sync(dest_dir: str | Path | None = None) -> Path:
    """Copy the backlog to <dest_dir>/catalog.md and return that path. A missing backlog fails the
    build: a bundle without it would answer every rig test request with "unknown item"."""
    dest = Path(dest_dir) if dest_dir else BACKEND / "build" / "rig_test"
    if not BACKLOG.is_file():
        raise SystemExit(f"rig-test catalogue source not found: {BACKLOG}")
    dest.mkdir(parents=True, exist_ok=True)
    out = dest / "catalog.md"
    shutil.copyfile(BACKLOG, out)
    return out


if __name__ == "__main__":
    print(sync(sys.argv[1] if len(sys.argv) > 1 else None))
