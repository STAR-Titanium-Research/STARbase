"""Webhook receiver for the surface-scan worker.

Endpoints:
  GET  /health               - liveness probe
  POST /api/webhook/scan     - Directus Flow callback on surface_scans create / update; enqueues a render

The webhook is the fast path; the poller (app/poller.py) is the safety net that picks up any
``pending`` row the Flow missed. Both go through app.queueing.enqueue_render.
"""

import logging
import uuid

from flask import Flask, jsonify, request
from redis.exceptions import RedisError
from rq import Queue

from app.lib.redis_conn import get_redis
from app.lib.security import check_secret
from app.lib.statuses import STATUS_PENDING
from app.queueing import QUEUE_NAME, enqueue_render

log = logging.getLogger(__name__)

app = Flask(__name__)
app.before_request(check_secret)

_redis = get_redis()
_queue = Queue(QUEUE_NAME, connection=_redis)


@app.get("/health")
def health():
    return jsonify({"status": "ok"})


def _scan_id(payload: dict) -> str | None:
    """The scan's primary key from a Flow body ({key} or {keys: [..]}) or a direct call ({scan_id})."""
    raw = payload.get("key") or payload.get("scan_id")
    if not raw and isinstance(payload.get("keys"), list) and len(payload["keys"]) == 1:
        raw = payload["keys"][0]
    try:
        return str(uuid.UUID(str(raw)))
    except (ValueError, AttributeError, TypeError):
        return None


@app.post("/api/webhook/scan")
def webhook_scan():
    """Directus Flow callback. Directus sends ``{event, collection, key, payload: {...}}``.

    A create always enqueues (the row defaults to ``pending``). An update enqueues only when the
    payload sets ``render_status`` to ``pending`` (a "Render again"); any other edit of the row is
    skipped, so the worker's own status writes do not loop back through the Flow.
    """
    body = request.get_json(force=True, silent=True)
    if not isinstance(body, dict):
        return jsonify({"error": "expected a JSON object"}), 400
    scan_id = _scan_id(body)
    if scan_id is None:
        return jsonify({"error": "missing or invalid scan id (key)"}), 400

    item = body.get("payload") if isinstance(body.get("payload"), dict) else {}
    event = str(body.get("event") or "")
    status = item.get("render_status")
    is_update = event.endswith(".update")
    if (is_update and status != STATUS_PENDING) or (status is not None and status != STATUS_PENDING):
        return jsonify({"status": "skipped", "reason": "render_status is not pending"}), 200

    try:
        job, enqueued = enqueue_render(_queue, scan_id)
    except RedisError:
        log.exception("queue unavailable")
        return jsonify({"error": "queue unavailable"}), 503
    if not enqueued:
        return jsonify({"status": "skipped", "reason": "already queued", "job_id": job.id}), 200
    return jsonify({"job_id": job.id}), 202
