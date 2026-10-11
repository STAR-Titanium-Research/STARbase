"""scripts/file_fingerprints.py: the whole-file hash and the decoded-force-array hash (stage T0e).

Pure: no database. `.mat` fixtures are written into tmp_path, v5 with scipy and v7.3 with h5py
(HDF5 stores the MATLAB array transposed, behind a 512-byte header).
"""

import hashlib
import io
import struct
import sys
import threading
import time
from pathlib import Path

import numpy as np
import pytest

h5py = pytest.importorskip("h5py")
scipy_io = pytest.importorskip("scipy.io")

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import file_fingerprints as ff  # noqa: E402


def write_v73(path, name, a, *, chunks=None, matlab_class=None, **extra):
    """A MATLAB-v7.3-shaped file: 512-byte header, then HDF5 holding each array transposed.

    `chunks` (a (cols-side, rows-side) HDF5 chunk shape) makes the first array chunked and gzipped;
    `matlab_class` sets the MATLAB_class attribute on it (real MATLAB files carry one).
    """
    with h5py.File(path, "w", userblock_size=512) as f:
        kw = {"chunks": chunks, "compression": "gzip"} if chunks else {}
        ds = f.create_dataset(name, data=np.asarray(a).T, **kw)
        if matlab_class:
            ds.attrs["MATLAB_class"] = np.bytes_(matlab_class)
        for k, v in extra.items():
            f.create_dataset(k, data=np.asarray(v).T)
    with open(path, "r+b") as f:  # h5py leaves the userblock zeroed
        f.seek(0)
        f.write(b"MATLAB 7.3 MAT-file, Platform: test".ljust(512, b"\0"))


def reference(a):
    """The definition, written out with plain hashlib: shape header, then one digest per column."""
    a = np.asarray(a)
    h = hashlib.sha256(struct.pack("<QQ", a.shape[0], a.shape[1]))
    for j in range(a.shape[1]):
        h.update(hashlib.sha256(a[:, j].astype("<f8").tobytes()).digest())
    return h.hexdigest()


@pytest.fixture
def matrix():
    return np.random.default_rng(7).normal(size=(1000, 4))


def test_v5_and_v73_give_the_same_reference_hash(tmp_path, matrix):
    p5, p73 = tmp_path / "a5.mat", tmp_path / "a73.mat"
    scipy_io.savemat(p5, {"data": matrix})
    write_v73(p73, "data", matrix)
    h5_, var5, r5, c5 = ff.mat_data_sha256(p5)
    h73, var73, r73, c73 = ff.mat_data_sha256(p73)
    assert h5_ == h73 == reference(matrix)
    assert (var5, var73) == ("data", "data")
    assert (r5, c5) == (r73, c73) == (1000, 4)


def test_v73_signature_at_offset_zero_is_accepted(tmp_path, matrix):
    p = tmp_path / "plain.h5"
    with h5py.File(p, "w") as f:
        f.create_dataset("data", data=matrix.T)
    assert ff.mat_data_sha256(p)[0] == reference(matrix)


class Rec(ff.Throttle):
    """A throttle that records the byte counts it is asked to consume."""

    def __init__(self):
        super().__init__(None)
        self.seen = []

    def consume(self, n):
        self.seen.append(n)


def test_golden_vector(tmp_path):
    # 2x3 (MATLAB rows=2, cols=3): [[1,2,3],[4,5,6]]. The literal was computed once with plain
    # hashlib/struct from the definition; it is the vector for the force-file standard.
    a = np.array([[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]])
    want = "31b27bca76dc86c7f8dbefde8e1541e793a4f2bafa2cf515c536467986c318f4"
    assert reference(a) == want
    p5, p73 = tmp_path / "g5.mat", tmp_path / "g73.mat"
    scipy_io.savemat(p5, {"data": a})
    write_v73(p73, "data", a)
    assert ff.mat_data_sha256(p5)[0] == want
    assert ff.mat_data_sha256(p73)[0] == want


def test_hdf5_streams_all_columns_per_block_in_one_pass(tmp_path, matrix):
    p = tmp_path / "a73.mat"
    write_v73(p, "data", matrix)
    rec = Rec()
    # 96 bytes = 3 samples of all 4 columns per block (one float64 each)
    h, _, _, _ = ff.mat_data_sha256(p, block_bytes=96, throttle=rec)
    assert h == reference(matrix)
    assert max(rec.seen) == 96 and len(rec.seen) == 1000 // 3 + 1
    assert sum(rec.seen) == matrix.size * 8


def test_hdf5_block_is_rounded_to_whole_chunk_widths(tmp_path, matrix):
    p = tmp_path / "chunked.mat"
    write_v73(p, "data", matrix, chunks=(4, 100))  # every chunk holds all 4 columns x 100 samples
    rec = Rec()
    h, _, _, _ = ff.mat_data_sha256(p, block_bytes=8, throttle=rec)  # asks for less than a chunk
    assert h == reference(matrix)
    assert rec.seen == [4 * 100 * 8] * 10  # one chunk width per block: each chunk is decoded once
    rec = Rec()
    ff.mat_data_sha256(p, block_bytes=4 * 250 * 8, throttle=rec)  # 250 samples -> rounds down to 200
    assert rec.seen == [4 * 200 * 8] * 5


