"""Finalize a capture: read the raw memmap in constant memory, sum + gain the dyno channels,
derive RPM + cumulative revs + cut window, and write the deliverables — a .mat (v1.0 layout), a
live_cache.bin (D1LC, so the plotting UI renders it directly), and summary.json.

The .mat DATA layout is [Time, Fx1,Fx2,Fy1,Fy2,Fz1,Fz2,Fz3,Fz4, Tacho] (v1.0), identical to what
the MATLAB app writes, so downstream tooling (process_force.m, the Directus crawler) is unchanged
— any configured extra (Aux/virtual) channels are strictly APPENDED after these 10, never inserted
among them, so a capture with none configured (which includes every capture recorded before extra
channels existed) still produces the exact original layout.

live_cache.bin (D1LC) does NOT get extra channels: that format is byte-identical across this app,
plugins/filter-service, and scripts/matlab/process_force.m — extending it needs coordinated changes
across all three, which is out of scope here. A virtual/Aux channel is archived in capture.mat and
streamed live (see session.py), but not shown if a finished capture is reopened in the Plot page.
"""

from __future__ import annotations

import os

import numpy as np
from scipy.io import savemat
from scipy.signal import detrend

from . import virtual_channels
from .config import SIGNAL_CHANNELS, RecordConfig
from .d1lc import write_d1lc
from .d1rw import memmap_rows, read_header
from .dsp import drift_check, order_spectrum_quick, rpm_from_tacho, sum_axes, tacho_column
from .storage import atomic_write_json

VAR_NAMES = ["Time"] + SIGNAL_CHANNELS  # 10 columns
LIVE_CACHE_TARGET = 300_000  # decimate the cache to ~this many points for the client
# MAT5's data-element header holds a size in a 32-bit field (scipy hits this as an OverflowError,
# "Python int too large to convert to C long", once the uncompressed array crosses roughly 2GB) --
# this is a format ceiling, not a scipy bug, so oversized captures skip the .mat write entirely
# rather than crash finalize (see #40: a ~245M-sample capture allocated 19.6GB for `data` and then
# blew past this ceiling, taking the whole app down with it). Threshold has generous headroom
# under the real ~2^31 byte limit.
MAT_MAX_BYTES = 1_500_000_000


def _cut_window(fz: np.ndarray, t: np.ndarray, frac: float = 0.2) -> tuple[float, float]:
    """First/last time |Fz| exceeds `frac` of its peak — the active-cut window."""
    a = np.abs(fz)
    if a.size == 0 or a.max() <= 0:
        return (float(t[0]) if t.size else 0.0, float(t[-1]) if t.size else 0.0)
    thr = frac * a.max()
    on = np.flatnonzero(a > thr)
    return (float(t[on[0]]), float(t[on[-1]])) if on.size else (float(t[0]), float(t[-1]))


