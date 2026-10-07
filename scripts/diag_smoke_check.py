"""One-off smoke test: process exactly the diag_status='pending' rows via handle_diags, and
nothing else in the orchestrator's queue. Deliberately bypasses run_queue/--run/--discover,
which would also process the 74 pending base analyses and 4 pending octrees already queued.

Usage (from the repo root, with POTREE_CONVERTER set in the environment):
    py scripts/diag_smoke_check.py

Named *_check.py, not *_test.py: it is a manual developer utility, not part of the pytest
suite, and must not be collected by a bare `pytest` run (it imports force_orchestrator and
psycopg2 at module scope).
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

import force_orchestrator as fo
import psycopg2

# The ambient DATABASE_URL (same one dbmate / the daemon use). No built-in default: the
# compose stack has no well-known password any more.
DATABASE_URL = os.environ.get("DATABASE_URL") or sys.exit(
    "ERROR: DATABASE_URL is required, e.g. "
    "postgres://d1:$POSTGRES_PASSWORD@localhost:5432/d1_database?sslmode=disable"
)


def main() -> None:
    exe = fo.detect_matlab()
    print(f"MATLAB: {exe}")
    potree = fo.detect_potree_converter()
    print(f"PotreeConverter: {potree}")
    if not potree:
        print("PotreeConverter not found -- aborting before touching the DB.")
        return

    conn = psycopg2.connect(DATABASE_URL)
    try:
        n = fo.handle_diags(conn, exe)
        print(f"handle_diags processed {n} row(s)")
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, diag_status, diag_points, diag_error, diag_path "
                "FROM machining_force_analysis WHERE diag_status IS NOT NULL"
            )
            for row in cur.fetchall():
                print(row)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
