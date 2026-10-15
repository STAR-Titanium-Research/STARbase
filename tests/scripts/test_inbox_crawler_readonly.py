"""The inbox crawler never changes the share (ADR-0020, spec section 3, skill inbox-crawler-conventions).

Three layers are tested here:

* an AST scan of the whole `scripts/inbox_crawler` package that fails on any write, delete, rename,
  chmod, truncate, copy, move or open-for-write call, on any `open` outside `fs_readonly.open_rb`, and on
  an `os`/`shutil`/`pathlib` import outside `fs_readonly` that is not pure path maths;
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

# Calls whose name starts with one of these are writes, deletes, renames, copies or moves, whatever
# object they are called on (os.remove, Path.unlink, shutil.copyfile, f.write, ...).
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
)
# Exact names that are just as bad but too common as a prefix (`link`, `replace`, `save`).
FORBIDDEN_NAMES = frozenset(
    {
        "replace",
        "link",
        "touch",
        "system",
        "popen",
        "save",
        "mkfifo",
        "mknod",
        "startfile",
        "fdopen",
        "lutimes",
    }
)
FORBIDDEN_ATTRS = frozenset(
    {"O_WRONLY", "O_RDWR", "O_CREAT", "O_TRUNC", "O_APPEND", "O_EXCL"}
)
FORBIDDEN_IMPORTS = frozenset({"shutil", "subprocess", "ctypes", "mmap", "tempfile"})
# What a module other than fs_readonly may take from `os`: string path maths and the environment.
OS_ALLOWED = frozenset({"path", "environ", "getpid", "sep", "fspath"})
PATHLIB_ALLOWED = frozenset({"PurePath", "PurePosixPath", "PureWindowsPath"})


def _is_binary_read_mode(call: ast.Call) -> bool:
    mode = None
    if len(call.args) >= 2 and isinstance(call.args[1], ast.Constant):
        mode = call.args[1].value
    for kw in call.keywords:
        if kw.arg == "mode" and isinstance(kw.value, ast.Constant):
            mode = kw.value.value
    return mode == "rb"


def violations(source: str, module: str) -> list[str]:
    """Every rule the module breaks, as 'module:line: what'."""
    tree = ast.parse(source)
    found: list[str] = []
    is_fs = module == "fs_readonly"

    def bad(node, what):
        found.append(f"{module}:{node.lineno}: {what}")

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                top = a.name.split(".")[0]
                if top in FORBIDDEN_IMPORTS:
                    bad(node, f"import {a.name}")
                if top == "pathlib" and not is_fs:
                    bad(node, "import pathlib (only PurePath names may be imported)")
                if top == "os" and not is_fs and a.name not in ("os", "os.path"):
                    bad(node, f"import {a.name}")
        elif isinstance(node, ast.ImportFrom):
            top = (node.module or "").split(".")[0]
            if top in FORBIDDEN_IMPORTS:
                bad(node, f"from {node.module} import ...")
            if top == "pathlib" and not is_fs:
                for a in node.names:
                    if a.name not in PATHLIB_ALLOWED:
                        bad(node, f"from pathlib import {a.name}")
            if top == "os" and not is_fs:
                for a in node.names:
                    if a.name not in OS_ALLOWED:
                        bad(node, f"from os import {a.name}")
        elif isinstance(node, ast.Attribute):
            if node.attr in FORBIDDEN_ATTRS:
                bad(node, f"open flag {node.attr}")
            if (
                isinstance(node.value, ast.Name)
                and node.value.id == "os"
                and not is_fs
                and node.attr not in OS_ALLOWED
            ):
                bad(node, f"os.{node.attr} outside fs_readonly")
        elif isinstance(node, ast.Call):
            f = node.func
            name = f.id if isinstance(f, ast.Name) else getattr(f, "attr", None)
            if name is None:
                continue
            if name in FORBIDDEN_NAMES or name.startswith(FORBIDDEN_PREFIXES):
                bad(node, f"call to {name}()")
            elif name == "open":
                if isinstance(f, ast.Name):
                    # builtin open: only fs_readonly, only mode "rb"
                    if not is_fs:
                        bad(node, "open() outside fs_readonly")
                    elif not _is_binary_read_mode(node):
                        bad(node, 'open() with a mode other than "rb"')
                elif (
                    isinstance(f.value, ast.Name)
                    and f.value.id == "Image"
                    and module == "classify_sem"
                    and len(node.args) == 1
                    and isinstance(node.args[0], ast.Name)
                ):
                    pass  # Pillow reading a handle that open_rb gave us (never a path)
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
                    pass  # fs_readonly's opener: os.open(path, flags | extra) with O_NOFOLLOW in `extra`
                else:
                    bad(node, "a .open() call")
    return found


def package_modules() -> list[Path]:
    return sorted(PKG.glob("*.py"))


def test_package_is_there():
    assert (PKG / "fs_readonly.py").is_file()


@pytest.mark.parametrize("path", package_modules(), ids=lambda p: p.name)
def test_module_has_no_write_delete_rename_or_open_for_write(path):
    found = violations(path.read_text(encoding="utf-8"), path.stem)
    assert not found, "\n".join(found)


# The checker itself: each forbidden thing is caught, the allowed things are not.
@pytest.mark.parametrize(
    "snippet",
    [
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
        "open(p)",
        "open(p, 'w')",
        "open(p, 'wb')",
        "open(p, 'ab')",
        "open(p, 'r+b')",
        "open(p, mode='w')",
        "import io\nio.open(p, 'rb')",
        "import os\nos.fdopen(1)",
        "import os\nos.open(p, os.O_WRONLY)",
        "import os\nfd = os.O_CREAT",
        "img.save(p)",
        "from PIL import Image\nImage.open('a.tif')",
        "from PIL import Image\nImage.open(p + 'a.tif')",
        "import os\nos.scandir(p)",
        "import os\nos.stat(p)",
        "from os import walk",
    ],
)
def test_checker_catches(snippet):
    assert violations(snippet, "scan"), snippet


@pytest.mark.parametrize(
    "snippet",
    [
        "import os.path\nx = os.path.join('a', 'b')",
        "import os\nos.environ.get('A')",
        "from pathlib import PurePosixPath\nPurePosixPath('a/b').name",
        "from os import environ",
        "data = fh.read()",
        "import hashlib\nhashlib.sha256()",
        "s = set()\ns.discard(1)",
    ],
)
def test_checker_lets_clean_code_through(snippet):
    assert violations(snippet, "scan") == []


def test_only_fs_readonly_may_open_and_only_for_rb():
    assert violations('open(p, "rb")', "fs_readonly") == []
    assert violations("open(p)", "fs_readonly")
    assert violations('open(p, "rb")', "hashing")


def test_pillow_may_read_a_handle_in_classify_sem_only():
    src = "from PIL import Image\nimg = Image.open(fh)"
    assert violations(src, "classify_sem") == []
    assert violations(src, "scan")


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
