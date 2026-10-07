#!/usr/bin/env python3
"""One-time generator: flatten the per-type parameter tables into inline columns
on their parent tables and wire conditional visibility on the discriminator
field, so the typed parameter fields appear directly in the form (no O2M
"Create New" click).

For each param table (e.g. hardness_test_params) every data column is added to
the parent (test_sessions) as `<prefix>_<col>`, existing data is copied across,
the column's existing Directus field config (label, unit suffix, dropdown
choices) is cloned onto the parent with a condition that shows it only when the
discriminator matches (test_type = 'hardness'), and the old param table + its
O2M panel are removed.

Emits two SQL files and (with --apply) executes them in one transaction:
  db/migrations/20260623000032_inline_param_fields.sql   schema + data + drop
  scripts/configure_inline_params.sql                     Directus metadata

Usage:
  DATABASE_URL=postgres://d1:$POSTGRES_PASSWORD@localhost:5432/d1_database \\
      python scripts/flatten_param_fields.py --apply
  # or just generate the SQL files without executing:
  python scripts/flatten_param_fields.py
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import psycopg2
import psycopg2.extras

# (param_table, parent, fk_col, disc_col, disc_val, prefix, panel)
MAPPINGS = [
    # test_sessions — driven by test_type
    (
        "tensile_test_params",
        "test_sessions",
        "session_id",
        "test_type",
        "tensile",
        "tensile",
        "tensile_test_params",
    ),
    (
        "hardness_test_params",
        "test_sessions",
        "session_id",
        "test_type",
        "hardness",
        "hardness",
        "hardness_test_params",
    ),
    (
        "charpy_test_params",
        "test_sessions",
        "session_id",
        "test_type",
        "charpy",
        "charpy",
        "charpy_test_params",
    ),
    (
        "compression_test_params",
        "test_sessions",
        "session_id",
        "test_type",
        "compression",
        "compression",
        "compression_test_params",
    ),
    (
        "sem_params",
        "test_sessions",
        "session_id",
        "test_type",
        "sem",
        "sem",
        "sem_params",
    ),
    (
        "xrd_params",
        "test_sessions",
        "session_id",
        "test_type",
        "xrd",
        "xrd",
        "xrd_params",
    ),
    # manufacturing_operations — driven by process_category
    (
        "machining_params",
        "manufacturing_operations",
        "operation_id",
        "process_category",
        "machining",
        "machining",
        "machining_params",
    ),
    (
        "sintering_params",
        "manufacturing_operations",
        "operation_id",
        "process_category",
        "sintering",
        "sintering",
        "sintering_params",
    ),
    (
        "heat_treatment_params",
        "manufacturing_operations",
        "operation_id",
        "process_category",
        "heat_treatment",
        "ht",
        "heat_treatment_params",
    ),
    (
        "deformation_params",
        "manufacturing_operations",
        "operation_id",
        "process_category",
        "deformation",
        "deform",
        "deformation_params",
    ),
    (
        "am_params",
        "manufacturing_operations",
        "operation_id",
        "process_category",
        "additive",
        "am",
        "am_params",
    ),
]

SKIP_COLS = {
    "param_id",
    "operation_id",
    "session_id",
    "created_at",
    "updated_at",
    "version",
}

REPO = Path(__file__).resolve().parent.parent


def col_type(cur, table: str, col: str) -> str:
    cur.execute(
        """SELECT data_type, numeric_precision, numeric_scale, character_maximum_length
           FROM information_schema.columns WHERE table_name=%s AND column_name=%s""",
        (table, col),
    )
    dt, np_, ns, _ = cur.fetchone()
    if dt == "numeric":
        return f"NUMERIC({np_},{ns or 0})"
    if dt == "integer":
        return "INTEGER"
    if dt == "boolean":
        return "BOOLEAN"
    return "TEXT"


def data_columns(cur, table: str) -> list[str]:
    cur.execute(
        """SELECT column_name FROM information_schema.columns
           WHERE table_name=%s ORDER BY ordinal_position""",
        (table,),
    )
    return [r[0] for r in cur.fetchall() if r[0] not in SKIP_COLS]


def field_config(cur, collection: str, field: str) -> dict | None:
    cur.execute(
        """SELECT special, interface, options, display, display_options,
                  readonly, hidden, width, required, translations, note
           FROM directus_fields WHERE collection=%s AND field=%s""",
        (collection, field),
    )
    r = cur.fetchone()
    if not r:
        return None
    keys = [
        "special",
        "interface",
        "options",
        "display",
        "display_options",
        "readonly",
        "hidden",
        "width",
        "required",
        "translations",
        "note",
    ]
    return dict(zip(keys, r))


def sql_lit(v) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if isinstance(v, int | float):
        return str(v)
    if isinstance(v, dict | list):
        return "'" + json.dumps(v).replace("'", "''") + "'"
    return "'" + str(v).replace("'", "''") + "'"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="execute against the DB")
    args = ap.parse_args()

    db_url = os.environ.get("DATABASE_URL") or sys.exit(
        "ERROR: DATABASE_URL is required"
    )
    conn = psycopg2.connect(db_url)
    conn.autocommit = False
    cur = conn.cursor()

    schema_up: list[str] = []
    schema_down: list[str] = []
    meta: list[str] = []

    # Remove the O2M panel fields + param collections + relations first.
    panels = [m[6] for m in MAPPINGS]
    parents = sorted({m[1] for m in MAPPINGS})
    meta.append("-- Remove O2M parameter panels from parent forms")
    meta.append(
        "DELETE FROM directus_fields WHERE field IN ("
        + ",".join(sql_lit(p) for p in panels)
        + ") AND collection IN ("
        + ",".join(sql_lit(p) for p in parents)
        + ");"
    )
    meta.append("-- Remove the now-obsolete param collections, fields and relations")
    ptables = [m[0] for m in MAPPINGS]
    in_ptables = ",".join(sql_lit(t) for t in ptables)
    meta.append(
        f"DELETE FROM directus_relations"
        f" WHERE many_collection IN ({in_ptables})"
        f" OR one_collection IN ({in_ptables});"
    )
    meta.append(f"DELETE FROM directus_fields    WHERE collection IN ({in_ptables});")
    meta.append(f"DELETE FROM directus_collections WHERE collection IN ({in_ptables});")
    meta.append("")

    for idx, (ptable, parent, fk, disc, disc_val, prefix, _panel) in enumerate(
        MAPPINGS
    ):
        cols = data_columns(cur, ptable)
        cond = [
            {
                "name": f"show when {disc_val}",
                "rule": {"_and": [{disc: {"_eq": disc_val}}]},
                "hidden": False,
                "readonly": False,
                "required": False,
            }
        ]
        sort_base = 100 + idx * 40
        copy_sets = []
        newcols = [f"{prefix}_{c}" for c in cols]
        meta.append(
            f"-- ── {ptable} → {parent} (inline, shows when {disc}={disc_val}) ──"
        )
        # Idempotent: drop existing inline fields before re-inserting.
        meta.append(
            "DELETE FROM directus_fields"
            f" WHERE collection={sql_lit(parent)} AND field IN ("
            + ",".join(sql_lit(c) for c in newcols)
            + ");"
        )
        for j, col in enumerate(cols):
            newcol = f"{prefix}_{col}"
            ctype = col_type(cur, ptable, col)
            schema_up.append(
                f"ALTER TABLE {parent} ADD COLUMN IF NOT EXISTS {newcol} {ctype};"
            )
            schema_down.append(f"ALTER TABLE {parent} DROP COLUMN IF EXISTS {newcol};")
            copy_sets.append((newcol, col))

            fc = field_config(cur, ptable, col)
            if fc is None:
                # Field wasn't registered — register a sane default.
                fc = {
                    "special": None,
                    "interface": "input",
                    "display": "raw",
                    "display_options": None,
                    "readonly": False,
                    "hidden": False,
                    "width": "half",
                    "required": False,
                    "translations": None,
                    "note": None,
                }
            meta.append(
                "INSERT INTO directus_fields "
                "(collection, field, special, interface, options,"
                " display, display_options, readonly, hidden,"
                " sort, width, required, translations, note,"
                " conditions) VALUES ("
                + ", ".join(
                    [
                        sql_lit(parent),
                        sql_lit(newcol),
                        sql_lit(fc["special"]),
                        sql_lit(fc["interface"]),
                        sql_lit(fc["options"]),
                        sql_lit(fc["display"]),
                        sql_lit(fc["display_options"]),
                        sql_lit(False),
                        sql_lit(True),
                        str(sort_base + j),
                        sql_lit(fc["width"] or "half"),
                        sql_lit(False),
                        sql_lit(fc["translations"]),
                        sql_lit(fc["note"]),
                        sql_lit(cond),
                    ]
                )
                + ");"
            )
        # one UPDATE copying every column for this type
        set_clause = ", ".join(f"{nc} = p.{oc}" for nc, oc in copy_sets)
        schema_up.append(
            f"UPDATE {parent} t SET {set_clause} FROM {ptable} p WHERE t.{fk} = p.{fk};"
        )
        schema_up.append(f"DROP TABLE IF EXISTS {ptable} CASCADE;")
        meta.append("")

    # Write migration file
    mig = REPO / "db" / "migrations" / "20260623000032_inline_param_fields.sql"
    mig.write_text(
        "-- migrate:up\n"
        "-- Flatten per-type parameter tables into inline columns on the parent\n"
        "-- tables so the typed fields render directly in the form (conditional on\n"
        "-- the discriminator). Generated by scripts/flatten_param_fields.py.\n\n"
        + "\n".join(schema_up)
        + "\n\n-- migrate:down\n"
        + "\n".join(reversed(schema_down))
        + "\n",
        encoding="utf-8",
    )

    # Write Directus metadata file
    meta_sql = REPO / "scripts" / "configure_inline_params.sql"
    meta_sql.write_text(
        "-- Directus metadata for inline parameter fields.\n"
        "-- Generated by scripts/flatten_param_fields.py. Run AFTER the schema\n"
        "-- migration 20260623000032 and AFTER configure_directus.sql.\n\n"
        "BEGIN;\n\n" + "\n".join(meta) + "\nCOMMIT;\n",
        encoding="utf-8",
    )

    print(f"Wrote {mig.relative_to(REPO)}")
    print(f"Wrote {meta_sql.relative_to(REPO)}")

    if args.apply:
        print("Applying schema migration …")
        cur.execute("\n".join(schema_up))
        print("Applying Directus metadata …")
        cur.execute("\n".join(meta))
        conn.commit()
        print("Applied and committed.")
    else:
        conn.rollback()
        print("Generated only (no --apply). Review the files then re-run with --apply.")

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
