"""The render job end to end against fakes: Directus rows, MinIO objects, a synthetic .al3d on a fake share."""

import ast
import io
import json
import os
import re
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from app.jobs import render_scan as job
from app.lib import archive, topography
from app.lib.archive import RenderError
from app.lib.directus_client import VersionConflictError

from .conftest import FILE, OTHER_FILE, OTHER_SCAN, SCAN
from .synthetic import ramp, write_al3d

SHA = "cd" * 32


def _scan_file(world, name="insert-1.al3d", rows=40, cols=60, **kw) -> Path:
    path = write_al3d(world.root / "rig" / name, ramp(rows, cols), **kw)
    world.add_file(f"rig/{name}")
    return path


def _objects_under(world, key):
    return {
        k.rsplit("/", 1)[1]: v
        for k, v in world.objects.items()
        if k.startswith(f"surface-scans/{key}/")
    }


def test_happy_path_renders_and_fills_the_row(world):
    _scan_file(world, pixel_size_x_m=2e-6, pixel_size_y_m=4e-6)
    world.add_scan()
    world.current_fingerprint(FILE, SHA)

    job.render_scan(SCAN)

    assert world.statuses() == ["rendering", "done"]
    assert world.rows[SCAN]["render_status"] == "done"
    row = world.renders[SCAN]
    assert row["render_error"] is None
    assert row["cache_key"] == SHA
    assert row["source_format"] == "al3d"
    assert (row["source_width"], row["source_height"]) == (60, 40)
    assert (row["grid_width"], row["grid_height"]) == (60, 40)
    assert row["pixel_pitch_x_um"] == pytest.approx(2.0)
    assert row["pixel_pitch_y_um"] == pytest.approx(4.0)
    assert row["z_min_um"] == pytest.approx(0.0, abs=1e-4)
    assert row["z_max_um"] == pytest.approx(2399.0, rel=1e-5)
    assert re.match(r"^\d{4}-\d\d-\d\dT", row["rendered_at"])


def test_the_claim_patches_only_the_public_status(world):
    """render_error and the render columns are not on the public row (ADR-0023): never PATCH them."""
    _scan_file(world)
    world.add_scan()
    job.render_scan(SCAN)
    assert world.history == [(SCAN, {"render_status": "rendering"})]


RESULT_COLUMNS = {
    "cache_key", "source_format", "source_width", "source_height", "grid_width", "grid_height",
    "pixel_pitch_x_um", "pixel_pitch_y_um", "z_min_um", "z_max_um", "rendered_at",
}  # fmt: skip


def test_the_outcome_is_posted_to_the_result_route_with_the_version_read(world):
    _scan_file(world)
    world.add_scan()
    job.render_scan(SCAN)
    ((scan_id, body),) = world.results
    assert scan_id == SCAN
    # the claim moved the row from version 1 to 2; the result carries the version the poll re-read
    assert body["version"] == 2
    assert set(body) == {"version", "render_status", "columns"}
    assert body["render_status"] == "done"
    assert set(body["columns"]) == RESULT_COLUMNS


def test_a_failure_is_posted_with_its_error_and_no_columns(world):
    world.add_file("rig/gone.al3d")
    world.add_scan()
    with pytest.raises(Exception):
        job.render_scan(SCAN)
    ((_, body),) = world.results
    assert set(body) == {"version", "render_status", "render_error"}
    assert body["render_status"] == "failed"
    assert "moved or deleted" in body["render_error"]


def test_the_three_objects_are_written_under_the_cache_key(world):
    _scan_file(world, rows=3, cols=4)
    world.add_scan()
    world.current_fingerprint(FILE, SHA)
    job.render_scan(SCAN)

    objects = _objects_under(world, SHA)
    assert set(objects) == {"grid.bin", "meta.json", "thumb.png"}
    grid_bytes, _ = objects["grid.bin"]
    cells = np.frombuffer(grid_bytes, dtype="<f4").reshape(3, 4)
    np.testing.assert_allclose(
        cells, ramp(3, 4, scale_m=1.0), atol=1e-4
    )  # micrometres, top row first
    meta = json.loads(objects["meta.json"][0])
    assert meta["width"] == 4 and meta["height"] == 3
    assert meta["source_format"] == "al3d"
    assert meta["decimation"]["factor"] == 1
    assert objects["meta.json"][1] == "application/json"
    img = Image.open(io.BytesIO(objects["thumb.png"][0]))
    assert img.format == "PNG" and max(img.size) <= 320
    assert objects["thumb.png"][1] == "image/png"


