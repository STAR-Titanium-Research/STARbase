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


# ---- item 4: permanent errors do not block the baseline, temporary ones do ---------------------------


def tree(world):
    world.person("abc12de")
    world.write("Users/abc12de/ok.png", png((1, 1, 1)))
    world.write("Users/abc12de/locked/x.png", png((2, 2, 2)))
    world.commit()
    settle(world)


def test_a_folder_one_may_not_read_does_not_stop_the_baseline(world):
    import errno

    tree(world)
    sc, spy, _ = make(world)
    spy.fail[("scandir", "Users/abc12de/locked")] = PermissionError(
        errno.EACCES, "denied"
    )
    stats = sc.scan()
    assert stats.errors == 1 and stats.temporary_errors == 0
    assert baselined(world, "Users/abc12de") == (True,)
    assert cands(world)["Users/abc12de/ok.png"][1] == "backlog"
    # when the folder becomes readable its files are found, as new (it was not part of the baseline)
    spy.fail.clear()
    sc.scan()
    assert cands(world)["Users/abc12de/locked/x.png"][1] == "new"


def test_a_file_that_may_not_be_statted_is_permanent_too(world):
    import errno

    tree(world)
    sc, spy, _ = make(world)
    spy.fail[("stat", "Users/abc12de/locked/x.png")] = PermissionError(
        errno.EACCES, "denied"
    )
    sc.scan()
    assert baselined(world, "Users/abc12de") == (True,)


def test_a_name_that_fails_to_register_is_permanent(world, monkeypatch):
    tree(world)
    sc, spy, store = make(world)
    real = store.register_file

    def flaky(**kw):
        if kw["rel"].endswith("x.png"):
            raise ValueError("bad value")
        return real(**kw)

    monkeypatch.setattr(store, "register_file", flaky)
    stats = sc.scan()
    assert stats.errors == 1 and stats.temporary_errors == 0
    assert baselined(world, "Users/abc12de") == (True,)


def test_a_folder_nested_too_deep_is_permanent(world, monkeypatch):
    from inbox_crawler import scan

    tree(world)
    monkeypatch.setattr(scan, "MAX_DEPTH", 0)
    sc, spy, _ = make(world)
    stats = sc.scan()
    assert stats.errors >= 1 and stats.temporary_errors == 0
    assert baselined(world, "Users/abc12de") == (True,)


@pytest.mark.parametrize("where", ["scandir", "stat"])
def test_an_io_error_is_temporary_and_blocks_the_baseline(world, where):
    import errno

    tree(world)
    sc, spy, _ = make(world)
    spy.fail[(where, "Users/abc12de/locked")] = OSError(errno.EIO, "I/O error")
    stats = sc.scan()
    assert stats.temporary_errors >= 1
    assert baselined(world, "Users/abc12de") in (None, (False,))
    spy.fail.clear()
    sc.scan()
    assert baselined(world, "Users/abc12de") == (True,)
    assert (
        cands(world)["Users/abc12de/locked/x.png"][1] == "backlog"
    )  # a clean first scan: all backlog


def test_a_file_that_vanishes_while_it_is_read_is_temporary(world):
    tree(world)
    sc, spy, _ = make(world)
    spy.fail[("open", "Users/abc12de/ok.png")] = FileNotFoundError(2, "gone")
    stats = sc.scan()
    assert stats.temporary_errors == 1
    assert baselined(world, "Users/abc12de") in (None, (False,))


def test_images_that_cannot_be_decoded_are_registered_as_plain_images(world, caplog):
    import logging
    import struct
    import zlib

    world.person("abc12de")

    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    bomb = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", 40000, 40000, 8, 0, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(b"\x00"))
        + chunk(b"IEND", b"")
    )
    world.write("Users/abc12de/bomb.png", bomb)
    world.write("Users/abc12de/not_a_tiff.tif", b"this is not an image")
    world.write("Users/abc12de/fine.png", png())
    world.commit()
    settle(world)
    with caplog.at_level(logging.INFO):
        stats = run(world)[0]
    assert stats.errors == 0 and stats.registered == 3
    got = cands(world)
    assert {k: v[2] for k, v in got.items()} == {
        "Users/abc12de/bomb.png": "image",
        "Users/abc12de/not_a_tiff.tif": "image",
        "Users/abc12de/fine.png": "image",
    }
    assert "plain image" in caplog.text
    assert baselined(world, "Users/abc12de") == (True,)


def test_an_unlisted_root_never_baselines_even_with_only_permanent_errors(world):
    import errno

    tree(world)
    sc, spy, _ = make(world)
    spy.fail[("scandir", "Users/abc12de")] = PermissionError(errno.EACCES, "denied")
    sc.scan()
    assert baselined(world, "Users/abc12de") in (None, (False,))
