# ruff: noqa: F811
"""Fixes from the final review of the inbox crawler (plan 2026-10-15-found-files-inbox, crawler side).

One section per finding (S1, S2, B1, S4, ops nits). Postgres-backed like the other crawler tests.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

pytest.importorskip("psycopg2")
from inbox_crawler import db, fs_readonly, scan  # noqa: E402
from test_inbox_crawler_daemon import add_candidate, make_daemon  # noqa: E402
from test_inbox_crawler_scan import png, settle  # noqa: E402
from test_inbox_crawler_world import world  # noqa: E402, F401

# ---- S1: a path the share refuses is an error row, never an exception ------------------------------


def error_row(world, files_id, hours_ago):
    world.q(
        "INSERT INTO file_fingerprints (directus_files_id, status, error_message, hashed_at) "
        "VALUES (%s, 'error', 'earlier failure', now() - make_interval(hours => %s))",
        (files_id, hours_ago),
    )
    world.commit()


def fingerprint(world, files_id):
    return world.one(
        "SELECT status, error_message, content_sha256, hashed_at > now() - interval '1 minute' "
        "FROM file_fingerprints WHERE directus_files_id = %s",
        (files_id,),
    )


@pytest.mark.parametrize(
    "rel", ["Users/ab12/x/../secret.pdf", "Users/ab12/../../etc/passwd", "/etc/passwd"]
)
def test_fingerprint_file_turns_a_refused_path_into_an_error_outcome(world, rel):
    share = fs_readonly.Share(world.root)
    out, st, mtime = scan.fingerprint_file(share, rel, None, adopted=True)
    assert out.status == "error" and out.sha256 is None
    assert st is None and mtime is None


def test_fingerprint_file_turns_a_refused_read_into_an_error_outcome(world, tmp_path):
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    (outside / "secret.pdf").write_bytes(b"%PDF secret")
    world.person("ab12")
    os.makedirs(Path(world.root, "Users", "ab12"))
    os.symlink(outside, Path(world.root, "Users", "ab12", "link"))
    share = fs_readonly.Share(world.root)
    out, st, _mtime = scan.fingerprint_file(
        share, "Users/ab12/link/secret.pdf", None, adopted=True
    )
    assert out.status == "error" and out.sha256 is None
    assert st is not None  # the stat answered; it is the read that stays refused


def test_a_refused_path_in_the_retry_queue_is_recorded_and_the_loop_goes_on(world):
    pid, _ = world.person("ab12")
    world.write("Users/ab12/ok.png", png())
    settle(world)
    _bad, bad_fid = add_candidate(world, pid, "Users/ab12/x/../secret.png")
    _ok, ok_fid = add_candidate(world, pid, "Users/ab12/ok.png")
    error_row(world, bad_fid, 5)  # older, so it comes first
    error_row(world, ok_fid, 3)
    d, spy, _ = make_daemon(world)
    assert d.hash_pending() == 2  # no exception
    assert fingerprint(world, bad_fid)[0] == "error"
    assert fingerprint(world, bad_fid)[3]  # rewritten now: not retried for an hour
    assert fingerprint(world, ok_fid)[0] == "done"  # the loop moved on to the next row
    assert d.hash_pending() == 0


def test_a_linked_document_behind_a_symlinked_folder_stays_unread(world, tmp_path):
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    (outside / "secret.pdf").write_bytes(b"%PDF secret")
    pid, _ = world.person("ab12")
    os.makedirs(Path(world.root, "Users", "ab12"))
    os.symlink(outside, Path(world.root, "Users", "ab12", "link"))
    world.write("Users/ab12/notes.pdf", b"%PDF notes")
    _c1, bad_fid = add_candidate(
        world,
        pid,
        "Users/ab12/link/secret.pdf",
        kind="document",
        state="linked",
        adopted=True,
    )
    _c2, ok_fid = add_candidate(
        world,
        pid,
        "Users/ab12/notes.pdf",
        kind="document",
        state="linked",
        adopted=True,
    )
    d, _spy, _ = make_daemon(world)
    assert d.hash_pending() == 2  # no exception, the refused one does not end the tick
    assert fingerprint(world, bad_fid)[0] == "error"
    assert fingerprint(world, bad_fid)[2] is None  # nothing of the secret was hashed
    assert fingerprint(world, ok_fid)[0] == "done"  # the loop went on to the next row
    assert d.hash_pending() == 0  # and the refused one waits an hour like any failure


# ---- S2: metadata.archive_path is editable by any Lab Member, so it is not trusted ------------------


def meta_path(world, rel_or_none, files_id):
    world.q(
        "UPDATE directus_files SET metadata = json_build_object('archive_path', %s::text) WHERE id = %s",
        (rel_or_none, files_id),
    )
    world.commit()


def owner_of(world, pid, alias):
    from inbox_crawler.owners import Owner

    return Owner("person", pid, f"Users/{alias}", alias, claim=alias)


def rel_path_of(world, candidate_id):
    return world.one(
        "SELECT rel_path FROM file_candidates WHERE candidate_id = %s", (candidate_id,)
    )[0]


def test_edited_metadata_pointing_at_another_document_is_ignored(world):
    pid, _ = world.person("aaa11")
    cid, fid = add_candidate(world, pid, "Users/aaa11/mine.png")
    # a Lab Member edits the pointer row: "my file is really Users/aaa11/private/plan.pdf"
    meta_path(world, "Users/aaa11/private/plan.pdf", fid)
    n = db.Store(world.conn).resync_paths(owner_of(world, pid, "aaa11"))
    assert n == 0
    assert rel_path_of(world, cid) == "Users/aaa11/mine.png"


@pytest.mark.parametrize(
    "bad",
    [
        "Users/aaa11/x/../y.png",
        "Users/aaa11/../bbb22/y.png",
        "Users/aaa11\\y.png",
        "Users/aaa11//y.png",
        "Users/aaa11/./y.png",
        "Users/aaa11/y.png/",
        "Users/aaa11/",
        "Users/bbb22/y.png",
        "Shared/Team/y.png",
        "/Users/aaa11/y.png",
    ],
)
def test_a_resync_path_must_be_clean_and_under_the_owners_root(world, bad):
    """Even with a pointer row whose id matches the bad path (so the id rule alone would pass)."""
    pid, _ = world.person("aaa11")
    cid, fid = add_candidate(world, pid, bad)
    world.q(
        "UPDATE file_candidates SET rel_path = 'Users/aaa11/stale.png' WHERE candidate_id = %s",
        (cid,),
    )
    meta_path(world, bad, fid)
    assert db.Store(world.conn).resync_paths(owner_of(world, pid, "aaa11")) == 0
    assert rel_path_of(world, cid) == "Users/aaa11/stale.png"


def test_a_genuine_indexer_move_still_resyncs(world):
    """The indexer re-points the candidate to the pointer row of the new path (id = uuid5 of that path)
    and cannot touch rel_path: the id of the row and its archive_path agree."""
    pid, _ = world.person("aaa11")
    cid, fid = add_candidate(world, pid, "Users/aaa11/new/f.png")
    world.q(
        "UPDATE file_candidates SET rel_path = 'Users/aaa11/old/f.png' WHERE candidate_id = %s",
        (cid,),
    )
    meta_path(world, "Users/aaa11/new/f.png", fid)
    assert db.Store(world.conn).resync_paths(owner_of(world, pid, "aaa11")) == 1
    assert rel_path_of(world, cid) == "Users/aaa11/new/f.png"


def test_a_tampered_pointer_row_never_gets_a_document_read_through_a_tick(world):
    pid, _ = world.person("aaa11")
    world.write("Users/aaa11/mine.pdf", b"%PDF mine")
    world.write("Users/aaa11/private/plan.pdf", b"%PDF private plan")
    settle(world)
    cid, fid = add_candidate(
        world,
        pid,
        "Users/aaa11/mine.pdf",
        kind="document",
        state="linked",
        adopted=True,
    )
    meta_path(world, "Users/aaa11/private/plan.pdf", fid)
    d, spy, _ = make_daemon(world)
    d.tick()
    assert "Users/aaa11/private/plan.pdf" not in spy.opens
    assert rel_path_of(world, cid) == "Users/aaa11/mine.pdf"


@pytest.mark.parametrize(
    "rel",
    [
        "Users/aaa11/private/plan.pdf",  # another document than the row's id says
        "Users/aaa11/x/../mine.pdf",
        "Users/bbb22/mine.pdf",  # another owner's folder
        "Shared/Team/mine.pdf",
    ],
)
def test_adopted_awaiting_hash_checks_the_path_before_anything_is_read(world, rel):
    pid, _ = world.person("aaa11")
    world.write("Users/aaa11/private/plan.pdf", b"%PDF private plan")
    world.write("Users/bbb22/mine.pdf", b"%PDF other")
    cid, _fid = add_candidate(
        world,
        pid,
        "Users/aaa11/mine.pdf",
        kind="document",
        state="linked",
        adopted=True,
    )
    # the stored path is not the row's own (however it got there)
    world.q(
        "UPDATE file_candidates SET rel_path = %s WHERE candidate_id = %s", (rel, cid)
    )
    world.commit()
    store = db.Store(world.conn)
    assert store.adopted_awaiting_hash() == []
    d, spy, _ = make_daemon(world)
    assert d.hash_pending() == 0
    assert spy.opens == []


def test_adopted_awaiting_hash_still_returns_a_proper_row(world):
    pid, _ = world.person("aaa11")
    cid, fid = add_candidate(
        world,
        pid,
        "Users/aaa11/d/mine.pdf",
        kind="document",
        state="linked",
        adopted=True,
    )
    assert db.Store(world.conn).adopted_awaiting_hash() == [
        (cid, fid, "Users/aaa11/d/mine.pdf")
    ]


def test_adopted_awaiting_hash_accepts_the_owners_folder_in_its_share_spelling(world):
    """SMB is case-insensitive: the folder on the share may be spelled Users/AAA11 for the alias aaa11."""
    pid, _ = world.person("aaa11")
    cid, fid = add_candidate(
        world,
        pid,
        "Users/AAA11/mine.pdf",
        kind="document",
        state="linked",
        adopted=True,
    )
    assert [r[0] for r in db.Store(world.conn).adopted_awaiting_hash()] == [cid]


def test_adopted_awaiting_hash_for_a_team_file(world):
    tid = world.team("Machining")
    pid, _ = world.person("aaa11")
    cid, fid = add_candidate(
        world,
        pid,
        "Shared/Machining/mine.pdf",
        kind="document",
        state="linked",
        adopted=True,
        team_id=tid,
    )
    assert [r[0] for r in db.Store(world.conn).adopted_awaiting_hash()] == [cid]


# ---- B1: an auto-link a person undid is never offered again ----------------------------------------

from test_inbox_crawler_daemon import (  # noqa: E402
    FakeInbox,  # noqa: F401
    eligible,
    inbox,  # noqa: F401
    linkable,  # noqa: F401
    run_autolink,
)


def test_an_undone_auto_link_is_not_offered_again(linkable, inbox):
    world, pid, _, sid = linkable
    undone = eligible(world, pid, sid, rel="Users/abc12de/3fa9c1d2_undone.png")
    fresh = eligible(world, pid, sid, rel="Users/abc12de/3fa9c1d2_fresh.png")
    world.q(
        "UPDATE file_candidates SET auto_undone_at = now() WHERE candidate_id = %s",
        (undone,),
    )
    world.commit()
    counts, attempted = run_autolink(world, inbox)
    assert counts["offered"] == 1
    assert inbox.requests[0]["body"] == {"candidate_ids": [fresh]}
    assert set(attempted) == {fresh}


def test_the_in_process_attempted_map_still_holds_back_an_answered_candidate(
    linkable, inbox
):
    world, pid, _, sid = linkable
    cid = eligible(world, pid, sid)
    _, attempted = run_autolink(world, inbox)
    inbox.requests.clear()
    counts, _ = run_autolink(world, inbox, attempted)
    assert counts["offered"] == 0 and cid in attempted and inbox.requests == []
