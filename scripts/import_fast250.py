#!/usr/bin/env python3
"""Rebuild FAST 250 (FCT HP D 250) sintering runs from the machine backend.

The FCT HP D 250 exports a run-list CSV (`export_*.csv`) and per-run trace CSVs under
`FAST 250/CSV/YYYY-MM/<No>_<date>_<time>.csv`. The run-list carries the rich metadata
(Customer/Material/Load/Remark/Recipe); the trace CSVs carry the plottable signal AND a
small preamble (Used Recipe / StartTime). Some runs appear only in one source, so we build
the operation set from the UNION of both, keyed by the machine run number `No`.

For every run that has a local trace file we also upsert a `fast_run_data` row (status
'pending', import_archive_path relative to the data-root) — scripts/fast_orchestrator.py
(run with ARCHIVE_UNC pointed at the data-root) then normalises + uploads + catalogs it.

The machine's own run number (`No`) is written to sintering_run_number and the database builds the
operation code from it (trigger mfg_op_set_code): this script never writes pass_code. A
hand-logged FAST 250 operation with the same run number and no source_run_uid is filled in
instead of duplicated (fast_ops.adopt_hand_logged).

Usage:
    DATABASE_URL=… python scripts/import_fast250.py "…/FAST Machines Data" [--dry-run]
"""

from __future__ import annotations

import argparse
import csv
import glob
import io
import os
import re
import sys
import uuid
from datetime import datetime

import psycopg2
import psycopg2.extras

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fast_mapping as fm
import fast_ops
import fast_recipes as frx

METHOD_MF = "4b13b4f4-7f7e-5356-b93a-937ab527386d"
EQUIP_250 = "27f468ae-5e5b-532d-bf33-e9cfc939b524"
SOURCE_SYSTEM = "fast_250"
MACHINE = "FCT HP D 250"
_NS = uuid.uuid5(uuid.NAMESPACE_DNS, "d1-database.fast-250.v1")

REL_ROOT = "FAST 250"  # data-root-relative prefix stored in import_archive_path


def uid_for(run_no: int) -> str:
    return f"fast250|{run_no}"


def op_id_for(run_no: int) -> str:
    return str(uuid.uuid5(_NS, uid_for(run_no)))


def parse_de_dt(s: str):
    """'20.07.2026 13:02:35' -> datetime, else None."""
    m = re.search(r"(\d{2})\.(\d{2})\.(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})", s or "")
    if not m:
        return None
    d, mo, y, h, mi, se = (int(x) for x in m.groups())
    try:
        return datetime(y, mo, d, h, mi, se)
    except ValueError:
        return None


def parse_mass_grams(load: str):
    """'272g' -> 272 ; '10.0 kg' -> 10000 ; recipe-ish strings -> None."""
    m = re.match(r"^\s*([\d.]+)\s*(kg|g)\b", (load or "").strip(), re.IGNORECASE)
    if not m:
        return None
    try:
        v = float(m.group(1))
    except ValueError:
        return None
    return v * 1000 if m.group(2).lower() == "kg" else v


def read_export(data_root: str) -> dict[int, dict]:
    """Newest export_*.csv -> {No: {status,start,end,name,customer,load,material,remark,recipe}}."""
    exports = sorted(glob.glob(os.path.join(data_root, REL_ROOT, "export_*.csv")))
    if not exports:
        return {}
    path = exports[-1]
    raw = open(path, "rb").read().decode("cp1252", errors="replace")
    rows = list(csv.reader(io.StringIO(raw), delimiter=";"))
    out: dict[int, dict] = {}
    if not rows:
        return out
    hdr = [h.strip().lower() for h in rows[0]]
    idx = {name: hdr.index(name) for name in hdr}

    def g(r, name):
        i = idx.get(name)
        return r[i].strip() if i is not None and i < len(r) else ""

    for r in rows[1:]:
        if not r or not r[0].strip().isdigit():
            continue
        no = int(r[0])
        out[no] = {
            "status": g(r, "status"),
            "start": g(r, "start"),
            "end": g(r, "end"),
            "name": g(r, "name"),
            "customer": g(r, "customer"),
            "load": g(r, "load"),
            "material": g(r, "material"),
            "remark": g(r, "remark"),
            "recipe": g(r, "recipe"),
        }
    return out


def trace_files(data_root: str) -> dict[int, str]:
    """{No: data-root-relative POSIX path} for every CSV/**/<No>_*.csv."""
    out: dict[int, str] = {}
    for f in glob.glob(
        os.path.join(data_root, REL_ROOT, "CSV", "**", "*.csv"), recursive=True
    ):
        base = os.path.basename(f)
        head = base.split("_", 1)[0]
        if head.isdigit():
            rel = os.path.relpath(f, data_root).replace("\\", "/")
            out.setdefault(int(head), rel)
    return out


