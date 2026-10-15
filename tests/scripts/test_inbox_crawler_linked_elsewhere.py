# ruff: noqa: F811
"""Items 13 and 14: a file already linked elsewhere is not a found file; copies of images and scans."""

from __future__ import annotations

import os
import sys
import uuid
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

pytest.importorskip("psycopg2")
import index_archive as ia  # noqa: E402
from test_inbox_crawler_scan import (  # noqa: E402, F401
    OLD,
    cands,
    make,
    png,
    run,
    settle,
)
from test_inbox_crawler_world import world  # noqa: E402, F401

JUNCTIONS = [
    ("sample_data_files", "sample_id"),
    ("operation_data_files", "operation_id"),
    ("session_data_files", "session_id"),
]


def link_in_data_studio(world, junction, parent_col, rel):
    """A person linked the file with Data Studio's picker: a pointer row and a junction row, no candidate."""
    fid = str(ia.file_id(rel))
    world.q(
        "INSERT INTO directus_files (id, storage, filename_download) VALUES (%s, 'star', %s) ON CONFLICT DO NOTHING",
        (fid, rel.rsplit("/", 1)[-1]),
    )
    world.q(
        f"INSERT INTO {junction} ({parent_col}, directus_files_id) VALUES (%s, %s)",
        (str(uuid.uuid4()), fid),
    )
    world.commit()
    return fid


# ---- item 13 ------------------------------------------------------------------------------------------


@pytest.mark.parametrize("junction,parent", JUNCTIONS)
def test_a_file_already_linked_in_a_junction_gets_no_candidate(world, junction, parent):
    world.person("abc12de")
    world.write("Users/abc12de/linked.png", png((1, 1, 1)))
    world.write("Users/abc12de/free.png", png((2, 2, 2)))
    link_in_data_studio(world, junction, parent, "Users/abc12de/linked.png")
    settle(world)
    stats = run(world)[0]
    assert list(cands(world)) == ["Users/abc12de/free.png"]
    assert stats.registered == 1 and stats.errors == 0


def test_a_linked_document_is_skipped_too_and_the_folder_still_counts_as_scanned(world):
    world.person("abc12de")
    world.write("Users/abc12de/notes.pdf", b"%PDF")
    link_in_data_studio(
        world, "operation_data_files", "operation_id", "Users/abc12de/notes.pdf"
    )
    settle(world)
    run(world)
    assert list(cands(world)) == []
    assert world.one(
        "SELECT baselined_at IS NOT NULL FROM inbox_dirs WHERE rel_path = 'Users/abc12de'"
    )[0]


@pytest.mark.parametrize("junction,parent", JUNCTIONS)
def test_a_candidate_whose_file_gets_linked_in_data_studio_disappears_at_the_next_scan(
    world, junction, parent
):
    world.person("abc12de")
    world.write("Users/abc12de/a.png", png((1, 1, 1)))
    world.write("Users/abc12de/b.png", png((2, 2, 2)))
    settle(world)
    run(world)
    assert len(cands(world)) == 2
    link_in_data_studio(world, junction, parent, "Users/abc12de/a.png")
    stats = run(world)[
        0
    ]  # nothing in the folder changed: the folder is not even listed
    assert stats.listed_dirs == 0
    assert list(cands(world)) == ["Users/abc12de/b.png"]
    # and it is not brought back by a later scan of a changed folder
    world.write("Users/abc12de/c.png", png((3, 3, 3)))
    run(world)
    assert sorted(cands(world)) == ["Users/abc12de/b.png", "Users/abc12de/c.png"]


def test_a_gone_candidate_whose_file_is_linked_meanwhile_is_dropped_too(world):
    world.person("abc12de")
    world.write("Users/abc12de/a.png", png())
    settle(world)
    run(world)
    os.unlink(Path(world.root, "Users/abc12de/a.png"))
    os.utime(Path(world.root, "Users/abc12de"), (OLD + 10, OLD + 10))
    run(world)
    assert cands(world)["Users/abc12de/a.png"][0] == "gone"
    link_in_data_studio(world, "sample_data_files", "sample_id", "Users/abc12de/a.png")
    run(world)
    assert cands(world) == {}


