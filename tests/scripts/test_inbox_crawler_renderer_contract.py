# ruff: noqa: F811
"""What the Alicona surface-scan renderer relies on (it reads the share and trusts our hash).

* every pointer row has storage 'star' and metadata.archive_path (relative to star_group1), as the indexer writes;
* a fingerprint row carries the size and mtime the hash was taken against, and is 'done' only if the file did
  not change while it was read, so a reader can tell when a hash no longer matches its file.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

pytest.importorskip("psycopg2")
from test_inbox_crawler_scan import make, one_person, run, settle  # noqa: E402, F401
from test_inbox_crawler_world import world  # noqa: E402, F401


def test_a_surface_scan_pointer_row_is_a_star_row_with_an_archive_path(world):
    world.person("abc12de")
    world.write("Users/abc12de/cuts/edge1.al3d", b"AL3D" * 50)
    settle(world)
    run(world)
    row = world.one(
        "SELECT storage, metadata::jsonb->>'archive_path', filename_disk FROM directus_files"
    )
    assert row == (
        "star",
        "Users/abc12de/cuts/edge1.al3d",
        "Users/abc12de/cuts/edge1.al3d",
    )


def test_every_found_file_has_storage_star_and_an_archive_path(one_person):
    world, _, _ = one_person
    run(world)
    rows = world.q(
        "SELECT f.storage, f.metadata::jsonb->>'archive_path' = c.rel_path FROM directus_files f "
        "JOIN file_candidates c ON c.directus_files_id = f.id"
    )
    assert rows and set(rows) == {("star", True)}


@pytest.mark.parametrize("rel", ["Users/abc12de/scan1.al3d", "Users/abc12de/sem/a.png"])
def test_the_fingerprint_records_the_size_and_mtime_it_was_taken_against(
    one_person, rel
):
    world, _, _ = one_person
    run(world)
    p = Path(world.root, rel)
    row = world.one(
        "SELECT f.status, f.size_bytes, extract(epoch FROM f.source_mtime)::float8 "
        "FROM file_fingerprints f JOIN file_candidates c ON c.directus_files_id = f.directus_files_id "
        "WHERE c.rel_path = %s",
        (rel,),
    )
    assert row[0] == "done" and row[1] == p.stat().st_size
    assert row[2] == pytest.approx(p.stat().st_mtime, abs=1e-5)


def test_a_file_that_changes_while_it_is_hashed_is_not_recorded_as_done(world):
    world.person("abc12de")
    world.write("Users/abc12de/a.al3d", b"first version")
    settle(world)
    sc, spy, _ = make(world)
    real = spy.open_rb

    def changing(rel, adopted=False):
        Path(world.root, rel).write_bytes(b"a longer second version")
        return real(rel, adopted)

    spy.open_rb = changing
    sc.scan()
    row = world.one(
        "SELECT status, content_sha256, error_message FROM file_fingerprints"
    )
    assert row[0] == "error" and row[1] is None and "changed" in row[2]
    assert (
        world.one("SELECT count(*) FROM file_candidates")[0] == 1
    )  # still a found file


def test_a_file_edited_later_leaves_a_fingerprint_that_visibly_no_longer_matches(
    one_person,
):
    world, _, _ = one_person
    run(world)
    p = Path(world.root, "Users/abc12de/scan1.al3d")
    p.write_bytes(
        b"edited in place, so longer than before" * 10
    )  # v1 does not notice in-place edits
    settle(world)
    run(world)
    size = world.one(
        "SELECT f.size_bytes FROM file_fingerprints f JOIN file_candidates c "
        "ON c.directus_files_id = f.directus_files_id WHERE c.rel_path = 'Users/abc12de/scan1.al3d'"
    )[0]
    assert (
        size == 400 and size != p.stat().st_size
    )  # a reader comparing sizes sees the hash is stale


def test_the_scan_extension_list_is_still_just_al3d():
    from inbox_crawler import fs_readonly

    assert fs_readonly.SCAN_EXTENSIONS == (".al3d",)
