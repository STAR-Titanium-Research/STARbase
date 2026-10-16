# ruff: noqa: F811
"""`python -m inbox_crawler --sem-backfill` (SEM reader plan task E3).

Postgres-backed (see test_inbox_crawler_world.py): the fixture carries the REAL migration 197, so every test
runs the real `save_sem_settings` (the only place `extracted` becomes settings) and `correct_sem_setting`.
Images are synthetic: the FEI TIFF carries the metadata text of test_inbox_crawler_sem_meta.
"""

from __future__ import annotations

import errno
import json
import logging
import shutil
import sys
import uuid
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
    maintenance,
    scan,
)
from inbox_crawler.identity import file_id  # noqa: E402
from test_inbox_crawler_classify_fei import make_fei_tiff  # noqa: E402
from test_inbox_crawler_reclassify import DropShare, FlagSpy  # noqa: E402
from test_inbox_crawler_scan import png  # noqa: E402
from test_inbox_crawler_world import world  # noqa: E402, F401

FEI = make_fei_tiff().getvalue()  # sem_image: kv 2.0, spot 3.5, wd 15.9 mm, ETD / SE
BAR_ONLY = make_fei_tiff(meta=False).getvalue()  # a bar with no SEM evidence: image


def pointer(
    world,
    rel,
    content=FEI,
    *,
    link=True,
    owner=None,
    archive_path=None,
    write=True,
    junction="sample_data_files",
):
    """A pointer row as the indexer writes it (id = uuid5 of the path, metadata.archive_path), the bytes on the
    share, and (by default) a link to a record. Returns the files id."""
    fid = str(file_id(rel))
    world.q(
        "INSERT INTO directus_files (id, storage, filename_download, type, metadata, owner_person_id) "
        "VALUES (%s, 'star', %s, 'image/tiff', %s, %s)",
        (
            fid,
            rel.rsplit("/", 1)[1],
            json.dumps({"archive_path": archive_path or rel}),
            owner,
        ),
    )
    if write:
        world.write(rel, content)
    if link:
        col = {
            "sample_data_files": "sample_id",
            "operation_data_files": "operation_id",
            "session_data_files": "session_id",
        }[junction]
        world.q(
            f"INSERT INTO {junction} ({col}, directus_files_id) VALUES (gen_random_uuid(), %s)",
            (fid,),
        )
    world.commit()
    return fid


def settings(world, fid):
    cols = "kv, spot, working_distance_mm, magnification, detector, mode, sources, flags, read_by"
    return world.one(
        f"SELECT {cols} FROM sem_image_settings WHERE directus_files_id = %s", (fid,)
    )


def n_settings(world):
    return world.one("SELECT count(*) FROM sem_image_settings")[0]


def backfill(world, *, spy=None, **kw):
    spy = spy or FlagSpy(fs_readonly.Share(world.root))
    kw.setdefault("throttle", None)
    stats = maintenance.sem_backfill(db.Store(world.conn), spy, **kw)
    world.commit()
    return stats, spy


# ---- what it writes ---------------------------------------------------------------------------


def test_backfill_writes_settings_for_a_linked_unowned_fei_tiff(world):
    fid = pointer(world, "Equipment/SEM/a.tif")
    stats, spy = backfill(world)
    kv, spot, wd, mag, detector, mode, sources, flags, read_by = settings(world, fid)
    assert (float(kv), float(spot), detector, mode) == (2.0, 3.5, "ETD", "SE")
    assert float(wd) == pytest.approx(15.92, abs=0.01)
    assert (
        mag == 40
        and sources["kv"] == "metadata"
        and sources["magnification"] == "derived"
    )
    assert read_by == "backfill"
    assert (stats.saved, stats.not_sem, stats.no_values, stats.unreadable) == (
        1,
        0,
        0,
        0,
    )
    assert spy.opens == ["Equipment/SEM/a.tif"]


