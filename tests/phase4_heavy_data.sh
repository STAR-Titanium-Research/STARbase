#!/usr/bin/env bash
# Phase 4 integration test — heavy-data upload pipeline.
#
# Prerequisites (all must be running):
#   make up && make migrate && make seed && make bootstrap-minio
#   core/apply.sh run (Phase 3) to provision machine user
#   heavy-data-worker running with WORKER_DIRECTUS_TOKEN set
#
# Environment:
#   WORKER_URL      default http://localhost:8080
#   DIRECTUS_URL    default http://localhost:8055
#   MACHINE_TOKEN   Operator machine token from core/apply.sh (required)
#   WORKER_WEBHOOK_SECRET  the same value as in .env (required): the worker rejects every
#                   request without it in X-Worker-Secret. `set -a; . ./.env; set +a` loads it.
#   MINIO_RESOLVE_IP  address that the presigned URLs' host `minio` resolves to for the part
#                   upload (default D1_BIND_ADDR, else 127.0.0.1)
#   N_SAMPLES       synthetic file size in samples (default 100000 ≈ 2.4 MB)

set -euo pipefail

WORKER_URL="${WORKER_URL:-http://localhost:8080}"
DIRECTUS_URL="${DIRECTUS_URL:-http://localhost:8055}"
MACHINE_TOKEN="${MACHINE_TOKEN:-}"
WORKER_WEBHOOK_SECRET="${WORKER_WEBHOOK_SECRET:-}"
MINIO_RESOLVE_IP="${MINIO_RESOLVE_IP:-${D1_BIND_ADDR:-127.0.0.1}}"
N_SAMPLES="${N_SAMPLES:-100000}"
TEST_FILE="/tmp/phase4_test_$(date +%s).d1f"
OBJECT_KEY="test/phase4_$(date +%s).d1f"

PASS=0
FAIL=0

info() { echo "  [INFO] $*"; }
ok()   { echo "  [PASS] $*"; PASS=$((PASS+1)); }
fail() { echo "  [FAIL] $*"; FAIL=$((FAIL+1)); }

require_env() {
    if [[ -z "${!1:-}" ]]; then
        echo "ERROR: $1 is required but not set." >&2
        exit 1
    fi
}

cleanup() { rm -f "$TEST_FILE"; }
trap cleanup EXIT

require_env MACHINE_TOKEN
require_env WORKER_WEBHOOK_SECRET

# ------------------------------------------------------------------ #
echo
echo "=== 1. Worker health ==="
status=$(curl -sf "$WORKER_URL/health" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])" 2>/dev/null \
    || echo "unreachable")
if [[ "$status" == "ok" ]]; then ok "worker healthy"; else fail "worker unreachable or unhealthy ($status)"; fi

# ------------------------------------------------------------------ #
echo
echo "=== 2. Generate synthetic D1F file ==="
info "generating $N_SAMPLES samples → $TEST_FILE"
docker run --rm \
    -v "/tmp:/tmp" \
    d1-heavy-data-worker \
    python tests/generate_test_file.py --output "$TEST_FILE" --n-samples "$N_SAMPLES"
FILE_SIZE=$(stat -c%s "$TEST_FILE")
ok "generated $(du -sh "$TEST_FILE" | cut -f1) ($FILE_SIZE bytes)"

# ------------------------------------------------------------------ #
echo
echo "=== 3. Presign multipart upload ==="
PRESIGN=$(curl -sf -X POST "$WORKER_URL/api/presign-upload" \
    -H "Content-Type: application/json" \
    -H "X-Worker-Secret: $WORKER_WEBHOOK_SECRET" \
    -d "{\"object_key\":\"$OBJECT_KEY\",\"file_size_bytes\":$FILE_SIZE}")
UPLOAD_ID=$(echo "$PRESIGN" | python3 -c "import sys,json; print(json.load(sys.stdin)['upload_id'])")
PART_URL=$(echo "$PRESIGN" | python3 -c "import sys,json; print(json.load(sys.stdin)['parts'][0]['url'])")
[[ -n "$UPLOAD_ID" ]] && ok "upload_id=$UPLOAD_ID" || fail "no upload_id in presign response"

# ------------------------------------------------------------------ #
echo
echo "=== 4. Upload file to MinIO via presigned URL ==="
# The presigned URL names the compose host `minio`; resolve it to the published port.
ETAG=$(curl -sf --resolve "minio:9000:$MINIO_RESOLVE_IP" -X PUT "$PART_URL" \
    --upload-file "$TEST_FILE" \
    -D - \
    | grep -i "^etag:" | tr -d '\r\n' | sed 's/[Ee][Tt][Aa][Gg]:[[:space:]]*//' | tr -d '"')
[[ -n "$ETAG" ]] && ok "part uploaded, ETag=$ETAG" || fail "upload failed or no ETag returned"

