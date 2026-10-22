"""Move handling in scripts/index_archive.py (finding 7.1).

Pure helpers run against a fake cursor; the re-pointing itself runs against a real
Postgres when DATABASE_URL is set (it builds a throwaway schema, touching nothing else).
"""

import json
import os
import re
import sys
import uuid
from pathlib import Path

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "scripts"))

import index_archive as ia  # noqa: E402
from test_inbox_crawler_world import POINTER_GUARD, migration_up  # noqa: E402

# ---- is_confident_move ----------------------------------------------------------


def test_same_name_unique_match_is_a_move():
    assert ia.is_confident_move("run1.mat", "new/dir/run1.mat", 1, 1)


def test_renamed_file_is_not_auto_matched():
    assert not ia.is_confident_move("run1.mat", "new/dir/run2.mat", 1, 1)


def test_missing_old_name_is_not_auto_matched():
    assert not ia.is_confident_move(None, "a/run1.mat", 1, 1)


@pytest.mark.parametrize("n_new,n_old", [(2, 1), (1, 2), (0, 1), (3, 3)])
def test_ambiguous_fingerprint_is_not_auto_matched(n_new, n_old):
    assert not ia.is_confident_move("run1.mat", "a/run1.mat", n_new, n_old)


# ---- repoint_file_references with a fake cursor ----------------------------------


class _UniqueViolationError(Exception):
    pgcode = "23505"


class FakeCursor:
    def __init__(self, fail_on=None, counts=None):
        self.sql: list[str] = []
        self.fail_on = fail_on
        self.counts = counts or {}
        self._last = ""

    def execute(self, sql, params=None):
        self.sql.append(sql)
        self._last = sql
        if self.fail_on and sql.startswith(self.fail_on):
            raise _UniqueViolationError()

    def fetchone(self):
        for table, n in self.counts.items():
            if f"FROM {table} " in self._last:
                return (n,)
        return (0,)


FKS = [
    ("sample_data_files", "directus_files_id", 1),
    ("machining_force_analysis", "directus_files_id", 1),
]


def test_every_discovered_fk_is_repointed_not_just_the_junctions():
    cur = FakeCursor()
    left = ia.repoint_file_references(cur, FKS, "old", "new")
    assert left == 0
    updated = [s for s in cur.sql if s.startswith("UPDATE")]
    assert any("machining_force_analysis" in s for s in updated)
    assert any("sample_data_files" in s for s in updated)


def test_unique_violation_keeps_the_reference_and_reports_it():
    cur = FakeCursor(
        fail_on="UPDATE machining_force_analysis",
        counts={"machining_force_analysis": 1},
    )
    left = ia.repoint_file_references(cur, FKS, "old", "new")
    assert left == 1
    assert "ROLLBACK TO SAVEPOINT repoint_fk" in cur.sql


def test_other_errors_propagate():
    class BoomError(Exception):
        pgcode = "XX000"

    class C(FakeCursor):
        def execute(self, sql, params=None):
            if sql.startswith("UPDATE"):
                raise BoomError()
            super().execute(sql, params)

    with pytest.raises(BoomError):
        ia.repoint_file_references(C(), FKS, "old", "new")


# ---- against a real Postgres ------------------------------------------------------

DSN = os.environ.get("DATABASE_URL")


def _fingerprints_ddl() -> str:
    """The up section of the file_fingerprints migration (T0e)."""
    sql = (
        Path(__file__).resolve().parents[2]
        / "db/migrations/20261010000159_file_fingerprints.sql"
    ).read_text(encoding="utf-8")
    return sql.split("-- migrate:up", 1)[1].split("-- migrate:down", 1)[0]


