"""The render job end to end against fakes: Directus rows, MinIO objects, a synthetic .al3d on a fake share."""

import ast
import io
import json
import re
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from app.jobs import render_scan as job
from app.lib import topography
from app.lib.directus_client import VersionConflictError

from .conftest import FILE, SCAN
from .synthetic import ramp, write_al3d

SHA = "cd" * 32
OTHER_FILE = "9c1d6a52-2f3a-4c0e-bd0b-7a1a4f0f9c77"
OTHER_SCAN = "1b0a1c1e-5a53-4b0e-9a3c-0d6f6a0c9e22"


def _scan_file(world, name="insert-1.al3d", rows=40, cols=60, **kw) -> Path:
    path = write_al3d(world.root / "rig" / name, ramp(rows, cols), **kw)
    world.add_file(f"rig/{name}")
    return path


def _objects_under(world, key):
    return {k.rsplit("/", 1)[1]: v for k, v in world.objects.items() if k.startswith(f"surface-scans/{key}/")}


def test_happy_path_renders_and_fills_the_row(world):
    _scan_file(world, pixel_size_x_m=2e-6, pixel_size_y_m=4e-6)
    world.add_scan()
    world.fingerprints[FILE] = {"status": "done", "content_sha256": SHA}

    job.render_scan(SCAN)

    assert world.statuses() == ["rendering", "done"]
    row = world.rows[SCAN]
    assert row["render_status"] == "done"
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


def test_the_worker_only_writes_its_own_columns(world):
    _scan_file(world)
    world.add_scan()
    job.render_scan(SCAN)
    allowed = {
        "render_status", "render_error", "rendered_at", "cache_key",
        "source_format", "source_width", "source_height", "grid_width", "grid_height",
        "pixel_pitch_x_um", "pixel_pitch_y_um", "z_min_um", "z_max_um",
    }  # fmt: skip
    for _, payload in world.history:
        assert set(payload) <= allowed


def test_the_three_objects_are_written_under_the_cache_key(world):
    _scan_file(world, rows=3, cols=4)
    world.add_scan()
    world.fingerprints[FILE] = {"status": "done", "content_sha256": SHA}
    job.render_scan(SCAN)

    objects = _objects_under(world, SHA)
    assert set(objects) == {"grid.bin", "meta.json", "thumb.png"}
    grid_bytes, _ = objects["grid.bin"]
    cells = np.frombuffer(grid_bytes, dtype="<f4").reshape(3, 4)
    np.testing.assert_allclose(cells, ramp(3, 4, scale_m=1.0), atol=1e-4)  # micrometres, top row first
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
    row = world.rows[SCAN]
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
    assert world.rows[SCAN]["cache_key"] == f"p-{FILE}-{st.st_size}-{int(st.st_mtime)}"
    assert _objects_under(world, world.rows[SCAN]["cache_key"])


def test_provisional_key_when_the_fingerprint_is_not_done(world):
    _scan_file(world)
    world.add_scan()
    world.fingerprints[FILE] = {"status": "error", "content_sha256": SHA}
    job.render_scan(SCAN)
    assert world.rows[SCAN]["cache_key"].startswith(f"p-{FILE}-")


def test_cache_hit_skips_reading_the_file(world, monkeypatch):
    _scan_file(world)
    world.add_scan()
    world.fingerprints[FILE] = {"status": "done", "content_sha256": SHA}
    job.render_scan(SCAN)
    first = dict(world.rows[SCAN])
    writes = dict(world.objects)

    # The same bytes under another file id and name: same content hash.
    _scan_file(world, name="copy.al3d")
    world.files[OTHER_FILE] = {"id": OTHER_FILE, "storage": "star", "metadata": {"archive_path": "rig/copy.al3d"}}
    world.fingerprints[OTHER_FILE] = {"status": "done", "content_sha256": SHA}
    world.add_scan(OTHER_SCAN, OTHER_FILE)

    def boom(path):
        raise AssertionError("the file must not be read on a cache hit")

    monkeypatch.setattr(topography, "read_scan", boom)
    job.render_scan(OTHER_SCAN)

    second = world.rows[OTHER_SCAN]
    assert second["render_status"] == "done"
    assert second["cache_key"] == SHA
    for column in ("source_format", "source_width", "grid_width", "grid_height", "z_min_um", "z_max_um",
                   "pixel_pitch_x_um", "pixel_pitch_y_um"):  # fmt: skip
        assert second[column] == first[column]
    assert world.objects == writes  # nothing rewritten


def test_an_incomplete_earlier_render_is_not_a_cache_hit(world):
    _scan_file(world)
    world.add_scan()
    world.fingerprints[FILE] = {"status": "done", "content_sha256": SHA}
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
    world.conflicts_to_inject = 1  # another job claimed it between our read and our write
    job.render_scan(SCAN)
    assert world.objects == {}
    assert world.rows[SCAN]["render_status"] == "pending"


