# ruff: noqa: F811
"""Owners and the scan loop (plan C5): incremental walk, baseline, copies, moves, gone, share drops.

Postgres-backed (a throwaway schema, see test_inbox_crawler_world.py); the share is a directory under tmp_path.
Faults are injected through a spy around `fs_readonly.Share`, never with chmod on test data.
"""

from __future__ import annotations

import errno
import io
import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

from inbox_crawler import fs_readonly, hashing, owners  # noqa: E402

pytest.importorskip("psycopg2")
from inbox_crawler import db, scan  # noqa: E402
from test_inbox_crawler_world import world  # noqa: E402, F401

# ---- owners (pure) -------------------------------------------------------------------------


def claims(*items):
    return [(i, f, f, s) for i, f, s in items]


def test_a_folder_matches_an_alias_whatever_the_case():
    m = owners.match_folders(
        "Users", ["ABC12de", "zz9"], claims(("p1", "abc12de", True)), "person"
    )
    assert [(o.id, o.root) for o in m.owners] == [
        ("p1", "Users/ABC12de")
    ]  # spelled as the share has it
    assert m.unmatched == ["Users/zz9"]


def test_a_former_persons_folder_is_neither_scanned_nor_unmatched():
    m = owners.match_folders(
        "Users",
        ["old1", "new1"],
        claims(("p1", "old1", False), ("p2", "new1", True)),
        "person",
    )
    assert [o.id for o in m.owners] == ["p2"]
    assert m.skipped == ["Users/old1"] and m.unmatched == []


def test_person_claims_scan_a_former_person_only_when_switched_on():
    people = [
        {
            "person_id": "a",
            "uni_alias": "aa1",
            "active": True,
            "scan_while_former": False,
        },
        {
            "person_id": "b",
            "uni_alias": "bb2",
            "active": False,
            "scan_while_former": False,
        },
        {
            "person_id": "c",
            "uni_alias": "cc3",
            "active": False,
            "scan_while_former": True,
        },
        {"person_id": "d", "uni_alias": None, "active": True},
    ]
    assert [(c[0], c[3]) for c in owners.person_claims(people)] == [
        ("a", True),
        ("b", False),
        ("c", True),
    ]


@pytest.mark.parametrize(
    "bad", ["a/b", "a\\b", "..", ".", "", " x", "x ", ".hidden", "~snapshot"]
)
def test_a_claimed_name_that_is_not_one_path_component_is_never_used(bad):
    m = owners.match_folders(
        "Users", ["ok1", "..", "x"], claims(("p1", bad, True)), "person"
    )
    assert m.owners == []


@pytest.mark.parametrize(
    "name",
    [
        ".snapshot",
        ".git",
        "~snapshot",
        "~snapshot.2026",
        "~Snapshot",
        ".",
        "$RECYCLE.BIN",
        "_dedup_removed",
    ],
)
def test_snapshot_and_hidden_directories_are_skipped(name):
    assert owners.skip_dir(name)
    m = owners.match_folders("Users", [name, "real"], [], "person")
    assert m.unmatched == ["Users/real"]


@pytest.mark.parametrize("name", ["sem", "snapshot", "Snapshots", "data.v2"])
def test_ordinary_directories_are_not_skipped(name):
    assert not owners.skip_dir(name)


def test_team_folders_match_by_share_folder():
    m = owners.match_folders(
        "Shared",
        ["Machining", "Old project"],
        claims(("t1", "machining", True)),
        "team",
    )
    assert [(o.kind, o.id, o.root) for o in m.owners] == [
        ("team", "t1", "Shared/Machining")
    ]
    assert m.unmatched == ["Shared/Old project"]


# ---- helpers for the DB-backed scans -------------------------------------------------------


