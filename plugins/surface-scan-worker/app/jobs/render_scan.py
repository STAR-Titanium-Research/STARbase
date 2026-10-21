"""The rq job: render one ``surface_scans`` row.

pending -> rendering -> done | failed. Resolves the file from ``directus_files.metadata.archive_path``
under the read-only archive mount, reads it with SurfaceTopography, writes ``grid.bin``,
``thumb.png`` and ``meta.json`` (last, so its presence marks a complete render) under
``surface-scans/<cache_key>/`` and fills the row's render columns. A cache hit on the key skips the
read of the file altogether.
"""

from __future__ import annotations

import functools
import json
import logging
import os
from datetime import UTC, datetime

from app.lib import archive, directus_client, grid, minio_client, topography
from app.lib.archive import RenderError
from app.lib.cache_key import cache_key, object_keys
from app.lib.directus_client import VersionConflictError
from app.lib.statuses import (
    STATUS_DONE,
    STATUS_FAILED,
    STATUS_PENDING,
    STATUS_RENDERING,
)

log = logging.getLogger(__name__)

#: Columns the worker may copy from meta.json onto the row (meta key -> column).
_META_COLUMNS = {
    "source_format": "source_format",
    "source_width": "source_width",
    "source_height": "source_height",
    "width": "grid_width",
    "height": "grid_height",
    "pixel_pitch_x_um": "pixel_pitch_x_um",
    "pixel_pitch_y_um": "pixel_pitch_y_um",
    "z_min_um": "z_min_um",
    "z_max_um": "z_max_um",
}

_ERROR_LIMIT = 500


def render_scan(scan_id: str) -> None:
    """Render *scan_id* if it is still ``pending``; otherwise do nothing (another job has it)."""
    row = directus_client.get_scan(scan_id)
    if row.get("render_status") != STATUS_PENDING:
        log.info("skip scan=%s status=%s", scan_id, row.get("render_status"))
        return
    try:
        directus_client.patch_scan(
            scan_id,
            {"render_status": STATUS_RENDERING, "render_error": None},
            version=row["version"],
        )
    except VersionConflictError:
        log.info("skip scan=%s: claimed by another job", scan_id)
        return

    log.info("start scan=%s file=%s", scan_id, row.get("directus_files_id"))
    try:
        columns = _render(row["directus_files_id"])
        _finish(
            scan_id, {**columns, "render_status": STATUS_DONE, "render_error": None}
        )
        log.info("done scan=%s key=%s", scan_id, columns["cache_key"])
    except Exception as err:
        log.exception("failed scan=%s", scan_id)
        _finish(
            scan_id, {"render_status": STATUS_FAILED, "render_error": _message(err)}
        )
        raise


def _message(err: Exception) -> str:
    text = (
        str(err)
        if isinstance(err, RenderError)
        else f"Unexpected error: {type(err).__name__}: {err}"
    )
    return text[:_ERROR_LIMIT]


def _finish(scan_id: str, payload: dict) -> None:
    """Write the terminal state, unless the row left ``rendering`` meanwhile (someone reset it)."""

    def compute(current: dict) -> dict | None:
        return payload if current.get("render_status") == STATUS_RENDERING else None

    try:
        directus_client.update_scan(scan_id, compute)
    except Exception:
        log.exception("could not write the final state of scan=%s", scan_id)
        if payload.get("render_status") == STATUS_DONE:
            raise


def _render(directus_files_id: str) -> dict:
    """Produce the render (or find it in the cache) and return the row's columns for it."""
    file_row = directus_client.get_file(directus_files_id)
    if file_row.get("storage") != "star":
        raise RenderError(
            "The file is not on the archive share; only archive files are rendered."
        )
    archive_path = (file_row.get("metadata") or {}).get("archive_path")
    archive.check_identity(file_row.get("id"), archive_path)
    owner = (file_row.get("owner_person_id"), file_row.get("owner_team_id"))
    team_folders = functools.cache(lambda: directus_client.get_team_folders())
    archive.check_owner_stamped(archive_path, *owner, team_folders)
    path = archive.resolve(archive_path)
    # A link inside the archive can lead from a harmless folder into someone's: check where it lands too.
    root = os.path.realpath(archive.ARCHIVE_ROOT)
    archive.check_owner_stamped(os.path.relpath(path, root), *owner, team_folders)
    st = archive.stat_file(path)

    key = cache_key(
        directus_files_id,
        directus_client.get_fingerprint(directus_files_id),
        st.st_size,
        st.st_mtime,
    )
    keys = object_keys(key)

    cached = _cached_meta(keys)
    if cached is not None:
        log.info("cache hit key=%s", key)
        return _columns(key, cached)

    scan = topography.read_scan(
        path, st
    )  # refused if the file is no longer the one stat-ed
    cells, factor = grid.decimate(scan.heights_um)
    try:
        meta = grid.meta_bytes(
            grid=cells,
            factor=factor,
            pitch_x_um=scan.pixel_pitch_x_um,
            pitch_y_um=scan.pixel_pitch_y_um,
            source_width=scan.width,
            source_height=scan.height,
            source_format=scan.source_format,
        )
    except ValueError as err:
        raise RenderError(
            "The file has no valid height values (every cell is no-data)."
        ) from err

    minio_client.put_object(keys["grid"], grid.grid_bytes(cells))
    minio_client.put_object(keys["thumb"], grid.thumbnail_png(cells), "image/png")
    minio_client.put_object(keys["meta"], meta, "application/json")
    return _columns(key, json.loads(meta))


def _cached_meta(keys: dict[str, str]) -> dict | None:
    """meta.json of a complete earlier render, or None (any of the three objects missing or unreadable)."""
    raw = minio_client.get_object_bytes(keys["meta"])
    if raw is None:
        return None
    if not (
        minio_client.object_exists(keys["grid"])
        and minio_client.object_exists(keys["thumb"])
    ):
        return None
    try:
        meta = json.loads(raw)
    except ValueError:
        return None
    return meta if all(k in meta for k in _META_COLUMNS) else None


def _columns(key: str, meta: dict) -> dict:
    out = {column: meta[name] for name, column in _META_COLUMNS.items()}
    out["cache_key"] = key
    out["rendered_at"] = datetime.now(UTC).isoformat()
    return out
