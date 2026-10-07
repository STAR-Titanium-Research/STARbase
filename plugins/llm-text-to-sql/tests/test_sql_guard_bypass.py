"""Regression tests for the guard bypasses in review finding 6.4.

Every case here must be REJECTED. They are kept apart from the allow/deny matrix
in test_sql_guard.py so a reader can see at a glance which known bypasses stay
closed. ``directus_future_secret`` stands in for a Directus table that a later
release adds: it is not in any explicit list, so only the per-scope AST check
(deny every ``directus_*``) stops it — the lexical safety net does not.
"""

import pytest
import sqlglot

from app.lib.sql_guard import (
    MAX_ROW_LIMIT,
    SqlGuardError,
    _referenced_tables,
    guard,
    message_only,
    normalise,
    validate,
)

BASE = "physical_samples"

CTE_SHADOWING = [
    # The cited bypass: a CTE of the same name in a nested scope used to exempt
    # the real table everywhere, because CTE names were collected tree-wide.
    (
        "cte_in_subquery_shadows_real_table_outside",
        f"SELECT * FROM {BASE}, "
        "(WITH directus_future_secret AS (SELECT 1 AS a) "
        " SELECT a FROM directus_future_secret) t, directus_future_secret",
    ),
    (
        "cte_in_where_subquery",
        f"SELECT * FROM {BASE} WHERE sample_id IN "
        "(WITH directus_future_secret AS (SELECT 1) SELECT 1 FROM directus_future_secret) "
        "AND sample_id IN (SELECT 1 FROM directus_future_secret)",
    ),
    (
        "cte_referring_to_itself_reads_the_real_table",
        "WITH directus_future_secret AS (SELECT * FROM directus_future_secret) "
        "SELECT * FROM directus_future_secret",
    ),
    (
        "cte_defined_after_use",
        "WITH a AS (SELECT * FROM directus_future_secret), "
        "directus_future_secret AS (SELECT 1) SELECT * FROM a",
    ),
    (
        "cte_in_union_branch_does_not_cover_the_other_branch",
        f"SELECT sample_id FROM {BASE} UNION "
        "(WITH directus_future_secret AS (SELECT 1) SELECT * FROM directus_future_secret) "
        "UNION SELECT * FROM directus_future_secret",
    ),
    (
        "quoted_cte_name_does_not_shadow_unquoted_table",
        'WITH "DIRECTUS_FUTURE_SECRET" AS (SELECT 1) '
        f"SELECT * FROM directus_future_secret, {BASE}",
    ),
    (
        "cte_named_like_a_denied_table",
        "WITH directus_users AS (SELECT 1) SELECT * FROM directus_users",
    ),
    (
        "cte_shadow_then_pg_authid",
        f"SELECT * FROM {BASE}, (WITH pg_authid AS (SELECT 1) SELECT * FROM pg_authid) t, "
        "pg_authid",
    ),
]

DANGEROUS_FUNCTIONS = [
    (
        "query_to_xml",
        "SELECT query_to_xml('select * from directus_users', true, false, '')",
    ),
    (
        "query_to_xml_and_xmlschema",
        "SELECT query_to_xml_and_xmlschema('select 1', true, false, '')",
    ),
    ("cursor_to_xml", "SELECT cursor_to_xml('c', 1, true, false, '')"),
    ("table_to_xml", "SELECT table_to_xml('audit_logs', true, false, '')"),
    ("table_to_xmlschema", "SELECT table_to_xmlschema('audit_logs', true, false, '')"),
    ("schema_to_xml", "SELECT schema_to_xml('public', true, false, '')"),
    ("database_to_xml", "SELECT database_to_xml(true, false, '')"),
    ("pg_read_file", "SELECT pg_read_file('/etc/passwd')"),
    ("pg_read_binary_file", "SELECT pg_read_binary_file('/etc/passwd')"),
    ("pg_ls_dir", "SELECT pg_ls_dir('/')"),
    ("pg_stat_file", "SELECT pg_stat_file('/etc/passwd')"),
    ("lo_import", "SELECT lo_import('/etc/passwd')"),
    ("lo_get", "SELECT lo_get(1)"),
    ("dblink", "SELECT dblink('host=evil', 'select 1')"),
    ("dblink_exec", "SELECT dblink_exec('host=evil', 'select 1')"),
    ("set_config", "SELECT set_config('default_transaction_read_only', 'off', false)"),
    ("pg_sleep", "SELECT pg_sleep(30)"),
    ("pg_sleep_for", "SELECT pg_sleep_for('1 hour')"),
    ("pg_terminate_backend", "SELECT pg_terminate_backend(1)"),
    ("pg_cancel_backend", "SELECT pg_cancel_backend(1)"),
    ("pg_advisory_lock", "SELECT pg_advisory_lock(1)"),
    ("pg_advisory_xact_lock", "SELECT pg_advisory_xact_lock(1)"),
    ("txid_current", "SELECT txid_current()"),
    ("current_setting", "SELECT current_setting('server_version')"),
    ("pg_catalog_qualified", "SELECT pg_catalog.pg_read_file('/etc/passwd')"),
    ("quoted_name", "SELECT \"pg_read_file\"('/etc/passwd')"),
    ("upper_case", "SELECT PG_READ_FILE('/etc/passwd')"),
    ("nextval", "SELECT nextval('some_seq')"),
    ("refresh_project_rollup", "SELECT refresh_project_rollup()"),
]

