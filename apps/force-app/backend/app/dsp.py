"""Shared signal math for the recording pipeline — channel summing, tacho→RPM, and the FRM
spiral geometry. Mirrors scripts/matlab/process_force.m and the MATLAB app's LiveFRMPlot so the
live spiral and the finalized live_cache use identical geometry. Pure NumPy (2a); the hot paths
can move to abfp_core later without changing these signatures.
"""

from __future__ import annotations

from functools import lru_cache
from typing import NamedTuple

import numpy as np
from scipy import signal as ssig

from .config import AXIS_SUM, SIGNAL_CHANNELS


def sum_axes(signals: np.ndarray) -> dict[str, np.ndarray]:
    """signals: (n, len(SIGNAL_CHANNELS)) → {'Fx','Fy','Fz'} summed sub-channels."""
    idx = {name: i for i, name in enumerate(SIGNAL_CHANNELS)}
    out: dict[str, np.ndarray] = {}
    for axis, parts in AXIS_SUM.items():
        # Left-to-right column adds: the same sequence of float additions as a row-wise
        # np.sum(axis=1) (bit-identical), without gathering the columns into a copy first.
        total = signals[:, idx[parts[0]]] + signals[:, idx[parts[1]]]
        for p in parts[2:]:
            total += signals[:, idx[p]]
        out[axis] = total
    return out


def tacho_column(signals: np.ndarray) -> np.ndarray:
    return signals[:, SIGNAL_CHANNELS.index("Tacho")]


def tacho_rising_edges(
    tacho: np.ndarray, prev_above: bool | None = None, thr: float | None = None
) -> tuple[np.ndarray, bool | None]:
    """Rising-edge sample indices in one chunk, continuing across chunk boundaries.

    Returns `(edge_indices, last_above)`; pass `last_above` back in as `prev_above` next chunk so an
    edge falling exactly on the seam is not missed or double-counted.

    Needed because a live chunk is short relative to the pulse period: the sim emits 20 ms chunks
    and a 1500 RPM / 1 PPR tacho pulses every 40 ms, so NO chunk ever contains two edges. Timing
    edges within a chunk therefore never measures anything at all — the interval that matters is
    the one from the last edge of the previous chunk to the first edge of this one.

    `thr` defaults to this chunk's own mid-level, which is only meaningful when the chunk actually
    contains a transition; callers tracking a pulse train across chunks should pass a stable
    threshold so a chunk sitting entirely at the high or low level doesn't invent one.
    """
    n = tacho.size
    if n == 0:
        return np.zeros(0, dtype=np.int64), prev_above
    if thr is None:
        lo, hi = float(np.min(tacho)), float(np.max(tacho))
        if hi - lo < 1e-9:
            # Flat chunk: no transition to threshold against. Report the level so the caller can
            # still track continuity, but find no edges.
            return np.zeros(0, dtype=np.int64), prev_above
        thr = lo + 0.5 * (hi - lo)
    above = tacho > thr
    # Prepend the previous chunk's final level so a low->high transition straddling the seam counts.
    prior = above[0] if prev_above is None else prev_above
    joined = np.concatenate(([prior], above))
    edges = np.flatnonzero((~joined[:-1]) & joined[1:]).astype(np.int64)
    return edges, bool(above[-1])


def tacho_threshold(lo: float, hi: float) -> float:
    """The mid-level rising edges are found on, from a whole capture's tacho min and max."""
    return lo + 0.5 * (hi - lo)


class UniformChunk(NamedTuple):
    """A tacho chunk known to sit entirely above (`above=True`) or entirely at or below the
    threshold, standing in for its samples where TachoRpm's chunk iterator would otherwise have to
    read them. It can hold no edge of its own and at most one on its first sample, both of which
    TachoRpm works out without the data."""

    size: int
    above: bool