class SpyShare:
    """Wraps the real read-only Share: records every call, and can fail or drop on demand."""

    def __init__(self, inner):
        self.inner = inner
        self.scandirs: list[str] = []
        self.stats: list[str] = []
        self.opens: list[str] = []
        self.fail: dict[tuple[str, str], Exception] = {}
        self.vanish_after: int | None = None
        self.calls = 0

    def _tick(self, kind, rel):
        self.calls += 1
        if self.vanish_after is not None and self.calls > self.vanish_after:
            raise FileNotFoundError(errno.ENOENT, "the share is gone")
        exc = self.fail.get((kind, rel))
        if exc is not None:
            raise exc

    def scandir(self, rel=""):
        self.scandirs.append(rel)
        self._tick("scandir", rel)
        return self.inner.scandir(rel)

    def stat(self, rel=""):
        self.stats.append(rel)
        self._tick("stat", rel)
        return self.inner.stat(rel)

    def open_rb(self, rel, adopted=False):
        self.opens.append(rel)
        self._tick("open", rel)
        return self.inner.open_rb(rel, adopted=adopted)


OLD = 1_600_000_000  # a fixed old time: settling twice gives the same mtime, so nothing looks changed


def settle(world):
    """Make every directory look old, so the scan may cache its modification time (see RACY_WINDOW_S)."""
    old = OLD
    for dirpath, _dirs, _files in os.walk(world.root):
        os.utime(dirpath, (old, old))


def png(color=(120, 120, 120), size=(64, 48)):
    pil_image = pytest.importorskip("PIL.Image")
    b = io.BytesIO()
    pil_image.new("RGB", size, color).save(b, "PNG")
    return b.getvalue()


def make(world, **kw):
    spy = SpyShare(fs_readonly.Share(world.root))
    store = db.Store(world.conn)
    kw.setdefault("throttle", None)
    return scan.Scanner(spy, store, **kw), spy, store


def run(world, person_id=None, **kw):
    sc, spy, store = make(world, **kw)
    stats = sc.scan(person_id=person_id)
    return stats, spy, store


def cands(world):
    rows = world.q(
        "SELECT rel_path, state, origin, kind FROM file_candidates ORDER BY rel_path"
    )
    return {r[0]: r[1:] for r in rows}


def baselined(world, root):
    return world.one(
        "SELECT baselined_at IS NOT NULL FROM inbox_dirs WHERE rel_path = %s", (root,)
    )


@pytest.fixture
def one_person(world):
    pid, uid = world.person("abc12de", user=True)
    world.write("Users/abc12de/sem/a.png", png((1, 1, 1)))
    world.write("Users/abc12de/sem/deep/b.png", png((2, 2, 2)))
    world.write("Users/abc12de/notes.pdf", b"%PDF-1.4 notes")
    world.write("Users/abc12de/scan1.al3d", b"AL3D" * 100)
    settle(world)
    return world, pid, uid


# ---- first scan: baseline ---------------------------------------------------------------


def test_the_first_scan_registers_everything_as_backlog_then_baselines(one_person):
    world, pid, _ = one_person
    stats, _spy, _ = run(world)
    assert (stats.registered, stats.errors, stats.aborted) == (4, 0, False)
    got = cands(world)
    assert set(got) == {
        "Users/abc12de/sem/a.png",
        "Users/abc12de/sem/deep/b.png",
        "Users/abc12de/notes.pdf",
        "Users/abc12de/scan1.al3d",
    }
    assert {v[1] for v in got.values()} == {"backlog"}  # origin
    assert got["Users/abc12de/notes.pdf"][2] == "document"
    assert got["Users/abc12de/scan1.al3d"][2] == "surface_scan"
    assert got["Users/abc12de/sem/a.png"][2] == "image"
    assert baselined(world, "Users/abc12de") == (True,)
    assert (
        world.one("SELECT owner_person_id::text FROM file_candidates LIMIT 1")[0] == pid
    )


def test_a_file_that_arrives_after_the_baseline_is_new(one_person):
    world, _, _ = one_person
    run(world)
    world.write("Users/abc12de/sem/c.png", png((3, 3, 3)))
    stats, _, _ = run(world)
    assert stats.registered == 1
    assert cands(world)["Users/abc12de/sem/c.png"][1] == "new"