def trace_preamble(path: str) -> tuple[str | None, datetime | None]:
    """Cheap read of a trace CSV's first lines -> (recipe, start_dt)."""
    recipe = start = None
    try:
        with open(path, "rb") as fh:
            head = fh.read(2000).decode("cp1252", errors="replace")
        for ln in head.splitlines()[:4]:
            low = ln.lower()
            if low.startswith("used recipe:"):
                recipe = ln.split(":", 1)[1].strip().replace(".rcp", "") or None
            elif "starttime" in low:
                start = parse_de_dt(ln.split(":", 1)[1] if ":" in ln else ln)
    except OSError:
        pass
    return recipe, start


def read_recipes(data_root: str) -> dict[str, dict]:
    """PROGS/*.rcp -> {lower(name): recipe row} for machine '250'."""
    out: dict[str, dict] = {}
    for path in glob.glob(os.path.join(data_root, REL_ROOT, "PROGS", "*.rcp")):
        name = os.path.splitext(os.path.basename(path))[0]
        try:
            text = open(path, "rb").read().decode("cp1252", errors="replace")
        except OSError:
            text = ""
        segments = [ln.split(";") for ln in text.splitlines() if ln.strip()]
        row = {
            "id": frx.recipe_id("250", None, name),
            "machine": "250",
            "program_nr": None,
            "name": name,
            "group_name": None,
            "source_file": os.path.relpath(path, data_root).replace("\\", "/"),
            "params": {"segments": segments[:40]},
        }
        row.update(frx.rcp_targets_from_name(name))
        out[name.strip().lower()] = row
    return out


def build_ops(data_root: str) -> tuple[list[dict], dict[int, str]]:
    exp = read_export(data_root)
    traces = trace_files(data_root)
    all_nos = sorted(set(exp) | set(traces))
    ops: list[dict] = []
    for no in all_nos:
        e = exp.get(no)
        rel = traces.get(no)
        recipe = material_text = customer = remark = status = None
        start = None
        if e:
            start = parse_de_dt(e["start"])
            recipe = (e["recipe"] or e["name"] or "").strip() or None
            material_text = e["material"] or None
            customer = e["customer"] or None
            remark = e["remark"] or None
            status = e["status"] or None
        if (start is None or recipe is None) and rel:
            pre_recipe, pre_start = trace_preamble(os.path.join(data_root, rel))
            recipe = recipe or pre_recipe
            start = start or pre_start
        if start is None:
            # No usable timestamp anywhere — skip (can't date the op).
            continue
        operator_name, owner_email, raw_user = fm.parse_user(customer)
        notes = (
            " ".join(
                filter(
                    None,
                    [
                        remark,
                        f"Status: {status}"
                        if status and status.lower() != "ready"
                        else None,
                    ],
                )
            )
            or None
        )
        ops.append(
            {
                "run_no": no,
                "source_run_uid": uid_for(no),
                "operation_id": op_id_for(no),
                "operation_date": start,
                "operator_disp": operator_name,
                "operator_name": raw_user,
                "owner_email": owner_email,
                "material_code": fm.match_material(material_text),
                "material_text": material_text,
                "recipe": recipe,
                "mass_grams": parse_mass_grams(e["load"]) if e else None,
                "outcome_notes": notes,
                "trace_rel": rel,
            }
        )
    return ops, traces


