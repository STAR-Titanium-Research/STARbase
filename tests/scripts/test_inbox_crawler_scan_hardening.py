# ruff: noqa: F811
"""Review fixes for the scan loop: links, lost gone decisions, one bad folder, baseline vs permanent errors."""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

pytest.importorskip("psycopg2")
from inbox_crawler import fs_readonly, scan  # noqa: E402
from test_inbox_crawler_scan import (  # noqa: E402, F401
    OLD,
    SpyShare,
    baselined,
    cands,
    make,
    one_person,
    png,
    run,
    settle,
)
from test_inbox_crawler_world import world  # noqa: E402, F401

# ---- item 1: a link, FIFO or directory swapped in is not a found file and is never opened ----------


def test_a_file_replaced_by_a_link_between_listing_and_stat_is_not_registered(
    one_person,
):
    world, _, _ = one_person
    sc, spy, _ = make(world)
    real = spy.stat

    def swapped(rel=""):
        st = real(rel)
        if rel.endswith("a.png"):
            return fs_readonly.Stat(
                st.size, st.mtime_ns, False, False
            )  # what lstat says of a link
        return st

    spy.stat = swapped
    stats = sc.scan()
    assert "Users/abc12de/sem/a.png" not in cands(world)
    assert "Users/abc12de/sem/a.png" not in spy.opens
    assert stats.errors == 0


def test_fingerprint_file_refuses_a_non_regular_file_before_opening(one_person):
    world, _, _ = one_person
    spy = SpyShare(fs_readonly.Share(world.root))
    real = spy.stat
    spy.stat = lambda rel="": fs_readonly.Stat(0, 0, False, False)
    out, st, mtime = scan.fingerprint_file(
        spy, "Users/abc12de/notes.pdf", None, adopted=True
    )
    assert out.status == "error" and "regular" in out.error
    assert spy.opens == [] and st is None and mtime is None
    assert real  # (kept so the spy is a plain wrapper)


@pytest.mark.skipif(not hasattr(os, "symlink"), reason="needs symbolic links")
def test_a_real_link_in_a_folder_is_neither_registered_nor_read(world):
    world.person("abc12de")
    world.write("Users/abc12de/real.png", png())
    os.symlink(
        Path(world.root, "Users/abc12de/real.png"),
        Path(world.root, "Users/abc12de/photo.tif"),
    )
    settle(world)
    stats, spy, _ = run(world)
    assert list(cands(world)) == ["Users/abc12de/real.png"]
    assert spy.opens == ["Users/abc12de/real.png"]
    assert stats.errors == 0


# ---- item 2: a 'gone' decision is never lost to an abort or a stop -----------------------------------


def seeded(world):
    world.person("abc12de")
    for i in range(4):
        world.write(f"Users/abc12de/d{i}/f.png", png((i, i, i)))
    settle(world)
    run(world)
    settle(world)


def touch(world, rel):
    t = (
        OLD + 10
    )  # a changed, but not recent, mtime: the folder is cacheable, which is what hid the loss
    os.utime(Path(world.root, rel), (t, t))


@pytest.mark.parametrize("after", range(0, 46))
def test_gone_is_found_by_a_later_scan_wherever_an_earlier_one_stopped(world, after):
    seeded(world)
    os.unlink(Path(world.root, "Users/abc12de/d1/f.png"))
    touch(world, "Users/abc12de/d1")
    sc, spy, _ = make(world)
    spy.vanish_after = after
    first = sc.scan()
    sc2, spy2, _ = make(world)
    second = sc2.scan()
    assert first.gone + second.gone == 1
    got = cands(world)
    assert got["Users/abc12de/d1/f.png"][0] == "gone"
    assert [k for k, v in got.items() if v[0] == "gone"] == ["Users/abc12de/d1/f.png"]


def test_a_vanished_folder_is_found_by_a_later_scan_after_an_abort(world):
    seeded(world)
    import shutil

    shutil.rmtree(Path(world.root, "Users/abc12de/d2"))
    touch(world, "Users/abc12de")
    for after in (3, 4, 5):
        sc, spy, _ = make(world)
        spy.vanish_after = after
        sc.scan()
    run(world)
    assert cands(world)["Users/abc12de/d2/f.png"][0] == "gone"


def test_a_stop_after_a_folder_was_listed_loses_no_gone(world):
    seeded(world)
    os.unlink(Path(world.root, "Users/abc12de/d1/f.png"))
    touch(world, "Users/abc12de/d1")
    box = {}
    sc, spy, _ = make(world, stop=lambda: "Users/abc12de/d1" in box["spy"].scandirs)
    box["spy"] = spy
    first = sc.scan()
    assert first.interrupted
    second = run(world)[0]
    assert first.gone + second.gone == 1
    assert cands(world)["Users/abc12de/d1/f.png"][0] == "gone"


@pytest.mark.parametrize("after", range(0, 46))
def test_a_moved_file_is_never_left_as_a_ghost_and_a_copy(world, after):
    seeded(world)
    os.rename(
        Path(world.root, "Users/abc12de/d0/f.png"),
        Path(world.root, "Users/abc12de/d3/moved.png"),
    )
    touch(world, "Users/abc12de/d0")
    touch(world, "Users/abc12de/d3")
    sc, spy, _ = make(world)
    spy.vanish_after = after
    sc.scan()
    run(world)
    got = cands(world)
    assert "Users/abc12de/d0/f.png" not in got
    assert got["Users/abc12de/d3/moved.png"][0] == "new"
    assert (
        world.one("SELECT count(*) FROM file_candidates WHERE state = 'gone'")[0] == 0
    )
    assert len(got) == 4