def test_meta_json_is_written_last_so_its_presence_means_a_complete_render(world):
    _scan_file(world)
    world.add_scan()
    job.render_scan(SCAN)
    assert list(world.objects)[-1].endswith("/meta.json")


def test_a_large_scan_is_decimated_and_the_row_carries_the_grid_pitch(world):
    _scan_file(world, rows=1200, cols=2500, pixel_size_x_m=1e-6, pixel_size_y_m=1e-6)
    world.add_scan()
    job.render_scan(SCAN)
    row = world.renders[SCAN]
    assert (row["source_width"], row["source_height"]) == (2500, 1200)
    assert (row["grid_width"], row["grid_height"]) == (834, 400)
    assert row["pixel_pitch_x_um"] == pytest.approx(3.0)
    key = row["cache_key"]
    assert len(_objects_under(world, key)["grid.bin"][0]) == 834 * 400 * 4


def test_provisional_key_when_the_crawler_has_no_fingerprint(world):
    path = _scan_file(world)
    world.add_scan()
    job.render_scan(SCAN)
    st = path.stat()
    assert (
        world.renders[SCAN]["cache_key"] == f"p-{FILE}-{st.st_size}-{int(st.st_mtime)}"
    )
    assert _objects_under(world, world.renders[SCAN]["cache_key"])


def test_provisional_key_when_the_fingerprint_is_not_done(world):
    _scan_file(world)
    world.add_scan()
    world.fingerprints[FILE] = {"status": "error", "content_sha256": SHA}
    job.render_scan(SCAN)
    assert world.renders[SCAN]["cache_key"].startswith(f"p-{FILE}-")


def test_cache_hit_skips_reading_the_file(world, monkeypatch):
    _scan_file(world)
    world.add_scan()
    world.current_fingerprint(FILE, SHA)
    job.render_scan(SCAN)
    first = dict(world.renders[SCAN])
    writes = dict(world.objects)

    # The same bytes under another file id and name: same content hash.
    _scan_file(world, name="copy.al3d")
    world.add_file("rig/copy.al3d", file_id=OTHER_FILE)
    world.current_fingerprint(OTHER_FILE, SHA)
    world.add_scan(OTHER_SCAN, OTHER_FILE)

    def boom(*args):
        raise AssertionError("the file must not be read on a cache hit")

    monkeypatch.setattr(topography, "read_scan", boom)
    job.render_scan(OTHER_SCAN)

    second = world.renders[OTHER_SCAN]
    assert world.rows[OTHER_SCAN]["render_status"] == "done"
    assert second["cache_key"] == SHA
    for column in ("source_format", "source_width", "grid_width", "grid_height", "z_min_um", "z_max_um",
                   "pixel_pitch_x_um", "pixel_pitch_y_um"):  # fmt: skip
        assert second[column] == first[column]
    assert world.objects == writes  # nothing rewritten


def test_an_incomplete_earlier_render_is_not_a_cache_hit(world):
    _scan_file(world)
    world.add_scan()
    world.current_fingerprint(FILE, SHA)
    job.render_scan(SCAN)
    del world.objects[f"surface-scans/{SHA}/thumb.png"]
    world.rows[SCAN]["render_status"] = "pending"
    job.render_scan(SCAN)
    assert f"surface-scans/{SHA}/thumb.png" in world.objects  # rendered again


def test_only_a_pending_row_is_rendered(world):
    _scan_file(world)
    for status in ("rendering", "done", "failed"):
        world.add_scan(status=status)
        job.render_scan(SCAN)
        assert world.history == []
        assert world.rows[SCAN]["render_status"] == status
    assert world.objects == {}


def test_losing_the_claim_race_does_nothing(world):
    _scan_file(world)
    world.add_scan()
    world.conflicts_to_inject = (
        1  # another job claimed it between our read and our write
    )
    job.render_scan(SCAN)
    assert world.objects == {}
    assert world.rows[SCAN]["render_status"] == "pending"


