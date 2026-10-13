"""ADR-0011 row-level visibility and A1 record access: scripts/access_rules.json, its generator and the script block.

Pure checks run everywhere. The database checks need a migrated Postgres (DATABASE_URL and psql);
they skip otherwise (the CI job sets REQUIRE_DB_TESTS=1, so a skip there fails the job).
tests/phase1_schema.sh also resolves every rule path against the Directus metadata that the
configure_*.sql scripts leave behind.

READ visibility is not tested here: it lives in the SQL function family (d1_private.readers_of_*, migration 166) and is
tested by tests/readers_matrix.sh (the mutation matrix, the differential test against the independent oracle ref.*) and by
the Directus smoke. What this file tests is the generator and its output: the shapes Directus accepts, the read kinds
(`readers` some, `open_to_all`), the one-hop child rules, the update, delete and manage filters (the reader term AND the
editor or owner test), the guards and the rule files.

The update/delete/manage tests use a small fixture evaluator that models Directus, not SQL intuition:
  * a legal `_some` (directly under a top-level to-many alias) is an EXISTS subquery, and the related
    collection's own Lab Member read rule applies to the rows it looks at;
  * a dropped `_some` (a bare to-many hop) is a LEFT JOIN: every bare hop of one filter is ONE joined alias,
    the whole filter is evaluated per row of the join product, so two conditions on the same hop hold on the
    same row; a filter on a null row (no join partner) is false, except `_null`, which is true.
"""

import importlib.util
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"
FIXTURES = Path(__file__).resolve().parent / "fixtures"
spec = importlib.util.spec_from_file_location(
    "gen_access_rules", SCRIPTS / "gen_access_rules.py"
)
gen = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gen)

DOC = gen.load()
ROWS = gen.build_rows(DOC)
BY_KEY = {(r["collection"], r["action"]): r for r in ROWS}
RULES = {k: r["permissions"] for k, r in BY_KEY.items()}
# Lab Member filters of main before A1 (generator output on 2026-10-12, frozen so no git history is needed).
MAIN = {
    (r["collection"], r["action"]): r["permissions"]
    for r in json.loads((FIXTURES / "lab_member_rules_main.json").read_text())
}

# Reference data every member can read and edit, as before ADR-0011.
REFERENCE = [
    "materials", "material_iso_classifications", "alloying_elements", "material_alloying_elements",
    "equipment", "tools", "tool_boxes", "cutting_inserts", "insert_edges", "insert_types",
    "raw_stock_lots", "manufacturing_methods", "facilities", "fast_recipes",
]  # fmt: skip

# What a path may end with: the relation field and then the login column it is matched against.
PATH_TAILS = (
    "owner_person_id.user_id",
    "principal_investigator_person.user_id",
    "co_owners.user_id",
    "secondary_investigators.user_id",
    "person_id.user_id",
    "readers.user_id",
)

# the five record types and what hangs off them
RECORDS = [
    "physical_samples",
    "manufacturing_operations",
    "test_sessions",
    "campaigns",
    "projects",
]
READERS = {
    "physical_samples": "sample_readers", "manufacturing_operations": "operation_readers", "test_sessions": "test_readers",
    "campaigns": "campaign_readers", "projects": "project_readers", "campaign_samples": "campaign_sample_readers",
}  # fmt: skip


def _paths(collection, action):
    return list(
        dict.fromkeys(gen.expand(DOC["sets"], DOC["rules"][collection][action]))
    )


def _rule_paths():
    for collection, actions in DOC["rules"].items():
        for action, rule in actions.items():
            if rule != "any" and not isinstance(rule, dict):
                yield collection, action, _paths(collection, action)


# =================================================================================================
# The fixture evaluator
# =================================================================================================

COMPARATORS = {"_eq", "_null", "_in", "_nnull"}


SCHEMA = {
    "people": {"pk": "person_id"},
    "projects": {
        "pk": "project_id",
        "principal_investigator_person": ("m2o", "people"),
        "secondary_investigators": ("o2m", "project_investigators", "project_id"),
        "access": ("o2m", "project_access", "project_id"),
        "campaigns": ("o2m", "campaigns", "project_id"),
        "samples": ("o2m", "physical_samples", "project_id"),
        "operations": ("o2m", "manufacturing_operations", "project_id"),
        "sessions": ("o2m", "test_sessions", "project_id"),
        "readers": ("o2m", "project_readers", "record_id"),
    },
    "campaigns": {
        "pk": "campaign_id",
        "owner_person_id": ("m2o", "people"),
        "project_id": ("m2o", "projects"),
        "access": ("o2m", "campaign_access", "campaign_id"),
        "samples": ("o2m", "campaign_samples", "campaign_id"),
        "readers": ("o2m", "campaign_readers", "record_id"),
    },
    "physical_samples": {
        "pk": "sample_id",
        "owner_person_id": ("m2o", "people"),
        "project_id": ("m2o", "projects"),
        "co_owners": ("o2m", "sample_co_owners", "sample_id"),
        "access": ("o2m", "sample_access", "sample_id"),
        "campaigns": ("o2m", "campaign_samples", "sample_id"),
        "readers": ("o2m", "sample_readers", "record_id"),
    },
    "manufacturing_operations": {
        "pk": "operation_id",
        "owner_person_id": ("m2o", "people"),
        "project_id": ("m2o", "projects"),
        "campaign_id": ("m2o", "campaigns"),
        "sample_id": ("m2o", "physical_samples"),
        "access": ("o2m", "operation_access", "operation_id"),
        "readers": ("o2m", "operation_readers", "record_id"),
        "open_to_all": ("o2m", "operation_open_to_all", "record_id"),
    },
    "test_sessions": {
        "pk": "session_id",
        "owner_person_id": ("m2o", "people"),
        "project_id": ("m2o", "projects"),
        "campaign_id": ("m2o", "campaigns"),
        "sample_id": ("m2o", "physical_samples"),
        "access": ("o2m", "test_access", "session_id"),
        "readers": ("o2m", "test_readers", "record_id"),
    },
    "project_investigators": {"pk": "_n", "project_id": ("m2o", "projects")},
    "sample_co_owners": {"pk": "_n", "sample_id": ("m2o", "physical_samples")},
    "campaign_samples": {
        "pk": "_n",
        "campaign_id": ("m2o", "campaigns"),
        "sample_id": ("m2o", "physical_samples"),
        "readers": ("o2m", "campaign_sample_readers", "record_id"),
    },
    "sample_readers": {"pk": "_n", "record_id": ("m2o", "physical_samples")},
    "operation_readers": {"pk": "_n", "record_id": ("m2o", "manufacturing_operations")},
    "operation_open_to_all": {"pk": "_n", "record_id": ("m2o", "manufacturing_operations")},
    "test_readers": {"pk": "_n", "record_id": ("m2o", "test_sessions")},
    "campaign_readers": {"pk": "_n", "record_id": ("m2o", "campaigns")},
    "project_readers": {"pk": "_n", "record_id": ("m2o", "projects")},
    "campaign_sample_readers": {"pk": "_n", "record_id": ("m2o", "campaign_samples")},
    "sample_access": {"pk": "_n", "sample_id": ("m2o", "physical_samples"), "person_id": ("m2o", "people")},
    "operation_access": {"pk": "_n", "operation_id": ("m2o", "manufacturing_operations"), "person_id": ("m2o", "people")},
    "test_access": {"pk": "_n", "session_id": ("m2o", "test_sessions"), "person_id": ("m2o", "people")},
    "campaign_access": {"pk": "_n", "campaign_id": ("m2o", "campaigns"), "person_id": ("m2o", "people")},
    "project_access": {"pk": "_n", "project_id": ("m2o", "projects"), "person_id": ("m2o", "people")},
    "sample_data_files": {"pk": "_n", "sample_id": ("m2o", "physical_samples")},
    "operation_data_files": {"pk": "_n", "operation_id": ("m2o", "manufacturing_operations")},
    "machining_force_analysis": {"pk": "_n", "operation_id": ("m2o", "manufacturing_operations")},
    "session_data_files": {"pk": "_n", "session_id": ("m2o", "test_sessions")},
    "test_sessions_subject": {"pk": "_n", "test_sessions_id": ("m2o", "test_sessions")},
    "project_rollup": {"pk": "_n", "project_id": ("m2o", "projects")},
}  # fmt: skip


