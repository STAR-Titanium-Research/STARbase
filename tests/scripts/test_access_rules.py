"""ADR-0011 row-level visibility and A1 record access: scripts/access_rules.json, its generator and the script block.

Pure checks run everywhere. The database checks need a migrated Postgres (DATABASE_URL and psql);
they skip otherwise (the CI job sets REQUIRE_DB_TESTS=1, so a skip there fails the job).
tests/phase1_schema.sh also resolves every rule path against the Directus metadata that the
configure_*.sql scripts leave behind.

The semantic tests use a small fixture evaluator that models Directus, not SQL intuition:
  * a legal `_some` (directly under a top-level to-many alias) is an EXISTS subquery, and the related
    collection's own Lab Member read rule applies to the rows it looks at;
  * a dropped `_some` (a bare to-many hop) is a LEFT JOIN: every bare hop of one filter is ONE joined alias,
    the whole filter is evaluated per row of the join product, so two conditions on the same hop hold on the
    same row; a filter on a null row (no join partner) is false, except `_null`, which is true.
"""

import importlib.util
import json
import os
import random
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
# Lab Member filters of main before A1 (generator output on 2026-10-12, frozen so equivalence needs no git history).
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
)


def _paths(collection, action):
    return list(
        dict.fromkeys(gen.expand(DOC["sets"], DOC["rules"][collection][action]))
    )


def _rule_paths():
    for collection, actions in DOC["rules"].items():
        for action, rule in actions.items():
            if rule != "any":
                yield collection, action, _paths(collection, action)


# =================================================================================================
# The fixture evaluator
# =================================================================================================

COMPARATORS = {"_eq", "_null", "_in"}


def _access(parent, table, fk):
    return {
        "access": ("o2m", table, fk),
    }


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
    },
    "campaigns": {
        "pk": "campaign_id",
        "owner_person_id": ("m2o", "people"),
        "project_id": ("m2o", "projects"),
        "access": ("o2m", "campaign_access", "campaign_id"),
        "samples": ("o2m", "campaign_samples", "campaign_id"),
    },
    "physical_samples": {
        "pk": "sample_id",
        "owner_person_id": ("m2o", "people"),
        "project_id": ("m2o", "projects"),
        "co_owners": ("o2m", "sample_co_owners", "sample_id"),
        "access": ("o2m", "sample_access", "sample_id"),
        "campaigns": ("o2m", "campaign_samples", "sample_id"),
    },
    "manufacturing_operations": {
        "pk": "operation_id",
        "owner_person_id": ("m2o", "people"),
        "project_id": ("m2o", "projects"),
        "campaign_id": ("m2o", "campaigns"),
        "sample_id": ("m2o", "physical_samples"),
        "access": ("o2m", "operation_access", "operation_id"),
    },
    "test_sessions": {
        "pk": "session_id",
        "owner_person_id": ("m2o", "people"),
        "project_id": ("m2o", "projects"),
        "campaign_id": ("m2o", "campaigns"),
        "sample_id": ("m2o", "physical_samples"),
        "access": ("o2m", "test_access", "session_id"),
    },
    "project_investigators": {"pk": "_n", "project_id": ("m2o", "projects")},
    "sample_co_owners": {"pk": "_n", "sample_id": ("m2o", "physical_samples")},
    "campaign_samples": {
        "pk": "_n",
        "campaign_id": ("m2o", "campaigns"),
        "sample_id": ("m2o", "physical_samples"),
    },
    "sample_access": {"pk": "_n", "sample_id": ("m2o", "physical_samples"), "person_id": ("m2o", "people")},
    "operation_access": {"pk": "_n", "operation_id": ("m2o", "manufacturing_operations"), "person_id": ("m2o", "people")},
    "test_access": {"pk": "_n", "session_id": ("m2o", "test_sessions"), "person_id": ("m2o", "people")},
    "campaign_access": {"pk": "_n", "campaign_id": ("m2o", "campaigns"), "person_id": ("m2o", "people")},
    "project_access": {"pk": "_n", "project_id": ("m2o", "projects"), "person_id": ("m2o", "people")},
    "sample_data_files": {"pk": "_n", "sample_id": ("m2o", "physical_samples")},
    "operation_data_files": {"pk": "_n", "operation_id": ("m2o", "manufacturing_operations")},
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
            elif actual is None:
                ok = False
            elif op == "_eq":
                ok = actual == (self.user if want == "$CURRENT_USER" else want)
            else:
                ok = actual in want
            if not ok:
                return False
        return True


def visible(rules, world, users, tables, action="read"):
    out = {}
    for user in users:
        d = Directus(rules, world, user)
        for table in tables:
            out[(user, table)] = d.ids(table, action)
    return out


def users_of(world):
    return [p["user_id"] for p in world.t["people"] if p["user_id"]]


RECORDS = [
    "physical_samples",
    "manufacturing_operations",
    "test_sessions",
    "campaigns",
    "projects",
]
CHILDREN = [
    "sample_data_files", "operation_data_files", "session_data_files", "test_sessions_subject",
    "project_investigators", "sample_co_owners", "campaign_samples",
]  # fmt: skip


# =================================================================================================
# A plain reading of spec section 1 (not built from the generated filters)
# =================================================================================================