def test_a_scan_with_nothing_new_changes_nothing_and_lists_nothing(one_person):
    world, _, _ = one_person
    run(world)
    settle(world)
    before = world.q("SELECT candidate_id, state FROM file_candidates ORDER BY 1")
    stats, spy, _ = run(world)
    assert stats.registered == 0 and stats.listed_dirs == 0
    assert [
        d for d in spy.scandirs if d.startswith("Users/")
    ] == []  # only "Users" itself, to find owners
    assert (
        world.q("SELECT candidate_id, state FROM file_candidates ORDER BY 1") == before
    )


def test_every_document_and_data_type_is_listed_but_never_opened(world):
    world.person("abc12de")
    names = [
        "r.pdf",
        "r.docx",
        "r.xlsx",
        "r.csv",
        "r.txt",
        "r.m",
        "r.mat",
        "r.nef",
        "r.doc",
        "r.h5",
        "r.xyz",
    ]
    for n in names:
        world.write(f"Users/abc12de/{n}", b"never read")
    world.write("Users/abc12de/pic.png", png())
    settle(world)
    stats, spy, _ = run(world)
    assert stats.registered == len(names) + 1
    assert spy.opens == ["Users/abc12de/pic.png"]  # the one image, nothing else
    got = cands(world)
    assert (
        got["Users/abc12de/r.pdf"][2] == "document"
        and got["Users/abc12de/r.mat"][2] == "other"
    )
    assert world.one("SELECT count(*) FROM file_fingerprints")[0] == 1


def test_a_surface_scan_and_an_image_are_hashed_at_discovery(one_person):
    world, _, _ = one_person
    run(world)
    rows = world.q(
        "SELECT c.rel_path FROM file_candidates c JOIN file_fingerprints f "
        "ON f.directus_files_id = c.directus_files_id WHERE f.status = 'done' ORDER BY 1"
    )
    assert [r[0] for r in rows] == [
        "Users/abc12de/scan1.al3d",
        "Users/abc12de/sem/a.png",
        "Users/abc12de/sem/deep/b.png",
    ]


def test_hashing_is_throttled(one_person):
    world, _, _ = one_person
    seen = []

    class Spy(hashing.Throttle):
        def consume(self, n):
            seen.append(n)

    run(world, throttle=Spy(1e9))
    assert sum(seen) == (
        os.path.getsize(Path(world.root, "Users/abc12de/sem/a.png"))
        + os.path.getsize(Path(world.root, "Users/abc12de/sem/deep/b.png"))
        + 400
    )


# ---- incremental walk -----------------------------------------------------------------------


def test_only_the_changed_directory_is_listed(one_person):
    world, _, _ = one_person
    run(world)
    settle(world)
    world.write(
        "Users/abc12de/sem/deep/new1.png", png((9, 9, 9))
    )  # changes only deep/'s mtime
    stats, spy, _ = run(world)
    assert stats.registered == 1
    assert [d for d in spy.scandirs if d.startswith("Users/abc12de")] == [
        "Users/abc12de/sem/deep"
    ]
    # every known directory was stat'd, one cheap call each
    assert {"Users/abc12de", "Users/abc12de/sem", "Users/abc12de/sem/deep"} <= set(
        spy.stats
    )


def test_a_new_nested_directory_shows_up_as_an_entry_of_a_changed_parent(one_person):
    world, _, _ = one_person
    run(world)
    settle(world)
    world.write("Users/abc12de/fresh/x/y.png", png((7, 7, 7)))
    stats, _, _ = run(world)
    assert stats.registered == 1
    assert "Users/abc12de/fresh/x/y.png" in cands(world)
    dirs = {r[0] for r in world.q("SELECT rel_path FROM inbox_dirs")}
    assert {"Users/abc12de/fresh", "Users/abc12de/fresh/x"} <= dirs


