"""ADR-0011 row-level visibility: scripts/access_rules.json, its generator and the script block.

Pure checks run everywhere. The database checks need a migrated Postgres (DATABASE_URL and psql);
they skip otherwise (the CI job sets REQUIRE_DB_TESTS=1, so a skip there fails the job).
tests/phase1_schema.sh also resolves every rule path against the Directus metadata that the
configure_*.sql scripts leave behind.
"""

import importlib.util
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"
spec = importlib.util.spec_from_file_location(
    "gen_access_rules", SCRIPTS / "gen_access_rules.py"
)
gen = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gen)

DOC = gen.load()
ROWS = gen.build_rows(DOC)
BY_KEY = {(r["collection"], r["action"]): r for r in ROWS}

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


def test_every_leaf_matches_the_signed_in_user():
    def leaves(node):
        if isinstance(node, dict):
            for key, value in node.items():
                if key == "_eq":
                    yield value
                else:
                    yield from leaves(value)
        elif isinstance(node, list):
            for item in node:
                yield from leaves(item)

    for row in ROWS:
        assert set(leaves(row["permissions"])) <= {"$CURRENT_USER"}, row["collection"]


def test_update_and_delete_are_narrower_than_read():
    """Owner decision 4: PI and investigator access through a project is read-only."""
    for collection in (
        "physical_samples",
        "manufacturing_operations",
        "test_sessions",
        "campaigns",
    ):
        for action in ("update", "delete"):
            text = json.dumps(BY_KEY[(collection, action)]["permissions"])
            assert "principal_investigator_person" not in text, (collection, action)
            assert "secondary_investigators" not in text, (collection, action)
    assert "co_owners" not in json.dumps(
        BY_KEY[("physical_samples", "delete")]["permissions"]
    )
    assert "co_owners" in json.dumps(
        BY_KEY[("physical_samples", "update")]["permissions"]
    )
    # operations and tests: the owner of the record, or an owner / co-owner of the sample
    update = json.dumps(BY_KEY[("manufacturing_operations", "update")]["permissions"])
    assert "sample_id" in update and "co_owners" in update
    delete = BY_KEY[("manufacturing_operations", "delete")]["permissions"]
    assert delete == {"owner_person_id": {"user_id": {"_eq": "$CURRENT_USER"}}}
    # projects: the PI alone
    pi = {"principal_investigator_person": {"user_id": {"_eq": "$CURRENT_USER"}}}
    assert BY_KEY[("projects", "update")]["permissions"] == pi
    assert BY_KEY[("projects", "delete")]["permissions"] == pi


def test_project_rollup_is_for_pi_and_investigators_only():
    paths = _paths("project_rollup", "read")
    assert paths == [
        "project_id.principal_investigator_person.user_id",
        "project_id.secondary_investigators._some.user_id",
    ]


def test_set_cycles_and_unknown_sets_are_rejected():
    with pytest.raises(gen.RulesError):
        gen.expand({"a": [{"set": "a"}]}, "a")
    with pytest.raises(gen.RulesError):
        gen.expand({"a": [{"set": "missing"}]}, "a")
    with pytest.raises(gen.RulesError):
        gen.build_rows(
            {**DOC, "rules": {"physical_samples": {"create": "sample.read"}}}
        )


def test_path_filter_shape():
    assert gen.path_filter("co_owners._some.user_id") == {
        "co_owners": {"_some": {"user_id": {"_eq": "$CURRENT_USER"}}}
    }


@pytest.mark.parametrize("collection,action,paths", list(_rule_paths()))
def test_every_path_ends_at_a_user_column(collection, action, paths):
    for path in paths:
        tail = ".".join([p for p in path.split(".") if p != "_some"][-2:])
        assert tail in PATH_TAILS, f"{collection}.{action}: {path}"


# -- what the rules must say (owner decisions of 2026-10-07) ----------------------------------