class Reference:
    def __init__(self, world, user):
        self.w, self.u = world, user
        self.d = Directus({}, world, user)

    def usr(self, person_id):
        p = self.d.find("people", person_id)
        return p["user_id"] if p else None

    def me(self, person_id):
        return person_id is not None and self.usr(person_id) == self.u

    def rows(self, table, **kw):
        return [r for r in self.w.t[table] if all(r.get(k) == v for k, v in kw.items())]

    def f(self, table, key):
        return self.d.find(table, key)

    # projects
    def p_listed(self, p):
        k = p["project_id"]
        return (
            self.me(p["principal_investigator_person"])
            or any(
                r["user_id"] == self.u
                for r in self.rows("project_investigators", project_id=k)
            )
            or any(
                self.me(r["person_id"])
                for r in self.rows("project_access", project_id=k)
            )
        )

    def p_invs(self, p):
        if p is None:
            return False
        k = p["project_id"]
        return any(
            r["user_id"] == self.u
            for r in self.rows("project_investigators", project_id=k)
        ) or any(
            self.me(r["person_id"]) and r["role"] == "investigator"
            for r in self.rows("project_access", project_id=k)
        )

    def gate_p(self, project_key):
        p = self.f("projects", project_key)
        return p is None or not p["restricted"] or self.p_listed(p)

    # campaigns
    def c_pi(self, c):
        p = self.f("projects", c["project_id"])
        return p is not None and self.me(p["principal_investigator_person"])

    def c_listed(self, c):
        return (
            self.me(c["owner_person_id"])
            or any(
                self.me(r["person_id"])
                for r in self.rows("campaign_access", campaign_id=c["campaign_id"])
            )
            or self.c_pi(c)
        )

    def gate_c(self, campaign_key):
        c = self.f("campaigns", campaign_key)
        return c is None or (
            (not c["restricted"] or self.c_listed(c)) and self.gate_p(c["project_id"])
        )

    # samples
    def camps(self, s):
        return [
            self.f("campaigns", r["campaign_id"])
            for r in self.rows("campaign_samples", sample_id=s["sample_id"])
        ]

    def s_listed(self, s):
        k = s["sample_id"]
        pr = self.f("projects", s["project_id"])
        return (
            self.me(s["owner_person_id"])
            or any(
                r["user_id"] == self.u
                for r in self.rows("sample_co_owners", sample_id=k)
            )
            or any(
                self.me(r["person_id"]) for r in self.rows("sample_access", sample_id=k)
            )
            or (pr is not None and self.me(pr["principal_investigator_person"]))
            or any(self.c_pi(c) for c in self.camps(s))
        )

    def gate_s(self, sample_key):
        s = self.f("physical_samples", sample_key)
        return s is None or not s["restricted"] or self.s_listed(s)

    def s_editor(self, s):
        k = s["sample_id"]
        return (
            self.me(s["owner_person_id"])
            or any(
                r["user_id"] == self.u
                for r in self.rows("sample_co_owners", sample_id=k)
            )
            or any(
                self.me(r["person_id"]) and r["role"] == "edit"
                for r in self.rows("sample_access", sample_id=k)
            )
        )

    def s_read(self, s):
        if s is None:
            return False
        if self.s_listed(s):
            return True
        if s["restricted"]:
            return False
        return (
            self.p_invs(self.f("projects", s["project_id"]))
            or any(
                self.me(c["owner_person_id"]) and self.gate_p(c["project_id"])
                for c in self.camps(s)
            )
            or any(
                not c["restricted"] and self.p_invs(self.f("projects", c["project_id"]))
                for c in self.camps(s)
            )
        )

    # operations and tests
    def gates(self, r):
        s = self.f("physical_samples", r["sample_id"])
        return (
            self.gate_s(r["sample_id"])
            and (s is None or self.gate_p(s["project_id"]))
            and self.gate_p(r["project_id"])
            and self.gate_c(r["campaign_id"])
        )

    def r_listed(self, table, r):
        k = r[SCHEMA[table]["pk"]]
        access = {
            "manufacturing_operations": "operation_access",
            "test_sessions": "test_access",
        }[table]
        fk = SCHEMA[table]["pk"]
        pr = self.f("projects", r["project_id"])
        c = self.f("campaigns", r["campaign_id"])
        return (
            self.me(r["owner_person_id"])
            or any(self.me(a["person_id"]) for a in self.rows(access, **{fk: k}))
            or (pr is not None and self.me(pr["principal_investigator_person"]))
            or (c is not None and self.c_pi(c))
        )

    def r_inherited(self, r):
        c = self.f("campaigns", r["campaign_id"])
        return (
            self.s_read(self.f("physical_samples", r["sample_id"]))
            or self.p_invs(self.f("projects", r["project_id"]))
            or (c is not None and self.me(c["owner_person_id"]))
            or (c is not None and self.p_invs(self.f("projects", c["project_id"])))
        )

    def r_read(self, table, r, amnesty=True):
        if self.gates(r) and (
            self.r_listed(table, r) or (not r["restricted"] and self.r_inherited(r))
        ):
            return True
        if amnesty and table == "manufacturing_operations":
            s = self.f("physical_samples", r["sample_id"])
            return (
                r["owner_person_id"] is None and r["project_id"] is None and r["campaign_id"] is None
                and not r["restricted"] and self.gate_s(r["sample_id"]) and (s is None or self.gate_p(s["project_id"]))
            )  # fmt: skip
        return False

    def r_update(self, table, r):
        if not self.gates(r):
            return False
        access = {
            "manufacturing_operations": "operation_access",
            "test_sessions": "test_access",
        }[table]
        fk, k = SCHEMA[table]["pk"], r[SCHEMA[table]["pk"]]
        s = self.f("physical_samples", r["sample_id"])
        return (
            self.me(r["owner_person_id"])
            or any(
                self.me(a["person_id"]) and a["role"] == "edit"
                for a in self.rows(access, **{fk: k})
            )
            or (not r["restricted"] and s is not None and self.s_editor(s))
        )

    def r_delete(self, r):
        return self.gates(r) and self.me(r["owner_person_id"])

    # campaigns
    def c_read(self, c):
        k = c["campaign_id"]
        if not self.gate_p(c["project_id"]):
            return False
        if self.c_listed(c):
            return True
        if c["restricted"]:
            return False
        if self.p_invs(self.f("projects", c["project_id"])):
            return True
        for r in self.rows("campaign_samples", campaign_id=k):
            s = self.f("physical_samples", r["sample_id"])
            if self.s_editor(s) and (self.me(s["owner_person_id"]) or self.s_listed(s)):
                return True
        return False

    def c_update(self, c):
        return self.gate_p(c["project_id"]) and (
            self.me(c["owner_person_id"])
            or any(
                self.me(a["person_id"]) and a["role"] == "edit"
                for a in self.rows("campaign_access", campaign_id=c["campaign_id"])
            )
        )

    def c_delete(self, c):
        return self.gate_p(c["project_id"]) and self.me(c["owner_person_id"])

    # projects
    def pj_read(self, p):
        if self.p_listed(p):
            return True
        if p["restricted"]:
            return False
        k = p["project_id"]
        if any(
            self.me(c["owner_person_id"]) and self.c_read(c)
            for c in self.rows("campaigns", project_id=k)
        ):
            return True
        if any(
            self.s_editor(s) and self.s_read(s)
            for s in self.rows("physical_samples", project_id=k)
        ):
            return True
        for table in ("manufacturing_operations", "test_sessions"):
            if any(
                self.me(r["owner_person_id"]) and self.r_read(table, r)
                for r in self.rows(table, project_id=k)
            ):
                return True
        return False

    def ids(self, table, action):
        pk = SCHEMA[table]["pk"]
        out = set()
        for r in self.w.t[table]:
            if table == "physical_samples":
                ok = {
                    "read": self.s_read(r),
                    "update": self.s_editor(r),
                    "delete": self.me(r["owner_person_id"]),
                }[action]
            elif table in ("manufacturing_operations", "test_sessions"):
                ok = {
                    "read": lambda: self.r_read(table, r),
                    "update": lambda: self.r_update(table, r),
                    "delete": lambda: self.r_delete(r),
                }[action]()
            elif table == "campaigns":
                ok = {
                    "read": self.c_read,
                    "update": self.c_update,
                    "delete": self.c_delete,
                }[action](r)
            elif table == "projects":
                ok = (
                    self.pj_read(r)
                    if action == "read"
                    else self.me(r["principal_investigator_person"])
                )
            if ok:
                out.add(r[pk])
        return out


