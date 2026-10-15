"""Reading a scan file from the read-only archive share, and only that.

The share is mounted at ``/mnt/archive`` (``:ro`` in compose, ``ro`` in the CIFS options: the same
volume the archive indexer reads). ``directus_files.metadata.archive_path`` is relative to
``ARCHIVE_ROOT`` (``/mnt/archive/star_group1``, the root ``scripts/index_archive.py`` indexes).

Refusals, all before a single byte is read:

* a path that is not a clean relative path (absolute, ``..``, backslash, NUL) or that resolves, after
  symlinks, outside ``ARCHIVE_ROOT`` (which itself must sit inside ``ARCHIVE_MOUNT``);
* an extension that is not on :data:`ALLOWED_EXTENSIONS`, checked on the path as stored and again on
  the file it resolves to (a link named ``x.al3d`` that points at ``x.pdf`` is refused);
* anything that is not a regular file.

:func:`open_readonly` is the only place a file is opened: ``os.open(O_RDONLY | O_NOFOLLOW)`` on the
resolved path, then ``fstat`` on the descriptor, which must be the same file (device, inode, size and
mtime) that :func:`stat_file` saw. SurfaceTopography then reads through that descriptor's file object,
never through the path again, so a link swapped in after the check cannot redirect the read. (The
library accepts file objects for every reader on the allowlist; a reader that insisted on a path would
fail with "could not be read", never fall back to opening the path itself.)
"""

from __future__ import annotations

import os
import stat
import uuid
from pathlib import Path, PurePosixPath
from typing import BinaryIO

from SurfaceTopography.IO import lookup_reader_by_format, readers

ARCHIVE_MOUNT = os.getenv("ARCHIVE_MOUNT", "/mnt/archive")
ARCHIVE_ROOT = os.getenv("ARCHIVE_ROOT", "/mnt/archive/star_group1")

#: The lab's rule: only images and Alicona / topography instrument files are read from the share,
#: never documents or plain-text data. So no ``.tif``, ``.xyz``, ``.asc``, ``.npy``, ``.mat``, ``.txt``,
#: ``.csv``, ``.dat``, ``.xlsx``, ``.zip``, ``.nc``, ``.hdf5``, ``.sxm`` and so on.
#: STARbase's "Add a surface scan" dialog offers the SAME list (packages/starbase-pages); change both
#: together. Lower case, no dot.
ALLOWED_EXTENSIONS: frozenset[str] = frozenset(
    {
        "al3d", "opd", "opdx", "x3p", "ibw", "h5", "datx", "sur", "plu", "apx", "plux",
        "vk3", "vk4", "vk6", "vk7", "lext", "zon", "os3d", "sdf", "frt", "mnt", "gwy",
        "mdt", "nms", "oir", "poir", "ezd", "nid", "bcr", "bcrf", "tmd", "zmg", "mi",
        "jpk", "qep", "spm",
    }
)  # fmt: skip


#: The namespace ``scripts/index_archive.py`` derives every archive file id from (``file_id``): the id of
#: a pointer row is ``uuid5(_NS, "file:" + <path relative to ARCHIVE_ROOT>)``. The crawler registers its
#: pointer rows with the same rule. Keep this value identical to that script's ``_NS``.
_ID_NAMESPACE = uuid.uuid5(uuid.NAMESPACE_DNS, "d1-database.archive-index.v1")


class RenderError(Exception):
    """The file must not (or cannot) be rendered; the message goes to ``render_error`` as is."""


def _extension_formats() -> dict[str, str]:
    """Allowed extension -> SurfaceTopography format id, for those the installed library can read."""
    out: dict[str, str] = {}
    for reader in readers:
        if reader.format() not in lookup_reader_by_format:
            continue
        for ext in reader.file_extensions():
            ext = ext.lower()
            if ext in ALLOWED_EXTENSIONS:
                out.setdefault(ext, reader.format())
    return out


#: Accepted extensions, each tied to one reader (so a file is never sniffed against every format).
#: An allowed extension with no installed reader is absent here and fails with its own message.
EXTENSION_FORMATS: dict[str, str] = _extension_formats()


def format_for(path: str) -> str:
    """The SurfaceTopography format id for *path*'s extension, or :class:`RenderError`."""
    ext = PurePosixPath(path.replace("\\", "/")).suffix.lstrip(".").lower()
    if ext not in ALLOWED_EXTENSIONS:
        shown = f".{ext}" if ext else "no extension"
        raise RenderError(
            f"Not a topography file format ({shown}); only topography instrument files are rendered."
        )
    fmt = EXTENSION_FORMATS.get(ext)
    if fmt is None:
        raise RenderError(
            f"The installed SurfaceTopography has no reader for .{ext} files."
        )
    return fmt


