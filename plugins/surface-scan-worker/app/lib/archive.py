"""Reading a scan file from the read-only archive share, and only that.

The share is mounted at ``/mnt/archive`` (``:ro`` in compose, ``ro`` in the CIFS options: the same
volume the archive indexer reads). ``directus_files.metadata.archive_path`` is relative to
``ARCHIVE_ROOT`` (``/mnt/archive/star_group1``, the root ``scripts/index_archive.py`` indexes).

Three refusals, all before a single byte is read:

* a path that is not a clean relative path (absolute, ``..``, backslash, NUL) or that resolves, after
  symlinks, outside ``ARCHIVE_ROOT`` (which itself must sit inside ``ARCHIVE_MOUNT``);
* an extension that is not a topography format SurfaceTopography reads, or that is on
  :data:`NOT_TOPOGRAPHY`: documents, spreadsheets, archives and the force-recording ``.mat`` files, which
  SurfaceTopography could technically open but must not be pointed at;
* anything that is not a regular file.

:func:`open_readonly` is the only place a file is opened, always ``'rb'`` (``O_RDONLY``).
"""

from __future__ import annotations

import os
import stat
from pathlib import Path, PurePosixPath
from typing import BinaryIO

from SurfaceTopography.IO import lookup_reader_by_format, readers

ARCHIVE_MOUNT = os.getenv("ARCHIVE_MOUNT", "/mnt/archive")
ARCHIVE_ROOT = os.getenv("ARCHIVE_ROOT", "/mnt/archive/star_group1")

#: Extensions some SurfaceTopography reader claims but that, on this share, are documents, tables,
#: archives or force recordings (``.mat`` is the D1 force format). Never opened.
NOT_TOPOGRAPHY: frozenset[str] = frozenset(
    {"mat", "txt", "csv", "dat", "xlsx", "zip", "nc"}
)


class RenderRefused(Exception):
    """The file must not (or cannot) be rendered; the message goes to ``render_error`` as is."""


def _extension_formats() -> dict[str, str]:
    """Lower-case extension (no dot) -> SurfaceTopography format id, minus :data:`NOT_TOPOGRAPHY`."""
    out: dict[str, str] = {}
    for reader in readers:
        for ext in reader.file_extensions():
            ext = ext.lower()
            if ext not in NOT_TOPOGRAPHY:
                out.setdefault(ext, reader.format())
    return out


#: Accepted extensions, each tied to one reader (so a file is never sniffed against every format).
EXTENSION_FORMATS: dict[str, str] = _extension_formats()


def format_for(path: str) -> str:
    """The SurfaceTopography format id for *path*'s extension, or :class:`RenderRefused`."""
    ext = PurePosixPath(path.replace("\\", "/")).suffix.lstrip(".").lower()
    fmt = EXTENSION_FORMATS.get(ext)
    if fmt is None or fmt not in lookup_reader_by_format:
        shown = f".{ext}" if ext else "no extension"
        raise RenderRefused(f"Not a topography file format ({shown}); only topography files are rendered.")
    return fmt


def resolve(archive_path: str | None) -> Path:
    """Absolute path of *archive_path* inside the archive, or :class:`RenderRefused`.

    Does not touch the file. The extension is checked first, so a document is refused without even
    being looked up on the share.
    """
    if not archive_path or not isinstance(archive_path, str):
        raise RenderRefused("The file is not on the archive share (it has no archive_path).")
    if "\x00" in archive_path or "\\" in archive_path or archive_path.startswith("/"):
        raise RenderRefused("The file's archive_path is not a clean relative path.")
    parts = archive_path.split("/")
    if ".." in parts or "" in parts[:-1]:
        raise RenderRefused("The file's archive_path escapes the archive.")
    format_for(archive_path)

    mount = Path(os.path.realpath(ARCHIVE_MOUNT))
    root = Path(os.path.realpath(ARCHIVE_ROOT))
    if not root.is_relative_to(mount):
        raise RenderRefused("The archive root is not inside the archive mount.")
    target = Path(os.path.realpath(root.joinpath(*[p for p in parts if p and p != "."])))
    if not target.is_relative_to(root):
        raise RenderRefused("The file resolves outside the archive.")
    return target


def stat_file(path: Path) -> os.stat_result:
    """``os.stat`` of a resolved archive file; a missing or non-regular file is a refusal."""
    try:
        st = path.stat()
    except FileNotFoundError:
        raise RenderRefused("The file is not on the archive share (moved or deleted).") from None
    except OSError as err:
        raise RenderRefused(f"The archive share could not be read: {err.strerror or err}.") from None
    if not stat.S_ISREG(st.st_mode):
        raise RenderRefused("The archive path is not a regular file.")
    return st


def open_readonly(path: Path) -> BinaryIO:
    """Open a resolved archive file for reading. The only ``open`` in the worker."""
    return open(path, "rb")  # noqa: SIM115 - the caller closes it
