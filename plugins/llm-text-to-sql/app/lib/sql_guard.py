"""SQL guard — the injection boundary for LLM-generated SQL.

The text-to-SQL flow lets a local LLM author SQL from a natural-language
question. That SQL is *never* trusted. This module is the first of two layers;
the second is the ``d1_llm_readonly`` Postgres role, which holds ``SELECT`` on an
explicit allow-list of lab tables and views only (ADR-0009, migration
``20261003000132_llm_readonly_allow_list.sql``). Either layer failing alone must
not leak data.

  0. The raw text is lexed the way Postgres lexes it: comments (including nested
     ``/* /* */ */`` ones) are stripped, and anything sqlglot and Postgres could
     read differently — dollar quoting, ``E''`` / ``U&''`` strings, backslashes —
     is rejected. What is validated is then exactly what is executed.
  1. The statement must parse as exactly **one** SQL statement.
  2. It must be a read-only ``SELECT`` (optionally a ``WITH ... SELECT``). Any
     DML/DDL/utility node is rejected, and so is any locking clause
     (``FOR UPDATE`` / ``FOR SHARE``).
  3. Every function call must be on the function allow-list below. This is what
     stops ``pg_read_file``, ``query_to_xml`` (a SQL-in-a-string table reader),
     ``set_config``, ``pg_sleep``, ``dblink``, ``lo_*`` and friends. The only
     functions allowed in ``FROM`` are ``generate_series`` and ``unnest``.
  4. It must not reference a **denied** relation: credential/secret tables, the
     audit log, personal data, every ``directus_*`` table, and the system
     catalogs. CTE names are resolved *per scope*, so a CTE only hides a name
     inside its own query, never elsewhere.
  5. A ``LIMIT`` is enforced by wrapping the query, so a model that forgets one
     cannot stream an unbounded result set.

Parsing is done with sqlglot (a real SQL parser), not regexes, so comment- and
whitespace-based evasion does not work.
"""

from __future__ import annotations

import re

import sqlglot
from sqlglot import exp

# The curated, denormalised views the prompt features first — the easy path for a
# small model. Not the security gate (base tables are readable too); the gates are
# the deny-list below and the role's explicit grants.
ALLOWED_RELATIONS: frozenset[str] = frozenset(
    {
        "v_complete_sample_history",
        "v_tooling_hierarchy",
        "v_sample_genealogy_flat",
        "v_manufacturing_operations_full",
        "v_stock_provenance",
        "v_test_sessions_full",
        "v_schema_dictionary",
        "v_llm_query_targets",
    }
)

# Relations the LLM may NEVER read. Mirrors what migration
# 20261003000132_llm_readonly_allow_list.sql leaves OFF the role's grant list —
# keep the two in sync. Names are lower-case; comparison is case-insensitive.
DENIED_RELATIONS: frozenset[str] = frozenset(
    {
        # audit trail (full row JSON of every change) and personal data
        "audit_logs",
        "people",
        "machine_operators",
        "archive_metadata_edits",
        # control/state rows for host daemons
        "force_crawler_state",
        # plugin-internal: read by /api/search under the role, not by LLM SQL
        "semantic_embeddings",
        "v_embeddings_source_notes",
        # migration bookkeeping
        "schema_migrations",
    }
)

# Every ``directus_*`` relation is denied (credentials, auth model, activity and
# revisions that embed other tables' rows, flows with API keys, and any future
# system table). Deny-by-default; there is no allow-list of Directus metadata.
DENIED_PREFIXES: tuple[str, ...] = ("directus_", "pg_")

# Directus system tables by exact name. Only used by the lexical safety net in
# ``normalise`` (a column such as ``directus_files_id`` is legitimate, so the
# net cannot use the ``directus_`` prefix); the AST check denies the whole prefix.
DIRECTUS_SYSTEM_TABLES: frozenset[str] = frozenset(
    "directus_" + name
    for name in (
        "access",
        "activity",
        "collections",
        "comments",
        "dashboards",
        "deployments",
        "extensions",
        "fields",
        "files",
        "flows",
        "folders",
        "migrations",
        "notifications",
        "operations",
        "panels",
        "permissions",
        "policies",
        "presets",
        "relations",
        "revisions",
        "roles",
        "sessions",
        "settings",
        "shares",
        "translations",
        "users",
        "versions",
    )
)