LOCKING = [
    ("for_update", f"SELECT * FROM {BASE} FOR UPDATE"),
    ("for_share", f"SELECT * FROM {BASE} FOR SHARE"),
    ("for_update_nowait", f"SELECT * FROM {BASE} FOR UPDATE NOWAIT"),
    ("for_update_skip_locked", f"SELECT * FROM {BASE} FOR UPDATE SKIP LOCKED"),
    ("for_no_key_update", f"SELECT * FROM {BASE} FOR NO KEY UPDATE"),
    ("for_key_share", f"SELECT * FROM {BASE} FOR KEY SHARE"),
    ("for_update_of", f"SELECT * FROM {BASE} p FOR UPDATE OF p"),
    (
        "for_update_in_subquery",
        f"SELECT * FROM {BASE} WHERE sample_id IN "
        f"(SELECT sample_id FROM {BASE} FOR UPDATE)",
    ),
]

FUNCTION_IN_FROM = [
    ("dblink_in_from", f"SELECT * FROM {BASE}, dblink('x', 'select 1') AS t(a int)"),
    ("scalar_function_as_table", f"SELECT * FROM {BASE}, lower('X') AS t"),
    (
        "lateral_json_each",
        f"SELECT * FROM {BASE} p CROSS JOIN LATERAL jsonb_each(p.metadata) e",
    ),
    (
        "jsonb_array_elements",
        f"SELECT * FROM {BASE}, jsonb_array_elements('[]'::jsonb)",
    ),
    ("pg_ls_dir_in_from", "SELECT * FROM pg_ls_dir('/')"),
    ("rows_from", "SELECT * FROM ROWS FROM (generate_series(1, 2), pg_sleep(1))"),
    (
        "unnest_of_dangerous_call",
        f"SELECT * FROM {BASE}, unnest(string_to_array(pg_read_file('x'), ','))",
    ),
    ("schema_qualified_srf", f"SELECT * FROM {BASE}, public.generate_series(1, 3)"),
]

LEXICAL_TRICKS = [
    # Postgres nests block comments; sqlglot does not. PG reads ", directus_users"
    # as live code, a non-nesting lexer reads it as comment (or errors).
    (
        "nested_comment_hides_nothing",
        f"SELECT 1 FROM {BASE} /* outer /* inner */ */ , directus_users",
    ),
    ("unterminated_comment", f"SELECT 1 FROM {BASE} /* never closed"),
    ("dollar_quoted_string", f"SELECT $$ x $$ FROM {BASE}"),
    (
        "tagged_dollar_quote",
        f"SELECT $tag$ ' $tag$ FROM {BASE}, directus_future_secret",
    ),
    (
        "dollar_quote_swallows_quote",
        f"SELECT $$'$$, a FROM {BASE}, directus_future_secret WHERE b = $$'$$",
    ),
    ("e_string", f"SELECT E'abc' FROM {BASE}"),
    ("lower_e_string", f"SELECT e'abc' FROM {BASE}"),
    (
        "e_string_backslash_quote",
        f"SELECT E'a\\'', 1 FROM {BASE}, directus_future_secret WHERE x = E'\\''",
    ),
    ("unicode_escape_string", f"SELECT U&'d\\0061ta' FROM {BASE}"),
    (
        "backslash_in_plain_string",
        f"SELECT 'a\\' FROM {BASE}, directus_future_secret --'",
    ),
    ("backslash_outside_string", f"SELECT 1 FROM {BASE} \\g"),
    ("nul_byte", f"SELECT 1 FROM {BASE}\x00, directus_future_secret"),
    ("unterminated_string", f"SELECT 'abc FROM {BASE}"),
    ("unterminated_identifier", f'SELECT 1 FROM "{BASE}'),
    (
        "stacked_after_comment",
        f"SELECT 1 FROM {BASE} -- x\n; SELECT 1 FROM directus_users",
    ),
    (
        "table_shorthand_in_subquery",
        "SELECT * FROM (TABLE directus_future_secret) t, " + BASE,
    ),
    (
        "table_shorthand_in_cte",
        f"WITH x AS (TABLE directus_future_secret) SELECT * FROM x, {BASE}",
    ),
    ("table_shorthand_scalar", f"SELECT (TABLE directus_future_secret) FROM {BASE}"),
]

