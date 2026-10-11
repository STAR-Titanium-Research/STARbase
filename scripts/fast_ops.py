"""Shared database helpers for the FAST importers (import_fast25.py, import_fast250.py).

The importers write `sintering_run_number` (the machine's own run number, never invented) and the
trigger `mfg_op_set_code` builds the operation code from it, so they never write `pass_code`.
A person may already have logged the run by hand (machine + run number typed, no
`source_run_uid`); `adopt_hand_logged` marks that operation as the imported run so the importer's
upsert fills it in instead of creating a second one (spec 2026-10-10-record-codes, Q37/Q48).
"""

from __future__ import annotations


def run_number(v) -> int | None:
    """The machine's run number as an int; None unless it is a whole number >= 1 (the column's CHECK)."""
    try:
        f = float(v)
        n = int(f)
    except (TypeError, ValueError, OverflowError):
        return None
    return n if n == f and n >= 1 else None


def adopt_hand_logged(cur, equipment_id, source_system, runs) -> int:
    """Give hand-logged sintering operations of this machine the identity of the imported run.

    `runs` is a list of `(run_no, source_run_uid)`. An operation is adopted when it is a sintering
    operation on `equipment_id` with that `sintering_run_number` and no `source_run_uid`; it gets
    the uid and `source_system` and keeps its own operation_id, owner, notes and sample links, so
    the importer's `ON CONFLICT (source_run_uid)` upsert then updates it. A uid some operation
    already has is never given to a second one. Returns the number of operations adopted.
    """
    runs = [(run_number(n), uid) for n, uid in runs]
    runs = [(n, uid) for n, uid in runs if n is not None]
    if not runs:
        return 0
    cur.execute(
        "UPDATE manufacturing_operations m "
        "SET source_run_uid = r.uid, source_system = %s, updated_at = now() "
        "FROM unnest(%s::int[], %s::text[]) AS r(run_no, uid) "
        "WHERE m.process_category = 'sintering' AND m.equipment_id = %s "
        "  AND m.sintering_run_number = r.run_no AND m.source_run_uid IS NULL "
        "  AND NOT EXISTS (SELECT 1 FROM manufacturing_operations x WHERE x.source_run_uid = r.uid)",
        [source_system, [n for n, _ in runs], [uid for _, uid in runs], str(equipment_id)],
    )
    return cur.rowcount


def operation_ids_for(cur, uids) -> dict:
    """{source_run_uid: operation_id} for the operations that exist (after the upsert).

    An adopted hand-logged operation keeps its own id, so the importers read the ids back instead
    of using the ones they derive from the uid.
    """
    uids = list(uids)
    if not uids:
        return {}
    cur.execute(
        "SELECT source_run_uid, operation_id FROM manufacturing_operations "
        "WHERE source_run_uid = ANY(%s)",
        [uids],
    )
    return dict(cur.fetchall())