class World:
    """Rows by table. Names are the keys: person `x` has login user `u_x` (unless `nologin`)."""

    def __init__(self):
        self.t = {name: [] for name in SCHEMA}
        self.n = 0

    def add(self, table, **row):
        self.n += 1
        row.setdefault("_n", self.n)
        self.t[table].append(row)
        return row

    def person(self, name, login=True):
        return self.add(
            "people", person_id=f"p_{name}", user_id=f"u_{name}" if login else None
        )

    def project(self, key, pi=None, restricted=False):
        return self.add(
            "projects",
            project_id=key,
            principal_investigator_person=_p(pi),
            restricted=restricted,
        )

    def campaign(self, key, project=None, owner=None, restricted=False):
        return self.add(
            "campaigns",
            campaign_id=key,
            project_id=project,
            owner_person_id=_p(owner),
            restricted=restricted,
        )

    def sample(self, key, project=None, owner=None, restricted=False):
        return self.add(
            "physical_samples",
            sample_id=key,
            project_id=project,
            owner_person_id=_p(owner),
            restricted=restricted,
        )

    def record(
        self,
        table,
        key,
        sample=None,
        project=None,
        campaign=None,
        owner=None,
        restricted=False,
    ):
        pk = SCHEMA[table]["pk"]
        return self.add(
            table,
            **{pk: key, "sample_id": sample, "project_id": project, "campaign_id": campaign,
               "owner_person_id": _p(owner), "restricted": restricted},
        )  # fmt: skip

    def op(self, key, **kw):
        return self.record("manufacturing_operations", key, **kw)

    def test(self, key, **kw):
        return self.record("test_sessions", key, **kw)

    def in_campaign(self, campaign, sample):
        return self.add("campaign_samples", campaign_id=campaign, sample_id=sample)

    def coowner(self, sample, user):
        return self.add("sample_co_owners", sample_id=sample, user_id=f"u_{user}")

    def investigator(self, project, user):
        return self.add(
            "project_investigators", project_id=project, user_id=f"u_{user}"
        )

    def grant(self, kind, key, person, role):
        table, fk = ACCESS[kind]
        return self.add(table, **{fk: key, "person_id": f"p_{person}", "role": role})

    def readers(self, table, key, *users):
        """The materialised readers of a record (what migration 166's functions put in <type>_readers)."""
        for user in users:
            self.add(READERS[table], record_id=key, user_id=f"u_{user}")

    def open_to_all(self, key):
        return self.add("operation_open_to_all", record_id=key)


ACCESS = {
    "sample": ("sample_access", "sample_id"),
    "operation": ("operation_access", "operation_id"),
    "test": ("test_access", "session_id"),
    "campaign": ("campaign_access", "campaign_id"),
    "project": ("project_access", "project_id"),
}


def _p(name):
    return None if name is None else f"p_{name}"


class Directus:
    """Evaluates permission filters the way Directus 11.17 does, as far as these rules need."""

    def __init__(self, rules, world, user):
        self.rules, self.w, self.user = rules, world, user
        self.memo = {}
        self.action = "read"  # the action of the rule being evaluated (a legal `_some` applies the same action's rule)

    # -- rows -------------------------------------------------------------------------------
    def find(self, table, key):
        if key is None:
            return None
        pk = SCHEMA[table]["pk"]
        for row in self.w.t[table]:
            if row[pk] == key:
                return row
        return None

    def children(self, table, row, alias):
        _kind, child, fk = SCHEMA[table][alias]
        return [r for r in self.w.t[child] if r.get(fk) == row[SCHEMA[table]["pk"]]]

    # -- permissions ----------------------------------------------------------------------------
    def can(self, table, action, row):
        key = (table, action, id(row))
        if key not in self.memo:
            filt = self.rules[(table, action)]
            saved, self.action = self.action, action
            try:
                self.memo[key] = self.matches(table, filt, row)
            finally:
                self.action = saved
        return self.memo[key]

    def related_allows(self, table, row):
        """What Directus does inside a legal `_some`: the related collection's rule for the SAME action applies to
        the rows it looks at (getCases over the permissions of the action being run); no rule, no extra condition."""
        if (table, self.action) not in self.rules:
            return True
        return self.can(table, self.action, row)

    def ids(self, table, action):
        pk = SCHEMA[table]["pk"]
        if (table, action) not in self.rules:
            return set()
        return {r[pk] for r in self.w.t[table] if self.can(table, action, r)}

    # -- filters --------------------------------------------------------------------------------
    def matches(self, table, filt, row):
        return any(True for _ in self.solve(table, filt, row, (), {}))

    def solve(self, table, filt, row, path, binding):
        """Yields every join assignment (path -> row) under which `filt` holds on `row`."""
        yield from self._and(list(filt.items()), table, row, path, binding)

    def _and(self, items, table, row, path, binding):
        if not items:
            yield binding
            return
        (key, value), rest = items[0], items[1:]
        for b in self._key(key, value, table, row, path, binding):
            yield from self._and(rest, table, row, path, b)

    def _key(self, key, value, table, row, path, binding):
        if key == "_and":
            yield from self._and(
                [("_and1", f) for f in value], table, row, path, binding
            )
        elif key == "_and1":
            yield from self.solve(table, value, row, path, binding)
        elif key == "_or":
            for f in value:
                yield from self.solve(table, f, row, path, binding)
        elif isinstance(value, dict) and value and set(value) <= COMPARATORS:
            if self.compare(value, row.get(key) if row else None):
                yield binding
        else:
            kind = SCHEMA[table][key]
            if not isinstance(value, dict) or len(value) != 1:
                raise AssertionError(
                    f"Directus reads a relation key by its first key only: {key}: {value}"
                )
            if kind[0] == "m2o":
                child = self.find(kind[1], row[key]) if row else None
                yield from self.solve(kind[1], value, child, path + (key,), binding)
            elif set(value) == {
                "_some"
            }:  # a legal `_some`: EXISTS, under the related collection's own rule
                body = value["_some"]
                if (
                    not isinstance(body, dict)
                    or len(body) != 1
                    or next(iter(body)) in ("_and", "_or")
                ):
                    raise AssertionError(
                        f"a `_some` body must be one plain chain: {body}"
                    )
                if row is not None and any(
                    self.related_allows(kind[1], c)
                    and self.matches(kind[1], value["_some"], c)
                    for c in self.children(table, row, key)
                ):
                    yield binding
            else:  # a bare to-many hop: one joined alias for the whole filter
                where = path + (key,)
                if where in binding:
                    yield from self.solve(
                        kind[1], value, binding[where], where, binding
                    )
                else:
                    kids = self.children(table, row, key) if row else []
                    for child in kids or [None]:
                        yield from self.solve(
                            kind[1], value, child, where, {**binding, where: child}
                        )

    def compare(self, comparators, actual):
        for op, want in comparators.items():
            if op == "_null":
                ok = (actual is None) == want
            elif op == "_nnull":
                ok = (actual is not None) == want
            elif actual is None:
                ok = False
            elif op == "_eq":
                ok = actual == (self.user if want == "$CURRENT_USER" else want)
            else:
                ok = actual in want
            if not ok:
                return False
        return True


def users_of(world):
    return [p["user_id"] for p in world.t["people"] if p["user_id"]]


PEOPLE = [
    "owner",
    "coowner",
    "viewer",
    "editor",
    "inv",
    "inv2",
    "pi",
    "campaignOwner",
    "stranger",
]


def base_people(w):
    for name in PEOPLE:
        w.person(name)
    w.person("nologin", login=False)


# =================================================================================================
# Script block, drift, and the plain facts about the rows
# =================================================================================================


def test_generated_script_block_is_current():
    script = SCRIPTS / "configure_users_and_policies.sql"
    assert gen.render_script(
        script.read_text(encoding="utf-8"), ROWS
    ) == script.read_text(
        encoding="utf-8"
    ), "run `python3 scripts/gen_access_rules.py --write`"


def test_check_command_detects_a_hand_edit(tmp_path):
    script = tmp_path / "configure_users_and_policies.sql"
    text = (SCRIPTS / "configure_users_and_policies.sql").read_text(encoding="utf-8")
    script.write_text(text.replace('"_or"', '"_and"', 1), encoding="utf-8")
    assert gen.main(["--check", "--script", str(script)]) == 1
    script.write_text(text, encoding="utf-8")
    assert gen.main(["--check", "--script", str(script)]) == 0


def test_script_has_no_ungenerated_lab_member_rows():
    """The only INSERT INTO directus_permissions in the script is the generated one."""
    text = (SCRIPTS / "configure_users_and_policies.sql").read_text(encoding="utf-8")
    assert text.count("INSERT INTO directus_permissions") == 1
    start, end = gen.script_block(text)
    assert "INSERT INTO directus_permissions" in text[start:end]


def test_create_is_never_filtered():
    for (collection, action), row in BY_KEY.items():
        if action == "create":
            assert row["permissions"] == {}, collection


def test_reference_data_stays_unfiltered():
    for collection in REFERENCE:
        rows = [r for (c, _a), r in BY_KEY.items() if c == collection]
        assert rows, f"{collection} lost its Lab Member grant"
        assert all(r["permissions"] == {} for r in rows), collection
        assert collection not in DOC["rules"]


def test_previously_granted_actions_are_kept():
    """Every (collection, action) the old hand-written script and later migrations granted,
    except the ones an owner decision removed (audit_logs read, people delete)."""
    granted = {
        ("physical_samples", a) for a in gen.ACTIONS
    } | {
        ("manufacturing_operations", a) for a in gen.ACTIONS
    } | {("test_sessions", a) for a in gen.ACTIONS} | {("projects", a) for a in gen.ACTIONS} | {
        ("machining_force_analysis", a) for a in ("create", "read", "update")
    } | {("fast_run_data", "read"), ("directus_files", "create"), ("directus_files", "read"),
         ("people", "create"), ("people", "read"), ("people", "update")}  # fmt: skip
    assert granted <= set(BY_KEY)