def test_a_render_again_during_the_render_is_not_overwritten(world, monkeypatch):
    _scan_file(world)
    world.add_scan()
    real = topography.read_scan

    def read_then_reset(path, expected=None):
        scan = real(path, expected)
        world.rows[SCAN]["render_status"] = "pending"  # Render again pressed meanwhile
        world.rows[SCAN]["version"] += 1
        return scan

    monkeypatch.setattr(topography, "read_scan", read_then_reset)
    job.render_scan(SCAN)
    assert world.rows[SCAN]["render_status"] == "pending"


def test_a_409_at_the_result_is_retried_with_the_version_read_again(world):
    _scan_file(world)
    world.add_scan()
    world.result_conflicts_to_inject = 2  # the row's version moves under both attempts
    job.render_scan(SCAN)
    assert world.rows[SCAN]["render_status"] == "done"
    assert world.renders[SCAN]["cache_key"]
    versions = [body["version"] for _, body in world.results]
    assert versions == [
        2,
        3,
        4,
    ]  # each retry re-read the row and sent the version it found


def test_a_lost_claim_at_the_result_is_skipped_not_overwritten(world, monkeypatch):
    """Render again was pressed during the render: the row is pending, so nothing is posted."""
    _scan_file(world)
    world.add_scan()
    real = topography.read_scan

    def read_then_reset(path, expected=None):
        scan = real(path, expected)
        world.rows[SCAN]["render_status"] = "pending"
        world.rows[SCAN]["version"] += 1
        return scan

    monkeypatch.setattr(topography, "read_scan", read_then_reset)
    job.render_scan(SCAN)
    assert world.results == []
    assert SCAN not in world.renders
    assert world.rows[SCAN]["render_status"] == "pending"


def test_a_claim_lost_during_the_retries_is_skipped(world):
    """The first post answers 409 and the row was reset meanwhile: the re-read sees 'pending'."""
    _scan_file(world)
    world.add_scan()
    real = world.post_result

    def conflict_after_reset(scan_id, payload, version):
        world.rows[scan_id]["render_status"] = "pending"
        world.rows[scan_id]["version"] += 1
        raise VersionConflictError("stale")

    import app.lib.directus_client as dc

    dc.post_result = conflict_after_reset
    try:
        job.render_scan(SCAN)
    finally:
        dc.post_result = real
    assert world.rows[SCAN]["render_status"] == "pending"
    assert SCAN not in world.renders


def test_giving_up_after_repeated_409s_on_a_done_result_raises(world):
    _scan_file(world)
    world.add_scan()
    world.result_conflicts_to_inject = 99
    with pytest.raises(VersionConflictError, match="gave up"):
        job.render_scan(SCAN)
    # OCC_MAX_ATTEMPTS posts of 'done', then the job's own failure path tries 'failed' as many times
    assert [b["render_status"] for _, b in world.results] == ["done"] * 5 + [
        "failed"
    ] * 5
    assert SCAN not in world.renders


def test_a_rejected_done_result_raises_so_the_job_fails(world):
    """A 403 (the token is not an administrator's) or a 400 must not be swallowed on success."""
    _scan_file(world)
    world.add_scan()
    world.result_error = RuntimeError("403 Forbidden")
    with pytest.raises(RuntimeError, match="403"):
        job.render_scan(SCAN)
    assert SCAN not in world.renders


def test_a_failed_result_that_cannot_be_posted_does_not_hide_the_render_error(world):
    world.add_file("rig/gone.al3d")
    world.add_scan()
    world.result_error = RuntimeError("directus down")
    with pytest.raises(
        Exception, match="moved or deleted"
    ):  # the original error, not directus down
        job.render_scan(SCAN)


# --- failure paths: row goes to failed with a message, and the job re-raises -----------------------


def _fails(world, match, error_contains=None):
    with pytest.raises(Exception, match=match):
        job.render_scan(SCAN)
    assert world.rows[SCAN]["render_status"] == "failed"
    error = world.renders[SCAN]["render_error"]
    assert error
    assert error_contains is None or error_contains in error
    assert "columns" not in world.results[-1][1]
    assert world.statuses() == ["rendering", "failed"]
    assert world.objects == {}


def test_a_missing_file_fails_the_row(world):
    world.add_file("rig/gone.al3d")
    world.add_scan()
    _fails(world, "moved or deleted", "moved or deleted")


def test_a_file_without_archive_path_fails(world):
    world.add_file(None)
    world.add_scan()
    _fails(world, "archive_path")


