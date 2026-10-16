"""The inbox crawler never changes the share (ADR-0020, spec section 3, skill inbox-crawler-conventions).

Three layers are tested here:

* an AST scan of the whole `scripts/inbox_crawler` package (subpackages too) that fails on any write, delete,
  rename, chmod, truncate, copy, move, exec or spawn call or reference, on reflection and dynamic code, on any
  `open` outside `fs_readonly.open_rb`, on an import that is not on the module's allow-list, and on Pillow
  anywhere but classify_image's guarded BytesIO and thumbs.make_thumbnails' guarded bytes (its one `save` goes
  to an in-memory BytesIO);
* `open_rb` refuses every file type that is not on the read allow-list (documents, .mat, ...);
* a share that vanishes mid-scan aborts the scan and marks nothing gone (see the end of this file).
"""

from __future__ import annotations

import ast
import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
PKG = ROOT / "scripts" / "inbox_crawler"
sys.path.insert(0, str(ROOT / "scripts"))

from inbox_crawler import fs_readonly as fsr  # noqa: E402

# ---- the AST checker ------------------------------------------------------------------
#
# The package is scanned module by module (subpackages too). Every module except fs_readonly may import
# ONLY what ALLOWED_IMPORTS lists for it, so a new import is a reviewed change to this table. On top of that:
# no write, delete, rename, copy, move, exec or spawn call or reference by any name or attribute; no dynamic
# trickery (getattr, eval, exec, compile, __import__, importlib, vars, globals, dunder attributes); `open`
# only in fs_readonly, only with a literal "rb", never assigned to a variable; Pillow only on a BytesIO.

# Calls and references whose name starts with one of these are writes, deletes, renames, copies, moves,
# process starts or kills, whatever object they are on (os.remove, Path.unlink, shutil.copyfile, f.write ...).
FORBIDDEN_PREFIXES = (
    "write",
    "copy",
    "move",
    "remove",
    "rename",
    "unlink",
    "mkdir",
    "makedirs",
    "chmod",
    "chown",
    "lchown",
    "fchmod",
    "fchown",
    "truncate",
    "ftruncate",
    "utime",
    "symlink",
    "rmdir",
    "rmtree",
    "exec",
    "spawn",
    "posix_spawn",
    "fork",
    "popen",
    "kill",
)
# `execute` is the database cursor's, not os.exec*.
PREFIX_EXCEPTIONS = frozenset({"execute", "executemany"})
# Exact names that are just as bad but too common as a prefix (`link`, `replace`, `save`).
FORBIDDEN_NAMES = frozenset(
    {
        "replace",
        "link",
        "touch",
        "system",
        "save",
        "mkfifo",
        "mknod",
        "startfile",
        "fdopen",
        "lutimes",
        "FileIO",
    }
)
# Reflection and dynamic code: ways to reach a forbidden call without writing its name.
DYNAMIC_NAMES = frozenset(
    {
        "getattr",
        "setattr",
        "delattr",
        "vars",
        "globals",
        "locals",
        "__import__",
        "eval",
        "exec",
        "compile",
        "breakpoint",
        "__builtins__",
        "importlib",
    }
)
DUNDER_ALLOWED = frozenset({"__name__", "__doc__"})
FORBIDDEN_ATTRS = frozenset(
    {"O_WRONLY", "O_RDWR", "O_CREAT", "O_TRUNC", "O_APPEND", "O_EXCL"}
)
# Imports no module may make, whatever the table says (a belt over the braces). fs_readonly may not take
# them either, apart from nothing: it needs only os, errno, stat and typing.
NEVER_IMPORT = frozenset(
    {
        "shutil",
        "subprocess",
        "ctypes",
        "mmap",
        "tempfile",
        "importlib",
        "builtins",
        "pathlib",
        "socket",
        "pickle",
        "sqlite3",
        "zipfile",
        "tarfile",
        "gzip",
        "bz2",
        "lzma",
        "shelve",
        "dbm",
        "fcntl",
        "pty",
        "code",
        "codecs",
        "multiprocessing",
        "concurrent",
        "asyncio",
    }
)

# module name -> what it may import (top-level module or dotted name). Relative imports (from . import x)
# and `from __future__ import annotations` are always fine.
ALLOWED_IMPORTS: dict[str, frozenset[str]] = {
    "__init__": frozenset(),
    "__main__": frozenset({"argparse", "logging", "os", "signal", "sys", "threading"}),
    "autolink": frozenset(
        {"json", "logging", "time", "urllib.error", "urllib.request"}
    ),
    "classify_scan": frozenset(),
    "classify_sem": frozenset(
        {
            "re",
            "warnings",
            "collections.abc",
            "dataclasses",
            "typing",
            "io",
            "PIL",
            "pytesseract",
        }
    ),
    "daemon": frozenset({"logging", "threading", "dataclasses", "datetime"}),
    "db": frozenset({"json", "logging", "dataclasses", "datetime", "psycopg2"}),
    "hashing": frozenset({"hashlib", "logging", "time", "dataclasses"}),
    "identity": frozenset({"os.path", "sys", "index_archive"}),
    "kinds": frozenset({"dataclasses"}),
    "owners": frozenset({"collections.abc", "dataclasses"}),
    "recognise": frozenset({"re", "collections.abc", "dataclasses"}),
    "scan": frozenset({"io", "logging", "time", "dataclasses"}),
    "thumbs": frozenset({"warnings", "dataclasses", "io", "PIL"}),
}
PACKAGE_MODULES = frozenset(ALLOWED_IMPORTS) | {"fs_readonly"}
# (module, imported name) -> the attributes of it that module may use; anything else is refused. `io` is
# BytesIO only; `os` and `sys` only what the entry points and the path set-up need.
ATTR_ALLOWED: dict[tuple[str, str], frozenset[str]] = {
    ("__main__", "os"): frozenset({"environ"}),
    ("__main__", "sys"): frozenset({"exit"}),
    ("identity", "sys"): frozenset({"path"}),
    ("identity", "os"): frozenset({"path"}),
    ("autolink", "urllib.request"): frozenset(
        {"Request", "build_opener", "ProxyHandler", "HTTPRedirectHandler", "urlopen"}
    ),
}
IMAGE_ATTRS = frozenset(
    {"open", "BOX", "DecompressionBombWarning", "MAX_IMAGE_PIXELS", "LANCZOS"}
)
# which `from PIL import ...` lines a module may have (one name per line)
PIL_IMPORTS: dict[str, list[list[str]]] = {
    "classify_sem": [["Image"]],
    "thumbs": [["Image", "ImageOps"]],
}
IMAGEOPS_ATTRS = frozenset({"exif_transpose"})
# What the package may use of the indexer: the id rule and the move re-pointing, nothing that walks or
# writes (index_archive.main, fingerprint, ...).
INDEX_ARCHIVE_ATTRS = frozenset(
    {
        "file_id",
        "folder_id",
        "guess_type",
        "_FILENAME_DISK_MAX",
        "find_file_fk_columns",
        "repoint_file_references",
    }
)


