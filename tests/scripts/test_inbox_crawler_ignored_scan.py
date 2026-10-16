# ruff: noqa: F811
"""Ignored folders (spec section 15) in the crawler: an ignored subtree is NOT SCANNED.

Postgres-backed (the world fixture creates `inbox_ignored_dirs` from the plan's DDL, see
test_inbox_crawler_world.py) with a real temp tree as the share. Not scanned is not empty: nothing below an
ignored folder is listed, statted or opened, no candidate under it is marked gone (whatever its state), and
its folder-cache rows stay. The rules are read when an owner starts (and again as a scan goes on). Linked files stay tracked by the adopted-hash
queue. The pure matching is in test_inbox_crawler_ignored.py.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

pytest.importorskip("psycopg2")
from inbox_crawler import db  # noqa: E402
from test_inbox_crawler_daemon import (  # noqa: E402
    add_candidate,
    make_daemon,
)
from test_inbox_crawler_scan import (  # noqa: E402
    OLD,
    cands,
    make,
    png,
    run,
    settle,
)
from test_inbox_crawler_world import world  # noqa: E402, F401

ME = "Users/abc12de"
PAPER = f"{ME}/World-Ti Paper"


def under(rel: str, folder: str) -> bool:
    return rel == folder or rel.startswith(folder + "/")


def touched(spy, folder: str) -> list[str]:
    """Every path the spy saw the crawler list, stat or open at or below `folder`."""
    seen = [*spy.scandirs, *spy.stats, *spy.opens]
    return [p for p in seen if under(p, folder)]


def bump(world, rel: str, delta: int = 100) -> None:
    """Give a directory a new modification time, so the next scan lists it again."""
    p = Path(world.root, rel)
    os.utime(p, (OLD + delta, OLD + delta))


@pytest.fixture
def papers(world):
    """abc12de with a folder to ignore, a lookalike next to it, and ordinary files."""
    pid, _ = world.person("abc12de", user=True)
    world.write(f"{ME}/keep/a.png", png((1, 1, 1)))
    world.write(f"{PAPER}/x.png", png((2, 2, 2)))
    world.write(f"{PAPER}/Drafts/y.png", png((3, 3, 3)))
    world.write(f"{PAPER} 2/z.png", png((4, 4, 4)))
    world.write(f"{ME}/notes.pdf", b"%PDF notes")
    settle(world)
    return world, pid


# ---- an ignored subtree is neither listed, statted nor opened -------------------------------------


def test_an_ignored_subtree_is_not_listed_statted_or_opened(papers):
    world, pid = papers
    world.ignore("World-Ti Paper", person=pid)
    world.commit()
    stats, spy, _ = run(world)
    assert stats.errors == 0 and not stats.aborted
    assert touched(spy, PAPER) == []
    got = cands(world)
    assert f"{PAPER}/x.png" not in got and f"{PAPER}/Drafts/y.png" not in got
    # the lookalike and the ordinary folders are scanned as always
    assert f"{PAPER} 2/z.png" in got and f"{ME}/keep/a.png" in got
    assert f"{ME}/notes.pdf" in got
    assert any(p == f"{PAPER} 2" for p in spy.scandirs)
    # the folder is known (seen in its parent's listing) but never listed
    row = world.one(
        "SELECT last_listed_at IS NULL FROM inbox_dirs WHERE rel_path = %s", (PAPER,)
    )
    assert row == (True,)
    assert stats.ignored_dirs >= 1


def test_the_next_scan_still_does_not_touch_the_ignored_folder(papers):
    world, pid = papers
    world.ignore("World-Ti Paper", person=pid)
    world.commit()
    run(world)
    settle(world)
    # something changed inside it AND in the owner's root: the root is listed again, the ignored folder is not
    world.write(f"{PAPER}/new.png", png((9, 9, 9)))
    bump(world, ME)
    stats, spy, _ = run(world)
    assert any(p == ME for p in spy.scandirs)
    assert touched(spy, PAPER) == []
    assert f"{PAPER}/new.png" not in cands(world)
    assert stats.errors == 0


def test_removing_a_rule_lists_the_folder_again_on_the_next_scan(papers):
    world, pid = papers
    world.ignore("World-Ti Paper", person=pid)
    world.commit()
    run(world)
    settle(world)
    world.unignore("World-Ti Paper", person=pid)
    world.commit()
    stats, spy, _ = run(world)
    got = cands(world)
    assert f"{PAPER}/x.png" in got and f"{PAPER}/Drafts/y.png" in got
    assert PAPER in spy.scandirs and f"{PAPER}/Drafts" in spy.scandirs
    # registered after the owner's baseline: they are new, not backlog
    assert got[f"{PAPER}/x.png"][1] == "new"
    assert stats.errors == 0


def test_a_name_that_only_starts_like_a_rule_is_not_ignored(papers):
    world, pid = papers
    world.ignore("World-Ti Paper", person=pid)
    world.commit()
    _, spy, _ = run(world)
    assert f"{PAPER} 2" in spy.scandirs
    assert f"{PAPER} 2/z.png" in cands(world)


def test_the_match_ignores_case(papers):
    world, pid = papers
    world.ignore("WORLD-TI paper/drafts", person=pid)
    world.commit()
    _, spy, _ = run(world)
    got = cands(world)
    assert touched(spy, f"{PAPER}/Drafts") == []
    assert f"{PAPER}/Drafts/y.png" not in got
    assert f"{PAPER}/x.png" in got  # the folder above the rule is still scanned


def test_nested_rules_each_cover_their_own_subtree(world):
    pid, _ = world.person("abc12de")
    for rel in ("a/b/c/f1.png", "a/b/f2.png", "a/other/f3.png", "z/f4.png"):
        world.write(f"{ME}/{rel}", png((len(rel), 1, 1)))
    settle(world)
    world.ignore("a/b/c", person=pid)
    world.ignore("a/b", person=pid)  # the outer rule covers the inner one as well
    world.commit()
    _, spy, _ = run(world)
    assert touched(spy, f"{ME}/a/b") == []
    assert set(cands(world)) == {f"{ME}/a/other/f3.png", f"{ME}/z/f4.png"}


def test_a_rule_of_one_owner_does_not_touch_another_owner(world):
    a, _ = world.person("abc12de")
    b, _ = world.person("zzz99")
    team = world.team("Machining")
    for root in ("Users/abc12de", "Users/zzz99", "Shared/Machining"):
        world.write(f"{root}/World-Ti Paper/f.png", png((len(root), 5, 5)))
        world.write(f"{root}/other/g.png", png((len(root), 6, 6)))
    settle(world)
    world.ignore("World-Ti Paper", person=a)  # person A's rule only
    world.commit()
    _, spy, _ = run(world)
    got = cands(world)
    assert touched(spy, "Users/abc12de/World-Ti Paper") == []
    assert "Users/abc12de/World-Ti Paper/f.png" not in got
    assert (
        "Users/zzz99/World-Ti Paper/f.png" in got
    )  # person B: same folder name, scanned
    assert "Shared/Machining/World-Ti Paper/f.png" in got  # a team folder: scanned
    # and the other way round: a team's rule leaves people alone
    world.ignore("other", team=team)
    world.commit()
    world.write("Users/abc12de/other/h.png", png((1, 2, 3)))
    world.write("Shared/Machining/other/h.png", png((3, 2, 1)))
    settle(world)
    bump(world, "Users/abc12de/other")
    bump(world, "Shared/Machining/other")
    _, spy, _ = run(world)
    got = cands(world)
    assert touched(spy, "Shared/Machining/other") == []
    assert "Shared/Machining/other/h.png" not in got
    assert "Users/abc12de/other/h.png" in got


def test_a_team_rule_ignores_below_the_team_folder_only(world):
    team = world.team("Machining")
    world.write("Shared/Machining/Old Jobs/f.png", png((1, 1, 2)))
    world.write("Shared/Machining/Keep/g.png", png((1, 1, 3)))
    settle(world)
    world.ignore("Old Jobs", team=team)
    world.commit()
    _, spy, _ = run(world)
    assert touched(spy, "Shared/Machining/Old Jobs") == []
    assert set(cands(world)) == {"Shared/Machining/Keep/g.png"}


def test_a_scan_of_one_person_honours_the_rules_too(papers):
    world, pid = papers
    world.ignore("World-Ti Paper", person=pid)
    world.commit()
    _, spy, _ = run(world, person_id=pid)
    assert touched(spy, PAPER) == []
    assert f"{PAPER}/x.png" not in cands(world)


def test_a_database_without_the_rules_table_scans_everything(papers):
    world, _pid = papers
    world.q("DROP TABLE inbox_ignored_dirs")
    world.commit()
    stats, _, _ = run(world)
    assert stats.errors == 0
    assert f"{PAPER}/x.png" in cands(world)


# ---- not scanned is not empty: nothing under it is marked gone --------------------------------------


def seed_under_ignored(world, pid):
    """Candidates of every state under a folder that is not on the share at all (as if it were deleted or
    unreadable), plus a control under a plain missing folder."""
    world.write(f"{ME}/keep/a.png", png((1, 1, 1)))
    settle(world)
    run(world)  # baseline: the root is known
    rows = {
        "new": add_candidate(world, pid, f"{PAPER}/n.png")[0],
        "new_deep": add_candidate(world, pid, f"{PAPER}/Drafts/n2.png")[0],
        "dismissed": add_candidate(world, pid, f"{PAPER}/d.png")[0],
        "gone": add_candidate(world, pid, f"{PAPER}/g.png")[0],
        "linked": add_candidate(
            world, pid, f"{PAPER}/l.pdf", kind="document", state="linked", adopted=True
        )[0],
        "control": add_candidate(world, pid, f"{ME}/Vanished/c.png")[0],
    }
    world.q(
        "UPDATE file_candidates SET state = 'dismissed' WHERE candidate_id = %s",
        (rows["dismissed"],),
    )
    world.q(
        "UPDATE file_candidates SET state = 'gone' WHERE candidate_id = %s",
        (rows["gone"],),
    )
    for rel in (PAPER, f"{PAPER}/Drafts"):
        world.q(
            "INSERT INTO inbox_dirs (rel_path, owner_person_id, dir_mtime, last_listed_at) "
            "VALUES (%s, %s, now(), now())",
            (rel, pid),
        )
    world.commit()
    return rows


def states(world):
    return {r[0]: r[1] for r in world.q("SELECT rel_path, state FROM file_candidates")}


def test_candidates_under_an_ignored_folder_keep_their_state(world):
    pid, _ = world.person("abc12de")
    seed_under_ignored(world, pid)
    world.ignore("World-Ti Paper", person=pid)
    world.commit()
    bump(world, ME)  # the root is listed: its listing has no World-Ti Paper
    stats, spy, _ = run(world)
    assert not stats.aborted and stats.errors == 0
    got = states(world)
    assert got[f"{PAPER}/n.png"] == "new"
    assert got[f"{PAPER}/Drafts/n2.png"] == "new"
    assert got[f"{PAPER}/d.png"] == "dismissed"
    assert got[f"{PAPER}/g.png"] == "gone"
    assert got[f"{PAPER}/l.pdf"] == "linked"
    # the control proves the sweep ran: an undecided file of a missing, not ignored folder is gone
    assert got[f"{ME}/Vanished/c.png"] == "gone"
    assert touched(spy, PAPER) == []
    # and the cache rows below the ignored folder are as they were
    kept = {
        r[0]
        for r in world.q(
            "SELECT rel_path FROM inbox_dirs WHERE rel_path LIKE %s",
            ("%World-Ti Paper%",),
        )
    }
    assert kept == {PAPER, f"{PAPER}/Drafts"}


def test_without_the_rule_the_same_candidates_do_go_gone(world):
    """The control for the test above: the rule is what keeps them."""
    pid, _ = world.person("abc12de")
    seed_under_ignored(world, pid)
    bump(world, ME)
    run(world)
    got = states(world)
    assert got[f"{PAPER}/n.png"] == "gone"
    assert got[f"{PAPER}/Drafts/n2.png"] == "gone"
    assert got[f"{PAPER}/d.png"] == "dismissed"  # an undecided file only


def test_an_ignored_folder_below_a_deleted_one_keeps_its_candidates_and_cache(world):
    pid, _ = world.person("abc12de")
    world.write(f"{ME}/Proj/Sub/s.png", png((5, 5, 1)))
    world.write(f"{ME}/Proj/Other/o.png", png((5, 5, 2)))
    world.write(f"{ME}/keep/k.png", png((5, 5, 3)))
    settle(world)
    run(world)
    settle(world)
    world.ignore("Proj/Sub", person=pid)
    world.commit()
    import shutil

    shutil.rmtree(Path(world.root, *f"{ME}/Proj".split("/")))
    bump(world, ME)
    stats, spy, _ = run(world)
    assert not stats.aborted
    got = states(world)
    assert (
        got[f"{ME}/Proj/Other/o.png"] == "gone"
    )  # a real deletion elsewhere is still noticed
    assert got[f"{ME}/Proj/Sub/s.png"] == "new"  # not scanned: not judged
    assert got[f"{ME}/keep/k.png"] == "new"
    assert touched(spy, f"{ME}/Proj/Sub") == []
    rows = {r[0] for r in world.q("SELECT rel_path FROM inbox_dirs")}
    assert f"{ME}/Proj/Sub" in rows
    assert f"{ME}/Proj/Other" not in rows


@pytest.mark.parametrize("after", [1, 2, 3, 4, 5, 6, 8])
def test_a_scan_that_aborts_midway_marks_nothing_gone(world, after):
    pid, _ = world.person("abc12de")
    seed_under_ignored(world, pid)
    world.ignore("World-Ti Paper", person=pid)
    world.commit()
    before = states(world)
    bump(world, ME)
    sc, spy, _ = make(world)
    spy.vanish_after = after
    stats = sc.scan()
    assert stats.aborted
    assert (
        states(world) == before
    )  # not one state moved, under the folder or outside it


# ---- the rules are read when an owner starts (a rule changing later in a scan: test_inbox_crawler_ignored_race.py)


def test_a_rule_added_during_a_scan_before_the_owner_starts_is_honoured(papers):
    world, pid = papers
    sc, spy, _ = make(world)
    real = spy.scandir
    fired = []

    def scandir_then_add_rule(rel=""):
        out = real(rel)
        if not fired:
            fired.append(rel)
            world.ignore(
                "World-Ti Paper", person=pid
            )  # another session adds it while the scan lists Users
        return out

    spy.scandir = scandir_then_add_rule
    sc.scan()
    assert fired == ["Users"]
    # the owner's rules are read when the owner starts, which is after that
    assert touched(spy, PAPER) == []
    assert f"{PAPER}/x.png" not in cands(world)
    assert f"{PAPER} 2/z.png" in cands(world)


def test_a_rule_removed_during_a_scan_before_the_owner_starts_is_honoured(papers):
    world, pid = papers
    world.ignore("World-Ti Paper", person=pid)
    world.commit()
    sc, spy, _ = make(world)
    real = spy.scandir
    fired = []

    def scandir_then_drop_rule(rel=""):
        out = real(rel)
        if not fired:
            fired.append(rel)
            world.unignore("World-Ti Paper", person=pid)
        return out

    spy.scandir = scandir_then_drop_rule
    sc.scan()
    # removing a rule only makes the crawler read more, and only what the person asked for: the folder is
    # listed from the moment the owner starts
    assert PAPER in spy.scandirs
    assert f"{PAPER}/x.png" in cands(world)


# ---- nothing below an ignored folder is read by anything else ------------------------------------


def error_row(world, files_id, hours_ago=3):
    world.q(
        "INSERT INTO file_fingerprints (directus_files_id, status, error_message, hashed_at) "
        "VALUES (%s, 'error', 'earlier failure', now() - make_interval(hours => %s))",
        (files_id, hours_ago),
    )
    world.commit()


def test_a_failed_hash_under_an_ignored_folder_is_not_retried(world):
    pid, _ = world.person("abc12de")
    world.write(f"{PAPER}/x.png", png((1, 2, 3)))
    world.write(f"{ME}/keep/a.png", png((3, 2, 1)))
    settle(world)
    _c1, ignored_fid = add_candidate(world, pid, f"{PAPER}/x.png")
    _c2, kept_fid = add_candidate(world, pid, f"{ME}/keep/a.png")
    error_row(world, ignored_fid)
    error_row(world, kept_fid)
    world.ignore("world-ti paper", person=pid)
    world.commit()
    d, spy, _ = make_daemon(world)
    assert d.hash_pending() == 1  # only the file outside the rule
    assert touched(spy, PAPER) == []
    status = dict(
        world.q("SELECT directus_files_id::text, status FROM file_fingerprints")
    )
    assert status[ignored_fid] == "error" and status[kept_fid] == "done"


def test_a_rule_does_not_hide_a_lookalike_folder_from_the_retry_queue(world):
    pid, _ = world.person("abc12de")
    world.write(f"{PAPER} 2/z.png", png((1, 2, 3)))
    settle(world)
    _c, fid = add_candidate(world, pid, f"{PAPER} 2/z.png")
    error_row(world, fid)
    world.ignore("World-Ti Paper", person=pid)
    world.commit()
    d, _spy, _ = make_daemon(world)
    assert d.hash_pending() == 1


def test_auto_link_is_not_offered_a_file_under_an_ignored_folder(world):
    pid, _ = world.person("abc12de")
    sid = world.sample("3fa9c1d2")
    kw = {"strength": "short_id", "collection": "physical_samples", "record": sid}
    _c1, _ = add_candidate(world, pid, f"{PAPER}/3fa9c1d2.png", **kw)
    c2, _ = add_candidate(world, pid, f"{ME}/keep/3fa9c1d2.png", **kw)
    world.ignore("World-Ti Paper", person=pid)
    world.commit()
    offered = db.Store(world.conn).autolink_candidates({pid})
    assert [c["candidate_id"] for c in offered] == [c2]


def test_a_linked_file_under_an_ignored_folder_keeps_being_tracked(world):
    """Already linked document tracking by the adopted-hash queue is NOT stopped by a rule: a linked file is
    a record's file, and stays tracked (hashed once, retried when it failed)."""
    pid, _ = world.person("abc12de")
    world.write(f"{PAPER}/thesis.pdf", b"%PDF thesis")
    settle(world)
    _c, fid = add_candidate(
        world, pid, f"{PAPER}/thesis.pdf", kind="document", state="linked", adopted=True
    )
    world.ignore("World-Ti Paper", person=pid)
    world.commit()
    d, spy, _ = make_daemon(world)
    assert d.hash_pending() == 1
    assert f"{PAPER}/thesis.pdf" in spy.opens
    assert world.one(
        "SELECT status FROM file_fingerprints WHERE directus_files_id = %s", (fid,)
    ) == ("done",)
    # and a scan leaves the linked row alone (it neither lists the folder nor marks it gone)
    run(world)
    assert states(world)[f"{PAPER}/thesis.pdf"] == "linked"
