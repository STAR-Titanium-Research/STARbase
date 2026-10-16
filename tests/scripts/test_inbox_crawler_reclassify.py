# ruff: noqa: F811
"""`python -m inbox_crawler --reclassify` (SEM reader plan task E2).

Postgres-backed (see test_inbox_crawler_world.py). Every image is synthetic: the FEI TIFF carries the
metadata text of test_inbox_crawler_sem_meta, the false claim is a bar-only image. The pass reads each file
once through the share's read-only `open_rb`, classifies it in memory and writes kind, kind_confidence,
extracted and classified_by of undecided candidates only.
"""

from __future__ import annotations

import errno
import logging
import shutil
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

pytest.importorskip("psycopg2")
import psycopg2  # noqa: E402
from inbox_crawler import __main__ as cli  # noqa: E402
from inbox_crawler import (  # noqa: E402
    classify_sem,
    db,
    fs_readonly,
    hashing,
    kinds,
    maintenance,
    recognise,
    scan,
)
from inbox_crawler.owners import Owner  # noqa: E402
from test_inbox_crawler_classify_fei import make_fei_tiff  # noqa: E402
from test_inbox_crawler_daemon import add_candidate  # noqa: E402
from test_inbox_crawler_scan import SpyShare, png, run, settle  # noqa: E402
from test_inbox_crawler_world import world  # noqa: E402, F401

VERSION = classify_sem.CLASSIFIER_VERSION
FEI = make_fei_tiff().getvalue()  # sem_image, kv 2.0
BAR_ONLY = make_fei_tiff(
    meta=False
).getvalue()  # a dark strip with dividers and no SEM evidence: image


class FlagSpy(SpyShare):
    """SpyShare that also remembers whether each open asked for `adopted`."""

    def __init__(self, inner):
        super().__init__(inner)
        self.adopted: list[bool] = []

    def open_rb(self, rel, adopted=False):
        self.adopted.append(adopted)
        return super().open_rb(rel, adopted=adopted)


@pytest.fixture
def pid(world):
    p, _ = world.person("abc12de")
    world.commit()
    return p


def put(world, pid, name, content, *, kind="image", state="new"):
    """A candidate row (never classified: classified_by NULL) and its bytes on the share."""
    rel = f"Users/abc12de/{name}"
    world.write(rel, content)
    cid, fid = add_candidate(world, pid, rel, kind=kind, state=state)
    return cid, rel


def row(world, cid):
    return world.one(
        "SELECT kind, kind_confidence, extracted, classified_by, state FROM file_candidates "
        "WHERE candidate_id = %s",
        (cid,),
    )


def reclassify(world, *, spy=None, **kw):
    spy = spy or FlagSpy(fs_readonly.Share(world.root))
    kw.setdefault("throttle", None)
    stats = maintenance.reclassify(db.Store(world.conn), spy, **kw)
    world.commit()
    return stats, spy


# ---- what changes -----------------------------------------------------------------------------


def test_reclassify_demotes_a_false_sem_image(world, pid):
    cid, _ = put(world, pid, "strip.tif", BAR_ONLY, kind="sem_image")
    world.q(
        "UPDATE file_candidates SET kind_confidence = 0.7 WHERE candidate_id = %s",
        (cid,),
    )
    world.commit()
    stats, _ = reclassify(world)
    kind, conf, extracted, by, state = row(world, cid)
    assert (kind, conf, extracted, by, state) == ("image", None, {}, VERSION, "new")
    assert (stats.promoted, stats.demoted, stats.unchanged) == (0, 1, 0)


def test_reclassify_promotes_a_fei_tiff(world, pid):
    cid, _ = put(world, pid, "fei.tif", FEI, kind="image")
    stats, _ = reclassify(world)
    kind, conf, extracted, by, _ = row(world, cid)
    assert kind == "sem_image" and conf >= classify_sem.SEM_MIN_CONFIDENCE
    assert extracted["kv"] == 2.0 and by == VERSION
    assert (stats.promoted, stats.demoted, stats.unchanged) == (1, 0, 0)


