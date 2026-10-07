# Runbook — Local Text-to-SQL & Semantic Search (Phase 6)

How to stand up, secure, and operate the local LLM text-to-SQL layer. Design
rationale is in [ADR-0009](../adr/0009-text-to-sql-guarded-readonly.md).

The capability has two halves:

- **Durable core** (already applied by migration `…0015_ai_readiness.sql`): the
  `v_schema_dictionary` / `v_llm_query_targets` views, the `semantic_embeddings`
  pgvector store, and the `d1_llm_readonly` read-only role.
- **Plugin** (`plugins/llm-text-to-sql/`, `llm` compose profile): a small API
  that turns a question into guarded SQL and rows, plus pgvector search and an
  embedding backfill. It depends on an **Ollama** runtime in the same profile.

---

## 1. One-time: create the read-only login role

Migrations create `d1_llm_readonly`, a NOLOGIN **privilege bundle** (SELECT on an
explicit allow-list of lab tables and views), and `d1_llm_app`, a NOLOGIN member of
it that already has `default_transaction_read_only = on` and a 5 s
`statement_timeout` (migration `…132_llm_readonly_allow_list`). Turn it into the
plugin's login once, with a password kept out of version control:

```sql
-- as the d1 superuser, against the d1_database database
ALTER ROLE d1_llm_app LOGIN PASSWORD 'choose-a-strong-password';
```

The embedding backfill needs its own writer login, which is **not** the `d1`
superuser (this container also runs LLM-authored SQL, so it must not hold
superuser credentials). It only reads the note view and upserts one table:

```sql
-- as the d1 superuser, against the d1_database database
CREATE ROLE d1_embedder LOGIN PASSWORD 'choose-another-strong-password';
GRANT CONNECT ON DATABASE d1_database TO d1_embedder;
GRANT USAGE ON SCHEMA public TO d1_embedder;
GRANT SELECT ON v_embeddings_source_notes TO d1_embedder;
GRANT SELECT, INSERT, UPDATE ON semantic_embeddings TO d1_embedder;
```

Then set the DSNs in `.env` (use hex passwords so they are URL-safe):

```
LLM_DATABASE_URL=postgres://d1_llm_app:choose-a-strong-password@postgres:5432/d1_database?sslmode=disable
EMBED_DATABASE_URL=postgres://d1_embedder:choose-another-strong-password@postgres:5432/d1_database?sslmode=disable
```

- `LLM_DATABASE_URL` executes LLM-authored SQL — **never** point it at the
  superuser. It is the read-only, allow-listed login role above.
- `EMBED_DATABASE_URL` is used **only** by the embedding backfill, which must
  write `semantic_embeddings`; the `d1_embedder` role above has INSERT/UPDATE on
  that one table and nothing else. Never point it at `d1`. (A later migration or
  setup script may create the role; until then this runbook step is the source.)

> Verify the isolation any time with `make ai-test` (or
> `bash tests/phase6_text_to_sql.sh`): it provisions a throwaway member of
> `d1_llm_readonly` and asserts the role can read but not write.

**Read surface (allow-list since migration `…132_llm_readonly_allow_list`):**
`d1_llm_readonly` can `SELECT` the lab tables and `v_*` views listed in that
migration and nothing else. `audit_logs`, `people`, `Machine_Operators`,
`archive_metadata_edits`, `force_crawler_state`, `schema_migrations` and every
`directus_*` table are not granted, and a table added later stays invisible to the
LLM until a migration grants it (a view that is dropped and recreated must be
re-granted). `app/lib/sql_guard.py` enforces the same deny-list a second time and
also rejects side-effect and SQL-running functions (`query_to_xml`,
`pg_read_file`, `set_config`, …) and `FOR UPDATE`. See ADR-0009's status note.

Who may ask: `/d1-ask` serves admins and users with app access only (API-only
tokens get 403). It forwards only the last 20 messages (4000 characters each),
the plugin caps `row_limit` at 1000, and both refuse to run (503) when
`WORKER_WEBHOOK_SECRET` is unset.

---

## 2. Start the LLM profile and pull models

Ollama and the plugin are in the opt-in `llm` profile so the heavy image and
models are not pulled by a default `docker compose up`.