def test_a_directory_changed_a_moment_ago_is_listed_again_next_time(world):
    world.person("abc12de")
    world.write("Users/abc12de/a.png", png())  # its directories are brand new: racy
    run(world)
    world.write("Users/abc12de/b.png", png((5, 5, 5)))
    stats, _, _ = run(world)
    assert stats.registered == 1  # not missed although the mtime may not have moved


def test_hidden_and_snapshot_directories_are_never_entered(world):
    world.person("abc12de")
    world.write("Users/abc12de/ok.png", png())
    for d in (
        ".snapshot",
        "~snapshot",
        "~snapshot.2026-01-01",
        ".git",
        "$RECYCLE.BIN",
        "_dedup_removed",
    ):
        world.write(f"Users/abc12de/{d}/other_user_copy.png", png((4, 4, 4)))
        world.write(f"Users/abc12de/sem/{d}/deeper.png", png((4, 4, 4)))
    settle(world)
    stats, spy, _ = run(world)
    assert list(cands(world)) == ["Users/abc12de/ok.png"]
    assert not [
        d
        for d in spy.scandirs + spy.stats
        if any(s in d for s in (".snapshot", "~snapshot", ".git", "RECYCLE", "_dedup"))
    ]


def test_litter_files_are_not_found_files(world):
    world.person("abc12de")
    for n in (
        "~$report.docx",
        "Thumbs.db",
        "desktop.ini",
        ".hidden.png",
        "x.tmp",
        ".DS_Store",
    ):
        world.write(f"Users/abc12de/{n}", b"x")
    world.write("Users/abc12de/real.png", png())
    settle(world)
    run(world)
    assert list(cands(world)) == ["Users/abc12de/real.png"]


def test_links_in_a_folder_are_not_followed(world, tmp_path):
    if not hasattr(os, "symlink"):
        pytest.skip("needs symbolic links")
    world.person("abc12de")
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    (outside / "secret.png").write_bytes(png())
    world.write("Users/abc12de/ok.png", png())
    os.symlink(outside, Path(world.root, "Users/abc12de/linked"))
    os.symlink(outside / "secret.png", Path(world.root, "Users/abc12de/l.png"))
    settle(world)
    run(world)
    assert list(cands(world)) == ["Users/abc12de/ok.png"]


# ---- who is scanned -------------------------------------------------------------------------


def test_team_folders_unmatched_folders_and_former_people(world):
    world.person("abc12de")
    world.person("old1", active=False)
    world.person("old2", active=False, scan_while_former=True)
    world.person(None)  # no alias: nothing to scan
    tid = world.team("Machining")
    for rel in (
        "Users/abc12de/a.png",
        "Users/old1/b.png",
        "Users/old2/c.png",
        "Users/zz9/d.png",
        "Shared/Machining/e.png",
        "Shared/Old project/f.png",
        "Shared/loose.png",
    ):
        world.write(rel, png())
    settle(world)
    stats, _, _ = run(world)
    assert set(cands(world)) == {
        "Users/abc12de/a.png",
        "Users/old2/c.png",
        "Shared/Machining/e.png",
    }
    assert stats.unmatched == ["Shared/Old project", "Users/zz9"] or set(
        stats.unmatched
    ) == {
        "Users/zz9",
        "Shared/Old project",
    }
    team_row = world.one(
        "SELECT owner_team_id::text FROM file_candidates WHERE rel_path = 'Shared/Machining/e.png'"
    )
    assert team_row[0] == tid


def test_a_person_scope_scan_touches_only_that_persons_folder(world):
    a, _ = world.person("abc12de")
    world.person("other1")
    world.team("Machining")
    for rel in ("Users/abc12de/a.png", "Users/other1/b.png", "Shared/Machining/c.png"):
        world.write(rel, png())
    settle(world)
    stats, spy, _ = run(world, person_id=a)
    assert list(cands(world)) == ["Users/abc12de/a.png"]
    assert stats.unmatched is None  # a one-person scan leaves the admin list alone
    assert "Shared" not in spy.scandirs