def test_a_dismissed_candidate_is_re_read_too_but_a_gone_one_is_not(world, pid):
    d, _ = put(world, pid, "d.tif", FEI, state="dismissed")
    g, _ = put(world, pid, "g.tif", FEI, state="gone")
    stats, spy = reclassify(world)
    assert row(world, d)[0] == "sem_image" and row(world, d)[4] == "dismissed"
    assert row(world, g)[0] == "image" and row(world, g)[3] is None
    assert spy.opens == ["Users/abc12de/d.tif"]
    assert stats.promoted == 1


def test_an_image_that_stays_what_it_was_is_unchanged_and_marked(world, pid):
    plain, _ = put(world, pid, "p.png", png())
    sem, _ = put(world, pid, "s.tif", FEI, kind="sem_image")
    stats, _ = reclassify(world)
    assert row(world, plain)[0] == "image" and row(world, plain)[3] == VERSION
    assert row(world, sem)[0] == "sem_image" and row(world, sem)[3] == VERSION
    assert (stats.promoted, stats.demoted, stats.unchanged) == (0, 0, 2)


def test_a_file_that_is_not_an_image_is_kept_as_a_plain_image(world, pid):
    cid, _ = put(world, pid, "broken.png", b"this is not a png")
    stats, _ = reclassify(world)
    assert row(world, cid)[0] == "image" and row(world, cid)[3] == VERSION
    assert stats.unchanged == 1 and stats.unreadable == 0


# ---- what it never touches --------------------------------------------------------------------


def test_reclassify_skips_linked_rows(world, pid):
    cid, _ = put(world, pid, "linked.tif", BAR_ONLY, kind="sem_image", state="linked")
    stats, spy = reclassify(world)
    kind, _, _, by, state = row(world, cid)
    assert (kind, by, state) == ("sem_image", None, "linked")
    assert spy.opens == [] and (stats.promoted, stats.demoted, stats.unchanged) == (
        0,
        0,
        0,
    )


def test_documents_and_surface_scans_are_never_read(world, pid):
    put(world, pid, "notes.pdf", b"%PDF-1.4", kind="document")
    put(world, pid, "scan.al3d", b"AL3D" * 10, kind="surface_scan")
    stats, spy = reclassify(world)
    assert spy.opens == [] and stats.examined == 0


def test_a_row_set_to_linked_during_the_pass_is_not_written(world, pid, monkeypatch):
    cid, _ = put(world, pid, "race.tif", FEI, kind="image")
    store = db.Store(world.conn)
    real = store.set_classification

    def link_then_write(candidate_id, classification):
        world.q(
            "UPDATE file_candidates SET state = 'linked', link_kind = 'manual', "
            "linked_collection = 'physical_samples', linked_junction_id = gen_random_uuid(), "
            "link_batch_id = gen_random_uuid() WHERE candidate_id = %s",
            (candidate_id,),
        )
        return real(candidate_id, classification)

    monkeypatch.setattr(store, "set_classification", link_then_write)
    maintenance.reclassify(store, FlagSpy(fs_readonly.Share(world.root)), throttle=None)
    world.commit()
    assert row(world, cid)[0] == "image" and row(world, cid)[4] == "linked"


def test_set_classification_writes_only_the_four_columns(world, pid):
    cid, _ = put(world, pid, "a.tif", FEI)
    before = world.one(
        "SELECT state, origin, rel_path, owner_person_id, match_strength, adopted_at "
        "FROM file_candidates WHERE candidate_id = %s",
        (cid,),
    )
    store = db.Store(world.conn)
    c = kinds.Classification("sem_image", 0.9, {"kv": 5.0}, "x", "sem-9")
    assert store.set_classification(cid, c) is True
    kind, conf, extracted, by = row(world, cid)[:4]
    assert (kind, float(conf), extracted, by) == (
        "sem_image",
        0.9,
        {"kv": 5.0},
        "sem-9",
    )
    assert (
        world.one(
            "SELECT state, origin, rel_path, owner_person_id, match_strength, adopted_at "
            "FROM file_candidates WHERE candidate_id = %s",
            (cid,),
        )
        == before
    )


# ---- idempotent, resumable, no tight retry ---------------------------------------------------