def test_a_local_upload_is_not_rendered(world):
    world.add_file("rig/x.al3d", storage="local")
    world.add_scan()
    _fails(world, "not on the archive share")


@pytest.mark.parametrize(
    "path", ["../../etc/passwd.al3d", "/etc/shadow.al3d", "rig/../../x.al3d"]
)
def test_a_path_that_escapes_the_archive_fails_and_nothing_is_opened(
    world, monkeypatch, path
):
    world.add_file(path)
    world.add_scan()
    monkeypatch.setattr(topography, "read_scan", lambda p: pytest.fail("must not open"))
    with pytest.raises(Exception):
        job.render_scan(SCAN)
    assert world.rows[SCAN]["render_status"] == "failed"


@pytest.mark.parametrize(
    "name", ["report.pdf", "protocol.docx", "force.mat", "table.xlsx", "notes.txt"]
)
def test_documents_are_never_opened(world, monkeypatch, name):
    (world.root / "rig" / name).write_bytes(b"not a scan")
    world.add_file(f"rig/{name}")
    world.add_scan()
    opened = []
    monkeypatch.setattr(topography, "read_scan", lambda p: opened.append(p))
    _fails(world, "topography", "Not a topography file format")
    assert opened == []


def test_a_corrupt_file_fails_with_the_reader_error(world):
    (world.root / "rig" / "bad.al3d").write_bytes(b"garbage" * 100)
    world.add_file("rig/bad.al3d")
    world.add_scan()
    _fails(world, "could not be read")


def test_a_scan_with_no_valid_cell_fails(world):
    write_al3d(world.root / "rig" / "empty.al3d", np.full((4, 4), np.nan))
    world.add_file("rig/empty.al3d")
    world.add_scan()
    _fails(world, "no valid height")


def test_an_unexpected_error_fails_the_row_and_reraises_the_original(world):
    _scan_file(world)
    world.add_scan()
    world.put_error = ConnectionError("minio down")
    with pytest.raises(ConnectionError, match="minio down"):
        job.render_scan(SCAN)
    assert world.rows[SCAN]["render_status"] == "failed"
    error = world.renders[SCAN]["render_error"]
    assert error.startswith("Unexpected error: ConnectionError")


def test_the_error_message_is_capped(world):
    _scan_file(world)
    world.add_scan()
    world.put_error = RuntimeError("x" * 5000)
    with pytest.raises(RuntimeError):
        job.render_scan(SCAN)
    assert len(world.renders[SCAN]["render_error"]) <= 500


def test_render_again_after_a_failure_clears_the_error(world):
    world.add_file("rig/later.al3d")
    world.add_scan()
    with pytest.raises(Exception):
        job.render_scan(SCAN)
    assert world.renders[SCAN]["render_error"]
    write_al3d(world.root / "rig" / "later.al3d", ramp(3, 3))
    world.rows[SCAN]["render_status"] = "pending"  # what POST /render does
    job.render_scan(SCAN)
    assert world.rows[SCAN]["render_status"] == "done"
    assert world.renders[SCAN]["render_error"] is None


def test_a_file_re_exported_in_place_is_not_served_from_the_old_hash(world):
    """Same size, new mtime: the crawler's hash is stale, so the cache must not hit."""
    path = _scan_file(world, rows=20, cols=30)
    world.add_scan()
    world.current_fingerprint(FILE, SHA)
    job.render_scan(SCAN)
    assert world.renders[SCAN]["cache_key"] == SHA
    old_surface = world.objects[f"surface-scans/{SHA}/grid.bin"][0]

    # Re-export in place: a different surface of the same size, a newer mtime; the fingerprint is old.
    write_al3d(path, ramp(20, 30, scale_m=2e-6))
    st = path.stat()
    os.utime(path, ns=(st.st_atime_ns, st.st_mtime_ns + 3_600 * 10**9))
    world.rows[SCAN]["render_status"] = "pending"

    job.render_scan(SCAN)

    row = world.renders[SCAN]
    assert world.rows[SCAN]["render_status"] == "done"
    assert row["cache_key"] != SHA
    assert row["cache_key"].startswith(f"p-{FILE}-")
    new_surface = world.objects[f"surface-scans/{row['cache_key']}/grid.bin"][0]
    assert new_surface != old_surface  # really re-read, not the old surface
    assert world.objects[f"surface-scans/{SHA}/grid.bin"][0] == old_surface