@pytest.mark.parametrize(
    "junction", ["sample_data_files", "operation_data_files", "session_data_files"]
)
def test_a_link_in_any_of_the_three_junctions_counts(world, junction):
    fid = pointer(world, "Equipment/SEM/a.tif", junction=junction)
    backfill(world)
    assert settings(world, fid) is not None


def test_a_surface_scan_link_counts_when_the_table_exists(world):
    world.q(
        "CREATE TABLE surface_scans (id serial PRIMARY KEY, "
        "directus_files_id uuid REFERENCES directus_files (id) ON DELETE CASCADE)"
    )
    fid = pointer(world, "Equipment/SEM/a.tif", link=False)
    world.q("INSERT INTO surface_scans (directus_files_id) VALUES (%s)", (fid,))
    world.commit()
    backfill(world)
    assert settings(world, fid) is not None


# ---- what it leaves alone ---------------------------------------------------------------------


def test_backfill_skips_owned_files(world):
    pid, _ = world.person("abc12de")
    fid = pointer(world, "Users/abc12de/a.tif", owner=pid)
    stats, spy = backfill(world)
    assert settings(world, fid) is None and spy.opens == [] and stats.examined == 0


def test_backfill_skips_unlinked_files(world):
    fid = pointer(world, "Equipment/SEM/a.tif", link=False)
    stats, spy = backfill(world)
    assert settings(world, fid) is None and spy.opens == []


def test_backfill_skips_files_that_have_settings(world):
    fid = pointer(world, "Equipment/SEM/a.tif")
    world.q(
        "SELECT save_sem_settings(%s, %s::jsonb, 'link')",
        (fid, json.dumps({"kv": 9.0, "sources": {"kv": "metadata"}})),
    )
    world.commit()
    stats, spy = backfill(world)
    assert spy.opens == [] and stats.examined == 0
    assert float(settings(world, fid)[0]) == 9.0  # not overwritten by the re-read


def test_backfill_skips_non_sem_images(world):
    plain = pointer(world, "Equipment/SEM/plain.png", png())
    strip = pointer(world, "Equipment/SEM/strip.tif", BAR_ONLY)
    stats, spy = backfill(world)
    assert settings(world, plain) is None and settings(world, strip) is None
    assert stats.not_sem == 2 and stats.saved == 0 and len(spy.opens) == 2


def test_a_document_or_a_scan_is_not_image_typed(world):
    pointer(world, "Equipment/notes.pdf", b"%PDF-1.4")
    pointer(world, "Equipment/scan.al3d", b"AL3D" * 10)
    stats, spy = backfill(world)
    assert spy.opens == [] and stats.examined == 0


def test_a_path_that_is_not_the_files_own_is_never_read(world):
    """metadata.archive_path is editable: a row whose id is not the uuid5 of its path is not read."""
    other = pointer(world, "Equipment/SEM/other.tif")
    fid = pointer(
        world,
        "Equipment/SEM/mine.tif",
        archive_path="Equipment/SEM/other.tif",
        write=False,
    )
    backfill(world)
    assert settings(world, fid) is None
    # the honest row was read; the lying one cost no read of its claimed path
    assert settings(world, other) is not None


@pytest.mark.parametrize(
    "bad", ["../etc/x.tif", "Equipment//x.tif", "a\\b.tif", "x.tif"]
)
def test_an_unclean_stored_path_is_never_read(world, bad):
    fid = str(uuid.uuid4())
    world.q(
        "INSERT INTO directus_files (id, storage, metadata) VALUES (%s, 'star', %s)",
        (fid, json.dumps({"archive_path": bad})),
    )
    world.q(
        "INSERT INTO sample_data_files (sample_id, directus_files_id) VALUES (gen_random_uuid(), %s)",
        (fid,),
    )
    world.commit()
    stats, spy = backfill(world)
    assert spy.opens == [] and settings(world, fid) is None


def test_backfill_only_opens_allowlisted_images_never_adopted(world):
    pointer(world, "Equipment/SEM/a.tif")
    pointer(world, "Equipment/SEM/b.JPG", png())
    pointer(world, "Equipment/notes.pdf", b"%PDF-1.4")
    _, spy = backfill(world)
    assert sorted(spy.opens) == ["Equipment/SEM/a.tif", "Equipment/SEM/b.JPG"]
    assert spy.adopted and not any(spy.adopted)


