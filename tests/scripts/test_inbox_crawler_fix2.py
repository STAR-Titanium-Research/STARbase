# ruff: noqa: F811
"""Focused re-review fixes, crawler side (S1 heartbeat connection, S2 deleted folders, S5 surface scans,
and the adopted-hash queue)."""

from __future__ import annotations

import logging
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

pytest.importorskip("psycopg2")
import psycopg2  # noqa: E402
from inbox_crawler import db, hashing, kinds, recognise  # noqa: E402
from inbox_crawler.owners import Owner  # noqa: E402
from test_inbox_crawler_daemon import add_candidate  # noqa: E402
from test_inbox_crawler_scan import cands, make, png, run, settle  # noqa: E402, F401
from test_inbox_crawler_world import world  # noqa: E402, F401

T0 = db.to_datetime(1_700_000_000_000_000_000)


def other_session(world, autocommit=True):
    conn = psycopg2.connect(world.dsn)
    conn.autocommit = autocommit
    with conn.cursor() as cur:
        cur.execute(f"SET search_path = {world.schema}, public")
    return conn


def person_owner(pid, alias):
    return Owner("person", pid, f"Users/{alias}", alias, claim=alias)


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


def count_candidates(conn):
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM file_candidates")
        return cur.fetchone()[0]


# ---- S1: the heartbeat has a connection of its own --------------------------------------------------


def test_a_heartbeat_neither_commits_nor_rolls_back_the_scans_pending_work(world):
    pid, _ = world.person("abc12de")
    world.commit()
    store = db.Store(world.conn)
    register(store, person_owner(pid, "abc12de"), "Users/abc12de/a.png")
    store.heartbeat("hashing something big")
    seen = other_session(world)
    try:
        assert count_candidates(seen) == 0  # not committed by the heartbeat
        with seen.cursor() as cur:
            cur.execute(
                "SELECT current_activity FROM inbox_crawler_state WHERE last_heartbeat_at IS NOT NULL"
            )
            assert cur.fetchone() == ("hashing something big",)  # but written
    finally:
        seen.close()
        store.close_heartbeat()
    assert count_candidates(world.conn) == 1  # and not rolled back either
    store.rollback()
    assert count_candidates(world.conn) == 0


def test_a_heartbeat_during_a_slow_hash_does_not_commit_work_the_alias_guard_must_drop(
    world, monkeypatch
):
    pid, _ = world.person("abc12de")
    world.write("Users/abc12de/a.png", png((1, 1, 1)))
    world.write("Users/abc12de/b.png", png((2, 2, 2)))
    world.commit()
    settle(world)
    ticks = iter(
        range(0, 10**6, 10)
    )  # every _tell is "5 seconds later": the heartbeat fires
    sc, _spy, store = make(world, clock=lambda: next(ticks))
    sc.activity = store.heartbeat
    other = other_session(world)
    real_hash = hashing.hash_file
    beats = []

    def slow_hash(share, rel, **kw):
        if rel.endswith("b.png"):
            # a.png is registered and pending in the scan's transaction; the owner's alias changes while
            # b.png is hashed, and the hash reports progress (a heartbeat)
            with other.cursor() as cur:
                cur.execute(
                    "UPDATE people SET uni_alias = 'newalias' WHERE person_id = %s",
                    (pid,),
                )
            assert kw["progress"] is not None
            kw["progress"](1)
            beats.append(rel)
        return real_hash(share, rel, **kw)

    monkeypatch.setattr(hashing, "hash_file", slow_hash)
    try:
        stats = sc.scan()
    finally:
        other.close()
        store.close_heartbeat()
    assert beats, "the heartbeat must have fired during the hash"
    assert stats.errors >= 1 and "changed" in stats.last_error
    assert (
        cands(world) == {}
    )  # the pending registration was dropped by the guard, not committed
    s = world.one("SELECT last_heartbeat_at FROM inbox_crawler_state")
    assert s[0] is not None  # the heartbeat itself did land


