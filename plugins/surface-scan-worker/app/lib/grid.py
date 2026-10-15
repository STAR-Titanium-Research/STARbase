"""Height grids: NaN-aware block-mean decimation, the on-disk layout, and the thumbnail.

Convention for every array here: ``(rows, cols)``, row 0 is the top row, values in micrometres,
``NaN`` is "no data". SurfaceTopography's ``heights()`` is indexed ``[x, y]``, so the reader module
hands over its transpose.
"""

from __future__ import annotations

import io
import json
import math

import numpy as np
from PIL import Image

#: Longest side of the grid written to MinIO, in cells.
MAX_GRID_SIDE = 1024
#: Longest side of the thumbnail, in pixels.
MAX_THUMB_SIDE = 320
#: Rows of the source processed at once (bounds the float32 temporaries on a huge scan).
_STRIP_CELLS = 16_000_000

# Viridis at 17 evenly spaced stops (perceptually uniform, readable in greyscale); the thumbnail
# interpolates between them so the worker needs no plotting library.
_RAMP = np.array(
    [
        (68, 1, 84),
        (72, 26, 108),
        (71, 47, 125),
        (65, 68, 135),
        (57, 86, 140),
        (47, 104, 142),
        (40, 120, 142),
        (33, 135, 141),
        (31, 150, 139),
        (34, 167, 133),
        (53, 183, 121),
        (84, 197, 104),
        (122, 209, 81),
        (165, 219, 54),
        (210, 226, 27),
        (248, 230, 33),
        (253, 231, 37),
    ],
    dtype=np.float64,
)


def decimation_factor(rows: int, cols: int, max_side: int = MAX_GRID_SIDE) -> int:
    """Smallest integer block size that brings the longer side to at most *max_side* cells."""
    return max(1, math.ceil(max(rows, cols) / max_side))


def block_mean(source: np.ma.MaskedArray | np.ndarray, factor: int) -> np.ndarray:
    """Mean of each ``factor`` x ``factor`` block, ignoring masked and non-finite cells.

    Output shape is ``ceil(rows / factor), ceil(cols / factor)`` (edge blocks average the cells they
    have); a block with no valid cell is ``NaN``. float32 out; *source* may be a masked array.
    """
    rows, cols = source.shape
    out_rows, out_cols = math.ceil(rows / factor), math.ceil(cols / factor)
    out = np.full((out_rows, out_cols), np.nan, dtype=np.float32)
    strip_blocks = max(1, _STRIP_CELLS // max(1, factor * cols))
    for r0 in range(0, out_rows, strip_blocks):
        r1 = min(out_rows, r0 + strip_blocks)
        strip = source[r0 * factor : min(rows, r1 * factor)]
        values = np.ma.filled(np.ma.asarray(strip), np.nan).astype(np.float64)
        values[~np.isfinite(values)] = np.nan
        pad_r = (r1 - r0) * factor - values.shape[0]
        pad_c = out_cols * factor - cols
        if pad_r or pad_c:
            values = np.pad(values, ((0, pad_r), (0, pad_c)), constant_values=np.nan)
        blocks = values.reshape(r1 - r0, factor, out_cols, factor)
        valid = np.isfinite(blocks)
        count = valid.sum(axis=(1, 3))
        total = np.where(valid, blocks, 0.0).sum(axis=(1, 3))
        with np.errstate(invalid="ignore", divide="ignore"):
            out[r0:r1] = np.where(count > 0, total / np.maximum(count, 1), np.nan)
    return out


def decimate(source: np.ma.MaskedArray | np.ndarray) -> tuple[np.ndarray, int]:
    """The grid to store: *source* block-averaged to at most :data:`MAX_GRID_SIDE` cells on the
    longer side (aspect kept). Returns ``(grid float32, factor)``."""
    rows, cols = source.shape
    factor = decimation_factor(rows, cols)
    return block_mean(source, factor), factor


def grid_bytes(grid: np.ndarray) -> bytes:
    """``grid.bin``: float32 little-endian, row-major, top row first, NaN = no data."""
    return np.ascontiguousarray(grid, dtype="<f4").tobytes()


def height_range(grid: np.ndarray) -> tuple[float, float]:
    """(min, max) of the valid cells; ValueError when there are none."""
    finite = grid[np.isfinite(grid)]
    if finite.size == 0:
        raise ValueError("no valid height values")
    return float(finite.min()), float(finite.max())


def meta_bytes(
    *,
    grid: np.ndarray,
    factor: int,
    pitch_x_um: float,
    pitch_y_um: float,
    source_width: int,
    source_height: int,
    source_format: str,
) -> bytes:
    """``meta.json``: everything a viewer needs to place and colour ``grid.bin``.

    ``pixel_pitch_*_um`` is the pitch of the stored grid (the source pitch times the block size).
    """
    z_min, z_max = height_range(grid)
    meta = {
        "width": int(grid.shape[1]),
        "height": int(grid.shape[0]),
        "pixel_pitch_x_um": pitch_x_um * factor,
        "pixel_pitch_y_um": pitch_y_um * factor,
        "z_min_um": z_min,
        "z_max_um": z_max,
        "source_width": int(source_width),
        "source_height": int(source_height),
        "source_format": source_format,
        "decimation": {"method": "block-mean-nan-aware", "factor": int(factor)},
    }
    return json.dumps(meta, allow_nan=False, separators=(",", ":")).encode()


def thumbnail_png(grid: np.ndarray) -> bytes:
    """``thumb.png``: the height map in the colour ramp, at most :data:`MAX_THUMB_SIDE` px on the
    longer side, ``NaN`` cells transparent. Colours stretch from the 1st to the 99th percentile so a
    single spike does not wash the scan out."""
    factor = decimation_factor(*grid.shape, max_side=MAX_THUMB_SIDE)
    small = block_mean(grid, factor) if factor > 1 else grid
    valid = np.isfinite(small)
    rgba = np.zeros((*small.shape, 4), dtype=np.uint8)
    if valid.any():
        lo, hi = np.percentile(small[valid], [1, 99])
        span = hi - lo if hi > lo else 1.0
        t = np.clip((small[valid].astype(np.float64) - lo) / span, 0.0, 1.0)
        stops = np.linspace(0.0, 1.0, len(_RAMP))
        for channel in range(3):
            rgba[..., channel][valid] = np.round(
                np.interp(t, stops, _RAMP[:, channel])
            ).astype(np.uint8)
        rgba[..., 3][valid] = 255
    buf = io.BytesIO()
    Image.fromarray(rgba).save(buf, format="PNG", optimize=True)
    return buf.getvalue()