def test_directus_files_are_untouched_and_audit_logs_are_admin_only():
    for key in [("directus_files", "read"), ("directus_files", "create")]:
        assert BY_KEY[key]["permissions"] == {}
    # Owner decision (2026-10-07): the audit log holds old and new values of every change and has
    # no owner column to filter on, so Lab Members get no grant at all.
    assert not [k for k in BY_KEY if k[0] == "audit_logs"]


def test_every_leaf_matches_the_signed_in_user_or_the_restricted_flag():
    """Every `_eq` is the signed-in user on a `user_id`, or `false` on a `restricted` flag: nothing else
    (no id, no name) is ever compared, so no rule can be satisfied by a value a member chooses."""

    def leaves(node, key=None):
        if isinstance(node, dict):
            for k, value in node.items():
                if k == "_eq":
                    yield key, value
                else:
                    yield from leaves(value, k)
        elif isinstance(node, list):
            for item in node:
                yield from leaves(item, key)

    for row in ROWS:
        for key, value in leaves(row["permissions"]):
            allowed = {("user_id", "$CURRENT_USER"), ("restricted", False)}
            if (
                row["collection"] == "label_templates"
            ):  # migration 164: a member edits their own templates
                allowed.add(("user_created", "$CURRENT_USER"))
            assert (key, value) in allowed, (
                row["collection"],
                row["action"],
                key,
                value,
            )


def test_access_tables_are_readable_for_own_rows_only_and_never_writable():
    me = {"person_id": {"user_id": {"_eq": "$CURRENT_USER"}}}
    for table in (
        "sample_access",
        "operation_access",
        "test_access",
        "campaign_access",
        "project_access",
    ):
        assert BY_KEY[(table, "read")]["permissions"] == me, table
        assert {a for (c, a) in BY_KEY if c == table} == {"read"}, table


def test_readers_tables_show_a_member_their_own_rows_only_and_take_no_writes():
    """A legal `readers._some` applies the readers table's own rule for the action inside it, so that rule must be
    trivial (own rows, no relation hop, no recursion into the parent's read rule)."""
    mine = {"user_id": {"_eq": "$CURRENT_USER"}}
    for table in (
        "sample_readers", "operation_readers", "test_readers", "campaign_readers", "project_readers", "campaign_sample_readers",
    ):  # fmt: skip
        assert BY_KEY[(table, "read")]["permissions"] == mine, table
        assert BY_KEY[(table, "read")]["fields"] == "*"
        assert {a for (c, a) in BY_KEY if c == table} == {"read"}, table
    # every member may read the open set (it is the amnesty leaf: record_id is not null)
    assert BY_KEY[("operation_open_to_all", "read")]["permissions"] == {}


def test_params_tables_listed_as_unfiltered_are_the_stale_ones():
    """The eleven *_params tables were folded into the operation and test rows by migration 32;
    access_rules.json keeps their stale grants only for the drift checks (see its comment)."""
    stale = {
        "machining_params", "sintering_params", "heat_treatment_params", "deformation_params", "am_params",
        "tensile_test_params", "hardness_test_params", "charpy_test_params", "compression_test_params",
        "sem_params", "xrd_params",
    }  # fmt: skip
    assert stale <= set(DOC["unfiltered"])
    assert not stale & set(DOC["rules"])


def test_set_cycles_and_unknown_sets_are_rejected():
    with pytest.raises(gen.RulesError):
        gen.expand({"a": [{"set": "a"}]}, "a")
    with pytest.raises(gen.RulesError):
        gen.expand({"a": [{"set": "missing"}]}, "a")
    with pytest.raises(gen.RulesError):
        gen.build_rows(
            {**DOC, "rules": {"physical_samples": {"create": "sample.read"}}}
        )


# =================================================================================================
# path_filter, tree flattening, _some legality
# =================================================================================================

U = {"_eq": "$CURRENT_USER"}


def test_path_filter_shape():
    assert gen.path_filter("co_owners._some.user_id") == {
        "co_owners": {"_some": {"user_id": U}}
    }


def test_path_filter_drops_only_illegal_some():
    """Directus's filter engine (apply-query/filter) only gives `_some`/`_none` their EXISTS-subquery
    handling when the field right above is reached in exactly one hop from where that subquery
    started: `_some` at path index 1, or immediately after another legal `_some`. Reached through a
    preceding to-one hop -- `project_id.secondary_investigators._some.user_id` -- it throws "_some can
    only be used with top level relational alias field" (confirmed against a running Directus). A bare
    relational filter still means "any row", so an illegal `_some` is dropped, not replaced."""
    assert gen.path_filter("co_owners._some.user_id") == {
        "co_owners": {"_some": {"user_id": U}}
    }
    assert gen.path_filter("project_id.secondary_investigators._some.user_id") == {
        "project_id": {"secondary_investigators": {"user_id": U}}
    }
    assert gen.path_filter("samples._some.co_owners._some.user_id") == {
        "samples": {"_some": {"co_owners": {"_some": {"user_id": U}}}}
    }
    assert gen.path_filter(
        "sample_id.campaigns._some.campaign_id.project_id.secondary_investigators._some.user_id"
    ) == {
        "sample_id": {
            "campaigns": {
                "campaign_id": {
                    "project_id": {"secondary_investigators": {"user_id": U}}
                }
            }
        }
    }


def test_where_is_an_and_of_bare_paths_through_one_alias():
    """Directus reads a relation key's value by its first key only, so `role` beside `person_id` would be silently
    ignored, and a `_some` whose body is not one plain chain makes the request fail with a 500 (both found on a
    restored copy, 2026-10-12). A role test is therefore two paths under an `_and`, through the same bare alias
    (Directus joins an alias once per query path, so they are conditions on one row)."""
    where = {"role": ["edit"]}
    user = {"person_id": {"user_id": U}}
    role = {"role": {"_in": ["edit"]}}
    assert gen.path_filter("access._some.person_id.user_id", where, "access") == {
        "_and": [{"access": user}, {"access": role}]
    }
    assert gen.path_filter(
        "sample_id.access._some.person_id.user_id", where, "access"
    ) == {"_and": [{"sample_id": {"access": user}}, {"sample_id": {"access": role}}]}
    # no `_some` survives anywhere in a path with a role test, not even a chain's first
    assert gen.path_filter(
        "samples._some.access._some.person_id.user_id", where, "access"
    ) == {"_and": [{"samples": {"access": user}}, {"samples": {"access": role}}]}
    two = gen.path_filter(
        "access._some.person_id.user_id", {"role": ["a"], "x": ["b"]}, "access"
    )
    assert two["_and"][1:] == [
        {"access": {"role": {"_in": ["a"]}}},
        {"access": {"x": {"_in": ["b"]}}},
    ]


def test_combine_flattens_dedupes_and_unwraps_one():
    a, b = {"a": 1}, {"b": 2}
    assert gen.combine("_or", [a]) == a
    assert gen.combine("_or", [a, {"_or": [b, a]}]) == {"_or": [a, b]}
    assert gen.combine("_and", [{"_or": [a, b]}, {"_and": [a]}]) == {
        "_and": [{"_or": [a, b]}, a]
    }


SETS = {
    "u": ["owner_person_id.user_id"],
    "mix": ["owner_person_id.user_id", {"field": "restricted", "eq": False}, {"field": "sample_id", "null": True}],
    "unl": [{"unless_restricted": [{"set": "u"}, "co_owners._some.user_id"]}],
    "and": {"and": [{"set": "u"}, {"field": "restricted", "eq": False}]},
    "via_unl": [{"via": "sample_id", "set": "unl"}],
    "via_and": [{"via": "sample_id", "set": "and"}],
    "via_field": [{"via": "sample_id", "set": "mix"}],
    "rd": [{"reader": "bare"}],
    "rd_via": [{"via": "sample_id", "set": "rd"}],
    "rd_or_own": [{"set": "rd_via"}, "owner_person_id.user_id"],
}  # fmt: skip
R = {"restricted": {"_eq": False}}
OWN = {"owner_person_id": {"user_id": U}}


def test_tree_flattening_and_literal_leaves():
    assert gen.set_filter(SETS, "u") == OWN
    assert gen.set_filter(SETS, "mix") == {
        "_or": [OWN, R, {"sample_id": {"_null": True}}]
    }
    assert gen.set_filter(SETS, "and") == {"_and": [OWN, R]}


def test_unless_restricted_without_and_with_a_via():
    co = {"co_owners": {"_some": {"user_id": U}}}
    assert gen.set_filter(SETS, "unl") == {"_and": [R, {"_or": [OWN, co]}]}
    # the restricted test and the paths all move behind the via; the dropped _some is a bare hop
    via_co = {"sample_id": {"co_owners": {"user_id": U}}}
    assert gen.set_filter(SETS, "via_unl") == {
        "_and": [{"sample_id": R}, {"_or": [{"sample_id": OWN}, via_co]}]
    }