@pytest.fixture
def pgcur():
    psycopg2 = pytest.importorskip("psycopg2")
    if not DSN:
        pytest.skip("DATABASE_URL not set")
    try:
        conn = psycopg2.connect(DSN)
    except psycopg2.OperationalError:
        pytest.skip("database not reachable")
    schema = "ia_test_" + uuid.uuid4().hex[:8]
    cur = conn.cursor()
    cur.execute(f"CREATE SCHEMA {schema}")
    cur.execute(f"SET search_path = {schema}")
    cur.execute("CREATE TABLE directus_files (id uuid PRIMARY KEY, metadata json)")
    cur.execute(
        "CREATE TABLE sample_data_files (id serial PRIMARY KEY, sample_id int, "
        "directus_files_id uuid REFERENCES directus_files(id) ON DELETE CASCADE, "
        "UNIQUE (sample_id, directus_files_id))"
    )
    cur.execute(
        "CREATE TABLE machining_force_analysis (id serial PRIMARY KEY, "
        "directus_files_id uuid NOT NULL UNIQUE REFERENCES directus_files(id) ON DELETE CASCADE)"
    )
    cur.execute(
        "CREATE TABLE tools (id serial PRIMARY KEY, "
        "image uuid REFERENCES directus_files(id) ON DELETE SET NULL)"
    )
    cur.execute(
        _fingerprints_ddl()
    )  # the real migration, so the table is exactly what ships
    yield cur
    conn.rollback()
    conn.close()


def _files(cur, *ids):
    for i in ids:
        cur.execute("INSERT INTO directus_files VALUES (%s, '{}')", (i,))


OLD, NEW = str(uuid.uuid4()), str(uuid.uuid4())


def test_catalog_discovery_finds_every_referencing_column(pgcur):
    found = {(t, c) for t, c, _ in ia.find_file_fk_columns(pgcur)}
    assert found == {
        ("sample_data_files", "directus_files_id"),
        ("machining_force_analysis", "directus_files_id"),
        ("file_fingerprints", "directus_files_id"),
        ("tools", "image"),
    }


def test_move_keeps_force_analysis_and_every_link(pgcur):
    cur = pgcur
    _files(cur, OLD, NEW)
    cur.execute(
        "INSERT INTO sample_data_files (sample_id, directus_files_id) VALUES (1, %s), (2, %s)",
        (OLD, OLD),
    )
    cur.execute(
        "INSERT INTO sample_data_files (sample_id, directus_files_id) VALUES (1, %s)",
        (NEW,),
    )  # dup link
    cur.execute(
        "INSERT INTO machining_force_analysis (directus_files_id) VALUES (%s)", (OLD,)
    )
    cur.execute("INSERT INTO tools (image) VALUES (%s)", (OLD,))

    left = ia.repoint_file_references(cur, ia.find_file_fk_columns(cur), OLD, NEW)

    assert left == 0
    cur.execute(
        "SELECT count(*) FROM machining_force_analysis WHERE directus_files_id=%s",
        (NEW,),
    )
    assert cur.fetchone()[0] == 1
    cur.execute(
        "SELECT sample_id FROM sample_data_files WHERE directus_files_id=%s ORDER BY 1",
        (NEW,),
    )
    assert [r[0] for r in cur.fetchall()] == [1, 2]
    cur.execute("SELECT count(*) FROM tools WHERE image=%s", (NEW,))
    assert cur.fetchone()[0] == 1
    # deleting the old row now cascades nothing
    cur.execute("DELETE FROM directus_files WHERE id=%s", (OLD,))
    cur.execute("SELECT count(*) FROM machining_force_analysis")
    assert cur.fetchone()[0] == 1


def test_conflicting_force_analysis_blocks_deletion_and_is_reported(pgcur):
    cur = pgcur
    _files(cur, OLD, NEW)
    cur.execute(
        "INSERT INTO machining_force_analysis (directus_files_id) VALUES (%s), (%s)",
        (OLD, NEW),
    )
    cur.execute("INSERT INTO tools (image) VALUES (%s)", (OLD,))

    left = ia.repoint_file_references(cur, ia.find_file_fk_columns(cur), OLD, NEW)

    assert left == 1  # the force-analysis row stays on the old file
    cur.execute("SELECT count(*) FROM tools WHERE image=%s", (NEW,))
    assert cur.fetchone()[0] == 1  # the rest were still re-pointed
    cur.execute("SELECT count(*) FROM machining_force_analysis")
    assert cur.fetchone()[0] == 2


