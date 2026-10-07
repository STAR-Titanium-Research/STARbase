"""Move handling in scripts/index_archive.py (finding 7.1).

Pure helpers run against a fake cursor; the re-pointing itself runs against a real
Postgres when DATABASE_URL is set (it builds a throwaway schema, touching nothing else).
"""

import os
import sys
import uuid

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "scripts"))

import index_archive as ia  # noqa: E402

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
