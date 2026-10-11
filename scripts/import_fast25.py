#!/usr/bin/env python3
r"""Rebuild FAST 25 (FCT HP D 25) sintering runs from the machine backend MDB.

`ECS_Analysis.MDB::Versuch` is the authoritative run history (9,735 rows, 2010-2026).
Its `Daten1..20` columns are free text; `DataCaption` gives the legend:
    Daten1=Operator  Daten2=Temperature/C  Daten3=Material  Daten4=Force/kN
    Daten5=Gas/Vacuum  Daten6=Pyro/TC  Daten7=Tool size/mm  Daten8=Batch  Daten9=Mass/g
The values are messy ('1325C', '13 kN', '15min holding' in the mass slot), so we extract
numbers defensively. `FileName` points at the per-run EMD archive (binary .HIS trace) —
stashed on fast_run_data by Step 5 (fast_his.py), not here, so the 250 orchestrator run
never tries to normalise EMD bytes.

There is no Versuch->recipe foreign key, so `Bezeichnung` (the run's program title) is used
as the recipe/title; the standalone ECS_Prog recipe catalog is intentionally not imported
(nothing to link it to).

The machine's own run number (VersuchNr) is written to sintering_run_number and the database
builds the operation code from it (trigger mfg_op_set_code): this script never writes pass_code.
A hand-logged FAST 25 operation with the same run number and no source_run_uid is filled in
instead of duplicated (fast_ops.adopt_hand_logged).

Usage:
    DATABASE_URL=… python scripts/import_fast25.py "…/FAST Machines Data" [--dry-run]
    (needs the pure-Python 'access-parser'; run with the real interpreter, e.g. `py`)
"""

from __future__ import annotations

import argparse
import os
import re
import sys
import uuid
from datetime import date, datetime

import psycopg2
import psycopg2.extras

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fast_mapping as fm
import fast_ops
import fast_recipes as frx

METHOD_MF = "4b13b4f4-7f7e-5356-b93a-937ab527386d"
EQUIP_25 = "a4e9b161-745a-5532-b72a-71e9e5f33388"
SOURCE_SYSTEM = "fast_25"
_NS = uuid.uuid5(uuid.NAMESPACE_DNS, "d1-database.fast-25.v1")

MDB_REL = os.path.join("FAST 25", "ECS2000", "Data", "ECS_Analysis.MDB")
PROG_REL = os.path.join("FAST 25", "ECS2000", "Recipes", "1001", "ECS_Prog.mdb")
EMD_PREFIX = "FAST 25/ECS2000/Data"  # + FileName + .EMD (data-root-relative, POSIX)


def uid_for(vnr) -> str:
    return f"fast25|{vnr}"


def op_id_for(vnr) -> str:
    return str(uuid.uuid5(_NS, uid_for(vnr)))


def _s(v) -> str | None:
    if v is None:
        return None
    s = str(v).strip()
    return s or None


# Shared with the FAST 250 importer / recipe parsing (single definition in fast_recipes).
first_num = frx.first_num


def mass_grams(v) -> float | None:
    """Only when it reads like a mass: '200g' -> 200, '2kg' -> 2000, '15min holding' -> None."""
    s = _s(v)
    if not s:
        return None
    m = re.search(r"(\d+(?:\.\d+)?)\s*(kg|g)\b", s, re.IGNORECASE)
    if not m:
        return None
    v = float(m.group(1))
    return v * 1000 if m.group(2).lower() == "kg" else v


def parse_dt(datev, timev) -> datetime | None:
    """Combine Versuch StartDate (date) + StartTime (epoch-dated time) -> datetime."""

    def to_dt(x):
        if isinstance(x, datetime):
            return x
        if isinstance(x, date):
            return datetime(x.year, x.month, x.day)
        s = _s(x)
        if not s:
            return None
        for f in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d", "%d.%m.%Y %H:%M:%S"):
            try:
                return datetime.strptime(s[:19], f)
            except ValueError:
                continue
        return None

    d = to_dt(datev)
    t = to_dt(timev)
    if d is None:
        return None
    if t is None:
        return d
    return datetime(d.year, d.month, d.day, t.hour, t.minute, t.second)


