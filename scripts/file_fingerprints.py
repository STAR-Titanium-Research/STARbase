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
`UnreadableMat`. A v7.3 chunk that fails to decode (gzip/filter/checksum) raises `CorruptChunk`, an
OSError: a flaky share can garble a read, so it is retried like any read error, and the runner
records it as `UnreadableMat` only once the retries are spent and the whole file was read cleanly.
Importing this module does no work; the runner and CLI (selection, throttled hashing of the files
on the share, resumable writes to file_fingerprints) are at the end of the file.

Permanent and retryable errors. The runner writes a `FingerprintError` (NoForceArray,
BadForceArray, UnreadableMat; the file was read but is not a usable force file) as status `error`
with an error_message that starts with `PERMANENT_PREFIX`, exactly "permanent: ", then the class
name: `permanent: NoForceArray: neither 'data' nor 'DATA' in the file`. That prefix is the stable
marker the selection keys on: such a row is re-read only when its staleness key changes or with
--retry-permanent. Every other `error` row (read failures after the retries, the provisional
"hashing started", "file changed while hashing", unexpected exceptions) is retried on every run.
"""

from __future__ import annotations

import hashlib
import os
import re
import struct
import threading
import time

import numpy as np

HDF5_SIGNATURE = b"\x89HDF\r\n\x1a\n"
VARIABLES = ("data", "DATA")  # `data` wins when both are present
NUMERIC_KINDS = "biuf"  # bool, signed/unsigned integer, float (not complex, string, object, compound)
MATLAB_NUMERIC_CLASSES = frozenset(
    ["double", "single", "logical"]
    + [f"{p}int{b}" for p in ("", "u") for b in (8, 16, 32, 64)]
)


class FingerprintError(Exception):
    """Base class for fingerprinting failures."""


class NoForceArray(FingerprintError):  # noqa: N818 (named for what it means; the base is the Error)
    """The file has neither a `data` nor a `DATA` variable."""


class BadForceArray(FingerprintError):  # noqa: N818
    """The force variable is not a 2-D numeric array."""


class UnreadableMat(FingerprintError):  # noqa: N818
    """The file cannot be parsed as a MATLAB .mat file."""


class CorruptChunk(OSError):  # noqa: N818
    """A v7.3 data chunk failed to decode. Retryable (an OSError); see the module docstring."""


PERMANENT_PREFIX = (
    "permanent: "  # error_message of a FingerprintError row (see the module docstring)
)
# The HDF5 causes (the parenthesised part of h5py's "Can't read data (...)") that mean the stored
# bytes do not decode. "file read failed" (what a dropped share looks like) is deliberately absent.
_DECODE_FAILURE = re.compile(
    r"filter returned failure|inflate|fletcher32|checksum|B-tree signature", re.I
)


def permanent_message(e: FingerprintError) -> str:
    return f"{PERMANENT_PREFIX}{type(e).__name__}: {e}"


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


def content_sha256(
    stream_or_path, chunk: int = 8 << 20, throttle: Throttle | None = None
) -> tuple[str, int]:
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


def mat_data_sha256(
    path, block_bytes: int = 64 << 20, throttle: Throttle | None = None
) -> tuple[str, str, int, int]:
    """SHA-256 of the decoded force array (see the module docstring). Returns (hex, variable, rows, cols)."""
    if _is_hdf5(
        path
    ):  # also raises FileNotFoundError / PermissionError (OSError) as-is
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
    except (
        Exception
    ) as e:  # scipy raises ValueError, NotImplementedError, struct.error, ...
        raise _unreadable(path, e) from e
    var = _pick(mat)
    a = mat[var]
    if (
        not isinstance(a, np.ndarray)
        or a.ndim != 2
        or a.dtype.kind not in NUMERIC_KINDS
    ):
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
                    raise BadForceArray(
                        f"{var!r} is an empty array with {len(dims)} dimensions"
                    )
                rows, cols = dims
                return (
                    _finish(rows, cols, [hashlib.sha256() for _ in range(cols)]),
                    var,
                    rows,
                    cols,
                )
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

        # The single pass over the data. From here on a failure may be a read problem (for example
        # the share dropped mid-file), so it surfaces as a retryable OSError, never as UnreadableMat;
        # a chunk that does not decode is a CorruptChunk, which the runner judges after its retries.
        hashers = [hashlib.sha256() for _ in range(cols)]
        try:
            for k in range(0, rows, n):
                block = ds[:, k : k + n]
                for j in range(cols):
                    hashers[j].update(np.ascontiguousarray(block[j], dtype="<f8"))
                if throttle is not None:
                    throttle.consume(block.nbytes)
        except MemoryError:
            raise
        except OSError as e:
            if e.errno is None and _DECODE_FAILURE.search(str(e)):
                raise CorruptChunk(f"reading {var!r} from {path} failed: {e}") from e
            raise
        except Exception as e:
            raise OSError(
                f"reading {var!r} from {path} failed: {type(e).__name__}: {e}"
            ) from e
        return _finish(rows, cols, hashers), var, rows, cols


# ======================================================================================
# The runner: select files from the database, hash them on the share, write file_fingerprints.
#
#   DATABASE_URL=... python scripts/file_fingerprints.py --phase linked [--workers 1] [--max-mb-s 60]
#       [--limit N] [--skip-failed] [--retry-permanent] [--include-local] [--archive-root PATH] [--dry-run]
#
# Resumable: a file is selected when it has no fingerprint, when the stored staleness key
# (size_bytes, source_mtime) no longer matches directus_files, when its status is missing or a
# retryable error (unless --skip-failed), or when it is a permanent error (error_message starts
# with PERMANENT_PREFIX) and --retry-permanent is given. The two flags combine: both together
# retry only the permanent errors (for example after a parser fix). Ordering by hashed_at NULLS
# FIRST puts never-tried files first and sends a file that fails to the back. Only reads from the share; only writes
# file_fingerprints. Exit codes: 0 queue drained, 2 the share (or the setup) is not usable,
# 130 stopped with Ctrl+C (files in hand finished), 1 an unexpected error (traceback).
# ======================================================================================

import argparse  # noqa: E402
import contextlib  # noqa: E402
import subprocess  # noqa: E402
import sys  # noqa: E402
import tempfile  # noqa: E402
from collections import deque  # noqa: E402
from dataclasses import dataclass  # noqa: E402
from datetime import datetime  # noqa: E402

DIRECTUS_CONTAINER = "d1-database-directus-1"
LOCAL_UPLOADS = "/directus/uploads"
RETRY_BACKOFF_S = (
    2,
    4,
    8,
)  # an OSError is retried after each of these waits, then recorded as an error
MISSING_STREAK = 5  # consecutive missing files before the share itself is re-checked
PROGRESS_EVERY = 10
_sleep = time.sleep  # indirection so tests do not wait out the backoff


@dataclass
class FileJob:
    id: str
    storage: str
    archive_path: str | None
    filename_disk: str | None
    filename_download: str | None
    size_bytes: int | None  # directus_files.filesize, as read at selection time
    source_mtime: (
        datetime | None
    )  # metadata.modified, else modified_on, as read at selection time


def default_archive_root() -> str:
    """The same root the force orchestrator uses (ARCHIVE_UNC), without importing that daemon module."""
    return os.environ.get("ARCHIVE_UNC", r"\\uosfstore.shef.ac.uk\shared\star_group1")


# ---- selection ----------------------------------------------------------------------

_SOURCE_MTIME_SQL = (
    "COALESCE((f.metadata::jsonb->>'modified')::timestamptz, f.modified_on)"
)
# Linked = attached somewhere. machining_force_analysis.directus_files_id is the source .mat; its
# live_cache_file / render_file are derived caches, not linked source files.
_LINKED_SQL = """f.id IN (
        SELECT directus_files_id FROM operation_data_files
        UNION SELECT directus_files_id FROM sample_data_files
        UNION SELECT directus_files_id FROM session_data_files
        UNION SELECT directus_files_id FROM machining_force_analysis)"""


# The inbox crawler (scripts/inbox_crawler) registers a pointer row for every file it finds on a person's
# or team's share folder, documents included, but reads only images and surface scans (ADR-0020): a
# document's content is read once, after a person links it. So under --phase all a document or other
# non-image file the crawler found (a d1_private.file_candidates row) that nobody has linked or adopted is
# left alone. The exclusion keys on the candidate row, not on the pointer row's metadata: the indexer
# rewrites `metadata` of the files it walks, and any Lab Member can edit it, while a candidate row is
# written by the crawler and the d1-inbox extension only. A file in a junction is always linked, so `all`
# stays a superset of `linked`.
CANDIDATES_TABLE = "d1_private.file_candidates"  # tests point it at a throwaway schema


def _unlinked_crawler_find_sql(table: str) -> str:
    return (
        "(f.id IN (SELECT c.directus_files_id FROM "
        + table
        + " c WHERE c.state <> 'linked' AND c.adopted_at IS NULL AND c.kind IN ('document', 'other')) "
        "AND NOT (" + _LINKED_SQL + "))"
    )


def _all_phase_sql(cur) -> str:
    """The `all` filter. A database without the inbox migration has no candidates, so excludes nothing."""
    cur.execute("SELECT to_regclass(%s) IS NOT NULL", (CANDIDATES_TABLE,))
    if not cur.fetchone()[0]:
        return "TRUE"
    return f"NOT {_unlinked_crawler_find_sql(CANDIDATES_TABLE)}"


def select_files(
    cur,
    phase: str,
    include_local: bool,
    retry_failed: bool,
    limit: int | None,
    retry_permanent: bool = False,
) -> list[FileJob]:
    """The files that need (re)hashing, never-tried first. See the section comment for the rules."""
    if phase not in ("linked", "all"):
        raise ValueError(f"phase must be 'linked' or 'all', not {phase!r}")
    storages = ["star", "local"] if include_local else ["star"]
    linked = _LINKED_SQL if phase == "linked" else _all_phase_sql(cur)
    permanent = "starts_with(COALESCE(fp.error_message, ''), %s)"
    sql = f"""
        SELECT f.id::text, f.storage, f.metadata::jsonb->>'archive_path', f.filename_disk,
               f.filename_download, f.filesize, {_SOURCE_MTIME_SQL}
        FROM directus_files f
        LEFT JOIN file_fingerprints fp ON fp.directus_files_id = f.id
        WHERE f.storage = ANY(%s)
          AND ({linked})
          AND (fp.directus_files_id IS NULL
               OR fp.size_bytes IS DISTINCT FROM f.filesize
               OR fp.source_mtime IS DISTINCT FROM {_SOURCE_MTIME_SQL}
               OR (fp.status = 'missing' AND %s)
               OR (fp.status = 'error' AND NOT {permanent} AND %s)
               OR (fp.status = 'error' AND {permanent} AND %s))
        ORDER BY fp.hashed_at NULLS FIRST, f.id
    """
    params: list = [
        storages,
        bool(retry_failed),
        PERMANENT_PREFIX,
        bool(retry_failed),
        PERMANENT_PREFIX,
        bool(retry_permanent),
    ]
    if limit is not None:
        sql += " LIMIT %s"
        params.append(limit)
    cur.execute(sql, params)
    return [FileJob(*r) for r in cur.fetchall()]


# ---- paths and file access ----------------------------------------------------------


def resolve_path(job: FileJob, archive_root: str) -> str:
    """Where the bytes are: star files at archive_root + metadata.archive_path (never filename_disk);
    local files at their path inside the Directus container (read through `docker exec`)."""
    if job.storage == "local":
        if not job.filename_disk:
            raise ValueError("no filename_disk for a local file")
        return f"{LOCAL_UPLOADS}/{job.filename_disk}"
    if not job.archive_path:
        raise ValueError("no archive_path in the file metadata")
    parts = job.archive_path.split("/")
    if ".." in parts:
        raise ValueError(f"archive_path escapes the archive root: {job.archive_path!r}")
    return os.path.join(archive_root, *parts)


def _display_name(job: FileJob) -> str:
    if job.storage == "local":
        return job.filename_download or job.filename_disk or ""
    return (job.archive_path or "").rsplit("/", 1)[-1]


def _stat(job: FileJob, path: str):
    """(size, mtime) of the file as it is now, or None when it is not there. Other OSErrors propagate."""
    if job.storage == "local":
        return _local_stat(job.filename_disk)
    try:
        st = os.stat(path)
    except (FileNotFoundError, NotADirectoryError):
        return None
    return st.st_size, st.st_mtime_ns


def _local_stat(filename_disk: str):
    r = subprocess.run(
        [
            "docker",
            "exec",
            DIRECTUS_CONTAINER,
            "stat",
            "-c",
            "%s %Y",
            f"{LOCAL_UPLOADS}/{filename_disk}",
        ],
        capture_output=True,
        text=True,
    )
    if r.returncode != 0:
        if "No such file" in r.stderr:
            return None
        raise OSError(f"docker exec stat failed ({r.returncode}): {r.stderr.strip()}")
    size, mtime = r.stdout.split()
    return int(size), int(mtime)


@contextlib.contextmanager
def _local_open(filename_disk: str):
    """A binary stream of a file in the Directus container uploads (docker exec ... cat)."""
    p = subprocess.Popen(
        [
            "docker",
            "exec",
            DIRECTUS_CONTAINER,
            "cat",
            f"{LOCAL_UPLOADS}/{filename_disk}",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    try:
        yield p.stdout
    except BaseException:
        p.kill()
        raise
    finally:
        p.stdout.close()
        rc = p.wait()
    if (
        rc != 0
    ):  # reached only when the body completed: the stream was cut short or the file vanished
        raise OSError(f"docker exec cat exited {rc} for {filename_disk}")


class _Tee:
    """A read-only stream that copies what it hands out into a file (one pass for hash and temp copy)."""

    def __init__(self, src, out):
        self.src, self.out = src, out

    def read(self, n=-1):
        b = self.src.read(n)
        self.out.write(b)
        return b


def _hash_file(
    job, path, is_mat, throttle, block_bytes, got
) -> FingerprintError | None:
    """Fill `got` with the content / mat results; return a FingerprintError for a permanent .mat failure.
    OSError propagates (the caller retries). got['content'] is set only for a fully read file."""
    if job.storage != "local":
        got["content"], _ = content_sha256(path, throttle=throttle)
        if is_mat:
            try:
                got["mat"] = mat_data_sha256(
                    path, block_bytes=block_bytes, throttle=throttle
                )
            except FingerprintError as e:
                return e
        return None
    tmp = None
    try:
        with _local_open(job.filename_disk) as stream:
            if is_mat:
                fd, tmp = tempfile.mkstemp(suffix=".mat")
                with os.fdopen(fd, "wb") as out:
                    digest, _ = content_sha256(_Tee(stream, out), throttle=throttle)
            else:
                digest, _ = content_sha256(stream, throttle=throttle)
        got["content"] = (
            digest  # only once the stream ended cleanly (the exit above checks docker status)
        )
        if is_mat:
            try:
                got["mat"] = mat_data_sha256(
                    tmp, block_bytes=block_bytes, throttle=throttle
                )
            except FingerprintError as e:
                return e
        return None
    finally:
        if tmp:
            with contextlib.suppress(OSError):
                os.unlink(tmp)


def _should_retry(attempt: int) -> bool:
    if attempt < len(RETRY_BACKOFF_S):
        _sleep(RETRY_BACKOFF_S[attempt])
        return True
    return False


def fingerprint_job(
    job: FileJob,
    archive_root: str,
    throttle=None,
    block_bytes: int = 64 << 20,
    on_start=None,
) -> dict:
    """Hash one file and return the file_fingerprints row values (nothing is written here).

    `on_start` (optional) runs once the file is known to exist and just before it is read; the
    runner uses it to write and commit the provisional row, so a hard crash leaves the file recorded.
    """
    row = {
        "status": None,
        "content_sha256": None,
        "data_sha256": None,
        "data_variable": None,
        "data_rows": None,
        "data_cols": None,
        "size_bytes": job.size_bytes,
        "source_mtime": job.source_mtime,
        "error_message": None,
    }

    def result(status, message=None, **more):
        return {**row, "status": status, "error_message": message, **more}

    try:
        path = resolve_path(job, archive_root)
    except ValueError as e:
        return result("error", str(e))
    is_mat = _display_name(job).lower().endswith(".mat")
    started = False
    got: dict = {}
    attempt = 0
    while True:
        try:
            before = _stat(job, path)
        except OSError as e:
            if _should_retry(attempt):
                attempt += 1
                continue
            return result("error", f"{type(e).__name__}: {e}", io_failure=True)
        if before is None:
            return result("missing", f"not found: {path}")
        if not started:
            started = True
            if on_start is not None:
                on_start()
        got.clear()
        try:
            ferr = _hash_file(job, path, is_mat, throttle, block_bytes, got)
            after = _stat(job, path)
        except OSError as e:
            if _should_retry(attempt):
                attempt += 1
                continue
            if isinstance(e, CorruptChunk) and got.get("content"):
                # Every byte of the file was read cleanly (the content pass) and the force array
                # still failed to decode on each attempt: the file itself is corrupt, not the share.
                return result(
                    "error",
                    permanent_message(UnreadableMat(str(e))),
                    content_sha256=got["content"],
                )
            return result(
                "error",
                f"{type(e).__name__}: {e}",
                content_sha256=got.get("content"),
                io_failure=True,
            )
        except Exception as e:  # noqa: BLE001 - one odd file must not stop a 10K-file run
            return result(
                "error",
                f"unexpected {type(e).__name__}: {e}",
                content_sha256=got.get("content"),
            )
        if after != before:
            return result("error", "file changed while hashing")
        if ferr is not None:
            return result(
                "error", permanent_message(ferr), content_sha256=got["content"]
            )
        out = result("done", None, content_sha256=got["content"])
        if "mat" in got:
            digest, variable, rows, cols = got["mat"]
            out.update(
                data_sha256=digest,
                data_variable=variable,
                data_rows=rows,
                data_cols=cols,
            )
        return out


_UPSERT_SQL = """
    INSERT INTO file_fingerprints (directus_files_id, status, content_sha256, data_sha256, data_variable,
                                   data_rows, data_cols, size_bytes, source_mtime, error_message, hashed_at)
    VALUES (%(id)s, %(status)s, %(content_sha256)s, %(data_sha256)s, %(data_variable)s,
            %(data_rows)s, %(data_cols)s, %(size_bytes)s, %(source_mtime)s, %(error_message)s, now())
    ON CONFLICT (directus_files_id) DO UPDATE SET
        status = EXCLUDED.status, content_sha256 = EXCLUDED.content_sha256,
        data_sha256 = EXCLUDED.data_sha256, data_variable = EXCLUDED.data_variable,
        data_rows = EXCLUDED.data_rows, data_cols = EXCLUDED.data_cols, size_bytes = EXCLUDED.size_bytes,
        source_mtime = EXCLUDED.source_mtime, error_message = EXCLUDED.error_message, hashed_at = now()
