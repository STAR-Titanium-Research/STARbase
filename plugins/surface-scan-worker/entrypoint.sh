#!/bin/bash
# Runs the webhook (gunicorn), SURFACE_SCAN_CONCURRENCY rq workers (default 1, at most 2 renders at a
# time) and the poller. If ANY of them dies the container exits non-zero, so the healthcheck / restart
# policy sees it (a crashed rq worker must not leave /health green).
set -e

CONCURRENCY="${SURFACE_SCAN_CONCURRENCY:-1}"
case "$CONCURRENCY" in
    1|2) ;;
    *) echo "SURFACE_SCAN_CONCURRENCY must be 1 or 2 (got '$CONCURRENCY')" >&2; exit 2 ;;
esac

PIDS=()
_stop_all() {
    kill "${PIDS[@]}" 2>/dev/null || true
}
trap _stop_all TERM INT

gunicorn \
    --bind "0.0.0.0:${WORKER_HTTP_PORT:-8080}" \
    --workers 2 \
    --timeout 30 \
    "app.webhook:app" &
PIDS+=($!)

for _ in $(seq 1 "$CONCURRENCY"); do
    rq worker \
        --url "${REDIS_URL:-redis://${REDIS_HOST:-redis}:${REDIS_PORT:-6379}}" \
        "${QUEUE_NAME:-surface-scan-worker}" &
    PIDS+=($!)
done

python -m app.poller &
PIDS+=($!)

# Block until the first child exits, then take the others down with it.
status=0
wait -n || status=$?
_stop_all
wait 2>/dev/null || true
# A child exiting "cleanly" is still an unexpected death for a long-running service.
if [ "$status" -eq 0 ]; then
    status=1
fi
exit "$status"