def test_and_sets_keep_their_and_under_a_via_and_field_leaves_move_behind_it():
    assert gen.set_filter(SETS, "via_and") == {
        "_and": [{"sample_id": OWN}, {"sample_id": R}]
    }
    assert gen.set_filter(SETS, "via_field") == {
        "_or": [
            {"sample_id": OWN},
            {"sample_id": R},
            {"sample_id": {"sample_id": {"_null": True}}},
        ]
    }


def test_the_reader_item_is_the_bare_hop_to_the_readers_alias_with_and_without_a_via():
    """{"reader": "bare"} is `readers.user_id = $CURRENT_USER` at the row's prefix: never a `_some` (a legal `_some`
    applies the readers table's own rule for the action, and behind a to-one hop it is not top-level)."""
    mine = {"readers": {"user_id": U}}
    assert gen.set_filter(SETS, "rd") == mine
    assert gen.set_filter(SETS, "rd_via") == {"sample_id": mine}
    assert gen.set_filter(SETS, "rd_or_own") == {"_or": [{"sample_id": mine}, OWN]}
    assert "_some" not in json.dumps(gen.set_filter(SETS, "rd_via"))


def test_a_reader_item_other_than_bare_is_rejected():
    for bad in ("some", "", None, ["bare"]):
        with pytest.raises(gen.RulesError):
            gen.set_filter({"x": [{"reader": bad}]}, "x")
    with pytest.raises(gen.RulesError):
        gen.set_filter({"x": [{"reader": "bare", "via": "a"}]}, "x")


def test_the_each_item_and_the_orphan_amnesty_shape_are_gone():
    """read equivalence moved to SQL; `each` only existed for the old read-only sets, the amnesty is operation_open_to_all."""
    with pytest.raises(gen.RulesError):
        gen.set_filter({"x": [{"each": "a", "items": ["b.user_id"]}]}, "x")
    assert "orphan_amnesty" not in DOC
    assert not hasattr(gen, "amnesty_filter") and not hasattr(gen, "with_amnesty")
    assert "each" not in json.dumps(DOC["sets"])


def test_bad_items_are_rejected():
    for bad in (
        {"x": [{"field": "a"}]},
        {"x": [{"path": "a.b"}]},
        {"x": [{"path": "a.b", "at": "z", "where": {}}]},
        {"x": [{"unless_restricted": []}]},
        {"x": [{"nonsense": 1}]},
        {"x": {"xor": ["a.b"]}},
    ):
        with pytest.raises(gen.RulesError):
            gen.set_filter(bad, "x")


def _walk_relations(node, root_depth=0, problems=None, path=()):
    """What Directus 11.17 can evaluate (found on a restored copy; see gen_access_rules.path_filter):
      * `_some` only directly under the first relation key of the filter (or of a legal `_some`'s body);
      * a `_some` body is ONE plain chain (no `_and`, no `_or`, no second key), else the per-field permission case
        collapses and the request fails with a 500;
      * a relation key has exactly one child key (Directus reads the first and ignores the rest);
      * no `_and`/`_or` under a relation key (it is ignored: the condition silently disappears).
    `root_depth` = relation keys above this node since the filter's root."""
    problems = [] if problems is None else problems
    if isinstance(node, list):
        for item in node:
            _walk_relations(item, root_depth, problems, path)
        return problems
    if not isinstance(node, dict):
        return problems
    for key, value in node.items():
        if key in ("_and", "_or"):
            if root_depth > 0:
                problems.append((path, key, "logical operator under a relation key"))
            _walk_relations(value, root_depth, problems, path)
        elif key in ("_eq", "_null", "_in", "_nnull"):
            continue
        elif key == "_some":
            if root_depth != 1:
                problems.append(
                    (path, key, "_some not directly under a top-level alias")
                )
            if not isinstance(value, dict) or len(value) != 1:
                problems.append((path, key, "_some body is not one plain chain"))
            elif next(iter(value)) in ("_and", "_or"):
                problems.append((path, key, "_some body has a logical operator"))
            _walk_relations(value, 0, problems, path + (key,))
        else:
            if root_depth > 0 and len(node) > 1:
                problems.append((path, key, "a relation key with several children"))
            _walk_relations(value, root_depth + 1, problems, path + (key,))
    return problems


def test_no_generated_filter_has_an_illegal_some_or_an_operator_under_a_relation_key():
    """`resolve()` only checks that relations exist, not that Directus accepts the filter shape, so this
    walks every generated filter (every row, the hook and endpoint rules)."""
    bad = {k: p for k, r in BY_KEY.items() if (p := _walk_relations(r["permissions"]))}
    assert not bad, bad
    hook = gen.hook_rules(DOC)
    for checks in hook["guards"].values():
        for c in checks:
            assert not _walk_relations(c["filter"]), c
    for g in hook["ownerGuards"].values():
        assert not _walk_relations(g["filter"])
    for rec in gen.record_rules(DOC)["records"].values():
        assert not _walk_relations(rec["read"]) and not _walk_relations(rec["manage"])


def test_the_shape_walker_catches_what_it_is_for():
    assert _walk_relations({"sample_id": {"co_owners": {"_some": U}}})
    assert _walk_relations({"a": {"_or": [{"b": U}]}})
    assert _walk_relations({"a": {"_some": {"_or": [{"b": U}]}}})
    assert _walk_relations({"a": {"_some": {"_and": [{"b": U}]}}})
    assert _walk_relations({"a": {"_some": {"b": U, "c": U}}})
    assert _walk_relations({"a": {"person_id": U, "role": U}})
    assert not _walk_relations({"a": {"_some": {"b": {"_some": U}}}})
    assert not _walk_relations({"a": {"_some": {"b": {"c": U}}}})
    assert not _walk_relations(
        {"_or": [{"a": {"_some": U}}, {"_and": [{"b": U}, {"b": {"c": U}}]}]}
    )


def _leaves(node):
    if isinstance(node, dict):
        if set(node) <= COMPARATORS:
            return 1
        return sum(_leaves(v) for v in node.values())
    if isinstance(node, list):
        return sum(_leaves(v) for v in node)
    return 0


def test_filters_have_the_documented_sizes():
    """A tripwire (the performance gate measures the real cost): the five record types read through ONE membership test
    (two leaves for operations with the amnesty), and the 76-leaf read filter of the first attempt is gone."""
    sizes = {c: _leaves(BY_KEY[(c, "read")]["permissions"]) for c in RECORDS}
    assert sizes == {
        "physical_samples": 1,
        "manufacturing_operations": 2,
        "test_sessions": 1,
        "campaigns": 1,
        "projects": 1,
    }
    assert _leaves(BY_KEY[("campaign_samples", "read")]["permissions"]) == 1
    for (collection, action), row in BY_KEY.items():
        if action == "read" and collection in DOC["rules"]:
            assert (
                _leaves(row["permissions"]) <= 3 or collection == "project_rollup"
            ), collection
        if action in ("update", "delete") and collection in DOC["rules"]:
            assert _leaves(row["permissions"]) < 20, (collection, action)


def test_read_rules_are_the_membership_test_a_one_hop_child_rule_or_the_rollup():
    some = {"readers": {"_some": {"user_id": U}}}
    for collection in RECORDS + ["campaign_samples"]:
        got = RULES[(collection, "read")]
        want = (
            {"_or": [some, {"open_to_all": {"_some": {"record_id": {"_nnull": True}}}}]}
            if collection == "manufacturing_operations"
            else some
        )
        assert got == want, collection
    # a child of a record: one bare to-one hop to the parent's readers, and nothing else
    for collection, fk in (
        ("sample_co_owners", "sample_id"), ("sample_stock_provenance", "sample_id"), ("sample_data_files", "sample_id"),
        ("operation_data_files", "operation_id"), ("machining_force_analysis", "operation_id"),
        ("fast_run_data", "operation_id"), ("operation_additional_operators", "operation_id"),
        ("session_data_files", "session_id"), ("session_additional_operators", "session_id"),
        ("test_sessions_subject", "test_sessions_id"), ("project_investigators", "project_id"),
    ):  # fmt: skip
        assert RULES[(collection, "read")] == {
            fk: {"readers": {"user_id": U}}
        }, collection
    # the one two-hop rule left: an edge is readable by readers of its child or its parent
    assert RULES[("sample_genealogy", "read")] == {
        "_or": [
            {"child_sample_id": {"readers": {"user_id": U}}},
            {"parent_sample_id": {"readers": {"user_id": U}}},
        ]
    }
    # the rollup is not read through project_id.readers (a wider audience): the PI, investigators on unrestricted rows
    rollup = json.dumps(RULES[("project_rollup", "read")])
    assert (
        "readers" not in rollup
        and "principal_investigator_person" in rollup
        and '"restricted"' in rollup
    )


