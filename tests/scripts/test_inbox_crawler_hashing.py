# ruff: noqa: F811
"""Hashing and registration (plan C4): throttled streaming SHA-256, pointer rows with the indexer's id rule."""

from __future__ import annotations

import hashlib
import io
import sys
import uuid
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

import index_archive as ia  # noqa: E402
from inbox_crawler import fs_readonly, hashing, kinds, recognise  # noqa: E402
from inbox_crawler.owners import Owner  # noqa: E402

pytest.importorskip("psycopg2")
from inbox_crawler import db  # noqa: E402
from test_inbox_crawler_world import world  # noqa: E402, F401

# ---- Throttle ------------------------------------------------------------------------------


class FakeClock:
    def __init__(self):
        self.t = 100.0
        self.slept = 0.0

    def now(self):
        return self.t

    def sleep(self, s):
        self.slept += s
        self.t += s


def test_the_throttle_caps_the_rate():
    c = FakeClock()
    th = hashing.Throttle(1 << 20, clock=c.now, sleep=c.sleep)  # 1 MiB/s
    for _ in range(3):
        th.consume(1 << 20)
    assert c.slept == pytest.approx(3.0, abs=0.01)


def test_a_throttle_with_no_rate_never_sleeps():
    c = FakeClock()
    th = hashing.Throttle(None, clock=c.now, sleep=c.sleep)
    th.consume(10 << 20)
    assert c.slept == 0


def test_the_rate_can_change_while_running():
    c = FakeClock()
    th = hashing.Throttle(1 << 20, clock=c.now, sleep=c.sleep)
    th.set_rate(4 << 20)
    th.consume(4 << 20)
    assert c.slept == pytest.approx(1.0, abs=0.01)
    with pytest.raises(ValueError):
        th.set_rate(0)


def test_mb_per_s_converts_the_state_rows_setting():
    assert hashing.mb_per_s(60) == 60 * 1024 * 1024
    assert hashing.mb_per_s(None) is None


# ---- hash_stream / hash_file ---------------------------------------------------------------


def test_hash_stream_matches_hashlib_and_counts_bytes():
    data = b"abc" * 1_000_000  # several chunks
    out = hashing.hash_stream(io.BytesIO(data))
    assert (out.status, out.sha256, out.size) == (
        "done",
        hashlib.sha256(data).hexdigest(),
        len(data),
    )
    assert out.data is None  # nothing kept unless asked


def test_hash_stream_keeps_small_files_only():
    small = hashing.hash_stream(io.BytesIO(b"x" * 100), keep_up_to=1000)
    assert small.data == b"x" * 100
    big = hashing.hash_stream(io.BytesIO(b"x" * (3 << 20)), keep_up_to=1 << 20)
    assert big.data is None and big.size == 3 << 20


def test_hash_stream_is_throttled_by_what_it_read():
    c = FakeClock()
    th = hashing.Throttle(1 << 20, clock=c.now, sleep=c.sleep)
    hashing.hash_stream(io.BytesIO(b"x" * (2 << 20)), throttle=th)
    assert c.slept == pytest.approx(2.0, abs=0.01)


def test_hash_file_reads_through_the_read_only_module(world):
    world.write("Users/a/img.tif", b"pixels")
    share = fs_readonly.Share(world.root)
    out = hashing.hash_file(share, "Users/a/img.tif", throttle=None)
    assert out.sha256 == hashlib.sha256(b"pixels").hexdigest()


def test_hash_file_reports_a_vanished_file_as_missing(world):
    out = hashing.hash_file(
        fs_readonly.Share(world.root), "Users/a/gone.tif", throttle=None
    )
    assert out.status == "missing" and out.sha256 is None


def test_hash_file_records_a_read_error_instead_of_raising():
    class Boom:
        def open_rb(self, rel, adopted=False):
            raise PermissionError("denied")

    out = hashing.hash_file(Boom(), "Users/a/x.tif", throttle=None)
    assert out.status == "error" and "PermissionError" in out.error


def test_a_read_refusal_is_a_bug_and_propagates(world):
    world.write("Users/a/notes.pdf", b"%PDF")
    with pytest.raises(fs_readonly.ReadRefused):
        hashing.hash_file(
            fs_readonly.Share(world.root), "Users/a/notes.pdf", throttle=None
        )
    out = hashing.hash_file(
        fs_readonly.Share(world.root), "Users/a/notes.pdf", throttle=None, adopted=True
    )
    assert out.status == "done"


