"""D1LC live-cache binary format (must match scripts/matlab/process_force.m's
write_live_cache and the client parser in liveCache.ts): 32-byte little-endian header
(magic 'D1LC', version, N, Fs, feed, diam, cs_sec, ce_sec) then six float32[N] arrays
t, Fx, Fy, Fz, rpm, revs_cum. Version 2 appends a trailer of named float32[N] arrays
(u32 count, then per array an 8-byte NUL-padded name + float32[N]); see
apps/force-app/backend/app/d1lc.py, the reference writer. The trailer is parsed into
`Cache.extras` and written back on serialise (strided like the rest), so filtering a v2
cache does not silently drop its Mz/X/Y/Z columns."""

from __future__ import annotations

import struct
from dataclasses import dataclass, field

import numpy as np

MAGIC = 0x44314C43


@dataclass
class Cache:
    fs: float
    feed: float
    diam: float
    cs_sec: float
    ce_sec: float
    t: np.ndarray
    fx: np.ndarray
    fy: np.ndarray
    fz: np.ndarray
    rpm: np.ndarray
    revs: np.ndarray
    # Version-2 trailer arrays by name (empty for a v1 file). Not filtered, only strided.
    extras: dict[str, np.ndarray] = field(default_factory=dict)

    @property
    def n(self) -> int:
        return self.t.size


def parse(buf: bytes) -> Cache:
    magic, version, n = struct.unpack_from("<III", buf, 0)
    if magic != MAGIC:
        raise ValueError(f"bad D1LC magic {magic:#x}")
    fs, feed, diam, cs, ce = struct.unpack_from("<fffff", buf, 12)
    arrs = np.frombuffer(buf, dtype="<f4", count=n * 6, offset=32)
    a = arrs.reshape(6, n)
    extras: dict[str, np.ndarray] = {}
    off = 32 + n * 6 * 4
    if version >= 2 and off + 4 <= len(buf):
        (count,) = struct.unpack_from("<I", buf, off)
        off += 4
        for _ in range(count):
            if off + 8 + n * 4 > len(buf):
                break  # truncated trailer: keep what parsed cleanly
            # latin-1 so every byte of the name slot round-trips unchanged.
            name = buf[off : off + 8].rstrip(b"\x00").decode("latin-1")
            off += 8
            extras[name] = np.frombuffer(buf, dtype="<f4", count=n, offset=off).copy()
            off += n * 4
    return Cache(
        fs,
        feed,
        diam,
        cs,
        ce,
        a[0].copy(),
        a[1].copy(),
        a[2].copy(),
        a[3].copy(),
        a[4].copy(),
        a[5].copy(),
        extras,
    )


def serialise(c: Cache, stride: int = 1) -> bytes:
    """Emit a D1LC binary, optionally strided (preview decimation)."""
    sl = slice(None, None, max(1, stride))
    t = c.t[sl]
    head = struct.pack(
        "<IIIfffff",
        MAGIC,
        2 if c.extras else 1,
        t.size,
        c.fs,
        c.feed,
        c.diam,
        c.cs_sec,
        c.ce_sec,
    )
    body = b"".join(
        np.ascontiguousarray(x[sl], dtype="<f4").tobytes()
        for x in (c.t, c.fx, c.fy, c.fz, c.rpm, c.revs)
    )
    if c.extras:
        body += struct.pack("<I", len(c.extras))
        for name, arr in c.extras.items():
            body += name.encode("latin-1")[:8].ljust(8, b"\x00")
            body += np.ascontiguousarray(arr[sl], dtype="<f4").tobytes()
    return head + body
