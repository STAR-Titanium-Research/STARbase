"""Content fingerprints for stored files (spec 2026-10-10-record-codes, section 7; stage T0e).

Two SHA-256 hashes identify a file's content independently of its name, path or date:

* `content_sha256`: the whole file, byte for byte. Any change at all (a renamed internal field, a
  re-saved header) gives a different hash.
* `mat_data_sha256` (MATLAB .mat files only): the decoded force array, not the bytes on disk.
  It is the SHA-256 over the array's MATLAB shape as two little-endian uint64 (rows, cols),
  followed, for each column j in order, by the 32-byte digest `sha256(column j as little-endian
  float64, top to bottom)`. With no columns it is the shape alone; with no rows each column
  digest is sha256(b""). The variable is `data` when the file has one, else `DATA` (never decided
  from `fileVersion`). Only the numbers are hashed, so the same force data saved as v5 or v7.3,
  with or without extra metadata variables, in any integer or float type, gives the same hash;
  that is what lets a metadata-only upgrade of an old file be recognised as the same measurement.
  Hashing per column (not one column-major stream) is what allows a single pass: real v7.3 force
  files are chunked across all columns (for example 10 x 819 samples, gzip), so reading one column
  at a time would decode the whole file once per column.

v5/v6/v7 files are read with scipy (the whole array is loaded; they are small). v7.3 files are
HDF5 and are read with h5py one block at a time (`block_bytes`, default 64 MiB of float64), so a
14.6 GB array never sits in memory. HDF5 stores a MATLAB array transposed, so a dataset of shape
(cols, rows) is MATLAB (rows, cols) and one HDF5 row is one MATLAB column.

Files are only ever opened for reading. An `OSError` from the file system (missing file, I/O
error) propagates unchanged so a caller can retry it; a file that is not a parseable .mat raises
`UnreadableMat`. This module is a library: importing it does no work.
"""

from __future__ import annotations

import hashlib
import os
import struct
import threading
import time

import numpy as np

HDF5_SIGNATURE = b"\x89HDF\r\n\x1a\n"
VARIABLES = ("data", "DATA")  # `data` wins when both are present
NUMERIC_KINDS = "biuf"  # bool, signed/unsigned integer, float (not complex, string, object, compound)
MATLAB_NUMERIC_CLASSES = frozenset(
    ["double", "single", "logical"] + [f"{p}int{b}" for p in ("", "u") for b in (8, 16, 32, 64)]
)


class FingerprintError(Exception):
    """Base class for fingerprinting failures."""


class NoForceArray(FingerprintError):
    """The file has neither a `data` nor a `DATA` variable."""


class BadForceArray(FingerprintError):
    """The force variable is not a 2-D numeric array."""


class UnreadableMat(FingerprintError):
    """The file cannot be parsed as a MATLAB .mat file."""


class Throttle:
    """A thread-safe global byte-rate cap: the total rate across all callers stays <= the cap.

    Each `consume(n)` reserves the next n / rate seconds of a shared timeline and sleeps until
    that slot has passed. `Throttle(None)` never sleeps.
    """

    def __init__(self, max_bytes_per_s: float | None):
        if max_bytes_per_s is not None and max_bytes_per_s <= 0:
            raise ValueError("max_bytes_per_s must be positive or None")
        self.rate = max_bytes_per_s
        self._lock = threading.Lock()
        self._free_at = 0.0  # monotonic time at which the timeline is next free

    def consume(self, n: int) -> None:
        if self.rate is None or n <= 0:
            return
        with self._lock:
            start = max(time.monotonic(), self._free_at)
            self._free_at = start + n / self.rate
            wait = self._free_at - time.monotonic()
        if wait > 0:
            time.sleep(wait)


def content_sha256(stream_or_path, chunk: int = 8 << 20, throttle: Throttle | None = None) -> tuple[str, int]:
    """SHA-256 of a whole file, given a path or a binary file object. Returns (hex, bytes read)."""
    h = hashlib.sha256()
    total = 0

    def run(f):
        nonlocal total
        while True:
            buf = f.read(chunk)
            if not buf:
                return
            h.update(buf)
            total += len(buf)
            if throttle is not None:
                throttle.consume(len(buf))

    if hasattr(stream_or_path, "read"):
        run(stream_or_path)
    else:
        with open(stream_or_path, "rb") as f:
            run(f)
    return h.hexdigest(), total


def _is_hdf5(path) -> bool:
    with open(path, "rb") as f:
        if f.read(8) == HDF5_SIGNATURE:
            return True
        f.seek(512)
        return f.read(8) == HDF5_SIGNATURE


def _pick(container) -> str:
    for v in VARIABLES:
        if v in container:
            return v
    raise NoForceArray("neither 'data' nor 'DATA' in the file")


