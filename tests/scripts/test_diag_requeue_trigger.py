import os

import pytest

psycopg2 = pytest.importorskip("psycopg2")

DSN = os.environ.get("DATABASE_URL")


@pytest.fixture
def conn():
    if not DSN:
        pytest.skip("DATABASE_URL not set (needs a migrated Postgres)")
    try:
        c = psycopg2.connect(DSN)
    except psycopg2.OperationalError as exc:
        pytest.skip(f"database not reachable: {exc}")
    yield c
    c.rollback()
    c.close()


def _smallest_done_row(cur):
    # smallest cut (least likely to be mid-bake and holding a row lock)
    cur.execute(
        "SELECT id FROM machining_force_analysis WHERE diag_status='done' "
        "ORDER BY diag_points ASC LIMIT 1"
    )
    row = cur.fetchone()
    if row:
        return row[0]
    # A freshly migrated and seeded database has no baked cut. Make one inside this test's
    # transaction (every test rolls back), so the trigger is tested wherever it runs.
    try:
        cur.execute("SAVEPOINT make_fixture")
        cur.execute(
            "INSERT INTO directus_files (id) VALUES (gen_random_uuid()) RETURNING id"
        )
        file_id = cur.fetchone()[0]
        cur.execute(
            "INSERT INTO manufacturing_operations "
            "(operation_id, method_id, process_category, source_system) "
            "SELECT gen_random_uuid(), method_id, 'machining', 'test_fixture' "
            "FROM manufacturing_methods "
            "LIMIT 1 RETURNING operation_id"
        )
        op_id = cur.fetchone()[0]
        cur.execute(
            "INSERT INTO machining_force_analysis "
            "(operation_id, directus_files_id, status, diag_status, diag_points) "
            "VALUES (%s, %s, 'done', 'done', 1) RETURNING id",
            [op_id, file_id],
        )
        return cur.fetchone()[0]
    except (psycopg2.Error, TypeError) as exc:
        cur.execute("ROLLBACK TO SAVEPOINT make_fixture")
        pytest.skip(f"no baked diag row, and could not create one: {exc}")


def test_editing_diag_recipe_requeues(conn):
    with conn.cursor() as cur:
        cur.execute("SET lock_timeout = '3s'")
        rid = _smallest_done_row(cur)
        cur.execute(
            "UPDATE machining_force_analysis SET diag_recipe = '{\"steps\":[]}'::jsonb "
            "WHERE id = %s RETURNING diag_status",
            [rid],
        )
        assert cur.fetchone()[0] == "pending"
    conn.rollback()


def test_touching_unrelated_columns_does_not_requeue(conn):
    with conn.cursor() as cur:
        cur.execute("SET lock_timeout = '3s'")
        rid = _smallest_done_row(cur)
        cur.execute(
            "UPDATE machining_force_analysis SET diag_points = diag_points "
            "WHERE id = %s RETURNING diag_status",
            [rid],
        )
        assert cur.fetchone()[0] == "done"
    conn.rollback()