def test_no_read_rule_of_a_record_type_or_child_contains_a_gate_leaf():
    """The gates live in SQL now: no read filter names the restricted flag, a campaign, a project or an access list
    (project_rollup keeps its set-based rule)."""
    for (collection, action), row in BY_KEY.items():
        if (
            action != "read"
            or collection not in DOC["rules"]
            or collection == "project_rollup"
        ):
            continue
        text = json.dumps(row["permissions"])
        for word in (
            "restricted",
            "access",
            "co_owners",
            "secondary_investigators",
            "owner_person_id",
            "campaign_id",
            'project_id": {"prin',
        ):
            assert word not in text.replace("child_sample_id", "").replace(
                "parent_sample_id", ""
            ), (collection, word)


def test_the_removed_sets_are_gone_and_nothing_references_them():
    removed = {
        "sample.inherited", "sample.read", "sample.listed", "sample.pass", "record.listed", "record.inherited", "record.read",
        "campaign.inherited", "campaign.read", "campaign.listed", "campaign.pass", "project.inherited", "project.read",
        "project.listed", "project.pass", "link.sample.read", "genealogy.read", "operation.read", "session.read",
        "subject.read", "investigators.read", "campaign_samples.read", "has.project_ok", "has.campaign_ok", "gates.sample",
        "record.gates", "amnesty.gates",
    }  # fmt: skip
    assert not removed & set(DOC["sets"])
    text = json.dumps(DOC["rules"]) + json.dumps(DOC["sets"])
    for name in removed:
        assert f'"{name}"' not in text, name


def test_read_kinds_are_validated_and_only_for_read():
    for bad in (
        {"readers": "all"},
        {"open_to_all": True},
        {"readers": "some", "extra": 1},
        {"readers": "some", "open_to_all": False},
    ):
        with pytest.raises(gen.RulesError):
            gen.read_kind_filter("c", bad)
    doc = {
        **DOC,
        "rules": {
            **DOC["rules"],
            "campaigns": {
                "create": "any",
                "read": {"readers": "some"},
                "update": {"readers": "some"},
            },
        },
    }
    with pytest.raises(gen.RulesError, match="read only"):
        gen.rule_filter(doc, "campaigns", "update")
    # a guard or owner guard cannot be built from a read kind
    with pytest.raises(gen.RulesError):
        gen.hook_rules(
            {
                **DOC,
                "guards": {
                    "campaign_samples": [
                        {
                            "field": "campaign_id",
                            "parent": "campaigns",
                            "key": "campaign_id",
                            "rule": "read",
                        }
                    ]
                },
            }
        )


def test_the_readers_alias_is_never_under_a_some_in_a_child_rule_and_a_some_only_at_the_root():
    """`readers: {_some: ...}` only at the root of a collection (its own top-level alias); everywhere else, and in every
    child rule, the hop is bare (the readers alias is behind a to-one relation there, so a `_some` would be illegal)."""
    for (collection, action), row in BY_KEY.items():
        text = json.dumps(row["permissions"])
        if collection in RECORDS + ["campaign_samples"] and action == "read":
            assert text.startswith('{"readers": {"_some"') or text.startswith(
                '{"_or": [{"readers": {"_some"'
            ), collection
            continue
        assert '"readers": {"_some"' not in text, (collection, action)


@pytest.mark.parametrize("collection,action,paths", list(_rule_paths()))
def test_every_path_ends_at_a_user_column(collection, action, paths):
    for path in paths:
        tail = ".".join([p for p in path.split(".") if p != "_some"][-2:])
        assert tail in PATH_TAILS, f"{collection}.{action}: {path}"


# =================================================================================================
# Guards, owner guards, the hook and endpoint rule files
# =================================================================================================


def test_guards_cover_every_junction_that_grants_visibility():
    """Any junction whose rows feed d1_private.readers_of_* must be guarded (create is never filtered): co-owners, the
    legacy investigators, the campaign junction, and the test subjects (test_sessions.sample_id is derived from the first
    subject, migration 139). The *_access and readers tables are the exception by design: Lab Member has no write grant
    on them, the endpoint and the trigger functions write them."""
    assert set(DOC["guards"]) == {
        "sample_co_owners", "project_investigators", "campaign_samples", "test_sessions_subject",
    }  # fmt: skip
    for junction in DOC["guards"]:
        assert "create" in DOC["rules"][junction], junction
    for table in (
        "sample_access", "operation_access", "test_access", "campaign_access", "project_access",
        "sample_readers", "operation_readers", "test_readers", "campaign_readers", "project_readers",
        "campaign_sample_readers", "operation_open_to_all",
    ):  # fmt: skip
        assert {a for (c, a) in BY_KEY if c == table} == {"read"}, table
    rules = gen.hook_rules(DOC)["guards"]
    assert set(rules) == set(DOC["guards"])
    assert [c["parent"] for c in rules["campaign_samples"]] == [
        "campaigns",
        "physical_samples",
    ]
    assert [c["parent"] for c in rules["sample_co_owners"]] == ["physical_samples"]
    assert [c["parent"] for c in rules["project_investigators"]] == ["projects"]
    assert [c["parent"] for c in rules["test_sessions_subject"]] == ["test_sessions"]
    # the filter shipped to the hook is the parent's row named by the guard's `rule`, word for word
    for junction, checks in DOC["guards"].items():
        for check, shipped in zip(checks, rules[junction]):
            row = BY_KEY[(check["parent"], check.get("rule", "update"))]
            assert shipped["filter"] == row["permissions"], (junction, check)


def test_co_owner_and_investigator_junctions_are_managed_by_the_owner_and_the_pi_only():
    assert DOC["guards"]["sample_co_owners"][0]["rule"] == "delete"
    assert DOC["guards"]["project_investigators"][0]["rule"] == "delete"
    guards = gen.hook_rules(DOC)["guards"]
    assert (
        guards["sample_co_owners"][0]["filter"]
        == BY_KEY[("physical_samples", "delete")]["permissions"]
    )
    assert (
        guards["project_investigators"][0]["filter"]
        == BY_KEY[("projects", "delete")]["permissions"]
    )
    assert (
        BY_KEY[("sample_co_owners", "update")]["permissions"]
        == BY_KEY[("sample_co_owners", "delete")]["permissions"]
    )


def test_hook_rules_file_is_current_and_drift_is_detected(tmp_path):
    assert gen.HOOK_RULES_FILE.read_text(encoding="utf-8") == gen.hook_rules_text(DOC)
    assert gen.RECORD_RULES_FILE.read_text(encoding="utf-8") == gen.record_rules_text(
        DOC
    )
    stale = tmp_path / "rules.json"
    stale.write_text("{}", encoding="utf-8")
    assert gen.main(["--check", "--hook-rules", str(stale)]) == 1
    assert gen.main(["--check", "--record-rules", str(stale)]) == 1
    stale.write_text(gen.hook_rules_text(DOC), encoding="utf-8")
    assert gen.main(["--check", "--hook-rules", str(stale)]) == 0
    stale.write_text(gen.record_rules_text(DOC), encoding="utf-8")
    assert gen.main(["--check", "--record-rules", str(stale)]) == 0


def test_owner_guards_cover_every_record_whose_update_is_wider_than_delete():
    """An editor who changes the owner column or the restricted flag would gain delete or visibility."""
    wider = {
        c
        for c, actions in DOC["rules"].items()
        if "update" in actions
        and "delete" in actions
        and BY_KEY[(c, "update")]["permissions"] != BY_KEY[(c, "delete")]["permissions"]
    }
    guards = gen.hook_rules(DOC)["ownerGuards"]
    assert wider == set(DOC["owner_guards"]) == set(guards)
    assert wider == {
        "physical_samples",
        "manufacturing_operations",
        "test_sessions",
        "campaigns",
    }
    for collection, g in guards.items():
        assert g["fields"] == [
            {"field": "owner_person_id", "valueKey": "person_id"},
            {"field": "restricted"},
        ]
        # hooks that predate the list read the first field
        assert (g["field"], g["valueKey"]) == ("owner_person_id", "person_id")
        # the filter shipped to the hook is the record's delete row, word for word
        assert g["filter"] == BY_KEY[(collection, "delete")]["permissions"], collection


def test_restricted_keys_are_emitted_for_the_guarded_records():
    keys = gen.hook_rules(DOC)["restrictedKeys"]
    assert keys == {
        "physical_samples": ["project_id"],
        "manufacturing_operations": ["project_id", "campaign_id", "sample_id"],
        "test_sessions": ["project_id", "campaign_id", "sample_id"],
        "campaigns": ["project_id"],
    }
    with pytest.raises(gen.RulesError, match="owner_guards"):
        gen.hook_rules({**DOC, "restricted_keys": {"projects": ["x"]}})


def test_a_wider_update_rule_without_an_owner_guard_is_rejected():
    doc = {**DOC, "owner_guards": {}, "restricted_keys": {}}
    with pytest.raises(gen.RulesError, match="owner_guards"):
        gen.hook_rules(doc)
    # campaigns on their own trip the net now that Can edit people may update them
    only_campaigns = {k: v for k, v in DOC["owner_guards"].items() if k != "campaigns"}
    with pytest.raises(gen.RulesError, match="campaigns"):
        gen.hook_rules({**DOC, "owner_guards": only_campaigns, "restricted_keys": {}})