def reference_ids(world, users, tables=RECORDS):
    return {
        (u, t, a): Reference(world, u).ids(t, a)
        for u in users
        for t in tables
        for a in ("read", "update", "delete")
        if not (t == "projects" and a == "update")
    }


# =================================================================================================
# Worlds
# =================================================================================================

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


def random_world(seed, restricted=True, access=True, legacy=True):
    r = random.Random(seed)
    w = World()
    base_people(w)
    names = PEOPLE + ["nologin"]
    logins = PEOPLE

    def pick(xs, p_none):
        return None if r.random() < p_none else r.choice(xs)

    def flag():
        return restricted and r.random() < 0.3

    projects = [f"P{i}" for i in range(3)]
    for p in projects:
        w.project(p, pi=pick(logins, 0.1), restricted=flag())
        if legacy:
            for _ in range(r.choice([0, 0, 1, 2])):
                w.investigator(p, r.choice(logins))
        if access:
            for _ in range(r.choice([0, 0, 1, 2])):
                w.grant(
                    "project", p, r.choice(names), r.choice(["view", "investigator"])
                )
    campaigns = [f"C{i}" for i in range(4)]
    for c in campaigns:
        w.campaign(
            c, project=pick(projects, 0.3), owner=pick(logins, 0.1), restricted=flag()
        )
        if access:
            for _ in range(r.choice([0, 0, 1, 2])):
                w.grant("campaign", c, r.choice(names), r.choice(["view", "edit"]))
    samples = [f"S{i}" for i in range(6)]
    for s in samples:
        w.sample(
            s, project=pick(projects, 0.4), owner=pick(logins, 0.1), restricted=flag()
        )
        for c in r.sample(campaigns, r.choice([0, 1, 1, 2])):
            w.in_campaign(c, s)
        if legacy:
            for _ in range(r.choice([0, 0, 1, 2])):
                w.coowner(s, r.choice(logins))
        if access:
            for _ in range(r.choice([0, 0, 1, 2])):
                w.grant("sample", s, r.choice(names), r.choice(["view", "edit"]))
    for table, keys in (
        ("manufacturing_operations", [f"O{i}" for i in range(8)]),
        ("test_sessions", [f"T{i}" for i in range(4)]),
    ):
        for k in keys:
            orphan = table == "manufacturing_operations" and r.random() < 0.3
            rec = w.record(
                table, k,
                sample=pick(samples, 0.15),
                project=None if orphan else pick(projects, 0.5),
                campaign=None if orphan else pick(campaigns, 0.5),
                owner=None if orphan else pick(logins, 0.25),
                restricted=flag(),
            )  # fmt: skip
            if access and r.random() < 0.4:
                w.grant(
                    "operation" if table == "manufacturing_operations" else "test",
                    k,
                    r.choice(names),
                    r.choice(["view", "edit"]),
                )
            kind = (
                "operation_data_files"
                if table == "manufacturing_operations"
                else "session_data_files"
            )
            fk = "operation_id" if table == "manufacturing_operations" else "session_id"
            w.add(kind, **{fk: k})
            if table == "test_sessions":
                w.add("test_sessions_subject", test_sessions_id=k)
            del rec
    for s in samples:
        w.add("sample_data_files", sample_id=s)
    return w