def _is_binary_read_mode(call: ast.Call) -> bool:
    mode = None
    if len(call.args) >= 2 and isinstance(call.args[1], ast.Constant):
        mode = call.args[1].value
    for kw in call.keywords:
        if kw.arg == "mode" and isinstance(kw.value, ast.Constant):
            mode = kw.value.value
    return mode == "rb"


def _dotted(node) -> str | None:
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
        return ".".join(reversed(parts))
    return None


def _forbidden_name(name: str) -> bool:
    if name in PREFIX_EXCEPTIONS:
        return False
    return name in FORBIDDEN_NAMES or name.startswith(FORBIDDEN_PREFIXES)


def _descendants(node) -> set[int]:
    return {id(n) for n in ast.walk(node)}


def violations(source: str, module: str) -> list[str]:
    """Every rule the module breaks, as 'module:line: what'."""
    tree = ast.parse(source)
    found: list[str] = []
    is_fs = module == "fs_readonly"
    allowed = ALLOWED_IMPORTS.get(module, frozenset())

    def bad(node, what):
        found.append(f"{module}:{getattr(node, 'lineno', 0)}: {what}")

    # ---- imports
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                if a.asname:
                    bad(
                        node,
                        f"import {a.name} as {a.asname} (an alias hides what is called)",
                    )
                if a.name.split(".")[0] in NEVER_IMPORT:
                    bad(node, f"import {a.name}")
                elif not is_fs and a.name not in allowed:
                    bad(node, f"import {a.name} is not on {module}'s import allow-list")
        elif isinstance(node, ast.ImportFrom):
            for a in node.names:
                if a.asname:
                    bad(node, f"from {node.module} import {a.name} as {a.asname}")
            if node.level:  # inside the package
                mods = (
                    [a.name for a in node.names]
                    if node.module is None
                    else [node.module.split(".")[0]]
                )
                for m in mods:
                    if m not in PACKAGE_MODULES:
                        bad(
                            node, f"relative import of {m}: not a module of the package"
                        )
                continue
            mod = node.module or ""
            names = [a.name for a in node.names]
            if mod == "__future__":
                continue
            if mod.split(".")[0] in NEVER_IMPORT:
                bad(node, f"from {mod} import ...")
            elif is_fs:
                continue
            elif mod == "io":
                if names != ["BytesIO"]:
                    bad(node, "from io import anything but BytesIO")
            elif mod == "PIL":
                if names not in PIL_IMPORTS.get(module, []):
                    bad(
                        node,
                        "from PIL import anything but Image (classify_sem) or Image, ImageOps (thumbs)",
                    )
            elif mod in ("os", "sys"):
                ok = ATTR_ALLOWED.get((module, mod))
                if mod not in allowed or ok is None or not set(names) <= ok:
                    bad(node, f"from {mod} import {', '.join(names)}")
            elif mod not in allowed:
                bad(
                    node,
                    f"from {mod} import ... is not on {module}'s import allow-list",
                )

    # ---- thumbs: Pillow only inside make_thumbnails (on a BytesIO of `data`, which must be bytes) and
    # _encode_jpeg (the one `save`, to a BytesIO it made itself)
    thumbs_open_nodes: set[int] = set()
    thumbs_guarded = False
    save_nodes: set[int] = set()  # the `.save` attribute nodes that are allowed
    for node in ast.walk(tree):
        if module != "thumbs" or not isinstance(node, ast.FunctionDef):
            continue
        if node.name == "make_thumbnails":
            thumbs_open_nodes |= _descendants(node)
            for n in ast.walk(node):
                if (
                    isinstance(n, ast.Call)
                    and isinstance(n.func, ast.Name)
                    and n.func.id == "isinstance"
                    and len(n.args) == 2
                    and isinstance(n.args[0], ast.Name)
                    and n.args[0].id == "data"
                    and isinstance(n.args[1], ast.Name)
                    and n.args[1].id == "bytes"
                ):
                    thumbs_guarded = True
        elif node.name == "_encode_jpeg":
            made_buf = any(
                isinstance(n, ast.Assign)
                and len(n.targets) == 1
                and isinstance(n.targets[0], ast.Name)
                and n.targets[0].id == "buf"
                and isinstance(n.value, ast.Call)
                and isinstance(n.value.func, ast.Name)
                and n.value.func.id == "BytesIO"
                and not n.value.args
                for n in ast.walk(node)
            )
            for n in ast.walk(node):
                if (
                    made_buf
                    and isinstance(n, ast.Call)
                    and isinstance(n.func, ast.Attribute)
                    and n.func.attr == "save"
                    and isinstance(n.func.value, ast.Name)
                    and n.func.value.id == "img"
                    and n.args
                    and isinstance(n.args[0], ast.Name)
                    and n.args[0].id == "buf"
                ):
                    save_nodes.add(id(n.func))

    # ---- reflection, dynamic code, dunders, file-writing log handlers
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and node.id in DYNAMIC_NAMES:
            bad(node, f"{node.id} (reflection or dynamic code)")
        elif isinstance(node, ast.Attribute):
            if node.attr in DYNAMIC_NAMES and _dotted(node) != "re.compile":
                bad(node, f".{node.attr} (reflection or dynamic code)")
            if (
                node.attr.startswith("__")
                and node.attr.endswith("__")
                and node.attr not in DUNDER_ALLOWED
            ):
                bad(node, f".{node.attr} (a dunder attribute)")
            if node.attr in FORBIDDEN_ATTRS:
                bad(node, f"open flag {node.attr}")
            if "FileHandler" in node.attr or node.attr == "handlers":
                bad(node, f".{node.attr} (a logging handler that writes files)")
        elif isinstance(node, ast.Call):
            for kw in node.keywords:
                if kw.arg in ("filename", "filemode", "stream"):
                    bad(node, f"keyword {kw.arg}= (logging or streaming to a file)")

    # ---- forbidden names, by call AND by reference (so `rm = os.remove` is caught too)
    for node in ast.walk(tree):
        name = (
            node.attr
            if isinstance(node, ast.Attribute)
            else node.id
            if isinstance(node, ast.Name)
            else None
        )
        if name and _forbidden_name(name) and id(node) not in save_nodes:
            bad(node, f"{name} (write, delete, rename, copy, move, exec or spawn)")

    # ---- Pillow: only inside classify_image, only on `fh`, which is refused unless it is a BytesIO
    classify_image_nodes: set[int] = set()
    guarded = False
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == "classify_image":
            classify_image_nodes |= _descendants(node)
            for n in ast.walk(node):
                if (
                    isinstance(n, ast.Call)
                    and isinstance(n.func, ast.Name)
                    and n.func.id == "isinstance"
                    and len(n.args) == 2
                    and isinstance(n.args[0], ast.Name)
                    and n.args[0].id == "fh"
                    and isinstance(n.args[1], ast.Name)
                    and n.args[1].id == "BytesIO"
                ):
                    guarded = True

    # ---- open: only fs_readonly, only "rb", never as a value
    ok_funcs: set[int] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        f = node.func
        if isinstance(f, ast.Name) and f.id == "open":
            if is_fs and _is_binary_read_mode(node):
                ok_funcs.add(id(f))
            elif is_fs:
                bad(node, 'open() with a mode other than "rb"')
            else:
                bad(node, "open() outside fs_readonly")
        elif isinstance(f, ast.Attribute) and f.attr == "open":
            image_open = (
                isinstance(f.value, ast.Name)
                and f.value.id == "Image"
                and module == "classify_sem"
                and len(node.args) == 1
                and isinstance(node.args[0], ast.Name)
                and node.args[0].id == "fh"
                and {k.arg for k in node.keywords} <= {"formats"}
            )
            thumbs_image_open = (
                isinstance(f.value, ast.Name)
                and f.value.id == "Image"
                and module == "thumbs"
                and len(node.args) == 1
                and isinstance(node.args[0], ast.Call)
                and isinstance(node.args[0].func, ast.Name)
                and node.args[0].func.id == "BytesIO"
                and len(node.args[0].args) == 1
                and isinstance(node.args[0].args[0], ast.Name)
                and node.args[0].args[0].id == "data"
                and {k.arg for k in node.keywords} <= {"formats"}
            )
            if image_open and id(node) in classify_image_nodes and guarded:
                ok_funcs.add(id(f))
            elif thumbs_image_open and id(node) in thumbs_open_nodes and thumbs_guarded:
                ok_funcs.add(id(f))
            elif (
                module == "autolink"
                and isinstance(f.value, ast.Attribute)
                and f.value.attr == "_opener"
                and _dotted(f.value) == "self._opener"
            ):
                ok_funcs.add(
                    id(f)
                )  # the no-redirect, no-proxy opener autolink built (a URL, never a path)
            elif (
                is_fs
                and isinstance(f.value, ast.Name)
                and f.value.id == "os"
                and len(node.args) == 2
                and any(
                    isinstance(n, ast.Attribute) and n.attr == "O_NOFOLLOW"
                    for n in ast.walk(node.args[1])
                )
            ):
                ok_funcs.add(
                    id(f)
                )  # fs_readonly's opener: os.open(path, flags | O_NOFOLLOW | extra)
            else:
                bad(
                    node,
                    "a .open() call (Pillow only on classify_image's or make_thumbnails' guarded BytesIO)",
                )
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Name)
            and node.id == "open"
            and id(node) not in ok_funcs
        ):
            bad(node, "open used as a value (assigned, passed or aliased)")
        elif (
            isinstance(node, ast.Attribute)
            and node.attr == "open"
            and id(node) not in ok_funcs
        ):
            if not any(
                isinstance(p, ast.Call) and p.func is node for p in ast.walk(tree)
            ):
                bad(node, ".open used as a value")

    # ---- what a package module may touch of the modules it imports (fs_readonly: only its own checks)
    if not is_fs:
        for node in ast.walk(tree):
            if not isinstance(node, ast.Attribute):
                continue
            dotted = _dotted(node)
            if dotted is None:
                continue
            parts = dotted.split(".")
            head, n = parts[0], len(parts)
            if (
                head in ("os", "sys")
                and n == 2
                and node.attr not in ATTR_ALLOWED.get((module, head), frozenset())
            ):
                bad(
                    node,
                    f"{head}.{node.attr} is not on {module}'s attribute allow-list",
                )
            elif head == "io" and n == 2 and node.attr != "BytesIO":
                bad(node, f"io.{node.attr} (only BytesIO)")
            elif head == "Image" and n == 2 and node.attr not in IMAGE_ATTRS:
                bad(node, f"Image.{node.attr}")
            elif head == "ImageOps" and n == 2 and node.attr not in IMAGEOPS_ATTRS:
                bad(node, f"ImageOps.{node.attr}")
            elif parts[:2] == ["urllib", "request"] and n == 3:
                if node.attr not in ATTR_ALLOWED.get(
                    (module, "urllib.request"), frozenset()
                ):
                    bad(node, f"urllib.request.{node.attr}")
            elif (
                head == "index_archive"
                and n == 2
                and node.attr not in INDEX_ARCHIVE_ATTRS
            ):
                bad(node, f"index_archive.{node.attr}")
            elif parts[:2] == ["identity", "index_archive"]:
                if module != "db":
                    bad(node, "identity.index_archive outside db")
                elif n == 3 and node.attr not in INDEX_ARCHIVE_ATTRS:
                    bad(node, f"index_archive.{node.attr}")
        # classify_image is only ever given an in-memory BytesIO
        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                fn = node.func
                called = (
                    fn.id
                    if isinstance(fn, ast.Name)
                    else fn.attr
                    if isinstance(fn, ast.Attribute)
                    else None
                )
                if called == "classify_image" and module != "classify_sem":
                    first = node.args[0] if node.args else None
                    if not (
                        isinstance(first, ast.Call)
                        and (_dotted(first.func) or "") in ("io.BytesIO", "BytesIO")
                    ):
                        bad(node, "classify_image must be given io.BytesIO(...)")
        if module == "classify_sem" and classify_image_nodes and not guarded:
            bad(
                tree,
                "classify_image must refuse anything that is not a BytesIO (isinstance(fh, BytesIO))",
            )
        # make_thumbnails is only ever given the bytes themselves: `x.data` (a HashOutcome's) or a name
        # `data`, never a path, a handle or a call that opens one
        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                fn = node.func
                called = (
                    fn.id
                    if isinstance(fn, ast.Name)
                    else fn.attr
                    if isinstance(fn, ast.Attribute)
                    else None
                )
                if called == "make_thumbnails" and module != "thumbs":
                    first = node.args[0] if node.args else None
                    if not (
                        len(node.args) == 1
                        and not node.keywords
                        and (
                            (isinstance(first, ast.Attribute) and first.attr == "data")
                            or (isinstance(first, ast.Name) and first.id == "data")
                        )
                    ):
                        bad(
                            node, "make_thumbnails must be given `<outcome>.data` bytes"
                        )
        if module == "thumbs" and thumbs_open_nodes and not thumbs_guarded:
            bad(
                tree,
                "make_thumbnails must refuse anything that is not bytes (isinstance(data, bytes))",
            )
    return found


