# ruff: noqa: F811
"""Review item 9: owner filters that use the owner indexes, and commits inside a big folder."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

pytest.importorskip("psycopg2")
from inbox_crawler import db, scan  # noqa: E402
from inbox_crawler.owners import Owner  # noqa: E402
from test_inbox_crawler_scan import cands, make, png, run, settle  # noqa: E402, F401
from test_inbox_crawler_world import world  # noqa: E402, F401


class Recorder:
    """Wraps a cursor-producing connection so every SQL string the Store sends is kept."""

    def __init__(self, store):
        self.sql: list[str] = []
        real_all, real_run, real_one = store._all, store._run, store._one

        def all_(q, p=()):
            self.sql.append(q)
            return real_all(q, p)

        def run_(q, p=()):
            self.sql.append(q)
            return real_run(q, p)

        def one_(q, p=()):
            self.sql.append(q)
            return real_one(q, p)

        store._all, store._run, store._one = all_, run_, one_


def test_no_owner_filter_uses_is_not_distinct_from(world):
    world.person("abc12de")
    world.team("Machining")
    world.write("Users/abc12de/a.png", png())
    world.write("Shared/Machining/b.png", png((1, 2, 3)))
    settle(world)
    sc, spy, store = make(world)
    rec = Recorder(store)
    sc.scan()
    assert rec.sql
    assert not [q for q in rec.sql if "DISTINCT FROM" in q.upper()]


def owners_for(world):
    pid, _ = world.person("abc12de")
    tid = world.team("Machining")
    return Owner("person", pid, "Users/abc12de", "abc12de"), Owner(
        "team", tid, "Shared/Machining", "Machining"
    )


def explain(world, query, params):
    world.q("SET enable_seqscan = off")
    try:
        plan = "\n".join(r[0] for r in world.q("EXPLAIN " + query, params))
    finally:
        world.q("SET enable_seqscan = on")
    return plan


@pytest.mark.parametrize("which", [0, 1], ids=["person", "team"])
def test_the_owner_queries_can_use_the_owner_indexes(world, which):
    owner = owners_for(world)[which]
    store = db.Store(world.conn)
    rec = Recorder(store)
    store.load_dirs(owner)
    store.load_candidates(owner)
    store.copies_of(
        db.Cand("00000000-0000-0000-0000-000000000001", "x", "p", "new", "image"), owner
    )
    store.forget_dirs_under(owner, [owner.root + "/x"])
    store.resync_paths(owner)
    owner_queries = [q for q in rec.sql if "owner_" in q]
    assert len(owner_queries) >= 5
    assert not [q for q in owner_queries if "DISTINCT FROM" in q.upper()]
    # the two reads, explained with sequential scans disabled, name the owner index
    col = "owner_person_id" if which == 0 else "owner_team_id"
    plan = explain(
        world,
        f"SELECT rel_path, candidate_id::text FROM file_candidates WHERE {col} = %s",
        (owner.id,),
    )
    assert "idx_file_candidates_owner" in plan
    plan = explain(
        world, f"SELECT rel_path FROM inbox_dirs WHERE {col} = %s", (owner.id,)
    )
    assert "idx_inbox_dirs_owner" in plan


def test_the_real_queries_are_the_ones_explained(world):
    """The store's own SQL carries the same simple equality, not something the planner cannot index."""
    owner = owners_for(world)[0]
    store = db.Store(world.conn)
    rec = Recorder(store)
    store.load_candidates(owner)
    store.load_dirs(owner)
    for q in rec.sql:
        assert "owner_person_id = %s" in q
        assert "owner_team_id" not in q  # one branch per owner kind


# ---- commits inside a big folder -----------------------------------------------------------------


def test_a_big_folder_commits_every_batch_and_a_kill_keeps_the_batches(
    world, monkeypatch
):
    monkeypatch.setattr(scan, "COMMIT_EVERY", 10)
    world.person("abc12de")
    for i in range(35):
        world.write(f"Users/abc12de/big/f{i:03d}.png", png((i, i, i)))
    world.commit()
    settle(world)

    class Killed(BaseException):
        pass

    sc, spy, store = make(world)
    commits = []
    real_commit = store.commit
    store.commit = lambda: (commits.append(len(spy.opens)), real_commit())[1]
    real_open = spy.open_rb

    def dying(rel, adopted=False):
        if len(spy.opens) >= 24:
            raise Killed()
        return real_open(rel, adopted)

    spy.open_rb = dying
    with pytest.raises(Killed):
        sc.scan()
    world.conn.rollback()
    kept = [k for k in cands(world) if k.startswith("Users/abc12de/big/")]
    assert 20 <= len(kept) <= 23  # two whole batches of ten survived the kill
    assert any(
        10 <= c <= 21 for c in commits
    )  # committed inside the folder, not only at its end
    # the folder itself was not marked done, so a rerun lists it again and finishes the job
    stats, _, _ = run(world)
    assert stats.registered == 35 - len(kept) and stats.errors == 0
    got = cands(world)
    assert len([k for k in got if k.startswith("Users/abc12de/big/")]) == 35
    assert {v[1] for v in got.values()} == {"backlog"}  # still the owner's first scan
    assert world.one("SELECT count(*) FROM directus_files")[0] == 35


def test_the_folder_row_is_still_written_last(world, monkeypatch):
    monkeypatch.setattr(scan, "COMMIT_EVERY", 5)
    world.person("abc12de")
    for i in range(12):
        world.write(f"Users/abc12de/big/f{i:02d}.png", png((i, i, i)))
    world.commit()
    settle(world)
    sc, spy, store = make(world)
    seen = []
    real_commit = store.commit

    def watching():
        row = world.one(
            "SELECT last_listed_at IS NOT NULL FROM inbox_dirs WHERE rel_path = 'Users/abc12de/big'"
        )
        seen.append(row[0] if row else None)
        real_commit()

    store.commit = watching
    sc.scan()
    # while the folder was being worked on its row was not yet "listed"; at the end it is
    assert False in seen or None in seen
    assert world.one(
        "SELECT last_listed_at IS NOT NULL FROM inbox_dirs WHERE rel_path = 'Users/abc12de/big'"
    )[0]
