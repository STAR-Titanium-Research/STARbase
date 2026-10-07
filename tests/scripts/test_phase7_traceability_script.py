"""tests/phase7_traceability.sh: a fixture that cannot be created fails the run loudly, and a
good run leaves no P7-* rows behind (review finding 7.11). Needs a migrated Postgres."""

import os
import shutil
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "phase7_traceability.sh"
DSN = os.environ.get("DATABASE_URL")

pytestmark = pytest.mark.skipif(
    not DSN or shutil.which("psql") is None, reason="needs DATABASE_URL and psql"
)


def _psql(sql):
    return subprocess.run(
        ["psql", DSN, "--no-psqlrc", "-Atc", sql], capture_output=True, text=True
    )


@pytest.fixture(autouse=True)
def migrated():
    r = _psql("SELECT to_regproc('f_trace_ancestors') IS NOT NULL")
    if r.returncode != 0 or r.stdout.strip() != "t":
        pytest.skip("database is not migrated")


def _leftovers():
    r = _psql(
        "SELECT (SELECT count(*) FROM physical_samples WHERE sample_code LIKE 'P7-%') "
        "+ (SELECT count(*) FROM raw_stock_lots WHERE lot_code = 'P7-LOT-001')"
    )
    return int(r.stdout.strip())


def _run(dsn):
    return subprocess.run(
        ["bash", str(SCRIPT)],
        env={**os.environ, "DATABASE_URL": dsn},
        capture_output=True,
        text=True,
        timeout=120,
    )


def test_a_good_run_passes_and_removes_its_fixture():
    r = _run(DSN)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "fixture created" in r.stdout
    assert _leftovers() == 0


def test_a_leftover_from_a_killed_run_is_cleared_first():
    _psql(
        "INSERT INTO physical_samples (sample_code, form) VALUES ('P7-BILLET','billet')"
    )
    r = _run(DSN)
    assert r.returncode == 0, r.stdout + r.stderr
    assert _leftovers() == 0


def test_fixture_failure_is_fatal_not_swallowed():
    # Make the last statement of the fixture fail with a trigger that only the test installs.
    assert (
        _psql(
            "CREATE FUNCTION p7_test_boom() RETURNS trigger LANGUAGE plpgsql AS "
            "$$ BEGIN RAISE EXCEPTION 'p7 sabotage'; END $$; "
            "CREATE TRIGGER p7_test_boom BEFORE INSERT ON test_sessions "
            "FOR EACH ROW EXECUTE FUNCTION p7_test_boom()"
        ).returncode
        == 0
    )
    try:
        r = _run(DSN)
    finally:
        _psql(
            "DROP TRIGGER IF EXISTS p7_test_boom ON test_sessions; DROP FUNCTION IF EXISTS p7_test_boom()"
        )
    assert r.returncode != 0
    assert "fixture creation failed" in r.stdout and "p7 sabotage" in r.stdout
    # it stopped: none of the lineage checks ran against a missing fixture
    assert "PIECE-A has 3 ancestor rows" not in r.stdout
    assert _leftovers() == 0  # the DO block rolled back, nothing half-built remains


def test_an_unwritable_database_fails_loudly():
    sep = "&" if "?" in DSN else "?"
    r = _run(f"{DSN}{sep}options=-c%20default_transaction_read_only%3Don")
    assert r.returncode != 0
    assert "FAIL" in r.stdout
    assert "PIECE-A has 3 ancestor rows" not in r.stdout