def test_pi_reaches_records_through_the_project_campaigns():
    pi = "campaign_id.project_id.principal_investigator_person.user_id"
    inv = "campaign_id.project_id.secondary_investigators._some.user_id"
    for collection in ("manufacturing_operations", "test_sessions"):
        paths = _paths(collection, "read")
        assert pi in paths and inv in paths, collection
    sample = _paths("physical_samples", "read")
    assert (
        "campaigns._some.campaign_id.project_id.principal_investigator_person.user_id"
        in sample
    )
    assert (
        "campaigns._some.campaign_id.project_id.secondary_investigators._some.user_id"
        in sample
    )
    # still read-only: no update or delete filter goes through a project
    for collection in ("physical_samples", "manufacturing_operations", "test_sessions"):
        for action in ("update", "delete"):
            assert "project" not in json.dumps(
                BY_KEY[(collection, action)]["permissions"]
            ), (collection, action)


def test_project_read_includes_owners_of_its_operations_and_tests():
    paths = _paths("projects", "read")
    assert "operations._some.owner_person_id.user_id" in paths
    assert "sessions._some.owner_person_id.user_id" in paths


def test_people_rows_close_the_relink_takeover():
    """A member must not be able to attach a login to someone else's People row."""
    assert ("people", "delete") not in BY_KEY, "people delete is for admins only"
    assert BY_KEY[("people", "read")]["permissions"] == {}
    update = BY_KEY[("people", "update")]
    assert update["fields"] != "*"
    assert "user_id" not in update["fields"].split(",")
    assert "full_name" in update["fields"].split(",")
    create = BY_KEY[("people", "create")]
    assert create["validation"] == {
        "_or": [{"user_id": {"_null": True}}, {"user_id": {"_eq": "$CURRENT_USER"}}]
    }
    assert create["fields"] == "*"


def test_custom_rows_are_applied_by_the_migration_and_marked_ruled():
    assert "people" in gen.ruled_collections(DOC)
    values = gen.migration_values(ROWS, gen.ruled_collections(DOC))
    assert "('people', 'update'," in values and "('people', 'delete'," not in values


def test_custom_create_cannot_carry_a_filter_and_unknown_keys_are_rejected():
    bad = {**DOC, "custom": {"people": {"create": {"permissions": {"a": 1}}}}}
    with pytest.raises(gen.RulesError):
        gen.build_rows(bad)
    bad = {**DOC, "custom": {"people": {"read": {"filter": {}}}}}
    with pytest.raises(gen.RulesError):
        gen.build_rows(bad)


def test_guards_cover_every_junction_that_grants_visibility():
    """Any junction a read path goes through must be guarded (create is never filtered)."""
    grants = set()
    for _c, _a, paths in _rule_paths():
        for path in paths:
            if "co_owners" in path:
                grants.add("sample_co_owners")
            if "secondary_investigators" in path:
                grants.add("project_investigators")
            parts = path.split(".")
            # test_sessions.sample_id is derived from the first sample of the test_sessions_subject
            # junction (migration 139), so a read path through it is a junction grant too
            if _c == "test_sessions" and parts[0] == "sample_id":
                grants.add("test_sessions_subject")
            # `campaigns._some.campaign_id` on a sample, `samples._some.sample_id` on a campaign
            for a, b in zip(parts, parts[2:]):
                if (a, b) in (("campaigns", "campaign_id"), ("samples", "sample_id")):
                    grants.add("campaign_samples")
    assert grants == set(DOC["guards"])
    rules = gen.hook_rules(DOC)["guards"]
    assert set(rules) == set(DOC["guards"])
    assert [c["parent"] for c in rules["campaign_samples"]] == [
        "campaigns",
        "physical_samples",
    ]
    assert [c["parent"] for c in rules["sample_co_owners"]] == ["physical_samples"]
    assert [c["parent"] for c in rules["project_investigators"]] == ["projects"]
    assert [c["parent"] for c in rules["test_sessions_subject"]] == ["test_sessions"]
    # the filter shipped to the hook is the parent's update row, word for word
    for junction, checks in rules.items():
        for c in checks:
            assert c["filter"] == BY_KEY[(c["parent"], "update")]["permissions"], (
                junction,
                c,
            )