# ------------------------------------------------------------------ #
echo
echo "=== 5. Complete multipart upload ==="
COMPLETE=$(curl -sf -X POST "$WORKER_URL/api/complete-upload" \
    -H "Content-Type: application/json" \
    -H "X-Worker-Secret: $WORKER_WEBHOOK_SECRET" \
    -d "{\"object_key\":\"$OBJECT_KEY\",\"upload_id\":\"$UPLOAD_ID\",\"parts\":[{\"PartNumber\":1,\"ETag\":\"$ETAG\"}]}")
POINTER=$(echo "$COMPLETE" | python3 -c "import sys,json; print(json.load(sys.stdin)['file_storage_pointer'])")
[[ -n "$POINTER" ]] && ok "file_storage_pointer=$POINTER" || fail "no file_storage_pointer"

# ------------------------------------------------------------------ #
echo
echo "=== 6. Register test_session via Directus ==="
# Fetch a sample_id to attach the session to
SAMPLE_ID=$(curl -sf "$DIRECTUS_URL/items/physical_samples?limit=1" \
    -H "Authorization: Bearer $MACHINE_TOKEN" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['data'][0]['sample_id'] if d['data'] else '')" 2>/dev/null || echo "")
if [[ -z "$SAMPLE_ID" ]]; then
    fail "no samples found — load seed data first"
else
    SESSION_RESP=$(curl -sf -X POST "$DIRECTUS_URL/items/test_sessions" \
        -H "Authorization: Bearer $MACHINE_TOKEN" \
        -H "Content-Type: application/json" \
        -d "{
            \"sample_id\": \"$SAMPLE_ID\",
            \"test_type\": \"force_monitoring\",
            \"operator_name\": \"phase4_test\",
            \"file_storage_pointer\": \"$POINTER\",
            \"status\": \"pending_processing\"
        }")
    SESSION_ID=$(echo "$SESSION_RESP" | python3 -c \
        "import sys,json; print(json.load(sys.stdin).get('data',{}).get('session_id',''))" 2>/dev/null || echo "")
    [[ -n "$SESSION_ID" ]] && ok "session_id=$SESSION_ID" || fail "failed to create session"
fi

# ------------------------------------------------------------------ #
echo
echo "=== 7. Trigger webhook ==="
if [[ -n "${SESSION_ID:-}" ]]; then
    WEBHOOK_RESP=$(curl -sf -X POST "$WORKER_URL/api/webhook/session" \
        -H "Content-Type: application/json" \
        -H "X-Worker-Secret: $WORKER_WEBHOOK_SECRET" \
        -d "{\"session_id\":\"$SESSION_ID\",\"file_storage_pointer\":\"$POINTER\"}")
    JOB_ID=$(echo "$WEBHOOK_RESP" | python3 -c \
        "import sys,json; print(json.load(sys.stdin).get('job_id',''))" 2>/dev/null || echo "")
    [[ -n "$JOB_ID" ]] && ok "job enqueued job_id=$JOB_ID" || fail "webhook did not return job_id"
fi

# ------------------------------------------------------------------ #
echo
echo "=== 8. Wait for job completion (up to 120 s) ==="
if [[ -n "${SESSION_ID:-}" ]]; then
    for i in $(seq 1 24); do
        sleep 5
        SESSION_STATUS=$(curl -sf "$DIRECTUS_URL/items/test_sessions/$SESSION_ID" \
            -H "Authorization: Bearer $MACHINE_TOKEN" \
            | python3 -c \
                "import sys,json; print(json.load(sys.stdin).get('data',{}).get('status',''))" \
            2>/dev/null || echo "")
        info "poll $i/24: status=$SESSION_STATUS"
        if [[ "$SESSION_STATUS" == "processed" ]]; then
            ok "session processed"
            break
        elif [[ "$SESSION_STATUS" == "failed" ]]; then
            fail "worker reported error on session"
            break
        fi
    done

    # Verify stats and plot URIs were written back
    SESSION_DATA=$(curl -sf "$DIRECTUS_URL/items/test_sessions/$SESSION_ID" \
        -H "Authorization: Bearer $MACHINE_TOKEN")
    HAS_STATS=$(echo "$SESSION_DATA" | python3 -c \
        "import sys,json; d=json.load(sys.stdin).get('data',{}); print('yes' if d.get('summary_stats') else 'no')" \
        2>/dev/null || echo "no")
    HAS_PLOTS=$(echo "$SESSION_DATA" | python3 -c \
        "import sys,json; d=json.load(sys.stdin).get('data',{}); print('yes' if d.get('plot_uris') else 'no')" \
        2>/dev/null || echo "no")
    [[ "$HAS_STATS" == "yes" ]] && ok "summary_stats populated" || fail "summary_stats missing"
    [[ "$HAS_PLOTS" == "yes" ]] && ok "plot_uris populated" || fail "plot_uris missing"
fi

# ------------------------------------------------------------------ #
echo
echo "=== Result ==="
echo "  PASS: $PASS   FAIL: $FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
