"""Redis connection selection shared by the webhook and the reaper.

Prefer REDIS_URL (it can carry a password: redis://:pw@redis:6379/0); fall back
to REDIS_HOST / REDIS_PORT so deployments that predate REDIS_URL keep working.
entrypoint.sh applies the same rule for ``rq worker --url``.
"""

import os

from redis import Redis


def redis_url() -> str:
    url = os.getenv("REDIS_URL", "").strip()
    if url:
        return url
    host = os.getenv("REDIS_HOST", "redis")
    port = os.getenv("REDIS_PORT", "6379")
    return f"redis://{host}:{port}"


def get_redis() -> Redis:
    """Return a (lazily connecting) Redis client for the configured URL."""
    return Redis.from_url(redis_url())
