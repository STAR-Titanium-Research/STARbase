"""SQL-guard tests — the security-critical allow/deny matrix.

If any DENY case starts passing validation, the injection boundary is broken.
"""

import pytest

from app.lib.sql_guard import (
    DEFAULT_ROW_LIMIT,
    SqlGuardError,
    guard,
    message_only,
    validate,
)

ALLOW = [
    "SELECT * FROM v_complete_sample_history",
    "SELECT mass_grams FROM v_complete_sample_history WHERE mass_grams > 10",
    "select count(*) from v_test_sessions_full",
    "SELECT * FROM v_complete_sample_history WHERE sample_code = 'a' LIMIT 5",
    # Base tables are now readable (broad read surface, ADR-0009 revisited).
    "SELECT * FROM physical_samples",
    "SELECT machining_feed_mm_per_rev, machining_spindle_speed_rpm "
    "FROM manufacturing_operations WHERE machining_feed_mm_per_rev IS NOT NULL",
    # Ordinary scalar / aggregate / window functions.
    "SELECT lower(sample_code), count(*), date_trunc('month', created_at), "
    "string_agg(sample_code, ',') FROM physical_samples GROUP BY 1, 3",
    "SELECT sample_code, row_number() OVER (ORDER BY mass_grams), "
    "round(avg(mass_grams), 2) OVER () FROM physical_samples",
    "SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY mass_grams) "
    "FROM physical_samples",
    "SELECT coalesce(notes, ''), CAST(mass_grams AS int), mass_grams::text, now() "
    "FROM physical_samples WHERE created_at > now() - interval '30 days'",
    "SELECT count(*) FILTER (WHERE mass_grams > 1) FROM physical_samples",
    # generate_series / unnest are the only set-returning functions in FROM.
    "SELECT s.n, p.sample_code FROM generate_series(1, 3) AS s(n), physical_samples p",
    "SELECT p.sample_code, u.x FROM physical_samples p "
    "CROSS JOIN unnest(ARRAY[1, 2]) AS u(x)",
    # A CTE shadowing nothing real is fine, and a CTE may reference an earlier CTE.
    "WITH a AS (SELECT sample_id FROM physical_samples), "
    "b AS (SELECT sample_id FROM a) SELECT * FROM b",
    "WITH RECURSIVE r AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM r WHERE n < 3) "
    "SELECT r.n, p.sample_code FROM r, physical_samples p",
    # Comments are stripped; a string containing ; or -- or E is just a string.
    "SELECT sample_code FROM physical_samples /* note */ -- trailing\n",
    "SELECT 'a;b -- not a comment /* nor this */' FROM physical_samples",
    "SELECT 'e' FROM physical_samples",
    # CTE + base table.
    "WITH heavy AS (SELECT sample_id FROM physical_samples) "
    "SELECT * FROM v_manufacturing_operations_full "
    "WHERE sample_id IN (SELECT sample_id FROM heavy)",
    # UNION across a view and a base table.
    "SELECT sample_code FROM v_complete_sample_history "
    "UNION SELECT sample_code FROM physical_samples",
    # Join a base table to a view (the feed/speed use case).
    "SELECT o.machining_feed_mm_per_rev FROM manufacturing_operations o "
    "JOIN v_complete_sample_history v ON v.sample_id = o.sample_id",
    "SELECT * FROM v_complete_sample_history;",  # single trailing semicolon ok
]

