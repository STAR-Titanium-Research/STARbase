# ruff: noqa: F811
"""The inbox crawler stamps the provenance owner on pointer rows (ADR-0022, SEM reader plan task E1).

Postgres-backed (see test_inbox_crawler_world.py, whose fixture carries the owner columns of migration 196).
The owner is the person_id or team_id of the Owner a scan works for, never read from a path again; a stamp
is written once and never overwritten; a linked file stays unowned.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

pytest.importorskip("psycopg2")
from inbox_crawler import db, kinds, recognise  # noqa: E402
from inbox_crawler.identity import file_id  # noqa: E402
from inbox_crawler.owners import Owner  # noqa: E402
from test_inbox_crawler_scan import OLD, png, run, settle  # noqa: E402, F401
from test_inbox_crawler_world import world  # noqa: E402, F401

T0 = db.to_datetime(1_700_000_000_000_000_000)


def person_owner(pid, alias):
    return Owner("person", pid, f"Users/{alias}", alias, claim=alias)


def team_owner(tid, folder):
    return Owner("team", tid, f"Shared/{folder}", folder, claim=folder)


def register(store, owner, rel):
    return store.register_file(
        owner=owner,
        rel=rel,
        size=1,
        mtime=T0,
        classification=kinds.Classification("image"),
        recognition=recognise.NO_MATCH,
        origin="new",
        hashed=None,
    )


def owner_of(world, rel):
    """(owner_person_id, owner_team_id) of the pointer row of `rel`, as text."""
    return world.one(
        "SELECT owner_person_id::text, owner_team_id::text FROM directus_files WHERE id = %s",
        (str(file_id(rel)),),
    )


def indexer_row(world, rel):
    """A pointer row as the indexer writes it: no owner, no candidate."""
    world.q(
        "INSERT INTO directus_files (id, storage, filename_download, type, metadata) "
        "VALUES (%s, 'star', %s, 'image/png', %s)",
        (
            str(file_id(rel)),
            rel.rsplit("/", 1)[1],
            json.dumps({"archive_path": rel}),
        ),
    )


def link(world, rel):
    """Link the file to a sample, as Data Studio's picker does."""
    sid = world.sample("S" + rel[-6:])
    world.q(
        "INSERT INTO sample_data_files (sample_id, directus_files_id) VALUES (%s, %s)",
        (sid, str(file_id(rel))),
    )


# ---- a new file takes its owner's stamp ----------------------------------------------------------


def test_new_file_is_stamped_with_the_owner(world):
    pid, _ = world.person("abc12de")
    tid = world.team("Machining")
    store = db.Store(world.conn)
    register(store, person_owner(pid, "abc12de"), "Users/abc12de/a.png")
    register(store, team_owner(tid, "Machining"), "Shared/Machining/b.png")
    assert owner_of(world, "Users/abc12de/a.png") == (pid, None)
    assert owner_of(world, "Shared/Machining/b.png") == (None, tid)


def test_a_scan_stamps_the_files_it_registers_for_a_person_and_for_a_team(world):
    pid, _ = world.person("abc12de")
    tid = world.team("Machining")
    world.write("Users/abc12de/sem/a.png", png((1, 1, 1)))
    world.write("Shared/Machining/b.png", png((2, 2, 2)))
    settle(world)
    world.commit()
    stats, _, _ = run(world)
    assert stats.registered == 2
    assert owner_of(world, "Users/abc12de/sem/a.png") == (pid, None)
    assert owner_of(world, "Shared/Machining/b.png") == (None, tid)


def test_existing_unlinked_row_is_stamped_on_first_encounter(world):
    """The indexer made the pointer row first: registering the candidate stamps it."""
    pid, _ = world.person("abc12de")
    rel = "Users/abc12de/sem/a.png"
    indexer_row(world, rel)
    assert owner_of(world, rel) == (None, None)
    store = db.Store(world.conn)
    register(store, person_owner(pid, "abc12de"), rel)
    assert owner_of(world, rel) == (pid, None)


def test_a_scan_stamps_an_unstamped_row_of_a_candidate_it_already_knows(world):
    """A candidate whose pointer row has no stamp (an older crawler made it) is stamped when its folder is
    listed again."""
    pid, _ = world.person("abc12de")
    rel = "Users/abc12de/sem/a.png"
    world.write(rel, png((1, 1, 1)))
    settle(world)
    world.commit()
    run(world)
    assert owner_of(world, rel) == (pid, None)
    world.q(
        "UPDATE directus_files SET owner_person_id = NULL WHERE id = %s",
        (str(file_id(rel)),),
    )
    world.write("Users/abc12de/sem/other.png", png((2, 2, 2)))  # the folder changes
    os.utime(Path(world.root, "Users/abc12de/sem"), (OLD + 60, OLD + 60))
    world.commit()
    run(world)
    assert owner_of(world, rel) == (pid, None)


