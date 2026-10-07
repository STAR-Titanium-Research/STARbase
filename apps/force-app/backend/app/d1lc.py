"""D1LC live-cache writer — byte-identical to plugins/filter-service/app/d1lc.py,
scripts/matlab/process_force.m::write_live_cache, and the client parser liveCache.ts.

32-byte LE header (magic 'D1LC', version, N, Fs, feed, diam, cs_sec, ce_sec) then six
float32[N] arrays t, Fx, Fy, Fz, rpm, revs_cum. Version 1 (no extras) is byte-identical to
before this file gained the `extras` parameter. Version 2 appends a trailer of named
float32[N] arrays -- see docs/superpowers/specs/2026-09-07-milling-path-models-and-polar-design.md #4.
Writing this format means the finished cut renders through the existing FrmCloud/ForceChart
with no new display code.
"""

from __future__ import annotations

import struct

import numpy as np

MAGIC = 0x44314C43  # 'D1LC'

# Names a reader (this module, and liveCache.ts) will actually populate from a v2 trailer.
# Writers may write any name; readers ignore names outside this set (forward compatibility --
# see the note on the "don't crash loading a bake made before Phase H's new columns" fix).
KNOWN_TRAILER_NAMES = {"Mz", "X", "Y", "Z"}


def write_d1lc(
    path: str,
    t: np.ndarray,
    fx: np.ndarray,
    fy: np.ndarray,
    fz: np.ndarray,
    rpm: np.ndarray,
    revs: np.ndarray,
    fs: float,
    feed: float,
    diam: float,
    cs_sec: float,
    ce_sec: float,
    extras: dict[str, np.ndarray] | None = None,
) -> None:
    n = int(t.size)
    version = 2 if extras else 1
    head = struct.pack(
        "<IIIfffff",
        MAGIC,
        version,
        n,
        float(fs),
        float(feed),
        float(diam),
        float(cs_sec),
        float(ce_sec),
    )
    with open(path, "wb") as f:
        f.write(head)
        for arr in (t, fx, fy, fz, rpm, revs):
            f.write(np.ascontiguousarray(arr, dtype="<f4").tobytes())
        if extras:
            f.write(struct.pack("<I", len(extras)))
            for name, arr in extras.items():
                # The trailer's name field is a fixed 8-byte ASCII slot. errors="replace" keeps a
                # stray non-ASCII key from crashing the whole writer; the reader ignores any name
                # it doesn't recognise anyway (KNOWN_TRAILER_NAMES).
                name_bytes = name.encode("ascii", errors="replace")[:8].ljust(8, b"\x00")
                f.write(name_bytes)
                f.write(np.ascontiguousarray(arr, dtype="<f4").tobytes())


def read_d1lc_header(buf: bytes) -> dict:
    """Raises ValueError for anything that is not a complete D1LC header (including a file cut off
    before the header ends, which struct reports as struct.error)."""
    try:
        magic, version, n = struct.unpack_from("<III", buf, 0)
        if magic != MAGIC:
            raise ValueError(f"bad D1LC magic {magic:#x}")
        fs, feed, diam, cs, ce = struct.unpack_from("<fffff", buf, 12)
    except struct.error as e:
        raise ValueError(f"truncated header ({len(buf)} bytes)") from e
    return {
        "version": version,
        "n": n,
        "fs": fs,
        "feed": feed,
        "diam": diam,
        "cs_sec": cs,
        "ce_sec": ce,
    }


def parse_d1lc(buf: bytes) -> dict:
    """Full parse: header + the six float32[N] arrays (t, Fx, Fy, Fz, rpm, revs), plus a
    version-2 `extras` dict of any named trailer arrays this reader recognises (always
    present, empty for a v1 file or a v2 file with no recognised extras)."""
    h = read_d1lc_header(buf)
    n = h["n"]
    a = np.frombuffer(buf, dtype="<f4", count=n * 6, offset=32).reshape(6, n)
    out = {
        **h,
        "t": a[0].copy(),
        "fx": a[1].copy(),
        "fy": a[2].copy(),
        "fz": a[3].copy(),
        "rpm": a[4].copy(),
        "revs": a[5].copy(),
        "extras": {},
    }
    off = 32 + n * 6 * 4
    if h["version"] >= 2 and off + 4 <= len(buf):
        (extra_count,) = struct.unpack_from("<I", buf, off)
        off += 4
        for _ in range(extra_count):
            if off + 8 > len(buf):
                break
            name = buf[off : off + 8].rstrip(b"\x00").decode("ascii", errors="replace")
            off += 8
            if off + n * 4 > len(buf):
                break
            arr = np.frombuffer(buf, dtype="<f4", count=n, offset=off).copy()
            off += n * 4
            if name in KNOWN_TRAILER_NAMES:
                out["extras"][name] = arr
    return out
