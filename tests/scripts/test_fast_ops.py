"""scripts/fast_ops.py and the FAST importers' database write (stage T0d).

A hand-logged sintering operation (typed machine + run number, no source_run_uid) is filled in by
the import instead of duplicated (spec 2026-10-10-record-codes Q48), the importers write the run
number so the database builds the operation code, and the trace queue uses the operation ids that
exist after the upsert. DB-level: needs a migrated Postgres with the reference seed (DATABASE_URL);
every test rolls back what it wrote.
"""

import os
import sys
import uuid
from datetime import datetime
from pathlib import Path

import pytest

psycopg2 = pytest.importorskip("psycopg2")

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import fast_ops  # noqa: E402
import import_fast25  # noqa: E402
import import_fast250  # noqa: E402

DSN = os.environ.get("DATABASE_URL")
RUN = 9999


@pytest.fixture
def cur():
    if not DSN:
        pytest.skip("DATABASE_URL not set (needs a migrated Postgres)")
    try:
        conn = psycopg2.connect(DSN)
    except psycopg2.OperationalError as exc:
        pytest.skip(f"database not reachable: {exc}")
    c = conn.cursor()
    c.execute("SELECT to_regclass('manufacturing_operations'), to_regproc('operation_code_for')")
    if c.fetchone() != ("manufacturing_operations", "operation_code_for"):
        conn.close()
        pytest.skip("database is not migrated")
    yield c
    conn.rollback()
    conn.close()


def _method_id(cur):
    cur.execute("SELECT method_id FROM manufacturing_methods WHERE method_code = 'MF'")
    row = cur.fetchone()
    if row is None:
        pytest.skip("reference seed not loaded (no MF method)")
    return row[0]


def _machine(cur, name):
    """A fresh equipment row named like the machine (the code rule reads the machine from the name)."""
    eid = str(uuid.uuid4())
    cur.execute(
        "INSERT INTO equipment (equipment_id, equipment_code, equipment_name, equipment_type, capabilities) "
        "VALUES (%s, %s, %s, 'FAST_Press', 'sintering')",
        [eid, f"T0D-{eid[:8]}", name],
    )
    return eid


def _sample(cur):
    """An operation needs a sample unless it is an import (check manufacturing_operations_has_sample)."""
    cur.execute(
        "INSERT INTO physical_samples (sample_code, form) VALUES (%s, 'billet') RETURNING sample_id",
        [f"T0D-{uuid.uuid4().hex[:8]}"],
    )
    return cur.fetchone()[0]


def _hand_logged(cur, method_id, equipment_id, run, date=datetime(2026, 3, 5, 12, 0), **extra):
    cols = {
        "operation_id": str(uuid.uuid4()),
        "method_id": method_id,
        "equipment_id": equipment_id,
        "process_category": "sintering",
        "operation_date": date,
        "sintering_run_number": run,
        "sample_id": _sample(cur),
        **extra,
    }
    cur.execute(
        f"INSERT INTO manufacturing_operations ({', '.join(cols)}) "
        f"VALUES ({', '.join(['%s'] * len(cols))}) RETURNING operation_id",
        list(cols.values()),
    )
    return str(cur.fetchone()[0])


def _row(cur, op_id):
    cur.execute(
        "SELECT source_run_uid, source_system, sintering_run_number, pass_code "
        "FROM manufacturing_operations WHERE operation_id = %s",
        [op_id],
    )
    return cur.fetchone()


def _ids(mapping):
    return {k: str(v) for k, v in mapping.items()}


def test_adopts_a_hand_logged_operation_once(cur):
    mf, e25 = _method_id(cur), None
    e25 = _machine(cur, "FCT HP D 25")
    op = _hand_logged(cur, mf, e25, RUN)
    uid = import_fast25.uid_for(RUN)

    assert fast_ops.adopt_hand_logged(cur, e25, "fast_25", [(RUN, uid)]) == 1
    assert _row(cur, op)[:3] == (uid, "fast_25", RUN)
    assert fast_ops.adopt_hand_logged(cur, e25, "fast_25", [(RUN, uid)]) == 0
    assert _ids(fast_ops.operation_ids_for(cur, [uid])) == {uid: op}


def test_leaves_other_machines_and_identified_operations_alone(cur):
    mf = _method_id(cur)
    e25, e250 = _machine(cur, "FCT HP D 25"), _machine(cur, "FCT HP D 250")
    other_machine = _hand_logged(cur, mf, e250, RUN)
    imported = _hand_logged(
        cur, mf, e25, RUN + 1, source_run_uid="fast25|elsewhere", source_system="fast_25"
    )
    other_run = _hand_logged(cur, mf, e25, RUN + 2)
    machining = _hand_logged(cur, mf, e25, RUN + 3, process_category="machining")

    runs = [(RUN, "fast25|a"), (RUN + 1, "fast25|b"), (RUN + 3, "fast25|d")]
    assert fast_ops.adopt_hand_logged(cur, e25, "fast_25", runs) == 0
    assert _row(cur, other_machine)[:2] == (None, None)
    assert _row(cur, imported)[:2] == ("fast25|elsewhere", "fast_25")
    assert _row(cur, other_run)[:2] == (None, None)
    assert _row(cur, machining)[:2] == (None, None)
    assert fast_ops.operation_ids_for(cur, ["fast25|a", "fast25|b"]) == {}