def swap_legacy_for_access(world):
    """The same people on the same records, as access rows instead of sample_co_owners / project_investigators."""
    w = World()
    w.t = {k: [dict(r) for r in v] for k, v in world.t.items()}
    w.n = world.n
    for row in w.t.pop("sample_co_owners"):
        w.t["sample_access"].append(
            {
                "sample_id": row["sample_id"],
                "person_id": "p_" + row["user_id"][2:],
                "role": "edit",
                "_n": row["_n"],
            }
        )
    for row in w.t.pop("project_investigators"):
        w.t["project_access"].append(
            {
                "project_id": row["project_id"],
                "person_id": "p_" + row["user_id"][2:],
                "role": "investigator",
                "_n": row["_n"],
            }
        )
    w.t["sample_co_owners"] = []
    w.t["project_investigators"] = []
    return w


def drop_access_rows(world):
    w = World()
    w.t = {
        k: ([] if k.endswith("_access") else [dict(r) for r in v])
        for k, v in world.t.items()
    }
    return w


def match_all(world, rules, users=None):
    users = users or users_of(world)
    return visible(
        rules, world, users, RECORDS + [c for c in CHILDREN if (c, "read") in rules]
    )


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
            assert (key, value) in {
                ("user_id", "$CURRENT_USER"),
                ("restricted", False),
            }, (
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
    "each": [{"each": "campaigns", "items": [{"and": ["campaign_id.owner_person_id.user_id", {"field": "campaign_id.restricted", "eq": False}]}]}],
    "each_via": [{"via": "sample_id", "set": "each"}],
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


def test_each_is_an_and_of_paths_through_the_bare_alias_never_a_some_body():
    own_c = {"campaign_id": {"owner_person_id": {"user_id": U}}}
    unr_c = {"campaign_id": {"restricted": {"_eq": False}}}
    # {alias: {_some: {_and: [...]}}} is what the spec first said; Directus 11.17 answers it with a 500
    assert gen.set_filter(SETS, "each") == {
        "_and": [{"campaigns": own_c}, {"campaigns": unr_c}]
    }
    assert gen.set_filter(SETS, "each_via") == {
        "_and": [
            {"sample_id": {"campaigns": own_c}},
            {"sample_id": {"campaigns": unr_c}},
        ]
    }


def test_bad_items_are_rejected():
    for bad in (
        {"x": [{"field": "a"}]},
        {"x": [{"path": "a.b"}]},
        {"x": [{"path": "a.b", "at": "z", "where": {}}]},
        {"x": [{"each": "a", "items": []}]},
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
        elif key in ("_eq", "_null", "_in"):
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
    walks every generated filter (every row, the amnesty clause, the hook and endpoint rules)."""
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


def test_filters_have_the_documented_sizes():
    """Not a limit: a tripwire so a change that doubles a filter is noticed (the performance gate of the
    plan watches the real cost). Counts leaves of the ruled operation, test, sample, campaign and project reads."""

    def count(node):
        if isinstance(node, dict):
            if set(node) <= COMPARATORS:
                return 1
            return sum(count(v) for v in node.values())
        if isinstance(node, list):
            return sum(count(v) for v in node)
        return 0

    sizes = {c: count(BY_KEY[(c, "read")]["permissions"]) for c in RECORDS}
    assert sizes["manufacturing_operations"] < 90 and sizes["test_sessions"] < 70
    assert (
        sizes["physical_samples"] < 30
        and sizes["campaigns"] < 25
        and sizes["projects"] < 20
    )


@pytest.mark.parametrize("collection,action,paths", list(_rule_paths()))
def test_every_path_ends_at_a_user_column(collection, action, paths):
    for path in paths:
        tail = ".".join([p for p in path.split(".") if p != "_some"][-2:])
        assert tail in PATH_TAILS, f"{collection}.{action}: {path}"


# =================================================================================================
# Guards, owner guards, the hook and endpoint rule files
# =================================================================================================


def test_guards_cover_every_junction_that_grants_visibility():
    """Any junction a read path goes through must be guarded (create is never filtered). The *_access
    tables are the exception by design: Lab Member has no write grant on them, the endpoint writes them."""
    grants = set()
    for _c, _a, paths in _rule_paths():
        for path in paths:
            if "co_owners" in path:
                grants.add("sample_co_owners")
            if "secondary_investigators" in path:
                grants.add("project_investigators")
            parts = [p for p in path.split(".") if p != "_some"]
            # test_sessions.sample_id is derived from the first sample of the test_sessions_subject
            # junction (migration 139), so a read path through it is a junction grant too
            if _c == "test_sessions" and parts[0] == "sample_id":
                grants.add("test_sessions_subject")
            for a, b in zip(parts, parts[1:]):
                if (a, b) in (("campaigns", "campaign_id"), ("samples", "sample_id")):
                    grants.add("campaign_samples")
    assert grants == set(DOC["guards"])
    for table in (
        "sample_access",
        "operation_access",
        "test_access",
        "campaign_access",
        "project_access",
    ):
        assert not {a for (c, a) in BY_KEY if c == table} & {
            "create",
            "update",
            "delete",
        }
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
# Amnesty
# =================================================================================================


def test_amnesty_filter_takes_the_extra_gate_and_the_restricted_test():
    spec = {"null": ["a", "b"], "restricted_false": True, "also": "u"}
    assert gen.amnesty_filter(spec, SETS) == {
        "_and": [{"a": {"_null": True}}, {"b": {"_null": True}}, R, OWN]
    }
    assert gen.amnesty_filter({"null": ["a"]}) == {"a": {"_null": True}}
    assert gen.with_amnesty({"_or": [OWN, R]}, {"null": ["a"]}) == {
        "_or": [OWN, R, {"a": {"_null": True}}]
    }
    for bad in ({"null": []}, {"null": ["a"], "x": 1}):
        with pytest.raises(gen.RulesError):
            gen.amnesty_filter(bad, SETS)
    with pytest.raises(gen.RulesError):
        gen.amnesty_filter({"null": ["a"], "also": "u"})


def test_orphan_amnesty_opens_read_only_for_fully_unowned_unrestricted_operations():
    """~7254 pre-ADR-0011 FAST runs have no owner, operator, project or campaign and never will
    (migration 20261009000141): admin-only visibility helps nobody, so read is opened to every Lab Member
    for exactly that shape of record, unless the record or what it hangs on is restricted. Update and
    delete still need a real owner; test_sessions and the children get no amnesty."""
    w = World()
    base_people(w)
    w.project("P", pi="pi")
    w.sample("S", project="P", owner="owner")
    w.sample("SR", project="P", owner="owner", restricted=True)
    w.project("PR", pi="pi", restricted=True)
    w.sample("SP", project="PR", owner="owner")
    w.op("free")
    w.op("free_s", sample="S")
    w.op("restricted", restricted=True)
    w.op("under_restricted_sample", sample="SR")
    w.op("under_restricted_project_sample", sample="SP")
    w.test("t_free")
    w.add("operation_data_files", operation_id="free")
    d = Directus(RULES, w, "u_stranger")
    assert d.ids("manufacturing_operations", "read") == {"free", "free_s"}
    assert d.ids("manufacturing_operations", "update") == set()
    assert d.ids("manufacturing_operations", "delete") == set()
    assert d.ids("test_sessions", "read") == set()
    assert d.ids("operation_data_files", "read") == set(), "children get no amnesty"
    assert gen.amnesty_filter(
        DOC["orphan_amnesty"]["manufacturing_operations"], DOC["sets"]
    ) == {
        "_and": [
            {"owner_person_id": {"_null": True}},
            {"project_id": {"_null": True}},
            {"campaign_id": {"_null": True}},
            R,
            *gen.combine("_and", [gen.set_filter(DOC["sets"], "amnesty.gates")])[
                "_and"
            ],
        ]
    }


# =================================================================================================
# Equivalence with main, restricted never widens, legacy = access, the cascade table
# =================================================================================================

SEEDS = range(40)


def test_with_nothing_restricted_every_user_sees_exactly_todays_ids():
    """(i) The new filters give today's visible ids for every fixture user when nothing is restricted and no
    access rows exist. Intended difference: sample_co_owners update/delete (owner only, checked below)."""
    differs = {("sample_co_owners", "update"), ("sample_co_owners", "delete")}
    tables = RECORDS + [c for c in CHILDREN if (c, "read") in MAIN]
    for seed in SEEDS:
        w = random_world(seed, restricted=False, access=False)
        for user in users_of(w):
            new, old = Directus(RULES, w, user), Directus(MAIN, w, user)
            for table in tables:
                for action in ("read", "update", "delete"):
                    if (table, action) in differs or (table, action) not in MAIN:
                        continue
                    assert new.ids(table, action) == old.ids(table, action), (
                        seed,
                        user,
                        table,
                        action,
                    )


def test_sample_co_owners_update_and_delete_are_owner_only():
    w = World()
    base_people(w)
    w.sample("S", owner="owner")
    w.coowner("S", "coowner")
    w.coowner("S", "viewer")
    w.sample("S2", owner="viewer")
    row = w.add("sample_co_owners", sample_id="S2", user_id="u_stranger")
    for table in ("sample_co_owners",):
        for action in ("update", "delete"):
            ids = lambda user: {  # noqa: E731
                r["_n"]
                for r in w.t[table]
                if Directus(RULES, w, user).can(table, action, r)
            }
            assert ids("u_owner") == {
                r["_n"] for r in w.t[table] if r["sample_id"] == "S"
            }
            assert (
                ids("u_coowner") == set()
            ), "a co-owner can no longer change or remove co-owners"
            assert ids("u_viewer") == {row["_n"]}
            assert ids("u_stranger") == set()
            old = Directus(MAIN, w, "u_coowner")
            assert any(
                old.can(table, action, r) for r in w.t[table]
            ), "today a co-owner could"


def test_restricted_never_widens_update_and_delete_are_subsets_of_read():
    """(ii) over random worlds with restricted records and access rows, and: switching a record to restricted
    never makes anything visible to anyone who could not see it before."""
    for seed in SEEDS:
        w = random_world(seed)
        for user in users_of(w):
            d = Directus(RULES, w, user)
            for table in RECORDS:
                read = d.ids(table, "read")
                for action in ("update", "delete"):
                    assert d.ids(table, action) <= read, (seed, user, table, action)
            for table in (
                "operation_data_files",
                "session_data_files",
                "sample_data_files",
            ):
                if (table, "update") in RULES and (table, "read") in RULES:
                    assert d.ids(table, "update") <= d.ids(table, "read"), (
                        seed,
                        user,
                        table,
                    )


def test_switching_one_record_to_restricted_only_ever_removes_visibility():
    for seed in range(15):
        w = random_world(seed, restricted=False)
        before = {k: v for k, v in match_all(w, RULES).items()}
        flips = [(t, r) for t in RECORDS for r in w.t[t]]
        for table, row in random.Random(seed).sample(flips, 6):
            row["restricted"] = True
            after = match_all(w, RULES)
            for key in before:
                assert after[key] <= before[key], (
                    seed,
                    table,
                    row[SCHEMA[table]["pk"]],
                    key,
                )
            row["restricted"] = False


def test_the_generated_rules_equal_a_plain_reading_of_the_spec_on_random_worlds():
    """The independent check: spec section 1 written as plain Python (class Reference) against the generated
    filters run through the Directus model, for read, update and delete of the five record types."""
    for seed in SEEDS:
        w = random_world(seed)
        users = users_of(w)
        ref = reference_ids(w, users)
        for user in users:
            d = Directus(RULES, w, user)
            for table in RECORDS:
                for action in ("read", "update", "delete"):
                    if table == "projects" and action == "update":
                        action = "delete"  # the same filter: the PI
                    assert d.ids(table, action) == ref[(user, table, action)], (
                        seed,
                        user,
                        table,
                        action,
                    )


def test_children_follow_their_parent():
    for seed in range(15):
        w = random_world(seed)
        for user in users_of(w):
            d = Directus(RULES, w, user)
            ops = Reference(w, user).ids("manufacturing_operations", "read")
            # the children are not given the orphan amnesty (the rule is per collection): only the gates and own rule
            ref = Reference(w, user)
            plain_ops = {
                r["operation_id"]
                for r in w.t["manufacturing_operations"]
                if ref.r_read("manufacturing_operations", r, amnesty=False)
            }
            assert ops >= plain_ops
            files = {r["_n"]: r["operation_id"] for r in w.t["operation_data_files"]}
            got = {
                files[r["_n"]]
                for r in w.t["operation_data_files"]
                if d.can("operation_data_files", "read", r)
            }
            assert got == plain_ops, (seed, user)
            tests = ref.ids("test_sessions", "read")
            subj = {
                r["_n"]: r["test_sessions_id"] for r in w.t["test_sessions_subject"]
            }
            got = {
                subj[r["_n"]]
                for r in w.t["test_sessions_subject"]
                if d.can("test_sessions_subject", "read", r)
            }
            assert got == tests, (seed, user)
            samples = ref.ids("physical_samples", "read")
            got = {
                r["sample_id"]
                for r in w.t["sample_data_files"]
                if d.can("sample_data_files", "read", r)
            }
            assert got == samples & {
                r["sample_id"] for r in w.t["sample_data_files"]
            }, (seed, user)
            projects = ref.ids("projects", "read")
            got = {
                r["project_id"]
                for r in w.t["project_investigators"]
                if d.can("project_investigators", "read", r)
            }
            # the bare (via) form has no junction rule inside it, so for an unrestricted project it can be a little
            # wider than the project page (as it is today); a restricted project's rows are the list's alone
            open_projects = {
                r["project_id"] for r in w.t["projects"] if not r["restricted"]
            }
            assert got - open_projects <= projects, (seed, user)


def test_a_legacy_co_owner_and_an_access_edit_person_see_exactly_the_same_ids_everywhere():
    """(iii) Including the project page (decision 17: the old tables and the new ones are a union)."""
    for seed in SEEDS:
        w = random_world(seed, legacy=True)
        swapped = swap_legacy_for_access(w)
        users = users_of(w)
        legacy_tables = RECORDS + [
            "sample_data_files",
            "operation_data_files",
            "session_data_files",
            "test_sessions_subject",
        ]
        for action in ("read", "update", "delete"):
            a = visible(RULES, w, users, legacy_tables, action)
            b = visible(RULES, swapped, users, legacy_tables, action)
            for key in a:
                if key[1] == "projects" and action == "update":
                    continue
                assert a[key] == b[key], (seed, key, action)


def test_a_view_person_reads_but_cannot_update_and_an_edit_person_can():
    w = World()
    base_people(w)
    w.sample("S", owner="owner")
    w.grant("sample", "S", "viewer", "view")
    w.grant("sample", "S", "editor", "edit")
    w.op("O", sample="S", owner="owner")
    w.test("T", sample="S", owner="owner")
    w.campaign("C", owner="campaignOwner")
    w.grant("campaign", "C", "viewer", "view")
    w.grant("campaign", "C", "editor", "edit")
    w.op("O2", owner="owner")
    w.grant("operation", "O2", "viewer", "view")
    w.grant("operation", "O2", "editor", "edit")
    for user, can_read, can_edit in (
        ("viewer", True, False),
        ("editor", True, True),
        ("stranger", False, False),
    ):
        d = Directus(RULES, w, f"u_{user}")
        assert ("S" in d.ids("physical_samples", "read")) is can_read
        assert ("S" in d.ids("physical_samples", "update")) is can_edit
        assert "S" not in d.ids("physical_samples", "delete")
        # a person who can edit the sample edits its unrestricted operations and tests; a viewer does not
        assert ("O" in d.ids("manufacturing_operations", "update")) is can_edit
        assert ("T" in d.ids("test_sessions", "update")) is can_edit
        assert ("C" in d.ids("campaigns", "read")) is can_read
        assert ("C" in d.ids("campaigns", "update")) is can_edit
        assert "C" not in d.ids("campaigns", "delete")
        assert ("O2" in d.ids("manufacturing_operations", "read")) is can_read
        assert ("O2" in d.ids("manufacturing_operations", "update")) is can_edit
        assert "O2" not in d.ids("manufacturing_operations", "delete")


def test_pi_and_investigator_access_is_read_only():
    """Owner decision 4 (2026-10-07): PI and investigator access through a project is read-only."""
    w = World()
    base_people(w)
    w.project("P", pi="pi")
    w.investigator("P", "inv")
    w.grant("project", "P", "inv2", "investigator")
    w.campaign("C", project="P", owner="campaignOwner")
    w.sample("S", project="P", owner="owner")
    w.op("O", sample="S", project="P", campaign="C", owner="owner")
    w.test("T", sample="S", project="P", owner="owner")
    for user in ("pi", "inv", "inv2"):
        d = Directus(RULES, w, f"u_{user}")
        assert "S" in d.ids("physical_samples", "read")
        assert "C" in d.ids("campaigns", "read")
        assert {"O"} == d.ids("manufacturing_operations", "read")
        assert {"T"} == d.ids("test_sessions", "read")
        for table in (
            "physical_samples",
            "manufacturing_operations",
            "test_sessions",
            "campaigns",
        ):
            for action in ("update", "delete"):
                assert d.ids(table, action) == set(), (user, table, action)
        assert ("P" in d.ids("projects", "update")) is (user == "pi")
        assert ("P" in d.ids("projects", "delete")) is (user == "pi")
    d = Directus(RULES, w, "u_stranger")
    assert all(not d.ids(t, "read") for t in RECORDS)


def test_the_cascade_of_spec_section_1_case_by_case():
    """(iv) restricted project, restricted campaign, a sample in two campaigns, an orphan FAST operation."""
    w = World()
    base_people(w)
    w.project("P", pi="pi", restricted=True)
    w.investigator("P", "inv")
    w.grant("project", "P", "viewer", "view")
    w.campaign("C", project="P", owner="campaignOwner")
    w.sample("S", project="P", owner="owner")
    w.in_campaign("C", "S")
    w.op("O", sample="S", project="P", owner="owner")
    w.test("T", sample="S", project="P", owner="owner")
    w.add("operation_data_files", operation_id="O")
    seen = lambda user, table: Directus(RULES, w, f"u_{user}").ids(table, "read")  # noqa: E731

    # a restricted project: its campaigns, samples, operations and tests are visible to people on its list
    assert seen("pi", "projects") == {"P"} and seen("viewer", "projects") == {"P"}
    assert seen("inv", "projects") == {
        "P"
    }, "the old investigators table is a list entry"
    assert seen("stranger", "projects") == set() and seen("owner", "projects") == set()
    assert seen("pi", "campaigns") == {"C"} and seen("stranger", "campaigns") == set()
    assert (
        seen("campaignOwner", "campaigns") == set()
    ), "the campaign owner is shut out of a restricted project"
    # the PI always sees everything; the owner keeps the sample (the owner exception), not the operation (strict gates)
    assert seen("pi", "physical_samples") == {"S"} and seen(
        "owner", "physical_samples"
    ) == {"S"}
    assert seen("pi", "manufacturing_operations") == {"O"} and seen(
        "pi", "test_sessions"
    ) == {"T"}
    assert (
        seen("owner", "manufacturing_operations") == set()
        and seen("owner", "test_sessions") == set()
    )
    assert seen("stranger", "physical_samples") == set()
    # people on the list who are not the PI see the project, not what is inside (they are not investigators)
    assert seen("viewer", "manufacturing_operations") == set()
    assert seen("inv", "manufacturing_operations") == {
        "O"
    }, "an investigator on the list reads the unrestricted contents"
    # attached rows follow the operation
    pi_files = Directus(RULES, w, "u_pi")
    assert [
        pi_files.can("operation_data_files", "read", r)
        for r in w.t["operation_data_files"]
    ] == [True]
    owner_files = Directus(RULES, w, "u_owner")
    assert [
        owner_files.can("operation_data_files", "read", r)
        for r in w.t["operation_data_files"]
    ] == [False]

    # a restricted campaign: its operations and tests are hidden; the samples are not hidden from their owner
    w2 = World()
    base_people(w2)
    w2.project("P", pi="pi")
    w2.investigator("P", "inv")
    w2.campaign("C", project="P", owner="campaignOwner", restricted=True)
    w2.campaign("C2", project="P", owner="campaignOwner")
    w2.sample("S", project="P", owner="owner")
    w2.sample("S2", owner="owner")
    w2.in_campaign("C", "S")
    w2.in_campaign("C", "S2")
    w2.in_campaign("C2", "S2")
    w2.op("OC", campaign="C", owner="owner")
    w2.op("OS", sample="S", owner="owner")
    w2.test("TC", campaign="C", owner="owner")
    seen2 = lambda user, table: Directus(RULES, w2, f"u_{user}").ids(table, "read")  # noqa: E731
    assert seen2("pi", "campaigns") == {"C", "C2"} and seen2(
        "campaignOwner", "campaigns"
    ) == {"C", "C2"}
    assert seen2("inv", "campaigns") == {
        "C2"
    }, "an investigator no longer reaches a restricted campaign"
    assert seen2("stranger", "campaigns") == set()
    assert seen2("pi", "manufacturing_operations") == {"OC", "OS"}
    assert seen2("campaignOwner", "manufacturing_operations") == {
        "OC",
        "OS",
    }, "OS inherits its sample, which the campaign owner reads"
    assert seen2("owner", "manufacturing_operations") == {
        "OS"
    }, "the owner of an operation in a restricted campaign is shut out"
    assert seen2("owner", "test_sessions") == set() and seen2(
        "campaignOwner", "test_sessions"
    ) == {"TC"}
    # a sample in a restricted campaign: its owner and the project's PI keep it, the investigator loses the inherited way
    assert seen2("owner", "physical_samples") == {"S", "S2"} and seen2(
        "pi", "physical_samples"
    ) == {"S", "S2"}
    assert seen2("inv", "physical_samples") == {
        "S",
        "S2",
    }, "S via the project, S2 via the open campaign C2"
    assert seen2("campaignOwner", "physical_samples") == {"S", "S2"}

    # a sample in two campaigns stays visible through any campaign that still lets the caller in
    w3 = World()
    base_people(w3)
    w3.project("P", pi="pi", restricted=True)
    w3.campaign("Cin", project="P", owner="campaignOwner")
    w3.campaign("Cout", owner="inv")
    w3.sample("S", owner="owner")
    w3.in_campaign("Cin", "S")
    w3.in_campaign("Cout", "S")
    seen3 = lambda user, table: Directus(RULES, w3, f"u_{user}").ids(table, "read")  # noqa: E731
    assert seen3("inv", "physical_samples") == {
        "S"
    }, "the owner of the open campaign Cout reaches it"
    assert (
        seen3("campaignOwner", "physical_samples") == set()
    ), "Cin hides behind the restricted project"
    assert seen3("pi", "physical_samples") == {
        "S"
    }, "the PI of a campaign's project always does"

    # an orphan FAST operation: readable by every member until it or the sample it hangs on is restricted
    w4 = World()
    base_people(w4)
    w4.sample("S", owner="owner", restricted=True)
    w4.op("orphan")
    w4.op("under", sample="S")
    seen4 = lambda user: Directus(RULES, w4, f"u_{user}").ids(  # noqa: E731
        "manufacturing_operations", "read"
    )
    assert seen4("stranger") == {
        "orphan"
    }, "the orphan is open, the operation on the restricted sample is not"
    assert seen4("owner") == {
        "orphan",
        "under",
    }, "the sample's list reads the operations under it"
    w4.t["manufacturing_operations"][0]["restricted"] = True
    assert seen4("stranger") == set() and seen4("owner") == {"under"}


def test_a_sample_restricted_operation_is_invisible_to_its_own_owner():
    w = World()
    base_people(w)
    w.sample("S", owner="owner", restricted=True)
    w.op("O", sample="S", owner="campaignOwner")
    w.test("T", sample="S", owner="campaignOwner")
    for table, key in (("manufacturing_operations", "O"), ("test_sessions", "T")):
        assert key not in Directus(RULES, w, "u_campaignOwner").ids(
            table, "read"
        )  # the operation's own owner
        assert key in Directus(RULES, w, "u_owner").ids(
            table, "read"
        )  # the sample's owner is on its list


def test_a_restricted_operation_is_seen_only_by_owner_list_and_pi():
    w = World()
    base_people(w)
    w.project("P", pi="pi")
    w.sample("S", owner="owner", project="P")
    w.op("O", sample="S", project="P", owner="campaignOwner", restricted=True)
    w.grant("operation", "O", "viewer", "view")
    seen = {
        u: Directus(RULES, w, f"u_{u}").ids("manufacturing_operations", "read")
        for u in PEOPLE
    }
    assert {u for u, ids in seen.items() if "O" in ids} == {
        "campaignOwner",
        "viewer",
        "pi",
    }


def test_rollup_pi_reads_every_row_investigators_only_unrestricted_ones():
    """project_rollup carries `restricted` (migration 167): the PI reads every row of the project, an investigator
    (old table or access role investigator) only the unrestricted ones, a Can view person or a stranger none."""
    w = World()
    base_people(w)
    w.project("P", pi="pi")
    w.investigator("P", "inv")
    w.grant("project", "P", "inv2", "investigator")
    w.grant("project", "P", "viewer", "view")
    w.add("project_rollup", project_id="P", restricted=False)
    w.add("project_rollup", project_id="P", restricted=True)
    open_row, hidden_row = w.t["project_rollup"]

    def readers(row):
        return {
            u
            for u in PEOPLE
            if Directus(RULES, w, f"u_{u}").can("project_rollup", "read", row)
        }

    assert readers(open_row) == {"pi", "inv", "inv2"}
    assert readers(hidden_row) == {"pi"}


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
        (("manufacturing_operations", "project_id"), "projects.operations"),
        (("sample_access", "sample_id"), "access"),
        (("project_access", "person_id"), "project_access.person_id"),
    ],
)
def test_resolver_reports_a_deleted_relation(dropped, needle):
    problems = gen.resolve(DOC, _directus(drop=[dropped]))
    assert problems and any(needle in p for p in problems), problems


def test_resolver_needs_the_alias_field_row_and_the_user_column():
    db = _directus()
    db["fields"].remove("projects.samples")
    assert any("projects.samples" in p for p in gen.resolve(DOC, db))
    db = _directus()
    db["columns"].remove("people.user_id")
    assert any("people.user_id is not a column" in p for p in gen.resolve(DOC, db))
    db = _directus()
    db["fields"].remove("physical_samples.access")
    assert any("physical_samples.access" in p for p in gen.resolve(DOC, db))


def test_resolver_reports_a_missing_restricted_column_a_missing_where_column_and_a_bad_alias():
    problems = gen.resolve(DOC, _directus(restricted=False))
    assert any("physical_samples.restricted is not a column" in p for p in problems)
    assert any(
        "orphan_amnesty manufacturing_operations" in p and "restricted" in p
        for p in problems
    )
    db = _directus()
    db["columns"].remove("project_access.role")
    assert any(
        "where project_access.role is not a column" in p for p in gen.resolve(DOC, db)
    )
    # `at` and `each` must name a to-many alias: here `campaign_id` (a to-one) is used as one
    bad = {**DOC, "sets": {**DOC["sets"], "bad": [{"path": "project_id.principal_investigator_person.user_id", "at": "project_id", "where": {"restricted": [True]}}]},
           "rules": {**DOC["rules"], "physical_samples": {**DOC["rules"]["physical_samples"], "read": "bad"}}}  # fmt: skip
    assert any("is not a to-many alias" in p for p in gen.resolve(bad, _directus()))
    bad = {**DOC, "sets": {**DOC["sets"], "bad": [{"each": "project_id", "items": ["principal_investigator_person.user_id"]}]},
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