def test_stamp_owner_stamps_an_unstamped_unlinked_row_once(world):
    pid, _ = world.person("abc12de")
    rel = "Users/abc12de/a.png"
    indexer_row(world, rel)
    store = db.Store(world.conn)
    fid = str(file_id(rel))
    assert store.stamp_owner(fid, person_owner(pid, "abc12de")) is True
    assert owner_of(world, rel) == (pid, None)
    assert (
        store.stamp_owner(fid, person_owner(pid, "abc12de")) is False
    )  # nothing to do


# ---- a linked file stays unowned -----------------------------------------------------------------


def test_linked_row_is_not_stamped(world):
    pid, _ = world.person("abc12de")
    rel = "Users/abc12de/a.png"
    indexer_row(world, rel)
    link(world, rel)
    store = db.Store(world.conn)
    assert store.stamp_owner(str(file_id(rel)), person_owner(pid, "abc12de")) is False
    assert owner_of(world, rel) == (None, None)
    # registering a candidate for it (a race with the link) does not stamp it either
    register(store, person_owner(pid, "abc12de"), rel)
    assert owner_of(world, rel) == (None, None)


def test_a_file_linked_to_an_operation_or_a_session_is_not_stamped_either(world):
    pid, _ = world.person("abc12de")
    store = db.Store(world.conn)
    for n, (table, col) in enumerate(
        [("operation_data_files", "operation_id"), ("session_data_files", "session_id")]
    ):
        rel = f"Users/abc12de/f{n}.png"
        indexer_row(world, rel)
        world.q(
            f"INSERT INTO {table} ({col}, directus_files_id) VALUES (gen_random_uuid(), %s)",
            (str(file_id(rel)),),
        )
        assert (
            store.stamp_owner(str(file_id(rel)), person_owner(pid, "abc12de")) is False
        )
        assert owner_of(world, rel) == (None, None)


# ---- a stamp is never overwritten ----------------------------------------------------------------


def test_stamp_is_never_overwritten(world):
    a, _ = world.person("aaa11")
    b, _ = world.person("bbb22")
    tid = world.team("Machining")
    rel = "Users/aaa11/a.png"
    store = db.Store(world.conn)
    register(store, person_owner(a, "aaa11"), rel)
    assert owner_of(world, rel) == (a, None)
    # a second owner scanning the same path (registering and stamping) leaves the first
    fid = str(file_id(rel))
    assert store.stamp_owner(fid, person_owner(b, "aaa11")) is False
    assert store.stamp_owner(fid, team_owner(tid, "Machining")) is False
    assert owner_of(world, rel) == (a, None)
    world.q(
        "DELETE FROM file_candidates"
    )  # the candidate row of A is gone: B registers
    register(store, person_owner(b, "aaa11"), rel)
    assert owner_of(world, rel) == (a, None)


def test_a_team_stamp_is_not_overwritten_by_a_person(world):
    pid, _ = world.person("abc12de")
    tid = world.team("Machining")
    rel = "Shared/Machining/a.png"
    store = db.Store(world.conn)
    register(store, team_owner(tid, "Machining"), rel)
    assert store.stamp_owner(str(file_id(rel)), person_owner(pid, "abc12de")) is False
    assert owner_of(world, rel) == (None, tid)


def test_alias_handed_to_someone_else_does_not_move_the_file(world):
    """The owner is the person, not the alias text: when the folder name goes to another person the file
    keeps the person it came from."""
    a, _ = world.person("aaa11")
    rel = "Users/aaa11/a.png"
    world.write(rel, png((1, 1, 1)))
    settle(world)
    world.commit()
    run(world)
    assert owner_of(world, rel) == (a, None)
    world.q("UPDATE people SET uni_alias = 'gone1' WHERE person_id = %s", (a,))
    b, _ = world.person("aaa11")  # the folder name now belongs to B
    world.write("Users/aaa11/b_new.png", png((2, 2, 2)))
    settle(world)
    world.commit()
    run(world)
    assert owner_of(world, rel) == (a, None)  # still A's file
    assert owner_of(world, "Users/aaa11/b_new.png") == (b, None)
    assert world.one(
        "SELECT owner_person_id::text FROM file_candidates WHERE rel_path = %s", (rel,)
    ) == (
        b,
    )  # B's inbox lists it (the candidate follows the folder), the file stays A's