def package_modules() -> list[Path]:
    return sorted(p for p in PKG.rglob("*.py") if "__pycache__" not in p.parts)


def module_name(path: Path) -> str:
    return path.relative_to(PKG).with_suffix("").as_posix()


def test_package_is_there():
    assert (PKG / "fs_readonly.py").is_file()


def test_every_module_of_the_package_is_known_to_the_import_table():
    names = {module_name(p) for p in package_modules()}
    assert (
        names - {"fs_readonly"} == set(ALLOWED_IMPORTS)
    ), "a new module needs a reviewed entry in ALLOWED_IMPORTS (and a removed one must leave it)"


@pytest.mark.parametrize("path", package_modules(), ids=module_name)
def test_module_has_no_write_delete_rename_or_open_for_write(path):
    found = violations(path.read_text(encoding="utf-8"), module_name(path))
    assert not found, "\n".join(found)


def test_the_package_uses_of_the_indexer_are_exactly_the_allowed_ones():
    used = set()
    for path in package_modules():
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Attribute):
                d = _dotted(node)
                if d and d.startswith("index_archive."):
                    used.add(d.split(".")[1])
                if d and d.startswith("identity.index_archive."):
                    used.add(d.split(".")[2])
    assert (
        used and used <= INDEX_ARCHIVE_ATTRS
    )  # nothing but the id rule and the re-pointing


