"""The ``surface_scans.render_status`` vocabulary.

Mirrors the CHECK constraint on ``surface_scans.render_status`` (stream S1's migration, spec
docs/superpowers/specs/2026-10-15-surface-scans-design.md). Import these constants; never hard-code
the strings. (``test_sessions.status``, which the template's copy of this file listed, is not used
by this worker.)
"""

STATUS_PENDING = "pending"
STATUS_RENDERING = "rendering"
STATUS_DONE = "done"
STATUS_FAILED = "failed"

ALLOWED_STATUSES: frozenset[str] = frozenset(
    {STATUS_PENDING, STATUS_RENDERING, STATUS_DONE, STATUS_FAILED}
)
