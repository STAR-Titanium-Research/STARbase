"""Path refusal, extension allowlist, read-only access."""

import builtins
import os
import stat

import pytest

from app.lib import archive
from app.lib.archive import RenderError

from .synthetic import ramp, write_al3d


@pytest.fixture
def share(tmp_path, monkeypatch):
    """A fake archive: <tmp>/mnt/archive/star_group1, with a sibling directory outside the root."""
    mount = tmp_path / "mnt" / "archive"
    root = mount / "star_group1"
    (root / "rig").mkdir(parents=True)
    (mount / "other_group").mkdir()
    monkeypatch.setattr(archive, "ARCHIVE_MOUNT", str(mount))
    monkeypatch.setattr(archive, "ARCHIVE_ROOT", str(root))
    return root


def test_a_clean_relative_path_resolves_inside_the_root(share):
    assert (
        archive.resolve("rig/insert-1.al3d")
        == (share / "rig" / "insert-1.al3d").resolve()
    )


def test_extension_match_is_case_insensitive(share):
    assert archive.resolve("rig/INSERT.AL3D").name == "INSERT.AL3D"


@pytest.mark.parametrize(
    "bad",
    [
        "../other_group/x.al3d",
        "rig/../../other_group/x.al3d",
        "rig/../../../etc/passwd.al3d",
        "/etc/passwd.al3d",
        "/mnt/archive/star_group1/rig/x.al3d",
        "rig\\..\\x.al3d",
        "rig/x.al3d\x00.txt",
        "rig//x.al3d",
        "",
        None,
    ],
)
def test_unclean_paths_are_refused(share, bad):
    with pytest.raises(RenderError):
        archive.resolve(bad)


def test_a_symlink_that_leaves_the_root_is_refused(share, tmp_path):
    outside = tmp_path / "secret.al3d"
    outside.write_bytes(b"x")
    (share / "rig" / "link.al3d").symlink_to(outside)
    with pytest.raises(RenderError, match="outside"):
        archive.resolve("rig/link.al3d")


def test_a_symlink_to_a_sibling_group_inside_the_mount_is_still_refused(share):
    sibling = share.parent / "other_group" / "x.al3d"
    sibling.write_bytes(b"x")
    (share / "rig" / "link.al3d").symlink_to(sibling)
    with pytest.raises(RenderError):
        archive.resolve("rig/link.al3d")


def test_a_symlink_that_stays_inside_the_root_is_fine(share):
    (share / "rig" / "real.al3d").write_bytes(b"x")
    (share / "rig" / "alias.al3d").symlink_to(share / "rig" / "real.al3d")
    assert archive.resolve("rig/alias.al3d").name == "real.al3d"


def test_a_root_outside_the_mount_is_refused(share, monkeypatch, tmp_path):
    monkeypatch.setattr(archive, "ARCHIVE_ROOT", str(tmp_path))
    with pytest.raises(RenderError, match="mount"):
        archive.resolve("rig/x.al3d")


@pytest.mark.parametrize(
    "name",
    [
        "report.pdf",
        "notes.docx",
        "slides.pptx",
        "table.xlsx",
        "table.csv",
        "readme.txt",
        "export.dat",
        "bundle.zip",
        "force.mat",  # a D1 force recording, not a topography
        "photo.jpg",
        "noextension",
        "x.al3d.pdf",
        "x.exe",
        "x.",
        # formats SurfaceTopography reads but the lab's rule keeps off the share's read path
        "scan.tif",
        "scan.tiff",
        "profile.xyz",
        "profile.asc",
        "profile.hfm",
        "array.npy",
        "data.hdf5",
        "image.sxm",
        "data.nc",
    ],
)
def test_non_topography_extensions_are_refused(share, name):
    with pytest.raises(RenderError, match="topography"):
        archive.resolve(f"rig/{name}")


@pytest.mark.parametrize(
    "name,fmt",
    [
        ("a.al3d", "al3d"),
        ("a.AL3D", "al3d"),
        ("a.x3p", "x3p"),
        ("a.sur", "sur"),
        ("a.opd", "opd"),
        ("a.vk4", "vk"),
        ("a.nid", "ezd"),
        ("a.ezd", "ezd"),
        ("a.spm", "di"),
        ("a.h5", "h5"),
    ],
)
def test_topography_extensions_map_to_one_reader(name, fmt):
    assert archive.format_for(name) == fmt


EXPECTED_ALLOWLIST = set(
    "al3d opd opdx x3p ibw h5 datx sur plu apx plux vk3 vk4 vk6 vk7 lext zon os3d sdf frt mnt gwy "
    "mdt nms oir poir ezd nid bcr bcrf tmd zmg mi jpk qep spm".split()
)


def test_the_allowlist_is_exactly_the_agreed_one():
    # STARbase's dialog offers the same list: change both together.
    assert archive.ALLOWED_EXTENSIONS == EXPECTED_ALLOWLIST
    assert len(archive.ALLOWED_EXTENSIONS) == 36


def test_every_allowed_extension_has_an_installed_reader():
    assert set(archive.EXTENSION_FORMATS) == EXPECTED_ALLOWLIST


def test_generic_and_document_formats_are_not_allowed():
    for ext in (
        "tif",
        "tiff",
        "xyz",
        "asc",
        "hfm",
        "npy",
        "hdf5",
        "sxm",
        "mat",
        "txt",
        "csv",
        "dat",
    ):
        assert ext not in archive.EXTENSION_FORMATS


