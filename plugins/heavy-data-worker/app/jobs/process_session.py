"""rq job: download a D1F file from MinIO, compute stats, render plot, write back."""

import logging
import os
import tempfile
from pathlib import Path

from app.lib import directus_client, minio_client
from app.lib.parser import parse_header, strided_read
from app.lib.plotter import plot_overview
from app.lib.stats import streaming_stats
from app.lib.statuses import (
    STATUS_FAILED,
    STATUS_PROCESSED,
    STATUS_PROCESSING,
    resolve_status,
)

log = logging.getLogger(__name__)

MEMORY_LIMIT_MB: int = int(os.getenv("WORKER_MEMORY_LIMIT_MB", "256"))
PLOT_MAX_POINTS: int = int(os.getenv("PLOT_MAX_POINTS", "10000"))


def process_session(session_id: str, object_key: str) -> None:
    """End-to-end processing job enqueued via the webhook endpoint.

    Steps:
      1. Mark session status = processing
      2. Stream-download the D1F file from MinIO to a temp file
      3. Parse the 64-byte header
      4. Compute per-channel stats in bounded-size chunks
      5. Generate a downsampled overview SVG plot
      6. Upload the SVG to MinIO
      7. PATCH test_sessions with merged stats + plot URI + status = processed
    """
    log.info("start session=%s object=%s", session_id, object_key)
    _mark(session_id, STATUS_PROCESSING)

    with tempfile.NamedTemporaryFile(suffix=".d1f", delete=False) as tmp:
        tmp_path = tmp.name

    try:
        minio_client.download_file(object_key, tmp_path)

        with open(tmp_path, "rb") as fh:
            header = parse_header(fh)

        # chunk_rows chosen so chunk ≤ MEMORY_LIMIT_MB of float32 data
        chunk_rows = max(
            1024, (MEMORY_LIMIT_MB * 1024 * 1024) // (header["n_channels"] * 4)
        )
        stats = streaming_stats(tmp_path, header, chunk_rows=chunk_rows)

        plot_data = strided_read(tmp_path, header, target_points=PLOT_MAX_POINTS)
        svg_bytes = plot_overview(plot_data, header, title=object_key)

        plot_key = object_key.rsplit(".", 1)[0] + "_overview.svg"
        minio_client.put_object(plot_key, svg_bytes, "image/svg+xml")
        plot_uri = f"minio://{minio_client.BUCKET}/{plot_key}"

        # Read-merge-write under OCC: namespace our stats under "basic" and
        # append our plot so we don't clobber the analysis worker's
        # "fft_analysis"; the status moves to 'processed' only if that does not
        # regress a better outcome (see statuses.resolve_status).
        _merge_outputs(session_id, "basic", stats, plot_uri, STATUS_PROCESSED)
        log.info("done session=%s", session_id)

    except Exception:
        log.exception("failed session=%s", session_id)
        _mark(session_id, STATUS_FAILED)
        raise

    finally:
        try:
            Path(tmp_path).unlink(missing_ok=True)
        except OSError:
            log.warning("could not remove temp file %s", tmp_path)


def _merge_outputs(
    session_id: str,
    stats_key: str,
    stats: dict,
    plot_uri: str,
    target_status: str | None = None,
) -> dict | None:
    """Merge this worker's outputs into the session row, guarded by OCC.

    Reads the row (including ``version``), namespaces our contribution under
    *stats_key*, appends our plot (deduped) and PATCHes with
    ``filter[version][_eq]``; on a conflict it re-reads and re-merges, a bounded
    number of times. If the row can't be read the write is aborted (the
    exception propagates and the job is marked failed) rather than overwriting
    ``summary_stats`` with a fresh object.
    """

    def compute(current: dict) -> dict:
        summary_stats = current.get("summary_stats") or {}
        if not isinstance(summary_stats, dict):
            summary_stats = {}
        summary_stats[stats_key] = stats

        plot_uris = current.get("plot_uris") or []
        if not isinstance(plot_uris, list):
            plot_uris = []
        if plot_uri not in plot_uris:
            plot_uris.append(plot_uri)

        payload: dict = {"summary_stats": summary_stats, "plot_uris": plot_uris}
        if target_status:
            status = resolve_status(current.get("status"), target_status)
            if status:
                payload["status"] = status
        return payload

    return directus_client.update_session(session_id, compute)


def _mark(session_id: str, status: str) -> None:
    """Set *status* if the transition rules allow it; never raises."""
    try:
        directus_client.update_session(
            session_id,
            lambda current: (
                {"status": new}
                if (new := resolve_status(current.get("status"), status))
                else None
            ),
        )
    except Exception:
        log.warning("could not set status=%s for session=%s", status, session_id)
