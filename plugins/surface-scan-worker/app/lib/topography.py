"""Read a topography file with SurfaceTopography into a micrometre height array.

Only what the file states is used: its lateral sizes, its length unit and its heights. A file that
states no unit, or that is not a 2D uniform height map (a line scan, a point cloud), is refused
rather than guessed at.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
from SurfaceTopography import open_topography

from app.lib import archive
from app.lib.archive import RenderRefused

try:  # SurfaceTopography exceptions that mean "this file is not what its extension says"
    from SurfaceTopography.Exceptions import CorruptFile, FileFormatMismatch, ReadFileError

    _FILE_ERRORS: tuple[type[Exception], ...] = (CorruptFile, FileFormatMismatch, ReadFileError)
except ImportError:  # pragma: no cover - older library
    _FILE_ERRORS = ()


@dataclass
class Scan:
    """A source height map, ``(rows, cols)`` with row 0 on top, in micrometres."""

    heights_um: np.ma.MaskedArray
    pixel_pitch_x_um: float
    pixel_pitch_y_um: float
    source_format: str

    @property
    def width(self) -> int:
        return int(self.heights_um.shape[1])

    @property
    def height(self) -> int:
        return int(self.heights_um.shape[0])


def read_scan(path: Path) -> Scan:
    """Open *path* read-only and return its default channel in micrometres.

    :class:`RenderRefused` for a file the library cannot read or that is not a 2D height map.
    """
    fmt = archive.format_for(path.name)
    with archive.open_readonly(path) as handle:
        try:
            reader = open_topography(handle, format=fmt)
            topography = reader.topography()
            source_format = reader.format()
            return _to_scan(topography, source_format)
        except RenderRefused:
            raise
        except _FILE_ERRORS as err:
            raise RenderRefused(f"The file could not be read as {fmt}: {err}") from err
        except Exception as err:  # noqa: BLE001 - readers raise assorted errors on bad input
            raise RenderRefused(f"The file could not be read as {fmt}: {type(err).__name__}: {err}") from err


def _to_scan(topography, source_format: str) -> Scan:
    if topography.dim != 2 or not topography.is_uniform:
        raise RenderRefused("The file is not a 2D uniform height map (a line scan or point cloud).")
    if not topography.unit:
        raise RenderRefused("The file does not state its length unit, so the scale is unknown.")
    try:
        in_um = topography.to_unit("um")
    except Exception as err:  # noqa: BLE001
        raise RenderRefused(f"The file's length unit cannot be converted to micrometres: {err}") from err

    nx, ny = in_um.nb_grid_pts
    size_x, size_y = in_um.physical_sizes
    # heights() is [x, y]; transpose to (rows = y, cols = x). y = 0 is the first row of the file, the top.
    heights = np.ma.asarray(in_um.heights()).T
    return Scan(
        heights_um=heights,
        pixel_pitch_x_um=float(size_x) / int(nx),
        pixel_pitch_y_um=float(size_y) / int(ny),
        source_format=source_format,
    )