def test_empty_run_list_adopts_nothing(cur):
    assert fast_ops.adopt_hand_logged(cur, _machine(cur, "FCT HP D 25"), "fast_25", []) == 0
    assert fast_ops.operation_ids_for(cur, []) == {}


def _fast25_op(run, date, **kw):
    return {
        "run_no": run,
        "source_run_uid": import_fast25.uid_for(run),
        "operation_id": import_fast25.op_id_for(run),
        "operation_date": date,
        "operator_disp": None,
        "operator_name": None,
        "owner_email": None,
        "material_code": None,
        "material_text": None,
        "recipe_title": None,
        "program_nr": None,
        "batch": None,
        "temp_c": 1600.0,
        "force_kn": 63.0,
        "mould_mm": 20.0,
        "mass_g": None,
        "atmosphere": None,
        "tc_pyro": None,
        "notes": None,
        "emd_rel": f"FAST 25/ECS2000/Data/{run}.EMD",
        **kw,
    }


def _write25(cur, ops, e25, mf):
    return import_fast25.write_operations(
        cur, ops, op_to_id={}, code_to_mat={}, by_prog={}, resolve_owner=lambda o: None,
        equipment_id=e25, method_id=mf,
    )


def test_fast25_upsert_fills_in_the_hand_logged_run_and_codes_a_new_one(cur):
    mf, e25 = _method_id(cur), _machine(cur, "FCT HP D 25")
    hand = _hand_logged(cur, mf, e25, RUN)
    ops = [
        _fast25_op(RUN, datetime(2026, 3, 5, 12, 0)),
        _fast25_op(RUN + 1, datetime(2026, 3, 6, 12, 0)),
    ]

    assert _write25(cur, ops, e25, mf) == (2, 1, 2)  # upserted, adopted, queued

    uid = import_fast25.uid_for(RUN)
    assert _row(cur, hand) == (uid, "fast_25", RUN, "05-03-26-MF25-9999-1600C_63kN_20dia")
    cur.execute("SELECT count(*) FROM manufacturing_operations WHERE equipment_id = %s", [e25])
    assert cur.fetchone()[0] == 2  # filled in, not duplicated
    cur.execute(
        "SELECT operation_id, sintering_run_number, pass_code FROM manufacturing_operations "
        "WHERE source_run_uid = %s",
        [import_fast25.uid_for(RUN + 1)],
    )
    new_id, run, code = cur.fetchone()
    assert (str(new_id), run, code) == (
        import_fast25.op_id_for(RUN + 1),
        RUN + 1,
        "06-03-26-MF25-10000-1600C_63kN_20dia",
    )
    # the trace queue holds the ids that exist: the hand-logged operation's own, not the derived one
    cur.execute(
        "SELECT operation_id::text FROM fast_run_data WHERE operation_id = ANY(%s::uuid[]) "
        "ORDER BY import_archive_path",
        [[hand, str(new_id), import_fast25.op_id_for(RUN)]],
    )
    assert {r[0] for r in cur.fetchall()} == {hand, str(new_id)}

    # a second run of the importer adopts nothing and keeps the codes
    assert _write25(cur, ops, e25, mf) == (2, 0, 2)
    assert _row(cur, hand)[3] == "05-03-26-MF25-9999-1600C_63kN_20dia"


def test_fast250_upsert_fills_in_the_hand_logged_run_and_codes_a_new_one(cur):
    mf, e250 = _method_id(cur), _machine(cur, "FCT HP D 250")
    hand = _hand_logged(cur, mf, e250, 331)

    def op(no, date):
        return {
            "run_no": no,
            "source_run_uid": import_fast250.uid_for(no),
            "operation_id": import_fast250.op_id_for(no),
            "operation_date": date,
            "operator_disp": None,
            "operator_name": None,
            "owner_email": None,
            "material_code": None,
            "material_text": None,
            "recipe": None,
            "mass_grams": None,
            "outcome_notes": None,
            "trace_rel": f"FAST 250/CSV/{no}.csv",
        }

    ops = [op(331, datetime(2026, 7, 20, 12, 0)), op(332, datetime(2026, 7, 21, 12, 0))]
    kw = dict(op_to_id={}, code_to_mat={}, resolve_owner=lambda o: None,
              equipment_id=e250, method_id=mf)
    assert import_fast250.write_operations(cur, ops, **kw) == (2, 1, 2)

    assert _row(cur, hand) == (
        import_fast250.uid_for(331), "fast_250", 331, "20-07-26-MF250-331")
    cur.execute(
        "SELECT sintering_run_number, pass_code FROM manufacturing_operations "
        "WHERE source_run_uid = %s",
        [import_fast250.uid_for(332)],
    )
    assert cur.fetchone() == (332, "21-07-26-MF250-332")
    cur.execute(
        "SELECT count(*) FROM fast_run_data "
        "WHERE operation_id = %s AND import_archive_path = 'FAST 250/CSV/331.csv'",
        [hand],
    )
    assert cur.fetchone()[0] == 1