# ---- fingerprints follow a moved file (T0e) -----------------------------------------

HASH_OLD, HASH_NEW = "a" * 64, "b" * 64


def _fingerprint(cur, file_id, content_hash):
    cur.execute(
        "INSERT INTO file_fingerprints (directus_files_id, content_sha256, size_bytes) "
        "VALUES (%s, %s, 10)",
        (file_id, content_hash),
    )


def test_move_repoints_the_fingerprint_when_the_new_file_has_none(pgcur):
    cur = pgcur
    _files(cur, OLD, NEW)
    _fingerprint(cur, OLD, HASH_OLD)

    left = ia.repoint_file_references(cur, ia.find_file_fk_columns(cur), OLD, NEW)

    assert left == 0
    cur.execute("SELECT directus_files_id::text, content_sha256 FROM file_fingerprints")
    assert cur.fetchall() == [(NEW, HASH_OLD)]


def test_move_keeps_the_new_files_fingerprint_and_drops_the_old_ones(pgcur):
    cur = pgcur
    _files(cur, OLD, NEW)
    _fingerprint(cur, OLD, HASH_OLD)
    _fingerprint(cur, NEW, HASH_NEW)

    left = ia.repoint_file_references(cur, ia.find_file_fk_columns(cur), OLD, NEW)

    assert left == 0  # no leftover reference to block deleting the old row
    cur.execute("SELECT directus_files_id::text, content_sha256 FROM file_fingerprints")
    assert cur.fetchall() == [(NEW, HASH_NEW)]


def test_fingerprint_dedupe_runs_before_the_update_on_a_fake_cursor():
    cur = FakeCursor()
    ia.repoint_file_references(
        cur, [("file_fingerprints", "directus_files_id", 1)], "old", "new"
    )
    dedupe = [
        i
        for i, s in enumerate(cur.sql)
        if s.startswith("DELETE FROM file_fingerprints")
    ]
    update = [
        i for i, s in enumerate(cur.sql) if s.startswith("UPDATE file_fingerprints")
    ]
    assert dedupe and update and dedupe[0] < update[0]


# ---- the missing sweep judges only the file types the indexer walks -------------------------------
# The inbox crawler registers pointer rows for files the indexer's ALLOWED_EXT does not cover (.al3d,
# .txt, ...). The indexer never walks those, so its sweep must not call them missing.


@pytest.fixture
def sweep_env(tmp_path, monkeypatch):
    psycopg2 = pytest.importorskip("psycopg2")
    if not DSN:
        pytest.skip("DATABASE_URL not set")
    try:
        admin = psycopg2.connect(DSN)
    except psycopg2.OperationalError:
        pytest.skip("database not reachable")
    schema = "ia_sweep_" + uuid.uuid4().hex[:8]
    admin.autocommit = True
    admin.cursor().execute(f"CREATE SCHEMA {schema}")
    monkeypatch.setenv("PGOPTIONS", f"-c search_path={schema}")
    monkeypatch.setenv("DATABASE_URL", DSN)
    conn = psycopg2.connect(DSN)
    cur = conn.cursor()
    cur.execute(
        "CREATE TABLE directus_files (id uuid PRIMARY KEY, storage text NOT NULL, filename_disk text, "
        "filename_download text, title text, type text, folder uuid, filesize bigint, metadata json, "
        "created_on timestamptz, modified_on timestamptz, uploaded_on timestamptz)"
    )
    cur.execute(
        "CREATE TABLE directus_folders (id uuid PRIMARY KEY, name text NOT NULL, parent uuid)"
    )
    cur.execute(_fingerprints_ddl())
    # the pointer-row write guard of migration 206 (ADR-0023): only a session that set d1.archive_writer = 'on' writes a pointer row. The
    # test's own connection (which seeds rows with _row) declares itself one; index_archive.main() opens its own and must do the same.
    cur.execute(migration_up(POINTER_GUARD, schema))
    cur.execute("SELECT set_config('d1.archive_writer', 'on', false)")
    conn.commit()
    root = tmp_path / "star_group1"
    root.mkdir()
    try:
        yield conn, cur, root
    finally:
        conn.rollback()
        conn.close()
        admin.cursor().execute(f"DROP SCHEMA {schema} CASCADE")
        admin.close()


