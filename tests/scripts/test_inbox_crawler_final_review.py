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
from inbox_crawler import fs_readonly, scan  # noqa: E402
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