def test_a_missing_personal_folder_is_simply_nothing_to_scan(world):
    world.person("abc12de")
    world.write("Users/someone_else/a.png", png())
    stats, _, _ = run(world)
    assert stats.registered == 0 and not stats.aborted


# ---- gone, moved, copies --------------------------------------------------------------------


def test_a_vanished_undecided_file_becomes_gone_and_comes_back(one_person):
    world, _, _ = one_person
    run(world)
    settle(world)
    os.unlink(Path(world.root, "Users/abc12de/sem/a.png"))
    stats, _, _ = run(world)
    assert stats.gone == 1
    assert cands(world)["Users/abc12de/sem/a.png"][0] == "gone"
    settle(world)
    world.write("Users/abc12de/sem/a.png", png((1, 1, 1)))
    run(world)
    assert cands(world)["Users/abc12de/sem/a.png"][0] == "new"


def test_decided_files_are_never_marked_gone(one_person):
    world, _, _ = one_person
    run(world)
    world.q(
        "UPDATE file_candidates SET state = 'dismissed' WHERE rel_path = 'Users/abc12de/sem/a.png'"
    )
    world.commit()
    settle(world)
    os.unlink(Path(world.root, "Users/abc12de/sem/a.png"))
    run(world)
    assert cands(world)["Users/abc12de/sem/a.png"][0] == "dismissed"


def test_a_vanished_folder_takes_its_undecided_files_with_it(one_person):
    world, _, _ = one_person
    run(world)
    settle(world)
    import shutil

    shutil.rmtree(Path(world.root, "Users/abc12de/sem"))
    stats, _, _ = run(world)
    got = cands(world)
    assert got["Users/abc12de/sem/a.png"][0] == "gone"
    assert got["Users/abc12de/sem/deep/b.png"][0] == "gone"
    assert got["Users/abc12de/notes.pdf"][0] == "new"
    assert (
        world.one(
            "SELECT count(*) FROM inbox_dirs WHERE rel_path LIKE 'Users/abc12de/sem%'"
        )[0]
        == 0
    )


def test_a_moved_image_re_points_the_candidate_instead_of_going_gone(one_person):
    world, _, _ = one_person
    run(world)
    settle(world)
    before = world.one(
        "SELECT candidate_id::text, first_seen_at, origin FROM file_candidates WHERE rel_path = 'Users/abc12de/sem/a.png'"
    )
    new = Path(world.root, "Users/abc12de/archive/a_moved.png")
    new.parent.mkdir(parents=True)
    os.rename(Path(world.root, "Users/abc12de/sem/a.png"), new)
    stats, _, _ = run(world)
    assert stats.repointed == 1
    got = cands(world)
    assert "Users/abc12de/sem/a.png" not in got
    assert got["Users/abc12de/archive/a_moved.png"][0] == "new"
    after = world.one(
        "SELECT candidate_id::text, first_seen_at, origin FROM file_candidates "
        "WHERE rel_path = 'Users/abc12de/archive/a_moved.png'"
    )
    assert after == before  # the same candidate: its history is kept
    assert (
        world.one("SELECT count(*) FROM file_candidates WHERE state = 'gone'")[0] == 0
    )
    assert (
        world.one(
            "SELECT count(*) FROM directus_files WHERE filename_download = 'a.png'"
        )[0]
        == 0
    )


def test_an_ambiguous_move_is_gone_plus_new(world):
    world.person("abc12de")
    same = png((8, 8, 8))
    world.write("Users/abc12de/x/one.png", same)
    world.write("Users/abc12de/x/two.png", same)
    settle(world)
    run(world)
    settle(world)
    os.unlink(Path(world.root, "Users/abc12de/x/one.png"))
    os.unlink(Path(world.root, "Users/abc12de/x/two.png"))
    world.write("Users/abc12de/y/three.png", same)
    stats, _, _ = run(world)
    assert stats.repointed == 0
    got = cands(world)
    assert (
        got["Users/abc12de/x/one.png"][0] == "gone"
        and got["Users/abc12de/x/two.png"][0] == "gone"
    )
    assert got["Users/abc12de/y/three.png"][0] == "new"


