# Stream 4 — `core/` Directus layer (raw reviewer report)

Static review plus syntax checks; no live Directus stack, so claims about Directus internals are
marked **uncertain**. The coordinator's checks are recorded in the consolidated report.

## Findings

1. **blocking — `d1-report` endpoints bypass RBAC.** `core/extensions/d1-report/src/index.js:165-360`.
   `/sample/:id`, `/operation/:id`, `/test/:id` check only `req.accountability?.user`, then read
   with the root `database` knex. Any logged-in account, whatever its collection permissions, can
   fetch full reports (`mo.*`, `t.*`, `people.email`, export-controlled samples) and probe which
   sample codes exist. Fix: read via `ItemsService` with the request's accountability, or check
   read permission on the base collection first.
2. **blocking — `d1-ask` gives every authenticated user broad DB read.**
   `core/extensions/d1-ask-endpoint/index.js:22-36`. Gate is "has a user"; the plugin's role has
   `SELECT ON ALL TABLES` minus a deny-list (see stream 5 #8), so any account — including
   restricted roles and machine tokens like Rig_1 — can query `audit_logs`, `people`, and
   owner-restricted rows, bypassing Directus row/field permissions. The proxy forwards `req.body`
   verbatim (client `row_limit`, arbitrary message roles, no size cap), `fetch` has no timeout,
   and an empty `WORKER_WEBHOOK_SECRET` silently drops the header (the plugin then disables its
   check). Fix: explicit role gate; forward only capped `messages`; `AbortSignal.timeout`; 503 if
   the secret is unset; deny `audit_logs`/`people`.
3. **should fix (uncertain) — `core/apply.sh` / `permissions.json` target the pre-v11 role
   model.** Compose runs `directus/directus:11` (permissions on policies). `apply.sh:98-118` POSTs
   `admin_access`/`app_access` to `/roles`; `:148-168` uses `role` on permissions, with errors
   hidden by `2>/dev/null || echo 0`. `tests/phase3_api.sh` is not in any workflow. The wiki says
   the live model is `scripts/configure_users_and_policies.sql`. Port to `/policies` + `/access`,
   or retire `apply.sh`.
4. **should fix — `apply.sh` creates but never converges.** `:152-165` skips existing
   (role, collection, action), so narrowed `fields` never apply; a failed existence query reads as
   0 (duplicates); `-sf` hides bodies; `:61-63` hand-interpolates the admin password into JSON (use
   `jq -n --arg`); the Rig_1 token is printed to stdout. README vs `apply.sh:245` disagree on
   committing `schema-snapshot.yaml`.
5. **should fix — operation codes built in the browser, no uniqueness.**
   `d1-operation-code/src/OperationCode.vue:236-299` composes `pass_code` from
   `operation_sequence`, which is blank for new non-machining ops until
   `d1-operation-sequence/index.js:19-25` assigns `max+1` afterwards (unlocked read-then-write);
   nothing rewrites `pass_code`. Sintering counter `count+1` (`:207-217`) reuses numbers after a
   delete. No `UNIQUE(pass_code)` or `UNIQUE(sample_id, operation_sequence)`. Fix: server-side
   generation (`generate_pass_code` already exists in `…011_code_generation.sql`) + unique
   constraints.
6. **should fix — sample codes generated client-side.** `d1-sample-code/src/SampleCode.vue:65-81`,
   `d1-home/src/register-sample.vue:65-77` fetch all codes and take `max+1`; permission-filtered
   reads give a lower max; `catch { return 1 }` hides failures. `UNIQUE` catches it loudly. Fix: a
   Postgres sequence/function.
7. **should fix — `owner-cascade` and `box-intake` are post-commit action hooks.** Failures are
   logged but the API returns success (migration `…113` documents box intake silently aborting).
   `owner-cascade/index.js:12-58` runs up to four non-transactional statements with the root knex
   (bypassing child permissions); SQL updates don't cascade (ADR-0002). Fix: Postgres triggers.
8. **should fix — `expand_tool_box_intake` drops the visible owner.**
   `db/migrations/20260621000022_insert_box_intake.sql:149-157` copies only legacy `owner`, not
   `owner_person_id` (never updated after `…061`), so cloned boxes, inserts and edges get NULL
   owners. `v_base_seq = COUNT(*)` (`:128`) collides after a box delete.
9. **should fix (uncertain) — audit actor may be lost.** `actor-identity/index.js:19-30` uses
   `set_config(…, true)` in a filter hook; correct only if Directus runs it on the write's
   transaction. Root-knex writes from other hooks never carry the actor. `tests/phase3_api.sh:195`
   sends an `X-Actor-Identity` header the hook ignores. Confirm by PATCHing as a normal user and
   reading `audit_logs.actor_identity`.
10. **should fix — Vue stale responses and swallowed errors.** `d1-lab-dashboard`
    `SampleDashboard.vue` `selectSample`, `FastDashboard.vue` `fetchOps`; `d1-fast-dashboard`
    `selectOp`/`loadFastRun`, `pollImport` (`:326-338`, 3 min, no cancel, overwrites after op
    change/unmount); `d1-force-crawler/src/Crawler.vue:88-93` (`loading` stuck on first
    rejection, interval with no in-flight guard, actions without `catch`, `recrawlAll` resets
    `processing` rows → double work); `d1-campaign-ops` add/remove without error handling.
11. **should fix — `ProcessCategory.vue:22-60` can blank a stored category.** Hard-coded method →
    category map duplicated in `…031_process_category.sql` (already diverged: `MT`, `MP`); the
    `immediate` watch emits `null` for unmapped codes on existing records. Same pattern possible
    in `MaterialInherit.vue`, `ProjectInherit.vue` (uncertain).
12. **nit — permissions details.** Operator (used by Rig_1 tokens) can set `export_controlled` on
    `physical_samples`; `d1-equipment-code` check-then-insert; `campaign-inherit` depends on
    load order before `d1-default-owner` (uncertain; `09-campaign-inheritance.spec.ts:74` asserts
    only truthiness); `d1-apply-prep-recipe` doesn't check the op type and swallows errors.

## Test gaps

No unit tests for any hook or endpoint (only `d1-geometry-preview`); Playwright specs and
`phase3_api.sh` not run in CI. Needed: non-privileged user → `/d1-report/*`, `/d1-ask/chat` (403);
`actor_identity` non-NULL after an API PATCH; concurrent creates → unique codes; partial owner
cascade; box intake after a delete; `apply.sh` on v11 twice with a changed `permissions.json`.

## Checks run

`node --check` on all hook/endpoint files; `bash -n core/apply.sh`; JSON parse of roles and
permissions; `npm run build -w directus-extension-d1-force-dashboard` OK. shellcheck not installed.