def test_int16_hashes_as_float64(tmp_path):
    ints = np.arange(40, dtype=np.int16).reshape(10, 4) - 20
    p5, p73 = tmp_path / "i5.mat", tmp_path / "i73.mat"
    scipy_io.savemat(p5, {"data": ints})
    write_v73(p73, "data", ints)
    want = reference(ints.astype(float))
    assert ff.mat_data_sha256(p5)[0] == want
    assert ff.mat_data_sha256(p73)[0] == want


@pytest.mark.parametrize("writer", ["v5", "v73"])
def test_data_is_preferred_over_DATA_and_DATA_is_the_fallback(tmp_path, writer):
    lower, upper = np.ones((5, 2)), np.full((5, 2), 2.0)

    def make(path, **arrays):
        if writer == "v5":
            scipy_io.savemat(path, arrays)
        else:
            (n0, a0), *rest = arrays.items()
            write_v73(path, n0, a0, **dict(rest))

    both, only = tmp_path / "both.mat", tmp_path / "only.mat"
    make(both, data=lower, DATA=upper)
    make(only, DATA=upper)
    h, var, _, _ = ff.mat_data_sha256(both)
    assert (h, var) == (reference(lower), "data")
    h, var, _, _ = ff.mat_data_sha256(only)
    assert (h, var) == (reference(upper), "DATA")


@pytest.mark.parametrize("writer", ["v5", "v73"])
def test_no_force_array_raises(tmp_path, writer):
    p = tmp_path / "none.mat"
    if writer == "v5":
        scipy_io.savemat(p, {"other": np.ones((3, 3))})
    else:
        write_v73(p, "other", np.ones((3, 3)))
    with pytest.raises(ff.NoForceArray):
        ff.mat_data_sha256(p)


@pytest.mark.parametrize("writer", ["v5", "v73"])
def test_three_dimensional_array_raises(tmp_path, writer):
    p = tmp_path / "3d.mat"
    cube = np.ones((3, 4, 2))
    if writer == "v5":
        scipy_io.savemat(p, {"data": cube})
    else:
        write_v73(p, "data", cube)
    with pytest.raises(ff.BadForceArray):
        ff.mat_data_sha256(p)


def test_non_numeric_array_raises(tmp_path):
    p5, p73 = tmp_path / "s5.mat", tmp_path / "s73.mat"
    scipy_io.savemat(p5, {"data": np.array([["a", "b"], ["c", "d"]])})
    with h5py.File(p73, "w", userblock_size=512) as f:
        f.create_dataset("data", data=np.array([[b"a", b"b"], [b"c", b"d"]]))
    for p in (p5, p73):
        with pytest.raises(ff.BadForceArray):
            ff.mat_data_sha256(p)


def test_text_file_named_mat_is_unreadable(tmp_path):
    p = tmp_path / "notes.mat"
    p.write_text("this is not a MATLAB file\n" * 50)
    with pytest.raises(ff.UnreadableMat):
        ff.mat_data_sha256(p)


def test_corrupt_hdf5_is_unreadable(tmp_path, matrix):
    p = tmp_path / "bad73.mat"
    write_v73(p, "data", matrix)
    raw = p.read_bytes()
    p.write_bytes(raw[:600])  # signature intact, superblock/data cut off
    with pytest.raises(ff.UnreadableMat):
        ff.mat_data_sha256(p)


def test_missing_file_is_an_oserror_not_unreadable(tmp_path):
    with pytest.raises(OSError):
        ff.mat_data_sha256(tmp_path / "gone.mat")


def test_metadata_only_change_keeps_data_hash_but_not_content_hash(tmp_path, matrix):
    a, b = tmp_path / "a.mat", tmp_path / "b.mat"
    scipy_io.savemat(a, {"data": matrix})
    scipy_io.savemat(b, {"data": matrix, "info": np.array([1.0, 2.0])})
    assert ff.mat_data_sha256(a)[0] == ff.mat_data_sha256(b)[0]
    assert ff.content_sha256(a)[0] != ff.content_sha256(b)[0]


def test_content_sha256_path_and_stream(tmp_path):
    payload = bytes(range(256)) * 1000
    p = tmp_path / "blob.bin"
    p.write_bytes(payload)
    want = hashlib.sha256(payload).hexdigest()
    assert ff.content_sha256(p) == (want, len(payload))
    assert ff.content_sha256(str(p), chunk=1000) == (want, len(payload))
    assert ff.content_sha256(io.BytesIO(payload), chunk=4096) == (want, len(payload))


def test_content_sha256_uses_the_throttle(tmp_path):
    p = tmp_path / "blob.bin"
    p.write_bytes(b"x" * 2500)
    seen = []

    class Rec(ff.Throttle):
        def consume(self, n):
            seen.append(n)

    ff.content_sha256(p, chunk=1000, throttle=Rec(None))
    assert seen == [1000, 1000, 500]


def test_unlimited_throttle_never_sleeps(monkeypatch):
    monkeypatch.setattr(time, "sleep", lambda s: pytest.fail("slept"))
    t = ff.Throttle(None)
    for _ in range(100):
        t.consume(10**9)


def test_throttle_caps_the_rate_across_threads():
    t = ff.Throttle(1000)  # bytes per second
    t0 = time.monotonic()
    threads = [threading.Thread(target=t.consume, args=(1500,)) for _ in range(2)]
    for th in threads:
        th.start()
    for th in threads:
        th.join()
    took = time.monotonic() - t0
    assert 1.8 <= took < 5  # 3000 bytes at 1000 B/s: each caller waits out its own bytes: 1.5 s, then 3 s


