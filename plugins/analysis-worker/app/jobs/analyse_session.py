"""rq job: FFT-based frequency analysis on D1F force files."""

import logging
import os
import tempfile
from pathlib import Path

from app.lib import directus_client, minio_client
from app.lib.d1f_reader import (
    CHANNEL_NAMES,
    available_samples,
    parse_header,
    read_channel_block,
)
from app.lib.fft_analysis import (
    analyse_spectrum,
    compute_spectrum,
    default_nperseg,
    plan_blocks,
    plot_spectrum_from,
)
from app.lib.statuses import (
    STATUS_ANALYSED,
    STATUS_ANALYSING,
    STATUS_FAILED,
    resolve_status,
)

log = logging.getLogger(__name__)

COLLECTION = "test_sessions"
FFT_CHANNEL_INDEX = int(os.getenv("FFT_CHANNEL_INDEX", "2"))  # default: Fz
# Welch segment length (0 = adapt to the sample rate) and the cap on how many
# evenly spaced contiguous blocks are read from a large file.
FFT_NPERSEG = int(os.getenv("FFT_NPERSEG", "0"))
FFT_MAX_BLOCKS = int(os.getenv("FFT_MAX_BLOCKS", "32"))


def analyse_session(session_id: str, object_key: str) -> None:
    """Compute per-channel FFT metrics for a D1F file and write back to Directus.

    Pipeline:
      1. Mark session status = 'analysing'
      2. Download D1F from MinIO to temp file
      3. Parse header
      4. Read primary force channel (Fz by default) as contiguous blocks at the
         native sample rate (no decimation)
      5. Welch amplitude spectrum + distinct peaks + band energy
      6. Generate spectrum SVG plot
      7. Upload SVG to MinIO
      8. PATCH test_sessions with fft_analysis results + plot URI
    """
    log.info("start analysis session=%s object=%s", session_id, object_key)
    _mark(session_id, STATUS_ANALYSING)

    with tempfile.NamedTemporaryFile(suffix=".d1f", delete=False) as tmp:
        tmp_path = tmp.name

    try:
        minio_client.download_file(object_key, tmp_path)

        with open(tmp_path, "rb") as fh:
            header = parse_header(fh)

        n_ch = header["n_channels"]
        ch_idx = min(FFT_CHANNEL_INDEX, n_ch - 1)
        ch_name = (
            CHANNEL_NAMES[ch_idx] if ch_idx < len(CHANNEL_NAMES) else f"Ch{ch_idx}"
        )
        ch_unit = "N" if ch_idx < 3 else "Nm"

        fs = header["sample_rate_hz"]
        n_avail = available_samples(tmp_path, header)
        nperseg = min(FFT_NPERSEG or default_nperseg(fs), n_avail)
        blocks = plan_blocks(n_avail, nperseg, FFT_MAX_BLOCKS)
        spec = compute_spectrum(
            (read_channel_block(tmp_path, header, ch_idx, st, n) for st, n in blocks),
            fs,
            nperseg,
        )
        if spec is None:
            msg = "insufficient samples for FFT"
            raise ValueError(msg)
        metrics = analyse_spectrum(spec)

        svg_bytes = plot_spectrum_from(spec, ch_name, ch_unit)
        plot_key = object_key.rsplit(".", 1)[0] + f"_fft_{ch_name}.svg"
        minio_client.put_object(plot_key, svg_bytes, "image/svg+xml")
        plot_uri = f"minio://{minio_client.BUCKET}/{plot_key}"

        analysis_result = {
            "channel": ch_name,
            "channel_index": ch_idx,
            "n_samples_analysed": spec.n_samples,
            "n_samples_total": n_avail,
            "stride": 1,  # kept for schema compatibility: no decimation any more
            "effective_sample_rate_hz": fs,
            **metrics,
        }

        # Read-merge-write under OCC: namespace our stats under "fft_analysis"
        # and append our plot so we don't clobber the heavy-data worker's
        # "basic" stats; the status moves to 'analysed' only if the transition
        # rules allow it (see statuses.resolve_status).
        _merge_outputs(
            session_id, "fft_analysis", analysis_result, plot_uri, STATUS_ANALYSED
        )
        log.info(
            "done analysis session=%s dominant_freq=%.1f Hz",
            session_id,
            metrics.get("dominant_frequency_hz", 0),
        )

    except Exception:
        log.exception("failed analysis session=%s", session_id)
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