DENY = [
    ("empty", ""),
    ("whitespace", "   "),
    ("insert", "INSERT INTO physical_samples (sample_code) VALUES ('x')"),
    ("update", "UPDATE physical_samples SET notes = 'x'"),
    ("delete", "DELETE FROM physical_samples"),
    ("drop", "DROP TABLE physical_samples"),
    ("create", "CREATE TABLE evil (id int)"),
    ("alter", "ALTER TABLE physical_samples ADD COLUMN x int"),
    ("grant", "GRANT ALL ON physical_samples TO public"),
    ("truncate", "TRUNCATE physical_samples"),
    ("copy", "COPY physical_samples TO '/tmp/x'"),
    ("select_into", "SELECT * INTO evil FROM v_complete_sample_history"),
    ("stacked", "SELECT 1 FROM v_complete_sample_history; DROP TABLE physical_samples"),
    (
        "stacked_update",
        "SELECT 1 FROM v_test_sessions_full; UPDATE physical_samples SET notes='x'",
    ),
    # Credential / auth / system relations are denied even for read.
    ("directus_users", "SELECT * FROM directus_users"),
    ("directus_sessions", "SELECT token FROM directus_sessions"),
    ("directus_settings", "SELECT ai_openai_api_key FROM directus_settings"),
    ("directus_flows", "SELECT * FROM directus_flows"),
    ("directus_operations", "SELECT * FROM directus_operations"),
    ("directus_permissions", "SELECT * FROM directus_permissions"),
    ("schema_migrations", "SELECT * FROM schema_migrations"),
    # Unknown/future directus_* is denied by default.
    ("unknown_directus", "SELECT * FROM directus_super_secret"),
    ("comment_hidden_secret", "SELECT * FROM /* */ directus_users"),
    (
        "mixed_allow_and_secret",
        "SELECT * FROM v_complete_sample_history, directus_users",
    ),
    ("cte_then_secret", "WITH x AS (SELECT 1) SELECT * FROM directus_sessions"),
    (
        "join_to_secret",
        "SELECT v.sample_code FROM v_complete_sample_history v "
        "JOIN directus_users u ON true",
    ),
    # Audit log, personal data, and every directus_* table (activity/revisions
    # embed other tables' rows) are denied even though they once were readable.
    ("audit_logs", "SELECT * FROM audit_logs"),
    ("audit_logs_schema_qualified", "SELECT * FROM public.audit_logs"),
    (
        "audit_logs_in_subquery",
        "SELECT * FROM v_test_sessions_full WHERE x IN "
        "(SELECT record_id FROM audit_logs)",
    ),
    ("people", "SELECT email FROM people"),
    ("machine_operators_quoted", 'SELECT * FROM "Machine_Operators"'),
    ("machine_operators_lower", "SELECT * FROM machine_operators"),
    ("directus_activity", "SELECT collection FROM directus_activity"),
    ("directus_revisions", "SELECT data FROM directus_revisions"),
    ("semantic_embeddings", "SELECT content_text FROM semantic_embeddings"),
    # Postgres system catalogs stay blocked.
    ("information_schema", "SELECT * FROM information_schema.tables"),
    ("pg_catalog", "SELECT * FROM pg_catalog.pg_roles"),
    ("pg_authid", "SELECT * FROM pg_authid"),
]


@pytest.mark.parametrize("sql", ALLOW)
def test_allowed_queries_pass(sql):
    validate(sql)  # must not raise


@pytest.mark.parametrize("name,sql", DENY, ids=[d[0] for d in DENY])
def test_disallowed_queries_rejected(name, sql):
    with pytest.raises(SqlGuardError):
        validate(sql)


def test_guard_wraps_with_limit():
    wrapped = guard("SELECT * FROM v_complete_sample_history", row_limit=50)
    assert wrapped.strip().endswith("LIMIT 50")
    assert "v_complete_sample_history" in wrapped


def test_guard_probe_fetches_one_extra_row():
    wrapped = guard("SELECT * FROM v_complete_sample_history", row_limit=50, probe=True)
    assert wrapped.strip().endswith("LIMIT 51")


def test_guard_default_limit():
    wrapped = guard("SELECT * FROM v_test_sessions_full")
    assert f"LIMIT {DEFAULT_ROW_LIMIT}" in wrapped


def test_guard_rejects_before_wrapping():
    with pytest.raises(SqlGuardError):
        guard("DELETE FROM physical_samples")


def test_row_limit_is_integer_only():
    # A non-numeric limit must not flow into the SQL string.
    with pytest.raises(ValueError):
        guard("SELECT * FROM v_test_sessions_full", row_limit="5; DROP TABLE x")


# --- message-only detection (greetings / off-topic -> plain reply) ---


def test_message_only_returns_text_for_table_free_select():
    assert message_only("SELECT 'hi there' AS note") == "hi there"
    assert message_only("SELECT 'hi there' AS note;") == "hi there"


def test_message_only_none_for_real_query():
    assert message_only("SELECT count(*) FROM v_complete_sample_history") is None


def test_message_only_none_for_unsafe_or_stacked():
    assert message_only("DELETE FROM physical_samples") is None
    assert message_only("SELECT 'x' AS note; DROP TABLE physical_samples") is None
    assert message_only("") is None
