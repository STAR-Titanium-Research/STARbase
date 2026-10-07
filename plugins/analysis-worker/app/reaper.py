"""Stuck-row reaper: mark abandoned 'analysing' sessions as failed.

A job killed hard (rq job_timeout, OOM, container restart) never reaches its
``except`` block, so the session would stay in ``analysing`` forever, which
docs/plugin-contract.md section 9 forbids. This loop runs beside the webhook and
the rq worker (see entrypoint.sh): on start and then every
``REAPER_INTERVAL_SECONDS`` it finds sessions in ``analysing`` whose
``updated_at`` is older than the job timeout (plus a grace period) and PATCHes
them to ``failed`` with an explanation in ``summary_stats.pipeline_error``.

The PATCH is OCC-guarded and re-checks the row, so a job that finishes at the
last moment is never overwritten.
"""

import logging
import os
import time
from datetime import UTC, datetime, timedelta

from app.lib import directus_client
from app.lib.job_config import job_timeout_seconds
from app.lib.statuses import STATUS_ANALYSING, STATUS_FAILED, resolve_status

log = logging.getLogger("reaper")

WORKER_NAME = "analysis-worker"
#: Statuses this worker owns while a job is in flight.
REAP_STATUSES: tuple[str, ...] = (STATUS_ANALYSING,)

DEFAULT_INTERVAL_SECONDS = 900
DEFAULT_GRACE_SECONDS = 600


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, "") or default)
    except ValueError:
        return default


def _parse_ts(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        ts = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return ts if ts.tzinfo else ts.replace(tzinfo=UTC)


def reap_once(now: datetime | None = None) -> list[str]:
    """Fail every stale in-flight session; return the ids that were marked failed."""
    now = now or datetime.now(UTC)
    timeout = job_timeout_seconds()
    grace = _env_int("REAPER_GRACE_SECONDS", DEFAULT_GRACE_SECONDS)
    cutoff = now - timedelta(seconds=timeout + grace)

    reaped: list[str] = []
    for row in directus_client.list_stale_sessions(REAP_STATUSES, cutoff.isoformat()):
        session_id = row.get("session_id")
        if not session_id:
            continue

        def compute(current: dict, _now: datetime = now, _cutoff: datetime = cutoff):
            if current.get("status") not in REAP_STATUSES:
                return None  # finished or moved on since we listed it
            updated = _parse_ts(current.get("updated_at"))
            if updated is None or updated >= _cutoff:
                return None  # touched recently: not stuck
            if not resolve_status(current.get("status"), STATUS_FAILED):
                return None
            stats = current.get("summary_stats")
            stats = dict(stats) if isinstance(stats, dict) else {}
            stats["pipeline_error"] = {
                "worker": WORKER_NAME,
                "status_was": current.get("status"),
                "message": (
                    f"No result after the {timeout / 3600:g} h job timeout: the job "
                    "timed out or the worker died. Marked failed by the reaper; "
                    "re-run the job."
                ),
                "at": _now.isoformat(),
            }
            return {"status": STATUS_FAILED, "summary_stats": stats}

        try:
            if directus_client.update_session(session_id, compute):
                reaped.append(session_id)
                log.warning("reaped stuck session=%s", session_id)
        except Exception:
            log.exception("could not reap session=%s", session_id)
    return reaped


def run_forever() -> None:
    interval = max(10, _env_int("REAPER_INTERVAL_SECONDS", DEFAULT_INTERVAL_SECONDS))
    logging.basicConfig(level=logging.INFO)
    while True:
        try:
            reap_once()
        except Exception:
            # Directus may be down at container start: keep trying.
            log.exception("reaper pass failed")
        time.sleep(interval)


if __name__ == "__main__":
    run_forever()
