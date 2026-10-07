#!/usr/bin/env python3
"""Transfer sample ownership from the legacy XLSX into physical_samples.

The Inventory sheet's `Owner` column holds the researcher (email or full name). Each owner
is resolved to a row of `people` (by email or full name, from the database, so users that
already existed under another id still resolve) and written to BOTH
physical_samples.owner_person_id (what the UI reads, migrations 061/062) and the legacy
physical_samples.owner (the person's Directus user, when they have a login).

Usage:
  DATABASE_URL=postgres://d1:$POSTGRES_PASSWORD@localhost:5432/d1_database \\
      python scripts/transfer_sample_ownership.py "<path to Sample_Data.xlsx>" [--dry-run]
"""

from __future__ import annotations

import os
import sys

import openpyxl
from legacy_people import PeopleIndex, load_index
from migrate_legacy import clean_str as clean


def sheet_rows(wb, name):
    ws = wb[name]
    raw = list(ws.iter_rows(values_only=True))
    hdr = [str(h) for h in raw[0] if h is not None]
    out = []
    for r in raw[1:]:
        if not any(x is not None for x in r):
            continue
        out.append({hdr[i]: r[i] for i in range(min(len(hdr), len(r)))})
    return out


def name_to_email(users: list[dict]) -> dict[str, str]:
    """'first last' -> email, from the Users sheet (an extra way to resolve a name)."""
    out: dict[str, str] = {}
    for u in users:
        email = clean(u.get("Email") or u.get("Email Address") or u.get("email"))
        first = clean(u.get("First Name") or u.get("FirstName"))
        last = clean(u.get("Last Name") or u.get("Surname") or u.get("LastName"))
        if email and first and last:
            out[f"{first} {last}".lower()] = email.lower()
    return out


def transfer(
    cur,
    users: list[dict],
    inventory: list[dict],
    people: PeopleIndex,
    dry_run: bool = False,
) -> tuple[int, set[str]]:
    """Set the owner of each listed sample. Returns (samples updated, unresolved owners)."""
    by_name = name_to_email(users)
    updated = 0
    unresolved: set[str] = set()
    for r in inventory:
        code = clean(r.get("Item Code"))
        owner = clean(r.get("Owner"))
        if not (code and owner):
            continue
        key = owner.lower()
        user_id, person_id = people.resolve_owner(key)
        if not person_id and key in by_name:
            user_id, person_id = people.resolve_owner(by_name[key])
        if not person_id:
            unresolved.add(owner)
            continue
        if dry_run:
            cur.execute(
                "SELECT count(*) FROM physical_samples WHERE sample_code=%s", (code,)
            )
            updated += cur.fetchone()[0]
            continue
        cur.execute(
            "UPDATE physical_samples SET owner_person_id=%s, owner=COALESCE(%s, owner) "
            "WHERE sample_code=%s",
            (person_id, user_id, code),
        )
        updated += cur.rowcount
    return updated, unresolved


def main() -> None:
    import psycopg2

    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    dry = "--dry-run" in sys.argv
    if not args:
        sys.exit("usage: transfer_sample_ownership.py <Sample_Data.xlsx> [--dry-run]")
    dsn = os.environ.get("DATABASE_URL") or sys.exit("ERROR: DATABASE_URL required")
    wb = openpyxl.load_workbook(args[0], read_only=True, data_only=True)
    users = sheet_rows(wb, "Users")
    inventory = sheet_rows(wb, "Inventory")

    conn = psycopg2.connect(dsn)
    cur = conn.cursor()
    updated, unresolved = transfer(cur, users, inventory, load_index(cur), dry)
    if dry:
        conn.rollback()
    else:
        conn.commit()
    cur.close()
    conn.close()
    print(f"{'Would set' if dry else 'Set'} owner on {updated} samples.")
    if unresolved:
        print(f"Unresolved owners ({len(unresolved)}): {sorted(unresolved)}")


if __name__ == "__main__":
    main()
