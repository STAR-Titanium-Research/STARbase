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
        ("a.asc", "asc"),
        ("a.npy", "npy"),
    ],
)
def test_topography_extensions_map_to_one_reader(name, fmt):
    assert archive.format_for(name) == fmt


def test_documents_and_force_files_are_not_in_the_allowlist():
    assert archive.NOT_TOPOGRAPHY >= {"mat", "txt", "csv", "dat", "xlsx", "zip"}
    assert not archive.NOT_TOPOGRAPHY & set(archive.EXTENSION_FORMATS)
    assert "al3d" in archive.EXTENSION_FORMATS


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
    modes = []
    real_open = builtins.open

    def spy(file, mode="r", *args, **kwargs):
        modes.append(mode)
        return real_open(file, mode, *args, **kwargs)

    monkeypatch.setattr(builtins, "open", spy)
    with archive.open_readonly(path) as handle:
        assert handle.mode == "rb"
        assert not handle.writable()
        with pytest.raises(OSError):
            handle.write(b"x")
    assert modes == ["rb"]


def test_reading_a_scan_leaves_the_file_untouched(share):
    from app.lib import topography

    path = write_al3d(share / "rig" / "a.al3d", ramp(5, 7))
    path.chmod(0o444)
    before = (path.read_bytes(), path.stat().st_mtime_ns)
    topography.read_scan(path)
    assert (path.read_bytes(), path.stat().st_mtime_ns) == before
