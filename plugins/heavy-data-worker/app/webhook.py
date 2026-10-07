"""Webhook receiver and presigned-upload API for the heavy-data worker.

Endpoints:
  GET  /health                — liveness probe
  POST /api/presign-upload    — start a MinIO multipart upload; return part URLs
  POST /api/complete-upload   — finalise a MinIO multipart upload
  POST /api/webhook/session   — Directus Flow callback; enqueues processing job
"""

import math
import os

from flask import Flask, jsonify, request
from rq import Queue

from app.jobs.process_session import process_session
from app.lib import minio_client
from app.lib.job_config import job_timeout_seconds
from app.lib.redis_conn import get_redis
from app.lib.security import (
    MAX_UPLOAD_BYTES,
    check_secret,
    valid_object_key,
)

app = Flask(__name__)
app.before_request(check_secret)

_redis = get_redis()
_queue = Queue("heavy-data", connection=_redis)

PART_SIZE_BYTES: int = int(os.getenv("UPLOAD_PART_SIZE_BYTES", str(100 * 1024 * 1024)))


@app.get("/health")
def health():
    return jsonify({"status": "ok"})


@app.post("/api/presign-upload")
def presign_upload():
    """Return a multipart UploadId plus a presigned PUT URL for each part.

    Request JSON: {object_key, file_size_bytes, content_type?}
    Response JSON: {upload_id, object_key, parts: [{part_number, url}]}
    """
    body = request.get_json(force=True)
    object_key: str = body["object_key"]
    file_size: int = int(body["file_size_bytes"])
    content_type: str = body.get("content_type", "application/octet-stream")

    if not valid_object_key(object_key):
        return jsonify({"error": "invalid object_key"}), 400
    if file_size <= 0 or file_size > MAX_UPLOAD_BYTES:
        return jsonify({"error": "file_size_bytes out of range"}), 400

    n_parts = max(1, math.ceil(file_size / PART_SIZE_BYTES))
    upload_id = minio_client.create_multipart_upload(object_key, content_type)
    parts = [
        {
            "part_number": i,
            "url": minio_client.presign_part(object_key, upload_id, i),
        }
        for i in range(1, n_parts + 1)
    ]
    return jsonify({"upload_id": upload_id, "object_key": object_key, "parts": parts})


@app.post("/api/complete-upload")
def complete_upload():
    """Finalise a multipart upload and return the file_storage_pointer.

    Request JSON: {object_key, upload_id, parts: [{PartNumber, ETag}]}
    Response JSON: {file_storage_pointer}
    """
    body = request.get_json(force=True)
    object_key: str = body["object_key"]
    upload_id: str = body["upload_id"]
    parts: list = body["parts"]

    if not valid_object_key(object_key):
        return jsonify({"error": "invalid object_key"}), 400

    minio_client.complete_multipart_upload(object_key, upload_id, parts)
    pointer = f"minio://{minio_client.BUCKET}/{object_key}"
    return jsonify({"file_storage_pointer": pointer})


@app.post("/api/webhook/session")
def webhook_session():
    """Directus Flow webhook: enqueue a processing job for a new test_session.

    Directus sends: {event, collection, action, key, payload: {...}}
    Direct test call may omit the envelope: {session_id, object_key}.
    """
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
        process_session, session_id, object_key, job_timeout=job_timeout_seconds()
    )
    return jsonify({"job_id": job.id}), 202
