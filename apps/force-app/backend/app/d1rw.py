"""D1RW raw capture file — the append-only source of truth during a run.

Design (see the 2a spec's buffering note): the acquisition consumer appends every chunk here as
raw float32 rows; finalize() reads it back in fixed-size blocks (read_rows), so its memory is
constant however long the capture ran -- never read-it-all-into-RAM.

Layout: a FIXED 32-byte LE header so the body is memmap-able without parsing channel names:
    magic 'D1RW' (4s) | version u32 | n_cols u32 | rate f32 | start_unix f64 | pad(8)
then interleaved float32 rows of n_cols columns. Column 0 is Time (s); columns 1..n_cols-1 are the
signal channels in SIGNAL_CHANNELS order. Channel names + n_rows live in summary.json (kept out of
the header to keep it fixed-size and memmap-friendly).
"""

from __future__ import annotations

import os
import struct

import numpy as np

MAGIC = b"D1RW"
HEADER_SIZE = 32
_HEADER = "<4sIIfd"  # 4 + 4 + 4 + 4 + 8 = 24, then 8 pad bytes to reach 32


def pack_header(n_cols: int, rate: float, start_unix: float) -> bytes:
    head = struct.pack(_HEADER, MAGIC, 1, n_cols, float(rate), float(start_unix))
    return head + b"\x00" * (HEADER_SIZE - len(head))


class RawWriter:
    """Append-only writer for the raw capture. One instance per run."""

    def __init__(self, path: str, n_cols: int, rate: float, start_unix: float):
        self.path = path
        self.n_cols = n_cols
        self._fh = open(path, "wb")
        self._fh.write(pack_header(n_cols, rate, start_unix))
        self._rows = 0
        self._since_sync = 0

    def append(self, t: np.ndarray, data: np.ndarray) -> None:
        """t: (n,) seconds; data: (n, n_cols-1) signal columns."""
        n = t.shape[0]
        block = np.empty((n, self.n_cols), dtype="<f4")
        block[:, 0] = t
        block[:, 1:] = data
        self._fh.write(block.tobytes())
        self._rows += n
        self._since_sync += n
        # Periodic fsync so a crash mid-run still leaves a recoverable file.
        if self._since_sync >= 200_000:
            self._fh.flush()
            os.fsync(self._fh.fileno())
            self._since_sync = 0

    @property
    def rows(self) -> int:
        return self._rows

    def close(self) -> None:
        if self._fh and not self._fh.closed:
            self._fh.flush()
            os.fsync(self._fh.fileno())
            self._fh.close()


def read_header(path: str) -> dict:
    with open(path, "rb") as f:
        raw = f.read(HEADER_SIZE)
    magic, version, n_cols, rate, start_unix = struct.unpack_from(_HEADER, raw, 0)
    if magic != MAGIC:
        raise ValueError(f"bad D1RW magic {magic!r}")
    return {"version": version, "n_cols": n_cols, "rate": rate, "start_unix": start_unix}


def row_count(path: str, n_cols: int | None = None) -> int:
    """Complete rows in the body. A crash mid-append can leave a partial trailing row; it is not
    counted (and so never read)."""
    if n_cols is None:
        n_cols = read_header(path)["n_cols"]
    return (os.path.getsize(path) - HEADER_SIZE) // (n_cols * 4)


def read_rows(path: str, start: int, stop: int, n_cols: int) -> np.ndarray:
    """Rows [start, stop) as an owned (m, n_cols) float32 array.

    A plain read rather than a slice of memmap_rows: a mapping's touched pages stay in the
    process's resident set (Windows' working set) until it is unmapped, so walking a 12 GB capture
    through one grows the process by the file's size even though no array ever holds it.
    """
    with open(path, "rb") as f:
        f.seek(HEADER_SIZE + start * n_cols * 4)
        block = np.fromfile(f, dtype="<f4", count=max(0, stop - start) * n_cols)
    return block.reshape(-1, n_cols)


def memmap_rows(path: str) -> np.ndarray:
    """Memory-map the body as a (n_rows, n_cols) float32 view — no full read into RAM."""
    hdr = read_header(path)
    n_cols = hdr["n_cols"]
    n_rows = row_count(path, n_cols)
    return np.memmap(path, dtype="<f4", mode="r", offset=HEADER_SIZE, shape=(n_rows, n_cols))