def _row(cur, rel, ext):
    fid = str(ia.file_id(rel))
    meta = {"archive_path": rel}
    if ext is not None:
        meta["extension"] = ext
    cur.execute(
        "INSERT INTO directus_files (id, storage, filename_download, metadata) VALUES (%s, 'star', %s, %s)",
        (fid, rel.rsplit("/", 1)[-1], json.dumps(meta)),
    )
    return fid


def _missing(cur):
    cur.execute(
        "SELECT filename_download FROM directus_files "
        "WHERE (metadata::jsonb->>'missing') = 'true'"
    )
    # sorted in Python: ORDER BY follows the database collation, which differs between clusters
    return sorted(r[0] for r in cur.fetchall())


def test_the_sweep_flags_a_vanished_indexed_type_but_not_a_type_it_never_walks(
    sweep_env, monkeypatch
):
    conn, cur, root = sweep_env
    (root / "Users/x").mkdir(parents=True)
    for name in ("scan.al3d", "notes.txt", "UPPER.AL3D"):
        (root / "Users/x" / name).write_bytes(b"on the share, not an indexer type")
    (root / "Users/x/kept.pdf").write_bytes(b"%PDF")
    _row(cur, "Users/x/scan.al3d", ".al3d")  # registered by the inbox crawler
    _row(cur, "Users/x/notes.txt", ".txt")
    _row(
        cur, "Users/x/UPPER.AL3D", ".al3d"
    )  # the extension is lower-cased with its dot
    _row(cur, "Users/x/kept.pdf", ".pdf")  # an indexed type that is still there
    _row(cur, "Users/x/gone.mat", ".mat")  # an indexed type that vanished
    _row(cur, "Users/x/gone.PNG", ".png")
    _row(cur, "Users/x/legacy_gone", None)  # no recorded extension: not judged
    conn.commit()
    monkeypatch.setattr(sys, "argv", ["index_archive.py", "--root", str(root)])
    assert ia.main() == 0
    cur.execute("SELECT 1")  # a fresh view of the committed data
    conn.commit()
    assert _missing(cur) == sorted(["gone.PNG", "gone.mat"])


def test_a_crawler_registered_scan_that_is_deleted_is_not_the_indexers_business(
    sweep_env, monkeypatch
):
    conn, cur, root = sweep_env
    root.joinpath("Users").mkdir()
    _row(cur, "Users/x/vanished.al3d", ".al3d")
    conn.commit()
    monkeypatch.setattr(sys, "argv", ["index_archive.py", "--root", str(root)])
    ia.main()
    conn.commit()
    assert (
        _missing(cur) == []
    )  # the crawler marks its own candidate gone; this row is left alone


def test_the_sweep_extension_list_is_the_allowed_extensions_lower_cased_with_the_dot():
    assert all(e == e.lower() and e.startswith(".") for e in ia.ALLOWED_EXT)


# ---- the surface-scan worker derives file ids the way this script does -----------