"""
_ROW_KEYS = (
    "status",
    "content_sha256",
    "data_sha256",
    "data_variable",
    "data_rows",
    "data_cols",
    "size_bytes",
    "source_mtime",
    "error_message",
)


def upsert_fingerprint(cur, file_id: str, row: dict) -> None:
    """Insert or replace the file fingerprint row (the caller commits)."""
    cur.execute(_UPSERT_SQL, {"id": file_id, **{k: row.get(k) for k in _ROW_KEYS}})


# ---- the run -------------------------------------------------------------------------


class _Run:
    """Shared state of one run: the queue, the counters, the not-yet-written missing files."""

    def __init__(self, jobs, root, throttle, block_bytes):
        self.queue = deque(jobs)
        self.root, self.throttle, self.block_bytes = root, throttle, block_bytes
        self.lock = threading.Lock()
        self.total = len(jobs)
        self.total_bytes = sum(j.size_bytes or 0 for j in jobs)
        self.counts = {"done": 0, "error": 0, "missing": 0}
        self.vanished = 0  # deleted from Directus while we ran
        self.processed = 0
        self.bytes_done = (
            0  # directus_files.filesize of the files finished (the ETA basis)
        )
        # Rows not written yet: files that were missing or whose reads kept failing with an OSError.
        # They are written once the share is vouched for (see finish).
        self.pending: list[tuple[FileJob, dict]] = []
        self.exit_code: int | None = None  # 2: the share went away (set under the lock)
        self.stop = (
            threading.Event()
        )  # Ctrl+C: workers finish the file they are on, take no more
        self.t0 = time.monotonic()

    @property
    def bytes_read(self) -> int:
        """Bytes that went through the throttle: the whole file on the content pass, plus the decoded
        array on the data pass of a .mat (so a .mat counts about twice)."""
        return getattr(self.throttle, "total", 0)

    # callers hold self.lock for everything below

    def _write(self, conn, job, row) -> bool:
        import psycopg2.errors

        try:
            with conn.cursor() as cur:
                upsert_fingerprint(cur, job.id, row)
            conn.commit()
        except psycopg2.errors.ForeignKeyViolation:
            conn.rollback()
            self.vanished += 1
            return False
        self.counts[row["status"]] += 1
        return True

    def flush_pending(self, conn):
        for job, row in self.pending:
            self._write(conn, job, row)
        self.pending = []

    def share_gone(self, n):
        self.exit_code = 2
        print(
            f"stopping: {n} file(s) in a row were missing or unreadable and the archive root {self.root!r} "
            f"is no longer reachable; those files were not marked, rows already written are kept (exit 2)",
            file=sys.stderr,
        )

    def finish(self, conn, job, row):
        if (
            self.exit_code is not None
        ):  # another worker found the share gone: write nothing more
            return
        # A streak candidate is a file that was not found, or whose reads kept failing with an OSError
        # (on a dropped Windows share these are errors like WinError 64/59/121, not "not found"). Neither
        # is written until 5 in a row have been checked against the share itself, or a good file turns up.
        if row["status"] == "missing" or row.get("io_failure"):
            self.pending.append((job, row))
            if len(self.pending) >= MISSING_STREAK:
                if not os.path.isdir(self.root):
                    self.share_gone(len(self.pending))
                    return
                self.flush_pending(conn)
        else:
            self.flush_pending(
                conn
            )  # a file was read: the earlier failures were genuinely the files
            self._write(conn, job, row)
        self.processed += 1
        self.bytes_done += job.size_bytes or 0
        if self.processed % PROGRESS_EVERY == 0:
            print(self.progress_line(), flush=True)

    def progress_line(self) -> str:
        elapsed = max(time.monotonic() - self.t0, 1e-9)
        rate = self.bytes_read / elapsed
        file_rate = self.bytes_done / elapsed
        left = max(self.total_bytes - self.bytes_done, 0)
        eta = f"{left / file_rate / 60:.0f} min" if file_rate > 0 else "?"
        c = self.counts
        return (
            f"[{self.processed}/{self.total}] {c['done']} done, {c['error']} error, {c['missing']} missing | "
            f"{self.bytes_read / 1e9:.2f} GB read | {rate / 1e6:.1f} MB/s | ETA {eta}"
        )


def _worker(run: _Run, conn) -> None:
    import psycopg2.errors

    def provisional(job):
        """Record the file as 'hashing started' and commit, before reading a byte of it."""
        with conn.cursor() as cur:
            upsert_fingerprint(
                cur,
                job.id,
                {
                    "status": "error",
                    "size_bytes": job.size_bytes,
                    "source_mtime": job.source_mtime,
                    "error_message": "hashing started",
                },
            )
        conn.commit()

    while run.exit_code is None and not run.stop.is_set():
        try:
            job = run.queue.popleft()
        except IndexError:
            return
        try:
            row = fingerprint_job(
                job,
                run.root,
                run.throttle,
                run.block_bytes,
                on_start=lambda job=job: provisional(job),
            )
        except (
            psycopg2.errors.ForeignKeyViolation
        ):  # the file left Directus since we selected it
            conn.rollback()
            with run.lock:
                run.vanished += 1
                run.processed += 1
            continue
        with run.lock:
            run.finish(conn, job, row)


def _dry_run(jobs, root) -> int:
    exist, total = 0, 0
    for j in jobs:
        try:
            path = resolve_path(j, root)
            ok = _stat(j, path) is not None
        except (ValueError, OSError):
            path, ok = f"<unresolvable: {j.archive_path or j.filename_disk}>", False
        exist += ok
        total += j.size_bytes or 0
        print(
            f"{j.id}  {j.size_bytes or 0:>14}  {path}  {'exists' if ok else 'missing'}"
        )
    print(
        f"{len(jobs)} files, {total / 1e9:.2f} GB, {exist} of {len(jobs)} paths exist "
        f"(dry run: nothing read or written)"
    )
    return 0


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Hash Directus files on the lab share into file_fingerprints."
    )
    p.add_argument(
        "--phase",
        choices=("linked", "all"),
        required=True,
        help="linked: files attached to operations/samples/sessions/force analyses; all: every file except a document the inbox crawler found that nobody has linked yet",
    )
    p.add_argument(
        "--workers", type=int, default=1, help="parallel hashing threads (default 1)"
    )
    p.add_argument(
        "--max-mb-s",
        type=float,
        default=60.0,
        help="global read cap in MB/s across all workers (default 60; 0 = unlimited)",
    )
    p.add_argument(
        "--limit", type=int, default=None, help="stop after selecting N files"
    )
    p.add_argument(
        "--skip-failed",
        action="store_true",
        help="do not retry files recorded as missing or as a retryable error (read failures)",
    )
    p.add_argument(
        "--retry-permanent",
        action="store_true",
        help="also re-read files recorded as a permanent error (not a usable .mat force file); "
        "without it they are re-read only when their size or mtime changes",
    )
    p.add_argument(
        "--include-local",
        action="store_true",
        help="also hash storage='local' files, read from the Directus container via docker exec",
    )
    p.add_argument(
        "--archive-root", default=None, help="the share root (default: env ARCHIVE_UNC)"
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="list what would be hashed; read and write nothing",
    )
    return p


def main(argv=None) -> int:
    args = _parser().parse_args(argv)
    if args.workers < 1:
        print("--workers must be at least 1", file=sys.stderr)
        return 2
    root = args.archive_root or default_archive_root()
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        print("DATABASE_URL is required", file=sys.stderr)
        return 2
    if not os.path.isdir(root):
        print(
            f"archive root {root!r} is not reachable (is the share mounted / VPN up?); nothing written",
            file=sys.stderr,
        )
        return 2
    import psycopg2

    conns = []
    try:
        with contextlib.closing(
            psycopg2.connect(dsn)
        ) as sel_conn:  # not kept: it would idle for the whole run
            with sel_conn.cursor() as cur:
                jobs = select_files(
                    cur,
                    args.phase,
                    args.include_local,
                    not args.skip_failed,
                    args.limit,
                    retry_permanent=args.retry_permanent,
                )
            sel_conn.commit()
        if args.dry_run:
            return _dry_run(jobs, root)
        print(
            f"{len(jobs)} file(s) to hash, {sum(j.size_bytes or 0 for j in jobs) / 1e9:.2f} GB",
            flush=True,
        )
        throttle = _CountingThrottle(
            Throttle(args.max_mb_s * 1e6 if args.max_mb_s > 0 else None)
        )
        run = _Run(jobs, root, throttle, 64 << 20)
        if args.workers == 1 or len(jobs) <= 1:
            conn = psycopg2.connect(dsn)
            conns.append(conn)
            try:
                _worker(run, conn)
            except KeyboardInterrupt:
                run.stop.set()
                print(
                    "interrupted: the file in progress is left as 'hashing started'",
                    file=sys.stderr,
                )
        else:
            errors: list[BaseException] = []

            def target(conn):
                try:
                    _worker(run, conn)
                except BaseException as e:  # noqa: BLE001 - re-raised in the main thread below
                    errors.append(e)
                    run.exit_code = run.exit_code or 2

            threads = []
            for _ in range(args.workers):
                conn = psycopg2.connect(dsn)
                conns.append(conn)
                threads.append(
                    threading.Thread(target=target, args=(conn,), daemon=True)
                )
            _join_workers(threads, run)
            if errors:
                raise errors[0]
        if run.exit_code is None and run.pending:
            if os.path.isdir(root):
                # a fresh connection: none of the others is safe to assume alive after a long run
                with contextlib.closing(psycopg2.connect(dsn)) as end_conn:
                    run.flush_pending(end_conn)
            else:
                run.share_gone(len(run.pending))
        c = run.counts
        interrupted = run.stop.is_set() and run.exit_code is None
        print(
            f"{'interrupted' if interrupted else 'finished' if run.exit_code is None else 'stopped'}: "
            f"{c['done']} done, {c['error']} error, {c['missing']} missing"
            + (f", {run.vanished} vanished" if run.vanished else "")
            + f" | {run.bytes_read / 1e9:.2f} GB read in {time.monotonic() - run.t0:.0f} s",
            flush=True,
        )
        return 130 if interrupted else run.exit_code or 0
    finally:
        for conn in conns:
            with contextlib.suppress(Exception):
                conn.rollback()
                conn.close()


def _join_workers(threads, run: _Run) -> None:
    """Start the worker threads and wait for them. join(timeout) in a loop keeps Ctrl+C deliverable
    on Windows. The first interrupt asks the workers to stop after the file they are on (so its row is written); a
    second one gives up waiting (the daemon threads die with the process, their files stay provisional)."""
    try:
        for t in threads:
            t.start()
        while any(t.is_alive() for t in threads):
            for t in threads:
                if t.is_alive():  # (a thread whose start was interrupted never ran)
                    t.join(0.5)
        return
    except KeyboardInterrupt:
        run.stop.set()
        print(
            "interrupted: finishing the files in progress (Ctrl+C again to stop at once)",
            file=sys.stderr,
            flush=True,
        )
    try:
        while any(t.is_alive() for t in threads):
            for t in threads:
                if t.is_alive():  # (a thread whose start was interrupted never ran)
                    t.join(0.5)
    except KeyboardInterrupt:
        print(
            "stopping at once; files in progress stay 'hashing started'",
            file=sys.stderr,
            flush=True,
        )
        run.exit_code = run.exit_code or 130


class _CountingThrottle:
    """Wraps a Throttle and totals every byte that goes through it (what the progress line reports)."""

    def __init__(self, inner: Throttle):
        self.inner, self.total, self._lock = inner, 0, threading.Lock()

    def consume(self, n: int) -> None:
        with self._lock:
            self.total += max(n, 0)
        self.inner.consume(n)


if __name__ == "__main__":
    sys.exit(main())