def write_operations(
    cur,
    ops: list[dict],
    *,
    op_to_id: dict,
    code_to_mat: dict,
    resolve_owner,
    equipment_id: str = EQUIP_250,
    method_id: str = METHOD_MF,
) -> tuple[int, int, int]:
    """Upsert the built runs into manufacturing_operations and queue their trace files.

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
        "sintering_mass_grams",
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
            o["recipe"],
            fast_ops.run_number(o["run_no"]),
            o.get("fast_recipe_id"),
            o["mass_grams"],
            o["material_text"],
            o["outcome_notes"],
        )
        for o in ops
    ]

    # Upsert: refresh mutable metadata; pass_code is never written (the database builds it from the run number).
    # A hand-logged operation of this machine and run (typed by a person) becomes the imported run.
    adopted = fast_ops.adopt_hand_logged(
        cur,
        equipment_id,
        SOURCE_SYSTEM,
        [(fast_ops.run_number(o["run_no"]), o["source_run_uid"]) for o in ops],
    )
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
    psycopg2.extras.execute_values(
        cur,
        f"INSERT INTO manufacturing_operations ({', '.join(cols)}) VALUES %s "
        f"ON CONFLICT (source_run_uid) WHERE source_run_uid IS NOT NULL "
        f"DO UPDATE SET {set_clause}, updated_at=now()",
        values,
    )

    # Enqueue trace imports for runs that have a local trace file.
    # An adopted operation keeps its own id, so read the ids back instead of using the derived ones.
    ids = fast_ops.operation_ids_for(cur, [o["source_run_uid"] for o in ops if o["trace_rel"]])
    enq = [(ids[o["source_run_uid"]], o["trace_rel"]) for o in ops if o["trace_rel"]]
    psycopg2.extras.execute_values(
        cur,
        "INSERT INTO fast_run_data (operation_id, status, machine_format, import_archive_path) "
        "VALUES %s ON CONFLICT (operation_id) DO UPDATE "
        "SET status='pending', machine_format=EXCLUDED.machine_format, "
        "    import_archive_path=EXCLUDED.import_archive_path, error_message=NULL, updated_at=now() "
        "WHERE fast_run_data.status IS DISTINCT FROM 'done'",  # don't re-drain finished traces
        [(oid, "pending", "250", rel) for oid, rel in enq],
    )
    return len(values), adopted, len(enq)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("data_root", help="path to the 'FAST Machines Data' folder")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    ops, traces = build_ops(args.data_root)

    # Recipes from PROGS/*.rcp, plus a name-only row for any run whose recipe has no .rcp
    # file (the export list truncates long recipe names) — never drop the link.
    recipes = read_recipes(args.data_root)
    for o in ops:
        nm = (o["recipe"] or "").strip()
        if not nm:
            continue
        key = nm.lower()
        if key not in recipes:
            recipes[key] = {
                "id": frx.recipe_id("250", None, nm),
                "machine": "250",
                "program_nr": None,
                "name": nm,
                "group_name": None,
                "source_file": None,
                "params": None,
                **frx.rcp_targets_from_name(nm),
            }
        o["fast_recipe_id"] = recipes[key]["id"]

    with_trace = sum(1 for o in ops if o["trace_rel"])
    linked_mat = sum(1 for o in ops if o["material_code"])
    linked_owner = sum(1 for o in ops if o["owner_email"])
    print(
        f"FAST 250: {len(ops)} operations "
        f"({with_trace} with a local trace, {len(traces)} trace files seen)"
    )
    print(f"  material linked: {linked_mat}   owner linked: {linked_owner}")

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
                        "recipe",
                        "material_code",
                        "operator_name",
                        "mass_grams",
                        "trace_rel",
                    )
                },
            )
        return

    dsn = os.environ.get("DATABASE_URL") or sys.exit("ERROR: DATABASE_URL required")
    conn = psycopg2.connect(dsn)
    conn.autocommit = False
    cur = conn.cursor()

    # New materials (idempotent) + resolve code -> id.
    psycopg2.extras.execute_values(
        cur,
        "INSERT INTO materials (material_id, alloy_code, common_name, notes) VALUES %s "
        "ON CONFLICT DO NOTHING",
        [(fm.material_id(c), c, n, "FAST import") for c, n in fm.NEW_MATERIALS],
    )
    cur.execute("SELECT alloy_code, material_id FROM materials")
    code_to_mat = {c: m for c, m in cur.fetchall()}

    # Machine_Operators (idempotent).
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

    psycopg2.extras.execute_values(
        cur,
        "INSERT INTO fast_recipes (id, machine, program_nr, name, group_name, source_file, "
        "target_temp_c, target_force_kn, hold_time_min, params) VALUES %s "
        "ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, source_file=EXCLUDED.source_file, "
        "  target_temp_c=EXCLUDED.target_temp_c, target_force_kn=EXCLUDED.target_force_kn, "
        "  hold_time_min=EXCLUDED.hold_time_min, params=EXCLUDED.params, updated_at=now()",
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
                psycopg2.extras.Json(r["params"]) if r.get("params") else None,
            )
            for r in recipes.values()
        ],
        page_size=500,
    )
    print(f"upserted {len(recipes)} FAST 250 recipes")

    n_ops, adopted, queued = write_operations(
        cur,
        ops,
        op_to_id=op_to_id,
        code_to_mat=code_to_mat,
        resolve_owner=resolve_owner,
    )
    print(f"upserted {n_ops} FAST 250 operations ({adopted} hand-logged filled in)")
    print(f"enqueued {queued} trace imports (status=pending)")

    conn.commit()
    cur.close()
    conn.close()
    print("done. Next: run fast_orchestrator.py with ARCHIVE_UNC set to the data-root.")


if __name__ == "__main__":
    main()