@pytest.mark.parametrize("compress", [False, True])
def test_truncated_v5_is_unreadable(tmp_path, matrix, compress):
    p = tmp_path / "cut.mat"
    scipy_io.savemat(p, {"data": matrix}, do_compression=compress)
    raw = p.read_bytes()
    p.write_bytes(raw[: len(raw) * 6 // 10])
    with pytest.raises(ff.UnreadableMat):
        ff.mat_data_sha256(p)


def test_hdf5_read_error_after_open_is_retryable_oserror(tmp_path, matrix, monkeypatch):
    p = tmp_path / "a73.mat"
    write_v73(p, "data", matrix)
    real = h5py.Dataset.__getitem__

    def flaky(self, args):
        if isinstance(args, tuple) and len(args) == 2 and args != ():
            raise OSError("Can't read data (filter returned failure)")  # errno None, as h5py raises it
        return real(self, args)

    monkeypatch.setattr(h5py.Dataset, "__getitem__", flaky)
    with pytest.raises(OSError) as ei:
        ff.mat_data_sha256(p)
    assert not isinstance(ei.value, ff.FingerprintError)


@pytest.mark.parametrize("cls", ["double", "single", "int8", "uint16", "int64", "uint64", "logical"])
def test_v73_matlab_numeric_classes_are_accepted(tmp_path, cls):
    a = np.arange(12).reshape(3, 4) % 2
    p = tmp_path / "c.mat"
    write_v73(p, "data", a.astype("uint8" if cls == "logical" else cls), matlab_class=cls)
    assert ff.mat_data_sha256(p)[0] == reference(a)


def test_v73_char_array_is_rejected(tmp_path):
    p = tmp_path / "char.mat"
    write_v73(p, "data", np.array([[72, 105]], dtype="uint16"), matlab_class="char")  # char is uint16
    with pytest.raises(ff.BadForceArray):
        ff.mat_data_sha256(p)


def test_empty_array_hashes_alike_in_v5_and_v73(tmp_path):
    p5, p73 = tmp_path / "e5.mat", tmp_path / "e73.mat"
    scipy_io.savemat(p5, {"data": np.zeros((0, 3))})
    with h5py.File(p73, "w", userblock_size=512) as f:  # the way MATLAB writes an empty: its dimensions
        ds = f.create_dataset("data", data=np.array([0, 3], dtype="uint64"))
        ds.attrs["MATLAB_class"] = np.bytes_("double")
        ds.attrs["MATLAB_empty"] = np.uint32(1)
    with open(p73, "r+b") as f:
        f.write(b"MATLAB 7.3 MAT-file".ljust(512, b"\0"))
    h5_, _, r5, c5 = ff.mat_data_sha256(p5)
    h73, var, r73, c73 = ff.mat_data_sha256(p73)
    assert (r5, c5) == (r73, c73) == (0, 3)
    assert h5_ == h73 == "1dd0b17c4d187f22eb8028162fca71c9d2e0e2d6942070f9061ebaf842b8b503"
    assert var == "data"


# ======================================================================================
# The runner: selection, paths, per-file hashing, resumability (database + temp "share")
#
# The runner opens its own connection per worker, so its tests need committed rows. They get
# them in a throwaway schema (unique name, created and dropped per test, PGOPTIONS pointing every
# connection at it), which leaks nothing into the migrated database and leaves it untouched. The
# `directus_files` of a migrated database is a one-column stub (Directus owns the real table), so
# the schema carries a stand-in with the columns the runner reads; `file_fingerprints` is built
# from the real migration. The "share" is a directory under tmp_path.
# ======================================================================================

import contextlib  # noqa: E402
import datetime as dt  # noqa: E402
import json  # noqa: E402
import os  # noqa: E402
import shutil  # noqa: E402
import uuid  # noqa: E402

DSN = os.environ.get("DATABASE_URL")
MIGRATION = Path(__file__).resolve().parents[2] / "db/migrations/20261010000159_file_fingerprints.sql"
ROW_COLUMNS = ("status", "content_sha256", "data_sha256", "data_variable", "data_rows", "data_cols",
               "size_bytes", "source_mtime", "error_message")
T0 = dt.datetime(2025, 3, 1, 12, 0, tzinfo=dt.UTC)


def migration_up_sql() -> str:
    return MIGRATION.read_text(encoding="utf-8").split("-- migrate:up", 1)[1].split("-- migrate:down", 1)[0]


class Db:
    """Test-side handle: a connection in the throwaway schema plus helpers to add files."""

    def __init__(self, conn, root):
        self.conn, self.root = conn, root
        self.cur = conn.cursor()

    def path(self, rel):
        return os.path.join(self.root, *rel.split("/"))

    def add_file(self, rel, content=b"hello", *, linked="operation", storage="star", write=True, **kw):
        """Register a pointer row (and write the bytes under the share root unless write=False)."""
        if write:
            os.makedirs(os.path.dirname(self.path(rel)), exist_ok=True)
            with open(self.path(rel), "wb") as f:
                f.write(content)
        fid = kw.pop("id", str(uuid.uuid4()))
        size = kw.pop("filesize", len(content))
        modified = kw.pop("modified", T0.isoformat())
        disk = kw.pop("filename_disk", fid)
        modified_on = kw.pop("modified_on", dt.datetime(2025, 1, 1, tzinfo=dt.UTC))
        assert not kw, kw
        meta = {"archive_path": rel, "modified": modified} if storage == "star" else {}
        self.cur.execute(
            "INSERT INTO directus_files (id, storage, filename_disk, filename_download, filesize, "
            "modified_on, metadata) VALUES (%s, %s, %s, %s, %s, %s, %s)",
            (fid, storage, disk, rel.rsplit("/", 1)[-1], size, modified_on, json.dumps(meta)),
        )
        if linked == "operation":
            self.cur.execute("INSERT INTO operation_data_files (operation_id, directus_files_id) VALUES (%s, %s)",
                             (str(uuid.uuid4()), fid))
        elif linked == "force_analysis":
            self.cur.execute("INSERT INTO machining_force_analysis (directus_files_id) VALUES (%s)", (fid,))
        self.conn.commit()
        return fid

    def update(self, fid, **cols):
        sets = ", ".join(f"{k} = %s" for k in cols)
        self.cur.execute(f"UPDATE directus_files SET {sets} WHERE id = %s", (*cols.values(), fid))
        self.conn.commit()

    def set_modified(self, fid, iso):
        self.cur.execute(
            "UPDATE directus_files SET metadata = (metadata::jsonb || jsonb_build_object('modified', %s::text))::json "
            "WHERE id = %s", (iso, fid))
        self.conn.commit()

    def row(self, fid):
        self.cur.execute(f"SELECT {', '.join(ROW_COLUMNS)} FROM file_fingerprints WHERE directus_files_id = %s", (fid,))
        r = self.cur.fetchone()
        self.conn.commit()
        return None if r is None else dict(zip(ROW_COLUMNS, r))

    def count(self):
        self.cur.execute("SELECT count(*) FROM file_fingerprints")
        n = self.cur.fetchone()[0]
        self.conn.commit()
        return n

    def selected(self, phase="linked", include_local=False, retry_failed=True, limit=None):
        jobs = ff.select_files(self.cur, phase, include_local, retry_failed, limit)
        self.conn.commit()
        return jobs


@pytest.fixture
def db(tmp_path, monkeypatch):
    psycopg2 = pytest.importorskip("psycopg2")
    if not DSN:
        pytest.skip("DATABASE_URL not set")
    try:
        admin = psycopg2.connect(DSN)
    except psycopg2.OperationalError:
        pytest.skip("database not reachable")
    monkeypatch.setattr(ff, "_sleep", lambda s: None)  # no real backoff waits in tests
    schema = "ff_test_" + uuid.uuid4().hex[:8]
    admin.autocommit = True
    acur = admin.cursor()
    acur.execute(f"CREATE SCHEMA {schema}")
    monkeypatch.setenv("PGOPTIONS", f"-c search_path={schema}")  # every connection, ours and the runner's
    monkeypatch.setenv("DATABASE_URL", DSN)
    root = tmp_path / "share"
    root.mkdir()
    conn = psycopg2.connect(DSN)
    try:
        cur = conn.cursor()
        cur.execute(
            "CREATE TABLE directus_files (id uuid PRIMARY KEY, storage text NOT NULL, filename_disk text, "
            "filename_download text, filesize bigint, modified_on timestamptz, metadata json)")
        for t, parent in (("operation_data_files", "operation_id"), ("sample_data_files", "sample_id"),
                          ("session_data_files", "session_id")):
            cur.execute(f"CREATE TABLE {t} ({parent} uuid NOT NULL, directus_files_id uuid NOT NULL "
                        "REFERENCES directus_files(id) ON DELETE CASCADE)")
        cur.execute(
            "CREATE TABLE machining_force_analysis (id serial PRIMARY KEY, directus_files_id uuid NOT NULL "
            "UNIQUE REFERENCES directus_files(id) ON DELETE CASCADE, "
            "live_cache_file uuid REFERENCES directus_files(id), render_file uuid REFERENCES directus_files(id))")
        cur.execute(migration_up_sql())
        conn.commit()
        yield Db(conn, str(root))
    finally:
        conn.rollback()
        conn.close()
        acur.execute(f"DROP SCHEMA {schema} CASCADE")
        admin.close()


def run(db, *args):
    return ff.main(["--archive-root", db.root, *args])


def write_v5(path, a):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    scipy_io.savemat(str(path), {"data": a})


def sha(b):
    return hashlib.sha256(b).hexdigest()


# ---- pure helpers -------------------------------------------------------------------


def make_job(**kw):
    base = dict(id="i", storage="star", archive_path="a/b/c.txt", filename_disk="uuid-name",
                filename_download="c.txt", size_bytes=1, source_mtime=None)
    base.update(kw)
    return ff.FileJob(**base)


def test_resolve_path_joins_the_archive_path_under_the_root_never_filename_disk():
    p = ff.resolve_path(make_job(), "/root")
    assert p == os.path.join("/root", "a", "b", "c.txt")
    assert "uuid-name" not in p


def test_resolve_path_refuses_dotdot_and_a_missing_archive_path():
    with pytest.raises(ValueError):
        ff.resolve_path(make_job(archive_path="a/../../etc/passwd"), "/root")
    with pytest.raises(ValueError):
        ff.resolve_path(make_job(archive_path=None), "/root")


def test_resolve_path_for_local_files_is_the_path_inside_the_directus_container():
    assert ff.resolve_path(make_job(storage="local", filename_disk="abc.mat"), "/root") == "/directus/uploads/abc.mat"


def test_default_archive_root_is_the_unc_path_of_the_orchestrator(monkeypatch):
    monkeypatch.delenv("ARCHIVE_UNC", raising=False)
    assert ff.default_archive_root() == r"\\uosfstore.shef.ac.uk\shared\star_group1"
    monkeypatch.setenv("ARCHIVE_UNC", "/elsewhere")
    assert ff.default_archive_root() == "/elsewhere"


# ---- 1. a linked .mat and a .txt are fingerprinted -----------------------------------


def test_linked_mat_and_txt_get_done_rows(db, matrix):
    write_v5(db.path("Proj/run1.mat"), matrix)
    mat = db.add_file("Proj/run1.mat", write=False, filesize=os.path.getsize(db.path("Proj/run1.mat")))
    txt = db.add_file("Proj/notes.txt", b"some notes\n")

    assert run(db, "--phase", "linked") == 0

    m = db.row(mat)
    assert m["status"] == "done" and m["error_message"] is None
    with open(db.path("Proj/run1.mat"), "rb") as f:
        assert m["content_sha256"] == sha(f.read())
    assert (m["data_sha256"], m["data_variable"], m["data_rows"], m["data_cols"]) == (
        reference(matrix), "data", 1000, 4)
    t = db.row(txt)
    assert t["status"] == "done" and t["content_sha256"] == sha(b"some notes\n")
    assert (t["data_sha256"], t["data_variable"], t["data_rows"], t["data_cols"]) == (None, None, None, None)


def test_mat_is_recognised_by_extension_case_insensitively(db, matrix):
    write_v5(db.path("p/UP.MAT"), matrix)
    fid = db.add_file("p/UP.MAT", write=False, filesize=os.path.getsize(db.path("p/UP.MAT")))
    assert run(db, "--phase", "linked") == 0
    assert db.row(fid)["data_sha256"] == reference(matrix)


def test_the_stored_staleness_key_is_what_the_database_said_not_the_disk(db):
    when = dt.datetime(2020, 5, 5, 5, 5, tzinfo=dt.UTC)
    fid = db.add_file("p/a.txt", b"abc", filesize=999, modified=when.isoformat())  # DB disagrees with the disk
    assert run(db, "--phase", "linked") == 0
    r = db.row(fid)
    assert r["size_bytes"] == 999 and r["source_mtime"] == when
    assert db.selected() == []  # so it is not stale on the next look


def test_source_mtime_falls_back_to_modified_on_without_metadata_modified(db):
    fid = db.add_file("p/a.txt", b"abc")
    db.cur.execute("UPDATE directus_files SET metadata = %s WHERE id = %s",
                   (json.dumps({"archive_path": "p/a.txt"}), fid))
    db.update(fid, modified_on=dt.datetime(2024, 2, 2, tzinfo=dt.UTC))
    assert run(db, "--phase", "linked") == 0
    assert db.row(fid)["source_mtime"] == dt.datetime(2024, 2, 2, tzinfo=dt.UTC)


# ---- 2/3. resumable and staleness -----------------------------------------------------


def test_a_second_run_selects_nothing_and_rewrites_nothing(db):
    db.add_file("p/a.txt", b"abc")
    assert run(db, "--phase", "linked") == 0
    assert db.selected() == []
    db.cur.execute("SELECT max(hashed_at) FROM file_fingerprints")
    before = db.cur.fetchone()[0]
    db.conn.commit()
    assert run(db, "--phase", "linked") == 0
    db.cur.execute("SELECT max(hashed_at), count(*) FROM file_fingerprints")
    assert db.cur.fetchone() == (before, 1)


def test_a_changed_filesize_or_metadata_modified_makes_it_stale_but_modified_on_does_not(db):
    fid = db.add_file("p/a.txt", b"abc")
    assert run(db, "--phase", "linked") == 0
    first = db.row(fid)["content_sha256"]

    db.update(fid, modified_on=dt.datetime(2030, 1, 1, tzinfo=dt.UTC))  # only modified_on: not stale
    assert db.selected() == []

    db.set_modified(fid, dt.datetime(2026, 1, 1, tzinfo=dt.UTC).isoformat())  # metadata.modified: stale
    assert [j.id for j in db.selected()] == [fid]
    db.set_modified(fid, T0.isoformat())
    assert db.selected() == []

    with open(db.path("p/a.txt"), "wb") as f:
        f.write(b"abcdef")
    db.update(fid, filesize=6)  # filesize: stale, and re-hashed to the new content
    assert [j.id for j in db.selected()] == [fid]
    assert run(db, "--phase", "linked") == 0
    r = db.row(fid)
    assert r["content_sha256"] == sha(b"abcdef") != first and r["size_bytes"] == 6


# ---- 4. missing, retried until present -----------------------------------------------


def test_missing_path_is_marked_missing_retried_and_then_done(db):
    fid = db.add_file("p/later.txt", b"arrives", write=False)
    assert run(db, "--phase", "linked") == 0
    r = db.row(fid)
    assert r["status"] == "missing" and r["content_sha256"] is None and r["error_message"]

    assert [j.id for j in db.selected(retry_failed=True)] == [fid]  # the next run retries it
    assert db.selected(retry_failed=False) == []  # --skip-failed leaves it alone
    assert run(db, "--phase", "linked", "--skip-failed") == 0
    assert db.row(fid)["status"] == "missing"

    os.makedirs(os.path.dirname(db.path("p/later.txt")))
    with open(db.path("p/later.txt"), "wb") as f:
        f.write(b"arrives")
    assert run(db, "--phase", "linked") == 0
    r = db.row(fid)
    assert r["status"] == "done" and r["content_sha256"] == sha(b"arrives") and r["error_message"] is None


# ---- 5. broken .mat -> error, hash kept, sorted to the back --------------------------


def test_broken_mat_is_an_error_row_that_keeps_the_content_hash_and_goes_to_the_back(db):
    bad = db.add_file("p/broken.mat", b"this is not a mat file")
    assert run(db, "--phase", "linked") == 0
    r = db.row(bad)
    assert r["status"] == "error" and r["error_message"]
    assert r["content_sha256"] == sha(b"this is not a mat file") and r["data_sha256"] is None

    fresh = db.add_file("p/fresh.txt", b"new")
    assert [j.id for j in db.selected(retry_failed=True)] == [fresh, bad]  # never-tried first


def test_a_mat_without_a_force_array_is_an_error_not_a_crash(db):
    os.makedirs(os.path.dirname(db.path("p/nodata.mat")))
    scipy_io.savemat(db.path("p/nodata.mat"), {"other": np.ones((2, 2))})
    fid = db.add_file("p/nodata.mat", write=False, filesize=os.path.getsize(db.path("p/nodata.mat")))
    assert run(db, "--phase", "linked") == 0
    r = db.row(fid)
    assert r["status"] == "error" and "data" in r["error_message"] and r["content_sha256"]


# ---- 6. phases -----------------------------------------------------------------------


def test_phase_linked_ignores_unlinked_files_and_all_takes_them(db):
    linked = db.add_file("p/l.txt", b"l", linked="operation")
    via_analysis = db.add_file("p/f.txt", b"f", linked="force_analysis")
    unlinked = db.add_file("p/u.txt", b"u", linked=None)

    assert {j.id for j in db.selected("linked")} == {linked, via_analysis}
    assert run(db, "--phase", "linked") == 0
    assert db.row(unlinked) is None
    assert run(db, "--phase", "all") == 0
    assert db.row(unlinked)["status"] == "done"


def test_the_cache_files_of_a_force_analysis_are_not_linked_source_files(db):
    src = db.add_file("p/src.mat", b"x", linked="force_analysis", write=False)
    cache = db.add_file("p/cache.bin", b"c", linked=None)
    db.cur.execute("UPDATE machining_force_analysis SET live_cache_file = %s, render_file = %s", (cache, cache))
    db.conn.commit()
    assert [j.id for j in db.selected("linked")] == [src]


def test_linked_covers_every_junction_and_local_files_need_include_local(db):
    a = db.add_file("p/a.txt", b"a", linked=None)
    b = db.add_file("p/b.txt", b"b", linked=None)
    loc = db.add_file("p/c.bin", b"c", linked=None, storage="local", write=False)
    db.cur.execute("INSERT INTO sample_data_files VALUES (%s, %s)", (str(uuid.uuid4()), a))
    db.cur.execute("INSERT INTO session_data_files VALUES (%s, %s)", (str(uuid.uuid4()), b))
    db.cur.execute("INSERT INTO operation_data_files VALUES (%s, %s)", (str(uuid.uuid4()), loc))
    db.conn.commit()
    assert {j.id for j in db.selected("linked")} == {a, b}
    assert {j.id for j in db.selected("linked", include_local=True)} == {a, b, loc}


def test_selected_jobs_carry_the_database_values(db):
    fid = db.add_file("p/a.txt", b"abc", filesize=5)
    (j,) = db.selected()
    assert (j.id, j.storage, j.archive_path, j.filename_download, j.size_bytes) == (fid, "star", "p/a.txt", "a.txt", 5)
    assert j.source_mtime == T0


def test_limit_caps_the_queue(db):
    for i in range(4):
        db.add_file(f"p/{i}.txt", b"x")
    assert len(db.selected(limit=3)) == 3
    assert run(db, "--phase", "linked", "--limit", "2") == 0
    assert db.count() == 2


# ---- 7/8. share health ---------------------------------------------------------------


def test_missing_archive_root_exits_2_and_writes_nothing(db, capsys):
    db.add_file("p/a.txt", b"abc")
    shutil.rmtree(db.root)
    assert run(db, "--phase", "linked") == 2
    assert db.count() == 0
    assert "archive root" in capsys.readouterr().err


def test_five_consecutive_missing_with_the_share_gone_exits_2_and_marks_nothing(db, monkeypatch):
    ids = [db.add_file(f"p/f{i}.txt", b"x") for i in range(7)]
    real = ff.fingerprint_job
    calls = []

    def drop_the_share_after_the_first(*a, **kw):
        out = real(*a, **kw)
        if not calls:
            shutil.rmtree(db.root)  # the share disappears after the first file
        calls.append(1)
        return out

    monkeypatch.setattr(ff, "fingerprint_job", drop_the_share_after_the_first)
    assert run(db, "--phase", "linked") == 2
    rows = [db.row(i) for i in ids]
    assert [r["status"] for r in rows if r] == ["done"]  # only the first file was written
    assert len(calls) == 6  # the sixth call is the fifth missing one; the run stops there


def test_five_missing_files_with_the_share_present_are_marked_missing_and_the_run_goes_on(db):
    gone = [db.add_file(f"p/gone{i}.txt", b"x", write=False) for i in range(6)]
    there = db.add_file("p/there.txt", b"x")
    assert run(db, "--phase", "linked") == 0
    assert [db.row(i)["status"] for i in gone] == ["missing"] * 6
    assert db.row(there)["status"] == "done"


def test_fewer_than_five_missing_at_the_end_are_marked_when_the_share_is_still_there(db):
    gone = db.add_file("p/gone.txt", b"x", write=False)
    assert run(db, "--phase", "linked") == 0
    assert db.row(gone)["status"] == "missing"


def test_pending_missing_files_are_not_marked_when_the_share_is_gone_at_the_end(db, monkeypatch):
    gone = db.add_file("p/gone.txt", b"x", write=False)
    real = ff.fingerprint_job

    def then_drop_the_share(*a, **kw):
        out = real(*a, **kw)
        shutil.rmtree(db.root)
        return out

    monkeypatch.setattr(ff, "fingerprint_job", then_drop_the_share)
    assert run(db, "--phase", "linked") == 2
    assert db.row(gone) is None


# ---- 9. the provisional row ----------------------------------------------------------


class Boom(BaseException):
    pass


def test_provisional_row_survives_a_hard_crash(db, monkeypatch):
    fid = db.add_file("p/a.mat", b"whatever")

    def crash(*a, **kw):
        raise Boom()

    monkeypatch.setattr(ff, "mat_data_sha256", crash)
    with pytest.raises(Boom):
        run(db, "--phase", "linked")
    r = db.row(fid)
    assert r["status"] == "error" and r["error_message"] == "hashing started"
    assert r["size_bytes"] == len(b"whatever") and r["source_mtime"] == T0
    assert r["content_sha256"] is None
    assert [j.id for j in db.selected()] == [fid]  # and it is picked up again next run


# ---- 10. dry run ---------------------------------------------------------------------


def test_dry_run_reads_nothing_writes_nothing_and_reports_existence(db, monkeypatch, capsys):
    db.add_file("p/here.txt", b"abc")
    db.add_file("p/gone.txt", b"x", write=False)

    def no_reads(*a, **kw):
        raise AssertionError("a dry run must not read file content")

    monkeypatch.setattr(ff, "content_sha256", no_reads)
    monkeypatch.setattr(ff, "mat_data_sha256", no_reads)
    assert run(db, "--phase", "linked", "--dry-run") == 0
    out = capsys.readouterr().out
    assert db.count() == 0
    assert db.path("p/here.txt") in out and db.path("p/gone.txt") in out
    assert "exists" in out and "missing" in out
    assert "2 files" in out and "1 of 2 paths exist" in out


# ---- per-file behaviour: retries, changes while hashing ------------------------------


def test_oserror_is_retried_with_backoff_then_succeeds(db, monkeypatch):
    fid = db.add_file("p/a.txt", b"abc")
    real, fails, waits = ff.content_sha256, [2], []

    def flaky(*a, **kw):
        if fails[0]:
            fails[0] -= 1
            raise OSError("share hiccup")
        return real(*a, **kw)

    monkeypatch.setattr(ff, "content_sha256", flaky)
    monkeypatch.setattr(ff, "_sleep", waits.append)
    assert run(db, "--phase", "linked") == 0
    assert db.row(fid)["status"] == "done" and waits == [2, 4]


def test_oserror_every_time_gives_up_after_three_retries_as_an_error_row(db, monkeypatch):
    fid = db.add_file("p/a.mat", b"abc")
    waits, attempts = [], []

    def corrupt_chunk(*a, **kw):
        attempts.append(1)
        raise OSError("wrong B-tree signature")

    monkeypatch.setattr(ff, "mat_data_sha256", corrupt_chunk)
    monkeypatch.setattr(ff, "_sleep", waits.append)
    assert run(db, "--phase", "linked") == 0
    r = db.row(fid)
    assert r["status"] == "error" and "B-tree" in r["error_message"]
    assert r["content_sha256"] == sha(b"abc")
    assert waits == [2, 4, 8] and len(attempts) == 4


def test_a_file_that_changes_while_it_is_hashed_is_left_as_a_provisional_error(db, monkeypatch):
    fid = db.add_file("p/a.txt", b"abc")
    real = ff.content_sha256

    def touch_then_hash(path, *a, **kw):
        out = real(path, *a, **kw)
        with open(path, "ab") as f:
            f.write(b"more")  # a writer got there while we were reading
        return out

    monkeypatch.setattr(ff, "content_sha256", touch_then_hash)
    assert run(db, "--phase", "linked") == 0
    r = db.row(fid)
    assert r["status"] == "error" and r["error_message"] == "file changed while hashing"
    assert r["content_sha256"] is None  # no hash is trusted from a file that moved


def test_missing_archive_path_is_an_error_row(db):
    fid = db.add_file("p/a.txt", b"abc")
    db.cur.execute("UPDATE directus_files SET metadata = '{}' WHERE id = %s", (fid,))
    db.conn.commit()
    assert run(db, "--phase", "linked") == 0
    r = db.row(fid)
    assert r["status"] == "error" and "archive_path" in r["error_message"]


def test_an_unexpected_exception_is_recorded_and_the_run_goes_on(db, monkeypatch):
    bad = db.add_file("p/a.txt", b"abc")
    good = db.add_file("p/b.txt", b"def")
    real = ff.content_sha256

    def sometimes(path, *a, **kw):
        if str(path).endswith("a.txt"):
            raise RuntimeError("surprise")
        return real(path, *a, **kw)

    monkeypatch.setattr(ff, "content_sha256", sometimes)
    assert run(db, "--phase", "linked") == 0
    assert db.row(bad)["status"] == "error" and "surprise" in db.row(bad)["error_message"]
    assert db.row(good)["status"] == "done"


def test_a_file_deleted_from_directus_mid_run_is_skipped(db, monkeypatch):
    gone = db.add_file("p/a.txt", b"abc")
    other = db.add_file("p/b.txt", b"def")
    real = ff.fingerprint_job

    def delete_the_row_first(j, *a, **kw):
        if j.id == gone:
            db.cur.execute("DELETE FROM directus_files WHERE id = %s", (gone,))
            db.conn.commit()
        return real(j, *a, **kw)

    monkeypatch.setattr(ff, "fingerprint_job", delete_the_row_first)
    assert run(db, "--phase", "linked") == 0
    assert db.row(gone) is None and db.row(other)["status"] == "done"


def test_two_workers_share_the_queue(db):
    ids = [db.add_file(f"p/{i}.txt", f"content {i}".encode()) for i in range(12)]
    assert run(db, "--phase", "linked", "--workers", "2") == 0
    assert all(db.row(i)["status"] == "done" for i in ids)


def test_progress_lines_and_final_summary_are_printed(db, capsys):
    for i in range(11):
        db.add_file(f"p/{i}.txt", b"x" * 100)
    assert run(db, "--phase", "linked", "--max-mb-s", "100") == 0
    out = capsys.readouterr().out
    assert "[10/11]" in out
    assert "11 done, 0 error, 0 missing" in out.splitlines()[-1]


def test_throttle_is_shared_and_applied(db, monkeypatch):
    db.add_file("p/a.txt", b"x" * 1000)
    seen = []
    real = ff.Throttle.consume
    monkeypatch.setattr(ff.Throttle, "consume", lambda self, n: (seen.append((self.rate, n)), real(self, n))[1])
    assert run(db, "--phase", "linked", "--max-mb-s", "50") == 0
    assert seen and all(r == 50e6 for r, _ in seen) and sum(n for _, n in seen) == 1000


# ---- local storage (the Directus container), without Docker --------------------------


def test_local_files_are_streamed_from_the_container_and_mats_hashed_via_a_temp_file(db, monkeypatch, matrix, tmp_path):
    import io as _io

    write_v5(tmp_path / "local.mat", matrix)
    mat_bytes = (tmp_path / "local.mat").read_bytes()
    store = {"m.mat": mat_bytes, "n.bin": b"opaque bytes"}
    mat = db.add_file("x/m.mat", write=False, storage="local", filename_disk="m.mat", filesize=len(mat_bytes))
    other = db.add_file("x/n.bin", write=False, storage="local", filename_disk="n.bin", filesize=12)
    seen = []

    @contextlib.contextmanager
    def fake_open(filename_disk):
        seen.append(filename_disk)
        yield _io.BytesIO(store[filename_disk])

    monkeypatch.setattr(ff, "_local_open", fake_open)
    monkeypatch.setattr(ff, "_local_stat", lambda fd: (len(store[fd]), 1))
    assert run(db, "--phase", "linked", "--include-local") == 0
    m, o = db.row(mat), db.row(other)
    assert m["status"] == "done" and m["content_sha256"] == sha(mat_bytes) and m["data_sha256"] == reference(matrix)
    assert o["status"] == "done" and o["content_sha256"] == sha(b"opaque bytes") and o["data_sha256"] is None
    assert sorted(seen) == ["m.mat", "n.bin"]


def test_local_files_are_skipped_without_include_local(db):
    db.add_file("x/n.bin", write=False, storage="local", filename_disk="n.bin")
    assert run(db, "--phase", "linked") == 0
    assert db.count() == 0


def test_once_the_share_is_found_gone_a_late_finishing_worker_writes_nothing(db):
    """Another worker may still be finishing a file when the share-gone stop fires; its result must not
    flush the pending missing files (driven on _Run directly, so it is deterministic)."""
    jobs = [make_job(id=db.add_file(f"p/m{i}.txt", b"x", write=False), archive_path=f"p/m{i}.txt") for i in range(6)]
    late = make_job(id=db.add_file("p/late.txt", b"x"), archive_path="p/late.txt")
    run_state = ff._Run(jobs + [late], db.root, ff.Throttle(None), 1)
    missing = {"status": "missing", "error_message": "not found"}
    for j in jobs[:4]:
        run_state.finish(db.conn, j, dict(missing))
    shutil.rmtree(db.root)
    run_state.finish(db.conn, jobs[4], dict(missing))  # the fifth: the share is gone
    assert run_state.exit_code == 2
    done = {"status": "done", "content_sha256": "0" * 64, "size_bytes": 1, "source_mtime": None}
    run_state.finish(db.conn, late, done)  # a worker that was mid-file when the stop fired
    assert db.count() == 0