# ---- registration --------------------------------------------------------------------------

NONE = recognise.NO_MATCH
IMG = kinds.Classification("image")
DOC = kinds.Classification("document")


def register(
    store,
    owner,
    rel,
    *,
    size=10,
    cls=IMG,
    rec=NONE,
    origin="new",
    sha="a" * 64,
    status="done",
):
    hashed = (
        None
        if sha is None
        else hashing.HashOutcome(status, sha if status == "done" else None, size)
    )
    return store.register_file(
        owner=owner,
        rel=rel,
        size=size,
        mtime=db.to_datetime(1_700_000_000_000_000_000),
        classification=cls,
        recognition=rec,
        origin=origin,
        hashed=hashed,
    )


@pytest.fixture
def ctx(world):
    pid, _ = world.person("abc12de")
    owner = Owner("person", pid, "Users/abc12de", "abc12de")
    return world, db.Store(world.conn), owner


def test_the_pointer_row_uses_the_indexers_id_rule(ctx):
    world, store, owner = ctx
    rel = "Users/abc12de/sem/a.tif"
    r = register(store, owner, rel)
    assert r.created
    fid = str(ia.file_id(rel))
    row = world.one(
        "SELECT storage, filename_disk, filename_download, title, type, folder::text, filesize, "
        "metadata::jsonb->>'archive_path' FROM directus_files WHERE id = %s",
        (fid,),
    )
    assert row == (
        "star",
        rel,
        "a.tif",
        "a",
        "image/tiff",
        str(ia.folder_id("Users/abc12de/sem")),
        10,
        rel,
    )
    cand = world.one(
        "SELECT directus_files_id::text, owner_person_id::text, kind, origin, state, rel_path, size_bytes "
        "FROM file_candidates"
    )
    assert cand == (fid, owner.id, "image", "new", "new", rel, 10)


def test_the_folder_chain_mirrors_the_tree_from_the_root(ctx):
    world, store, owner = ctx
    register(store, owner, "Users/abc12de/sem/deep/a.tif")
    rows = dict(
        world.q(
            "SELECT id::text, name || '|' || COALESCE(parent::text, '') FROM directus_folders"
        )
    )
    assert rows[str(ia.folder_id(""))] == "star_group1|"
    assert rows[str(ia.folder_id("Users"))] == f"Users|{ia.folder_id('')}"
    assert rows[str(ia.folder_id("Users/abc12de/sem/deep"))] == (
        f"deep|{ia.folder_id('Users/abc12de/sem')}"
    )
    assert len(rows) == 5


def test_registering_twice_is_idempotent(ctx):
    world, store, owner = ctx
    a = register(store, owner, "Users/abc12de/a.tif")
    b = register(store, owner, "Users/abc12de/a.tif")
    assert a.created and not b.created and a.candidate_id == b.candidate_id
    assert world.one("SELECT count(*) FROM file_candidates")[0] == 1
    assert world.one("SELECT count(*) FROM directus_files")[0] == 1
    assert world.one("SELECT count(*) FROM file_fingerprints")[0] == 1


def test_an_existing_pointer_row_from_the_indexer_is_left_alone(ctx):
    world, store, owner = ctx
    rel = "Users/abc12de/a.tif"
    world.q(
        "INSERT INTO directus_files (id, storage, filename_download, title) VALUES (%s, 'star', 'a.tif', 'indexer title')",
        (str(ia.file_id(rel)),),
    )
    r = register(store, owner, rel)
    assert r.created  # the candidate is new even though the pointer was there
    assert world.one("SELECT title FROM directus_files")[0] == "indexer title"


def test_a_candidate_after_an_alias_change_wipe_is_registered_again(ctx):
    world, store, owner = ctx
    register(store, owner, "Users/abc12de/a.tif")
    world.q("DELETE FROM file_candidates")  # what the alias-change trigger does
    r = register(store, owner, "Users/abc12de/a.tif")
    assert r.created
    assert world.one("SELECT count(*) FROM directus_files")[0] == 1


def test_a_fingerprint_is_written_for_hashed_files_only(ctx):
    world, store, owner = ctx
    register(store, owner, "Users/abc12de/a.tif", sha="b" * 64, size=7)
    register(store, owner, "Users/abc12de/notes.pdf", cls=DOC, sha=None)
    fp = world.q(
        "SELECT directus_files_id::text, status, content_sha256, size_bytes FROM file_fingerprints"
    )
    assert fp == [(str(ia.file_id("Users/abc12de/a.tif")), "done", "b" * 64, 7)]