def test_linked_and_dismissed_candidates_are_never_touched(world):
    world.person("abc12de")
    world.write("Users/abc12de/a.png", png((1, 1, 1)))
    world.write("Users/abc12de/b.png", png((2, 2, 2)))
    settle(world)
    run(world)
    world.q(
        "UPDATE file_candidates SET state = 'linked', link_kind = 'manual', linked_collection = 'physical_samples', "
        "linked_junction_id = gen_random_uuid(), link_batch_id = gen_random_uuid() "
        "WHERE rel_path = 'Users/abc12de/a.png'"
    )
    world.q(
        "UPDATE file_candidates SET state = 'dismissed' WHERE rel_path = 'Users/abc12de/b.png'"
    )
    world.commit()
    for rel in ("Users/abc12de/a.png", "Users/abc12de/b.png"):
        link_in_data_studio(world, "sample_data_files", "sample_id", rel)
    run(world)
    assert {k: v[0] for k, v in cands(world).items()} == {
        "Users/abc12de/a.png": "linked",
        "Users/abc12de/b.png": "dismissed",
    }


def test_the_clean_up_is_per_owner_and_the_copies_of_a_dropped_original_are_freed(
    world,
):
    pa, _ = world.person("aaa11")
    world.person("bbb22")
    same = png((7, 7, 7))
    world.write("Users/aaa11/orig.png", same)
    settle(world)
    run(world)
    world.write("Users/bbb22/copy.png", same)
    settle(world)
    run(world)
    assert world.one(
        "SELECT duplicate_of IS NOT NULL FROM file_candidates WHERE rel_path = 'Users/bbb22/copy.png'"
    )[0]
    link_in_data_studio(world, "sample_data_files", "sample_id", "Users/aaa11/orig.png")
    run(world, person_id=pa)  # only aaa11's folder is looked at
    assert list(cands(world)) == ["Users/bbb22/copy.png"]
    assert (
        world.one("SELECT duplicate_of FROM file_candidates")[0] is None
    )  # no longer a copy of a deleted row


def test_a_file_in_no_junction_is_registered_as_before(world):
    world.person("abc12de")
    world.write("Users/abc12de/a.png", png())
    settle(world)
    assert run(world)[0].registered == 1


# ---- item 14: copies --------------------------------------------------------------------------------------


def test_copies_are_marked_for_images_and_scans_only_and_follow_their_original(world):
    world.person("aaa11")
    world.person("bbb22")
    img, scan_bytes, doc = png((5, 5, 5)), b"AL3D" * 50, b"%PDF same bytes"
    for who in ("aaa11", "bbb22"):
        world.write(f"Users/{who}/pic.png", img)
        world.write(f"Users/{who}/cut.al3d", scan_bytes)
        world.write(f"Users/{who}/doc.pdf", doc)
        settle(world)
        run(world)  # aaa11 first: the first sight of a content is the original
    dup = {
        r[0]: r[1]
        for r in world.q(
            "SELECT rel_path, duplicate_of IS NOT NULL FROM file_candidates"
        )
    }
    assert (
        dup
        == {
            "Users/aaa11/pic.png": False,
            "Users/aaa11/cut.al3d": False,
            "Users/aaa11/doc.pdf": False,
            "Users/bbb22/pic.png": True,  # a copy: shown as "copy of", counted nowhere by d1-inbox
            "Users/bbb22/cut.al3d": True,
            "Users/bbb22/doc.pdf": False,  # a document is never hashed, so never a copy
        }
    )
    # the original is dismissed or linked by a person: the crawler does nothing, the copy keeps its mark
    world.q(
        "UPDATE file_candidates SET state = 'dismissed' WHERE rel_path IN ('Users/aaa11/pic.png', 'Users/aaa11/cut.al3d')"
    )
    world.commit()
    run(world)
    dup2 = {
        r[0]: r[1]
        for r in world.q(
            "SELECT rel_path, duplicate_of IS NOT NULL FROM file_candidates"
        )
    }
    assert dup2["Users/bbb22/pic.png"] and dup2["Users/bbb22/cut.al3d"]


def test_a_copy_is_freed_when_its_original_has_gone_from_the_share(world):
    world.person("aaa11")
    world.person("bbb22")
    same = png((6, 6, 6))
    world.write("Users/aaa11/orig.png", same)
    settle(world)
    run(world)
    world.write("Users/bbb22/copy.png", same)
    settle(world)
    run(world)
    os.unlink(Path(world.root, "Users/aaa11/orig.png"))
    os.utime(Path(world.root, "Users/aaa11"), (OLD + 10, OLD + 10))
    run(world)
    got = dict(
        world.q(
            "SELECT rel_path, state || ':' || (duplicate_of IS NOT NULL)::text FROM file_candidates"
        )
    )
    assert got == {
        "Users/aaa11/orig.png": "gone:false",
        "Users/bbb22/copy.png": "new:false",
    }
