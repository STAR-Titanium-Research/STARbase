"""Canonical test_sessions.status vocabulary and the write-back transition rules.

ALLOWED_STATUSES MUST stay in sync with the CHECK constraint defined in
db/migrations/20260619000013_status_vocabulary.sql. The unit test
test_statuses.py asserts that every status this worker emits is a member of
ALLOWED_STATUSES.

This file is identical in heavy-data-worker and analysis-worker (each plugin is
self-contained, so it is duplicated); keep the two in step.
"""

ALLOWED_STATUSES: frozenset[str] = frozenset(
    {
        "registered",
        "pending_processing",
        "processing",
        "processed",
        "analysing",
        "analysed",
        "failed",
    }
)

STATUS_REGISTERED = "registered"
STATUS_PENDING = "pending_processing"
STATUS_PROCESSING = "processing"
STATUS_PROCESSED = "processed"
STATUS_ANALYSING = "analysing"
STATUS_ANALYSED = "analysed"
STATUS_FAILED = "failed"

# Two workers write to the same row (heavy-data-worker: processing/processed,
# analysis-worker: analysing/analysed), so a status write must not regress a
# better outcome. Each target lists the statuses it may overwrite; a write
# whose current status is not listed leaves the status alone (the worker's
# stats/plots are still merged in).
#
#   * a late 'processed' must not overwrite 'analysed' (or an in-flight
#     'analysing');
#   * 'failed' must not overwrite a good result ('processed' / 'analysed');
#   * the "start" marks must not displace the other worker's in-flight status;
#   * 'analysed' is the end of the pipeline and may overwrite anything.
_MAY_OVERWRITE: dict[str, frozenset[str]] = {
    STATUS_PROCESSING: ALLOWED_STATUSES - {STATUS_ANALYSING},
    STATUS_ANALYSING: ALLOWED_STATUSES - {STATUS_PROCESSING},
    STATUS_PROCESSED: frozenset(
        {STATUS_REGISTERED, STATUS_PENDING, STATUS_PROCESSING, STATUS_FAILED}
    ),
    STATUS_ANALYSED: ALLOWED_STATUSES,
    STATUS_FAILED: frozenset(
        {STATUS_REGISTERED, STATUS_PENDING, STATUS_PROCESSING, STATUS_ANALYSING}
    ),
}


def resolve_status(current: str | None, target: str) -> str | None:
    """Return *target* if writing it over *current* is allowed, else None.

    None means "leave the status as it is". An unknown or missing current status
    is treated as 'registered'.
    """
    if current == target:
        return None
    if current not in ALLOWED_STATUSES:
        current = STATUS_REGISTERED
    return target if current in _MAY_OVERWRITE[target] else None