def test_the_same_image_in_two_inboxes_is_a_copy_of_the_first(world):
    world.person("abc12de")
    world.person("zzz99")
    same = png((6, 6, 6))
    world.write("Users/abc12de/a.png", same)
    settle(world)
    run(world)
    world.write("Users/zzz99/copy.png", same)
    settle(world)
    run(world)
    row = world.one(
        "SELECT d.rel_path FROM file_candidates c JOIN file_candidates d ON d.candidate_id = c.duplicate_of "
        "WHERE c.rel_path = 'Users/zzz99/copy.png'"
    )
    assert row == ("Users/abc12de/a.png",)


# ---- the share drops ------------------------------------------------------------------------


def seed_two_scans(world):
    world.person("abc12de")
    for i in range(4):
        world.write(f"Users/abc12de/d{i}/f.png", png((i, i, i)))
    settle(world)
    run(world)
    settle(world)


def assert_nothing_lost(world, expect_candidates=4):
    assert (
        world.one("SELECT count(*) FROM file_candidates WHERE state = 'gone'")[0] == 0
    )
    assert world.one("SELECT count(*) FROM file_candidates")[0] == expect_candidates


@pytest.mark.parametrize("after", [1, 2, 3, 4, 5, 6, 8])
def test_a_share_that_vanishes_mid_scan_aborts_and_marks_nothing_gone(world, after):
    seed_two_scans(world)
    # changed directories are what make a scan look for vanished files
    os.unlink(Path(world.root, "Users/abc12de/d1/f.png"))
    os.utime(Path(world.root, "Users/abc12de/d1"), None)
    sc, spy, _ = make(world)
    spy.vanish_after = after
    stats = sc.scan()
    assert stats.aborted
    assert_nothing_lost(world)


def test_an_unmounted_share_leaves_an_empty_mount_point(world):
    seed_two_scans(world)
    import shutil

    shutil.rmtree(
        Path(world.root, "Users")
    )  # the mount point is there, the share is not
    stats, _, _ = run(world)
    assert stats.aborted and "Users" in (stats.last_error or "")
    assert_nothing_lost(world)


def test_a_share_root_that_is_gone_aborts(world):
    seed_two_scans(world)
    import shutil

    shutil.rmtree(world.root)
    stats, _, _ = run(world)
    assert stats.aborted
    assert_nothing_lost(world)


def test_an_owner_folder_that_disappears_is_not_taken_for_deleted_files(world):
    seed_two_scans(world)
    import shutil

    shutil.rmtree(Path(world.root, "Users/abc12de"))
    stats, _, _ = run(world)
    assert_nothing_lost(world)
    assert (
        stats.owners_scanned == 0
    )  # the folder is not there: nothing is scanned, nothing is lost


def test_a_run_of_failed_reads_means_the_share_is_going(world):
    seed_two_scans(world)
    sc, spy, _ = make(world)
    for i in range(4):
        spy.fail[("stat", f"Users/abc12de/d{i}")] = OSError(errno.EIO, "I/O error")
    scan.MAX_CONSECUTIVE_FAILURES, saved = 3, scan.MAX_CONSECUTIVE_FAILURES
    try:
        stats = sc.scan()
    finally:
        scan.MAX_CONSECUTIVE_FAILURES = saved
    assert stats.aborted
    assert_nothing_lost(world)


def test_the_aborted_scan_does_not_set_the_baseline(world):
    world.person("abc12de")
    world.write("Users/abc12de/a/f.png", png())
    settle(world)
    sc, spy, _ = make(world)
    spy.vanish_after = 4
    stats = sc.scan()
    assert stats.aborted
    assert baselined(world, "Users/abc12de") in (None, (False,))


# ---- unreadable things ----------------------------------------------------------------------