def test_an_allowed_extension_without_a_reader_fails_clearly(monkeypatch):
    monkeypatch.delitem(archive.EXTENSION_FORMATS, "al3d")
    with pytest.raises(RenderError, match="no reader for .al3d"):
        archive.format_for("x.al3d")


def test_a_link_to_a_file_of_another_type_is_refused(share):
    (share / "rig" / "doc.pdf").write_bytes(b"%PDF")
    (share / "rig" / "alias.al3d").symlink_to(share / "rig" / "doc.pdf")
    with pytest.raises(RenderError, match="topography"):
        archive.resolve("rig/alias.al3d")


def test_the_extension_is_checked_before_the_file_is_looked_up(share):
    # The file does not exist, but the refusal is about its type, not about a missing file.
    with pytest.raises(RenderError, match="topography"):
        archive.resolve("rig/missing.pdf")


def test_stat_of_a_missing_file_is_a_refusal(share):
    with pytest.raises(RenderError, match="moved or deleted"):
        archive.stat_file(share / "rig" / "gone.al3d")


def test_stat_of_a_directory_or_fifo_is_a_refusal(share):
    (share / "rig" / "dir.al3d").mkdir()
    with pytest.raises(RenderError, match="regular"):
        archive.stat_file(share / "rig" / "dir.al3d")
    fifo = share / "rig" / "pipe.al3d"
    os.mkfifo(fifo)
    with pytest.raises(RenderError, match="regular"):
        archive.stat_file(fifo)


def test_stat_returns_size_and_mtime(share):
    path = write_al3d(share / "rig" / "a.al3d", ramp(3, 3))
    st = archive.stat_file(path)
    assert stat.S_ISREG(st.st_mode)
    assert st.st_size == path.stat().st_size


def test_open_readonly_never_opens_for_writing(share, monkeypatch):
    path = write_al3d(share / "rig" / "a.al3d", ramp(3, 3))
    flags = []
    real_os_open = os.open

    def spy(file, flag, *args, **kwargs):
        flags.append(flag)
        return real_os_open(file, flag, *args, **kwargs)

    def no_builtin_open(*args, **kwargs):
        raise AssertionError("the worker must open through os.open only")

    monkeypatch.setattr(os, "open", spy)
    monkeypatch.setattr(builtins, "open", no_builtin_open)
    with archive.open_readonly(path, archive.stat_file(path)) as handle:
        assert handle.mode == "rb"
        assert not handle.writable()
        with pytest.raises(OSError):
            handle.write(b"x")
    assert len(flags) == 1
    (flag,) = flags
    assert flag & os.O_ACCMODE == os.O_RDONLY
    assert flag & os.O_NOFOLLOW
    assert not flag & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND)


def test_a_file_swapped_for_another_after_the_stat_is_refused(share):
    path = write_al3d(share / "rig" / "a.al3d", ramp(3, 3))
    expected = archive.stat_file(path)
    other = write_al3d(share / "rig" / "other.al3d", ramp(4, 4))
    os.replace(other, path)  # a different inode now sits at the path
    with pytest.raises(RenderError, match="changed on the share"):
        archive.open_readonly(path, expected)


def test_a_file_rewritten_in_place_after_the_stat_is_refused(share):
    path = write_al3d(share / "rig" / "a.al3d", ramp(3, 3))
    expected = archive.stat_file(path)
    write_al3d(path, ramp(6, 6))  # same inode, new size
    with pytest.raises(RenderError, match="changed on the share"):
        archive.open_readonly(path, expected)


def test_a_symlink_swapped_in_after_the_check_is_not_followed(share, tmp_path):
    path = write_al3d(share / "rig" / "a.al3d", ramp(3, 3))
    expected = archive.stat_file(path)
    outside = write_al3d(tmp_path / "outside.al3d", ramp(3, 3))
    path.unlink()
    path.symlink_to(outside)  # what resolve() would have refused, swapped in afterwards
    with pytest.raises(RenderError, match="could not be opened read-only"):
        archive.open_readonly(path, expected)


def test_a_directory_or_fifo_swapped_in_is_refused(share):
    path = write_al3d(share / "rig" / "a.al3d", ramp(3, 3))
    expected = archive.stat_file(path)
    path.unlink()
    os.mkfifo(path)
    # O_RDONLY on a FIFO with no writer would block, so make sure a writer exists
    writer = os.open(path, os.O_RDWR)
    try:
        with pytest.raises(RenderError):
            archive.open_readonly(path, expected)
    finally:
        os.close(writer)


def test_the_descriptor_is_closed_when_the_check_fails(share):
    path = write_al3d(share / "rig" / "a.al3d", ramp(3, 3))
    expected = archive.stat_file(path)
    write_al3d(path, ramp(6, 6))
    before = set(os.listdir("/proc/self/fd"))
    with pytest.raises(RenderError):
        archive.open_readonly(path, expected)
    assert set(os.listdir("/proc/self/fd")) == before


def test_read_scan_refuses_a_file_swapped_after_the_stat(share):
    from app.lib import topography

    path = write_al3d(share / "rig" / "a.al3d", ramp(3, 3))
    expected = archive.stat_file(path)
    os.replace(write_al3d(share / "rig" / "o.al3d", ramp(5, 5)), path)
    with pytest.raises(RenderError, match="changed on the share"):
        topography.read_scan(path, expected)


def test_reading_a_scan_leaves_the_file_untouched(share):
    from app.lib import topography

    path = write_al3d(share / "rig" / "a.al3d", ramp(5, 7))
    path.chmod(0o444)
    before = (path.read_bytes(), path.stat().st_mtime_ns)
    topography.read_scan(path)
    assert (path.read_bytes(), path.stat().st_mtime_ns) == before