# Only these schemas may be named explicitly; ``public`` is the lab schema.
ALLOWED_SCHEMAS: frozenset[str] = frozenset({"", "public"})


def is_denied_relation(name: str) -> bool:
    """True if the LLM must not read *name*.

    Denied: the explicit deny-list, every ``directus_*`` table, and Postgres
    catalog relations (``pg_*``).
    """
    lowered = name.lower()
    return lowered in DENIED_RELATIONS or lowered.startswith(DENIED_PREFIXES)


# Functions the LLM may call: ordinary scalar, aggregate and window functions.
# Everything else — including every pg_*, lo_*, dblink*, *_to_xml, set_config,
# current_setting, txid_* and advisory-lock function — is rejected. Names are
# lower-case. sqlglot parses many common functions into typed nodes whose
# canonical name differs from the Postgres spelling (``date_trunc`` ->
# ``timestamp_trunc``, ``string_agg`` -> ``group_concat``), so both spellings are
# listed; a name that only exists in one spelling is harmless in the other.
ALLOWED_FUNCTIONS: frozenset[str] = frozenset(
    {
        # aggregates
        "count",
        "sum",
        "avg",
        "min",
        "max",
        "stddev",
        "stddev_pop",
        "stddev_samp",
        "variance",
        "variance_pop",
        "var_pop",
        "var_samp",
        "array_agg",
        "string_agg",
        "group_concat",
        "json_agg",
        "jsonb_agg",
        "json_object_agg",
        "jsonb_object_agg",
        "bool_and",
        "bool_or",
        "logical_and",
        "logical_or",
        "every",
        "any_value",
        "mode",
        "percentile_cont",
        "percentile_disc",
        "corr",
        "covar_pop",
        "covar_samp",
        "regr_slope",
        "regr_intercept",
        "regr_r2",
        # window
        "row_number",
        "rank",
        "dense_rank",
        "percent_rank",
        "cume_dist",
        "ntile",
        "lag",
        "lead",
        "first_value",
        "last_value",
        "nth_value",
        # conditional / comparison
        "coalesce",
        "nullif",
        "greatest",
        "least",
        "case",
        "if",
        "cast",
        "try_cast",
        "collate",
        # math
        "abs",
        "ceil",
        "ceiling",
        "floor",
        "round",
        "trunc",
        "sqrt",
        "power",
        "pow",
        "exp",
        "ln",
        "log",
        "log10",
        "sign",
        "pi",
        "degrees",
        "radians",
        "sin",
        "cos",
        "tan",
        "atan2",
        "mod",
        "div",
        "width_bucket",
        "cbrt",
        # text
        "lower",
        "upper",
        "initcap",
        "length",
        "char_length",
        "character_length",
        "octet_length",
        "substring",
        "substr",
        "left",
        "right",
        "trim",
        "ltrim",
        "rtrim",
        "btrim",
        "replace",
        "concat",
        "concat_ws",
        "split_part",
        "str_position",
        "strpos",
        "starts_with",
        "regexp_replace",
        "regexp_like",
        "pad",
        "lpad",
        "rpad",
        "repeat",
        "reverse",
        "format",
        "translate",
        "ascii",
        "chr",
        "md5",
        "to_number",
        "to_char",
        "time_to_str",
        "to_date",
        "str_to_date",
        "to_timestamp",
        "str_to_time",
        # date / time
        "current_date",
        "current_time",
        "current_timestamp",
        "now",
        "date_trunc",
        "timestamp_trunc",
        "date_part",
        "extract",
        "age",
        "make_date",
        "make_interval",
        "make_timestamp",
        # json
        "json_extract",
        "json_extract_scalar",
        "jsonb_extract_scalar",
        "json_extract_path",
        "jsonb_extract_path",
        "json_extract_path_text",
        "jsonb_extract_path_text",
        "json_typeof",
        "jsonb_typeof",
        "json_array_length",
        "jsonb_array_length",
        "json_build_object",
        "jsonb_build_object",
        "json_build_array",
        "jsonb_build_array",
        "to_json",
        "to_jsonb",
        "row_to_json",
        # arrays
        "array",
        "array_size",
        "array_length",
        "cardinality",
        "array_to_string",
        "array_position",
        "array_concat",
        "array_cat",
        "array_append",
        "string_to_array",
        # set-returning, still only usable in FROM when listed in SRF_IN_FROM
        "generate_series",
        "unnest",
        "explode",
        # sqlglot canonical spelling of random()
        "rand",
    }
)

