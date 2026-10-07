#!/usr/bin/env bash
# Phase 3 API test: verifies Directus RBAC, authentication, sample CRUD with
# OCC, manufacturing operation creation, machine token auth, and audit log
# capture via the REST API.
#
# Requires a running Directus instance with the Phase 1 schema applied and
# core/apply.sh already executed.
#
# Usage:
#   DIRECTUS_URL=http://localhost:8055 \
#   DIRECTUS_ADMIN_EMAIL=admin@example.com \
#   DIRECTUS_ADMIN_PASSWORD=secret \
#   bash tests/phase3_api.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

# Load .env if present
if [[ -f "$ROOT/.env" ]]; then
    # shellcheck disable=SC1091
    set -a; source "$ROOT/.env"; set +a
fi

: "${DIRECTUS_URL:?DIRECTUS_URL must be set (e.g. http://localhost:8055)}"
: "${DIRECTUS_ADMIN_EMAIL:?DIRECTUS_ADMIN_EMAIL must be set}"
: "${DIRECTUS_ADMIN_PASSWORD:?DIRECTUS_ADMIN_PASSWORD must be set}"

# ── Helpers (same pattern as phase1_schema.sh) ────────────────────────────────
pass=0; fail=0
ok()  { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
run() {
    # run "label" <result> — pass if result is non-empty
    local label="$1" result="$2"
    [[ -n "$result" && "$result" != "null" ]] && ok "$label" || bad "$label (empty or null result)"
}
run_eq() {
    # run_eq "label" <result> "expected"
    local label="$1" result="$2" expected="$3"
    [[ "$result" == "$expected" ]] && ok "$label" || bad "$label (got '$result', want '$expected')"
}

# Authenticated curl helper; set AUTH_TOKEN before using. -g: Directus filters are written
# filter[field][_op]=..., and without -g curl treats the brackets as a URL glob and fails
# (exit 3) before sending anything.
api() {
    local method="$1" path="$2"; shift 2
    curl -sfg -X "$method" "$DIRECTUS_URL$path" \
        -H "Authorization: Bearer $AUTH_TOKEN" \
        -H "Content-Type: application/json" \
        "$@"
}

# Like api(), but keeps the response of a 4xx/5xx and reports the HTTP status separately, so a
# check can assert the exact status instead of treating "curl failed" as success or failure.
# Sets HTTP_STATUS (000 when curl itself failed) and HTTP_BODY.
HTTP_STATUS=""; HTTP_BODY=""
api_status() {
    local method="$1" path="$2"; shift 2
    local out
    out=$(curl -sg -w '\n%{http_code}' -X "$method" "$DIRECTUS_URL$path" \
        -H "Authorization: Bearer $AUTH_TOKEN" \
        -H "Content-Type: application/json" \
        "$@") || out=$'\n000'
    HTTP_STATUS="${out##*$'\n'}"
    HTTP_BODY="${out%$'\n'*}"
}

# ── Globals for IDs created during the test ───────────────────────────────────
TEST_SAMPLE_ID=""
TEST_OP_ID=""
MACHINE_TOKEN="${D1_RIG1_TOKEN:-}"   # optional — set if machine user was provisioned

# ── 1. Health check ───────────────────────────────────────────────────────────
echo "== Health endpoint =="
health_status=$(curl -sf "$DIRECTUS_URL/server/health" 2>/dev/null \
    | jq -r '.status' 2>/dev/null || true)
run_eq "GET /server/health → ok" "$health_status" "ok"

# ── 2. Authentication ─────────────────────────────────────────────────────────
echo
echo "== Authentication =="
auth_response=$(curl -sf -X POST "$DIRECTUS_URL/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$DIRECTUS_ADMIN_EMAIL\",\"password\":\"$DIRECTUS_ADMIN_PASSWORD\"}" \
    2>/dev/null || true)
AUTH_TOKEN=$(echo "$auth_response" | jq -r '.data.access_token // empty')
run "POST /auth/login → access_token present" "$AUTH_TOKEN"

# Abort if we can't auth — everything else depends on it
if [[ -z "$AUTH_TOKEN" ]]; then
    printf '\033[31mFATAL\033[0m Cannot authenticate — aborting remaining tests\n'
    echo
    echo "Results: $pass passed, $fail failed"
    exit 1
fi

# ── 3. Collections visible ────────────────────────────────────────────────────
echo
echo "== Collections visible =="
collections_json=$(api GET "/collections" 2>/dev/null || true)

for col in physical_samples manufacturing_operations test_sessions audit_logs; do
    found=$(echo "$collections_json" \
        | jq -r --arg c "$col" '.data[] | select(.collection == $c) | .collection' \
        2>/dev/null || true)
    run "collection $col visible" "$found"
done

# ── 4. Machine token auth ─────────────────────────────────────────────────────
echo
echo "== Machine token authentication =="
if [[ -n "$MACHINE_TOKEN" ]]; then
    machine_me=$(curl -sf "$DIRECTUS_URL/users/me" \
        -H "Authorization: Bearer $MACHINE_TOKEN" 2>/dev/null || true)
    machine_email=$(echo "$machine_me" | jq -r '.data.email // empty')
    run "machine token → GET /users/me returns user" "$machine_email"
    run_eq "machine user email is rig1@d1-internal.local" "$machine_email" "rig1@d1-internal.local"
else
    printf '  \033[33mSKIP\033[0m machine token tests (D1_RIG1_TOKEN not set)\n'
fi

# ── 5. Sample CRUD with OCC ───────────────────────────────────────────────────
echo
echo "== Sample CRUD =="

# 5a. Create
TEST_SAMPLE_CODE="TEST-P3-$(date +%s)"
create_response=$(api POST "/items/physical_samples" \
    -d "{\"sample_code\":\"$TEST_SAMPLE_CODE\",\"current_status\":\"active\",\"export_controlled\":false}" \
    2>/dev/null || true)
TEST_SAMPLE_ID=$(echo "$create_response" | jq -r '.data.sample_id // empty')
run "POST /items/physical_samples → sample created" "$TEST_SAMPLE_ID"
init_version=$(echo "$create_response" | jq -r '.data.version // empty')
run_eq "new sample version = 1" "$init_version" "1"

if [[ -z "$TEST_SAMPLE_ID" ]]; then
    bad "sample_id missing — skipping dependent sample tests"
else
    # 5b. Read back
    read_response=$(api GET "/items/physical_samples/$TEST_SAMPLE_ID" 2>/dev/null || true)
    read_code=$(echo "$read_response" | jq -r '.data.sample_code // empty')
    run_eq "GET /items/physical_samples/{id} → correct sample_code" "$read_code" "$TEST_SAMPLE_CODE"

    # 5c. Read by sample_code filter (MATLAB pre-test query)
    filter_response=$(api GET \
        "/items/physical_samples?filter[sample_code][_eq]=$TEST_SAMPLE_CODE&fields=*" \
        2>/dev/null || true)
    filter_count=$(echo "$filter_response" | jq '.data | length' 2>/dev/null || echo "0")
    run_eq "GET ?filter[sample_code][_eq]=... → 1 result" "$filter_count" "1"

    # 5d. Successful OCC update (version matches)
    patch_v1=$(api PATCH \
        "/items/physical_samples/$TEST_SAMPLE_ID?filter[version][_eq]=1" \
        -d '{"notes":"first update","current_status":"active"}' \
        2>/dev/null || true)
    patched_version=$(echo "$patch_v1" | jq -r '.data.version // empty')
    run_eq "PATCH with correct version → version increments to 2" "$patched_version" "2"

    # 5e. Stale OCC update (version already incremented — use old version 1).
    # Contract (docs/api-contract.md §7.2, §12.2): HTTP 200 with "data": null (or an empty
    # data array). Anything else — a 4xx/5xx, a connection failure, or a body that carries
    # the record — is NOT the documented conflict signal and must fail.
    api_status PATCH "/items/physical_samples/$TEST_SAMPLE_ID?filter[version][_eq]=1" \
        -d '{"notes":"stale update"}'
    if [[ "$HTTP_STATUS" == "200" ]] && echo "$HTTP_BODY" \
        | jq -e 'has("data") and (.data == null or (.data | type == "array" and length == 0))' \
            >/dev/null 2>&1; then
        ok "PATCH with stale version → 200 with data:null (OCC conflict detected)"
    else
        bad "PATCH with stale version → want 200 + null/empty data, got HTTP $HTTP_STATUS: $HTTP_BODY"
    fi
    stale_notes=$(api GET "/items/physical_samples/$TEST_SAMPLE_ID" 2>/dev/null \
        | jq -r '.data.notes // empty')
    run_eq "stale patch left notes untouched" "$stale_notes" "first update"

    # Verify version is still 2 (stale patch had no effect)
    check_version=$(api GET "/items/physical_samples/$TEST_SAMPLE_ID" 2>/dev/null \
        | jq -r '.data.version // empty')
    run_eq "version still 2 after stale patch" "$check_version" "2"
fi

# ── 6. Manufacturing operation creation ───────────────────────────────────────
echo
echo "== Manufacturing operation creation =="

if [[ -z "$TEST_SAMPLE_ID" ]]; then
    bad "no sample_id — skipping manufacturing operation tests"
else
    # Look up a method_id and equipment_id from reference tables
    method_response=$(api GET "/items/manufacturing_methods?limit=1&fields=method_id" \
        2>/dev/null || true)
    METHOD_ID=$(echo "$method_response" | jq -r '.data[0].method_id // empty')

    equip_response=$(api GET "/items/equipment?limit=1&fields=equipment_id" \
        2>/dev/null || true)
    EQUIP_ID=$(echo "$equip_response" | jq -r '.data[0].equipment_id // empty')

    run "reference: manufacturing_methods has at least one row" "$METHOD_ID"
    run "reference: equipment has at least one row" "$EQUIP_ID"

    if [[ -n "$METHOD_ID" && -n "$EQUIP_ID" ]]; then
        op_payload=$(jq -n \
            --arg sample_id "$TEST_SAMPLE_ID" \
            --arg method_id "$METHOD_ID" \
            --arg equipment_id "$EQUIP_ID" \
            --arg operator "Test_Operator" \
            --arg op_date "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
            --arg pass_code "TEST-P3-PASS-1" \
            '{sample_id:$sample_id, method_id:$method_id, equipment_id:$equipment_id,
              operator_name:$operator, operation_date:$op_date, pass_code:$pass_code,
              recorded_metadata:{"test":true}}')
        op_response=$(api POST "/items/manufacturing_operations" \
            -d "$op_payload" 2>/dev/null || true)
        TEST_OP_ID=$(echo "$op_response" | jq -r '.data.operation_id // empty')
        run "POST /items/manufacturing_operations → operation created" "$TEST_OP_ID"
        op_version=$(echo "$op_response" | jq -r '.data.version // empty')
        run_eq "new operation version = 1" "$op_version" "1"
    else
        printf '  \033[33mSKIP\033[0m operation creation (no reference rows found — seed data missing?)\n'
    fi
fi

# ── 7. Audit log capture ──────────────────────────────────────────────────────
echo
echo "== Audit log capture =="

if [[ -z "$TEST_SAMPLE_ID" ]]; then
    bad "no sample_id — skipping audit log tests"
else
    # Allow a moment for trigger to flush (should be synchronous, but just in case)
    sleep 1

    # Check INSERT was captured
    audit_insert=$(api GET \
        "/items/audit_logs?filter[table_name][_eq]=physical_samples&filter[action_type][_eq]=INSERT&filter[record_id][_eq]=$TEST_SAMPLE_ID&limit=1" \
        2>/dev/null || true)
    insert_count=$(echo "$audit_insert" | jq '.data | length' 2>/dev/null || echo "0")
    run_eq "audit_logs has INSERT for test sample" "$insert_count" "1"

    # Check UPDATE was captured (we did two PATCH operations — version 1→2)
    audit_update=$(api GET \
        "/items/audit_logs?filter[table_name][_eq]=physical_samples&filter[action_type][_eq]=UPDATE&filter[record_id][_eq]=$TEST_SAMPLE_ID&limit=10" \
        2>/dev/null || true)
    update_count=$(echo "$audit_update" | jq '.data | length' 2>/dev/null || echo "0")
    # At least 1 UPDATE (successful patch); stale patch matched nothing so no extra entry
    if [[ "$update_count" -ge 1 ]]; then
        ok "audit_logs has at least 1 UPDATE for test sample (got $update_count)"
    else
        bad "audit_logs UPDATE count — got $update_count, want >= 1"
    fi

    # Check row_before is populated on UPDATE
    first_update=$(echo "$audit_update" | jq -r '.data[0].row_before' 2>/dev/null || true)
    if [[ -n "$first_update" && "$first_update" != "null" ]]; then
        ok "audit UPDATE has row_before populated"
    else
        bad "audit UPDATE row_before is null or missing"
    fi

    # The PATCH is attributed to the signed-in admin (actor-identity hook, or the
    # directus_activity fallback of migration 128). v_audit_logs_with_actor is not exposed through
    # the API, so this needs direct database access; it is skipped without DATABASE_URL.
    if [[ -n "${DATABASE_URL:-}" ]] && command -v psql >/dev/null; then
        admin_id=$(api GET "/users/me?fields=id" 2>/dev/null | jq -r '.data.id // empty')
        update_actor=$(psql "$DATABASE_URL" -tAc \
            "SELECT actor_identity FROM v_audit_logs_with_actor
             WHERE table_name = 'physical_samples' AND action_type = 'UPDATE'
               AND record_id = '$TEST_SAMPLE_ID'
             ORDER BY log_id DESC LIMIT 1" 2>/dev/null || true)
        run_eq "audit UPDATE attributed to the signed-in user" "$update_actor" "$admin_id"
    else
        printf '  \033[33mSKIP\033[0m audit actor check (needs DATABASE_URL and psql)\n'
    fi

    # Check row_after is populated on UPDATE
    first_update_after=$(echo "$audit_update" | jq -r '.data[0].row_after' 2>/dev/null || true)
    run "audit UPDATE has row_after populated" "$first_update_after"

    # Verify audit_logs is immutable — attempt an update (should be silently blocked by DB rule)
    first_log_id=$(echo "$audit_insert" | jq -r '.data[0].log_id // empty')
    if [[ -n "$first_log_id" ]]; then
        # Directus will return a permission error (Operator/Researcher cannot update audit_logs)
        # We test using admin token — even admin should be blocked by the DB-level rule
        update_audit_response=$(api PATCH "/items/audit_logs/$first_log_id" \
            -d '{"table_name":"tampered"}' 2>/dev/null || true)
        tampered=$(api GET "/items/audit_logs/$first_log_id" 2>/dev/null \
            | jq -r '.data.table_name // empty')
        if [[ "$tampered" == "physical_samples" ]]; then
            ok "audit_logs UPDATE is blocked (table_name unchanged)"
        else
            bad "audit_logs UPDATE not blocked (table_name = '$tampered')"
        fi
    fi
fi

# ── 8. Role isolation — Researcher cannot write ───────────────────────────────
echo
echo "== Role isolation =="
# This test requires a Researcher-role user to be provisioned.
# If DIRECTUS_RESEARCHER_EMAIL / DIRECTUS_RESEARCHER_PASSWORD are set, test them.
RESEARCHER_EMAIL="${DIRECTUS_RESEARCHER_EMAIL:-}"
RESEARCHER_PASSWORD="${DIRECTUS_RESEARCHER_PASSWORD:-}"

if [[ -n "$RESEARCHER_EMAIL" && -n "$RESEARCHER_PASSWORD" ]]; then
    researcher_auth=$(curl -sf -X POST "$DIRECTUS_URL/auth/login" \
        -H "Content-Type: application/json" \
        -d "{\"email\":\"$RESEARCHER_EMAIL\",\"password\":\"$RESEARCHER_PASSWORD\"}" \
        2>/dev/null || true)
    RESEARCHER_TOKEN=$(echo "$researcher_auth" | jq -r '.data.access_token // empty')
    run "Researcher POST /auth/login → token acquired" "$RESEARCHER_TOKEN"

    if [[ -n "$RESEARCHER_TOKEN" ]]; then
        # Researcher must not be able to create a sample: assert the exact 403 (curl -f would
        # have hidden both the status and the body).
        RESEARCHER_CODE="RESEARCHER-ATTEMPT-$(date +%s)"
        OLD_TOKEN="$AUTH_TOKEN"
        AUTH_TOKEN="$RESEARCHER_TOKEN"
        api_status POST "/items/physical_samples" \
            -d "{\"sample_code\":\"$RESEARCHER_CODE\",\"current_status\":\"active\"}"
        AUTH_TOKEN="$OLD_TOKEN"
        run_eq "Researcher POST /items/physical_samples → HTTP 403" "$HTTP_STATUS" "403"
        err_code=$(echo "$HTTP_BODY" | jq -r '.errors[0].extensions.code // empty' 2>/dev/null || true)
        run_eq "Researcher POST error code is FORBIDDEN" "$err_code" "FORBIDDEN"

        # ...and nothing was written
        leaked=$(api GET "/items/physical_samples?filter[sample_code][_eq]=$RESEARCHER_CODE&fields=sample_id" \
            2>/dev/null | jq -r '.data | length' 2>/dev/null || echo "?")
        run_eq "Researcher attempt created no sample" "$leaked" "0"
    fi
else
    printf '  \033[33mSKIP\033[0m Researcher isolation (DIRECTUS_RESEARCHER_EMAIL not set)\n'
fi

# ── 9. Cleanup ────────────────────────────────────────────────────────────────
echo
echo "== Cleanup test records =="

if [[ -n "$TEST_OP_ID" ]]; then
    api DELETE "/items/manufacturing_operations/$TEST_OP_ID" >/dev/null 2>&1 || true
    ok "deleted test manufacturing_operation"
fi

if [[ -n "$TEST_SAMPLE_ID" ]]; then
    api DELETE "/items/physical_samples/$TEST_SAMPLE_ID" >/dev/null 2>&1 || true
    ok "deleted test physical_sample"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo
echo "Results: $pass passed, $fail failed"
[[ $fail -eq 0 ]] || exit 1
echo "Phase 3 API OK."