# The checker itself: each forbidden thing is caught, the allowed things are not. A snippet is checked as if it
# were module `scan` unless it says otherwise.
BYPASSES = [
    # direct writes, deletes, renames
    "import os\nos.remove(p)",
    "import os\nos.unlink(p)",
    "import os\nos.rename(a, b)",
    "import os\nos.replace(a, b)",
    "import os\nos.rmdir(p)",
    "import os\nos.mkdir(p)",
    "import os\nos.makedirs(p)",
    "import os\nos.chmod(p, 0o600)",
    "import os\nos.truncate(p, 0)",
    "import os\nos.utime(p)",
    "import os\nos.symlink(a, b)",
    "import shutil\nshutil.copyfile(a, b)",
    "from shutil import move",
    "import shutil",
    "import subprocess",
    "from pathlib import Path\nPath(p).write_text('x')",
    "from pathlib import Path",
    "p.write_bytes(b'x')",
    "p.unlink()",
    "p.touch()",
    "f.write(b'x')",
    "f.writelines([])",
    "x.copy2(a, b)",
    # open
    "open(p)",
    "open(p, 'w')",
    "open(p, 'wb')",
    "open(p, 'ab')",
    "open(p, 'r+b')",
    "open(p, mode='w')",
    "open(p, 'rb')",  # outside fs_readonly even a read is refused
    "import io\nio.open(p, 'rb')",
    "import os\nos.fdopen(1)",
    "import os\nos.open(p, os.O_WRONLY)",
    "import os\nfd = os.O_CREAT",
    "img.save(p)",
    # the reviewer's bypasses
    "import os as o\no.spawnlp(os.P_WAIT, 'rm', 'rm', p)",
    "import os\ngetattr(os, 're' + 'move')(p)",
    "eval(\"open(p,'w')\")",
    'exec("import os; os.remove(p)")',
    "import io\nio.FileIO(p, 'w')",
    "_o = open\n_o(p, 'wb')",
    "fs = [open]\nfs[0](p, 'wb')",
    "import logging\nlogging.FileHandler(p)",
    "import logging\nlogging.basicConfig(filename=p)",
    "import sqlite3\nsqlite3.connect(p)",
    "import zipfile\nzipfile.ZipFile(p)",
    "import sys\nsys.modules['os'].execv('/bin/rm', ['rm', p])",
    "from PIL import Image\nImage.open(rel_path_string)",
    "from PIL import Image\nImage.open('a.tif')",
    "from PIL import Image\nImage.open(p + 'a.tif')",
    # more ways round
    "__import__('os').remove(p)",
    "import importlib\nimportlib.import_module('os')",
    "compile('1', 'x', 'exec')",
    "vars(os)['remove'](p)",
    "globals()['open'](p, 'w')",
    "x = __builtins__",
    "().__class__.__mro__",
    "import os\nrm = os.remove\nrm(p)",
    "import os\nos.execv('/bin/rm', ['rm'])",
    "import os\nos.posix_spawn('/bin/rm', ['rm'], {})",
    "import os\nos.fork()",
    "import os\nos.popen('rm x')",
    "import os\nos.system('rm x')",
    "import os\nos.kill(1, 9)",
    "import os\nos.scandir(p)",
    "import os\nos.stat(p)",
    "from os import walk",
    "import ctypes",
    "import tempfile",
    "import mmap",
    "import socket",
    "import http.server",
    "import pickle",
    "import builtins\nbuiltins.open(p, 'w')",
    "import io\nio.StringIO()",
    "import index_archive\nindex_archive.main()",
    "import urllib.request\nurllib.request.urlretrieve(u, p)",
    "import psycopg2\npsycopg2.connect(d).cursor().copy_expert('COPY x TO STDOUT', f)",
]
# Snippets that are only bad in the module they are checked as.
BYPASSES_AS = [
    ("opener.open(url)", "autolink"),  # only self._opener.open
    ("self._opener.open(url)", "scan"),
    ("import io", "hashing"),  # `io` is on the table for scan only
    ("import index_archive\nindex_archive.main()", "identity"),
    ("import index_archive\nindex_archive.fingerprint(p, 1)", "identity"),
    ("import urllib.request\nurllib.request.urlretrieve(u, p)", "autolink"),
    ("import sys\nsys.modules['os']", "__main__"),
    ("import sys\nsys.path.insert(0, p)", "__main__"),
    ("import os\nos.environ.copy()", "__main__"),
    ("import os\nos.getcwd()", "__main__"),
    ("from os import getcwd", "__main__"),
    (
        "from PIL import Image\nImage.open(fh)",
        "classify_sem",
    ),  # not inside a guarded classify_image
    (
        "from PIL import Image\ndef classify_image(fh):\n    return Image.open(fh)",
        "classify_sem",
    ),  # no BytesIO guard
    (
        "from io import BytesIO\nfrom PIL import Image\ndef classify_image(fh):\n"
        "    if not isinstance(fh, BytesIO):\n        raise TypeError\n    return Image.open(fh, 'x')",
        "classify_sem",
    ),
    (
        "from io import BytesIO\nfrom PIL import Image\ndef other(fh):\n"
        "    return Image.open(fh)\ndef classify_image(fh):\n    isinstance(fh, BytesIO)",
        "classify_sem",
    ),
    ("from PIL import Image\nImage.new('L', (1, 1))", "classify_sem"),
    # thumbs: Pillow only on make_thumbnails' bytes, and the one save only to its own BytesIO
    ("img.save(p)", "thumbs"),
    ("img.save(buf)", "classify_sem"),
    ("def other(img, buf):\n    img.save(buf)", "thumbs"),
    ("def _encode_jpeg(img, q):\n    img.save(path)", "thumbs"),
    (
        "def _encode_jpeg(img, q):\n    buf = opener(p)\n    img.save(buf, 'JPEG')",
        "thumbs",
    ),
    (
        "from io import BytesIO\ndef _encode_jpeg(img, q):\n    buf = BytesIO()\n    other.save(buf, 'JPEG')",
        "thumbs",
    ),
    ("from PIL import Image\nImage.open(fh)", "thumbs"),
    ("from PIL import Image\nImage.open(rel)", "thumbs"),
    (
        "from io import BytesIO\nfrom PIL import Image\ndef other(data):\n    return Image.open(BytesIO(data))",
        "thumbs",
    ),
    (  # no isinstance(data, bytes) guard
        "from io import BytesIO\nfrom PIL import Image\ndef make_thumbnails(data):\n"
        "    return Image.open(BytesIO(data))",
        "thumbs",
    ),
    (  # a path through the BytesIO
        "from io import BytesIO\nfrom PIL import Image\ndef make_thumbnails(data):\n"
        "    if not isinstance(data, bytes):\n        return None\n    return Image.open(BytesIO(path))",
        "thumbs",
    ),
    ("from PIL import Image\nImage.new('L', (1, 1))", "thumbs"),
    ("from PIL import ImageFile", "thumbs"),
    ("from PIL import ImageOps", "thumbs"),
    ("from PIL import ImageOps\nImageOps.autocontrast(img)", "thumbs"),
    ("from PIL import ImageOps", "scan"),
    ("from PIL import Image", "scan"),
    ("x = thumbs.make_thumbnails(rel)", "scan"),
    ("x = thumbs.make_thumbnails(open_rb(p))", "daemon"),
    ("x = thumbs.make_thumbnails(fh.read())", "daemon"),
    ("x = thumbs.make_thumbnails(out.data, 1)", "daemon"),
    ("x = thumbs.make_thumbnails(data=out.data)", "daemon"),
]