def test_a_fingerprint_without_source_mtime_is_not_trusted_by_the_job(world):
    _scan_file(world)
    world.add_scan()
    world.current_fingerprint(FILE, SHA, source_mtime=None)
    job.render_scan(SCAN)
    assert world.renders[SCAN]["cache_key"].startswith(f"p-{FILE}-")


def test_a_file_replaced_between_the_stat_and_the_read_fails_the_row(
    world, monkeypatch
):
    path = _scan_file(world, rows=10, cols=10)
    world.add_scan()
    real_stat = archive.stat_file

    def stat_then_swap(p):
        st = real_stat(p)
        os.replace(write_al3d(path.parent / "other.al3d", ramp(12, 12)), path)
        return st

    monkeypatch.setattr(archive, "stat_file", stat_then_swap)
    with pytest.raises(RenderError, match="changed on the share"):
        job.render_scan(SCAN)
    assert world.rows[SCAN]["render_status"] == "failed"
    assert "changed on the share" in world.renders[SCAN]["render_error"]
    assert world.objects == {}


# --- the invariants of the design ------------------------------------------------------------------


APP = Path(__file__).parent.parent / "app"


def test_the_worker_never_hashes_a_file():
    for source in APP.rglob("*.py"):
        text = source.read_text()
        assert "hashlib" not in text, source
        assert "sha256(" not in text, source


def _code_strings(tree: ast.AST):
    """String literals in *tree* that are code (f-strings, URLs, SQL), not docstrings."""
    docstrings = set()
    for node in ast.walk(tree):
        if isinstance(
            node, ast.Module | ast.FunctionDef | ast.ClassDef | ast.AsyncFunctionDef
        ):
            body = getattr(node, "body", [])
            if (
                body
                and isinstance(body[0], ast.Expr)
                and isinstance(body[0].value, ast.Constant)
            ):
                docstrings.add(id(body[0].value))
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Constant)
            and isinstance(node.value, str)
            and id(node) not in docstrings
        ):
            yield node.value


def test_the_worker_never_writes_file_fingerprints():
    mentions = []
    for source in APP.rglob("*.py"):
        for value in _code_strings(ast.parse(source.read_text())):
            if "file_fingerprints" in value:
                mentions.append((source.name, value))
    # Only the Directus client names the table, and it builds exactly one URL for it (a GET, below).
    assert {name for name, _ in mentions} == {"directus_client.py"}
    assert [v for _, v in mentions if "/items/" in v] == ["/items/file_fingerprints"]
    text = (APP / "lib" / "directus_client.py").read_text()
    block = text[text.index("def get_fingerprint") :]
    for verb in ("patch", "post", "put", "delete"):
        assert f"requests.{verb}" not in block


def test_the_only_open_of_an_archive_file_is_read_only_and_nofollow():
    calls = []
    for source in APP.rglob("*.py"):
        for node in ast.walk(ast.parse(source.read_text())):
            if isinstance(node, ast.Call):
                f = node.func
                name = f.id if isinstance(f, ast.Name) else getattr(f, "attr", "")
                if name in ("open", "fdopen"):
                    calls.append((source.name, ast.unparse(f)))
    # One descriptor open and its file object; nothing else opens a file in the worker.
    assert calls == [("archive.py", "os.open"), ("archive.py", "os.fdopen")]
    text = (APP / "lib" / "archive.py").read_text()
    assert "os.O_RDONLY | os.O_NOFOLLOW" in text
    for flag in ("O_WRONLY", "O_RDWR", "O_CREAT", "O_TRUNC", "O_APPEND"):
        assert flag not in text.replace("O_RDONLY", "")
    assert 'os.fdopen(fd, "rb")' in text


def test_a_repointed_file_row_is_not_rendered(world):
    """A member edited metadata.archive_path of a registered row to another file under the share."""
    other = write_al3d(world.root / "rig" / "private.al3d", ramp(20, 30))
    assert other.exists()
    world.add_file(
        "rig/private.al3d", forged=True
    )  # the id is not the one derived from that path
    world.add_scan()
    _fails(world, "does not match its id")
    assert not world.objects  # nothing was rendered, nothing was written


def test_a_file_row_with_the_derived_id_renders(world):
    _scan_file(world)
    world.add_scan()
    job.render_scan(SCAN)
    assert world.rows[SCAN]["render_status"] == "done"