```bash
docker compose --profile llm up -d ollama llm-text-to-sql

# Pull the models once (stored in the ollama-models volume):
docker compose exec ollama ollama pull llama3            # OLLAMA_SQL_MODEL
docker compose exec ollama ollama pull nomic-embed-text  # OLLAMA_EMBED_MODEL (768-dim)
```

Swap models via `OLLAMA_SQL_MODEL` / `OLLAMA_EMBED_MODEL` in `.env`. **Note:**
`semantic_embeddings.embedding` is `vector(768)`; only use an embedding model
that produces 768-dimensional vectors, or add a migration to change the column.

---

## 3. Ask a question

`POST /api/ask` on the plugin (host port `LLM_HTTP_PORT`, default `8082`, bound to
`D1_BIND_ADDR`, i.e. `127.0.0.1` unless you changed it). `WORKER_WEBHOOK_SECRET` is
required (compose will not start without it), so always send it in `X-Worker-Secret`.

```bash
curl -s localhost:8082/api/ask \
  -H 'Content-Type: application/json' \
  -H "X-Worker-Secret: $WORKER_WEBHOOK_SECRET" \
  -d '{"question": "Which samples weigh more than 50 grams?"}' | jq
```

Response:

```json
{
  "sql": "SELECT sample_code, mass_grams FROM v_complete_sample_history WHERE mass_grams > 50",
  "columns": ["sample_code", "mass_grams"],
  "rows": [ ... ],
  "row_count": 42,
  "truncated": false
}
```

Results are capped at `row_limit` rows (default 200, max 1000). The query fetches one
extra row to find out whether more existed: `truncated` is `true` when it did, and `rows`
then holds exactly `row_limit` rows. `/api/chat` returns the same two fields.

If the model emits unsafe or off-menu SQL the API returns **422** with the
rejection reason and the offending SQL — it is never executed. See ADR-0009 and
`app/lib/sql_guard.py` for the rules.

---

## 4. Embeddings & semantic search

Backfill embeddings for every note in the schema (incremental — unchanged notes
are skipped via `content_hash`):

```bash
curl -s -X POST localhost:8082/api/embed/backfill \
  -H "X-Worker-Secret: $WORKER_WEBHOOK_SECRET" | jq
# -> {"embedded": N, "skipped": M, "model": "nomic-embed-text"}
```

Run it after large note edits, or schedule it. Then search by meaning:

```bash
curl -s localhost:8082/api/search \
  -H 'Content-Type: application/json' \
  -H "X-Worker-Secret: $WORKER_WEBHOOK_SECRET" \
  -d '{"query": "cracking during sintering", "limit": 5}' | jq
```

Results come from `semantic_embeddings` ordered by cosine distance (the HNSW
index `semantic_embeddings_hnsw_idx`), each with its `source_table` /
`source_id` so you can click through to the record.

The embeddable note columns are defined by the `v_embeddings_source_notes` view.
To embed a new note column, add a `UNION ALL` branch to that view in a new
migration and re-run the backfill — no plugin change needed.

---

## 5. Evaluating NL→SQL quality

`eval/questions.json` holds curated `(question, gold_sql)` pairs.

```bash
# Offline: assert every gold query still passes the guard (CI runs this).
make llm-eval

# Live: send each question to a running plugin and report safe-and-runnable rate.
LLM_API_URL=http://localhost:8082 python plugins/llm-text-to-sql/eval/run_eval.py --live
```

Add questions as the schema grows; the offline check guarantees the gold answers
stay within the allow-list as views change.

---

## 6. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `/api/ask` 422 "outside the allow-list" | Model referenced a base table | Expected — the guard worked. Improve the prompt or add the view to `v_llm_query_targets` **and** `ALLOWED_RELATIONS` if it should be queryable. |
| `/api/ask` 500, "LLM_DATABASE_URL is not configured" | DSN unset | Set `LLM_DATABASE_URL` in `.env` (step 1). |
| `permission denied for table …` in logs | Login role lacks a needed view grant | Grant it in a migration to `d1_llm_readonly`; never grant base tables. |
| Embeddings: `expected 768 dimensions` | Embedding model dimension ≠ 768 | Use a 768-dim model or migrate the `vector(…)` size. |
| Ollama timeouts | Model not pulled / cold | `docker compose exec ollama ollama pull <model>`; raise `OLLAMA_TIMEOUT_S`. |
| Query killed at ~5 s | `statement_timeout` hit | Expected guardrail; refine the question or raise `LLM_STATEMENT_TIMEOUT_MS`. |

