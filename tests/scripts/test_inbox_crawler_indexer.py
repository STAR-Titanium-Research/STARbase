# ruff: noqa: F811
"""The inbox crawler and scripts/index_archive.py share `directus_files` pointer rows (review item 8).

* the crawler writes metadata.extension the way the indexer does, so the indexer's missing sweep can tell
  which rows it walks;
* a file the indexer moved (it re-points every reference, the candidate included) is not then marked gone by
  the crawler: the candidate's rel_path is re-synced from the pointer row first.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path, PurePosixPath

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

pytest.importorskip("psycopg2")
import index_archive as ia  # noqa: E402
from inbox_crawler import db  # noqa: E402, F401
from test_inbox_crawler_scan import (  # noqa: E402, F401
    OLD,
    cands,
    png,
    run,
    settle,
)
from test_inbox_crawler_world import world  # noqa: E402, F401


def run_indexer(world, monkeypatch, *args):
    world.commit()
    monkeypatch.setenv("PGOPTIONS", f"-c search_path={world.schema}")
    monkeypatch.setenv("DATABASE_URL", world.dsn)
    monkeypatch.setattr(sys, "argv", ["index_archive.py", "--root", world.root, *args])
    assert ia.main() == 0
    world.conn.rollback()  # see what the indexer committed


NAMES = [
    "a.TIF",
    "b.tar.GZ",
    ".hidden",
    "noext",
    "x.al3d",
    "y.AL3D",
    "z.Pdf",
    "dots.in.name.PNG",
    "end.",
]


@pytest.mark.parametrize("name", NAMES)
def test_the_crawler_writes_the_extension_the_indexer_writes(world, name):
    pid, _ = world.person("abc12de")
    owner = __import__("inbox_crawler.owners", fromlist=["Owner"]).Owner(
        "person", pid, "Users/abc12de", "abc12de"
    )
    from inbox_crawler import kinds, recognise

    store = db.Store(world.conn)
    store.register_file(
        owner=owner,
        rel=f"Users/abc12de/{name}",
        size=1,
        mtime=db.to_datetime(1_700_000_000_000_000_000),
        classification=kinds.Classification("other"),
        recognition=recognise.NO_MATCH,
        origin="new",
        hashed=None,
    )
    got = world.one("SELECT metadata::jsonb->>'extension' FROM directus_files")[0]
    assert got == PurePosixPath(name).suffix.lower()
    # and it is lower-cased with its dot, so ALLOWED_EXT membership means the same on both sides
    assert got == got.lower() and (got == "" or got.startswith("."))


def test_a_crawler_registered_scan_and_text_file_survive_the_indexers_sweep(
    world, monkeypatch
):
    world.person("abc12de")
    world.write("Users/abc12de/cuts/scan1.al3d", b"AL3D" * 10)
    world.write("Users/abc12de/readme.txt", b"hello")
    world.write("Users/abc12de/pic.png", png())
    world.write("Users/abc12de/old.mat", b"x" * 20)
    settle(world)
    run(world)
    os.unlink(
        Path(world.root, "Users/abc12de/old.mat")
    )  # an indexed type that vanishes
    os.unlink(
        Path(world.root, "Users/abc12de/readme.txt")
    )  # a crawler-only type that vanishes
    run_indexer(world, monkeypatch)
    flagged = [
        r[0]
        for r in world.q(
            "SELECT filename_download FROM directus_files WHERE (metadata::jsonb->>'missing') = 'true' ORDER BY 1"
        )
    ]
    assert flagged == ["old.mat"]


def test_a_move_by_the_indexer_is_not_taken_for_a_vanished_file_by_the_crawler(
    world, monkeypatch
):
    world.person("abc12de")
    world.write("Users/abc12de/d0/f.png", png((9, 9, 9)))
    world.write("Users/abc12de/d1/keep.png", png((8, 8, 8)))
    settle(world)
    run(world)
    run_indexer(
        world, monkeypatch, "--fingerprint"
    )  # the indexer's own light fingerprints
    settle(world)
    before = world.one(
        "SELECT candidate_id::text, directus_files_id::text FROM file_candidates WHERE rel_path = 'Users/abc12de/d0/f.png'"
    )
    new = Path(world.root, "Users/abc12de/e0/f.png")
    new.parent.mkdir()
    os.rename(Path(world.root, "Users/abc12de/d0/f.png"), new)
    settle(world)
    run_indexer(
        world, monkeypatch, "--fingerprint"
    )  # re-points references, candidate included
    after_indexer = world.one(
        "SELECT directus_files_id::text, rel_path FROM file_candidates WHERE candidate_id = %s",
        (before[0],),
    )
    assert after_indexer[0] != before[1]  # the indexer moved the pointer ...
    assert (
        after_indexer[1] == "Users/abc12de/d0/f.png"
    )  # ... and left the candidate's path stale
    world.commit()
    os.utime(Path(world.root, "Users/abc12de/d0"), (OLD + 10, OLD + 10))
    os.utime(Path(world.root, "Users/abc12de/e0"), (OLD + 10, OLD + 10))
    stats, _, _ = run(world)
    assert stats.gone == 0 and stats.errors == 0
    got = cands(world)
    assert got["Users/abc12de/e0/f.png"][0] == "new"
    assert "Users/abc12de/d0/f.png" not in got
    assert (
        world.one("SELECT count(*) FROM file_candidates WHERE state = 'gone'")[0] == 0
    )
    assert (
        world.one(
            "SELECT candidate_id::text FROM file_candidates WHERE rel_path = 'Users/abc12de/e0/f.png'"
        )[0]
        == before[0]
    )


def test_resync_only_touches_the_owners_own_candidates_under_the_owners_folder(world):
    pa, _ = world.person("aaa11")
    pb, _ = world.person("bbb22")
    from inbox_crawler import kinds, recognise
    from inbox_crawler.owners import Owner

    store = db.Store(world.conn)
    oa, ob = (
        Owner("person", pa, "Users/aaa11", "aaa11"),
        Owner("person", pb, "Users/bbb22", "bbb22"),
    )
    for o, rel in ((oa, "Users/aaa11/a.png"), (ob, "Users/bbb22/b.png")):
        store.register_file(
            owner=o,
            rel=rel,
            size=1,
            mtime=db.to_datetime(1_700_000_000_000_000_000),
            classification=kinds.Classification("image"),
            recognition=recognise.NO_MATCH,
            origin="new",
            hashed=None,
        )
    # both pointer rows now say a different path than their candidates
    world.q("UPDATE file_candidates SET rel_path = 'stale/' || rel_path")
    store.resync_paths(oa)
    rows = dict(world.q("SELECT owner_person_id::text, rel_path FROM file_candidates"))
    assert rows[pa] == "Users/aaa11/a.png"  # fixed
    assert (
        rows[pb] == "stale/Users/bbb22/b.png"
    )  # another owner's: left for its own scan