@pytest.mark.parametrize("snippet", BYPASSES)
def test_checker_catches(snippet):
    assert violations(snippet, "scan"), snippet


@pytest.mark.parametrize("snippet,module", BYPASSES_AS)
def test_checker_catches_in_the_module_it_matters(snippet, module):
    assert violations(snippet, module), (module, snippet)


def test_imports_outside_the_table_are_refused_even_if_harmless():
    for src in (
        "import json",
        "import errno",
        "import random",
        "from typing import Any",
    ):
        assert violations(src, "hashing"), src
    assert violations(
        "import json", "some_new_module"
    )  # an unknown module may import nothing


CLEAN = [
    (
        "class A:\n    def f(self, req):\n        return self._opener.open(req, timeout=1)",
        "autolink",
    ),
    (
        "import urllib.request\no = urllib.request.build_opener(urllib.request.ProxyHandler({}))",
        "autolink",
    ),
    ("import re\nre.compile('x')", "recognise"),
    ("import logging\nlog = logging.getLogger('x')", "scan"),
    ("import os\nos.environ.get('A')", "__main__"),
    ("from os import environ", "__main__"),
    ("import sys\nsys.exit(1)", "__main__"),
    ("import sys\nsys.path.insert(0, p)", "identity"),
    ("import os.path\nx = os.path.join('a', 'b')", "identity"),
    ("import io\nb = io.BytesIO(data)", "scan"),
    ("data = fh.read()", "scan"),
    ("import hashlib\nhashlib.sha256()", "hashing"),
    ("s = set()\ns.discard(1)", "scan"),
    ("cur.execute('select 1')\ncur.executemany('x', [])", "db"),
    ("import urllib.request\nreq = urllib.request.Request(u)", "autolink"),
    ("from . import fs_readonly\nfrom .kinds import Classification", "classify_scan"),
    ("import index_archive\nx = index_archive.file_id('a')", "identity"),
    ("from dataclasses import dataclass", "owners"),
    ("def f(exc):\n    return type(exc).__name__", "scan"),
    (
        "from io import BytesIO\nfrom PIL import Image\ndef classify_image(fh):\n"
        "    if not isinstance(fh, BytesIO):\n        raise TypeError\n    return Image.open(fh, formats=['PNG'])",
        "classify_sem",
    ),
    ("x = classify_sem.classify_image(io.BytesIO(data))\nimport io", "scan"),
    ("x = thumbs.make_thumbnails(hashed.data)", "scan"),
    ("x = thumbs.make_thumbnails(out.data)", "daemon"),
    (
        "import warnings\nfrom io import BytesIO\nfrom PIL import Image, ImageOps\n"
        "def _encode_jpeg(img, quality):\n    buf = BytesIO()\n"
        "    img.save(buf, 'JPEG', quality=quality)\n    return buf.getvalue()\n"
        "def make_thumbnails(data):\n    if not isinstance(data, bytes):\n        return None\n"
        "    img = Image.open(BytesIO(data), formats=['PNG'])\n    img.thumbnail((9, 9), Image.LANCZOS)\n"
        "    return ImageOps.exif_transpose(img)",
        "thumbs",
    ),
]