def clean_note(v) -> str | None:
    s = _s(v)
    if not s:
        return None
    s = re.sub(r"[\r\n]+", " ", s).strip()
    return s or None


def emd_rel(filename) -> str | None:
    s = _s(filename)
    if not s:
        return None
    return f"{EMD_PREFIX}/{s.replace(chr(92), '/')}.EMD"


def read_recipes(data_root: str) -> list[dict]:
    """ECS_Prog.mdb::Rezept -> fast_recipes rows for machine '25'."""
    from access_parser import AccessParser

    db = AccessParser(os.path.join(data_root, PROG_REL))
    r = db.parse_table("Rezept")
    # Rezept holds more rows than distinct ProgrammNr (variants per Anlage/InstrClass), so
    # key by recipe id and let the last occurrence win — otherwise the batched upsert hits
    # "ON CONFLICT DO UPDATE cannot affect row a second time".
    out: dict[str, dict] = {}
    for i, pn in enumerate(r["ProgrammNr"]):
        if pn is None:
            continue
        pn = int(pn)
        name = _s(r["ProgrammText"][i]) or f"Recipe {pn}"
        daten = [r[f"Daten{n}"][i] for n in range(1, 21)]
        row = {
            "id": frx.recipe_id("25", pn, name),
            "machine": "25",
            "program_nr": pn,
            "name": name,
            "group_name": _s(r["GroupName"][i]),
            "source_file": _s(r["FileName"][i]),
            "params": {f"Daten{n}": _s(daten[n - 1]) for n in range(1, 21)},
            "date_created": parse_dt(r["DateCreate"][i], None),
            "date_changed": parse_dt(r["DateChange"][i], None),
        }
        row.update(frx.rezept_targets(daten))
        out[row["id"]] = row
    return list(out.values())


def read_versuch(data_root: str) -> list[dict]:
    from access_parser import AccessParser

    db = AccessParser(os.path.join(data_root, MDB_REL))
    v = db.parse_table("Versuch")
    n = len(v["VersuchNr"])
    ops = []
    for i in range(n):
        vnr = v["VersuchNr"][i]
        if vnr is None:
            continue
        start = parse_dt(v["StartDate"][i], v["StartTime"][i])
        if start is None:
            continue
        operator_disp, owner_email, raw_user = fm.parse_user(_s(v["Daten1"][i]))
        material_text = _s(v["Daten3"][i])
        ops.append(
            {
                "run_no": vnr,
                "source_run_uid": uid_for(vnr),
                "operation_id": op_id_for(vnr),
                "operation_date": start,
                "operator_disp": operator_disp,
                "operator_name": raw_user,
                "owner_email": owner_email,
                "material_code": fm.match_material(material_text),
                "material_text": material_text,
                "recipe_title": _s(v["Bezeichnung"][i]),
                "program_nr": frx.program_nr_from_bezeichnung(_s(v["Bezeichnung"][i])),
                "batch": _s(v["Daten8"][i]),
                "temp_c": first_num(v["Daten2"][i]),
                "force_kn": first_num(v["Daten4"][i]),
                "mould_mm": first_num(v["Daten7"][i]),
                "mass_g": mass_grams(v["Daten9"][i]),
                "atmosphere": _s(v["Daten5"][i]),
                "tc_pyro": _s(v["Daten6"][i]),
                "notes": clean_note(v["Bemerkung"][i]),
                "emd_rel": emd_rel(v["FileName"][i]),
            }
        )
    return ops