def test_reclassify_is_idempotent(world, pid):
    put(world, pid, "a.tif", FEI)
    put(world, pid, "b.tif", BAR_ONLY, kind="sem_image")
    reclassify(world)
    snapshot = world.q(
        "SELECT candidate_id, kind, extracted, classified_by FROM file_candidates ORDER BY 1"
    )
    stats, spy = reclassify(world)
    assert spy.opens == [] and stats.examined == 0
    assert (
        world.q(
            "SELECT candidate_id, kind, extracted, classified_by FROM file_candidates ORDER BY 1"
        )
        == snapshot
    )


def test_a_run_stopped_half_way_is_finished_by_the_next(world, pid):
    ids = [put(world, pid, f"f{n}.tif", FEI)[0] for n in range(4)]
    reads = []

    def stop():
        return len(reads) >= 2

    spy = FlagSpy(fs_readonly.Share(world.root))
    real = spy.open_rb

    def counting(rel, adopted=False):
        reads.append(rel)
        return real(rel, adopted=adopted)

    spy.open_rb = counting
    first, _ = reclassify(world, spy=spy, stop=stop)
    assert first.examined == 2
    assert sum(row(world, c)[3] == VERSION for c in ids) == 2
    second, spy2 = reclassify(world)
    assert second.examined == 2 and len(spy2.opens) == 2
    assert all(
        row(world, c)[3] == VERSION and row(world, c)[0] == "sem_image" for c in ids
    )
    assert set(reads).isdisjoint(spy2.opens)  # nothing read twice


def test_unreadable_file_is_not_retried_in_a_loop(world, pid, caplog):
    cid, rel = put(world, pid, "locked.tif", FEI, kind="sem_image")
    spy = FlagSpy(fs_readonly.Share(world.root))
    spy.fail[("open", rel)] = PermissionError(13, "no permission")
    with caplog.at_level(logging.INFO):
        stats, _ = reclassify(world, spy=spy)
    kind, _, _, by, _ = row(world, cid)
    assert (kind, by) == ("sem_image", VERSION)  # kind untouched, marked as classified
    assert stats.unreadable == 1 and spy.opens == [rel]  # one attempt, not a loop
    assert rel in caplog.text and "PermissionError" in caplog.text
    stats2, spy2 = reclassify(world)
    assert spy2.opens == [] and stats2.examined == 0


def test_a_file_missing_from_a_healthy_share_is_skipped_not_marked(world, pid, caplog):
    """A missing file is not a permanent failure (the file may have moved, the share may be flaky): the row
    stays queued, is not offered again in this run, the run goes on, and the next run offers it again."""
    gone, rel = put(world, pid, "vanished.tif", FEI)
    ok, _ = put(world, pid, "fine.tif", FEI)
    Path(world.root, rel).unlink()
    with caplog.at_level(logging.INFO):
        stats, spy = reclassify(world)
    assert stats.skipped == 1 and not stats.aborted
    assert stats.promoted == 1 and row(world, ok)[3] == VERSION
    assert row(world, gone)[3] is None  # not marked: still in the queue
    assert spy.opens.count(rel) == 1  # not offered again within the run
    assert rel in caplog.text
    stats2, spy2 = reclassify(world)  # the next run offers it again
    assert spy2.opens == [rel] and stats2.skipped == 1
    world.write(rel, FEI)  # the file is back: now it is classified
    stats3, _ = reclassify(world)
    assert stats3.promoted == 1 and row(world, gone)[3] == VERSION


def test_a_skipped_row_is_not_offered_again_in_the_same_run_whatever_the_batch(
    world, pid
):
    ids = []
    for n in range(3):
        cid, rel = put(world, pid, f"m{n}.tif", FEI)
        Path(world.root, rel).unlink()
        ids.append(rel)
    stats, spy = reclassify(world, batch=1)
    assert stats.skipped == 3 and sorted(spy.opens) == sorted(ids)  # once each


