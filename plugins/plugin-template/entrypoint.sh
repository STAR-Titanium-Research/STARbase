#!/bin/bash
# Replace QUEUE_NAME with the actual queue for your plugin.
# Runs two processes: the webhook (gunicorn) and the rq worker. If EITHER dies
# the container exits non-zero, so the healthcheck / restart policy sees it (a
# crashed rq worker must not leave /health green).
set -e

_stop_all() {
    kill "$WEBHOOK_PID" "$WORKER_PID" 2>/dev/null || true
}
trap _stop_all TERM INT

gunicorn \
    --bind "0.0.0.0:${WORKER_HTTP_PORT:-8080}" \
    --workers 2 \
    --timeout 30 \
    "app.webhook:app" &
WEBHOOK_PID=$!

rq worker \
    --url "${REDIS_URL:-redis://${REDIS_HOST:-redis}:${REDIS_PORT:-6379}}" \
    "${QUEUE_NAME:-plugin}" &
WORKER_PID=$!

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