@pytest.mark.parametrize("snippet,module", CLEAN)
def test_checker_lets_clean_code_through(snippet, module):
    assert violations(snippet, module) == [], (module, snippet)


def test_only_fs_readonly_may_open_and_only_for_rb():
    assert violations('open(p, "rb")', "fs_readonly") == []
    assert violations("open(p)", "fs_readonly")
    assert violations('open(p, "rb")', "hashing")
    assert violations("f = open\nf(p, 'rb')", "fs_readonly")


def test_classify_image_may_only_be_given_a_bytesio():
    assert (
        violations("classify_sem.classify_image(io.BytesIO(data))\nimport io", "scan")
        == []
    )
    assert violations("classify_sem.classify_image(fh)", "scan")
    assert violations("classify_sem.classify_image(open_rb(p))", "scan")
    assert violations("classify_sem.classify_image(rel)", "scan")


def test_only_the_indexers_id_rule_and_repointing_may_be_used():
    assert (
        violations("import index_archive\nindex_archive.file_id(p)", "identity") == []
    )
    assert violations("import index_archive", "db")  # only identity may import it
    assert violations(
        "x = identity.index_archive.file_id", "scan"
    )  # only db may reach through identity
    assert violations("x = identity.index_archive.main", "db")
    assert violations("x = identity.index_archive.repoint_file_references", "db") == []


# ---- open_rb and the allow-list --------------------------------------------------------

REFUSED = [
    ".pdf",
    ".docx",
    ".doc",
    ".xlsx",
    ".xls",
    ".csv",
    ".txt",
    ".m",
    ".mat",
    ".pptx",
    ".nef",
    ".h5",
    ".dat",
    ".zip",
    "",
]
ALLOWED = [".tif", ".tiff", ".jpg", ".jpeg", ".png", ".bmp", ".al3d"]


@pytest.mark.parametrize("ext", REFUSED)
def test_open_rb_refuses_a_file_type_off_the_allow_list(tmp_path, ext):
    p = tmp_path / f"report{ext}"
    p.write_bytes(b"secret")
    with pytest.raises(fsr.ReadRefused):
        fsr.open_rb(str(p))