# Set-returning functions permitted as a FROM source. Anything else in FROM
# (``query_to_xml``-style readers, ``dblink``, ``jsonb_each`` over arbitrary
# input, ``ROWS FROM (...)``) is rejected even if it were on the list above.
SRF_IN_FROM: frozenset[str] = frozenset({"generate_series", "unnest", "explode"})

# Expression classes that must never appear anywhere in the tree.
_FORBIDDEN_NODES: tuple[type[exp.Expression], ...] = (
    exp.Insert,
    exp.Update,
    exp.Delete,
    exp.Drop,
    exp.Create,
    exp.AlterTable,
    exp.Command,  # raw/unknown utility statements (GRANT, VACUUM, ...)
    exp.Copy,
    exp.TruncateTable,
    exp.Set,
    exp.Merge,
    exp.Into,  # SELECT ... INTO writes a new table
    exp.Lock,  # FOR UPDATE / FOR SHARE take row locks
)

DEFAULT_ROW_LIMIT = 200
MAX_ROW_LIMIT = 1000


class SqlGuardError(ValueError):
    """Raised when LLM-generated SQL fails a safety check."""


def _is_ident_char(ch: str) -> bool:
    return ch.isalnum() or ch in '_$"'


def normalise(sql: str) -> str:
    """Lex *sql* like Postgres does and return it comment-free and single-statement.

    Block comments are removed with Postgres' *nested* semantics (sqlglot's own
    tokenizer does not nest them, so ``/* /* */ x */`` would be read differently
    by the two). Dollar quoting, ``E'…'`` / ``U&'…'`` strings and backslashes —
    the other places two lexers can disagree about where a string ends — are
    rejected outright. Trailing semicolons are dropped; a semicolon anywhere else
    outside a string is rejected (stacked statements).
    """
    if "\x00" in sql:
        raise SqlGuardError("NUL byte in SQL")
    if "\\" in sql:
        raise SqlGuardError("backslashes are not allowed")

    out: list[str] = []
    code: list[str] = []  # everything outside strings, comments and quoted names
    idents: list[str] = []  # quoted identifiers, lower-cased
    semis: set[int] = set()
    n = len(sql)
    pos = 0
    length = 0  # running length of the output, to index semicolons
    while pos < n:
        ch = sql[pos]
        if ch == "'":
            before = sql[pos - 1] if pos else ""
            before2 = sql[pos - 2] if pos > 1 else ""
            if before in "eE" and before and not _is_ident_char(before2):
                raise SqlGuardError("E'' escape strings are not allowed")
            if before == "&" and before2 in "uU" and before2:
                raise SqlGuardError("U&'' strings are not allowed")
            end = pos + 1
            while True:
                end = sql.find("'", end)
                if end == -1:
                    raise SqlGuardError("unterminated string literal")
                if sql[end + 1 : end + 2] == "'":  # '' is an escaped quote
                    end += 2
                    continue
                break
            chunk = sql[pos : end + 1]
            pos = end + 1
            code.append(" ")
        elif ch == '"':
            end = pos + 1
            while True:
                end = sql.find('"', end)
                if end == -1:
                    raise SqlGuardError("unterminated quoted identifier")
                if sql[end + 1 : end + 2] == '"':
                    end += 2
                    continue
                break
            idents.append(sql[pos + 1 : end].replace('""', '"').lower())
            chunk = sql[pos : end + 1]
            pos = end + 1
            code.append(" ")
        elif sql.startswith("--", pos):
            end = sql.find("\n", pos)
            pos = n if end == -1 else end
            chunk = " "
            code.append(" ")
        elif sql.startswith("/*", pos):
            depth = 1
            i = pos + 2
            while i < n and depth:
                if sql.startswith("/*", i):
                    depth += 1
                    i += 2
                elif sql.startswith("*/", i):
                    depth -= 1
                    i += 2
                else:
                    i += 1
            if depth:
                raise SqlGuardError("unterminated block comment")
            pos = i
            chunk = " "
            code.append(" ")
        elif ch == "$":
            raise SqlGuardError("dollar quoting and parameters are not allowed")
        else:
            if ch == ";":
                semis.add(length)
            chunk = ch
            pos += 1
            code.append(ch)
        out.append(chunk)
        length += len(chunk)

    text = "".join(out)
    end = len(text)
    while end > 0 and (text[end - 1].isspace() or (end - 1) in semis):
        end -= 1
    if any(s < end for s in semis):
        raise SqlGuardError("multiple statements are not allowed")
    _reject_hidden_names("".join(code), idents)
    return text[:end].strip()