def test_surface_scan_worker_derives_file_ids_like_the_indexer():
    """The worker renders a file only when its id is uuid5 of file:<archive_path> (a repointed
    archive_path is refused). Its copy of the namespace is a source constant in a plugin that needs
    SurfaceTopography, so compare the text: the namespace string and the "file:" prefix."""
    worker = (
        Path(__file__).resolve().parents[2]
        / "plugins"
        / "surface-scan-worker"
        / "app"
        / "lib"
        / "archive.py"
    )
    text = worker.read_text()
    m = re.search(
        r'_ID_NAMESPACE\s*=\s*uuid\.uuid5\(\s*uuid\.NAMESPACE_DNS,\s*"([^"]+)"\s*\)',
        text,
    )
    assert m, "the worker no longer defines _ID_NAMESPACE the expected way"
    assert uuid.uuid5(uuid.NAMESPACE_DNS, m.group(1)) == ia._NS
    assert '"file:" + archive_path' in text
    assert ia.file_id("rig/x.al3d") == uuid.uuid5(ia._NS, "file:rig/x.al3d")


# ---- a moved owned file keeps its first owner (ADR-0022 D13) ------------------------


def test_carry_owner_stamp_copies_the_owner_to_the_new_row(sweep_env):
    conn, cur, _root = sweep_env
    cur.execute(
        "ALTER TABLE directus_files ADD COLUMN owner_person_id uuid, ADD COLUMN owner_team_id uuid"
    )
    owner = str(uuid.uuid4())
    old, new = _row(cur, "Users/a/x.tif", ".tif"), _row(cur, "Projects/p/x.tif", ".tif")
    cur.execute(
        "UPDATE directus_files SET owner_person_id = %s WHERE id = %s", (owner, old)
    )
    ia.carry_owner_stamp(cur, old, new)
    cur.execute(
        "SELECT owner_person_id::text, owner_team_id FROM directus_files WHERE id = %s",
        (new,),
    )
    assert cur.fetchone() == (owner, None)


def test_carry_owner_stamp_leaves_unowned_and_already_stamped_rows_alone(sweep_env):
    conn, cur, _root = sweep_env
    cur.execute(
        "ALTER TABLE directus_files ADD COLUMN owner_person_id uuid, ADD COLUMN owner_team_id uuid"
    )
    first, second = str(uuid.uuid4()), str(uuid.uuid4())
    old, new = _row(cur, "Users/a/y.tif", ".tif"), _row(cur, "Projects/p/y.tif", ".tif")
    ia.carry_owner_stamp(cur, old, new)  # old row unowned: nothing to carry
    cur.execute("SELECT owner_person_id FROM directus_files WHERE id = %s", (new,))
    assert cur.fetchone() == (None,)
    cur.execute(
        "UPDATE directus_files SET owner_person_id = %s WHERE id = %s", (first, old)
    )
    cur.execute(
        "UPDATE directus_files SET owner_person_id = %s WHERE id = %s", (second, new)
    )
    ia.carry_owner_stamp(cur, old, new)  # the new row already has an owner: kept
    cur.execute(
        "SELECT owner_person_id::text FROM directus_files WHERE id = %s", (new,)
    )
    assert cur.fetchone() == (second,)


def test_carry_owner_stamp_is_a_no_op_before_the_owner_columns_exist(sweep_env):
    conn, cur, _root = sweep_env
    old, new = _row(cur, "Users/a/z.tif", ".tif"), _row(cur, "Projects/p/z.tif", ".tif")
    ia.carry_owner_stamp(cur, old, new)  # must not raise


def test_the_indexer_registers_a_pointer_row_under_the_write_guard(
    sweep_env, monkeypatch
):
    """Migration 206 refuses a storage 'star' insert from a session that is not an archive writer: the indexer's own connection must be one."""
    conn, cur, root = sweep_env
    (root / "Users/x").mkdir(parents=True)
    (root / "Users/x/new.pdf").write_bytes(b"%PDF")
    monkeypatch.setattr(sys, "argv", ["index_archive.py", "--root", str(root)])
    assert ia.main() == 0
    conn.commit()
    cur.execute(
        "SELECT storage, metadata::jsonb ->> 'archive_path' FROM directus_files"
    )
    assert cur.fetchall() == [("star", "Users/x/new.pdf")]