# ---- manual fields and merging (through the real function) ------------------------------------


def test_backfill_keeps_manual_fields(world):
    """A person links the file and corrects the kV while the back-fill is reading it: the manual value
    survives the back-fill's save."""
    fid = pointer(world, "Equipment/SEM/a.tif")
    spy = FlagSpy(fs_readonly.Share(world.root))
    real = spy.open_rb
    user = str(uuid.uuid4())

    def open_and_correct(rel, adopted=False):
        # the link-time save and the owner's correction land between the listing and the back-fill's save
        with psycopg2.connect(world.dsn) as other:
            with other.cursor() as cur:
                cur.execute(f"SET search_path = {world.schema}, public")
                cur.execute(
                    "SELECT save_sem_settings(%s, %s::jsonb, 'link')",
                    (fid, json.dumps({"kv": 2.0, "sources": {"kv": "metadata"}})),
                )
                cur.execute(
                    "SELECT correct_sem_setting(%s, 'kv', '7.5'::jsonb, %s)",
                    (fid, user),
                )
        return real(rel, adopted=adopted)

    spy.open_rb = open_and_correct
    backfill(world, spy=spy)
    kv, spot, _wd, _mag, detector, _mode, sources, _flags, _by = settings(world, fid)
    assert float(kv) == 7.5 and sources["kv"] == "manual"  # the correction survived
    assert (
        float(spot) == 3.5 and sources["spot"] == "metadata"
    )  # the rest was filled in
    assert detector == "ETD"


def test_a_run_without_ocr_does_not_erase_earlier_values(world):
    """The function merges: a re-read that carries fewer keys (no OCR, so no bar values) leaves the stored
    ones alone, and a key it does not carry keeps its source."""
    fid = pointer(world, "Equipment/SEM/a.tif", link=False)
    store = db.Store(world.conn)
    full = {
        "kv": 5.0,
        "spot": 3.0,
        "magnification": 5000,
        "hfw_um": 59.7,
        "sources": {
            "kv": "ocr",
            "spot": "ocr",
            "magnification": "ocr",
            "hfw_um": "ocr",
        },
        "flags": {"check_this": True},
    }
    assert store.save_sem_settings(fid, full, "backfill") is True
    partial = {"kv": 2.0, "sources": {"kv": "metadata"}}
    assert store.save_sem_settings(fid, partial, "backfill") is True
    kv, spot, _wd, mag, *_rest = settings(world, fid)
    assert float(kv) == 2.0 and float(spot) == 3.0 and mag == 5000
    sources = settings(world, fid)[6]
    assert sources == {
        "kv": "metadata",
        "spot": "ocr",
        "magnification": "ocr",
        "hfw_um": "ocr",
    }
    # nothing usable at all: the row is left exactly as it is
    before = settings(world, fid)
    assert store.save_sem_settings(fid, {"ocr_confidence": 0.9}, "backfill") is True
    assert settings(world, fid) == before


def test_a_sem_image_with_no_usable_value_writes_no_row_and_is_counted(world):
    """A FEI TIFF whose metadata has only the System/PrivateFei sections: the claim stands, the values are
    empty, the function writes no row, and the next run may try again (for example once OCR is on)."""
    text = "[System]\nType=SEM\n[PrivateFei]\nDatabarHeight=59\n"
    fid = pointer(world, "Equipment/SEM/bare.tif", make_fei_tiff(text=text).getvalue())
    stats, _ = backfill(world)
    assert settings(world, fid) is None
    assert stats.no_values == 1 and stats.saved == 0
    again, spy = backfill(world)
    assert again.no_values == 1 and len(spy.opens) == 1


# ---- resumable, unreadable, throttle, OCR -----------------------------------------------------


