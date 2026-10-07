"""Text-to-SQL API.

Endpoints (all but /health require the X-Worker-Secret header):
  GET  /health             — liveness probe
  POST /api/ask            — {question} -> {sql, columns, rows, row_count, truncated}
                             (NL -> SQL -> data)
  POST /api/chat           — {messages[]} -> {sql, columns, rows, row_count,
                             truncated, chart} (multi-turn)
  POST /api/search         — {query, limit?} -> semantically similar note rows
  POST /api/embed/backfill — (re)embed all note text into semantic_embeddings

The LLM is never trusted: its SQL passes through app.lib.sql_guard before it
touches the read-only database role, and any chart it proposes passes through
app.lib.charts before it reaches the client. See ADR-0009.
"""

import logging
import os

from flask import Flask, jsonify, request

from app.lib import charts, db, embeddings, ollama_client, schema_context
from app.lib.security import check_secret
from app.lib.sql_guard import (
    DEFAULT_ROW_LIMIT,
    MAX_ROW_LIMIT,
    SqlGuardError,
    guard,
    message_only,
)

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

# Bounded execution-feedback self-correction (standard text-to-SQL hardening):
# when a generated query is rejected or fails to run, feed the error back to the
# model and let it fix itself, up to this many total attempts.
MAX_SQL_ATTEMPTS: int = int(os.getenv("LLM_MAX_SQL_ATTEMPTS", "3"))

# Request-size limits. The Directus proxy already enforces the same caps; they are
# repeated here so a direct caller of the plugin cannot exceed them either.
MAX_MESSAGES = 20
MAX_MESSAGE_CHARS = 4000
MAX_SEARCH_LIMIT = 50
CHAT_ROLES = frozenset({"user", "assistant"})


class _BadParamError(ValueError):
    """A request field has the wrong type or range (answered with 422)."""


def _clamped_int(payload: dict, key: str, default: int, maximum: int) -> int:
    """Read an optional positive-integer field, clamped to *maximum*.

    A missing field gives *default*; a non-integer (including bool, float, str) or
    a value below 1 raises :class:`_BadParamError`; a value above *maximum* is clamped.
    """
    if key not in payload or payload[key] is None:
        return default
    value = payload[key]
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise _BadParamError(f"{key} must be a positive integer")
    return min(value, maximum)


def _json_object():
    """The request body as a dict, or None if it is not a JSON object."""
    payload = request.get_json(force=True, silent=True)
    return payload if isinstance(payload, dict) else None


def _valid_messages(messages) -> bool:
    """True for a bounded list of {role: user|assistant, content: str} turns
    that contains at least one non-blank user message."""
    if not isinstance(messages, list) or not 0 < len(messages) <= MAX_MESSAGES:
        return False
    for m in messages:
        if not isinstance(m, dict) or m.get("role") not in CHAT_ROLES:
            return False
        content = m.get("content")
        if not isinstance(content, str) or len(content) > MAX_MESSAGE_CHARS:
            return False
    return any(m["role"] == "user" and m["content"].strip() for m in messages)


def _cap_rows(rows: list[dict], row_limit: int) -> tuple[list[dict], bool]:
    """Drop the extra probe row a ``guard(..., probe=True)`` query fetched.

    Returns ``(rows, truncated)``: *truncated* is true when the query produced more
    than *row_limit* rows, and exactly *row_limit* of them are returned.
    """
    return rows[:row_limit], len(rows) > row_limit


def _correction_hint(error: str) -> str:
    """A corrective user turn: the real error + where columns actually live."""
    return (
        f"That SQL failed with: {error}\n"
        "Rewrite it as ONE valid read-only SELECT, using ONLY columns that exist "
        "on the exact table or view you select FROM (see the schema above). Note: "
        "detailed process parameters (machining feed/speed/depth, process_category, "
        "machining_operation_subtype) are columns on the BASE table "
        "manufacturing_operations, while method_name/method_code are on the v_* "
        "views — JOIN manufacturing_operations to a view if you need both. "
        "Output ONLY the corrected SQL."
    )


app = Flask(__name__)
app.before_request(check_secret)


@app.get("/health")
def health():
    return jsonify({"status": "ok"})


def _rejection_response(exc: SqlGuardError, candidate_sql: str):
    """The shared 422 for SQL the guard refuses — never executed. See ADR-0009."""
    log.warning("rejected LLM SQL: %s | sql=%r", exc, candidate_sql)
    return (
        jsonify(
            {
                "error": "generated SQL rejected",
                "reason": str(exc),
                "sql": candidate_sql,
            }
        ),
        422,
    )


def _query_error_response(exc: db.QueryExecutionError, candidate_sql: str):
    """The shared 422 for guarded SQL Postgres rejects at run time.

    The model referenced a column that doesn't exist, or the query timed out —
    its fault, not a server fault, so surface it as a message instead of a 500.
    """
    log.warning("query execution failed: %s | sql=%r", exc, candidate_sql)
    return (
        jsonify(
            {
                "error": "the generated query could not run",
                "reason": str(exc),
                "sql": candidate_sql,
            }
        ),
        422,
    )