---

## 7. Chat in Directus — "Ask the Database"

Two ways to chat with the data **inside the Directus Studio** (no separate app).

### Path A — the built-in Directus AI Chat (config only, no code)

Directus ships an AI Assistant/Chat (v11.14+) that speaks to any
OpenAI-compatible endpoint, including your **host Ollama**. Fastest to try, but it
queries via Directus RBAC/tools (not the guarded `v_*` path), returns text+tables
(no charts), and can *write* unless constrained.

1. The `directus` compose service already has
   `extra_hosts: ["host.docker.internal:host-gateway"]` so it can reach the host.
2. Pull a **tool-calling** model on the host: `ollama pull llama3.1` (the SQL-only
   `llama3` is weaker at the Assistant's function-calling).
3. In Studio → Settings → AI, choose an OpenAI-compatible provider with Base URL
   `http://host.docker.internal:11434/v1/`, API key `ollama` (placeholder), and
   the pulled model. (Set the equivalent env vars if your version is env-driven.)
4. Test as a **read-only** user/policy so the Assistant can't mutate; keep
   per-tool approval on (default).

### Path B — the "Ask the Database" module (guarded, with charts)

A custom page that reuses this plugin's guard + read-only role and adds a chat UI
with **Plotly charts**. Two extensions in `core/extensions/`:

- `d1-ask-endpoint` — server-side proxy mounted at `/d1-ask`. Requires a
  logged-in user and forwards to the plugin's `POST /api/chat`, injecting
  `WORKER_WEBHOOK_SECRET` so the browser never sees it. The plugin stays on the
  internal network — no host port needed.
- `d1-ask-db` — the module (sidebar entry **Ask the Database**). Multi-turn chat;
  each answer shows the generated SQL, a table, and a chart when one fits. The empty
  chat offers example-question chips (bundled in `src/examples.ts`, picked from
  `eval/questions.json`), a "Showing the first N rows" note appears when the result
  was truncated, and failures (guard rejection, 401/403, 502, 504) show a plain-language
  message instead of the raw error.

  Each answer has **Download CSV** (RFC 4180, UTF-8 BOM, `ask-<question>-<date>.csv`, built in
  the browser from the rows shown, so at most the 200-row cap), **Copy SQL** (falls back to
  `execCommand` on plain-http hosts, where `navigator.clipboard` is unavailable) and **Save
  question**. The empty chat also lists history, all client-side in `localStorage`: key
  `d1-ask-db:history:<user id>` holds the last 20 asked questions (deduplicated, newest first) and
  `d1-ask-db:saved:<user id>` holds saved questions (capped at 100), so users who share a browser
  keep separate lists (the bare keys are used only if no user id is available; lists written by
  older versions under the bare keys move to the first user who opens the module, then are
  deleted). Every change re-reads the stored list first, so two tabs merge instead of overwriting
  each other. Only the first question of a conversation is added to history (a follow-up is
  meaningless without the turns before it, so Run again on it would lose its context; Save
  question still works on any question). Only question text and a timestamp are stored, never result rows. Nothing is synced
  between browsers.

  Thumbs-up/down feedback on answers is deliberately **out of scope** until there is a place to
  store it (owner decision); do not add it to the module without one.

Setup:

```bash
# Build both extensions (module needs a build; endpoint is plain JS).
( cd core/extensions/d1-ask-db && npm install && npm run build )

# Ensure the plugin points at host Ollama (default in .env.example) and is up.
docker compose up -d llm-text-to-sql directus
# Pull a SQL model on the host if you haven't: ollama pull qwen2.5-coder
```

Then open the Studio → **Ask the Database** and ask, e.g. "how many samples per
material?". Follow-ups ("now only aluminium alloys") refine the previous query.
Unsafe/off-menu SQL is still rejected by the guard (surfaced as a note), never run.

The chart the model proposes is validated against the returned columns by
`app/lib/charts.py`; anything malformed or off-menu falls back to the table.

Tests: `make llm-test` (backend, incl. `/api/chat` + chart validation),
`cd core/extensions/d1-ask-db && npm test` (CSV and history helpers) and
`cd tests/ui && npx playwright test 08-ask-db-chat` (UI + endpoint auth).