def test_a_render_again_during_the_render_is_not_overwritten(world, monkeypatch):
    _scan_file(world)
    world.add_scan()
    real = topography.read_scan

    def read_then_reset(path):
        scan = real(path)
        world.rows[SCAN]["render_status"] = "pending"  # Render again pressed meanwhile
        world.rows[SCAN]["version"] += 1
        return scan

    monkeypatch.setattr(topography, "read_scan", read_then_reset)
    job.render_scan(SCAN)
    assert world.rows[SCAN]["render_status"] == "pending"


def test_a_stale_version_at_the_final_write_is_retried(world):
    _scan_file(world)
    world.add_scan()
    real = world.patch_scan
    calls = {"n": 0}

    def flaky(scan_id, payload, version=None):
        calls["n"] += 1
        if calls["n"] == 2:  # the terminal write, first attempt
            world.rows[scan_id]["version"] += 1
            raise VersionConflictError("stale")
        return real(scan_id, payload, version)

    import app.lib.directus_client as dc

    dc.patch_scan = flaky
    try:
        job.render_scan(SCAN)
    finally:
        dc.patch_scan = real
    assert world.rows[SCAN]["render_status"] == "done"


# --- failure paths: row goes to failed with a message, and the job re-raises -----------------------


def _fails(world, match, error_contains=None):
    with pytest.raises(Exception, match=match):
        job.render_scan(SCAN)
    row = world.rows[SCAN]
    assert row["render_status"] == "failed"
    assert row["render_error"]
    assert error_contains is None or error_contains in row["render_error"]
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


@pytest.mark.parametrize("path", ["../../etc/passwd.al3d", "/etc/shadow.al3d", "rig/../../x.al3d"])
def test_a_path_that_escapes_the_archive_fails_and_nothing_is_opened(world, monkeypatch, path):
    world.add_file(path)
    world.add_scan()
    monkeypatch.setattr(topography, "read_scan", lambda p: pytest.fail("must not open"))
    with pytest.raises(Exception):
        job.render_scan(SCAN)
    assert world.rows[SCAN]["render_status"] == "failed"


@pytest.mark.parametrize("name", ["report.pdf", "protocol.docx", "force.mat", "table.xlsx", "notes.txt"])
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
    row = world.rows[SCAN]
    assert row["render_status"] == "failed"
    assert row["render_error"].startswith("Unexpected error: ConnectionError")


def test_the_error_message_is_capped(world):
    _scan_file(world)
    world.add_scan()
    world.put_error = RuntimeError("x" * 5000)
    with pytest.raises(RuntimeError):
        job.render_scan(SCAN)
    assert len(world.rows[SCAN]["render_error"]) <= 500


def test_render_again_after_a_failure_clears_the_error(world):
    world.add_file("rig/later.al3d")
    world.add_scan()
    with pytest.raises(Exception):
        job.render_scan(SCAN)
    assert world.rows[SCAN]["render_error"]
    write_al3d(world.root / "rig" / "later.al3d", ramp(3, 3))
    world.rows[SCAN]["render_status"] = "pending"  # what POST /render does
    job.render_scan(SCAN)
    assert world.rows[SCAN]["render_status"] == "done"
    assert world.rows[SCAN]["render_error"] is None


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
        if isinstance(node, ast.Module | ast.FunctionDef | ast.ClassDef | ast.AsyncFunctionDef):
            body = getattr(node, "body", [])
            if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant):
                docstrings.add(id(body[0].value))
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in docstrings:
            yield node.value


def test_the_worker_never_writes_file_fingerprints():
    mentions = []
    for source in APP.rglob("*.py"):
        for value in _code_strings(ast.parse(source.read_text())):
            if "file_fingerprints" in value:
                mentions.append((source.name, value))
    # Only the Directus client names the table, and it builds exactly one URL for it (a GET, below).
    assert {name for name, _ in mentions} == {"directus_client.py"}
    assert [v for _, v in mentions if "/items/" in v] == ["/items/file_fingerprints/"]
    text = (APP / "lib" / "directus_client.py").read_text()
    block = text[text.index("def get_fingerprint") :]
    for verb in ("patch", "post", "put", "delete"):
        assert f"requests.{verb}" not in block


def test_the_only_open_of_an_archive_file_is_read_only():
    opens = []
    for source in APP.rglob("*.py"):
        for line in source.read_text().splitlines():
            if re.search(r"(?<![\w.])open\(", line) and not line.lstrip().startswith(("#", '"""')):
                opens.append((source.name, line.strip()))
    assert opens == [("archive.py", 'return open(path, "rb")  # noqa: SIM115 - the caller closes it')]
