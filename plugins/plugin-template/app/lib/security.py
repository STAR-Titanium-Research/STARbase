"""Lightweight request authentication for the plugin webhook.

Plugins sit on a private Docker network, but defence-in-depth applies: an
attacker reaching the network must not be able to enqueue arbitrary jobs. Copy
this verbatim into new plugins.
"""

import hmac
import logging
import os
import re

from flask import jsonify, request

log = logging.getLogger(__name__)

SECRET_HEADER = "X-Worker-Secret"
_OBJECT_KEY_RE = re.compile(r"^[A-Za-z0-9._/\-]+$")


def check_secret():
    """Flask before_request hook enforcing the shared-secret header (fails closed).

    Returns None to allow the request, or a Flask (response, status) tuple to
    reject it. GET /health is always exempt so container healthchecks work.

    If WORKER_WEBHOOK_SECRET is unset or empty every other request is rejected
    with 503: a worker with no secret configured must not accept jobs. A wrong or
    missing header gets 401. See .env.example.
    """
    if request.method == "GET" and request.path == "/health":
        return None
    expected = os.getenv("WORKER_WEBHOOK_SECRET", "")
    if not expected:
        return (
            jsonify({"error": "WORKER_WEBHOOK_SECRET is not configured on the worker"}),
            503,
        )
    provided = request.headers.get(SECRET_HEADER, "")
    if not hmac.compare_digest(provided.encode(), expected.encode()):
        return jsonify({"error": "unauthorized"}), 401
    return None


def valid_object_key(key: str) -> bool:
    """True if *key* is a safe S3 object key (no traversal, allowed chars only)."""
    return bool(key) and ".." not in key and bool(_OBJECT_KEY_RE.match(key))


if not os.getenv("WORKER_WEBHOOK_SECRET"):
    log.error(
        "WORKER_WEBHOOK_SECRET is not set — every request except GET /health "
        "will be rejected with 503."
    )