def test_a_transient_error_is_skipped_not_marked_and_retried_by_the_next_run(
    world, pid
):
    cid, rel = put(world, pid, "flaky.tif", FEI)
    spy = FlagSpy(fs_readonly.Share(world.root))
    spy.fail[("open", rel)] = OSError(errno.EIO, "input/output error")
    stats, _ = reclassify(world, spy=spy)
    assert stats.skipped == 1 and not stats.aborted and spy.opens == [rel]
    assert row(world, cid)[3] is None
    stats2, spy2 = reclassify(world)
    assert stats2.promoted == 1 and row(world, cid)[3] == VERSION


def test_a_file_too_large_to_read_into_memory_is_marked(world, pid, monkeypatch):
    cid, _ = put(world, pid, "huge.tif", FEI, kind="sem_image")
    monkeypatch.setattr(scan, "CLASSIFY_MAX_BYTES", 100)
    stats, _ = reclassify(world)
    assert stats.too_large == 1 and stats.skipped == 0
    kind, _, _, by, _ = row(world, cid)
    assert (kind, by) == ("sem_image", VERSION)
    assert reclassify(world)[1].opens == []


# ---- a share that drops: abort, mark nothing after that point --------------------------------


class DropShare(FlagSpy):
    """Removes the share's root when the `nth` file is about to be opened (the mount going away)."""

    def __init__(self, inner, root, nth):
        super().__init__(inner)
        self._root, self._nth = root, nth

    def open_rb(self, rel, adopted=False):
        if len(self.opens) + 1 == self._nth:
            shutil.rmtree(self._root)
        return super().open_rb(rel, adopted=adopted)


def test_a_share_that_drops_mid_run_aborts_and_marks_nothing_after_that(
    world, pid, caplog
):
    ids = [put(world, pid, f"f{n}.tif", FEI)[0] for n in range(5)]
    spy = DropShare(fs_readonly.Share(world.root), world.root, 3)
    with caplog.at_level(logging.INFO):
        stats, _ = reclassify(world, spy=spy)
    assert stats.aborted and stats.promoted == 2 and stats.skipped == 0
    assert (
        sum(row(world, c)[3] == VERSION for c in ids) == 2
    )  # the two read before the drop
    assert (
        sum(row(world, c)[3] is None for c in ids) == 3
    )  # nothing after it was marked
    assert "reclassify aborted" in caplog.text and "(ABORTED)" in caplog.text


def test_a_share_that_is_not_there_at_the_start_aborts_before_reading(world, pid):
    cid, _ = put(world, pid, "a.tif", FEI)
    shutil.rmtree(world.root)
    stats, spy = reclassify(world)
    assert stats.aborted and spy.opens == [] and row(world, cid)[3] is None


def test_consecutive_transient_failures_abort_the_run(world, pid):
    n = scan.MAX_CONSECUTIVE_FAILURES + 1
    ids = []
    spy = FlagSpy(fs_readonly.Share(world.root))
    for i in range(n):
        cid, rel = put(world, pid, f"e{i:02d}.tif", FEI)
        ids.append(cid)
        spy.fail[("open", rel)] = OSError(errno.EIO, "input/output error")
    stats, _ = reclassify(world, spy=spy)
    assert stats.aborted
    assert len(spy.opens) == scan.MAX_CONSECUTIVE_FAILURES  # stopped at the limit
    assert all(row(world, c)[3] is None for c in ids)  # nothing marked


def test_the_command_exits_one_when_the_share_drops_mid_run(
    env, pid, monkeypatch, caplog
):
    ids = [put(env, pid, f"f{n}.tif", FEI)[0] for n in range(4)]
    real = fs_readonly.Share.open_rb
    seen = []

    def dropping(self, rel, adopted=False):
        seen.append(rel)
        if len(seen) == 2:
            shutil.rmtree(env.root)
        return real(self, rel, adopted=adopted)

    monkeypatch.setattr(fs_readonly.Share, "open_rb", dropping)
    with caplog.at_level(logging.INFO):
        assert cli.main(["--reclassify", "--root", env.root]) == 1
    assert sum(row(env, c)[3] == VERSION for c in ids) == 1
    assert sum(row(env, c)[3] is None for c in ids) == 3
    assert "aborted" in caplog.text


