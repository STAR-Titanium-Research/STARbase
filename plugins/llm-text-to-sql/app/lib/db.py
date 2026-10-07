"""Read-only database access for the text-to-SQL layer.

Connects with ``LLM_DATABASE_URL`` — a DSN for a login role that inherits the
``d1_llm_readonly`` group role (see docs/runbooks/text-to-sql.md). That role is
``default_transaction_read_only`` with a statement timeout, so even a guard
bypass cannot mutate data or run a runaway query. We additionally pin each
transaction read-only here as belt-and-suspenders.
"""

import os

import psycopg
from psycopg.rows import dict_row

LLM_DATABASE_URL: str = os.getenv("LLM_DATABASE_URL", "")
# Per-connection statement timeout (ms). Enforced here rather than relying on the
# d1_llm_readonly role's setting, because role-level SET values are not inherited
# by member login roles (see docs/runbooks/text-to-sql.md).
STATEMENT_TIMEOUT_MS: int = int(os.getenv("LLM_STATEMENT_TIMEOUT_MS", "5000"))


def _connect() -> psycopg.Connection:
    """Open a connection pinned read-only with a statement timeout.

    Defence-in-depth on top of the d1_llm_readonly grants: even if the login
    role is mis-provisioned, this connection cannot write or run unbounded.
    """
    if not LLM_DATABASE_URL:
        raise RuntimeError("LLM_DATABASE_URL is not configured")
    conn = psycopg.connect(LLM_DATABASE_URL, row_factory=dict_row)
    conn.read_only = True
    # SET does not accept bind parameters; STATEMENT_TIMEOUT_MS is coerced to int.
    conn.execute(f"SET statement_timeout = {int(STATEMENT_TIMEOUT_MS)}")
    return conn


class QueryExecutionError(Exception):
    """A guarded query was rejected by Postgres at execution time.

    The SQL guard proves a statement is a read-only, allow-listed SELECT, but it
    cannot know whether every *column* the model referenced actually exists, or
    whether the query will exceed the statement timeout. Those surface here (e.g.
    a hallucinated column) and are the model's fault, not a server fault — so we
    raise a distinct error the API turns into a graceful message, not a 500.
    """


def run_select(sql: str) -> list[dict]:
    """Execute an already-guarded read-only query and return rows as dicts.

    Raises :class:`QueryExecutionError` on a database error (undefined column,
    statement timeout, …) so callers can respond gracefully instead of 500.
    """
    with _connect() as conn:
        with conn.cursor() as cur:
            try:
                cur.execute(sql)
                return cur.fetchall()
            except psycopg.Error as exc:
                # e.g. UndefinedColumn, QueryCanceled (timeout). Keep the primary
                # message; drop the multi-line CONTEXT/HINT noise psycopg appends.
                raise QueryExecutionError(str(exc).strip().splitlines()[0]) from exc


def fetch_query_targets() -> list[dict]:
    """Return the allow-listed views and their descriptions (the LLM menu)."""
    return run_select(
        "SELECT view_name, description FROM v_llm_query_targets ORDER BY view_name"
    )


def distinct_values(object_name: str, column: str, cap: int = 25) -> list | None:
    """Distinct non-null values of a column, or None if there are more than *cap*.

    Used to build the "known values" legend for low-cardinality categorical
    columns so the model filters on real strings (e.g. method_name = 'Turning')
    instead of guessing. Identifiers come from the schema dictionary (not user
    input) and are quoted. Returns None for high-cardinality or unreadable columns.
    """
    query = (
        f'SELECT DISTINCT "{column}" AS v FROM "{object_name}" '
        f'WHERE "{column}" IS NOT NULL ORDER BY 1 LIMIT {int(cap) + 1}'
    )
    try:
        rows = run_select(query)
    except Exception:  # noqa: BLE001 — best-effort legend, never break prompt build
        return None
    values = [r["v"] for r in rows]
    return None if len(values) > cap else values


def fetch_dictionary_all() -> list[dict]:
    """Return the full column dictionary for every documented object.

    Used to build the LLM prompt across all readable tables and views (the
    caller filters out denied/system objects). Ordered for stable grouping.

    Only objects this role can actually SELECT are returned, so the prompt never
    advertises a table the explicit grant list (migration
    20261003000132_llm_readonly_allow_list.sql) leaves out. ``to_regclass`` (not
    a bare name cast) because the planner may evaluate the filter before the
    view's own ``public`` filter, and a cast would raise for other schemas.
    """
    return run_select(
        """
        SELECT object_name, object_comment, column_name, data_type,
               column_comment, column_position
        FROM v_schema_dictionary
        WHERE has_table_privilege(
            to_regclass(format('public.%I', object_name)), 'SELECT'
        )
        ORDER BY object_name, column_position
        """
    )


def fetch_dictionary(views: list[str]) -> list[dict]:
    """Return the column dictionary rows for the given object names."""
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT object_name, object_comment, column_name, data_type,
                       column_comment
                FROM v_schema_dictionary
                WHERE object_name = ANY(%s)
                ORDER BY object_name, column_position
                """,
                (views,),
            )
            return cur.fetchall()


def semantic_search(query_embedding: list[float], limit: int = 5) -> list[dict]:
    """Return the note rows most similar to *query_embedding* (cosine distance)."""
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT source_table, source_id, source_column, content_text,
                       1 - (embedding <=> %s::vector) AS similarity
                FROM semantic_embeddings
                ORDER BY embedding <=> %s::vector
                LIMIT %s
                """,
                (query_embedding, query_embedding, limit),
            )
            return cur.fetchall()