_WORD = re.compile(r"[A-Za-z_][A-Za-z0-9_$]*")


def _reject_hidden_names(code: str, quoted: list[str]) -> None:
    """Lexical safety net, independent of how sqlglot parses the statement.

    sqlglot reads some Postgres-only syntax (``TABLE name`` shorthand) as
    something that hides a relation from the AST walk. So, outside strings and
    comments, the bare word ``table`` is rejected and any word equal to a denied
    relation name (or a ``pg_*`` catalog name) is rejected wherever it appears.
    That also refuses a column or alias that happens to be named ``people`` — an
    acceptable price for a net that does not depend on the parser.
    """
    words = [w.lower() for w in _WORD.findall(code)]
    if "table" in words:
        raise SqlGuardError("the TABLE shorthand is not allowed")
    for word in words + quoted:
        if (
            word in DENIED_RELATIONS
            or word in DIRECTUS_SYSTEM_TABLES
            or word.startswith("pg_")
        ):
            raise SqlGuardError(f"query mentions a blocked relation name: {word}")


def _ident_key(ident: exp.Expression) -> str:
    """Postgres identifier identity: quoted names are exact, unquoted fold to lower."""
    name = ident.name
    return name if ident.args.get("quoted") else name.lower()


def _function_name(node: exp.Expression) -> str:
    if isinstance(node, exp.Anonymous):
        return str(node.name).lower()
    return node.sql_name().lower()


def _collect_tables(
    node: exp.Expression,
    visible: frozenset[str],
    out: list[tuple[exp.Table, frozenset[str]]],
) -> None:
    """Walk *node*, recording every Table with the CTE names visible at that point.

    A WITH clause's names are visible in the body of the query it is attached to
    and in the CTEs that follow it (and in the CTE itself only when RECURSIVE) —
    and nowhere else. A same-named CTE in a sibling or nested scope therefore
    cannot hide a real table.
    """
    with_ = node.args.get("with")
    if isinstance(with_, exp.With):
        recursive = bool(with_.args.get("recursive"))
        scope = visible
        for cte in with_.expressions:
            alias = cte.args.get("alias")
            key = _ident_key(alias.this) if alias is not None and alias.this else ""
            _collect_tables(cte.this, scope | {key} if recursive else scope, out)
            scope = scope | {key}
        visible = scope

    if isinstance(node, exp.Table):
        out.append((node, visible))

    for arg, value in node.args.items():
        if arg == "with":
            continue
        for child in value if isinstance(value, list) else [value]:
            if isinstance(child, exp.Expression):
                _collect_tables(child, visible, out)


def _real_tables(tree: exp.Expression) -> list[exp.Table]:
    """Tables in *tree* that are physical relations (not CTE references)."""
    found: list[tuple[exp.Table, frozenset[str]]] = []
    _collect_tables(tree, frozenset(), found)
    real: list[exp.Table] = []
    for table, visible in found:
        this = table.this
        is_cte_ref = (
            isinstance(this, exp.Identifier)
            and not table.args.get("db")
            and not table.args.get("catalog")
            and _ident_key(this) in visible
        )
        if not is_cte_ref:
            real.append(table)
    return real


def _referenced_tables(tree: exp.Expression) -> set[str]:
    """Lower-cased names of the real (non-CTE) relations *tree* references."""
    return {
        t.name.lower()
        for t in _real_tables(tree)
        if isinstance(t.this, exp.Identifier) and t.name
    }


def _check_tables(tree: exp.Expression) -> None:
    for table in _real_tables(tree):
        this = table.this
        if not isinstance(this, exp.Identifier):
            # A function (or ROWS FROM / other construct) used as a row source.
            if not (
                isinstance(this, exp.Func)
                and not isinstance(this, exp.Dot)
                and not table.args.get("db")
                and _function_name(this) in SRF_IN_FROM
            ):
                raise SqlGuardError(
                    "only generate_series() and unnest() may be used in FROM"
                )
            continue
        if table.args.get("catalog"):
            raise SqlGuardError("database-qualified relation names are not allowed")
        schema = (table.db or "").lower()
        if schema not in ALLOWED_SCHEMAS:
            raise SqlGuardError(f"query references a non-lab schema: {schema}")

    # Unnest as a direct FROM/JOIN source is its own node, not a Table.
    for node in tree.find_all(exp.Unnest):
        if _function_name(node) not in SRF_IN_FROM:
            raise SqlGuardError(
                "only generate_series() and unnest() may be used in FROM"
            )