def uniform_chunk(size: int, lo: float, hi: float, thr: float) -> UniformChunk | None:
    """UniformChunk for a chunk of `size` samples whose min/max are `lo`/`hi`, if it is one.

    A NaN anywhere makes lo/hi NaN, every comparison False, and so None: the caller reads it."""
    if lo > thr:
        return UniformChunk(size, True)
    if hi <= thr:
        return UniformChunk(size, False)
    return None


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

    The whole-array form of TachoRpm (which finalize streams a long capture through instead).
    """
    tacho = np.asarray(tacho, dtype=np.float64)
    n = tacho.size
    if n == 0:
        return np.zeros(0, dtype=np.float64), False
    lo, hi = float(np.min(tacho)), float(np.max(tacho))
    stream = TachoRpm(iter([tacho]), n, fs, ppr, lo, hi)
    return stream.rpm(0, n), stream.measured


class TachoRpm:
    """rpm_from_tacho for a capture too long to hold in memory: the tacho arrives as an iterator
    of consecutive chunks, and `rpm(a, b)` returns samples a..b-1 — called for consecutive ranges.

    Bit-identical to the whole-array computation, not an approximation of it: edges are found on
    the same GLOBAL mid-level threshold (`lo`/`hi` are the whole capture's tacho min/max, so a
    first pass has to supply them), carried across chunk seams by tacho_rising_edges, and each
    range is interpolated against only the edges that bracket it — np.interp's value between two
    nodes depends on nothing but those two, so a subset that brackets the range gives the same
    numbers. The iterator is read ahead just far enough to find the first edge at or past the
    range's end, so held memory is a chunk's worth of edges however long the capture is.

    That read-ahead runs to the end of the capture once the pulses stop, since only reaching it
    shows there is no later edge. `chunks` may therefore yield a UniformChunk, which costs no read,
    for any chunk whose samples are all on one side of the threshold (see uniform_chunk): a spindle
    that has stopped leaves a tacho sitting at one level, so a long tail scans for free.
    """

    def __init__(self, chunks, n: int, fs: float, ppr: int, lo: float, hi: float) -> None:
        self._chunks = chunks
        self._fs = fs
        self._ppr = ppr
        self._edges = np.zeros(0, dtype=np.int64)  # pending edges; [0] precedes the bracket node
        self._scanned = 0
        self._prev_above: bool | None = None
        self._done = n == 0 or hi - lo < 1e-9  # flat tacho: no transition, so nothing to time
        self._thr = tacho_threshold(lo, hi)
        while not self._done and self._edges.size < 2:
            self._scan()
        self.measured = self._edges.size >= 2

    def _scan(self) -> None:
        chunk = next(self._chunks, None)
        if chunk is None:
            self._done = True
            return
        if isinstance(chunk, UniformChunk):
            # An all-below chunk has no rising edge and an all-above one only on its first sample,
            # rising out of a below level carried over the seam.
            edges = np.zeros(1 if chunk.above and self._prev_above is False else 0, dtype=np.int64)
            self._prev_above = chunk.above
        else:
            edges, self._prev_above = tacho_rising_edges(chunk, self._prev_above, self._thr)
        if edges.size:
            self._edges = np.concatenate((self._edges, edges + self._scanned))
        self._scanned += chunk.size

    def rpm(self, a: int, b: int) -> np.ndarray:
        if not self.measured or b <= a:
            return np.zeros(max(0, b - a), dtype=np.float64)
        while not self._done and self._edges[-1] < b - 1:
            self._scan()
        # Drop edges this range (and every later one) can't need: keep the last edge at or before
        # `a` -- the node bracketing the range's start -- plus the edge before it, which times it.
        keep = max(0, int(np.searchsorted(self._edges, a, side="right")) - 2)
        if keep:
            self._edges = self._edges[keep:]
        edge_t = self._edges / self._fs
        inst = 60.0 / (self._ppr * np.diff(edge_t))  # RPM on each inter-edge interval
        # Sample-time RPM: hold each interval's value across it; extend the ends. inst[0]/inst[-1]
        # are the capture's first/last interval whenever they can actually be reached: an earlier
        # node than this subset's first is only ever dropped once a later one brackets `a`, and
        # the subset ends before the last edge only while it still extends past `b - 1`.
        return np.interp(np.arange(a, b) / self._fs, edge_t[1:], inst, left=inst[0], right=inst[-1])


def frm_spiral(
    t: np.ndarray,
    rpm: np.ndarray,
    feed: float,
    axis_force: np.ndarray,
    diam: float,
    inner_diam: float = 0.0,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Integrate the FRM fingerprint spiral (mm) from per-sample RPM + feed.

    θ accumulates spindle angle (rpm·2π/60·dt); ρ winds inward by feed per rev
    (−feed/10·rpm/60·dt), offset so the spiral starts at the outer radius. Returns (x, y, revs_cum).
    Matches process_force.m lines ~168-178 and the app's LiveFRMPlot.
    """
    dt = np.gradient(t) if t.size > 1 else np.array([0.0])
    dtheta = rpm * (2.0 * np.pi / 60.0) * dt
    theta = np.cumsum(dtheta)
    revs_cum = theta / (2.0 * np.pi)
    drho = -(feed / 10.0) * (rpm / 60.0) * dt
    rho = np.cumsum(drho)
    r_outer = diam / 2.0
    rho = r_outer + rho  # start at the rim, spiral inward
    if inner_diam > 0:
        rho = np.maximum(rho, inner_diam / 2.0)
    x = rho * np.cos(theta)
    y = rho * np.sin(theta)
    return x, y, revs_cum