RELATION_QUALIFIERS = [
    ("other_schema", f"SELECT * FROM other_schema.{BASE}"),
    ("pg_temp", f"SELECT * FROM pg_temp.{BASE}"),
    ("catalog_qualified", f"SELECT * FROM somedb.public.{BASE}"),
    ("quoted_denied", 'SELECT * FROM "public"."audit_logs"'),
    ("denied_with_alias", "SELECT a.* FROM audit_logs AS a"),
    ("denied_with_only", "SELECT * FROM ONLY audit_logs"),
    ("denied_in_exists", f"SELECT 1 FROM {BASE} WHERE EXISTS (SELECT 1 FROM people)"),
    (
        "denied_in_scalar_subquery",
        f"SELECT (SELECT count(*) FROM audit_logs) FROM {BASE}",
    ),
    (
        "denied_in_limit",
        f"SELECT * FROM {BASE} LIMIT (SELECT count(*) FROM directus_future_secret)",
    ),
    ("unknown_directus_prefix", f"SELECT * FROM {BASE}, directus_future_secret"),
]


@pytest.mark.parametrize("name,sql", CTE_SHADOWING, ids=[c[0] for c in CTE_SHADOWING])
def test_cte_shadowing_is_per_scope(name, sql):
    with pytest.raises(SqlGuardError):
        validate(sql)


@pytest.mark.parametrize(
    "name,sql", DANGEROUS_FUNCTIONS, ids=[c[0] for c in DANGEROUS_FUNCTIONS]
)
def test_dangerous_functions_rejected(name, sql):
    # Give the statement a table so only the function can be the reason.
    with pytest.raises(SqlGuardError):
        validate(f"{sql.rstrip(';')} FROM {BASE}")


@pytest.mark.parametrize("name,sql", LOCKING, ids=[c[0] for c in LOCKING])
def test_locking_clauses_rejected(name, sql):
    with pytest.raises(SqlGuardError):
        validate(sql)


@pytest.mark.parametrize(
    "name,sql", FUNCTION_IN_FROM, ids=[c[0] for c in FUNCTION_IN_FROM]
)
def test_functions_in_from_rejected(name, sql):
    with pytest.raises(SqlGuardError):
        validate(sql)


@pytest.mark.parametrize("name,sql", LEXICAL_TRICKS, ids=[c[0] for c in LEXICAL_TRICKS])
def test_lexical_tricks_rejected(name, sql):
    with pytest.raises(SqlGuardError):
        validate(sql)


@pytest.mark.parametrize(
    "name,sql", RELATION_QUALIFIERS, ids=[c[0] for c in RELATION_QUALIFIERS]
)
def test_relation_qualifiers_rejected(name, sql):
    with pytest.raises(SqlGuardError):
        validate(sql)


def test_cte_names_resolve_per_scope():
    """Direct check of the scope logic: only the CTE's own query sees its name."""
    tree = sqlglot.parse_one(
        "SELECT * FROM a, (WITH a AS (SELECT 1) SELECT * FROM a) t", read="postgres"
    )
    # The outer ``a`` is a real table; the inner ``a`` is the CTE.
    assert _referenced_tables(tree) == {"a"}

    tree = sqlglot.parse_one(
        "WITH a AS (SELECT 1) SELECT * FROM a, (SELECT * FROM a) t", read="postgres"
    )
    assert _referenced_tables(tree) == set()  # CTE visible in nested scopes

    tree = sqlglot.parse_one(
        "WITH a AS (SELECT * FROM a) SELECT * FROM a", read="postgres"
    )
    assert _referenced_tables(tree) == {"a"}  # non-recursive: not visible to itself

    tree = sqlglot.parse_one(
        "WITH RECURSIVE a AS (SELECT 1 UNION ALL SELECT * FROM a) SELECT * FROM a",
        read="postgres",
    )
    assert _referenced_tables(tree) == set()  # recursive: visible to itself


def test_nested_comment_is_stripped_like_postgres():
    assert normalise("SELECT 1 /* a /* b */ c */ FROM t") == "SELECT 1   FROM t"


def test_nested_comment_that_closes_late_stays_a_comment():
    # Postgres reads the whole tail as ONE comment; so must we, or the validated
    # text and the executed text would differ.
    sql = f"SELECT 1 FROM {BASE} /* /* */ , directus_future_secret /* */ */"
    assert normalise(sql) == f"SELECT 1 FROM {BASE}"
    validate(sql)


def test_normalise_keeps_strings_intact():
    assert normalise("SELECT 'a -- b /* c */ ; d' FROM t;") == (
        "SELECT 'a -- b /* c */ ; d' FROM t"
    )


def test_guard_revalidates_and_clamps_the_limit():
    wrapped = guard("SELECT * FROM v_complete_sample_history", row_limit=10**9)
    assert wrapped.strip().endswith(f"LIMIT {MAX_ROW_LIMIT}")
    with pytest.raises(SqlGuardError):
        guard("SELECT * FROM v_complete_sample_history", row_limit=0)
    with pytest.raises(SqlGuardError):
        guard("SELECT * FROM v_complete_sample_history", row_limit=-5)


def test_guard_strips_comments_from_what_it_executes():
    wrapped = guard("SELECT * FROM v_complete_sample_history -- hi\n")
    assert "--" not in wrapped
    assert wrapped.strip().endswith("LIMIT 200")


def test_message_only_never_accepts_a_function_call():
    assert message_only("SELECT 'hi' AS note") == "hi"
    assert message_only("SELECT 'hi' AS note, pg_sleep(60)") is None
    assert message_only("SELECT 'hi' AS note /* /* */ */") == "hi"