def _check_functions(tree: exp.Expression) -> None:
    for node in tree.walk():
        if isinstance(node, exp.Dot) and isinstance(node.expression, exp.Func):
            raise SqlGuardError("schema-qualified function calls are not allowed")
        if isinstance(node, exp.Func):
            name = _function_name(node)
            if name not in ALLOWED_FUNCTIONS:
                raise SqlGuardError(f"function not allowed: {name}")


def validate(sql: str) -> exp.Expression:
    """Parse *sql* and assert it is a single, read-only, allow-listed SELECT.

    Returns the parsed expression on success; raises :class:`SqlGuardError`
    otherwise. Does not execute anything.
    """
    if not sql or not sql.strip():
        raise SqlGuardError("empty statement")

    cleaned = normalise(sql)
    if not cleaned:
        raise SqlGuardError("empty statement")

    try:
        statements = sqlglot.parse(cleaned, read="postgres")
    except Exception as exc:  # noqa: BLE001 — surface any parse failure uniformly
        raise SqlGuardError(f"could not parse SQL: {exc}") from exc

    statements = [s for s in statements if s is not None]
    if len(statements) != 1:
        raise SqlGuardError("exactly one statement is required")

    tree = statements[0]

    # Top-level must be a SELECT or a set operation (UNION/INTERSECT/EXCEPT).
    if not isinstance(tree, exp.Select | exp.Union | exp.Subquery):
        raise SqlGuardError(
            f"only SELECT queries are allowed, got {type(tree).__name__}"
        )

    for node in tree.walk():
        if isinstance(node, _FORBIDDEN_NODES):
            raise SqlGuardError(f"forbidden statement element: {type(node).__name__}")

    _check_tables(tree)
    _check_functions(tree)

    referenced = _referenced_tables(tree)
    if not referenced:
        raise SqlGuardError("query references no tables")

    denied = sorted(r for r in referenced if is_denied_relation(r))
    if denied:
        raise SqlGuardError(
            "query references blocked (credential/audit/personal/system) relations: "
            + ", ".join(denied)
        )

    return tree


def message_only(sql: str) -> str | None:
    """Return the message text if *sql* is a safe, table-free constant SELECT.

    The model answers a greeting or an off-topic / unanswerable question with a
    table-free ``SELECT '…' AS note``. That legitimately references no table, so
    rather than reject it as "no tables" we surface the literal as a plain chat
    reply (no data table). Returns ``None`` for any real query (one that touches
    a table) or anything unsafe, stacked, or unparseable. The SQL is never run.
    """
    if not sql or not sql.strip():
        return None
    try:
        cleaned = normalise(sql)
        tree = sqlglot.parse_one(cleaned, read="postgres")
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(tree, exp.Select):
        return None
    if _referenced_tables(tree):  # a real query, not a message
        return None
    for node in tree.walk():
        if isinstance(node, (*_FORBIDDEN_NODES, exp.Func)):
            return None
    literal = tree.find(exp.Literal)
    if literal is not None and literal.is_string:
        return str(literal.this)
    return None


def guard(sql: str, row_limit: int = DEFAULT_ROW_LIMIT, *, probe: bool = False) -> str:
    """Validate *sql* and return an execution-safe, row-limited version.

    The validated, comment-free query is wrapped in an outer ``SELECT ... LIMIT``
    so a result set is always bounded regardless of any (or no) inner LIMIT, and
    the wrapped statement is validated again. ``row_limit`` must be an integer;
    it is clamped to ``MAX_ROW_LIMIT``. With ``probe`` the query fetches one row
    beyond that limit so the caller can tell whether the result was cut short.
    Raises :class:`SqlGuardError` if validation fails.
    """
    validate(sql)
    limit = min(int(row_limit), MAX_ROW_LIMIT)
    if limit < 1:
        raise SqlGuardError("row_limit must be a positive integer")
    inner = normalise(sql)
    fetch = limit + 1 if probe else limit
    wrapped = f"SELECT * FROM (\n{inner}\n) AS _guarded LIMIT {fetch}"
    validate(wrapped)
    return wrapped