def test_reclassify_only_opens_allowlisted_images(world, pid):
    a, _ = put(world, pid, "a.tif", FEI)
    b, _ = put(world, pid, "b.JPG", png())
    c, odd = put(
        world, pid, "mislabelled.pdf", b"%PDF-1.4", kind="image"
    )  # an image row, a document name
    put(world, pid, "notes.pdf", b"%PDF-1.4", kind="document")
    put(world, pid, "x.tif", FEI, state="linked")
    stats, spy = reclassify(world)
    assert spy.adopted and not any(
        spy.adopted
    )  # never adopted: nothing a person linked is read
    assert sorted(spy.opens) == sorted(
        ["Users/abc12de/a.tif", "Users/abc12de/b.JPG", odd]
    )
    # the allow-list refused the mislabelled one before anything was read: marked, not retried
    assert stats.unreadable == 1 and row(world, c)[3] == VERSION
    ok = [r for r in spy.opens if r != odd]
    assert all(fs_readonly.extension(r) in fs_readonly.IMAGE_EXTENSIONS for r in ok)


# ---- throttle and OCR -------------------------------------------------------------------------


def test_reads_go_through_the_read_rate_throttle(world, pid):
    put(world, pid, "a.tif", FEI)
    slept = []
    t = hashing.Throttle(1_000.0, clock=lambda: 0.0, sleep=slept.append)
    reclassify(world, throttle=t)
    assert slept and sum(slept) > 0  # the bytes were charged to the cap


def test_the_ocr_switch_is_passed_to_the_classifier(world, pid, monkeypatch):
    put(world, pid, "a.tif", FEI)
    seen = []
    real = classify_sem.classify_image

    def spy(fh, **kw):
        seen.append(kw.get("ocr"))
        return real(fh, **kw)

    monkeypatch.setattr(classify_sem, "classify_image", spy)
    reclassify(world, ocr=True, bar_reader=lambda *_a, **_k: None)
    assert seen == [True]


# ---- the registration records the version, so a fresh scan is not re-read -----------------------


def test_a_scan_records_the_classifier_version_of_images_only(world):
    world.person("abc12de")
    world.write("Users/abc12de/a.tif", FEI)
    world.write("Users/abc12de/notes.pdf", b"%PDF-1.4")
    settle(world)
    world.commit()
    run(world)
    got = dict(world.q("SELECT rel_path, classified_by FROM file_candidates"))
    assert got["Users/abc12de/a.tif"] == VERSION
    assert got["Users/abc12de/notes.pdf"] is None
    stats, spy = reclassify(world)
    assert spy.opens == [] and stats.examined == 0


def test_register_file_stores_null_for_a_name_only_classification(world):
    pid, _ = world.person("abc12de")
    store = db.Store(world.conn)
    store.register_file(
        owner=Owner("person", pid, "Users/abc12de", "abc12de", claim="abc12de"),
        rel="Users/abc12de/x.png",
        size=1,
        mtime=db.to_datetime(1_700_000_000_000_000_000),
        classification=kinds.Classification("image"),
        recognition=recognise.NO_MATCH,
        origin="new",
        hashed=None,
    )
    assert world.one("SELECT classified_by FROM file_candidates") == (None,)


# ---- the command ------------------------------------------------------------------------------