def test_a_failing_heartbeat_does_not_roll_back_pending_registrations(
    world, monkeypatch, caplog
):
    pid, _ = world.person("abc12de")
    world.commit()
    monkeypatch.setattr(db, "HEARTBEAT_LOCK_TIMEOUT_MS", 150)
    store = db.Store(world.conn)
    register(store, person_owner(pid, "abc12de"), "Users/abc12de/a.png")
    blocker = other_session(world, autocommit=False)
    with (
        blocker.cursor() as cur
    ):  # the status row is locked: the heartbeat hits its lock timeout
        cur.execute("UPDATE inbox_crawler_state SET updated_at = now()")
    try:
        with caplog.at_level(logging.WARNING, logger="inbox_crawler.db"):
            store.heartbeat("x")  # fails, only logs
            store.heartbeat("y")  # a second failure is not logged again
    finally:
        blocker.rollback()
        blocker.close()
    assert [
        r.getMessage() for r in caplog.records if "heartbeat" in r.getMessage()
    ] == ["heartbeat not written (LockNotAvailable); the scan is not affected"]
    assert count_candidates(world.conn) == 1  # still pending in the scan's transaction
    store.commit()
    seen = other_session(world)
    try:
        assert count_candidates(seen) == 1  # and it commits
    finally:
        seen.close()
    store.heartbeat("recovered")  # a new connection is made on the next beat
    assert (
        world.one("SELECT current_activity FROM inbox_crawler_state")[0] == "recovered"
    )
    store.close_heartbeat()


# ---- S2: a restored file whose whole folder was deleted ---------------------------------------------


def _scenario(world):
    world.person("abc12de")
    world.write("Users/abc12de/sem/a.png", png((1, 1, 1)))
    world.write("Users/abc12de/sem/deep/b.png", png((2, 2, 2)))
    world.write("Users/abc12de/keep.png", png((3, 3, 3)))
    settle(world)
    run(world)


def _set_state(world, rel, state):
    world.q("UPDATE file_candidates SET state = %s WHERE rel_path = %s", (state, rel))
    world.commit()


@pytest.mark.parametrize(
    "rel", ["Users/abc12de/sem/a.png", "Users/abc12de/sem/deep/b.png"]
)
def test_a_restored_file_whose_whole_folder_was_deleted_goes_gone(world, rel):
    import shutil

    _scenario(world)
    _set_state(world, rel, "dismissed")
    shutil.rmtree(Path(world.root, "Users/abc12de/sem"))
    settle(world)
    run(world)
    assert cands(world)[rel][0] == "dismissed"  # untouched while dismissed
    assert (
        world.one(
            "SELECT count(*) FROM inbox_dirs WHERE rel_path LIKE 'Users/abc12de/sem%'"
        )[0]
        == 0
    )  # the cache rows of the folder are gone too
    _set_state(world, rel, "new")  # the person restores it
    stats, _, _ = run(world)
    assert cands(world)[rel][0] == "gone"
    assert stats.gone >= 1
    assert cands(world)["Users/abc12de/keep.png"][0] == "new"


def test_seeding_the_walk_with_new_candidates_folders_costs_no_extra_stat_normally(
    world,
):
    _scenario(world)
    settle(world)
    stats, spy, _ = run(world)
    assert stats.listed_dirs == 0 and stats.gone == 0
    for folder in ("Users/abc12de/sem", "Users/abc12de/sem/deep"):
        assert spy.stats.count(folder) == 1  # stat-ed once, never twice


# ---- S5: a file that is already a surface scan is not a found file ----------------------------------

SURFACE_SCANS_STUB = (
    "CREATE TABLE surface_scans (scan_id serial PRIMARY KEY, "
    "directus_files_id uuid NOT NULL REFERENCES directus_files (id) ON DELETE CASCADE)"
)


