# llm-text-to-sql — Local Text-to-SQL & Semantic Search (Phase 6)

A plugin that lets a **self-hosted** LLM (Ollama: Llama-3/Mistral) answer
natural-language questions against the database, and that runs pgvector hybrid
search over unstructured note text. Spec §6; design in
[`docs/adr/0009-text-to-sql-guarded-readonly.md`](../../docs/adr/0009-text-to-sql-guarded-readonly.md);
operations in
[`docs/runbooks/text-to-sql.md`](../../docs/runbooks/text-to-sql.md).

The LLM is **never trusted**. Its SQL passes a two-layer boundary — an
application SQL guard (sqlglot AST validation, function allow-list, per-scope CTE
resolution, denied relations, enforced LIMIT) and a read-only Postgres role with
`SELECT` on an explicit allow-list of lab tables and views (never `audit_logs`,
`people` or any `directus_*` table) — before it touches data.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness probe (no auth). |
| POST | `/api/ask` | `{question}` → `{sql, columns, rows, row_count, truncated}`. Unsafe SQL → 422, not executed. |
| POST | `/api/search` | `{query, limit?}` → note rows ranked by cosine similarity. |
| POST | `/api/embed/backfill` | (Re)embed all note text into `semantic_embeddings`. |

All but `/health` require the `X-Worker-Secret` header. The service **fails
closed**: with `WORKER_WEBHOOK_SECRET` unset every other route answers 503.
`row_limit` / `limit` must be positive integers (422 otherwise) and are clamped
(max 1000 rows; 50 search hits); `/api/chat` takes at most 20 `user`/`assistant`
messages of 4000 characters each.

## Layout

```
app/
  api.py                 # Flask app: /health, /api/ask, /api/search, /api/embed/backfill
  lib/
    sql_guard.py         # THE injection boundary: sqlglot validation + function allow-list + denied relations + LIMIT
    schema_context.py    # builds the LLM prompt from v_schema_dictionary (live)
    ollama_client.py     # Ollama /api/chat + /api/embeddings
    db.py                # read-only query execution + pgvector search (LLM_DATABASE_URL)
    embeddings.py        # incremental note-embedding backfill (EMBED_DATABASE_URL)
    security.py          # X-Worker-Secret auth
eval/
  questions.json         # curated NL->SQL gold set
  run_eval.py            # offline (guard) + live (--live) evaluation harness
tests/                   # guard allow/deny matrix, schema context, API, eval golds
```

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `LLM_DATABASE_URL` | yes | — | DSN for a login role inheriting `d1_llm_readonly`. Never the superuser. |
| `EMBED_DATABASE_URL` | for backfill | `DATABASE_URL` | Writer DSN; only the embedding backfill uses it. |
| `OLLAMA_URL` | yes | `http://ollama:11434` | Ollama runtime URL. |
| `OLLAMA_SQL_MODEL` | no | `llama3` | Chat model for SQL generation. |
| `OLLAMA_EMBED_MODEL` | no | `nomic-embed-text` | Embedding model (must be 768-dim). |
| `LLM_STATEMENT_TIMEOUT_MS` | no | `5000` | Per-connection statement timeout. |
| `WORKER_WEBHOOK_SECRET` | yes | — | Shared secret for `X-Worker-Secret`. Unset = every route except `/health` answers 503. |
| `WORKER_HTTP_PORT` | no | `8080` | Port gunicorn binds inside the container. |

## Test

```bash
make llm-test          # docker build + pytest (guard matrix, schema, API, eval golds)
make llm-eval          # offline NL->SQL gold validation (no LLM/DB needed)
```

This plugin is API-synchronous (no rq worker): `entrypoint.sh` runs gunicorn
only. It is **not** built from the webhook-style `plugin-template`, because its
job is request/response, not Directus-Flow-triggered file processing.
