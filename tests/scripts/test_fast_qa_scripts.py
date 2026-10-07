"""clear_fast_logs.py (7.2) and apply_fast_qa_backup.py --revert (7.9) against a real Postgres.

Each test builds a throwaway schema with just the columns the scripts touch, so it needs no
migrated database; it is skipped without DATABASE_URL.
"""

import os
import subprocess
import sys
import uuid

import pytest

psycopg2 = pytest.importorskip("psycopg2")

SCRIPTS = os.path.join(os.path.dirname(__file__), "..", "..", "scripts")
sys.path.insert(0, SCRIPTS)

import apply_fast_qa_backup as afq  # noqa: E402
import clear_fast_logs as cfl  # noqa: E402

DSN = os.environ.get("DATABASE_URL")


@pytest.fixture
def conn():
    if not DSN:
        pytest.skip("DATABASE_URL not set")
    try:
        c = psycopg2.connect(DSN)
    except psycopg2.OperationalError:
        pytest.skip("database not reachable")
    schema = "fq_test_" + uuid.uuid4().hex[:8]
    cur = c.cursor()
    cur.execute(f"CREATE SCHEMA {schema}")
    cur.execute(f"SET search_path = {schema}")
    cur.execute("""
        CREATE TABLE manufacturing_operations (
            operation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            source_system text, process_category text,
            operation_date timestamptz,
            sintering_recipe_number text, sintering_batch_number text,
            sintering_max_temp_celsius numeric, sintering_max_force_kn numeric,
            sintering_coshh_ref text,
            sintering_ptc_top_celsius numeric, sintering_ptc_bot_celsius numeric,
            sintering_mass_grams numeric, sintering_mould_diameter_mm numeric,
            sintering_voltage_at_max_t_v numeric, sintering_power_at_max_t_kw numeric,
            outcome_notes text, updated_at timestamptz)
        """)
    c.commit()
    yield c
    c.rollback()
    cur.execute(f"DROP SCHEMA {schema} CASCADE")
    c.commit()
    c.close()


def _add_sheet_op(cur, coshh="COSHH-1", notes="cracked"):
    cur.execute(
        "INSERT INTO manufacturing_operations (source_system, process_category, "
        "sintering_coshh_ref, outcome_notes) VALUES ('fast_log','sintering',%s,%s)",
        (coshh, notes),
    )


def _count(cur, table):
    cur.execute(f"SELECT count(*) FROM {table}")
    return cur.fetchone()[0]


# ---- clear_fast_logs ----------------------------------------------------------------


def test_second_run_does_not_destroy_the_backup(conn):
    cur = conn.cursor()
    _add_sheet_op(cur)
    conn.commit()

    first = cfl.run(conn, dry_run=False, yes=True)
    assert first["snapshotted"] == 1 and first["deleted"] == 1
    assert _count(cur, "fast_log_qa_backup") == 1

    second = cfl.run(conn, dry_run=False, yes=True)  # nothing left to snapshot
    assert second["snapshotted"] == 0
    assert _count(cur, "fast_log_qa_backup") == 1  # backup survived
    cur.execute("SELECT coshh_ref, outcome_notes FROM fast_log_qa_backup")
    assert cur.fetchone() == ("COSHH-1", "cracked")


def test_rescrape_appends_without_duplicating(conn):
    cur = conn.cursor()
    _add_sheet_op(cur, "A", "one")
    conn.commit()
    cfl.run(conn, dry_run=False, yes=True)
    _add_sheet_op(cur, "B", "two")
    conn.commit()
    cfl.run(conn, dry_run=False, yes=True)
    cur.execute("SELECT coshh_ref FROM fast_log_qa_backup ORDER BY 1")
    assert [r[0] for r in cur.fetchall()] == ["A", "B"]


def test_dry_run_writes_nothing(conn):
    cur = conn.cursor()
    _add_sheet_op(cur)
    conn.commit()
    res = cfl.run(conn, dry_run=True, yes=False)
    assert res["to_snapshot"] == 1 and res["deleted"] == 0
    assert _count(cur, "manufacturing_operations") == 1
    cur.execute("SELECT to_regclass('fast_log_qa_backup')")
    assert cur.fetchone()[0] is None  # the dry run rolled everything back, DDL included


def test_non_dry_run_without_yes_is_refused_by_the_cli():
    env = {**os.environ, "DATABASE_URL": "postgres://nobody@127.0.0.1:1/none"}
    r = subprocess.run(
        [sys.executable, os.path.join(SCRIPTS, "clear_fast_logs.py")],
        env=env,
        capture_output=True,
        text=True,
    )
    assert r.returncode != 0
    assert "--yes" in r.stderr


# ---- apply_fast_qa_backup --revert ----------------------------------------------------


def _add_machine_op(cur):
    cur.execute(
        "INSERT INTO manufacturing_operations (source_system, process_category, "
        "sintering_ptc_top_celsius, sintering_voltage_at_max_t_v) "
        "VALUES ('fast_25','sintering', 500, 4.2)"
    )


def test_revert_dry_run_does_not_write(conn):
    cur = conn.cursor()
    _add_machine_op(cur)
    conn.commit()
    n = afq.revert(conn, dry_run=True)
    assert n == 1
    conn.rollback()  # whatever the script left open must not matter
    cur.execute("SELECT sintering_ptc_top_celsius FROM manufacturing_operations")
    assert cur.fetchone()[0] == 500


def test_revert_really_nulls_the_sheet_columns(conn):
    cur = conn.cursor()
    _add_machine_op(cur)
    conn.commit()
    assert afq.revert(conn, dry_run=False) == 1
    cur.execute(
        "SELECT sintering_ptc_top_celsius, sintering_voltage_at_max_t_v "
        "FROM manufacturing_operations"
    )
    assert cur.fetchone() == (None, None)
