#!/usr/bin/env python3
"""Generate the Lab Member permission rows from scripts/access_rules.json (ADR-0011).

access_rules.json is the single source of the row-level visibility rules. This script turns it into
`directus_permissions` rows and keeps the two places that carry them in step:

  --json     print every Lab Member row as JSON, with a `ruled` flag for the collections that
             have rules (tests compare the database with this)
  --sql      print the INSERT statement, between its BEGIN/END GENERATED markers
  --values   print every row of the collections that have rules (or custom rows) as
             `(collection, action, filter, validation, fields)` VALUES lines, to paste into the
             migration that applies a rule change (a migration is a snapshot, so it embeds the rules
             as they were on the day it was written)
  --hook     print the rules the d1-access-guard hook enforces: the parents' update filters (junction
             guards) and the delete filters of records whose owner may not be changed by an editor
  --write    replace the marked block in scripts/configure_users_and_policies.sql and rewrite
             core/extensions/d1-access-guard/rules.json
  --check    exit 1 when either differs from what the rules generate (CI and pre-commit run this)
  --resolve FILE
             check that every path of every rule resolves, against the relations, columns and field
             rows of a Directus database, given as JSON {"relations": [[many_collection, many_field,
             one_collection, one_field], ...], "columns": ["table.column", ...],
             "fields": ["collection.field", ...]} (tests/phase1_schema.sh dumps it)

A rule is an OR of paths. Each path ends at a user column that must equal `$CURRENT_USER`, e.g.
`co_owners._some.user_id` becomes `{"co_owners": {"_some": {"user_id": {"_eq": "$CURRENT_USER"}}}}`.
Standard library only.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
RULES_FILE = HERE / "access_rules.json"
SCRIPT_FILE = HERE / "configure_users_and_policies.sql"
HOOK_RULES_FILE = HERE.parent / "core" / "extensions" / "d1-access-guard" / "rules.json"

BEGIN = (
    "-- BEGIN GENERATED: Lab Member permissions "
    "(scripts/gen_access_rules.py --write; do not edit by hand)"
)
END = "-- END GENERATED: Lab Member permissions"
ACTIONS = ("create", "read", "update", "delete")
CURRENT_USER = "$CURRENT_USER"


class RulesError(ValueError):
    """The rules file is inconsistent."""


def load(path: Path = RULES_FILE) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def expand(sets: dict, name: str, prefix: str = "", _stack: tuple = ()) -> list[str]:
    """All paths of a named set, with `prefix` put in front of each, in order."""
    if name not in sets:
        raise RulesError(f"unknown set {name!r}")
    if name in _stack:
        raise RulesError(
            f"set {name!r} includes itself ({' -> '.join(_stack + (name,))})"
        )
    out: list[str] = []
    for item in sets[name]:
        if isinstance(item, str):
            out.append(prefix + item)
        else:
            via = item.get("via", "")
            inner = f"{prefix}{via}." if via else prefix
            out.extend(expand(sets, item["set"], inner, _stack + (name,)))
    return out


def path_filter(path: str) -> dict:
    """`a.b._some.c` -> {"a": {"b": {"_some": {"c": {"_eq": "$CURRENT_USER"}}}}}."""
    node: dict = {"_eq": CURRENT_USER}
    for key in reversed(path.split(".")):
        node = {key: node}
    return node


def set_filter(sets: dict, name: str) -> dict:
    paths = list(dict.fromkeys(expand(sets, name)))  # drop duplicates, keep order
    filters = [path_filter(p) for p in paths]
    return filters[0] if len(filters) == 1 else {"_or": filters}


def build_rows(doc: dict) -> list[dict]:
    """Every Lab Member row: filtered collections first, then custom rows, then unfiltered grants."""
    sets, policy = doc["sets"], doc["policy"]
    rows: list[dict] = []

    def row(
        collection: str,
        action: str,
        permissions: dict,
        validation: dict | None = None,
        fields: str = "*",
    ) -> dict:
        return {
            "collection": collection,
            "action": action,
            "permissions": permissions,
            "validation": validation or {},
            "fields": fields,
            "policy": policy,
        }

    for collection, actions in doc["rules"].items():
        unknown = set(actions) - set(ACTIONS)
        if unknown:
            raise RulesError(f"{collection}: unknown action(s) {sorted(unknown)}")
        for action in ACTIONS:
            if action not in actions:
                continue
            rule = actions[action]
            if rule == "any":
                rows.append(row(collection, action, {}))
            elif action == "create":
                raise RulesError(
                    f'{collection}.create: Directus ignores item filters on create; use "any"'
                )
            else:
                rows.append(row(collection, action, set_filter(sets, rule)))
    for collection, actions in doc.get("custom", {}).items():
        if collection in doc["rules"]:
            raise RulesError(f"{collection} is both ruled and custom")
        unknown = set(actions) - set(ACTIONS)
        if unknown:
            raise RulesError(f"{collection}: unknown action(s) {sorted(unknown)}")
        for action in ACTIONS:
            if action not in actions:
                continue
            spec = actions[action]
            extra = set(spec) - {"permissions", "validation", "fields"}
            if extra:
                raise RulesError(
                    f"{collection}.{action}: unknown key(s) {sorted(extra)}"
                )
            if action == "create" and spec.get("permissions"):
                raise RulesError(
                    f"{collection}.create: Directus ignores item filters on create; use validation"
                )
            rows.append(
                row(
                    collection,
                    action,
                    spec.get("permissions", {}),
                    spec.get("validation", {}),
                    ",".join(spec["fields"]) if "fields" in spec else "*",
                )
            )
    seen = {(r["collection"], r["action"]) for r in rows}
    for collection, actions in doc["unfiltered"].items():
        for action in actions:
            if action not in ACTIONS:
                raise RulesError(f"{collection}: unknown action {action!r}")
            if (collection, action) in seen:
                raise RulesError(f"{collection}.{action} is both ruled and unfiltered")
            rows.append(row(collection, action, {}))
    return rows


def ruled_collections(doc: dict) -> set[str]:
    """Collections whose rows a migration must apply: filtered ones and the custom rows."""
    return set(doc["rules"]) | set(doc.get("custom", {}))


def compact(value: object) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=True)


def sql_block(rows: list[dict]) -> str:
    lines = [
        BEGIN,
        "INSERT INTO directus_permissions (collection, action, permissions, validation, fields, policy) VALUES",
    ]
    values = [
        f"('{r['collection']}', '{r['action']}', '{compact(r['permissions'])}', "
        f"'{compact(r['validation'])}', '{r['fields']}', '{r['policy']}')"
        for r in rows
    ]
    lines.append(",\n".join(values) + ";")
    lines.append(END)
    return "\n".join(lines)


def migration_values(rows: list[dict], ruled: set[str]) -> str:
    """Every row of a collection that has rules (create rows included), as VALUES lines."""
    return ",\n".join(
        f"    ('{r['collection']}', '{r['action']}', '{compact(r['permissions'])}', "
        f"'{compact(r['validation'])}', '{r['fields']}')"
        for r in rows
        if r["collection"] in ruled
    )


def hook_rules(doc: dict) -> dict:
    """What d1-access-guard enforces: per junction, the parents whose update rule the caller must pass."""
    sets, rules = doc["sets"], doc["rules"]
    guards: dict = {}
    for junction, checks in doc.get("guards", {}).items():
        if "create" not in rules.get(junction, {}):
            raise RulesError(
                f"guard {junction}: not a ruled collection with a create row"
            )
        out = []
        for check in checks:
            parent, action = check["parent"], check.get("rule", "update")
            rule = rules.get(parent, {}).get(action)
            if rule is None or rule == "any":
                raise RulesError(f"guard {junction}: {parent}.{action} has no filter")
            out.append(
                {
                    "field": check["field"],
                    "parent": parent,
                    "key": check["key"],
                    "filter": set_filter(sets, rule),
                }
            )
        guards[junction] = out
    return {
        "_comment": "Generated by scripts/gen_access_rules.py --write from scripts/access_rules.json (guards, owner_guards). Do not edit by hand.",
        "guards": guards,
        "ownerGuards": owner_guards(doc),
    }


def owner_guards(doc: dict) -> dict:
    """Records whose update rule is wider than their delete rule: changing the owner needs the delete rule.

    Otherwise an editor (a sample's co-owner) could set the owner column to themselves and gain delete.
    """
    sets, rules = doc["sets"], doc["rules"]
    declared = doc.get("owner_guards", {})
    out: dict = {}
    for collection, spec in declared.items():
        update, delete = (
            rules.get(collection, {}).get("update"),
            rules.get(collection, {}).get("delete"),
        )
        for action, rule in (("update", update), ("delete", delete)):
            if rule is None or rule == "any":
                raise RulesError(f"owner_guard {collection}: {action} has no filter")
        if set(spec) != {"field", "key", "value_key"}:
            raise RulesError(
                f"owner_guard {collection}: needs exactly field, key and value_key"
            )
        out[collection] = {
            "field": spec["field"],
            "key": spec["key"],
            "valueKey": spec["value_key"],
            "filter": set_filter(sets, delete),
        }
    for collection, actions in rules.items():
        update, delete = actions.get("update"), actions.get("delete")
        if update is None or delete is None or update == "any" or delete == "any":
            continue
        if collection not in declared and set_filter(sets, update) != set_filter(
            sets, delete
        ):
            raise RulesError(
                f"{collection}: the update rule is wider than the delete rule, so an editor who changes "
                "the owner would gain delete; add it to owner_guards"
            )
    return out


def hook_rules_text(doc: dict) -> str:
    return json.dumps(hook_rules(doc), indent=2) + "\n"


def resolve(doc: dict, db: dict) -> list[str]:
    """Problems that stop a rule from working in Directus: a path that cannot be followed.

    Walks every path of every rule from its collection. A relation field is followed through
    `relations` (many side by `many_field`, one side by `one_field`); the many side must be a
    column and the one side (an alias) a field row of its collection; the last part must be a column.
    """
    relations = [tuple(r) for r in db["relations"]]
    columns, fields = set(db["columns"]), set(db["fields"])
    problems: list[str] = []

    def step(table: str, part: str) -> str | None:
        for many_c, many_f, one_c, _one_f in relations:
            if many_c == table and many_f == part and one_c:
                return one_c if f"{table}.{part}" in columns else None
        for many_c, _many_f, one_c, one_f in relations:
            if one_c == table and one_f == part:
                return many_c if f"{table}.{part}" in fields else None
        return None

    def walk(collection: str, label: str, path: str) -> None:
        table = collection
        parts = [p for p in path.split(".") if p != "_some"]
        for part in parts[:-1]:
            nxt = step(table, part)
            if nxt is None:
                problems.append(
                    f"{label}: {path}: {table}.{part} is not a relation field Directus knows"
                )
                return
            table = nxt
        if f"{table}.{parts[-1]}" not in columns:
            problems.append(f"{label}: {path}: {table}.{parts[-1]} is not a column")

    for collection, actions in doc["rules"].items():
        for action, rule in actions.items():
            if rule == "any":
                continue
            for path in dict.fromkeys(expand(doc["sets"], rule)):
                walk(collection, f"{collection}.{action}", path)
    for junction, checks in doc.get("guards", {}).items():
        for check in checks:
            if step(junction, check["field"]) != check["parent"]:
                problems.append(
                    f"guard {junction}.{check['field']} is not a relation to {check['parent']}"
                )
            if f"{check['parent']}.{check['key']}" not in columns:
                problems.append(
                    f"guard {junction}: {check['parent']}.{check['key']} is not a column"
                )
    for collection, spec in doc.get("owner_guards", {}).items():
        for column in (spec["field"], spec["key"]):
            if f"{collection}.{column}" not in columns:
                problems.append(
                    f"owner_guard {collection}: {collection}.{column} is not a column"
                )
        target = step(collection, spec["field"])
        if target is None or f"{target}.{spec['value_key']}" not in columns:
            problems.append(
                f"owner_guard {collection}.{spec['field']}: not a relation to a table with column {spec['value_key']}"
            )
    return problems


def script_block(script_text: str) -> tuple[int, int]:
    start = script_text.find(BEGIN)
    end = script_text.find(END)
    if start < 0 or end < 0 or end < start:
        raise RulesError(f"the script has no '{BEGIN[:40]}...' block")
    return start, end + len(END)


def render_script(script_text: str, rows: list[dict]) -> str:
    start, end = script_block(script_text)
    return script_text[:start] + sql_block(rows) + script_text[end:]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawTextHelpFormatter
    )
    mode = ap.add_mutually_exclusive_group(required=True)
    for flag in ("json", "sql", "values", "hook", "write", "check"):
        mode.add_argument(f"--{flag}", action="store_true")
    mode.add_argument("--resolve", type=Path, metavar="FILE")
    ap.add_argument("--rules", type=Path, default=RULES_FILE)
    ap.add_argument("--script", type=Path, default=SCRIPT_FILE)
    ap.add_argument("--hook-rules", type=Path, default=HOOK_RULES_FILE)
    args = ap.parse_args(argv)

    doc = load(args.rules)
    try:
        rows = build_rows(doc)
        hook_text = hook_rules_text(doc)
    except RulesError as exc:
        print(f"access_rules: {exc}", file=sys.stderr)
        return 2

    if args.json:
        ruled = ruled_collections(doc)
        print(
            json.dumps(
                [{**r, "ruled": r["collection"] in ruled} for r in rows], indent=1
            )
        )
    elif args.sql:
        print(sql_block(rows))
    elif args.values:
        print(migration_values(rows, ruled_collections(doc)))
    elif args.hook:
        print(hook_text, end="")
    elif args.resolve:
        problems = resolve(doc, json.loads(args.resolve.read_text(encoding="utf-8")))
        for problem in problems:
            print(problem)
        if problems:
            return 1
        print("every rule path resolves")
    elif args.write:
        text = args.script.read_text(encoding="utf-8")
        args.script.write_text(render_script(text, rows), encoding="utf-8")
        args.hook_rules.parent.mkdir(parents=True, exist_ok=True)
        args.hook_rules.write_text(hook_text, encoding="utf-8")
    else:
        text = args.script.read_text(encoding="utf-8")
        stale = []
        if render_script(text, rows) != text:
            stale.append(args.script.name)
        have = (
            args.hook_rules.read_text(encoding="utf-8")
            if args.hook_rules.exists()
            else ""
        )
        if have != hook_text:
            stale.append(args.hook_rules.parent.name + "/" + args.hook_rules.name)
        if stale:
            print(
                f"{', '.join(stale)} differ(s) from {args.rules.name}: "
                "run `python3 scripts/gen_access_rules.py --write`",
                file=sys.stderr,
            )
            return 1
        print(
            f"{args.script.name} and the d1-access-guard rules match {args.rules.name} ({len(rows)} rows)"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
