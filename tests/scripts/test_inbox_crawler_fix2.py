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