# Wire-bin budget for welch_spectra: the DC bin plus up to this many minus one pooled groups.
SPECTRUM_MAX_BINS = 1024


@lru_cache(maxsize=8)
def _pool_starts(n: int, max_bins: int) -> tuple[np.ndarray, np.ndarray]:
    """Group starts (into the bins after DC) and widths for pooling `n` bins to ~`max_bins`.

    max_bins - 1 groups of near-equal width (e.g. 4 or 5 source bins), so the output is as close
    to the budget as the source allows. Cached: n and max_bins repeat every live frame."""
    starts = np.unique(np.linspace(1, n, max_bins - 1, endpoint=False).astype(int)) - 1
    counts = np.diff(np.append(starts, n - 1))
    starts.flags.writeable = counts.flags.writeable = False
    return starts, counts


def _maxpool_bins(
    f: np.ndarray, amps: dict[str, np.ndarray], max_bins: int
) -> tuple[np.ndarray, dict[str, np.ndarray]]:
    """Reduce a spectrum to at most ~`max_bins` points without losing narrow peaks (#186).

    Each output bin takes the MAXIMUM amplitude of the group of source bins it covers, so a peak
    always survives at full height. The output frequency is the group's centre (mean of its source
    frequencies), shared by every channel so one `f` array serves all spectra; a peak is located
    to within half a group width. The DC bin stays a separate output bin (f = 0): a load cell's
    static offset would otherwise swamp the first pooled group.
    """
    n = f.size
    if n <= max_bins:
        return f, amps
    starts, counts = _pool_starts(n, max_bins)
    f_out = np.concatenate(([f[0]], np.add.reduceat(f[1:], starts) / counts))
    a_out = {
        name: np.concatenate(([a[0]], np.maximum.reduceat(a[1:], starts)))
        for name, a in amps.items()
    }
    return f_out, a_out


def welch_spectra(
    bufs: dict[str, np.ndarray],
    fs: float,
    nperseg: int,
    min_samples: int = 256,
    max_bins: int = SPECTRUM_MAX_BINS,
) -> tuple[list[float] | None, dict[str, list[float]]]:
    """Welch AMPLITUDE spectra for a set of named channel buffers, reduced for the wire.

    One implementation shared by the live recording path (session._update_fft) and the
    /dsp/spectrum endpoint that playback calls, so a replayed cut's FFT cannot drift from a
    live one's. Buffers shorter than `min_samples` are skipped rather than erroring, since
    live chunks arrive before the rolling window has filled.

    Returns (f, {name: amp}) with at most about `max_bins` points per spectrum, reduced by
    max-pooling (see _maxpool_bins) so narrow peaks survive, or (None, {}) if no buffer was
    long enough.
    """
    f: np.ndarray | None = None
    psd: dict[str, np.ndarray] = {}
    for name, buf in bufs.items():
        if buf.size < min_samples:
            continue
        f, p = ssig.welch(buf, fs=fs, nperseg=min(int(nperseg), buf.size))
        psd[name] = np.sqrt(p)
    if f is None:
        return None, {}
    f_out, amps = _maxpool_bins(f, psd, max(2, int(max_bins)))
    return f_out.round(2).tolist(), {n: a.round(4).tolist() for n, a in amps.items()}