@app.post("/api/ask")
def ask():
    """Natural-language question -> guarded SQL -> rows.

    Body: {"question": "...", "row_limit": <optional int, 1..MAX_ROW_LIMIT>}
    """
    payload = _json_object()
    question = payload.get("question") if payload else None
    if not isinstance(question, str) or not question.strip():
        return jsonify({"error": "missing question"}), 400
    question = question.strip()
    if len(question) > MAX_MESSAGE_CHARS:
        return jsonify({"error": "question is too long"}), 400
    try:
        row_limit = _clamped_int(payload, "row_limit", DEFAULT_ROW_LIMIT, MAX_ROW_LIMIT)
    except _BadParamError as exc:
        return jsonify({"error": str(exc)}), 422

    system_prompt = schema_context.build_system_prompt()
    raw = ollama_client.generate_sql(system_prompt, question)
    candidate_sql = ollama_client.strip_sql_fences(raw)

    try:
        safe_sql = guard(candidate_sql, row_limit=row_limit, probe=True)
    except SqlGuardError as exc:
        return _rejection_response(exc, candidate_sql)

    try:
        rows, truncated = _cap_rows(db.run_select(safe_sql), row_limit)
    except db.QueryExecutionError as exc:
        return _query_error_response(exc, candidate_sql)
    columns = list(rows[0].keys()) if rows else []
    return jsonify(
        {
            "sql": candidate_sql,
            "columns": columns,
            "rows": rows,
            "row_count": len(rows),
            "truncated": truncated,
        }
    )


@app.post("/api/chat")
def chat():
    """Multi-turn NL chat -> guarded SQL -> rows + an optional chart spec.

    Body: {"messages": [{"role": "user"|"assistant", "content": "..."}...],
           "row_limit": <optional int, 1..MAX_ROW_LIMIT>}
    At most MAX_MESSAGES turns of MAX_MESSAGE_CHARS characters each.

    The prior turns give the model context so follow-ups refine the previous
    query. The generated SQL still passes the guard (unsafe -> 422, not run), and
    any proposed chart passes app.lib.charts before it is returned.
    """
    payload = _json_object() or {}
    messages = payload.get("messages")
    if not _valid_messages(messages):
        return jsonify({"error": "missing messages"}), 400
    try:
        row_limit = _clamped_int(payload, "row_limit", DEFAULT_ROW_LIMIT, MAX_ROW_LIMIT)
    except _BadParamError as exc:
        return jsonify({"error": str(exc)}), 422
    question = next(
        (m["content"] for m in reversed(messages) if m["role"] == "user"), ""
    )

    system_prompt = schema_context.build_system_prompt()

    # Execution-feedback self-correction loop: generate SQL, and on a guard
    # rejection or a run-time error, append the real error to the conversation
    # and let the model repair it — bounded by MAX_SQL_ATTEMPTS.
    convo = [{"role": m["role"], "content": m["content"]} for m in messages]
    candidate_sql: str = ""
    rows: list[dict] = []
    truncated = False
    result_ok = False
    failure = None  # (responder, exc, sql) from the last failed attempt

    for _attempt in range(MAX_SQL_ATTEMPTS):
        raw = ollama_client.generate_sql_chat(system_prompt, convo)
        candidate_sql = ollama_client.strip_sql_fences(raw)

        # Greetings / off-topic: a table-free SELECT of a message -> plain reply.
        reply = message_only(candidate_sql)
        if reply is not None:
            return jsonify(
                {"sql": None, "columns": [], "rows": [], "chart": None, "reply": reply}
            )

        try:
            safe_sql = guard(candidate_sql, row_limit=row_limit, probe=True)
        except SqlGuardError as exc:
            failure = (_rejection_response, exc, candidate_sql)
            convo += [
                {"role": "assistant", "content": candidate_sql},
                {"role": "user", "content": _correction_hint(str(exc))},
            ]
            continue

        try:
            rows, truncated = _cap_rows(db.run_select(safe_sql), row_limit)
        except db.QueryExecutionError as exc:
            failure = (_query_error_response, exc, candidate_sql)
            convo += [
                {"role": "assistant", "content": candidate_sql},
                {"role": "user", "content": _correction_hint(str(exc))},
            ]
            continue

        result_ok = True
        break

    if not result_ok:
        responder, exc, sql = failure
        return responder(exc, sql)

    columns = list(rows[0].keys()) if rows else []

    # Ask the model for a chart (honouring an explicit "pie/bar/…"), validate it
    # against the real columns, then fall back to a deterministic chart so an
    # explicit "make a chart" still yields one.
    chart = charts.validate_chart_spec(
        ollama_client.suggest_chart(columns, rows, question), columns
    )
    if chart is None:
        chart = charts.default_chart_for(columns, rows, question)

    return jsonify(
        {
            "sql": candidate_sql,
            "columns": columns,
            "rows": rows,
            "row_count": len(rows),
            "truncated": truncated,
            "chart": chart,
        }
    )


@app.post("/api/search")
def search():
    """Hybrid semantic search over unstructured note text.

    Body: {"query": "...", "limit": <optional int, 1..MAX_SEARCH_LIMIT>}
    """
    payload = _json_object()
    query = payload.get("query") if payload else None
    if not isinstance(query, str) or not query.strip():
        return jsonify({"error": "missing query"}), 400
    query = query.strip()
    if len(query) > MAX_MESSAGE_CHARS:
        return jsonify({"error": "query is too long"}), 400
    try:
        limit = _clamped_int(payload, "limit", 5, MAX_SEARCH_LIMIT)
    except _BadParamError as exc:
        return jsonify({"error": str(exc)}), 422

    query_embedding = ollama_client.embed(query)
    results = db.semantic_search(query_embedding, limit=limit)
    # source_id is a UUID -> stringify for JSON.
    for r in results:
        r["source_id"] = str(r["source_id"])
    return jsonify({"results": results})


@app.post("/api/embed/backfill")
def embed_backfill():
    """Embed all note text into semantic_embeddings (incremental)."""
    summary = embeddings.backfill()
    return jsonify(summary)
