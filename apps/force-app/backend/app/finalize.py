"""Finalize a capture: stream the raw file in constant memory, sum + gain the dyno channels,
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

Constant memory (#79): nothing here is ever full-length. A 12430 s capture (310M samples, 12 GB
of raw) used to die allocating its first float64 copy; now the raw file is read in BLOCK_ROWS
blocks over a few passes — whole-capture statistics first (gains, peaks, the drift-compensation
fit, the tacho's range), then the corrected |Fz| peak if drift_comp moved it, then the cut window,
then one pass that derives RPM/revs and fills the live cache, the cut-window diagnostics and the
.mat. Peak memory is a few blocks' worth however long the capture ran. The only full-length array
left is the .mat's DATA, which only exists under MAT_MAX_BYTES.
"""

from __future__ import annotations

import logging
import os

import numpy as np
from scipy.io import savemat

from . import virtual_channels
from .clipping import near_full_scale
from .config import AXIS_SUM, SIGNAL_CHANNELS, RecordConfig
from .d1lc import write_d1lc
from .d1rw import read_header, read_rows, row_count
from .dsp import (
    DriftCheck,
    LinearFit,
    OrderSpectrum,
    TachoRpm,
    sum_axes,
    tacho_threshold,
    uniform_chunk,
)
from .storage import atomic_write_json

log = logging.getLogger("force_app.finalize")

VAR_NAMES = ["Time"] + SIGNAL_CHANNELS  # 10 columns
LIVE_CACHE_TARGET = 300_000  # decimate the cache to ~this many points for the client
# MAT5's data-element header holds a size in a 32-bit field (scipy hits this as an OverflowError,
# "Python int too large to convert to C long", once the uncompressed array crosses roughly 2GB) --
# this is a format ceiling, not a scipy bug, so oversized captures skip the .mat write entirely
# rather than crash finalize (see #40: a ~245M-sample capture allocated 19.6GB for `data` and then
# blew past this ceiling, taking the whole app down with it). Threshold has generous headroom
# under the real ~2^31 byte limit.
MAT_MAX_BYTES = 1_500_000_000
# Rows per streamed block (40 MB of float32 at the 10-column layout). Peak memory is a small
# multiple of this — the float64 signals, axis sums, RPM/revs for one block — not of the capture.
BLOCK_ROWS = 1_000_000
DETREND_TILE_ROWS = 32_768
CUT_FRAC = 0.2  # the cut window is where |Fz| exceeds this fraction of its peak


def time_column_is_off(col: np.ndarray, expected: np.ndarray, fs: float) -> bool:
    """Whether a float32 Time column departs from `expected` (float64 start + index / fs) by more
    than rounding can explain, i.e. it carries real non-uniform timing.

    Allowed: half a sample, the stored value's own float32 rounding (spacing), and the float32
    rounding of the header rate, which the sources' float64 stamps don't share: for a rate float32
    can't hold exactly (10000.1 Hz) the formula drifts from the stamps by up to ~t * 2**-24, which
    passes the spacing term on its own past ~75M rows. 2**-23 * |t| covers that; the total
    tolerance stays within a few float32 ulps of t, so anything the column can resolve as a real
    step (a dropped chunk, a pause) is still caught.
    """
    col = np.abs(col)
    tol = 0.5 / fs + np.spacing(col).astype(np.float64) + 2.0**-23 * col.astype(np.float64)
    return bool(np.any(np.abs(col.astype(np.float64) - expected) > tol))