def test_backfill_is_resumable(world):
    fids = [pointer(world, f"Equipment/SEM/f{n}.tif") for n in range(4)]
    reads = []
    spy = FlagSpy(fs_readonly.Share(world.root))
    real = spy.open_rb

    def counting(rel, adopted=False):
        reads.append(rel)
        return real(rel, adopted=adopted)

    spy.open_rb = counting
    first, _ = backfill(
        world, spy=spy, stop=lambda: len(reads) >= 2
    )  # "killed" after two files
    assert first.saved == 2 and n_settings(world) == 2
    second, spy2 = backfill(world)
    assert second.saved == 2 and len(spy2.opens) == 2
    assert set(reads).isdisjoint(spy2.opens)  # the finished ones were not read again
    assert all(settings(world, f) is not None for f in fids)
    third, spy3 = backfill(world)
    assert third.examined == 0 and spy3.opens == []


def test_an_unreadable_file_is_logged_and_skipped_and_the_run_goes_on(world, caplog):
    bad = pointer(world, "Equipment/SEM/a_locked.tif")
    good = pointer(world, "Equipment/SEM/b_fine.tif")
    spy = FlagSpy(fs_readonly.Share(world.root))
    spy.fail[("open", "Equipment/SEM/a_locked.tif")] = PermissionError(13, "denied")
    with caplog.at_level(logging.INFO):
        stats, _ = backfill(world, spy=spy)
    assert stats.unreadable == 1 and stats.saved == 1
    assert settings(world, bad) is None and settings(world, good) is not None
    assert (
        "Equipment/SEM/a_locked.tif" in caplog.text and "PermissionError" in caplog.text
    )
    # one attempt per run, never a loop
    assert spy.opens.count("Equipment/SEM/a_locked.tif") == 1


def test_a_missing_or_flaky_file_is_skipped_and_picked_up_by_the_next_run(world):
    flaky = pointer(world, "Equipment/SEM/a_flaky.tif")
    gone = pointer(world, "Equipment/SEM/b_gone.tif")
    good = pointer(world, "Equipment/SEM/c_fine.tif")
    Path(world.root, "Equipment/SEM/b_gone.tif").unlink()
    spy = FlagSpy(fs_readonly.Share(world.root))
    spy.fail[("open", "Equipment/SEM/a_flaky.tif")] = OSError(errno.EIO, "io error")
    stats, _ = backfill(world, spy=spy)
    assert stats.unreadable == 2 and stats.saved == 1 and not stats.aborted
    assert settings(world, good) is not None
    assert settings(world, flaky) is None and settings(world, gone) is None
    world.write("Equipment/SEM/b_gone.tif", FEI)
    stats2, _ = backfill(world)
    assert stats2.saved == 2 and settings(world, flaky) is not None


def test_a_share_that_drops_mid_run_aborts_the_backfill(world, caplog):
    fids = [pointer(world, f"Equipment/SEM/f{n}.tif") for n in range(5)]
    spy = DropShare(fs_readonly.Share(world.root), world.root, 3)
    with caplog.at_level(logging.INFO):
        stats, _ = backfill(world, spy=spy)
    assert stats.aborted and stats.saved == 2
    assert sum(settings(world, f) is not None for f in fids) == 2
    assert "sem-backfill aborted" in caplog.text


def test_a_share_that_is_not_there_at_the_start_aborts_the_backfill(world):
    fid = pointer(world, "Equipment/SEM/a.tif")
    shutil.rmtree(world.root)
    stats, spy = backfill(world)
    assert stats.aborted and spy.opens == [] and settings(world, fid) is None


def test_consecutive_transient_failures_abort_the_backfill(world):
    spy = FlagSpy(fs_readonly.Share(world.root))
    fids = []
    for i in range(scan.MAX_CONSECUTIVE_FAILURES + 1):
        rel = f"Equipment/SEM/e{i:02d}.tif"
        fids.append(pointer(world, rel))
        spy.fail[("open", rel)] = OSError(errno.EIO, "io error")
    stats, _ = backfill(world, spy=spy)
    assert stats.aborted and len(spy.opens) == scan.MAX_CONSECUTIVE_FAILURES
    assert n_settings(world) == 0