def add_as_surface_scan(world, rel):
    """What the Alicona feature's own dialog does: a surface_scans row for the file's pointer row."""
    from inbox_crawler.identity import file_id

    fid = str(file_id(rel))
    world.q(
        "INSERT INTO directus_files (id, storage, filename_download) VALUES (%s, 'star', %s) ON CONFLICT DO NOTHING",
        (fid, rel.rsplit("/", 1)[-1]),
    )
    world.q("INSERT INTO surface_scans (directus_files_id) VALUES (%s)", (fid,))
    world.commit()
    return fid


def test_a_file_that_is_already_a_surface_scan_gets_no_candidate(world):
    world.q(SURFACE_SCANS_STUB)
    world.person("abc12de")
    world.write("Users/abc12de/done.al3d", b"AL3D" * 100)
    world.write("Users/abc12de/free.al3d", b"AL3D" * 50)
    add_as_surface_scan(world, "Users/abc12de/done.al3d")
    settle(world)
    stats = run(world)[0]
    assert list(cands(world)) == ["Users/abc12de/free.al3d"]
    assert stats.registered == 1 and stats.errors == 0


def test_an_undecided_candidate_that_becomes_a_surface_scan_is_dropped_at_the_next_scan(
    world,
):
    world.q(SURFACE_SCANS_STUB)
    world.person("abc12de")
    world.write("Users/abc12de/a.al3d", b"AL3D" * 100)
    world.write("Users/abc12de/b.al3d", b"AL3D" * 50)
    settle(world)
    run(world)
    assert len(cands(world)) == 2
    add_as_surface_scan(world, "Users/abc12de/a.al3d")
    stats = run(world)[0]
    assert stats.listed_dirs == 0  # nothing in the folder changed
    assert list(cands(world)) == ["Users/abc12de/b.al3d"]


def test_a_gone_candidate_that_becomes_a_surface_scan_is_dropped_too_but_decided_ones_stay(
    world,
):
    world.q(SURFACE_SCANS_STUB)
    world.person("abc12de")
    for n in ("gone", "linked", "dismissed"):
        world.write(f"Users/abc12de/{n}.al3d", b"AL3D" + n.encode())
    settle(world)
    run(world)
    world.q(
        "UPDATE file_candidates SET state = 'linked', link_kind = 'manual', linked_collection = 'insert_edges', "
        "linked_junction_id = gen_random_uuid(), link_batch_id = gen_random_uuid() "
        "WHERE rel_path = 'Users/abc12de/linked.al3d'"
    )
    world.q(
        "UPDATE file_candidates SET state = 'dismissed' WHERE rel_path = 'Users/abc12de/dismissed.al3d'"
    )
    world.q(
        "UPDATE file_candidates SET state = 'gone' WHERE rel_path = 'Users/abc12de/gone.al3d'"
    )
    world.commit()
    for n in ("gone", "linked", "dismissed"):
        add_as_surface_scan(world, f"Users/abc12de/{n}.al3d")
    run(world)
    assert {k: v[0] for k, v in cands(world).items()} == {
        "Users/abc12de/linked.al3d": "linked",
        "Users/abc12de/dismissed.al3d": "dismissed",
    }


def test_without_the_surface_scans_table_both_checks_still_work(world):
    # an older database: no surface_scans table. The world's own schema has none until a test creates
    # one, but a CI database that ran migration 192 has the real table in public, so leave public out.
    world.q(f"SET search_path = {world.schema}")
    world.commit()
    assert world.one("SELECT to_regclass('surface_scans') IS NULL")[0]
    store = db.Store(world.conn)
    assert store.already_linked(["00000000-0000-0000-0000-0000000000aa"]) == set()
    pid, _ = world.person("abc12de")
    world.write("Users/abc12de/a.al3d", b"AL3D" * 100)
    settle(world)
    run(world)
    assert list(cands(world)) == ["Users/abc12de/a.al3d"]
    assert store.drop_linked_elsewhere(person_owner(pid, "abc12de")) == 0
    assert list(cands(world)) == ["Users/abc12de/a.al3d"]


