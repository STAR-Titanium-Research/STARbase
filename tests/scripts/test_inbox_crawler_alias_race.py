# ruff: noqa: F811
"""Review item 10: an alias or share folder that changes while (or after) a scan ran.

Another session changing `people.uni_alias` / `teams.share_folder` removes the old owner's rows (migration
triggers) but cannot stop a scan already under way, and the old folder may go to someone else. So everything
the crawler keeps for a folder is tied to its owner as well as its path, and an owner's work is committed only
while the owner's claim on the folder is unchanged.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

pytest.importorskip("psycopg2")
import psycopg2  # noqa: E402
from inbox_crawler import db, kinds, owners, recognise  # noqa: E402
from inbox_crawler.owners import Owner  # noqa: E402
from test_inbox_crawler_scan import (  # noqa: E402, F401
    baselined,
    cands,
    make,
    png,
    run,
    settle,
)
from test_inbox_crawler_world import world  # noqa: E402, F401

T0 = db.to_datetime(1_700_000_000_000_000_000)


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


def other_session(world):
    conn = psycopg2.connect(world.dsn)
    conn.autocommit = True
    with conn.cursor() as cur:
        cur.execute(f"SET search_path = {world.schema}, public")
    return conn


# ---- the owner is part of a directory row's identity ---------------------------------------------


def test_a_folder_given_to_someone_else_is_not_already_baselined(world):
    a, _ = world.person("aaa11")
    b, _ = world.person("bbb22")
    store = db.Store(world.conn)
    oa = person_owner(a, "xx")
    ob = person_owner(b, "xx")  # B now has the alias that A had: the same folder
    store.upsert_dir(oa, "Users/xx", T0, listed=True)
    store.mark_baselined(oa)
    assert store.owner_baselined(oa)
    assert not store.owner_baselined(ob)


def test_mark_baselined_touches_only_the_owners_own_row(world):
    a, _ = world.person("aaa11")
    b, _ = world.person("bbb22")
    store = db.Store(world.conn)
    oa, ob = person_owner(a, "xx"), person_owner(b, "xx")
    store.upsert_dir(oa, "Users/xx", T0, listed=True)
    store.mark_baselined(ob)
    assert not store.owner_baselined(oa)
    store.mark_baselined(oa)
    assert store.owner_baselined(oa)


def test_upsert_dir_refuses_to_take_over_another_owners_row(world):
    a, _ = world.person("aaa11")
    b, _ = world.person("bbb22")
    store = db.Store(world.conn)
    oa, ob = person_owner(a, "xx"), person_owner(b, "xx")
    assert store.upsert_dir(oa, "Users/xx/sub", T0, listed=True) is True
    assert store.upsert_dir(ob, "Users/xx/sub", T0, listed=True) is False
    row = world.one(
        "SELECT owner_person_id::text FROM inbox_dirs WHERE rel_path = 'Users/xx/sub'"
    )
    assert row[0] == a
    assert (
        store.upsert_dir(oa, "Users/xx/sub", T0, listed=True) is True
    )  # its own: fine


def test_load_and_forget_are_scoped_to_the_owner(world):
    a, _ = world.person("aaa11")
    b, _ = world.person("bbb22")
    store = db.Store(world.conn)
    oa, ob = person_owner(a, "xx"), person_owner(b, "xx")
    store.upsert_dir(oa, "Users/xx", T0, listed=True)
    assert store.load_dirs(ob) == {}
    store.forget_dirs_under(ob, ["Users/xx"])
    assert "Users/xx" in store.load_dirs(oa)


# ---- the next owner of a folder starts clean ------------------------------------------------------


def test_a_folder_handed_to_a_new_person_is_scanned_as_a_first_scan_for_them(world):
    a, _ = world.person("aaa11")
    world.write("Users/aaa11/a.png", png((1, 1, 1)))
    settle(world)
    world.commit()
    run(world)
    assert baselined(world, "Users/aaa11") == (True,)
    # A's rows are what an in-flight scan left behind after A's alias moved on (no cascade ran for them)
    world.q("UPDATE people SET uni_alias = 'gone1' WHERE person_id = %s", (a,))
    b, _ = world.person("aaa11")  # the folder now belongs to B
    world.write("Users/aaa11/b_new.png", png((2, 2, 2)))
    settle(world)
    world.commit()
    run(world)
    got = {
        r[0]: r[1:]
        for r in world.q(
            "SELECT rel_path, owner_person_id::text, origin FROM file_candidates"
        )
    }
    assert (
        "Users/aaa11/a.png" not in got
    )  # A's stale candidate does not block or leak (C1): B gets no candidate for A's file
    assert got["Users/aaa11/b_new.png"] == (
        b,
        "backlog",
    )  # a first scan for B: nothing counts as new
    assert (
        world.one(
            "SELECT count(*) FROM file_candidates WHERE owner_person_id = %s", (a,)
        )[0]
        == 0
    )
    assert (
        world.one(
            "SELECT owner_person_id::text FROM inbox_dirs WHERE rel_path = 'Users/aaa11'"
        )[0]
        == b
    )


def test_linked_files_of_the_old_owner_are_left_alone(world):
    a, _ = world.person("aaa11")
    world.write("Users/aaa11/a.png", png((1, 1, 1)))
    settle(world)
    world.commit()
    run(world)
    world.q(
        "UPDATE file_candidates SET state = 'linked', link_kind = 'manual', linked_collection = 'physical_samples', "
        "linked_junction_id = gen_random_uuid(), link_batch_id = gen_random_uuid()"
    )
    world.q("UPDATE people SET uni_alias = 'gone1' WHERE person_id = %s", (a,))
    world.person("aaa11")
    world.commit()
    run(world)
    assert world.one("SELECT owner_person_id::text, state FROM file_candidates")[0] == a


# ---- the claim is re-checked before work is committed ---------------------------------------------


def seeded(world, n=3):
    pid, _ = world.person("abc12de")
    for i in range(n):
        world.write(f"Users/abc12de/d{i}/f.png", png((i, i, i)))
    world.commit()
    settle(world)
    return pid


def test_an_alias_that_changes_mid_scan_discards_the_unfinished_work(world):
    pid = seeded(world)
    sc, spy, _ = make(world)
    other = other_session(world)
    real = spy.scandir

    def changing(rel=""):
        if rel == "Users/abc12de/d1":
            with other.cursor() as cur:
                cur.execute(
                    "UPDATE people SET uni_alias = 'newalias' WHERE person_id = %s",
                    (pid,),
                )
        return real(rel)

    spy.scandir = changing
    stats = sc.scan()
    other.close()
    assert stats.errors >= 1 and "changed" in stats.last_error
    assert not stats.aborted
    got = list(cands(world))
    assert "Users/abc12de/d1/f.png" not in got and "Users/abc12de/d2/f.png" not in got
    assert baselined(world, "Users/abc12de") in (None, (False,))


def test_an_alias_that_changes_during_the_last_folder_discards_gone_and_baseline(world):
    pid = seeded(world)
    run(world)  # baselined, all registered
    settle(world)
    import os

    os.unlink(Path(world.root, "Users/abc12de/d2/f.png"))
    os.utime(Path(world.root, "Users/abc12de/d2"), (1_600_000_010, 1_600_000_010))
    sc, spy, _ = make(world)
    other = other_session(world)
    real = spy.scandir

    def changing(rel=""):
        if rel == "Users/abc12de/d2":
            with other.cursor() as cur:
                cur.execute(
                    "UPDATE people SET uni_alias = 'newalias' WHERE person_id = %s",
                    (pid,),
                )
        return real(rel)

    spy.scandir = changing
    sc.scan()
    other.close()
    assert (
        world.one("SELECT count(*) FROM file_candidates WHERE state = 'gone'")[0] == 0
    )


def test_a_share_folder_that_changes_mid_scan_is_noticed_for_a_team_too(world):
    tid = world.team("Machining")
    for i in range(3):
        world.write(f"Shared/Machining/d{i}/f.png", png((i, i, i)))
    world.commit()
    settle(world)
    sc, spy, _ = make(world)
    other = other_session(world)
    real = spy.scandir

    def changing(rel=""):
        if rel == "Shared/Machining/d1":
            with other.cursor() as cur:
                cur.execute(
                    "UPDATE teams SET share_folder = 'Elsewhere' WHERE team_id = %s",
                    (tid,),
                )
        return real(rel)

    spy.scandir = changing
    stats = sc.scan()
    other.close()
    assert stats.errors >= 1 and "changed" in stats.last_error
    assert "Shared/Machining/d2/f.png" not in cands(world)


def test_an_unchanged_claim_costs_nothing_and_commits_as_before(world):
    seeded(world)
    stats, _, _ = run(world)
    assert stats.errors == 0 and stats.registered == 3
    assert baselined(world, "Users/abc12de") == (True,)


def test_the_claim_check_holds_a_share_lock_until_the_commit(world):
    pid = seeded(world)
    store = db.Store(world.conn)
    o = person_owner(pid, "abc12de")
    assert store.owner_claim_unchanged(o)
    other = other_session(world)
    other.autocommit = False
    with other.cursor() as cur:
        cur.execute("SET lock_timeout = '300ms'")
        with pytest.raises(psycopg2.errors.LockNotAvailable):
            cur.execute(
                "UPDATE people SET uni_alias = 'zzz99' WHERE person_id = %s", (pid,)
            )
    other.rollback()
    other.close()
    store.commit()  # the lock is released with the commit
    assert not store.owner_claim_unchanged(person_owner(pid, "different"))
    assert not store.owner_claim_unchanged(
        person_owner("00000000-0000-0000-0000-000000000009", "x")
    )


def test_match_folders_remembers_the_claim():
    m = owners.match_folders(
        "Users", ["ABC12de"], [("p1", "abc12de", "abc12de", True)], "person"
    )
    assert m.owners[0].claim == "abc12de"
    assert m.owners[0].root == "Users/ABC12de"