def write_operations(
    cur,
    ops: list[dict],
    *,
    op_to_id: dict,
    code_to_mat: dict,
    by_prog: dict,
    resolve_owner,
    equipment_id: str = EQUIP_25,
    method_id: str = METHOD_MF,
) -> tuple[int, int, int]:
    """Upsert the parsed runs into manufacturing_operations and queue their EMD traces.

    Returns (operations upserted, hand-logged operations adopted, traces queued). The database
    builds pass_code from the run number, so the code is never written here.
    """
    cols = [
        "operation_id",
        "method_id",
        "equipment_id",
        "process_category",
        "source_run_uid",
        "source_system",
        "operation_date",
        "operator",
        "operator_name",
        "owner",
        "material_id",
        "sintering_recipe_number",
        "sintering_run_number",
        "fast_recipe_id",
        "sintering_batch_number",
        "sintering_mass_grams",
        "sintering_mould_diameter_mm",
        "sintering_atmosphere",
        "sintering_tc_pyro_control",
        "sintering_max_force_kn",
        "sintering_max_temp_celsius",
        "sintering_material_type_note",
        "outcome_notes",
    ]
    values = [
        (
            o["operation_id"],
            method_id,
            equipment_id,
            "sintering",
            o["source_run_uid"],
            SOURCE_SYSTEM,
            o["operation_date"],
            op_to_id.get(o["operator_disp"]),
            o["operator_name"],
            resolve_owner(o),
            code_to_mat.get(o["material_code"]) if o["material_code"] else None,
            o["recipe_title"],
            fast_ops.run_number(o["run_no"]),
            by_prog.get(o["program_nr"]),
            o["batch"],
            o["mass_g"],
            o["mould_mm"],
            o["atmosphere"],
            o["tc_pyro"],
            o["force_kn"],
            o["temp_c"],
            o["material_text"],
            o["notes"],
        )
        for o in ops
    ]

    update_cols = [
        c
        for c in cols
        if c
        not in (
            "operation_id",
            "source_run_uid",
            "method_id",
            "process_category",
            "source_system",
        )
    ]
    set_clause = ", ".join(f"{c}=EXCLUDED.{c}" for c in update_cols)
    # A hand-logged operation of this machine and run (typed by a person) becomes the imported run.
    adopted = fast_ops.adopt_hand_logged(
        cur,
        equipment_id,
        SOURCE_SYSTEM,
        [(fast_ops.run_number(o["run_no"]), o["source_run_uid"]) for o in ops],
    )
    psycopg2.extras.execute_values(
        cur,
        f"INSERT INTO manufacturing_operations ({', '.join(cols)}) VALUES %s "
        f"ON CONFLICT (source_run_uid) WHERE source_run_uid IS NOT NULL "
        f"DO UPDATE SET {set_clause}, updated_at=now()",
        values,
        page_size=500,
    )
    # Enqueue the per-run EMD trace for decoding by fast_orchestrator (fast_his.decode_emd).
    # Guard IS DISTINCT FROM 'done' so re-runs don't re-drain finished traces.
    # An adopted operation keeps its own id, so read the ids back instead of using the derived ones.
    ids = fast_ops.operation_ids_for(cur, [o["source_run_uid"] for o in ops if o["emd_rel"]])
    enq = [(ids[o["source_run_uid"]], o["emd_rel"]) for o in ops if o["emd_rel"]]
    psycopg2.extras.execute_values(
        cur,
        "INSERT INTO fast_run_data (operation_id, status, machine_format, import_archive_path) "
        "VALUES %s ON CONFLICT (operation_id) DO UPDATE "
        "SET status='pending', machine_format=EXCLUDED.machine_format, "
        "    import_archive_path=EXCLUDED.import_archive_path, error_message=NULL, updated_at=now() "
        "WHERE fast_run_data.status IS DISTINCT FROM 'done'",
        [(oid, "pending", "25", rel) for oid, rel in enq],
        page_size=500,
    )
    return len(values), adopted, len(enq)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("data_root", help="path to the 'FAST Machines Data' folder")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    ops = read_versuch(args.data_root)
    linked_mat = sum(1 for o in ops if o["material_code"])
    linked_owner = sum(1 for o in ops if o["owner_email"])
    with_emd = sum(1 for o in ops if o["emd_rel"])
    this_year = date.today().year
    bad = [o for o in ops if not (2005 <= o["operation_date"].year <= this_year + 1)]
    print(
        f"FAST 25: {len(ops)} operations  (material linked {linked_mat}, "
        f"owner linked {linked_owner}, EMD path {with_emd})"
    )
    if bad:
        print(
            f"  WARNING: {len(bad)} implausible dates (kept, review):",
            ", ".join(str(o["operation_date"].date()) for o in bad[:8]),
        )

    if args.dry_run:
        print("\n[dry-run] sample of 3:")
        for o in ops[:3]:
            print(
                "   ",
                {
                    k: o[k]
                    for k in (
                        "run_no",
                        "operation_date",
                        "recipe_title",
                        "material_code",
                        "temp_c",
                        "force_kn",
                        "mass_g",
                        "emd_rel",
                    )
                },
            )
        return

    dsn = os.environ.get("DATABASE_URL") or sys.exit("ERROR: DATABASE_URL required")
    conn = psycopg2.connect(dsn)
    conn.autocommit = False
    cur = conn.cursor()

    psycopg2.extras.execute_values(
        cur,
        "INSERT INTO materials (material_id, alloy_code, common_name, notes) VALUES %s "
        "ON CONFLICT DO NOTHING",
        [(fm.material_id(c), c, n, "FAST import") for c, n in fm.NEW_MATERIALS],
    )
    cur.execute("SELECT alloy_code, material_id FROM materials")
    code_to_mat = {c: m for c, m in cur.fetchall()}

    cur.execute('SELECT "Name", id FROM "Machine_Operators"')
    op_to_id = {n: i for n, i in cur.fetchall()}
    for name in sorted({o["operator_disp"] for o in ops if o["operator_disp"]}):
        if name not in op_to_id:
            cur.execute(
                'INSERT INTO "Machine_Operators" ("Name") VALUES (%s) RETURNING id',
                (name,),
            )
            op_to_id[name] = cur.fetchone()[0]

    cur.execute("SELECT email, id FROM directus_users")
    email_to_user = {e: i for e, i in cur.fetchall()}
    cur.execute("SELECT id, first_name, last_name FROM directus_users")
    name_to_uid = fm.user_name_index(cur.fetchall())

    def resolve_owner(o):
        if o["owner_email"] and o["owner_email"] in email_to_user:
            return email_to_user[o["owner_email"]]
        return fm.owner_from_names(o["operator_name"], name_to_uid)

    recipes = read_recipes(args.data_root)
    psycopg2.extras.execute_values(
        cur,
        "INSERT INTO fast_recipes (id, machine, program_nr, name, group_name, source_file, "
        "target_temp_c, target_force_kn, hold_time_min, params, date_created, date_changed) "
        "VALUES %s ON CONFLICT (id) DO UPDATE SET "
        "  name=EXCLUDED.name, group_name=EXCLUDED.group_name, source_file=EXCLUDED.source_file, "
        "  target_temp_c=EXCLUDED.target_temp_c, target_force_kn=EXCLUDED.target_force_kn, "
        "  hold_time_min=EXCLUDED.hold_time_min, params=EXCLUDED.params, "
        "  date_changed=EXCLUDED.date_changed, updated_at=now()",
        [
            (
                r["id"],
                r["machine"],
                r["program_nr"],
                r["name"],
                r["group_name"],
                r["source_file"],
                r.get("target_temp_c"),
                r.get("target_force_kn"),
                r.get("hold_time_min"),
                psycopg2.extras.Json(r["params"]),
                r["date_created"],
                r["date_changed"],
            )
            for r in recipes
        ],
        page_size=500,
    )
    print(f"upserted {len(recipes)} FAST 25 recipes")
    by_prog = {r["program_nr"]: r["id"] for r in recipes}

    n_ops, adopted, queued = write_operations(
        cur,
        ops,
        op_to_id=op_to_id,
        code_to_mat=code_to_mat,
        by_prog=by_prog,
        resolve_owner=resolve_owner,
    )
    conn.commit()
    print(
        f"upserted {n_ops} FAST 25 operations ({adopted} hand-logged filled in); "
        f"enqueued {queued} EMD traces (pending)"
    )
    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