@pytest.mark.parametrize("ext", REFUSED)
def test_refusal_comes_before_the_file_system_is_asked(tmp_path, ext):
    # a path that does not exist still raises ReadRefused, not FileNotFoundError: nothing was opened
    with pytest.raises(fsr.ReadRefused):
        fsr.open_rb(str(tmp_path / f"missing{ext}"))


@pytest.mark.parametrize("ext", ALLOWED + [e.upper() for e in ALLOWED])
def test_open_rb_reads_allow_listed_types(tmp_path, ext):
    p = tmp_path / f"a{ext}"
    p.write_bytes(b"abc")
    with fsr.open_rb(str(p)) as fh:
        assert fh.read() == b"abc"
        assert "b" in fh.mode and "w" not in fh.mode and "+" not in fh.mode


@pytest.mark.parametrize("ext", REFUSED[:-1])
def test_adopted_opens_a_linked_document(tmp_path, ext):
    p = tmp_path / f"linked{ext}"
    p.write_bytes(b"doc")
    with fsr.open_rb(str(p), adopted=True) as fh:
        assert fh.read() == b"doc"


def test_the_allow_list_is_images_and_scans_only():
    assert fsr.READ_ALLOWLIST == {
        ".tif",
        ".tiff",
        ".jpg",
        ".jpeg",
        ".png",
        ".bmp",
        ".al3d",
    }
    assert fsr.SCAN_EXTENSIONS == (".al3d",)


def test_the_module_exposes_scandir_stat_open_rb_and_nothing_that_writes():
    public = {
        n
        for n, v in vars(fsr).items()
        if callable(v)
        and not n.startswith("_")
        and getattr(v, "__module__", "") == fsr.__name__
    }
    assert public == {
        "scandir",
        "stat",
        "open_rb",
        "extension",
        "Share",
        "ReadRefused",
        "Entry",
        "Stat",
    }


# ---- Share: paths stay inside the root, links are not followed ---------------------------


@pytest.fixture
def share(tmp_path):
    root = tmp_path / "star_group1"
    (root / "Users" / "abc12de" / "sem").mkdir(parents=True)
    (root / "Users" / "abc12de" / "sem" / "a.tif").write_bytes(b"II*\x00")
    (root / "Users" / "abc12de" / "notes.pdf").write_bytes(b"%PDF")
    return fsr.Share(str(root)), root, tmp_path


def test_share_lists_and_stats_relative_paths(share):
    sh, _root, _ = share
    names = {e.name: e for e in sh.scandir("Users/abc12de")}
    assert names["sem"].is_dir and not names["sem"].is_file
    assert names["notes.pdf"].is_file
    st = sh.stat("Users/abc12de/sem/a.tif")
    assert st.size == 4 and st.is_file and st.mtime_ns > 0
    assert sh.stat("Users").is_dir


@pytest.mark.parametrize(
    "rel", ["../x", "Users/../../x", "/etc/passwd", "C:/x", "Users\\abc12de", "a/../.."]
)
def test_share_rejects_paths_that_leave_the_root(share, rel):
    sh, _, _ = share
    with pytest.raises(ValueError):
        sh.scandir(rel)
    with pytest.raises(ValueError):
        sh.stat(rel)
    with pytest.raises(ValueError):
        sh.open_rb(rel)


def test_share_open_rb_applies_the_allow_list(share):
    sh, _, _ = share
    with sh.open_rb("Users/abc12de/sem/a.tif") as fh:
        assert fh.read(2) == b"II"
    with pytest.raises(fsr.ReadRefused):
        sh.open_rb("Users/abc12de/notes.pdf")
    with sh.open_rb("Users/abc12de/notes.pdf", adopted=True) as fh:
        assert fh.read() == b"%PDF"


@pytest.mark.skipif(not hasattr(os, "symlink"), reason="needs symbolic links")
def test_links_are_neither_listed_nor_followed(share):
    sh, root, tmp = share
    outside = tmp / "outside"
    outside.mkdir()
    (outside / "secret.tif").write_bytes(b"secret")
    os.symlink(outside, root / "Users" / "abc12de" / "linkdir")
    os.symlink(outside / "secret.tif", root / "Users" / "abc12de" / "link.tif")
    names = {e.name for e in sh.scandir("Users/abc12de")}
    assert "linkdir" not in names and "link.tif" not in names
    with pytest.raises(fsr.ReadRefused):
        sh.open_rb("Users/abc12de/link.tif")
    with pytest.raises(fsr.ReadRefused):
        sh.open_rb("Users/abc12de/linkdir/secret.tif")
    assert not sh.stat("Users/abc12de/link.tif").is_file


def test_reading_leaves_the_tree_exactly_as_it_was(share):
    sh, root, _ = share

    def snapshot():
        out = {}
        for p in sorted(root.rglob("*")):
            st = p.stat()
            out[str(p.relative_to(root))] = (st.st_mtime_ns, st.st_size, st.st_mode)
        return out

    before = snapshot()
    sh.scandir("Users")
    sh.stat("Users/abc12de")
    with sh.open_rb("Users/abc12de/sem/a.tif") as fh:
        fh.read()
    assert snapshot() == before


# ---- links, FIFOs and swaps: open_rb reads a regular file and nothing else ----------------------


@pytest.mark.skipif(not hasattr(os, "symlink"), reason="needs symbolic links")
def test_a_link_named_like_an_image_that_points_at_a_document_is_refused(share):
    sh, root, _ = share
    os.symlink(root / "Users/abc12de/notes.pdf", root / "Users/abc12de/photo.tif")
    with pytest.raises(fsr.ReadRefused):
        sh.open_rb("Users/abc12de/photo.tif")
    with pytest.raises(fsr.ReadRefused):  # also straight through the module function
        fsr.open_rb(str(root / "Users/abc12de/photo.tif"))