def test_owner_guard_needs_update_and_delete_filters_and_well_formed_fields():
    ok = {"key": "y", "fields": [{"field": "x"}]}
    doc = {**DOC, "owner_guards": {**DOC["owner_guards"], "fast_run_data": ok}}
    with pytest.raises(gen.RulesError, match="fast_run_data"):
        gen.hook_rules(doc)
    for bad in (
        {"key": "k", "fields": []},
        {"key": "k"},
        {"key": "k", "fields": [{"value_key": "v"}]},
    ):
        doc = {**DOC, "owner_guards": {**DOC["owner_guards"], "physical_samples": bad}}
        with pytest.raises(gen.RulesError, match="physical_samples"):
            gen.hook_rules(doc)


def test_guard_rejects_a_parent_without_a_filter():
    doc = {
        **DOC,
        "guards": {
            "sample_co_owners": [
                {
                    "field": "sample_id",
                    "parent": "fast_run_data",
                    "key": "x",
                    "rule": "update",
                }
            ]
        },
    }
    with pytest.raises(gen.RulesError):
        gen.hook_rules(doc)


def test_record_rules_carry_the_read_and_manage_filters_of_the_five_record_types():
    rec = gen.record_rules(DOC)["records"]
    assert set(rec) == set(RECORDS)
    for collection, r in rec.items():
        assert r["read"] == BY_KEY[(collection, "read")]["permissions"]
        assert r["manage"] == BY_KEY[(collection, "delete")]["permissions"]
        assert r["table"].endswith("_access")
    assert rec["projects"]["roles"] == ["view", "investigator"]
    assert rec["physical_samples"]["roles"] == ["view", "edit"]
    assert (
        rec["manufacturing_operations"]["read"]
        == RULES[("manufacturing_operations", "read")]
    )  # with the amnesty


# =================================================================================================
# Update, delete and manage: the reader term AND the editor or owner test (the evaluator, with readers rows given by hand)
# =================================================================================================

READER_TERM = {"readers": {"user_id": U}}


def test_update_delete_and_manage_carry_the_reader_term_and_the_editor_or_owner_test():
    """Operations, tests and campaigns: update = reader AND (owner, Can edit, or, unless restricted, an editor of the
    sample); delete (= the manage rule) = reader AND owner. A role test is an AND of two bare paths through the same
    `access` alias (Directus reads a relation key by its first key only), never a sibling key."""
    for collection in ("manufacturing_operations", "test_sessions", "campaigns"):
        for action in ("update", "delete"):
            f = RULES[(collection, action)]
            assert f["_and"][0] == READER_TERM, (collection, action)
            assert "_some" not in json.dumps(f), (collection, action)
        assert RULES[(collection, "delete")] == {"_and": [READER_TERM, OWN]}, collection
    edit_role = [
        {"access": {"person_id": {"user_id": U}}},
        {"access": {"role": {"_in": ["edit"]}}},
    ]
    assert RULES[("campaigns", "update")] == {
        "_and": [READER_TERM, {"_or": [OWN, {"_and": edit_role}]}]
    }
    assert RULES[("manufacturing_operations", "update")]["_and"][1]["_or"][:2] == [
        OWN,
        {"_and": edit_role},
    ]
    # samples and projects need no reader term: the editors and the PI are on the list, hence readers
    assert RULES[("physical_samples", "delete")] == OWN
    assert (
        RULES[("projects", "update")]
        == RULES[("projects", "delete")]
        == {"principal_investigator_person": {"user_id": U}}
    )
    # the manage rule the endpoint ships is the delete rule
    for collection, rec in gen.record_rules(DOC)["records"].items():
        assert rec["manage"] == RULES[(collection, "delete")], collection


def _op_world():
    """S (owner owner, co-owner coowner), operation O on S (owned by opOwner, access: viewer view, editor edit)."""
    w = World()
    base_people(w)
    w.person("opOwner")
    w.sample("S", owner="owner")
    w.coowner("S", "coowner")
    w.op("O", sample="S", owner="opOwner")
    w.grant("operation", "O", "viewer", "view")
    w.grant("operation", "O", "editor", "edit")
    w.add("machining_force_analysis", operation_id="O")
    return w


def _can(w, user, table, action):
    d = Directus(RULES, w, user)
    return {r[SCHEMA[table]["pk"]] for r in w.t[table] if d.can(table, action, r)}


def test_a_view_person_reads_but_cannot_update_and_an_edit_person_can_when_both_are_readers():
    w = _op_world()
    w.readers(
        "manufacturing_operations",
        "O",
        "opOwner",
        "viewer",
        "editor",
        "owner",
        "coowner",
    )
    assert _can(w, "u_viewer", "manufacturing_operations", "update") == set()
    assert _can(w, "u_editor", "manufacturing_operations", "update") == {"O"}
    assert _can(w, "u_opOwner", "manufacturing_operations", "update") == {"O"}
    assert _can(w, "u_opOwner", "manufacturing_operations", "delete") == {"O"}
    assert _can(w, "u_editor", "manufacturing_operations", "delete") == set()
    # an editor of the unrestricted operation's sample may update it (not delete)
    assert _can(w, "u_owner", "manufacturing_operations", "update") == {"O"}
    assert _can(w, "u_coowner", "manufacturing_operations", "update") == {"O"}
    assert _can(w, "u_owner", "manufacturing_operations", "delete") == set()
    assert _can(w, "u_stranger", "manufacturing_operations", "update") == set()


def test_update_and_delete_need_the_reader_term_so_an_owner_who_is_hidden_the_record_changes_nothing():
    """The shielding of ruling 19 (an operation under a sample hidden by a restricted campaign) is in the readers table,
    not in the filter: the operation's own owner is not a reader, so they cannot update or delete it either."""
    w = _op_world()
    w.readers(
        "manufacturing_operations", "O", "owner"
    )  # opOwner, editor and the rest are not readers
    for user in ("u_opOwner", "u_editor", "u_coowner"):
        assert _can(w, user, "manufacturing_operations", "update") == set(), user
        assert _can(w, user, "manufacturing_operations", "delete") == set(), user
        assert _can(w, user, "machining_force_analysis", "update") == set(), user
    assert _can(w, "u_owner", "manufacturing_operations", "update") == {"O"}


def test_a_restricted_operation_is_not_updated_through_the_samples_editors():
    w = _op_world()
    w.t["manufacturing_operations"][0]["restricted"] = True
    w.readers(
        "manufacturing_operations",
        "O",
        "opOwner",
        "viewer",
        "editor",
        "owner",
        "coowner",
    )
    assert _can(w, "u_owner", "manufacturing_operations", "update") == set()
    assert _can(w, "u_coowner", "manufacturing_operations", "update") == set()
    assert _can(w, "u_opOwner", "manufacturing_operations", "update") == {"O"}
    assert _can(w, "u_editor", "manufacturing_operations", "update") == {"O"}


def test_children_follow_their_parents_update_rule_through_one_bare_hop():
    w = _op_world()
    w.readers("manufacturing_operations", "O", "opOwner", "viewer", "editor", "owner")
    only = {w.t["machining_force_analysis"][0]["_n"]}
    assert _can(w, "u_editor", "machining_force_analysis", "update") == only
    assert _can(w, "u_viewer", "machining_force_analysis", "update") == set()
    # read: a reader of the operation reads the analysis (one bare hop), an owner who is not a reader does not
    assert _can(w, "u_viewer", "machining_force_analysis", "read") == only
    assert _can(w, "u_coowner", "machining_force_analysis", "read") == set()
    assert _can(w, "u_stranger", "machining_force_analysis", "read") == set()


def test_campaigns_update_is_reader_and_owner_or_edit_and_delete_is_reader_and_owner():
    w = World()
    base_people(w)
    w.person("campOwner")
    w.campaign("C", owner="campOwner")
    w.grant("campaign", "C", "editor", "edit")
    w.grant("campaign", "C", "viewer", "view")
    w.readers("campaigns", "C", "campOwner", "editor", "viewer")
    assert _can(w, "u_campOwner", "campaigns", "update") == {"C"}
    assert _can(w, "u_campOwner", "campaigns", "delete") == {"C"}
    assert _can(w, "u_editor", "campaigns", "update") == {"C"}
    assert _can(w, "u_editor", "campaigns", "delete") == set()
    assert _can(w, "u_viewer", "campaigns", "update") == set()
    # the project gate lives in the readers table: an owner the project hides the campaign from loses the write too
    w2 = World()
    base_people(w2)
    w2.person("campOwner")
    w2.campaign("C", owner="campOwner")
    assert _can(w2, "u_campOwner", "campaigns", "update") == set()
    assert _can(w2, "u_campOwner", "campaigns", "delete") == set()


def test_sample_co_owners_update_and_delete_are_owner_only():
    w = World()
    base_people(w)
    w.sample("S", owner="owner")
    row = w.coowner("S", "coowner")
    w.readers("physical_samples", "S", "owner", "coowner")
    for action in ("update", "delete"):
        assert _can(w, "u_owner", "sample_co_owners", action) == {row["_n"]}
        assert (
            _can(w, "u_coowner", "sample_co_owners", action) == set()
        ), "a co-owner can no longer change or remove co-owners"
        assert _can(w, "u_stranger", "sample_co_owners", action) == set()
    old = Directus(MAIN, w, "u_coowner")
    assert any(
        old.can("sample_co_owners", "update", r) for r in w.t["sample_co_owners"]
    ), "today a co-owner could"


