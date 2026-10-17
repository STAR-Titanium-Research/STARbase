"""Job timing configuration shared by the webhook, the poller and the enqueue helper."""

import os

#: A render reads one topography file and writes three small objects: minutes, not hours.
DEFAULT_JOB_TIMEOUT_SECONDS = 3600
DEFAULT_POLL_INTERVAL_SECONDS = 60


def _positive_int_env(name: str, default: int) -> int:
    try:
        value = int(os.getenv(name, "") or default)
    except ValueError:
        return default
    return value if value > 0 else default


def job_timeout_seconds() -> int:
    """rq ``job_timeout`` for render jobs (env ``JOB_TIMEOUT_SECONDS``, default 1 h).

    rq's own default is 180 s, too short for a large scan on a slow share; a job killed at the limit
    would leave the row in 'rendering' until the poller's sweep fails it.
    """
    return _positive_int_env("JOB_TIMEOUT_SECONDS", DEFAULT_JOB_TIMEOUT_SECONDS)


def poll_interval_seconds() -> int:
    """Seconds between poller passes (env ``POLL_INTERVAL_SECONDS``, default 60, at least 5)."""
    return max(
        5, _positive_int_env("POLL_INTERVAL_SECONDS", DEFAULT_POLL_INTERVAL_SECONDS)
    )
