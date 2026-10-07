"""Frozen copy of finalize() and the dsp helpers it used BEFORE #79 (the streaming rewrite), kept
only as the reference the equivalence tests compare the new finalize against. It loads the whole
capture into float64 arrays, so it must only ever be run on small synthetic captures. Do not
"fix" or modernise this file: its value is that it is exactly the old behaviour.
"""

from __future__ import annotations

import os

import numpy as np
from scipy.io import savemat
from scipy.signal import detrend

from app import virtual_channels
from app.config import AXIS_SUM, SIGNAL_CHANNELS, RecordConfig
from app.d1lc import write_d1lc
from app.d1rw import memmap_rows, read_header
from app.storage import atomic_write_json


def sum_axes(signals: np.ndarray) -> dict[str, np.ndarray]:
    """signals: (n, len(SIGNAL_CHANNELS)) → {'Fx','Fy','Fz'} summed sub-channels."""
    idx = {name: i for i, name in enumerate(SIGNAL_CHANNELS)}
    out: dict[str, np.ndarray] = {}
    for axis, parts in AXIS_SUM.items():
        out[axis] = np.sum(signals[:, [idx[p] for p in parts]], axis=1)
    return out


def tacho_column(signals: np.ndarray) -> np.ndarray:
    return signals[:, SIGNAL_CHANNELS.index("Tacho")]


def rpm_from_tacho(tacho: np.ndarray, fs: float, ppr: int) -> tuple[np.ndarray, bool]:
    """Per-sample RPM from a tacho pulse train, by timing rising edges (a simplified tachorpm).

    Returns `(rpm, measured)`. Rising edges are detected on a mid-level threshold; instantaneous RPM
    between consecutive edges is 60 / (ppr · Δt), then interpolated to every sample. Fewer than two
    edges means there is no interval to time, so there is no rate to report: the result is zeros and
    `measured` is False. Callers must not substitute a guess for it — see below.

    This deliberately takes no `fallback`. It used to, and both callers seeded that fallback with
    the CONFIGURED spindle speed, so a tacho with no pulses reported the nominal RPM as though it
    had been measured. On the rig that produced a bit-exact, unvarying 1200.000 (and 777.000 once
    the configured value was changed) while the hall-effect sensor sat motionless on the bench —
    a fabricated reading indistinguishable from a healthy one, in the saved .mat as well as live.
    Holding the LAST MEASURED value across a short chunk is legitimate and belongs to the caller
    (FrmIntegrator does it, bounded by a staleness window); inventing a never-measured one is not.
    """
    n = tacho.size
    if n == 0:
        return np.zeros(0, dtype=np.float64), False
    lo, hi = float(np.min(tacho)), float(np.max(tacho))
    if hi - lo < 1e-9:
        return np.zeros(n, dtype=np.float64), False
    thr = lo + 0.5 * (hi - lo)
    above = tacho > thr
    edges = np.flatnonzero((~above[:-1]) & (above[1:])) + 1  # rising-edge sample indices
    if edges.size < 2:
        return np.zeros(n, dtype=np.float64), False
    edge_t = edges / fs
    inst = 60.0 / (ppr * np.diff(edge_t))  # RPM on each inter-edge interval
    # Sample-time RPM: hold each interval's value across it; extend the ends.
    rpm = np.interp(np.arange(n) / fs, edge_t[1:], inst, left=inst[0], right=inst[-1])
    return rpm, True


def order_spectrum_quick(
    revs: np.ndarray, sig: np.ndarray, samples_per_rev: int = 64, max_order: float = 16.0
) -> tuple[list[float], list[float]]:
    """A deliberately cheap order spectrum for the local tier (Component 8): resample onto a
    uniform revolution grid at a coarse `samples_per_rev`, then rfft. Independent of (and much
    lower-resolution than) scripts/diag/angular.py's order_spectrum -- that one runs server-side
    against a >=5M-point cache; this one runs at the machine, against whatever a single cut's
    live_cache holds, and only needs to answer "is there an obvious repeating pattern" before the
    operator walks away from the part.

    `revs` must be monotonically non-decreasing (revs_cum). Returns (orders, amplitude), orders
    capped to `max_order` -- consistent with the server pipeline's own metrics-payload cap, and
    for the same reason: everything diagnostically interesting (insert passing, its harmonics,
    the non-integer chatter orders between them) lives in the low orders. Windowed (Hann) and
    normalized the same way as scripts/diag/angular.py's order_spectrum (2/sum(w), single-sided)
    so the two aren't just structurally similar but numerically comparable.
    """
    revs = np.asarray(revs, dtype=np.float64)
    sig = np.asarray(sig, dtype=np.float64)
    if revs.size < samples_per_rev * 2:
        return [], []
    n_rev = int(revs[-1] - revs[0])
    if n_rev < 2:
        return [], []
    grid = revs[0] + np.arange(n_rev * samples_per_rev) / samples_per_rev
    resampled = np.interp(grid, revs, sig)
    w = np.hanning(resampled.size)
    spec = np.abs(np.fft.rfft((resampled - resampled.mean()) * w))
    amp = spec * (2.0 / w.sum())
    orders = np.fft.rfftfreq(resampled.size, d=1.0 / samples_per_rev)
    keep = orders <= max_order
    return orders[keep].tolist(), amp[keep].tolist()


def drift_check(t: np.ndarray, axes: dict[str, np.ndarray], thresh_frac: float = 0.1) -> dict:
    """Flag whether each summed axis shows a linear baseline drift large enough to matter,
    independent of whether drift_comp correction is enabled -- this is a diagnostic check, not
    the correction itself (see finalize.py's drift_comp, which unconditionally detrends when the
    operator opts in). "Large enough to matter" is the trend's total excursion over the capture
    (|slope| * duration) exceeding `thresh_frac` of the axis's own peak-to-peak amplitude, so a
    small drift on a small, quiet signal isn't judged by the same absolute-Newtons yardstick as
    a small drift on a violently noisy one.
    """
    t = np.asarray(t, dtype=np.float64)
    duration = float(t[-1] - t[0]) if t.size > 1 else 0.0
    out: dict = {}
    any_detected = False
    for name, sig in axes.items():
        sig = np.asarray(sig, dtype=np.float64)
        if sig.size < 2 or duration <= 0:
            out[name] = {"slope_n_per_sec": 0.0, "excursion_frac": 0.0, "detected": False}
            continue
        slope = float(np.polyfit(t, sig, 1)[0])
        ptp = float(np.ptp(sig))
        excursion_frac = (abs(slope) * duration / ptp) if ptp > 1e-9 else 0.0
        detected = excursion_frac > thresh_frac
        any_detected = any_detected or detected
        out[name] = {
            "slope_n_per_sec": slope,
            "excursion_frac": excursion_frac,
            "detected": detected,
        }
    out["detected"] = any_detected
    return out


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