def test_a_failed_hash_is_recorded_not_lost(ctx):
    world, store, owner = ctx
    register(store, owner, "Users/abc12de/a.tif", sha="x", status="error")
    row = world.one("SELECT status, content_sha256 FROM file_fingerprints")
    assert row == ("error", None)
    assert world.one("SELECT count(*) FROM file_candidates")[0] == 1


def test_the_same_content_elsewhere_makes_the_later_file_a_copy(ctx):
    world, store, owner = ctx
    pid2, _ = world.person("zzz99")
    other = Owner("person", pid2, "Users/zzz99", "zzz99")
    first = register(store, owner, "Users/abc12de/a.tif", sha="c" * 64)
    second = register(store, other, "Users/zzz99/copy.tif", sha="c" * 64)
    third = register(store, other, "Users/zzz99/other.tif", sha="d" * 64)
    assert first.duplicate_of is None
    assert second.duplicate_of == first.candidate_id
    assert third.duplicate_of is None
    row = world.one(
        "SELECT duplicate_of::text FROM file_candidates WHERE candidate_id = %s",
        (second.candidate_id,),
    )
    assert row[0] == first.candidate_id


def test_a_copy_of_a_copy_points_at_the_original(ctx):
    world, store, owner = ctx
    a = register(store, owner, "Users/abc12de/a.tif", sha="c" * 64)
    register(store, owner, "Users/abc12de/b.tif", sha="c" * 64)
    c = register(store, owner, "Users/abc12de/c.tif", sha="c" * 64)
    assert c.duplicate_of == a.candidate_id


def test_a_gone_original_is_not_an_original(ctx):
    world, store, owner = ctx
    a = register(store, owner, "Users/abc12de/a.tif", sha="c" * 64)
    store.mark_gone([a.candidate_id])
    b = register(store, owner, "Users/abc12de/b.tif", sha="c" * 64)
    assert b.duplicate_of is None


def test_recognition_and_classification_are_stored(ctx):
    world, store, owner = ctx
    sid = world.sample("3fa9c1d2")
    lk = db.Store(world.conn).load_lookup()
    rec = recognise.recognise("Users/abc12de/3fa9c1d2.tif", lk)
    cls = kinds.Classification("sem_image", 0.9, {"kv": 15.0})
    register(
        store, owner, "Users/abc12de/3fa9c1d2.tif", cls=cls, rec=rec, origin="backlog"
    )
    row = world.one(
        "SELECT kind, kind_confidence, extracted::text, origin, match_strength, suggested_collection, "
        "suggested_record_id::text, matches::jsonb->0->>'token' FROM file_candidates"
    )
    assert row[0] == "sem_image" and float(row[1]) == 0.9 and row[2] == '{"kv": 15.0}'
    assert row[3:] == ("backlog", "short_id", "physical_samples", sid, "3fa9c1d2")


def test_a_team_file_has_a_team_owner(ctx):
    world, store, _ = ctx
    tid = world.team("Machining")
    owner = Owner("team", tid, "Shared/Machining", "Machining")
    register(store, owner, "Shared/Machining/a.tif")
    row = world.one("SELECT owner_person_id, owner_team_id::text FROM file_candidates")
    assert row == (None, tid)


def test_one_bad_file_does_not_poison_the_transaction(ctx):
    world, store, owner = ctx
    register(store, owner, "Users/abc12de/ok1.tif")
    with pytest.raises(Exception):  # noqa: B017  (a constraint violation: unknown kind)
        register(
            store, owner, "Users/abc12de/bad.tif", cls=kinds.Classification("nonsense")
        )
    register(store, owner, "Users/abc12de/ok2.tif")
    store.commit()
    assert world.one("SELECT count(*) FROM file_candidates")[0] == 2


def test_the_long_path_has_no_filename_disk(ctx):
    world, store, owner = ctx
    rel = "Users/abc12de/" + "d/" * 130 + "a.tif"
    register(store, owner, rel)
    assert world.one("SELECT filename_disk FROM directus_files")[0] is None


def test_the_id_rule_is_imported_not_copied():
    from inbox_crawler import identity

    assert identity.file_id is ia.file_id and identity.folder_id is ia.folder_id
    assert str(identity.file_id("Users/a/b.tif")) == str(
        uuid.uuid5(ia._NS, "file:Users/a/b.tif")  # noqa: SLF001
    )