def test_an_unreadable_directory_is_recorded_skipped_and_retried_next_scan(one_person):
    world, _, _ = one_person
    sc, spy, store = make(world)
    spy.fail[("scandir", "Users/abc12de/sem")] = PermissionError(errno.EACCES, "denied")
    stats = sc.scan()
    assert stats.errors == 1 and "sem" in stats.last_error
    assert "Users/abc12de/notes.pdf" in cands(world)
    assert "Users/abc12de/sem/a.png" not in cands(world)
    # no permission is permanent: it does not hold the baseline back (see test_inbox_crawler_scan_errors.py)
    assert baselined(world, "Users/abc12de") == (True,)
    spy.fail.clear()
    stats = sc.scan()  # readable now: the folder is found; it was not part of the baseline, so it is new
    assert stats.errors == 0
    assert cands(world)["Users/abc12de/sem/a.png"][1] == "new"


def test_a_file_that_cannot_be_statted_keeps_its_folder_uncached(one_person):
    world, _, _ = one_person
    sc, spy, _ = make(world)
    spy.fail[("stat", "Users/abc12de/sem/a.png")] = PermissionError(
        errno.EACCES, "denied"
    )
    stats = sc.scan()
    assert stats.errors == 1
    assert "Users/abc12de/sem/a.png" not in cands(world)
    spy.fail.clear()
    stats = sc.scan()
    assert "Users/abc12de/sem/a.png" in cands(
        world
    )  # the folder was not marked as done


def test_an_unreadable_image_is_registered_with_an_error_and_not_retried_in_a_loop(
    one_person,
):
    world, _, _ = one_person
    sc, spy, _ = make(world)
    spy.fail[("open", "Users/abc12de/sem/a.png")] = PermissionError(
        errno.EACCES, "denied"
    )
    stats = sc.scan()
    assert (
        stats.errors == 0
    )  # the file is known; its hash error is recorded, not a scan error
    row = world.one(
        "SELECT f.status, f.error_message FROM file_fingerprints f JOIN file_candidates c "
        "ON c.directus_files_id = f.directus_files_id WHERE c.rel_path = 'Users/abc12de/sem/a.png'"
    )
    assert row[0] == "error" and "PermissionError" in row[1]
    assert spy.opens.count("Users/abc12de/sem/a.png") == 1
    sc.scan()
    assert (
        spy.opens.count("Users/abc12de/sem/a.png") == 1
    )  # not read again by the next scan


def test_a_scan_killed_midway_resumes_without_losing_or_duplicating(world):
    world.person("abc12de")
    for i in range(6):
        world.write(f"Users/abc12de/d{i}/f.png", png((i, i, i)))
    settle(world)

    class Killed(
        BaseException
    ):  # like KeyboardInterrupt: not caught by the per-file handler
        pass

    sc, spy, _ = make(world)
    real = spy.open_rb
    seen = []

    def dying(rel, adopted=False):
        seen.append(rel)
        if len(seen) == 4:
            raise Killed()
        return real(rel, adopted)

    spy.open_rb = dying
    with pytest.raises(Killed):
        sc.scan()
    world.conn.rollback()  # what dying does to the open transaction
    first = set(cands(world))
    assert 0 < len(first) < 6
    stats, _, _ = run(world)
    got = cands(world)
    assert len(got) == 6 and stats.registered == 6 - len(first)
    assert {v[1] for v in got.values()} == {"backlog"}  # still the first scan
    assert world.one("SELECT count(*) FROM directus_files")[0] == 6


def test_after_an_alias_change_wipe_the_next_scan_is_a_first_scan_and_is_idempotent(
    one_person,
):
    world, _, _ = one_person
    run(world)
    world.q("DELETE FROM file_candidates")
    world.q("DELETE FROM inbox_dirs")
    world.commit()
    files_before = world.one("SELECT count(*) FROM directus_files")[0]
    world.write("Users/abc12de/late.png", png((4, 4, 4)))
    settle(world)
    stats, _, _ = run(world)
    assert stats.errors == 0 and stats.registered == 5
    assert {v[1] for v in cands(world).values()} == {"backlog"}
    assert world.one("SELECT count(*) FROM directus_files")[0] == files_before + 1
    assert baselined(world, "Users/abc12de") == (True,)