def mat_data_sha256(path, block_bytes: int = 64 << 20, throttle: Throttle | None = None) -> tuple[str, str, int, int]:
    """SHA-256 of the decoded force array (see the module docstring). Returns (hex, variable, rows, cols)."""
    if _is_hdf5(path):  # also raises FileNotFoundError / PermissionError (OSError) as-is
        return _hdf5_data_sha256(path, block_bytes, throttle)
    return _v5_data_sha256(path, throttle)


def _unreadable(path, e) -> UnreadableMat:
    return UnreadableMat(f"cannot read {path} as a .mat file: {type(e).__name__}: {e}")


def _finish(rows, cols, hashers) -> str:
    """The outer hash: the shape header, then each column's 32-byte digest in column order."""
    h = hashlib.sha256(struct.pack("<QQ", rows, cols))
    for ch in hashers:
        h.update(ch.digest())
    return h.hexdigest()


def _v5_data_sha256(path, throttle):
    import scipy.io

    try:
        mat = scipy.io.loadmat(os.fspath(path), variable_names=list(VARIABLES))
    except MemoryError:
        raise
    except OSError as e:
        # scipy reports a truncated file as OSError('could not read bytes') with no errno; a real
        # file-system error (missing file, I/O error) has one and propagates for the caller to retry.
        if e.errno is not None:
            raise
        raise _unreadable(path, e) from e
    except Exception as e:  # scipy raises ValueError, NotImplementedError, struct.error, ...
        raise _unreadable(path, e) from e
    var = _pick(mat)
    a = mat[var]
    if not isinstance(a, np.ndarray) or a.ndim != 2 or a.dtype.kind not in NUMERIC_KINDS:
        raise BadForceArray(f"{var!r} is not a 2-D numeric array")
    rows, cols = a.shape
    hashers = []
    for j in range(cols):
        col = np.ascontiguousarray(a[:, j], dtype="<f8")
        hashers.append(hashlib.sha256(col))
        if throttle is not None:
            throttle.consume(col.nbytes)
    return _finish(rows, cols, hashers), var, rows, cols


def _matlab_class(ds):
    cls = ds.attrs.get("MATLAB_class")
    return cls.decode("ascii", "replace") if isinstance(cls, bytes) else cls


def _hdf5_data_sha256(path, block_bytes, throttle):
    import h5py

    # Open, variable lookup and attribute inspection: an errno-less error here means the file is not
    # a parseable HDF5/.mat (UnreadableMat); one with an errno is a file-system error and propagates.
    try:
        f = h5py.File(path, "r")
    except OSError as e:
        if e.errno is not None:
            raise
        raise _unreadable(path, e) from e
    except (KeyError, ValueError, RuntimeError, TypeError) as e:
        raise _unreadable(path, e) from e
    with f:
        try:
            var = _pick(f)
            ds = f[var]
            if not isinstance(ds, h5py.Dataset) or ds.shape is None:
                raise BadForceArray(f"{var!r} is not a 2-D numeric array")
            cls = _matlab_class(ds)
            if cls is not None and cls not in MATLAB_NUMERIC_CLASSES:
                raise BadForceArray(f"{var!r} is a MATLAB {cls}, not a numeric array")
            if ds.attrs.get("MATLAB_empty"):
                # MATLAB stores an empty array as its dimensions (rows, cols, ...), not as data.
                dims = [int(d) for d in np.ravel(ds[()])]
                if len(dims) != 2:
                    raise BadForceArray(f"{var!r} is an empty array with {len(dims)} dimensions")
                rows, cols = dims
                return _finish(rows, cols, [hashlib.sha256() for _ in range(cols)]), var, rows, cols
            if ds.ndim != 2 or ds.dtype.kind not in NUMERIC_KINDS:
                raise BadForceArray(f"{var!r} is not a 2-D numeric array")
            cols, rows = ds.shape  # HDF5 holds the MATLAB array transposed
            # All columns of a sample range are read together: v7.3 force files are chunked across
            # every column, so reading column by column would decode each chunk `cols` times.
            n = max(1, block_bytes // (8 * max(1, cols)))
            if ds.chunks:
                width = ds.chunks[1]
                n = max(width, n // width * width)
        except FingerprintError:
            raise
        except OSError as e:
            if e.errno is not None:
                raise
            raise _unreadable(path, e) from e
        except (KeyError, ValueError, RuntimeError, TypeError) as e:
            raise _unreadable(path, e) from e

        # The single pass over the data. From here on a failure is a read problem (for example the
        # share dropped mid-file), so it surfaces as a retryable OSError, never as UnreadableMat.
        hashers = [hashlib.sha256() for _ in range(cols)]
        try:
            for k in range(0, rows, n):
                block = ds[:, k:k + n]
                for j in range(cols):
                    hashers[j].update(np.ascontiguousarray(block[j], dtype="<f8"))
                if throttle is not None:
                    throttle.consume(block.nbytes)
        except (OSError, MemoryError):
            raise
        except Exception as e:
            raise OSError(f"reading {var!r} from {path} failed: {type(e).__name__}: {e}") from e
        return _finish(rows, cols, hashers), var, rows, cols
