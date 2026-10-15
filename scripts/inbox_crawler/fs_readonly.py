"""The only module that touches the share, and it can only look.

ADR-0020, spec section 3. It exposes exactly three operations:

* `scandir(path)`  list a directory (symbolic links are left out, never followed);
* `stat(path)`     size and modification time of a path (a link is not followed);
* `open_rb(path, adopted=False)`  open a file for binary reading, but only if its extension is on
  `READ_ALLOWLIST` (images and surface scans), unless the caller passes `adopted=True`, which it may do
  only for a candidate a person has linked (`state='linked'`). Anything else raises `ReadRefused`
  before the file system is asked for anything.

`Share(root)` is the same three calls on share-relative paths ("Users/abc12de/sem/a.tif"); it keeps every
path inside the root. No other module imports `os`, `shutil` or `pathlib` for anything but string path
maths, and `tests/scripts/test_inbox_crawler_readonly.py` fails the build if any module (this one
included) calls a write, delete, rename, `chmod`, truncate or open-for-write function.
"""

from __future__ import annotations

import os
from typing import BinaryIO, NamedTuple

# Images the crawler reads (to hash them and look at the picture) before a person has linked them.
IMAGE_EXTENSIONS = (".tif", ".tiff", ".jpg", ".jpeg", ".png", ".bmp")
# Surface-scan files: tagged by extension, hashed at discovery, never opened for pixels. A config
# constant: widening it is a reviewed code change (ADR-0020). v1 = Alicona .al3d.
SCAN_EXTENSIONS = (".al3d",)
# What open_rb will open without `adopted=True`. Documents, .mat, camera raw and unknown types are not here.
READ_ALLOWLIST = frozenset(IMAGE_EXTENSIONS + SCAN_EXTENSIONS)


class ReadRefused(Exception):  # noqa: N818 (a refusal, not an error of the share)
    """open_rb was asked for a file the allow-list does not cover (and `adopted` was not set)."""


class Entry(NamedTuple):
    name: str
    is_dir: bool
    is_file: bool


class Stat(NamedTuple):
    size: int
    mtime_ns: int
    is_dir: bool
    is_file: bool


def extension(name: str) -> str:
    """Lower-cased extension with its dot ('' when none). Pure string work."""
    return os.path.splitext(name)[1].lower()


def scandir(path: str) -> list[Entry]:
    """The entries of a directory, symbolic links left out. OSError propagates."""
    out: list[Entry] = []
    with os.scandir(path) as it:
        for e in it:
            if e.is_symlink():
                continue
            out.append(
                Entry(
                    e.name,
                    e.is_dir(follow_symlinks=False),
                    e.is_file(follow_symlinks=False),
                )
            )
    return out


def stat(path: str) -> Stat:
    """One metadata call; does not follow a link. OSError propagates."""
    st = os.stat(path, follow_symlinks=False)
    is_dir = (st.st_mode & 0o170000) == 0o040000
    is_file = (st.st_mode & 0o170000) == 0o100000
    return Stat(st.st_size, st.st_mtime_ns, is_dir, is_file)


def open_rb(path: str, adopted: bool = False) -> BinaryIO:
    """Open for binary reading. Refuses (ReadRefused) anything the allow-list does not cover."""
    ext = extension(path)
    if not adopted and ext not in READ_ALLOWLIST:
        raise ReadRefused(
            f"{ext or 'a file without an extension'} is not on the read allow-list; "
            "only a file a person has linked may be read"
        )
    return open(path, "rb")


class Share:
    """The share seen through share-relative POSIX paths ("" is the root). Read-only by construction."""

    def __init__(self, root: str):
        self.root = root

    def _full(self, rel: str) -> str:
        if "\\" in rel or rel.startswith("/") or (len(rel) > 1 and rel[1] == ":"):
            raise ValueError(f"not a share-relative path: {rel!r}")
        parts = [p for p in rel.split("/") if p not in ("", ".")]
        if ".." in parts:
            raise ValueError(f"path leaves the share: {rel!r}")
        return os.path.join(self.root, *parts) if parts else self.root

    def scandir(self, rel: str = "") -> list[Entry]:
        return scandir(self._full(rel))

    def stat(self, rel: str = "") -> Stat:
        return stat(self._full(rel))

    def open_rb(self, rel: str, adopted: bool = False) -> BinaryIO:
        full = self._full(rel)
        # A link inside the share must not lead the read outside it.
        real_root = os.path.realpath(self.root)
        real = os.path.realpath(full)
        if real != real_root and not real.startswith(real_root.rstrip(os.sep) + os.sep):
            raise ReadRefused(f"{rel!r} resolves outside the share")
        return open_rb(full, adopted=adopted)