@pytest.mark.skipif(not hasattr(os, "symlink"), reason="needs symbolic links")
def test_adopted_does_not_open_a_link_either(share):
    sh, root, _ = share
    os.symlink(root / "Users/abc12de/notes.pdf", root / "Users/abc12de/linked.pdf")
    with pytest.raises(fsr.ReadRefused):
        sh.open_rb("Users/abc12de/linked.pdf", adopted=True)
    with pytest.raises(fsr.ReadRefused):
        fsr.open_rb(str(root / "Users/abc12de/linked.pdf"), adopted=True)


@pytest.mark.skipif(not hasattr(os, "symlink"), reason="needs symbolic links")
def test_a_link_swapped_in_after_the_path_was_checked_is_refused(share, monkeypatch):
    sh, root, tmp = share
    target = root / "Users/abc12de/sem/a.tif"
    expected = os.path.join(os.path.realpath(root), "Users", "abc12de", "sem", "a.tif")
    # the checks passed while the file was still a file ...
    monkeypatch.setattr(
        fsr.os.path,
        "realpath",
        lambda p: expected if str(p).endswith("a.tif") else os.path.abspath(p),
    )
    # ... and then it was replaced by a link to something else
    outside = tmp / "outside.tif"
    outside.write_bytes(b"secret")
    target.unlink()
    os.symlink(outside, target)
    with pytest.raises(fsr.ReadRefused):
        sh.open_rb("Users/abc12de/sem/a.tif")


@pytest.mark.skipif(not hasattr(os, "mkfifo"), reason="needs FIFOs")
def test_a_fifo_is_refused_and_does_not_block(share):
    sh, root, _ = share
    os.mkfifo(root / "Users/abc12de/pipe.tif")
    with pytest.raises(fsr.ReadRefused):
        sh.open_rb("Users/abc12de/pipe.tif")
    with pytest.raises(fsr.ReadRefused):
        sh.open_rb("Users/abc12de/pipe.tif", adopted=True)


def test_a_directory_named_like_an_image_is_refused(share):
    sh, root, _ = share
    (root / "Users/abc12de/folder.tif").mkdir()
    with pytest.raises(fsr.ReadRefused):
        sh.open_rb("Users/abc12de/folder.tif")


def test_a_platform_without_no_follow_reads_nothing(share, monkeypatch):
    sh, root, _ = share
    monkeypatch.delattr(fsr.os, "O_NOFOLLOW")
    with pytest.raises(fsr.ReadRefused):
        sh.open_rb("Users/abc12de/sem/a.tif")


def test_the_stat_of_a_link_says_it_is_not_a_file(share):
    if not hasattr(os, "symlink"):
        pytest.skip("needs symbolic links")
    sh, root, _ = share
    os.symlink(root / "Users/abc12de/notes.pdf", root / "Users/abc12de/l.pdf")
    assert not sh.stat("Users/abc12de/l.pdf").is_file


def test_the_opener_with_no_follow_is_the_only_os_open_the_checker_allows():
    ok = "import os\nfh = open(p, 'rb', opener=lambda q, f: os.open(q, f | os.O_NOFOLLOW | extra))"
    assert violations(ok, "fs_readonly") == []
    assert violations(ok, "scan")
    assert violations("import os\nos.open(p, flags)", "fs_readonly")
    assert violations(
        "import os\nos.open(p, os.O_NOFOLLOW | os.O_WRONLY)", "fs_readonly"
    )


# ---- a whole scan changes nothing on the share, and a vanishing share loses nothing ------------
# (the DB-backed scan tests live in test_inbox_crawler_scan.py; these two are the read-only guarantees)

from test_inbox_crawler_world import world  # noqa: E402, F401


def _helpers():
    """The scan tests' helpers; importing them skips the test (not the module) without psycopg2."""
    pytest.importorskip("psycopg2")
    import test_inbox_crawler_scan as t

    return t


def _tree(root):
    out = {}
    for p in sorted(Path(root).rglob("*")):
        st = p.lstat()
        out[str(p.relative_to(root))] = (st.st_mtime_ns, st.st_size, st.st_mode)
    return out


def test_a_whole_scan_leaves_the_share_exactly_as_it_was(world):  # noqa: F811
    t = _helpers()
    png, run, settle = t.png, t.run, t.settle
    world.person("abc12de")
    world.team("Machining")
    for rel in (
        "Users/abc12de/a.png",
        "Users/abc12de/sem/b.png",
        "Users/abc12de/notes.pdf",
        "Users/abc12de/run.mat",
        "Users/abc12de/scan.al3d",
        "Shared/Machining/c.png",
        "Users/stranger/x.png",
    ):
        world.write(rel, png() if rel.endswith(".png") else b"x" * 64)
    settle(world)
    before = _tree(world.root)
    run(world)
    world.write(
        "Users/abc12de/later.png", png((1, 2, 3))
    )  # the test itself changes the share here
    before = _tree(world.root)
    run(world)
    assert _tree(world.root) == before


def test_a_share_that_vanishes_mid_scan_aborts_and_marks_nothing_gone(world):  # noqa: F811
    t = _helpers()
    png, run, settle, make, cands = t.png, t.run, t.settle, t.make, t.cands
    world.person("abc12de")
    for i in range(3):
        world.write(f"Users/abc12de/d{i}/f.png", png((i, i, i)))
    settle(world)
    run(world)
    os.unlink(
        Path(world.root, "Users/abc12de/d1/f.png")
    )  # d1 changed: this scan will look for gone files
    sc, spy, _ = make(world)
    spy.vanish_after = 6
    stats = sc.scan()
    assert stats.aborted
    assert set(cands(world).values()) == {("new", "backlog", "image")}
