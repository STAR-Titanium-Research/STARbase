"""Shared database helpers for the FAST importers (import_fast25.py, import_fast250.py).

The importers write `sintering_run_number` (the machine's own run number, never invented) and the
trigger `mfg_op_set_code` builds the operation code from it, so they never write `pass_code`.
A person may already have logged the run by hand (machine + run number typed, no
`source_run_uid`); `adopt_hand_logged` marks that operation as the imported run so the importer's
upsert fills it in instead of creating a second one (spec 2026-10-10-record-codes, Q37/Q48).

What the upsert then does to such a row (and to any re-imported row) is set by `upsert_set_clause`:
the person's `owner` and `outcome_notes` are kept (the import only fills them when blank); every other imported
column takes the import's value when it has one, and a missing value (None) never wipes a stored one
(so a mould diameter a person typed stays, and the code keeps its `_20dia`).
The row keeps its operation_id, sample links and anything the import does not write.
"""

from __future__ import annotations

# Columns a person may have filled on a hand-logged row: the import only fills them when blank.
KEEP_STORED = ("owner", "outcome_notes")
# Never updated on conflict: the row's identity.
IDENTITY_COLS = (
    "operation_id",
    "source_run_uid",
    "method_id",
    "process_category",
    "source_system",
)


def upsert_set_clause(cols, table="manufacturing_operations") -> str:
    """The `DO UPDATE SET` list for an importer's upsert over `cols` (identity columns left out)."""
    parts = []
    for c in cols:
        if c in IDENTITY_COLS:
            continue
        if c in KEEP_STORED:
            parts.append(f"{c}=COALESCE({table}.{c}, EXCLUDED.{c})")
        else:  # the import wins when it has a value; a missing one never wipes a stored one
            parts.append(f"{c}=COALESCE(EXCLUDED.{c}, {table}.{c})")
    return ", ".join(parts)


def run_number(v) -> int | None:
    """The machine's run number as an int; None unless it is a whole number >= 1 (the column's CHECK)."""
    try:
        f = float(v)
        n = int(f)
    except (TypeError, ValueError, OverflowError):
        return None
    return n if n == f and n >= 1 else None


def adopt_hand_logged(cur, equipment_id, source_system, runs) -> list:
    """Give hand-logged sintering operations of this machine the identity of the imported run.

    `runs` is a list of `(run_no, source_run_uid)`. An operation is adopted when it is a sintering
    operation on `equipment_id` with that `sintering_run_number`, no `source_run_uid` and no
    `source_system` (a frozen experiment_sheet row is never adopted); it gets the uid and
    `source_system` and keeps its own operation_id, so the importer's `ON CONFLICT
    (source_run_uid)` upsert then updates it (what that keeps: see the module docstring). A uid
    some operation already has is never given to a second one. Returns the adopted
    operations as a list of `(operation_id, run_number)` so the importers can log them (a mistyped
    run number shows up there).
    """
    runs = [(run_number(n), uid) for n, uid in runs]
    runs = [(n, uid) for n, uid in runs if n is not None]
    if not runs:
        return []
    cur.execute(
        "UPDATE manufacturing_operations m "
        "SET source_run_uid = r.uid, source_system = %s, updated_at = now() "
        "FROM unnest(%s::int[], %s::text[]) AS r(run_no, uid) "
        "WHERE m.process_category = 'sintering' AND m.equipment_id = %s "
        "  AND m.sintering_run_number = r.run_no AND m.source_run_uid IS NULL "
        "  AND m.source_system IS NULL "
        "  AND NOT EXISTS (SELECT 1 FROM manufacturing_operations x WHERE x.source_run_uid = r.uid) "
        "RETURNING m.operation_id, m.sintering_run_number",
        [
            source_system,
            [n for n, _ in runs],
            [uid for _, uid in runs],
            str(equipment_id),
        ],
    )
    return cur.fetchall()


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