def test_update_and_delete_ids_are_a_subset_of_read_ids_for_operations():
    """Structural, because update and delete contain the reader term and read is the readers table or the amnesty."""
    w = _op_world()
    w.readers("manufacturing_operations", "O", "opOwner", "viewer", "editor", "owner")
    w.op(
        "OF"
    )  # an ownerless run in operation_open_to_all: everyone reads it, nobody updates or deletes it
    w.open_to_all("OF")
    for user in users_of(w):
        read = _can(w, user, "manufacturing_operations", "read")
        for action in ("update", "delete"):
            assert _can(w, user, "manufacturing_operations", action) <= read, (
                user,
                action,
            )
    assert _can(w, "u_stranger", "manufacturing_operations", "read") == {"OF"}
    assert _can(w, "u_stranger", "manufacturing_operations", "update") == set()


def test_the_open_to_all_leaf_is_a_some_on_the_open_set_and_children_do_not_inherit_it():
    w = _op_world()
    w.op("OF")
    w.open_to_all("OF")
    w.add("machining_force_analysis", operation_id="OF")
    assert "OF" in _can(w, "u_stranger", "manufacturing_operations", "read")
    assert (
        _can(w, "u_stranger", "machining_force_analysis", "read") == set()
    ), "children do not inherit the amnesty"


def test_a_readers_row_of_another_user_does_not_make_the_caller_a_reader():
    """The membership test is `user_id = $CURRENT_USER` on the same joined row, not 'the record has readers'."""
    w = _op_world()
    w.readers("manufacturing_operations", "O", "viewer")
    assert _can(w, "u_viewer", "manufacturing_operations", "read") == {"O"}
    assert _can(w, "u_stranger", "manufacturing_operations", "read") == set()
    assert _can(w, "u_editor", "manufacturing_operations", "update") == set()


def test_campaign_samples_write_needs_the_junctions_own_reader_term():
    """The campaign's owner or the sample's editors may change a junction row, but never one they cannot read (update and
    delete are never wider than read): the owner of a campaign that a restricted project hides from them, or that holds a
    restricted sample, is not a reader of the junction row (campaign_sample_readers), so the bare hop refuses them."""
    for action in ("update", "delete"):
        f = RULES[("campaign_samples", action)]
        assert f["_and"][0] == READER_TERM, action
        assert "_some" not in json.dumps(f), action
    w = World()
    base_people(w)
    w.person("campOwner")
    w.campaign("C", owner="campOwner")
    w.sample("S", owner="owner")
    row = w.in_campaign("C", "S")
    # no readers row for campOwner: the sample is restricted and not theirs (or the project hides the campaign)
    w.readers("campaign_samples", row["_n"], "owner")
    assert _can(w, "u_campOwner", "campaign_samples", "update") == set()
    assert _can(w, "u_campOwner", "campaign_samples", "delete") == set()
    assert _can(w, "u_owner", "campaign_samples", "update") == {
        row["_n"]
    }, "the sample's owner reads and edits the row"
    w.readers("campaign_samples", row["_n"], "campOwner")
    assert _can(w, "u_campOwner", "campaign_samples", "update") == {row["_n"]}
    assert _can(w, "u_stranger", "campaign_samples", "update") == set()


# =================================================================================================
# The path resolver (phase1_schema.sh runs it on the real Directus metadata)
# =================================================================================================


def _directus(drop=(), restricted=True):
    """A hand-made Directus database in which every path of every rule resolves."""
    rel, cols, fields = {}, set(), set()

    def m2o(many, field, one, alias=None):
        rel[(many, field)] = (many, field, one, alias)
        cols.add(f"{many}.{field}")
        if alias:
            fields.add(f"{one}.{alias}")

    for t in (
        "physical_samples",
        "manufacturing_operations",
        "test_sessions",
        "campaigns",
    ):
        m2o(t, "owner_person_id", "people")
    m2o("projects", "principal_investigator_person", "people")
    m2o("physical_samples", "project_id", "projects", "samples")
    m2o("manufacturing_operations", "project_id", "projects", "operations")
    m2o("test_sessions", "project_id", "projects", "sessions")
    m2o("campaigns", "project_id", "projects", "campaigns")
    for t in ("manufacturing_operations", "test_sessions"):
        m2o(t, "sample_id", "physical_samples")
        m2o(t, "campaign_id", "campaigns")
    m2o("campaign_samples", "campaign_id", "campaigns", "samples")
    m2o("campaign_samples", "sample_id", "physical_samples", "campaigns")
    m2o("sample_co_owners", "sample_id", "physical_samples", "co_owners")
    m2o("project_investigators", "project_id", "projects", "secondary_investigators")
    for table, fk, parent in (
        ("sample_access", "sample_id", "physical_samples"),
        ("operation_access", "operation_id", "manufacturing_operations"),
        ("test_access", "session_id", "test_sessions"),
        ("campaign_access", "campaign_id", "campaigns"),
        ("project_access", "project_id", "projects"),
    ):
        m2o(table, fk, parent, "access")
        m2o(table, "person_id", "people")
        cols.add(f"{table}.role")
    # the readers tables (migration 166): record_id -> parent with the hidden alias `readers` (`open_to_all` for the amnesty set)
    for table, parent in (
        ("sample_readers", "physical_samples"), ("operation_readers", "manufacturing_operations"),
        ("test_readers", "test_sessions"), ("campaign_readers", "campaigns"), ("project_readers", "projects"),
        ("campaign_sample_readers", "campaign_samples"),
    ):  # fmt: skip
        m2o(table, "record_id", parent, "readers")
        cols.add(f"{table}.user_id")
    m2o("operation_open_to_all", "record_id", "manufacturing_operations", "open_to_all")
    for t, f, one in [
        ("sample_stock_provenance", "sample_id", "physical_samples"),
        ("sample_data_files", "sample_id", "physical_samples"),
        ("sample_genealogy", "child_sample_id", "physical_samples"),
        ("sample_genealogy", "parent_sample_id", "physical_samples"),
        ("operation_data_files", "operation_id", "manufacturing_operations"),
        ("machining_force_analysis", "operation_id", "manufacturing_operations"),
        ("fast_run_data", "operation_id", "manufacturing_operations"),
        ("session_data_files", "session_id", "test_sessions"),
        ("operation_additional_operators", "operation_id", "manufacturing_operations"),
        ("session_additional_operators", "session_id", "test_sessions"),
        ("test_sessions_subject", "test_sessions_id", "test_sessions"),
        ("project_rollup", "project_id", "projects"),
    ]:
        m2o(t, f, one)
    cols |= {
        "people.user_id",
        "sample_co_owners.user_id",
        "project_investigators.user_id",
    }
    cols |= {
        "physical_samples.sample_id",
        "manufacturing_operations.operation_id",
        "test_sessions.session_id",
        "campaigns.campaign_id",
        "projects.project_id",
        "people.person_id",
    }
    if restricted:
        cols |= {f"{t}.restricted" for t in RECORDS}
        cols.add("project_rollup.restricted")
    for key in drop:
        rel.pop(key)
    return {
        "relations": list(rel.values()),
        "columns": sorted(cols),
        "fields": sorted(fields),
    }


def test_resolver_accepts_a_complete_database():
    assert gen.resolve(DOC, _directus()) == []


@pytest.mark.parametrize(
    "dropped,needle",
    [
        (("physical_samples", "owner_person_id"), "physical_samples.owner_person_id"),
        (("campaigns", "owner_person_id"), "campaigns.owner_person_id"),
        (("campaign_samples", "campaign_id"), "campaign_samples.campaign_id"),
        (("project_investigators", "project_id"), "projects.secondary_investigators"),
        (("sample_access", "sample_id"), "access"),
        (("project_access", "person_id"), "project_access.person_id"),
        (("sample_readers", "record_id"), "physical_samples.readers"),
        (
            ("operation_open_to_all", "record_id"),
            "manufacturing_operations.open_to_all",
        ),
        (("campaign_sample_readers", "record_id"), "campaign_samples.readers"),
    ],
)
def test_resolver_reports_a_deleted_relation(dropped, needle):
    problems = gen.resolve(DOC, _directus(drop=[dropped]))
    assert problems and any(needle in p for p in problems), problems


def test_resolver_needs_the_alias_field_row_and_the_user_column():
    db = _directus()
    db["fields"].remove("projects.secondary_investigators")
    assert any("projects.secondary_investigators" in p for p in gen.resolve(DOC, db))
    db = _directus()
    db["columns"].remove("people.user_id")
    assert any("people.user_id is not a column" in p for p in gen.resolve(DOC, db))
    db = _directus()
    db["fields"].remove("physical_samples.access")
    assert any("physical_samples.access" in p for p in gen.resolve(DOC, db))
    # the readers aliases of the read kinds: a missing field row, a missing alias, a missing user_id column
    for alias in (
        "physical_samples.readers",
        "manufacturing_operations.open_to_all",
        "campaign_samples.readers",
    ):
        db = _directus()
        db["fields"].remove(alias)
        assert any(alias in p for p in gen.resolve(DOC, db)), alias
    db = _directus()
    db["columns"].remove("sample_readers.user_id")
    assert any("sample_readers.user_id" in p for p in gen.resolve(DOC, db))
    db = _directus()
    db["columns"].remove("operation_open_to_all.record_id")
    assert any("operation_open_to_all.record_id" in p for p in gen.resolve(DOC, db))


