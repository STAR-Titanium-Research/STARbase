#!/usr/bin/env python3
"""Step 1 of the FAST rebuild: snapshot sheet-only QA fields, then clear the
sheet-sourced sintering operations so they can be rebuilt from the machine backends.

The 1,895 `source_system='fast_log'` sintering ops were scraped from the Excel QA
log sheets. The machine backends (FAST 250 export list, FAST 25 MDB) are authoritative
for run metadata but carry NONE of the sheet's QA-only fields — CoSHH ref, PTC top/bot,
mass, mould diameter, and the free-text comments/failures/alarms. We back those up here,
keyed by a stable match key, so scripts/apply_fast_qa_backup.py can re-attach them to the
rebuilt rows afterwards.

Match key (mirrors backfill_fast_times.py): (date, recipe, batch, round(temp,1),
round(force,1)). Stored verbatim so the re-apply step can try tiered fallbacks.

The backup is append-only: each run snapshots only operations not already in
fast_log_qa_backup (de-duplicated by operation_id) and never truncates it, so re-running
the script after the sheet rows are gone cannot destroy the saved CoSHH refs and notes.
A non-dry run deletes data (and cascades to traces), so it requires --yes.

Usage:
    DATABASE_URL=postgres://d1:$POSTGRES_PASSWORD@localhost:5432/d1_database \
        python scripts/clear_fast_logs.py [--dry-run | --yes]
"""

from __future__ import annotations

import os
import sys

BACKUP_DDL = """
CREATE TABLE IF NOT EXISTS fast_log_qa_backup (
    id                  BIGSERIAL PRIMARY KEY,
    operation_id        UUID,
    operation_date      TIMESTAMPTZ,
    recipe              TEXT,
    batch               TEXT,
    max_temp_celsius    NUMERIC,
    max_force_kn        NUMERIC,
    -- QA-only payload the machine backends don't provide:
    coshh_ref           TEXT,
    ptc_top_celsius     NUMERIC,
    ptc_bot_celsius     NUMERIC,
    mass_grams          NUMERIC,
    mould_diameter_mm   NUMERIC,
    outcome_notes       TEXT,
    backed_up_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
"""

# Snapshot only rows that actually carry at least one QA-only value worth preserving.
_SNAPSHOT_FROM = """
FROM manufacturing_operations
WHERE source_system = 'fast_log' AND process_category = 'sintering'
  AND (sintering_coshh_ref IS NOT NULL
       OR sintering_ptc_top_celsius IS NOT NULL
       OR sintering_ptc_bot_celsius IS NOT NULL
       OR sintering_mass_grams IS NOT NULL
       OR sintering_mould_diameter_mm IS NOT NULL
       OR NULLIF(btrim(COALESCE(outcome_notes, '')), '') IS NOT NULL)
  -- append-only: never snapshot an operation twice
  AND NOT EXISTS (SELECT 1 FROM fast_log_qa_backup b
                  WHERE b.operation_id = manufacturing_operations.operation_id)
"""

SNAPSHOT_SQL = (
    """
INSERT INTO fast_log_qa_backup (
    operation_id, operation_date, recipe, batch, max_temp_celsius, max_force_kn,
    coshh_ref, ptc_top_celsius, ptc_bot_celsius, mass_grams, mould_diameter_mm, outcome_notes)
SELECT
    operation_id, operation_date, sintering_recipe_number, sintering_batch_number,
    sintering_max_temp_celsius, sintering_max_force_kn,
    sintering_coshh_ref, sintering_ptc_top_celsius, sintering_ptc_bot_celsius,
    sintering_mass_grams, sintering_mould_diameter_mm, outcome_notes
"""
    + _SNAPSHOT_FROM
)

COUNT_SNAPSHOT_SQL = "SELECT count(*) " + _SNAPSHOT_FROM

DELETE_SQL = """
DELETE FROM manufacturing_operations
WHERE source_system = 'fast_log' AND process_category = 'sintering';
"""


def run(conn, *, dry_run: bool, yes: bool) -> dict[str, int]:
    """Snapshot (append-only) then delete. Returns counts; writes only when yes and not dry_run."""
    cur = conn.cursor()
    cur.execute(
        "SELECT count(*) FROM manufacturing_operations "
        "WHERE source_system='fast_log' AND process_category='sintering'"
    )
    total = cur.fetchone()[0]
    print(f"sheet-sourced sintering ops present: {total}")

    cur.execute(BACKUP_DDL)
    cur.execute("SELECT count(*) FROM fast_log_qa_backup")
    already = cur.fetchone()[0]
    print(f"rows already in fast_log_qa_backup (kept): {already}")

    if dry_run or not yes:
        # Count what a real run would add, without writing.
        cur.execute(COUNT_SNAPSHOT_SQL)
        with_qa = cur.fetchone()[0]
        print(f"rows with QA-only fields still to preserve: {with_qa}")
        print("[dry-run] no writes. Would snapshot then delete the above.")
        conn.rollback()
        cur.close()
        return {
            "present": total,
            "to_snapshot": with_qa,
            "snapshotted": 0,
            "deleted": 0,
        }

    cur.execute(SNAPSHOT_SQL)
    snapped = cur.rowcount
    cur.execute(DELETE_SQL)
    deleted = cur.rowcount
    conn.commit()
    print(
        f"snapshotted {snapped} new QA rows -> fast_log_qa_backup (existing rows kept)"
    )
    print(f"deleted {deleted} sheet-sourced sintering ops (traces cascaded)")
    cur.close()
    return {
        "present": total,
        "to_snapshot": snapped,
        "snapshotted": snapped,
        "deleted": deleted,
    }


def main() -> None:
    import psycopg2

    dry = "--dry-run" in sys.argv
    yes = "--yes" in sys.argv
    if not dry and not yes:
        sys.exit(
            "ERROR: this deletes the sheet-sourced sintering operations (and their traces). "
            "Re-run with --yes to proceed, or --dry-run to preview."
        )
    dsn = os.environ.get("DATABASE_URL") or sys.exit("ERROR: DATABASE_URL required")
    conn = psycopg2.connect(dsn)
    conn.autocommit = False
    try:
        run(conn, dry_run=dry, yes=yes)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
