"""Webhook receiver for the analysis worker.

Endpoints:
  GET  /health                — liveness probe
  POST /api/webhook/session   — Directus Flow callback; enqueues FFT analysis job
"""

import os

from flask import Flask, jsonify, request
from rq import Queue

from app.jobs.analyse_session import analyse_session
from app.lib import minio_client
from app.lib.job_config import job_timeout_seconds
from app.lib.redis_conn import get_redis
from app.lib.security import check_secret, valid_object_key

app = Flask(__name__)
app.before_request(check_secret)

_redis = get_redis()
_queue = Queue(os.getenv("QUEUE_NAME", "analysis"), connection=_redis)


@app.get("/health")
def health():
    return jsonify({"status": "ok"})


@app.post("/api/webhook/session")
def webhook_session():
    """Directus Flow callback — enqueue FFT analysis for a test_session."""
    payload = request.get_json(force=True)

    session_id = payload.get("key") or payload.get("session_id")
    item_payload = payload.get("payload") or payload
    raw_pointer: str = item_payload.get("file_storage_pointer") or ""
    prefix = f"minio://{minio_client.BUCKET}/"

    if not session_id:
        return jsonify({"error": "missing session_id / key"}), 400
    # The Flow fires on every test_sessions create, including sessions that have no file for
    # this worker (no pointer, or a pointer into another store). Those are not errors: answer
    # 200 without enqueueing so the Flow does not log a failed run each time.
    if not raw_pointer:
        return jsonify({"status": "skipped", "reason": "no file_storage_pointer"}), 200
    if "://" in raw_pointer and not raw_pointer.startswith(prefix):
        return (
            jsonify(
                {
                    "status": "skipped",
                    "reason": "file_storage_pointer is not a MinIO pointer",
                }
            ),
            200,
        )
    object_key = (
        raw_pointer[len(prefix) :] if raw_pointer.startswith(prefix) else raw_pointer
    )
    if not valid_object_key(object_key):
        return jsonify({"error": "invalid object_key"}), 400

    job = _queue.enqueue(
        analyse_session, session_id, object_key, job_timeout=job_timeout_seconds()
    )
    return jsonify({"job_id": job.id}), 202
