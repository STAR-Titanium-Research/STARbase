"""Surface scans (Alicona .al3d): tagged by extension alone, no pixel work (spec section 7)."""

from __future__ import annotations

from . import fs_readonly
from .kinds import Classification


def classify_scan(
    name: str, extensions=fs_readonly.SCAN_EXTENSIONS
) -> Classification | None:
    """kind 'surface_scan', confidence 1.0, nothing extracted, when the extension is on the config list."""
    if fs_readonly.extension(name) in extensions:
        return Classification("surface_scan", 1.0, {}, "extension")
    return None
