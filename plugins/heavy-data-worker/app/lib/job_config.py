"""Job timing configuration shared by the webhook and the reaper."""

import os

DEFAULT_JOB_TIMEOUT_SECONDS = 6 * 3600


def job_timeout_seconds() -> int:
    """rq ``job_timeout`` for this worker's jobs (env ``JOB_TIMEOUT_SECONDS``, default 6 h).

    rq's own default is 180 s, far too short for 10-100 GB files; a job killed at
    the limit would otherwise leave the row in 'processing' forever.
    """
    try:
        value = int(os.getenv("JOB_TIMEOUT_SECONDS", "") or DEFAULT_JOB_TIMEOUT_SECONDS)
    except ValueError:
        return DEFAULT_JOB_TIMEOUT_SECONDS
    return value if value > 0 else DEFAULT_JOB_TIMEOUT_SECONDS
