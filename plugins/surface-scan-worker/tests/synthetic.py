"""Synthetic topography files for the tests. No real measurement data is ever committed.

SurfaceTopography has no AL3D writer, so :func:`write_al3d` lays out the format by hand, following the
reader's own declarative layout: a magic line, ``Version`` and ``TagCount`` tags, ``TagCount`` further
key/value tags (each 20 + 30 + 2 bytes), then the float32 depth image at ``DepthImageOffset`` with every
row padded to a multiple of 8 bytes.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

_MAGIC = b"AliconaImaging\x00\r\n"


def _tag(key: str, value: object) -> bytes:
    return key.encode().ljust(20, b"\x00") + str(value).encode().ljust(30, b"\x00") + b"\r\n"


def write_al3d(
    path: Path,
    heights_m: np.ndarray,
    pixel_size_x_m: float = 1e-6,
    pixel_size_y_m: float = 1e-6,
    invalid_value: float = -1e30,
) -> Path:
    """Write *heights_m* (rows x cols, metres, NaN or *invalid_value* = no data) as an .al3d file.

    The array is stored row by row, so ``heights_m[0]`` is the first row in the file.
    """
    heights = np.asarray(heights_m, dtype="<f4")
    rows, cols = heights.shape
    row_elements = (cols * 4 + 7) // 8 * 8 // 4
    padded = np.zeros((rows, row_elements), dtype="<f4")
    padded[:, :cols] = heights

    tags = [
        ("Cols", cols),
        ("Rows", rows),
        ("PixelSizeXMeter", repr(float(pixel_size_x_m))),
        ("PixelSizeYMeter", repr(float(pixel_size_y_m))),
        ("InvalidPixelValue", repr(float(invalid_value))),
        ("CreatingApplication", "synthetic test"),
    ]
    header_len = len(_MAGIC) + 52 + 52 + 52 * (len(tags) + 1)  # +1 for DepthImageOffset
    all_tags = [*tags, ("DepthImageOffset", header_len)]
    blob = bytearray(_MAGIC)
    blob += _tag("Version", 2)
    blob += _tag("TagCount", len(all_tags))
    for key, value in all_tags:
        blob += _tag(key, value)
    assert len(blob) == header_len
    blob += padded.tobytes()
    Path(path).write_bytes(bytes(blob))
    return Path(path)


def ramp(rows: int, cols: int, scale_m: float = 1e-6) -> np.ndarray:
    """A deterministic plane: height = (row * cols + col) * scale_m, so the top-left cell is 0."""
    return (np.arange(rows * cols, dtype=np.float64).reshape(rows, cols)) * scale_m


__all__ = ["ramp", "write_al3d"]