def test_hook_rules_file_is_current_and_drift_is_detected(tmp_path):
    assert gen.HOOK_RULES_FILE.read_text(encoding="utf-8") == gen.hook_rules_text(DOC)
    stale = tmp_path / "rules.json"
    stale.write_text("{}", encoding="utf-8")
    assert gen.main(["--check", "--hook-rules", str(stale)]) == 1
    stale.write_text(gen.hook_rules_text(DOC), encoding="utf-8")
    assert gen.main(["--check", "--hook-rules", str(stale)]) == 0


def test_owner_guards_cover_every_record_whose_update_is_wider_than_delete():
    """An editor who changes the owner column would gain delete, so each such record is guarded."""
    wider = {
        c
        for c, actions in DOC["rules"].items()
        if "update" in actions
        and "delete" in actions
        and BY_KEY[(c, "update")]["permissions"] != BY_KEY[(c, "delete")]["permissions"]
    }
    guards = gen.hook_rules(DOC)["ownerGuards"]
    assert wider == set(DOC["owner_guards"]) == set(guards)
    assert wider == {"physical_samples", "manufacturing_operations", "test_sessions"}
    for collection, g in guards.items():
        assert g["field"] == "owner_person_id"
        # the filter shipped to the hook is the record's delete row, word for word
        assert g["filter"] == BY_KEY[(collection, "delete")]["permissions"], collection


def test_a_wider_update_rule_without_an_owner_guard_is_rejected():
    doc = {**DOC, "owner_guards": {}}
    with pytest.raises(gen.RulesError, match="owner_guards"):
        gen.hook_rules(doc)


def test_owner_guard_needs_update_and_delete_filters():
    doc = {
        **DOC,
        "owner_guards": {
            **DOC["owner_guards"],
            "fast_run_data": {"field": "x", "key": "y", "value_key": "z"},
        },
    }
    with pytest.raises(gen.RulesError, match="fast_run_data"):
        gen.hook_rules(doc)


def test_resolver_checks_the_owner_guards_too():
    db = _directus()
    db["columns"].remove("test_sessions.session_id")
    assert any("owner_guard test_sessions" in p for p in gen.resolve(DOC, db))
    db = _directus()
    db["columns"].remove("people.person_id")
    assert any("owner_guard" in p and "person_id" in p for p in gen.resolve(DOC, db))


def test_guard_rejects_a_parent_without_an_update_filter():
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


# -- the path resolver (phase1_schema.sh runs it on the real Directus metadata) ----------------


def _directus(drop=()):
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
    for t, f, one in [
        ("sample_stock_provenance", "sample_id", "physical_samples"),
        ("sample_data_files", "sample_id", "physical_samples"),
        ("sample_genealogy", "child_sample_id", "physical_samples"),
        ("sample_genealogy", "parent_sample_id", "physical_samples"),
        ("operation_data_files", "operation_id", "manufacturing_operations"),
        ("machining_force_analysis", "operation_id", "manufacturing_operations"),
        ("fast_run_data", "operation_id", "manufacturing_operations"),
        ("session_data_files", "session_id", "test_sessions"),
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


def test_resolver_checks_the_guards_too():
    db = _directus()
    db["columns"].remove("sample_co_owners.sample_id")
    assert any("guard sample_co_owners.sample_id" in p for p in gen.resolve(DOC, db))


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
        target = _psql(
            "SELECT confrelid::regclass::text FROM pg_constraint WHERE contype = 'f' "
            f"AND conrelid = 'public.{collection}'::regclass "
            f"AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.{collection}'::regclass AND attname = '{g['field']}')]"
        )
        assert pk(target) == g["value_key"], (collection, target)


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
