#!/usr/bin/env python3
"""Generate the Lab Member permission rows from scripts/access_rules.json (ADR-0011, A1 record access).

access_rules.json is the single source of the row-level visibility rules. This script turns it into
`directus_permissions` rows and keeps the places that carry them in step:

  --json     print every Lab Member row as JSON, with a `ruled` flag for the collections that
             have rules (tests compare the database with this)
  --sql      print the INSERT statement, between its BEGIN/END GENERATED markers
  --values   print every row of the collections that have rules (or custom rows) as
             `(collection, action, filter, validation, fields)` VALUES lines, to paste into the
             migration that applies a rule change (a migration is a snapshot, so it embeds the rules
             as they were on the day it was written); `--only a,b` narrows it to those collections
  --hook     print the rules the d1-access-guard hook enforces: the parents' filters (junction
             guards), the delete filters of records whose owner may not be changed by an editor and
             the keys that move a record between restricted parents
  --record   print the rules file of the d1-record-access endpoint (per record type: the access
             table, the read filter and the manage filter)
  --write    replace the marked block in scripts/configure_users_and_policies.sql and rewrite
             core/extensions/d1-access-guard/rules.json and core/extensions/d1-record-access/rules.json
  --check    exit 1 when any of them differs from what the rules generate (CI and pre-commit run this)
  --resolve FILE
             check that every path of every rule resolves, against the relations, columns and field
             rows of a Directus database, given as JSON {"relations": [[many_collection, many_field,
             one_collection, one_field], ...], "columns": ["table.column", ...],
             "fields": ["collection.field", ...]} (tests/phase1_schema.sh dumps it)

A rule is a SET: a list (the OR of its items) or {"and": [...]} (the AND of its items). An item is

  "owner_person_id.user_id"       a user leaf: a path that ends at a user column that must equal `$CURRENT_USER`,
                                  e.g. `co_owners._some.user_id` becomes
                                  {"co_owners": {"_some": {"user_id": {"_eq": "$CURRENT_USER"}}}}
  {"set": "x", "via": "sample_id"} another set, with every path put behind a to-ONE relation (`via` must be an M2O)
  {"path": "access._some.person_id.user_id", "at": "access", "where": {"role": ["edit"]}}
                                  a user leaf plus `role _in [...]` on the same row of the junction `at`
  {"field": "restricted", "eq": false} / {"field": "sample_id", "null": true}
                                  a literal leaf on a column (the field may be a to-one chain, "campaign_id.restricted")
  {"unless_restricted": [...]}    AND(restricted = false, OR(items)), on the row the prefix points at
  {"each": "campaigns", "items": [...]}
                                  conditions that must hold on ONE row of a to-many alias (items are relative to the
                                  junction), written as an AND of paths through the bare alias
  {"and": [...]}  {"or": [...]}   nesting

The sets are built into a tree first (a `via` prefix is distributed onto the leaves, never wrapped around an
`_or`/`_and`, so no logical operator sits under a relation key except in a `_some` body) and flattened to
Directus filters last. Standard library only.
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
RECORD_RULES_FILE = (
    HERE.parent / "core" / "extensions" / "d1-record-access" / "rules.json"
)

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


# -- the rule tree ------------------------------------------------------------------------------
#
# A node is a tuple:
#   ("user", parts, where, at)        a user leaf; `parts` is the whole path from the collection the rule is on
#   ("lit", parts, op, value)         a literal leaf ({parts...: {op: value}})
#   ("and", [nodes]) / ("or", [nodes])
#   ("each", base, alias, [nodes])    the AND of the nodes on one row of the to-many `alias`; `base` = len(prefix)
#                                     at the alias (the nodes carry prefix + alias in front of their own path)
# `parts` keep the literal "_some" tokens of a user path: whether one is emitted is decided in path_filter().


def _op_and_items(name: str, spec: object) -> tuple[str, list]:
    if isinstance(spec, list):
        return "or", spec
    if isinstance(spec, dict) and len(spec) == 1 and next(iter(spec)) in ("and", "or"):
        op = next(iter(spec))
        return op, spec[op]
    raise RulesError(f'set {name!r}: expected a list or {{"and": [...]}}')


def build_set(
    sets: dict,
    name: str,
    prefix: tuple = (),
    _stack: tuple = (),
    vias: list | None = None,
) -> tuple:
    """The tree of a named set, every path prefixed with `prefix`. `vias` collects (path, n): the last n parts of
    `path` came from a `via` and must be to-one hops (resolve() checks it)."""
    if name not in sets:
        raise RulesError(f"unknown set {name!r}")
    if name in _stack:
        raise RulesError(
            f"set {name!r} includes itself ({' -> '.join(_stack + (name,))})"
        )
    op, items = _op_and_items(name, sets[name])
    if not items:
        raise RulesError(f"set {name!r} is empty")
    return (
        op,
        [build_item(sets, i, prefix, _stack + (name,), vias, name) for i in items],
    )


def _parts(text: str) -> tuple:
    return tuple(p for p in text.split(".") if p)


def build_item(
    sets: dict,
    item: object,
    prefix: tuple,
    stack: tuple,
    vias: list | None,
    where_from: str = "?",
) -> tuple:
    if isinstance(item, str):
        return ("user", prefix + _parts(item), None, None)
    if not isinstance(item, dict):
        raise RulesError(f"set {where_from!r}: bad item {item!r}")
    keys = set(item)

    def sub(items: list) -> list:
        if not items:
            raise RulesError(f"set {where_from!r}: empty {sorted(keys)[0]} list")
        return [build_item(sets, i, prefix, stack, vias, where_from) for i in items]

    if "set" in keys:
        if keys - {"set", "via"}:
            raise RulesError(f"set {where_from!r}: unknown key(s) in {item!r}")
        via = _parts(item.get("via", ""))
        if via and vias is not None:
            vias.append((prefix + via, len(via)))
        return build_set(sets, item["set"], prefix + via, stack, vias)
    if "path" in keys:
        if keys - {"path", "at", "where"} or not {"at", "where"} <= keys:
            raise RulesError(
                f"set {where_from!r}: a path item needs at and where: {item!r}"
            )
        parts = prefix + _parts(item["path"])
        if item["at"] not in parts:
            raise RulesError(
                f"set {where_from!r}: 'at' {item['at']!r} is not in path {item['path']!r}"
            )
        return ("user", parts, dict(item["where"]), item["at"])
    if "field" in keys:
        if keys not in ({"field", "eq"}, {"field", "null"}):
            raise RulesError(
                f"set {where_from!r}: a field item has field and eq or null: {item!r}"
            )
        parts = prefix + _parts(item["field"])
        if "eq" in keys:
            return ("lit", parts, "_eq", item["eq"])
        return ("lit", parts, "_null", item["null"])
    if keys == {"unless_restricted"}:
        return (
            "and",
            [
                ("lit", prefix + ("restricted",), "_eq", False),
                ("or", sub(item["unless_restricted"])),
            ],
        )
    if "each" in keys:
        if keys != {"each", "items"} or not item["items"]:
            raise RulesError(f"set {where_from!r}: bad each item {item!r}")
        alias = item["each"]
        inner = prefix + (alias,)
        return (
            "each",
            len(prefix),
            alias,
            [
                build_item(sets, i, inner, stack, vias, where_from)
                for i in item["items"]
            ],
        )
    if keys == {"and"} or keys == {"or"}:
        op = next(iter(keys))
        return (op, sub(item[op]))
    raise RulesError(f"set {where_from!r}: unknown item {item!r}")


def user_paths(node: tuple) -> list[str]:
    """Every user-leaf path of a tree, in order (the literal leaves are conditions, not paths)."""
    kind = node[0]
    if kind == "user":
        return [".".join(node[1])]
    if kind == "lit":
        return []
    return [p for child in node[-1] for p in user_paths(child)]


def expand(sets: dict, name: str, prefix: str = "", _stack: tuple = ()) -> list[str]:
    """All user-leaf paths of a named set, with `prefix` ("a.b.") put in front of each, in order."""
    return user_paths(build_set(sets, name, _parts(prefix), _stack))


def path_filter(
    path: str | list | tuple,
    where: dict | None = None,
    at: str | None = None,
    leaf: dict | None = None,
) -> dict:
    """`a.b._some.c` -> {"a": {"b": {"_some": {"c": {"_eq": "$CURRENT_USER"}}}}}.

    Directus's filter engine (apply-query/filter) only gives `_some`/`_none` their EXISTS-subquery
    handling when the field immediately above them is a to-many relation reached with exactly one
    hop from where that subquery started -- i.e. `_some` at path index 1, or immediately following
    another legal `_some` (starting a fresh one-hop subquery of its own). Reached any other way --
    through a preceding to-one hop, e.g. `project_id.secondary_investigators._some.user_id` -- it
    falls through to `throw new InvalidQueryError("_some can only be used with top level
    relational alias field")`. A chain of legal `_some`s (`samples._some.co_owners._some.user_id`,
    confirmed against a running Directus) is fine: each one starts a new subquery at its own
    top level. An illegal `_some` doesn't just break its own collection either -- the subquery
    recurses into the related collection's OWN Lab Member rule (getCases), so one illegal `_some`
    buried in, say, physical_samples.read throws for any other collection whose rule joins into
    physical_samples. A bare relational filter with no `_some` still means "any row" in a
    permission filter, so an illegal `_some` is simply dropped, not replaced.

    Two more things Directus 11.17 does that shape every output (found on a restored copy, 2026-10-12):
      * a relation key's value is read by its FIRST key only (apply-query/get-operation.js), so
        {"access": {"person_id": ..., "role": ...}} silently ignores `role`; two conditions on one
        row must be two paths under a root `_and`;
      * a `_some` whose body is anything but one plain chain (an `_and`, an `_or`, two keys) makes the
        per-field permission CASE collapse to `WHEN 1` and the request fail with a 500.
    So `where` ({column: [values]}, the role test) is written as an `_and` of the user path and one path
    per column, all through the same bare to-many alias: Directus joins an alias once per query path, so
    they are conditions on one row. A path with a `where` therefore has no `_some` at all.
    `leaf` replaces the user test ({"_eq": "$CURRENT_USER"}) for the literal leaves.
    """
    parts = path.split(".") if isinstance(path, str) else list(path)
    if where:
        bare = [p for p in parts if p != "_some"]
        at_index = bare.index(at)
        user = path_filter(bare, leaf=leaf)
        columns = [
            path_filter([*bare[: at_index + 1], col], leaf={"_in": list(values)})
            for col, values in where.items()
        ]
        return combine("_and", [user, *columns])
    legal_some: set[int] = set()
    for i, p in enumerate(parts):
        if p == "_some" and (i == 1 or (i - 2) in legal_some):
            legal_some.add(i)
    node: dict = {"_eq": CURRENT_USER} if leaf is None else leaf
    for i in reversed(range(len(parts))):
        key = parts[i]
        if key == "_some" and i not in legal_some:
            continue  # illegal position: drop it, Directus treats the hop as an implicit "any" join
        node = {key: node}
    return node


def combine(op: str, filters: list[dict]) -> dict:
    """AND/OR of filters: nested ones of the same operator are merged, duplicates dropped, one stays itself."""
    flat: list[dict] = []
    for f in filters:
        flat.extend(f[op] if set(f) == {op} else [f])
    flat = [json.loads(s) for s in dict.fromkeys(json.dumps(f) for f in flat)]
    return flat[0] if len(flat) == 1 else {op: flat}


def emit(node: tuple) -> dict:
    """The Directus filter of a tree (see path_filter for what Directus accepts)."""
    kind = node[0]
    if kind == "user":
        _, parts, where, at = node
        return path_filter(list(parts), where, at)
    if kind == "lit":
        _, parts, op, value = node
        return path_filter(list(parts), leaf={op: value})
    if kind in ("and", "or"):
        return combine(f"_{kind}", [emit(child) for child in node[1]])
    # `each`: conditions on one row of a to-many alias. They are written as paths through the bare alias (every
    # path of a query shares its joined alias, so they hold on the same row); the `_some` form
    # {alias: {_some: {_and: [...]}}} is the textbook one and Directus 500s on it.
    return combine("_and", [emit(child) for child in node[3]])


def set_filter(sets: dict, name: str) -> dict:
    return emit(build_set(sets, name))


def amnesty_filter(spec: dict, sets: dict | None = None) -> dict:
    """A record where every column of spec["null"] is NULL (and, with restricted_false, the record is not
    restricted, and, with `also`, a set holds) -- see 'orphan_amnesty' in access_rules.json."""
    extra = set(spec) - {"null", "restricted_false", "also"}
    if extra or not spec.get("null"):
        raise RulesError(f"orphan_amnesty: needs null columns, unknown {sorted(extra)}")
    clauses = [{c: {"_null": True}} for c in spec["null"]]
    if spec.get("restricted_false"):
        clauses.append({"restricted": {"_eq": False}})
    if "also" in spec:
        if sets is None:
            raise RulesError("orphan_amnesty: `also` needs the sets")
        clauses.append(set_filter(sets, spec["also"]))
    return combine("_and", clauses)


def with_amnesty(base: dict, spec: dict, sets: dict | None = None) -> dict:
    """OR `base` with the orphan-amnesty clause, flattening into an existing top-level _or."""
    return combine("_or", [base, amnesty_filter(spec, sets)])


def rule_filter(doc: dict, collection: str, action: str) -> dict:
    """The permission filter of a ruled collection and action (read gets its orphan amnesty)."""
    filt = set_filter(doc["sets"], doc["rules"][collection][action])
    amnesty = doc.get("orphan_amnesty", {}).get(collection)
    if action == "read" and amnesty:
        filt = with_amnesty(filt, amnesty, doc["sets"])
    return filt


def build_rows(doc: dict) -> list[dict]:
    """Every Lab Member row: filtered collections first, then custom rows, then unfiltered grants."""
    policy = doc["policy"]
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
                rows.append(
                    row(collection, action, rule_filter(doc, collection, action))
                )
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


def migration_values(
    rows: list[dict], ruled: set[str], only: set[str] | None = None
) -> str:
    """Every row of a collection that has rules (create rows included), as VALUES lines.
    `only` narrows it to those collections (a migration that changes some of the rules)."""
    return ",\n".join(
        f"    ('{r['collection']}', '{r['action']}', '{compact(r['permissions'])}', "
        f"'{compact(r['validation'])}', '{r['fields']}')"
        for r in rows
        if r["collection"] in ruled and (only is None or r["collection"] in only)
    )


def hook_rules(doc: dict) -> dict:
    """What d1-access-guard enforces: per junction, the parents whose rule the caller must pass; per record,
    the owner-only fields and their delete rule; the keys that move a record between restricted parents."""
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
    restricted_keys = {}
    for collection, keys in doc.get("restricted_keys", {}).items():
        if collection not in doc.get("owner_guards", {}):
            raise RulesError(
                f"restricted_keys {collection}: the delete rule it needs comes from an owner_guards entry"
            )
        restricted_keys[collection] = list(keys)
    return {
        "_comment": "Generated by scripts/gen_access_rules.py --write from scripts/access_rules.json (guards, owner_guards, restricted_keys). Do not edit by hand. ownerGuards[].field and .valueKey repeat the first entry of .fields for hooks that predate the list.",
        "guards": guards,
        "ownerGuards": owner_guards(doc),
        "restrictedKeys": restricted_keys,
    }


def owner_guards(doc: dict) -> dict:
    """Records whose update rule is wider than their delete rule: changing the owner (or the restricted flag)
    needs the delete rule.

    Otherwise an editor (a sample's co-owner, a person with Can edit) could set the owner column to
    themselves and gain delete, or lift a restriction.
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
        if set(spec) != {"key", "fields"} or not spec["fields"]:
            raise RulesError(
                f"owner_guard {collection}: needs exactly key and a non-empty fields list"
            )
        fields = []
        for entry in spec["fields"]:
            if "field" not in entry or set(entry) - {"field", "value_key"}:
                raise RulesError(
                    f"owner_guard {collection}: a field entry is {{field, value_key?}}: {entry!r}"
                )
            fields.append(
                {"field": entry["field"]}
                | ({"valueKey": entry["value_key"]} if "value_key" in entry else {})
            )
        out[collection] = {
            "key": spec["key"],
            "fields": fields,
            "field": fields[0]["field"],
            "valueKey": fields[0].get("valueKey"),
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


RECORD_KEYS = {"table", "fk", "key", "owner_field", "roles"}


def record_rules(doc: dict) -> dict:
    """The rules file of the d1-record-access endpoint: per record type its access table, the filter that says
    the caller can read the record and the one that says the caller may manage it (the delete rule)."""
    out: dict = {}
    for collection, spec in doc.get("record_access", {}).items():
        if set(spec) != RECORD_KEYS:
            raise RulesError(f"record_access {collection}: needs {sorted(RECORD_KEYS)}")
        actions = doc["rules"].get(collection, {})
        for action in ("read", "delete"):
            if actions.get(action) in (None, "any"):
                raise RulesError(f"record_access {collection}: no {action} filter")
        out[collection] = {
            "table": spec["table"],
            "fk": spec["fk"],
            "key": spec["key"],
            "ownerField": spec["owner_field"],
            "roles": list(spec["roles"]),
            "read": rule_filter(doc, collection, "read"),
            "manage": rule_filter(doc, collection, "delete"),
        }
    return {
        "_comment": "Generated by scripts/gen_access_rules.py --write from scripts/access_rules.json (record_access). Do not edit by hand. read = the record's Lab Member read filter, manage = its delete filter (the owner, or the PI of a project).",
        "records": out,
    }


def hook_rules_text(doc: dict) -> str:
    return json.dumps(hook_rules(doc), indent=2) + "\n"


def record_rules_text(doc: dict) -> str:
    return json.dumps(record_rules(doc), indent=2) + "\n"


def resolve(doc: dict, db: dict) -> list[str]:
    """Problems that stop a rule from working in Directus: a path that cannot be followed.

    Walks every leaf of every rule from its collection. A relation field is followed through
    `relations` (many side by `many_field`, one side by `one_field`); the many side must be a
    column and the one side (an alias) a field row of its collection; the last part must be a column.
    `where` columns must exist on the junction, `at` and `each` must be to-many aliases, a literal leaf
    must name a column, and every `via` must be a to-one hop (a to-many hop would turn an AND into "some
    row and some row" instead of "one row that satisfies both").
    """
    relations = [tuple(r) for r in db["relations"]]
    columns, fields = set(db["columns"]), set(db["fields"])
    problems: list[str] = []

    def step(table: str, part: str) -> tuple[str, str] | None:
        """(next table, 'm2o' | 'o2m') or None when Directus does not know the hop."""
        for many_c, many_f, one_c, _one_f in relations:
            if many_c == table and many_f == part and one_c:
                return (one_c, "m2o") if f"{table}.{part}" in columns else None
        for many_c, _many_f, one_c, one_f in relations:
            if one_c == table and one_f == part:
                return (many_c, "o2m") if f"{table}.{part}" in fields else None
        return None

    def follow(collection: str, label: str, hops: list[str]) -> str | None:
        """The table reached by walking `hops` from `collection`; a hop Directus does not know is reported."""
        table = collection
        for part in hops:
            nxt = step(table, part)
            if nxt is None:
                problems.append(
                    f"{label}: {table}.{part} is not a relation field Directus knows"
                )
                return None
            table = nxt[0]
        return table

    def alias_target(collection: str, label: str, hops: list[str]) -> str | None:
        """The junction table behind the to-many alias that ends `hops`."""
        before = follow(collection, label, hops[:-1])
        if before is None:
            return None
        nxt = step(before, hops[-1])
        if nxt is None:
            return None  # reported by the leaf walk
        if nxt[1] != "o2m":
            problems.append(f"{label}: {before}.{hops[-1]} is not a to-many alias")
            return None
        return nxt[0]

    def walk_node(collection: str, label: str, node: tuple) -> None:
        kind = node[0]
        if kind in ("and", "or"):
            for child in node[1]:
                walk_node(collection, label, child)
            return
        if kind == "each":
            _, base, alias, children = node
            for child in children:
                walk_node(collection, label, child)
            leaf = children[0]
            while leaf[0] in ("and", "or", "each"):
                leaf = leaf[-1][0]
            hops = [p for p in leaf[1] if p != "_some"][: base + 1]
            if hops and hops[-1] == alias:
                alias_target(collection, f"{label}: each {alias}", hops)
            return
        parts = [p for p in node[1] if p != "_some"]
        text = f"{label}: {'.'.join(node[1])}"
        table = follow(collection, text, parts[:-1])
        if table is not None and f"{table}.{parts[-1]}" not in columns:
            problems.append(f"{text}: {table}.{parts[-1]} is not a column")
        if kind == "user" and node[3] is not None:
            hops = parts[: parts.index(node[3]) + 1]
            junction = alias_target(collection, f"{text} (at {node[3]})", hops)
            for col in node[2] or {}:
                if junction and f"{junction}.{col}" not in columns:
                    problems.append(f"{text}: where {junction}.{col} is not a column")

    def walk_vias(collection: str, label: str, name: str) -> None:
        vias: list = []
        build_set(doc["sets"], name, (), (), vias)
        for parts, n in vias:
            clean = [p for p in parts if p != "_some"]
            table = collection
            for i, part in enumerate(clean):
                nxt = step(table, part)
                if nxt is None:
                    break  # reported by the leaf walk
                if i >= len(clean) - n and nxt[1] != "m2o":
                    problems.append(
                        f"{label}: via {'.'.join(clean[-n:])} goes through the to-many {table}.{part}; "
                        "a via must be a to-one hop"
                    )
                table = nxt[0]

    for collection, actions in doc["rules"].items():
        for action, rule in actions.items():
            if rule == "any":
                continue
            label = f"{collection}.{action}"
            walk_node(collection, label, build_set(doc["sets"], rule))
            walk_vias(collection, label, rule)
    for junction, checks in doc.get("guards", {}).items():
        for check in checks:
            hop = step(junction, check["field"])
            if hop is None or hop[0] != check["parent"]:
                problems.append(
                    f"guard {junction}.{check['field']} is not a relation to {check['parent']}"
                )
            if f"{check['parent']}.{check['key']}" not in columns:
                problems.append(
                    f"guard {junction}: {check['parent']}.{check['key']} is not a column"
                )
    for collection, spec in doc.get("owner_guards", {}).items():
        if f"{collection}.{spec['key']}" not in columns:
            problems.append(
                f"owner_guard {collection}: {collection}.{spec['key']} is not a column"
            )
        for entry in spec["fields"]:
            column = entry["field"]
            if f"{collection}.{column}" not in columns:
                problems.append(
                    f"owner_guard {collection}: {collection}.{column} is not a column"
                )
            if "value_key" in entry:
                hop = step(collection, column)
                if hop is None or f"{hop[0]}.{entry['value_key']}" not in columns:
                    problems.append(
                        f"owner_guard {collection}.{column}: not a relation to a table with column {entry['value_key']}"
                    )
    for collection, keys in doc.get("restricted_keys", {}).items():
        for column in keys:
            if f"{collection}.{column}" not in columns:
                problems.append(
                    f"restricted_keys {collection}: {collection}.{column} is not a column"
                )
    for collection, spec in doc.get("orphan_amnesty", {}).items():
        for col in spec.get("null", []):
            if f"{collection}.{col}" not in columns:
                problems.append(
                    f"orphan_amnesty {collection}: {collection}.{col} is not a column"
                )
        if spec.get("restricted_false") and f"{collection}.restricted" not in columns:
            problems.append(
                f"orphan_amnesty {collection}: {collection}.restricted is not a column"
            )
        if "also" in spec:
            label = f"orphan_amnesty {collection}"
            walk_node(collection, label, build_set(doc["sets"], spec["also"]))
            walk_vias(collection, label, spec["also"])
    for collection, spec in doc.get("record_access", {}).items():
        for table, column in (
            (spec["table"], spec["fk"]),
            (collection, spec["key"]),
            (collection, spec["owner_field"]),
        ):
            if f"{table}.{column}" not in columns:
                problems.append(
                    f"record_access {collection}: {table}.{column} is not a column"
                )
    return problems


def write_lf(path: Path, text: str) -> None:
    """Write with LF line endings on every platform (a CRLF file would differ from what --check generates)."""
    with path.open("w", encoding="utf-8", newline="\n") as f:
        f.write(text)


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
    for flag in ("json", "sql", "values", "hook", "record", "write", "check"):
        mode.add_argument(f"--{flag}", action="store_true")
    mode.add_argument("--resolve", type=Path, metavar="FILE")
    ap.add_argument("--rules", type=Path, default=RULES_FILE)
    ap.add_argument("--script", type=Path, default=SCRIPT_FILE)
    ap.add_argument("--hook-rules", type=Path, default=HOOK_RULES_FILE)
    ap.add_argument("--record-rules", type=Path, default=RECORD_RULES_FILE)
    ap.add_argument(
        "--only",
        metavar="COLLECTION[,COLLECTION...]",
        help="with --values: only these collections",
    )
    args = ap.parse_args(argv)

    doc = load(args.rules)
    try:
        rows = build_rows(doc)
        hook_text = hook_rules_text(doc)
        record_text = record_rules_text(doc)
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
        only = set(args.only.split(",")) if args.only else None
        print(migration_values(rows, ruled_collections(doc), only))
    elif args.hook:
        print(hook_text, end="")
    elif args.record:
        print(record_text, end="")
    elif args.resolve:
        problems = resolve(doc, json.loads(args.resolve.read_text(encoding="utf-8")))
        for problem in problems:
            print(problem)
        if problems:
            return 1
        print("every rule path resolves")
    elif args.write:
        text = args.script.read_text(encoding="utf-8")
        write_lf(args.script, render_script(text, rows))
        for path, body in (
            (args.hook_rules, hook_text),
            (args.record_rules, record_text),
        ):
            path.parent.mkdir(parents=True, exist_ok=True)
            write_lf(path, body)
    else:
        text = args.script.read_text(encoding="utf-8")
        stale = []
        if render_script(text, rows) != text:
            stale.append(args.script.name)
        for path, want in (
            (args.hook_rules, hook_text),
            (args.record_rules, record_text),
        ):
            have = path.read_text(encoding="utf-8") if path.exists() else ""
            if have != want:
                stale.append(path.parent.name + "/" + path.name)
        if stale:
            print(
                f"{', '.join(stale)} differ(s) from {args.rules.name}: "
                "run `python3 scripts/gen_access_rules.py --write`",
                file=sys.stderr,
            )
            return 1
        print(
            f"{args.script.name}, the d1-access-guard rules and the d1-record-access rules match "
            f"{args.rules.name} ({len(rows)} rows)"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