# Revolution-grid points per order-spectrum FFT: 4096 revolutions at the default 64 samples/rev.
# A cut window up to that long is transformed in one piece, exactly as before #79; a longer one is
# split into half-overlapping segments of this length and their power averaged (Welch, in the
# order domain), so the transform's memory -- and the spectrum's length in summary.json -- stays
# fixed however long the cut ran, at a resolution of 1/4096 of an order.
ORDER_SEGMENT_POINTS = 1 << 18


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

    The whole-array form of OrderSpectrum; a grid longer than ORDER_SEGMENT_POINTS is averaged
    over segments rather than transformed in one piece (see there).
    """
    acc = OrderSpectrum(samples_per_rev, max_order)
    acc.add(revs, sig)
    return acc.result()


class OrderSpectrum:
    """order_spectrum_quick fed one chunk at a time, for a cut window too long to hold in memory.

    Each chunk is resampled onto the revolution grid as it arrives -- np.interp against the
    chunk with the previous chunk's last sample prepended, which brackets every grid point the
    seam falls between, so the grid values are identical to resampling the whole window at once.
    Only the resampled grid is kept (64 points a revolution, a small fraction of the sample
    rate), and only up to one segment of it: past ORDER_SEGMENT_POINTS the grid is consumed in
    half-overlapping Hann segments whose power is averaged, instead of growing with the cut.
    """

    def __init__(
        self,
        samples_per_rev: int = 64,
        max_order: float = 16.0,
        segment_points: int = ORDER_SEGMENT_POINTS,
    ) -> None:
        self._spr = samples_per_rev
        self._max_order = max_order
        self._seg = int(segment_points)
        self._n = 0  # samples fed
        self._first = 0.0  # revs of the first sample: the grid's origin
        self._prev: tuple[float, float] | None = None  # last sample fed, to bridge the next seam
        self._buf = np.zeros(0, dtype=np.float64)  # resampled grid values not yet consumed
        self._buf_start = 0  # grid index of _buf[0]
        self._window: np.ndarray | None = None
        self._power: np.ndarray | None = None
        self._n_seg = 0

    def _grid(self, k: int) -> float:
        # The same expression the whole-array grid uses (revs[0] + arange(N) / spr), per point.
        return self._first + float(k) / self._spr

    def add(self, revs: np.ndarray, sig: np.ndarray) -> None:
        revs = np.asarray(revs, dtype=np.float64)
        sig = np.asarray(sig, dtype=np.float64)
        if revs.size == 0:
            return
        if self._prev is None:
            self._first = float(revs[0])
            xp, fp = revs, sig
        else:
            xp = np.concatenate(([self._prev[0]], revs))
            fp = np.concatenate(([self._prev[1]], sig))
        self._n += revs.size
        self._prev = (float(revs[-1]), float(sig[-1]))
        # Resample every grid point not yet taken that this chunk reaches (grid <= its last revs);
        # the estimate is nudged so the boundary matches the per-point grid expression exactly.
        last = float(xp[-1])
        k0 = self._buf_start + self._buf.size
        k1 = max(k0, int(np.floor((last - self._first) * self._spr)) + 1)
        while k1 > k0 and self._grid(k1 - 1) > last:
            k1 -= 1
        while self._grid(k1) <= last:
            k1 += 1
        if k1 > k0:
            grid = self._first + np.arange(k0, k1) / self._spr
            self._buf = np.concatenate((self._buf, np.interp(grid, xp, fp)))
            # A segment is only taken once the grid has run two revolutions past its end: the
            # final whole-revolution truncation (result()) removes less than that, so a segment
            # consumed now is certain to lie inside the grid the whole-array form would build.
            self._drain(self._buf_start + self._buf.size - 2 * self._spr)

    def _drain(self, end: int) -> None:
        """Consume every full segment that ends at or before grid index `end`."""
        hop = max(1, self._seg // 2)
        while self._buf_start + self._seg <= end and self._buf.size >= self._seg:
            if self._power is None:
                self._window = np.hanning(self._seg)
                self._power = np.zeros(self._seg // 2 + 1, dtype=np.float64)
            r = self._buf[: self._seg]
            self._power += np.abs(np.fft.rfft((r - r.mean()) * self._window)) ** 2
            self._n_seg += 1
            self._buf = self._buf[hop:].copy()
            self._buf_start += hop

    def result(self) -> tuple[list[float], list[float]]:
        spr = self._spr
        if self._prev is None or self._n < spr * 2:
            return [], []
        n_rev = int(self._prev[0] - self._first)
        if n_rev < 2:
            return [], []
        total = n_rev * spr
        if self._n_seg == 0 and total <= self._seg:
            # Short enough to transform in one piece: exactly the pre-#79 computation.
            resampled = self._buf[:total]
            w = np.hanning(resampled.size)
            spec = np.abs(np.fft.rfft((resampled - resampled.mean()) * w))
            amp = spec * (2.0 / w.sum())
            orders = np.fft.rfftfreq(resampled.size, d=1.0 / spr)
        else:
            self._drain(total)
            amp = np.sqrt(self._power / self._n_seg) * (2.0 / self._window.sum())
            orders = np.fft.rfftfreq(self._seg, d=1.0 / spr)
        keep = orders <= self._max_order
        return orders[keep].tolist(), amp[keep].tolist()


class LinearFit:
    """Least-squares straight line y ~ mean_y + slope * (x - mean_x), accumulated chunk by chunk.

    Each chunk's centred sums are merged into the running ones with the pairwise update of Chan,
    Golub & LeVeque, so no full-length copy of x or y is ever needed, and nothing is lost to the
    cancellation that raw sums of x**2 and x*y suffer over 10^8 samples. `y` may be (m,) or (m, k):
    k columns fitted against the same x at once.
    """

    def __init__(self) -> None:
        self.n = 0
        self.mean_x = 0.0
        self.mean_y: np.ndarray | float = 0.0
        self._sxx = 0.0
        self._sxy: np.ndarray | float = 0.0

    def add(self, x: np.ndarray, y: np.ndarray) -> None:
        m = int(x.shape[0])
        if m == 0:
            return
        mx = float(np.mean(x))
        my = np.mean(y, axis=0)
        dx = x - mx
        sxx = float(dx @ dx)
        sxy = dx @ (y - my)
        if self.n == 0:
            self.n, self.mean_x, self.mean_y, self._sxx, self._sxy = m, mx, my, sxx, sxy
            return
        n = self.n + m
        ddx, ddy = mx - self.mean_x, my - self.mean_y
        w = self.n * m / n
        self.mean_x += ddx * m / n
        self.mean_y = self.mean_y + ddy * m / n
        self._sxx += sxx + ddx * ddx * w
        self._sxy = self._sxy + sxy + ddx * ddy * w
        self.n = n

    @property
    def slope(self) -> np.ndarray | float:
        return self._sxy / self._sxx if self._sxx > 0 else self._sxy * 0.0

    def trend(self, x: np.ndarray) -> np.ndarray:
        """The fitted line at `x` -- (m,) for a 1-D fit, (m, k) for a k-column one."""
        dx = x - self.mean_x
        if np.ndim(self.mean_y):
            dx = dx[:, None]
        return self.mean_y + self.slope * dx


def drift_check(t: np.ndarray, axes: dict[str, np.ndarray], thresh_frac: float = 0.1) -> dict:
    """Flag whether each summed axis shows a linear baseline drift large enough to matter,
    independent of whether drift_comp correction is enabled -- this is a diagnostic check, not
    the correction itself (see finalize.py's drift_comp, which unconditionally detrends when the
    operator opts in). "Large enough to matter" is the trend's total excursion over the capture
    (|slope| * duration) exceeding `thresh_frac` of the axis's own peak-to-peak amplitude, so a
    small drift on a small, quiet signal isn't judged by the same absolute-Newtons yardstick as
    a small drift on a violently noisy one.

    The whole-array form of DriftCheck.
    """
    acc = DriftCheck(list(axes), thresh_frac)
    acc.add(t, axes)
    return acc.result()


class DriftCheck:
    """drift_check accumulated chunk by chunk (finalize streams a long cut window through it): the
    least-squares slope via LinearFit, plus running min/max for the peak-to-peak and the first/last
    time for the duration -- everything the verdict needs, none of it full-length."""

    def __init__(self, names: list[str], thresh_frac: float = 0.1) -> None:
        self._names = list(names)
        self._thresh = thresh_frac
        self._fit = LinearFit()
        self._lo: np.ndarray | None = None
        self._hi: np.ndarray | None = None
        self._t_first = 0.0
        self._t_last = 0.0
        self._n = 0

    def add(self, t: np.ndarray, axes: dict[str, np.ndarray]) -> None:
        t = np.asarray(t, dtype=np.float64)
        if t.size == 0:
            return
        if self._n == 0:
            self._t_first = float(t[0])
        self._t_last = float(t[-1])
        self._n += t.size
        if not self._names:
            return
        cols = [np.asarray(axes[k], dtype=np.float64) for k in self._names]
        y = np.column_stack(cols)
        self._fit.add(t, y)
        # Reduce each contiguous 1-D column rather than strided axis=0 over the (m, k) stack.
        lo = np.array([c.min() for c in cols])
        hi = np.array([c.max() for c in cols])
        self._lo = lo if self._lo is None else np.minimum(self._lo, lo)
        self._hi = hi if self._hi is None else np.maximum(self._hi, hi)

    def result(self) -> dict:
        duration = self._t_last - self._t_first if self._n > 1 else 0.0
        out: dict = {}
        any_detected = False
        for i, name in enumerate(self._names):
            if self._n < 2 or duration <= 0:
                out[name] = {"slope_n_per_sec": 0.0, "excursion_frac": 0.0, "detected": False}
                continue
            slope = float(self._fit.slope[i])
            ptp = float(self._hi[i] - self._lo[i])
            excursion_frac = (abs(slope) * duration / ptp) if ptp > 1e-9 else 0.0
            detected = excursion_frac > self._thresh
            any_detected = any_detected or detected
            out[name] = {
                "slope_n_per_sec": slope,
                "excursion_frac": excursion_frac,
                "detected": detected,
            }
        out["detected"] = any_detected
        return out