def finalize(capture_dir: str, cfg: RecordConfig, gain: float = 1.0) -> dict:
    raw_path = os.path.join(capture_dir, "raw.d1raw")
    hdr = read_header(raw_path)
    fs = float(hdr["rate"])
    # (n, 1 + 9 + H) memmap — H is however many source="hardware" extra channels were configured
    # for this capture (0 for anything recorded before extra channels existed, or with none set).
    rows = memmap_rows(raw_path)
    n = rows.shape[0]
    t = np.asarray(rows[:, 0], dtype=np.float64)
    # The fixed layout is ALWAYS exactly columns 1:10, regardless of how wide the file is — extra
    # hardware columns (if any) follow at 10: and are handled separately below, kept apart from the
    # gain/drift-compensation logic that is specific to the 8 charge-amp dyno channels.
    # np.array, not asarray: one owned, writable copy -- the gains below scale it in place.
    signals = np.array(rows[:, 1:10], dtype=np.float64)  # (n, 9) in SIGNAL_CHANNELS order
    hw_extra_raw = np.array(rows[:, 10:], dtype=np.float64) if rows.shape[1] > 10 else None
    # Apply volts→N gain to the 8 charge channels (Tacho is the last column — leave it). Per-channel
    # gains (from the amp's auto-ranged ranges) calibrate each channel independently; otherwise the
    # scalar gain applies (sim/replay data is already in N, so gain 1).
    gains = list(cfg.dyno_gains or [])
    if len(gains) >= 8:
        for i in range(8):
            signals[:, i] *= float(gains[i])
    else:
        signals[:, :8] *= gain

    # Per-channel ranging info (for the converging between-cuts auto-range): the peak force each
    # sensor channel saw, whether it railed (clipped), and the per-cut N/V + range that produced it.
    vfs = float(cfg.analog_fullscale_v or 10.0)
    chan_gains = [float(g) for g in gains[:8]] if len(gains) >= 8 else [float(gain)] * 8
    chan_ranges = [g * vfs for g in chan_gains]
    chan_peaks = [float(np.max(np.abs(signals[:, i]))) if n else 0.0 for i in range(8)]
    # Clipping only meaningful with real per-channel gains (nidaq path); sim/replay never rails.
    chan_clipped = [
        bool(len(gains) >= 8 and chan_ranges[i] > 0 and chan_peaks[i] >= 0.99 * chan_ranges[i])
        for i in range(8)
    ]

    # Snapshot the pre-correction axes for local_diag.drift below: that check must answer "did
    # this capture actually drift", independent of whether drift_comp correction is enabled --
    # sum_axes() returns freshly summed arrays, not views, so this is unaffected by the in-place
    # detrend() two lines down.
    raw_axes = sum_axes(signals)

    # Optional linear drift compensation on the 8 dyno channels (like the MATLAB app's driftComp).
    # Only affects the derived outputs (.mat DATA + live_cache); the raw .d1raw is never touched.
    drift_corrected = cfg.drift_comp and n > 1
    if drift_corrected:
        signals[:, :8] = detrend(signals[:, :8], axis=0, type="linear")

    axes = sum_axes(signals) if drift_corrected else raw_axes  # both only ever read below
    tacho = tacho_column(signals)
    # No fallback to cfg.rpm: this is the ARCHIVED record. Substituting the configured spindle speed
    # for an unmeasured one wrote a fabricated rate into capture.mat and the revs column, where
    # nothing downstream could tell it apart from a real measurement. Unmeasured stays 0 and is
    # recorded as such in summary.json (tacho_measured) so the gap is visible rather than papered over.
    rpm, tacho_measured = rpm_from_tacho(tacho, fs, cfg.ppr)
    dt = 1.0 / fs
    revs_cum = np.cumsum(rpm / 60.0 * dt)
    cs_sec, ce_sec = _cut_window(axes["Fz"], t)

    # Local tier (Component 8, deliberately thin): a quick order spectrum + a drift-detection
    # flag, computed here because finalize() only ever runs after the acquisition loop has
    # stopped (see session.py's _run -> self.raw.close() -> _finalize_async) -- this is what
    # makes "never runs during recording" structural rather than a rule this function has to
    # separately enforce. Both are restricted to the cut window (cs_sec..ce_sec) just detected
    # above: without that, a quiet air-cut lead-in ahead of a steady, genuinely non-drifting cut
    # reads as one large linear "drift" (the step between the two regions), and the order
    # spectrum gets diluted by non-cutting revolutions that were never in the material. The
    # order spectrum also needs a real revs_cum to resample against; without a measured tacho
    # there is no revolution axis to resample onto, so it refuses rather than guessing one (same
    # refusal-over-aliasing pattern as scripts/diag/pipeline.py's envelope analysis).
    cut_mask = (t >= cs_sec) & (t <= ce_sec)
    t_cut = t[cut_mask]
    if tacho_measured:
        os_orders, os_amp = order_spectrum_quick(revs_cum[cut_mask], axes["Fz"][cut_mask])
        os_status = "computed" if os_orders else "refused: cut too short for a revolution grid"
    else:
        os_orders, os_amp = [], []
        os_status = "refused: tacho not measured"
    local_diag = {
        "order_spectrum_status": os_status,
        "order_spectrum": {"orders": os_orders, "amplitude": os_amp} if os_orders else None,
        "drift": drift_check(t_cut, {k: v[cut_mask] for k, v in raw_axes.items()}),
    }

    # Extra (Aux/virtual) channels, if any were configured for this capture — computed from the
    # SAME gain/drift-corrected signals+axes the fixed 9 already use, so a virtual channel's
    # archived value is in the same units as what it references. Never touches raw.d1raw (already
    # written, verbatim, before finalize ever runs) — only appended to the derived outputs below.
    extra_cols = virtual_channels.compute_extra_columns(
        cfg.extra_channels, signals[:, :8], signals[:, 8], axes, hw_extra_raw
    )
    var_names = VAR_NAMES + [c.name for c in cfg.extra_channels]
    n_cols = 10 + extra_cols.shape[1]

    # --- .mat (v1.0), full resolution ---
    mat_bytes = n * n_cols * 8
    mat_written = mat_bytes <= MAT_MAX_BYTES
    mat_skip_reason = None
    if mat_written:
        data = np.empty((n, n_cols), dtype=np.float64)
        data[:, 0] = t
        data[:, 1:10] = signals
        if extra_cols.shape[1]:
            data[:, 10:] = extra_cols
        metadata = {
            "fileVersion": 1.0,
            "SampleName": cfg.sample_name,
            "Rate": fs,
            "CutDiameter": cfg.diam,
            "InnerDiameter": cfg.inner_diam,
            "Feed": cfg.feed,
            "MaxRPM": cfg.rpm,
            "SurfaceSpeed": np.pi * cfg.diam * cfg.rpm / 1000.0,  # m/min
            "PulsesPerRev": cfg.ppr,
            "Source": "force-app 2a",
        }
        # Stamp any UI-compiled metadata (sample/insert/tool/etc.) into the .mat struct.
        for k, v in (cfg.extra_metadata or {}).items():
            if k not in metadata and v not in (None, ""):
                metadata[str(k)] = v
        savemat(
            os.path.join(capture_dir, "capture.mat"),
            {
                "DATA": data,
                "metadata": metadata,
                "VariableNames": np.array(var_names, dtype=object),
            },
            do_compression=True,
        )
    else:
        mat_skip_reason = (
            f"capture has {n:,} samples ({mat_bytes / 1e9:.1f}GB uncompressed) -- "
            "too large for the MAT5 format's 32-bit size field. live_cache.bin and summary.json "
            "were still produced; the raw capture remains on disk at full resolution."
        )

    # --- live_cache.bin (D1LC), decimated for the client ---
    stride = max(1, n // LIVE_CACHE_TARGET)
    sl = slice(None, None, stride)
    fs_eff = fs / stride
    write_d1lc(
        os.path.join(capture_dir, "live_cache.bin"),
        t[sl].astype(np.float32),
        axes["Fx"][sl].astype(np.float32),
        axes["Fy"][sl].astype(np.float32),
        axes["Fz"][sl].astype(np.float32),
        rpm[sl].astype(np.float32),
        revs_cum[sl].astype(np.float32),
        fs=fs_eff,
        feed=cfg.feed,
        diam=cfg.diam,
        cs_sec=cs_sec,
        ce_sec=ce_sec,
    )

    # File sizes for the UI summary
    file_sizes: dict[str, float] = {}
    for fname in ("raw.d1raw", "capture.mat", "live_cache.bin"):
        fpath = os.path.join(capture_dir, fname)
        if os.path.isfile(fpath):
            file_sizes[fname] = round(os.path.getsize(fpath) / 1e6, 2)

    summary = {
        "sample_name": cfg.sample_name,
        "fs": fs,
        "n": int(n),
        "duration_sec": float(t[-1] - t[0]) if n > 1 else 0.0,
        "channels": var_names,
        "peaks": {ax: float(np.max(np.abs(axes[ax]))) for ax in ("Fx", "Fy", "Fz")},
        "cut_window_sec": [cs_sec, ce_sec],
        "drift_comp": bool(cfg.drift_comp),
        "local_diag": local_diag,
        # False => the tacho produced no timable edge pair, so the rpm/revs columns in capture.mat
        # and live_cache are zeros rather than a measurement. Recorded explicitly so an analysis
        # reading this capture later can tell "spindle genuinely stopped / sensor dead" apart from
        # a real 0, instead of trusting a number that was never measured.
        "tacho_measured": bool(tacho_measured),
        "mat_written": mat_written,
        "mat_skip_reason": mat_skip_reason,
        "file_sizes_mb": file_sizes,
        # Per-channel ranging (drives converging between-cuts auto-range + records the per-cut N/V).
        "channels_ranging": {
            "peaks_n": chan_peaks,
            "clipped": chan_clipped,
            "gains_n_per_v": chan_gains,
            "ranges_n": chan_ranges,
            "fullscale_v": vfs,
        },
        "metadata": cfg.extra_metadata or {},
        "config": cfg.model_dump(),
        "files": {
            "mat": "capture.mat" if mat_written else None,
            "live_cache": "live_cache.bin",
            "raw": "raw.d1raw",
        },
    }
    atomic_write_json(os.path.join(capture_dir, "summary.json"), summary, indent=2)
    return summary
