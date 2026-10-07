"""Lightweight request authentication for the plugin API.

Plugins sit on a private Docker network, but defence-in-depth applies: an
attacker reaching the network must not be able to run arbitrary queries through
the text-to-SQL endpoint. Derived from the plugin template, but it FAILS CLOSED:
this service runs LLM-authored SQL, so with no secret configured it refuses
every request (503) instead of silently running unauthenticated.
"""

import hmac
import logging
import os

from flask import jsonify, request

log = logging.getLogger(__name__)

SECRET_HEADER = "X-Worker-Secret"


def check_secret():
    """Flask before_request hook enforcing the shared-secret header.

    Returns None to allow, or a (response, status) tuple to reject. GET /health
    is exempt. If WORKER_WEBHOOK_SECRET is unset every other route answers 503
    ("not configured") — authentication is never disabled. See .env.example.
    """
    if request.method == "GET" and request.path == "/health":
        return None
    expected = os.getenv("WORKER_WEBHOOK_SECRET", "")
    if not expected:
        return jsonify({"error": "text-to-SQL not configured"}), 503
    provided = request.headers.get(SECRET_HEADER, "")
    if not hmac.compare_digest(provided.encode(), expected.encode()):
        return jsonify({"error": "unauthorized"}), 401
    return None


if not os.getenv("WORKER_WEBHOOK_SECRET"):
    log.warning(
        "WORKER_WEBHOOK_SECRET is not set — every API route will answer 503 "
        "until it is configured."
    )
