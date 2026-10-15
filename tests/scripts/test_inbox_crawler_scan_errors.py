# ruff: noqa: F811
"""Review fixes: one bad owner folder does not stop everyone (item 3); the baseline and permanent errors (item 4)."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

pytest.importorskip("psycopg2")
from test_inbox_crawler_scan import (  # noqa: E402, F401
    baselined,
    cands,
    make,
    png,
    run,
    settle,
)
from test_inbox_crawler_world import world  # noqa: E402, F401

# ---- item 3: one unreadable personal folder does not stop everyone else ------------------------------


def two_owners(world):
    world.person("aaa11")
    world.person("bbb22")
    world.write("Users/aaa11/a.png", png((1, 1, 1)))
    world.write("Users/bbb22/b.png", png((2, 2, 2)))
    world.commit()
    settle(world)


@pytest.mark.parametrize(
    "kind,exc",
    [
        ("stat", PermissionError(13, "denied")),
        ("stat", FileNotFoundError(2, "gone")),
        ("stat", OSError(5, "I/O error")),
        ("scandir", PermissionError(13, "denied")),
    ],
    ids=["stat-denied", "stat-missing", "stat-io", "list-denied"],
)
def test_an_unreadable_owner_folder_is_recorded_and_the_next_owner_is_scanned(
    world, kind, exc
):
    two_owners(world)
    sc, spy, _ = make(world)
    spy.fail[(kind, "Users/aaa11")] = exc
    stats = sc.scan()
    assert not stats.aborted
    assert stats.errors >= 1 and "aaa11" in stats.last_error
    assert list(cands(world)) == ["Users/bbb22/b.png"]


def test_an_owner_folder_that_goes_missing_loses_nothing_while_the_share_is_fine(world):
    two_owners(world)
    run(world)
    settle(world)
    sc, spy, _ = make(world)
    spy.fail[("stat", "Users/aaa11")] = FileNotFoundError(2, "gone")
    stats = sc.scan()
    assert not stats.aborted
    assert {v[0] for v in cands(world).values()} == {"new"}  # nothing marked gone


def test_the_share_itself_going_still_aborts_everything(world):
    two_owners(world)
    sc, spy, _ = make(world)
    spy.vanish_after = 3
    assert sc.scan().aborted
