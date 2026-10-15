"""A file's identity is the indexer's: uuid5 of its path relative to star_group1.

The rule lives in `scripts/index_archive.py`; it is imported here, not copied, so the crawler and the
indexer can never disagree about which `directus_files` row is which file. (Importing that module does no
work and needs no database driver.)
"""

from __future__ import annotations

import os.path
import sys

_SCRIPTS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _SCRIPTS not in sys.path:
    sys.path.insert(0, _SCRIPTS)

import index_archive  # noqa: E402

file_id = index_archive.file_id
folder_id = index_archive.folder_id
guess_type = index_archive.guess_type
FILENAME_DISK_MAX = index_archive._FILENAME_DISK_MAX  # noqa: SLF001 (the same limit the indexer applies)