@pytest.fixture
def env(world, monkeypatch):
    for k in ("D1_INBOX_URL", "D1_INBOX_CRAWLER_SECRET", "INBOX_OCR", "ARCHIVE_ROOT"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("DATABASE_URL", world.dsn)
    monkeypatch.setenv("INBOX_PRIVATE_SCHEMA", world.schema)
    return world


def test_reclassify_is_a_third_exclusive_mode(env):
    with pytest.raises(SystemExit) as e:
        cli.main(["--reclassify", "--once", "--root", env.root])
    assert e.value.code == 2
    with pytest.raises(SystemExit):
        cli.main(["--reclassify", "--daemon", "--root", env.root])


def test_the_command_logs_promoted_demoted_and_unchanged(env, pid, caplog):
    put(env, pid, "fei.tif", FEI, kind="image")
    put(env, pid, "strip.tif", BAR_ONLY, kind="sem_image")
    put(env, pid, "plain.png", png())
    with caplog.at_level(logging.INFO):
        assert cli.main(["--reclassify", "--root", env.root]) == 0
    assert "1 promoted, 1 demoted, 1 unchanged" in caplog.text
    assert env.one(
        "SELECT count(*) FROM file_candidates WHERE classified_by = %s", (VERSION,)
    ) == (3,)
    # a second command run has nothing to do
    caplog.clear()
    with caplog.at_level(logging.INFO):
        assert cli.main(["--reclassify", "--root", env.root]) == 0
    assert "0 promoted, 0 demoted, 0 unchanged" in caplog.text


def test_reclassify_refuses_when_another_crawler_holds_the_lock(env, pid, caplog):
    cid, _ = put(env, pid, "fei.tif", FEI, kind="image")
    other = psycopg2.connect(env.dsn)
    try:
        holder = db.Store(other)
        assert holder.try_crawler_lock()
        with caplog.at_level(logging.INFO):
            assert cli.main(["--reclassify", "--root", env.root]) == 1
        assert "another inbox crawler holds the database lock" in caplog.text
        assert (
            row(env, cid)[0] == "image" and row(env, cid)[3] is None
        )  # nothing was read or written
    finally:
        other.close()
    assert cli.main(["--reclassify", "--root", env.root]) == 0  # the lock is free again
    assert row(env, cid)[0] == "sem_image"


def test_the_command_reads_ocr_from_the_environment(env, pid, monkeypatch):
    put(env, pid, "fei.tif", FEI)
    seen = []
    real = maintenance.reclassify

    def spy(store, share, **kw):
        seen.append(kw.get("ocr"))
        return real(store, share, **kw)

    monkeypatch.setattr(maintenance, "reclassify", spy)
    monkeypatch.setenv("INBOX_OCR", "0")
    assert cli.main(["--reclassify", "--root", env.root]) == 0
    assert seen == [False]


# ---- --force: ignore classified_by -----------------------------------------------------------


def test_force_re_reads_a_row_already_at_the_current_version(world, pid):
    cid, rel = put(world, pid, "late.tif", FEI)
    reclassify(world)
    assert row(world, cid)[0] == "sem_image" and row(world, cid)[3] == VERSION
    world.write(
        rel, BAR_ONLY
    )  # what the file says changes (stands in for OCR becoming available)
    stats, spy = reclassify(world)
    assert (
        spy.opens == [] and row(world, cid)[0] == "sem_image"
    )  # not re-read without --force
    stats, spy = reclassify(world, force=True)
    assert spy.opens == [rel] and stats.demoted == 1
    assert row(world, cid)[0] == "image"


def test_force_visits_each_row_once_and_still_skips_linked_and_gone_rows(world, pid):
    a, _ = put(world, pid, "a.tif", FEI)
    put(world, pid, "l.tif", FEI, state="linked")
    put(world, pid, "g.tif", FEI, state="gone")
    reclassify(world)
    stats, spy = reclassify(world, force=True, batch=1)
    assert spy.opens == ["Users/abc12de/a.tif"] and stats.examined == 1


def test_the_command_force_re_reads_and_a_plain_run_reads_nothing(env, pid, caplog):
    put(env, pid, "a.tif", FEI)
    assert cli.main(["--reclassify", "--root", env.root]) == 0
    caplog.clear()
    with caplog.at_level(logging.INFO):
        assert cli.main(["--reclassify", "--root", env.root]) == 0
    assert "0 promoted, 0 demoted, 0 unchanged" in caplog.text
    caplog.clear()
    with caplog.at_level(logging.INFO):
        assert cli.main(["--reclassify", "--force", "--root", env.root]) == 0
    assert "0 promoted, 0 demoted, 1 unchanged" in caplog.text


@pytest.mark.parametrize("other", ["--daemon", "--once", "--sem-backfill"])
def test_force_is_refused_with_the_other_modes(env, other):
    with pytest.raises(SystemExit) as e:
        cli.main([other, "--force", "--root", env.root])
    assert e.value.code == 2