def expected_file_id(archive_path: str) -> str:
    """The id the archive indexer (and the crawler) give the pointer row of *archive_path*."""
    return str(uuid.uuid5(_ID_NAMESPACE, "file:" + archive_path))


def check_identity(file_id: str | None, archive_path: str | None) -> None:
    """Refuse a file row whose ``archive_path`` is not the path its id was derived from.

    ``metadata.archive_path`` is editable by every Lab Member (they can update ``directus_files``), so on
    its own it would let anyone repoint a scan at any topography file under the share, such as one in
    another person's personal folder, and publish its rendered surface lab-wide. The id is derived from
    the path by the indexer and cannot be changed, so a row whose id does not match its path was
    repointed (or was not registered by the indexer or crawler) and is not rendered.
    """
    if not file_id or not archive_path or not isinstance(archive_path, str):
        raise RenderError(
            "The file is not on the archive share (it has no archive_path)."
        )
    if str(file_id).lower() != expected_file_id(archive_path):
        raise RenderError(
            "The file's archive_path does not match its id (it was edited after the file was "
            "registered), so it is not rendered."
        )


def resolve(archive_path: str | None) -> Path:
    """Absolute path of *archive_path* inside the archive, or :class:`RenderError`.

    Does not touch the file. The extension is checked first, so a document is refused without even
    being looked up on the share.
    """
    if not archive_path or not isinstance(archive_path, str):
        raise RenderError(
            "The file is not on the archive share (it has no archive_path)."
        )
    if "\x00" in archive_path or "\\" in archive_path or archive_path.startswith("/"):
        raise RenderError("The file's archive_path is not a clean relative path.")
    parts = archive_path.split("/")
    if ".." in parts or "" in parts[:-1]:
        raise RenderError("The file's archive_path escapes the archive.")
    format_for(archive_path)

    mount = Path(os.path.realpath(ARCHIVE_MOUNT))
    root = Path(os.path.realpath(ARCHIVE_ROOT))
    if not root.is_relative_to(mount):
        raise RenderError("The archive root is not inside the archive mount.")
    target = Path(
        os.path.realpath(root.joinpath(*[p for p in parts if p and p != "."]))
    )
    if not target.is_relative_to(root):
        raise RenderError("The file resolves outside the archive.")
    format_for(target.name)  # a link must not lead to a file of another type
    return target


def stat_file(path: Path) -> os.stat_result:
    """``os.stat`` of a resolved archive file; a missing or non-regular file is a refusal."""
    try:
        st = os.stat(path)
    except FileNotFoundError:
        raise RenderError(
            "The file is not on the archive share (moved or deleted)."
        ) from None
    except OSError as err:
        raise RenderError(
            f"The archive share could not be read: {err.strerror or err}."
        ) from None
    if not stat.S_ISREG(st.st_mode):
        raise RenderError("The archive path is not a regular file.")
    return st


def _same_file(a: os.stat_result, b: os.stat_result) -> bool:
    return (
        a.st_dev == b.st_dev
        and a.st_ino == b.st_ino
        and a.st_size == b.st_size
        and a.st_mtime_ns == b.st_mtime_ns
    )


def open_readonly(path: Path, expected: os.stat_result) -> BinaryIO:
    """Open a resolved archive file for reading, only if it is still the file *expected* describes.

    *expected* is the :func:`stat_file` result the cache key was built from. The descriptor is opened
    ``O_RDONLY | O_NOFOLLOW`` (a symlink as the last component is refused) and ``fstat``-ed; a different
    inode, size or mtime, or a non-regular file, is refused. The caller closes the returned handle.
    This is the only place the worker opens a scan file.
    """
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0))
    except FileNotFoundError:
        raise RenderError(
            "The file is not on the archive share (moved or deleted)."
        ) from None
    except OSError as err:  # includes ELOOP for a symlink
        raise RenderError(
            f"The file could not be opened read-only: {err.strerror or err}."
        ) from None
    try:
        opened = os.fstat(fd)
        if not stat.S_ISREG(opened.st_mode):
            raise RenderError("The archive path is not a regular file.")
        if not _same_file(opened, expected):
            raise RenderError(
                "The file changed on the share while it was being checked; use Render again."
            )
        return os.fdopen(fd, "rb")
    except BaseException:
        os.close(fd)
        raise