def test_one_file_failing_to_register_does_not_stop_the_scan(one_person, monkeypatch):
    world, _, _ = one_person
    sc, spy, store = make(world)
    real = store.register_file

    def flaky(**kw):
        if kw["rel"].endswith("notes.pdf"):
            raise RuntimeError("database hiccup")
        return real(**kw)

    monkeypatch.setattr(store, "register_file", flaky)
    stats = sc.scan()
    assert stats.errors == 1 and stats.registered == 3
    monkeypatch.setattr(store, "register_file", real)
    stats = sc.scan()
    assert stats.registered == 1 and "Users/abc12de/notes.pdf" in cands(world)


def test_a_stop_request_leaves_no_baseline(one_person):
    world, _, _ = one_person
    sc, _, _ = make(world, stop=lambda: True)
    stats = sc.scan()
    assert stats.interrupted
    assert baselined(world, "Users/abc12de") in (None, (False,))


# ---- recognition and classification at registration -----------------------------------------


def test_a_short_id_in_the_name_is_suggested_and_a_date_is_not(world):
    world.person("abc12de")
    sid = world.sample("3fa9c1d2")
    world.write("Users/abc12de/IMG_3fa9c1d2.png", png())
    world.write("Users/abc12de/20261015.png", png((9, 9, 9)))
    settle(world)
    run(world)
    rows = {
        r[0]: r[1:]
        for r in world.q(
            "SELECT rel_path, match_strength, suggested_collection, suggested_record_id::text FROM file_candidates"
        )
    }
    assert rows["Users/abc12de/IMG_3fa9c1d2.png"] == (
        "short_id",
        "physical_samples",
        sid,
    )
    assert rows["Users/abc12de/20261015.png"] == ("none", None, None)


def test_a_synthetic_sem_image_is_tagged_and_a_plain_one_is_not(world):
    pytest.importorskip("PIL")
    from PIL import Image, ImageDraw

    world.person("abc12de")
    img = Image.effect_noise((1280, 960), 30).convert("L")
    d = ImageDraw.Draw(img)
    d.rectangle((0, 870, 1280, 960), fill=0)
    for i, x in enumerate((20, 360, 700, 960)):
        d.text((x, 880 + (i % 2) * 40), "15.0kV x5,000 5um", fill=255)
    d.line((950, 915, 1100, 915), fill=255, width=3)
    b = io.BytesIO()
    img.save(b, "TIFF")
    world.write("Users/abc12de/jeol.tif", b.getvalue())
    world.write("Users/abc12de/plain.png", png())
    settle(world)
    run(world)
    got = cands(world)
    assert got["Users/abc12de/jeol.tif"][2] == "sem_image"
    assert got["Users/abc12de/plain.png"][2] == "image"


def test_an_image_too_big_to_keep_is_hashed_but_not_classified(one_person, monkeypatch):
    world, _, _ = one_person
    monkeypatch.setattr(scan, "CLASSIFY_MAX_BYTES", 10)
    run(world)
    assert cands(world)["Users/abc12de/sem/a.png"][2] == "image"
    assert (
        world.one("SELECT count(*) FROM file_fingerprints WHERE status = 'done'")[0]
        == 3
    )


def test_a_record_made_after_the_file_arrived_is_suggested_on_refresh(world):
    world.person("abc12de")
    world.write("Users/abc12de/3fa9c1d2.png", png())
    settle(world)
    run(world)
    assert world.one("SELECT match_strength FROM file_candidates")[0] == "none"
    sid = world.sample("3fa9c1d2")
    store = db.Store(world.conn)
    assert store.refresh_recognition(store.load_lookup()) == 1
    row = world.one(
        "SELECT match_strength, suggested_record_id::text FROM file_candidates"
    )
    assert row == ("short_id", sid)
    assert store.refresh_recognition(store.load_lookup()) == 0  # nothing more to change