class _Blocks:
    """The raw body as consecutive BLOCK_ROWS blocks, keeping the last two read. The final pass
    reads each block twice in quick succession — once to find tacho edges a little ahead of the
    main loop, once in the main loop itself — and this turns the second read into a lookup."""

    def __init__(self, path: str, n: int, n_cols: int, block_rows: int) -> None:
        self.path, self.n, self.n_cols, self.rows = path, n, n_cols, max(1, int(block_rows))
        self.count = -(-n // self.rows)
        self._cache: dict[int, np.ndarray] = {}

    def bounds(self, k: int) -> tuple[int, int]:
        return k * self.rows, min(self.n, (k + 1) * self.rows)

    def get(self, k: int) -> np.ndarray:
        block = self._cache.get(k)
        if block is None:
            block = read_rows(self.path, *self.bounds(k), self.n_cols)
            block.flags.writeable = False  # shared between the two readers: never mutate in place
            if len(self._cache) >= 2:
                self._cache.pop(min(self._cache))
            self._cache[k] = block
        return block


def finalize(capture_dir: str, cfg: RecordConfig, gain: float = 1.0) -> dict:
    raw_path = os.path.join(capture_dir, "raw.d1raw")
    hdr = read_header(raw_path)
    fs = float(hdr["rate"])
    dt = 1.0 / fs
    # (n, 1 + 9 + H) rows — H is however many source="hardware" extra channels were configured
    # for this capture (0 for anything recorded before extra channels existed, or with none set).
    n_cols = int(hdr["n_cols"])
    n = row_count(raw_path, n_cols)
    if n == 0:
        raise ValueError("raw capture holds no samples")
    blocks = _Blocks(raw_path, n, n_cols, BLOCK_ROWS)

    # Apply volts→N gain to the 8 charge channels (Tacho is the last column — leave it). Per-channel
    # gains (from the amp's auto-ranged ranges) calibrate each channel independently; otherwise the
    # scalar gain applies (sim/replay data is already in N, so gain 1).
    gains = list(cfg.dyno_gains or [])
    scale = np.array([float(g) for g in gains[:8]]) if len(gains) >= 8 else float(gain)
    # Optional linear drift compensation on the 8 dyno channels (like the MATLAB app's driftComp):
    # the least-squares line against sample index, fitted over the whole capture in the first pass
    # and subtracted from every block after it. Only affects the derived outputs (.mat DATA +
    # live_cache); the raw .d1raw is never touched.
    drift_corrected = bool(cfg.drift_comp and n > 1)
    detrend_fit = LinearFit()

    def gained(block: np.ndarray) -> np.ndarray:
        # The fixed layout is ALWAYS exactly columns 1:10, regardless of how wide the file is —
        # extra hardware columns (if any) follow at 10: and are handled separately below, kept apart
        # from the gain/drift-compensation logic that is specific to the 8 charge-amp dyno channels.
        sig = np.array(block[:, 1:10], dtype=np.float64)  # (m, 9) in SIGNAL_CHANNELS order
        sig[:, :8] *= scale
        return sig

    def corrected(k: int, sig: np.ndarray) -> np.ndarray:
        if drift_corrected:
            a, b = blocks.bounds(k)
            # Tiled so the (rows, 8) trend temporaries stay cache-sized instead of two full-block
            # float64 arrays; the arithmetic is elementwise, so the result is bit-identical.
            for lo in range(a, b, DETREND_TILE_ROWS):
                hi = min(lo + DETREND_TILE_ROWS, b)
                sig[lo - a : hi - a, :8] -= detrend_fit.trend(np.arange(lo, hi, dtype=np.float64))
        return sig

    # --- Pass 1: whole-capture statistics ---
    # Time is computed as start + index / fs in float64 rather than read from the raw file's Time
    # column: that column is float32, whose spacing passes a 25 kHz sample period at ~336 s, so a
    # 12430 s capture's stamps were quantised to ~1 ms (25 samples sharing one value). Every source
    # writes uniform index / rate stamps (sim, nidaq, and replay of a uniformly-decimated cache), so
    # for those the only thing lost is the column's float32 rounding. The column is checked against
    # the formula as it streams past (time_column_is_off), and if it ever disagrees by more than
    # that rounding plus half a sample the capture is assumed to carry real non-uniform timing, and
    # the column is used as before.
    t0 = float(blocks.get(0)[0, 0])
    time_from_index = True
    chan_peaks = np.zeros(8)
    raw_peaks = dict.fromkeys(AXIS_SUM, 0.0)
    fz_block_max: list[float] = []  # per-block max |Fz| of the FINAL axes, to locate the cut window
    tacho_lo, tacho_hi = np.inf, -np.inf
    tacho_block_range: list[tuple[float, float]] = []  # per-block (min, max), see tacho_chunks
    for k in range(blocks.count):
        a, b = blocks.bounds(k)
        block = blocks.get(k)
        if time_from_index:
            col = block[:, 0]
            if time_column_is_off(col, t0 + np.arange(a, b) / fs, fs):
                time_from_index = False
                log.warning(
                    "finalize: %s has non-uniform Time stamps (block %d); using the stored column",
                    capture_dir,
                    k,
                )
        sig = gained(block)
        chan_peaks = np.maximum(chan_peaks, np.max(np.abs(sig[:, :8]), axis=0))
        blo, bhi = float(np.min(sig[:, 8])), float(np.max(sig[:, 8]))
        tacho_block_range.append((blo, bhi))
        tacho_lo = float(np.minimum(tacho_lo, blo))  # np.minimum: NaN propagates,
        tacho_hi = float(np.maximum(tacho_hi, bhi))  # as a whole-array min would
        if drift_corrected:
            # The axis peaks that matter are the corrected ones, which pass 2 computes once the
            # fit is complete, so summing the raw axes here would be thrown away.
            detrend_fit.add(np.arange(a, b, dtype=np.float64), sig[:, :8])
        else:
            # Final as they stand: without drift_comp the raw axes are the corrected ones.
            raw_axes = sum_axes(sig)
            for ax in AXIS_SUM:
                raw_peaks[ax] = np.maximum(raw_peaks[ax], np.max(np.abs(raw_axes[ax])))
            fz_block_max.append(float(np.max(np.abs(raw_axes["Fz"]))))

    def time_of(k: int) -> np.ndarray:
        a, b = blocks.bounds(k)
        if time_from_index:
            return t0 + np.arange(a, b) / fs
        return blocks.get(k)[:, 0].astype(np.float64)

    def final_axes(k: int) -> dict[str, np.ndarray]:
        return sum_axes(corrected(k, gained(blocks.get(k))))

    # --- Pass 2 (drift_comp only): peaks of the corrected axes, which the cut window is found on ---
    peaks = raw_peaks
    if drift_corrected:
        peaks = dict.fromkeys(AXIS_SUM, 0.0)
        fz_block_max = []
        for k in range(blocks.count):
            axes = final_axes(k)
            for ax in AXIS_SUM:
                peaks[ax] = np.maximum(peaks[ax], np.max(np.abs(axes[ax])))
            fz_block_max.append(float(np.max(np.abs(axes["Fz"]))))

    # Per-channel ranging info (for the converging between-cuts auto-range): the peak force each
    # sensor channel saw, whether it railed (clipped), and the per-cut N/V + range that produced it.
    vfs = float(cfg.analog_fullscale_v or 10.0)
    chan_gains = [float(g) for g in gains[:8]] if len(gains) >= 8 else [float(gain)] * 8
    chan_ranges = [g * vfs for g in chan_gains]
    chan_peaks = [float(p) for p in chan_peaks]
    # Clipping only meaningful with real per-channel gains (nidaq path); sim/replay never rails.
    chan_clipped = [
        bool(len(gains) >= 8 and hit)  # same test the live stream applies per block (clipping.py)
        for hit in near_full_scale(np.array(chan_peaks), np.array(chan_ranges))
    ]

    # --- Cut window: first/last time |Fz| exceeds CUT_FRAC of its peak — the active cut ---
    # Only the two blocks holding the first and last crossing are re-read to find the exact samples.
    t_first, t_last = float(time_of(0)[0]), float(time_of(blocks.count - 1)[-1])
    cs_sec, ce_sec = t_first, t_last
    fz_max = np.max(fz_block_max)
    if fz_max > 0:
        thr = CUT_FRAC * fz_max
        hot = np.flatnonzero(np.array(fz_block_max) > thr)
        if hot.size:
            k = int(hot[0])
            on = np.flatnonzero(np.abs(final_axes(k)["Fz"]) > thr)
            cs_sec = float(time_of(k)[on[0]])
            k = int(hot[-1])
            on = np.flatnonzero(np.abs(final_axes(k)["Fz"]) > thr)
            ce_sec = float(time_of(k)[on[-1]])

    # --- .mat (v1.0), full resolution: DATA is filled block by block in the final pass ---
    extra_names = [c.name for c in cfg.extra_channels]
    var_names = VAR_NAMES + extra_names
    n_mat_cols = 10 + len(extra_names)
    mat_bytes = n * n_mat_cols * 8
    mat_written = mat_bytes <= MAT_MAX_BYTES
    mat_skip_reason = None
    data = np.empty((n, n_mat_cols), dtype=np.float64) if mat_written else None
    bad_formulas: set[str] = set()

    def on_formula_error(name: str, e: virtual_channels.FormulaError) -> None:
        if name not in bad_formulas:  # once per capture, not once per block
            bad_formulas.add(name)
            log.warning("virtual channel '%s' evaluation failed: %s", name, e)

    # --- live_cache.bin (D1LC), decimated for the client: every stride-th sample ---
    stride = max(1, n // LIVE_CACHE_TARGET)
    n_lc = -(-n // stride)
    lc = {key: np.empty(n_lc, dtype=np.float32) for key in ("t", "Fx", "Fy", "Fz", "rpm", "revs")}

    # No fallback to cfg.rpm: this is the ARCHIVED record. Substituting the configured spindle speed
    # for an unmeasured one wrote a fabricated rate into capture.mat and the revs column, where
    # nothing downstream could tell it apart from a real measurement. Unmeasured stays 0 and is
    # recorded as such in summary.json (tacho_measured) so the gap is visible rather than papered over.
    # TachoRpm reads ahead to the end of the file once the pulses stop, to learn that no later edge
    # exists, and the 2-block cache means the main loop below then re-reads all of it. A block whose
    # tacho sits wholly on one side of the edge threshold (a stopped spindle's tail) is handed over
    # as a UniformChunk from the pass-1 min/max instead, so neither pass reads it for the tacho.
    tacho_thr = tacho_threshold(tacho_lo, tacho_hi)

    def tacho_chunks():
        for k in range(blocks.count):
            a, b = blocks.bounds(k)
            lo, hi = tacho_block_range[k]
            chunk = uniform_chunk(b - a, lo, hi, tacho_thr)
            yield chunk or blocks.get(k)[:, 1 + SIGNAL_CHANNELS.index("Tacho")].astype(np.float64)

    rpm_stream = TachoRpm(tacho_chunks(), n, fs, cfg.ppr, tacho_lo, tacho_hi)
    tacho_measured = rpm_stream.measured

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
    # refusal-over-aliasing pattern as scripts/diag/pipeline.py's envelope analysis). The drift
    # check deliberately sees the PRE-correction axes: it must answer "did this capture actually
    # drift", independent of whether drift_comp correction is enabled.
    drift = DriftCheck(list(AXIS_SUM))
    spectrum = OrderSpectrum()

    # --- Final pass: RPM/revs, live cache, cut-window diagnostics, .mat DATA ---
    revs_carry = 0.0
    for k in range(blocks.count):
        a, b = blocks.bounds(k)
        block = blocks.get(k)
        t = time_of(k)
        cut = (t >= cs_sec) & (t <= ce_sec)
        any_cut = bool(cut.any())
        sig = gained(block)
        # The drift check sees the PRE-correction axes, so they are summed before `corrected`
        # detrends sig in place; with drift_comp off they are also the final axes.
        raw_axes = sum_axes(sig) if (any_cut or not drift_corrected) else None
        axes = sum_axes(corrected(k, sig)) if drift_corrected else raw_axes
        rpm = rpm_stream.rpm(a, b)
        # Cumulative revs, continued across blocks: seeding the first element with the carry makes
        # this the exact same sequential sum a whole-capture np.cumsum would do.
        revs = rpm / 60.0 * dt
        if k:
            revs[0] += revs_carry
        np.cumsum(revs, out=revs)
        revs_carry = float(revs[-1])

        if any_cut:
            drift.add(t[cut], {ax: v[cut] for ax, v in raw_axes.items()})
            if tacho_measured:
                spectrum.add(revs[cut], axes["Fz"][cut])

        first = (-a) % stride  # first sample in this block that lands on the global stride grid
        dst = slice((a + first) // stride, (a + first) // stride + len(range(first, b - a, stride)))
        src = slice(first, None, stride)
        lc["t"][dst] = t[src]
        for ax in AXIS_SUM:
            lc[ax][dst] = axes[ax][src]
        lc["rpm"][dst] = rpm[src]
        lc["revs"][dst] = revs[src]

        if data is not None:
            # Extra (Aux/virtual) channels, if any were configured for this capture — computed
            # from the SAME gain/drift-corrected signals+axes the fixed 9 already use, so a virtual
            # channel's archived value is in the same units as what it references. Never touches
            # raw.d1raw (already written, verbatim, before finalize ever runs) — only appended to
            # the derived outputs. Formulas are elementwise, so evaluating per block is exact.
            data[a:b, 0] = t
            data[a:b, 1:10] = sig
            if extra_names:
                hw_extra_raw = np.array(block[:, 10:], dtype=np.float64) if n_cols > 10 else None
                data[a:b, 10:] = virtual_channels.compute_extra_columns(
                    cfg.extra_channels,
                    sig[:, :8],
                    sig[:, 8],
                    axes,
                    hw_extra_raw,
                    on_error=on_formula_error,
                )

    if tacho_measured:
        os_orders, os_amp = spectrum.result()
        os_status = "computed" if os_orders else "refused: cut too short for a revolution grid"
    else:
        os_orders, os_amp = [], []
        os_status = "refused: tacho not measured"
    local_diag = {
        "order_spectrum_status": os_status,
        "order_spectrum": {"orders": os_orders, "amplitude": os_amp} if os_orders else None,
        "drift": drift.result(),
    }

    if data is not None:
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
        del data
    else:
        mat_skip_reason = (
            f"capture has {n:,} samples ({mat_bytes / 1e9:.1f}GB uncompressed) -- "
            "too large for the MAT5 format's 32-bit size field. live_cache.bin and summary.json "
            "were still produced; the raw capture remains on disk at full resolution."
        )

    write_d1lc(
        os.path.join(capture_dir, "live_cache.bin"),
        lc["t"],
        lc["Fx"],
        lc["Fy"],
        lc["Fz"],
        lc["rpm"],
        lc["revs"],
        fs=fs / stride,
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
        "duration_sec": float(t_last - t_first) if n > 1 else 0.0,
        "channels": var_names,
        "peaks": {ax: float(peaks[ax]) for ax in ("Fx", "Fy", "Fz")},
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
