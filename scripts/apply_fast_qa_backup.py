#!/usr/bin/env python3
"""Re-attach sheet-only QA fields (from fast_log_qa_backup) to the rebuilt runs.

The deleted sheet rows were logged as "FCT HP D 250" but actually cover mostly FAST 25 runs
(1,747 of 1,895 backup rows share a calendar day with a rebuilt FAST 25 op vs 463 for 250).
So we match against BOTH rebuilt machines. The reliable common key is (date, max_temp,
max_force) — the same key backfill_fast_times.py used — because the rebuilt FAST 25 rows
carry temp/force from the MDB. We fall back to a unique same-day run when temp/force are
absent. A backup row is applied ONLY when it resolves to exactly one op, and only fills the
columns the machine data left NULL (coshh_ref, ptc_top/bot, mass, mould, outcome_notes).

The backup table is never modified, so unmatched QA stays available for later reconciliation.

Usage: DATABASE_URL=… python scripts/apply_fast_qa_backup.py [--dry-run]
       DATABASE_URL=… python scripts/apply_fast_qa_backup.py --revert [--dry-run]
"""

from __future__ import annotations

import os
import sys

import psycopg2
import psycopg2.extras

# Candidate rebuilt sintering ops per calendar date, with temp/force for disambiguation.
CANDIDATES = """
SELECT operation_date::date AS d, operation_id,
       sintering_max_temp_celsius, sintering_max_force_kn
FROM manufacturing_operations
WHERE source_system IN ('fast_25', 'fast_250') AND process_category = 'sintering'
"""

BACKUP = """
SELECT operation_date::date AS d, max_temp_celsius, max_force_kn,
       coshh_ref, ptc_top_celsius, ptc_bot_celsius,
       mass_grams, mould_diameter_mm, outcome_notes
FROM fast_log_qa_backup
WHERE operation_date IS NOT NULL
"""


def _r(v):
    return None if v is None else round(float(v), 1)


# Machine data is authoritative for everything except true QA fields. Only CoSHH and the
# free-text observations come from the sheet logs; mass/mould/PTC/V/P are recoverable as
# measured values from the trace summary, so they are deliberately NOT written here.
UPDATE = """
UPDATE manufacturing_operations SET
    sintering_coshh_ref = COALESCE(sintering_coshh_ref, %(coshh)s),
    outcome_notes = CASE WHEN NULLIF(btrim(COALESCE(outcome_notes,'')),'') IS NULL
                         THEN %(notes)s ELSE outcome_notes END,
    updated_at = now()
WHERE operation_id = %(oid)s
"""

# One-off correction: the first run of this script filled ANY null machine field from the
# sheets. Only these four can ONLY have come from the sheets — no machine importer writes
# them — so nulling them across machine-sourced sintering ops is safe and precise.
#
# Deliberately NOT nulled here: sintering_mass_grams and sintering_mould_diameter_mm. Both
# ARE machine-sourced (FAST 25 Daten9/Daten7, FAST 250 Load), so blanket-nulling them would
# destroy real MDB data. Re-running the importers restores them from machine truth instead
# (their upserts already set both columns from EXCLUDED).
REVERT = """
UPDATE manufacturing_operations SET
    sintering_ptc_top_celsius    = NULL,
    sintering_ptc_bot_celsius    = NULL,
    sintering_voltage_at_max_t_v = NULL,
    sintering_power_at_max_t_kw  = NULL,
    updated_at = now()
WHERE process_category='sintering' AND source_system IN ('fast_25','fast_250')
"""


def revert(conn, *, dry_run: bool) -> int:
    """Null the sheet-written non-QA columns; with dry_run, report the count and roll back."""
    cur = conn.cursor()
    cur.execute(REVERT)
    n = cur.rowcount
    if dry_run:
        conn.rollback()
        print(f"[dry-run] would revert sheet-written non-QA columns on {n} operations")
    else:
        conn.commit()
        print(f"reverted sheet-written non-QA columns on {n} operations")
    cur.close()
    return n


def main() -> None:
    dry = "--dry-run" in sys.argv
    dsn = os.environ.get("DATABASE_URL") or sys.exit("ERROR: DATABASE_URL required")
    conn = psycopg2.connect(dsn)
    cur = conn.cursor()

    if "--revert" in sys.argv:
        cur.close()
        revert(conn, dry_run=dry)
        conn.close()
        return

    cur.execute(CANDIDATES)
    by_date: dict[object, list] = {}
    for d, oid, temp, force in cur.fetchall():
        by_date.setdefault(d, []).append((oid, _r(temp), _r(force)))

    cur.execute(BACKUP)
    backup = cur.fetchall()

    applied_tf = applied_day = ambiguous = nomatch = 0
    updates = []
    for d, btemp, bforce, coshh, ptc_top, ptc_bot, mass, mould, notes in backup:
        cands = by_date.get(d, [])
        if not cands:
            nomatch += 1
            continue
        oid = None
        bt, bf = _r(btemp), _r(bforce)
        if bt is not None and bf is not None:
            tf = [c for c in cands if c[1] == bt and c[2] == bf]
            if len(tf) == 1:
                oid, applied_tf = tf[0][0], applied_tf + 1
            elif len(tf) > 1:
                ambiguous += 1
                continue
        if oid is None:  # no temp/force match — fall back to unique day
            if len(cands) == 1:
                oid, applied_day = cands[0][0], applied_day + 1
            else:
                ambiguous += 1
                continue
        updates.append({"oid": oid, "coshh": coshh, "notes": notes})

    print(f"backup rows: {len(backup)}")
    print(f"  matched by (date,temp,force): {applied_tf}")
    print(f"  matched by unique same-day run: {applied_day}")
    print(f"  ambiguous (skipped): {ambiguous}")
    print(f"  no rebuilt run that day: {nomatch}")

    if dry:
        print("[dry-run] no writes.")
        cur.close()
        conn.close()
        return

    for u in updates:
        cur.execute(UPDATE, u)
    conn.commit()
    print(f"applied QA to {len(updates)} operations (only filled NULL fields)")
    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