def test_the_command_exits_one_when_the_share_drops_mid_run(env, monkeypatch):
    fids = [pointer(env, f"Equipment/SEM/f{n}.tif") for n in range(4)]
    real = fs_readonly.Share.open_rb
    seen = []

    def dropping(self, rel, adopted=False):
        seen.append(rel)
        if len(seen) == 2:
            shutil.rmtree(env.root)
        return real(self, rel, adopted=adopted)

    monkeypatch.setattr(fs_readonly.Share, "open_rb", dropping)
    assert cli.main(["--sem-backfill", "--root", env.root]) == 1
    assert sum(settings(env, f) is not None for f in fids) == 1


def test_reads_go_through_the_read_rate_throttle(world):
    pointer(world, "Equipment/SEM/a.tif")
    slept = []
    t = hashing.Throttle(1_000.0, clock=lambda: 0.0, sleep=slept.append)
    backfill(world, throttle=t)
    assert slept and sum(slept) > 0


def test_the_ocr_switch_is_passed_to_the_classifier(world, monkeypatch):
    pointer(world, "Equipment/SEM/a.tif")
    seen = []
    real = classify_sem.classify_image

    def spy(fh, **kw):
        seen.append(kw.get("ocr"))
        return real(fh, **kw)

    monkeypatch.setattr(classify_sem, "classify_image", spy)
    backfill(world, ocr=True, bar_reader=lambda *_a, **_k: None)
    assert seen == [True]


# ---- the command ------------------------------------------------------------------------------


@pytest.fixture
def env(world, monkeypatch):
    for k in ("D1_INBOX_URL", "D1_INBOX_CRAWLER_SECRET", "INBOX_OCR", "ARCHIVE_ROOT"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("DATABASE_URL", world.dsn)
    monkeypatch.setenv("INBOX_PRIVATE_SCHEMA", world.schema)
    return world


def test_sem_backfill_is_a_mode_exclusive_with_the_others(env):
    for other in ("--once", "--daemon", "--reclassify"):
        with pytest.raises(SystemExit) as e:
            cli.main(["--sem-backfill", other, "--root", env.root])
        assert e.value.code == 2


def test_the_command_writes_settings_and_logs_the_counts(env, caplog):
    fid = pointer(env, "Equipment/SEM/a.tif")
    pointer(env, "Equipment/SEM/plain.png", png())
    with caplog.at_level(logging.INFO):
        assert cli.main(["--sem-backfill", "--root", env.root]) == 0
    assert settings(env, fid) is not None
    assert (
        "sem-backfill: 1 saved" in caplog.text and "1 not an SEM image" in caplog.text
    )


def test_sem_backfill_refuses_when_another_crawler_holds_the_lock(env, caplog):
    fid = pointer(env, "Equipment/SEM/a.tif")
    other = psycopg2.connect(env.dsn)
    try:
        assert db.Store(other).try_crawler_lock()
        with caplog.at_level(logging.INFO):
            assert cli.main(["--sem-backfill", "--root", env.root]) == 1
        assert "another inbox crawler holds the database lock" in caplog.text
        assert settings(env, fid) is None
    finally:
        other.close()
    assert cli.main(["--sem-backfill", "--root", env.root]) == 0
    assert settings(env, fid) is not None


def test_the_command_reads_ocr_from_the_environment(env, monkeypatch):
    pointer(env, "Equipment/SEM/a.tif")
    seen = []
    real = maintenance.sem_backfill

    def spy(store, share, **kw):
        seen.append(kw.get("ocr"))
        return real(store, share, **kw)

    monkeypatch.setattr(maintenance, "sem_backfill", spy)
    monkeypatch.setenv("INBOX_OCR", "1")
    # no recogniser is installed here: classify_image logs it and reads the metadata only
    assert cli.main(["--sem-backfill", "--root", env.root]) == 0
    assert seen == [True]