def test_resolver_reports_a_missing_restricted_column_a_missing_where_column_and_a_bad_alias():
    problems = gen.resolve(DOC, _directus(restricted=False))
    assert any("physical_samples.restricted is not a column" in p for p in problems)
    db = _directus()
    db["columns"].remove("project_access.role")
    assert any(
        "where project_access.role is not a column" in p for p in gen.resolve(DOC, db)
    )
    # `at` must name a to-many alias: here `project_id` (a to-one) is used as one
    bad = {**DOC, "sets": {**DOC["sets"], "bad": [{"path": "project_id.principal_investigator_person.user_id", "at": "project_id", "where": {"restricted": [True]}}]},
           "rules": {**DOC["rules"], "physical_samples": {**DOC["rules"]["physical_samples"], "read": "bad"}}}  # fmt: skip
    assert any("is not a to-many alias" in p for p in gen.resolve(bad, _directus()))


def test_resolver_rejects_a_to_many_via():
    """A `via` distributes onto an AND: "exists A and exists B" is not "exists one row with A and B"."""
    bad = {**DOC, "sets": {**DOC["sets"], "bad": [{"via": "co_owners", "set": "sample.owner"}]},
           "rules": {**DOC["rules"], "physical_samples": {**DOC["rules"]["physical_samples"], "read": "bad"}}}  # fmt: skip
    problems = gen.resolve(bad, _directus())
    assert any(
        "a via must be a to-one hop" in p and "co_owners" in p for p in problems
    ), problems
    assert not [p for p in gen.resolve(DOC, _directus()) if "via" in p]


def test_resolver_checks_the_guards_the_owner_guards_and_the_restricted_keys():
    db = _directus()
    db["columns"].remove("sample_co_owners.sample_id")
    assert any("guard sample_co_owners.sample_id" in p for p in gen.resolve(DOC, db))
    db = _directus()
    db["columns"].remove("test_sessions.session_id")
    assert any("owner_guard test_sessions" in p for p in gen.resolve(DOC, db))
    db = _directus()
    db["columns"].remove("people.person_id")
    assert any("owner_guard" in p and "person_id" in p for p in gen.resolve(DOC, db))
    db = _directus()
    db["columns"].remove("campaigns.restricted")
    assert any(
        "owner_guard campaigns: campaigns.restricted" in p for p in gen.resolve(DOC, db)
    )
    db = _directus()
    db["columns"].remove("manufacturing_operations.sample_id")
    assert any(
        "restricted_keys manufacturing_operations" in p for p in gen.resolve(DOC, db)
    )


def test_resolve_command_exit_codes(tmp_path):
    good, bad = tmp_path / "good.json", tmp_path / "bad.json"
    good.write_text(json.dumps(_directus()), encoding="utf-8")
    bad.write_text(
        json.dumps(_directus(drop=[("campaigns", "owner_person_id")])), encoding="utf-8"
    )
    assert gen.main(["--resolve", str(good)]) == 0
    assert gen.main(["--resolve", str(bad)]) == 1


# -- against a migrated database ---------------------------------------------------------------


def _psql(sql):
    dsn = os.environ.get("DATABASE_URL")
    if not dsn or shutil.which("psql") is None:
        pytest.skip("needs DATABASE_URL and psql")
    r = subprocess.run(
        ["psql", dsn, "--no-psqlrc", "-Atc", sql], capture_output=True, text=True
    )
    if r.returncode != 0:
        pytest.skip(f"database unreachable: {r.stderr.strip()}")
    return r.stdout.strip()


def _migrated():
    if _psql("SELECT to_regclass('public.physical_samples') IS NOT NULL") != "t":
        pytest.skip("database is not migrated")


def test_every_rule_path_resolves_in_the_migrated_database():
    _migrated()
    dump = _psql(
        "SELECT json_build_object("
        "'relations', (SELECT coalesce(json_agg(json_build_array(many_collection, many_field, one_collection, one_field)), '[]'::json) FROM directus_relations),"
        "'columns', (SELECT coalesce(json_agg(table_name || '.' || column_name), '[]'::json) FROM information_schema.columns WHERE table_schema='public'),"
        "'fields', (SELECT coalesce(json_agg(collection || '.' || field), '[]'::json) FROM directus_fields))"
    )
    assert gen.resolve(DOC, json.loads(dump)) == []


def test_guard_keys_are_the_parents_primary_keys():
    _migrated()
    for junction, checks in DOC["guards"].items():
        for c in checks:
            pk = _psql(
                "SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid "
                f"AND a.attnum = ANY(i.indkey) WHERE i.indrelid = 'public.{c['parent']}'::regclass AND i.indisprimary"
            )
            assert pk == c["key"], (junction, c)


def test_owner_guard_keys_are_the_primary_keys():
    _migrated()

    def pk(table):
        return _psql(
            "SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid "
            f"AND a.attnum = ANY(i.indkey) WHERE i.indrelid = 'public.{table}'::regclass AND i.indisprimary"
        )

    for collection, g in DOC["owner_guards"].items():
        assert pk(collection) == g["key"], collection
        owner = g["fields"][0]
        target = _psql(
            "SELECT confrelid::regclass::text FROM pg_constraint WHERE contype = 'f' "
            f"AND conrelid = 'public.{collection}'::regclass "
            f"AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.{collection}'::regclass AND attname = '{owner['field']}')]"
        )
        assert pk(target) == owner["value_key"], (collection, target)


def test_record_access_tables_have_the_declared_keys():
    _migrated()
    for collection, spec in DOC["record_access"].items():
        n = _psql(
            "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' "
            f"AND ((table_name='{spec['table']}' AND column_name='{spec['fk']}') "
            f"OR (table_name='{collection}' AND column_name IN ('{spec['key']}','{spec['owner_field']}','restricted')))"
        )
        assert n == "4", collection


def test_co_owners_is_not_a_real_column_any_more():
    """The permission filter's `co_owners` must be the M2M alias, not the legacy TEXT column."""
    _migrated()
    assert (
        _psql(
            "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' "
            "AND table_name='physical_samples' AND column_name='co_owners'"
        )
        == "0"
    )


def test_the_params_tables_in_unfiltered_do_not_exist_in_the_database():
    """access_rules.json keeps their stale grants; if a table ever comes back it must get rules, not a free pass."""
    _migrated()
    for table in (
        "machining_params", "sintering_params", "heat_treatment_params", "deformation_params", "am_params",
        "tensile_test_params", "hardness_test_params", "charpy_test_params", "compression_test_params",
        "sem_params", "xrd_params",
    ):  # fmt: skip
        assert _psql(f"SELECT to_regclass('public.{table}') IS NULL") == "t", table


def test_a_legal_some_applies_the_related_rule_of_the_same_action_so_edit_rules_use_bare_hops():
    """`sample_co_owners` update is owner-only, so `co_owners._some` inside an UPDATE filter would look only at
    co-owner rows the caller may update (the owner's): every co-owner would lose the right to edit the sample. The
    editors set reads the bare hop; this is the case the smoke matrix caught on a real Directus."""
    w = World()
    base_people(w)
    w.sample("S", owner="owner")
    w.coowner("S", "coowner")
    assert Directus(RULES, w, "u_coowner").ids("physical_samples", "update") == {"S"}
    assert "_some" not in json.dumps(
        BY_KEY[("physical_samples", "update")]["permissions"]
    )
    mutated = {**RULES}
    mutated[("physical_samples", "update")] = {
        "_or": [OWN, {"co_owners": {"_some": {"user_id": U}}}]
    }
    assert Directus(mutated, w, "u_coowner").ids("physical_samples", "update") == set()


def test_no_update_delete_or_manage_filter_contains_a_some():
    """A legal `_some` applies the related collection's rule of the same action to the rows it looks at, so an edit
    rule that goes through one inherits the related table's write rules (see the co-owner case above). Update and
    delete filters, the guard filters and the manage filters the endpoint ships are written with bare hops only."""
    for (collection, action), row in BY_KEY.items():
        if action in ("update", "delete"):
            assert "_some" not in json.dumps(row["permissions"]), (collection, action)
    hook = gen.hook_rules(DOC)
    for junction, checks in hook["guards"].items():
        for c in checks:
            assert "_some" not in json.dumps(c["filter"]), (junction, c["parent"])
    for collection, g in hook["ownerGuards"].items():
        assert "_some" not in json.dumps(g["filter"]), collection
    for collection, rec in gen.record_rules(DOC)["records"].items():
        assert "_some" not in json.dumps(rec["manage"]), collection
