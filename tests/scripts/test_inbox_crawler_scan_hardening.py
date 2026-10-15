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