# ---- NIT 4: a pile of linked documents with a bad path cannot starve the queue ---------------------


def add_bad_path_rows(world, pid, n):
    """n adopted, linked candidates (older than any real one) whose stored path is not their own: a
    document linked under an alias the person no longer has."""
    world.q(
        "INSERT INTO directus_files (id, storage, filename_download) "
        "SELECT ('b0000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'star', 'old' || g || '.pdf' "
        "FROM generate_series(1, %s) g",
        (n,),
    )
    world.q(
        "INSERT INTO file_candidates (directus_files_id, owner_person_id, kind, state, origin, rel_path, "
        " adopted_at, link_kind, linked_collection, linked_junction_id, link_batch_id) "
        "SELECT ('b0000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, %s, 'document', 'linked', "
        " 'new', 'Users/oldalias/old' || g || '.pdf', now() - interval '3 days' + g * interval '1 second', "
        " 'manual', 'physical_samples', gen_random_uuid(), gen_random_uuid() "
        "FROM generate_series(1, %s) g",
        (pid, n),
    )
    world.commit()


def test_many_bad_rows_ahead_of_one_good_one_do_not_starve_it(world):
    pid, _ = world.person("aaa11")
    add_bad_path_rows(
        world, pid, 150
    )  # more than the 5 pages of 10 x limit the old walk looked through
    cid, fid = add_candidate(
        world,
        pid,
        "Users/aaa11/d/mine.pdf",
        kind="document",
        state="linked",
        adopted=True,
    )
    store = db.Store(world.conn)
    assert store.adopted_awaiting_hash(limit=2) == [
        (cid, fid, "Users/aaa11/d/mine.pdf")
    ]
    # every bad row now has an error row with the reason, and is out of the queue
    got = world.q(
        "SELECT status, error_message, count(*) FROM file_fingerprints GROUP BY 1, 2"
    )
    assert got == [("error", db.BAD_PATH_ERROR, 150)]


def test_a_bad_row_is_retried_like_any_error_but_not_every_tick(world):
    pid, _ = world.person("aaa11")
    add_bad_path_rows(world, pid, 3)
    store = db.Store(world.conn)
    assert store.adopted_awaiting_hash() == []
    first = world.q(
        "SELECT directus_files_id, hashed_at FROM file_fingerprints ORDER BY 1"
    )
    assert len(first) == 3
    assert (
        store.adopted_awaiting_hash() == []
    )  # the next tick: nothing is written again
    assert (
        world.q("SELECT directus_files_id, hashed_at FROM file_fingerprints ORDER BY 1")
        == first
    )
    world.q("UPDATE file_fingerprints SET hashed_at = now() - interval '2 hours'")
    world.commit()
    assert (
        store.adopted_awaiting_hash() == []
    )  # an hour later: looked at again, still not its own
    assert (
        world.one(
            "SELECT count(*) FROM file_fingerprints WHERE hashed_at > now() - interval '1 hour'"
        )[0]
        == 3
    )


def test_a_bad_row_whose_path_is_fixed_is_read_after_its_retry(world):
    pid, _ = world.person("aaa11")
    cid, fid = add_candidate(
        world,
        pid,
        "Users/aaa11/mine.pdf",
        kind="document",
        state="linked",
        adopted=True,
    )
    world.q(
        "UPDATE file_candidates SET rel_path = 'Users/old/mine.pdf' WHERE candidate_id = %s",
        (cid,),
    )
    world.commit()
    store = db.Store(world.conn)
    assert store.adopted_awaiting_hash() == []
    world.q(
        "UPDATE file_candidates SET rel_path = 'Users/aaa11/mine.pdf' WHERE candidate_id = %s",
        (cid,),
    )
    world.q("UPDATE file_fingerprints SET hashed_at = now() - interval '2 hours'")
    world.commit()
    assert store.adopted_awaiting_hash() == [(cid, fid, "Users/aaa11/mine.pdf")]
