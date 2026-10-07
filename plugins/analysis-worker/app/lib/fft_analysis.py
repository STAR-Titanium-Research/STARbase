"""FFT-based frequency analysis for D1F force data.

The spectrum is a Welch estimate (Hann window, 50 % overlap, power-averaged)
computed from *contiguous* blocks of samples at the native sample rate. Large
files are covered by a bounded number of evenly spaced blocks, so memory and
time stay bounded for multi-GB files without decimating (a strided read with no
anti-alias filter folds everything above the decimated Nyquist back into the
band and zeroes the high bands).

Amplitudes are one-sided and window-corrected: a sine of amplitude A shows up
as a peak of height ~A. DC and (for even nperseg) Nyquist are not doubled.
"""

import io
from collections.abc import Iterable, Iterator
from dataclasses import dataclass

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np

MIN_NPERSEG = 4096
MAX_NPERSEG = 65536
# Segments per block; with 50 % overlap a block of 8 x nperseg holds 15 segments.
BLOCK_NPERSEG_MULTIPLE = 8
# Peaks closer than this many bins to a stronger peak are leakage, not new peaks.
MIN_PEAK_SEPARATION_BINS = 8
_SEGMENT_BATCH = 16

BANDS_HZ = (
    ("0_500_hz", 0.0, 500.0),
    ("500_2000_hz", 500.0, 2000.0),
    ("2000_plus_hz", 2000.0, float("inf")),
)


@dataclass
class Spectrum:
    """One-sided amplitude spectrum plus the sample statistics it was built from."""

    freqs: np.ndarray
    amplitude: np.ndarray
    fs_hz: float
    nperseg: int
    n_segments: int
    n_blocks: int
    n_samples: int
    rms: float
    peak: float

    @property
    def nyquist_hz(self) -> float:
        return self.fs_hz / 2.0

    @property
    def resolution_hz(self) -> float:
        return self.fs_hz / self.nperseg


def default_nperseg(fs_hz: float) -> int:
    """Segment length adapted to the sample rate: ~2 s of data, power of two, clamped."""
    target = max(2.0, 2.0 * fs_hz)
    n = 1 << int(np.ceil(np.log2(target)))
    return int(min(MAX_NPERSEG, max(MIN_NPERSEG, n)))


def plan_blocks(
    n_samples: int, nperseg: int, max_blocks: int = 32
) -> list[tuple[int, int]]:
    """Return [(start, count)] contiguous blocks covering the file.

    If the whole file fits in *max_blocks* blocks it is covered completely in
    non-overlapping blocks; otherwise *max_blocks* equal blocks are spaced evenly
    across the file so the work is bounded regardless of file size.
    """
    block_len = BLOCK_NPERSEG_MULTIPLE * nperseg
    if n_samples <= block_len:
        return [(0, n_samples)]
    max_blocks = max(1, max_blocks)
    if n_samples <= block_len * max_blocks:
        plan = [
            (s, min(block_len, n_samples - s)) for s in range(0, n_samples, block_len)
        ]
        # A short tail (< nperseg) can't hold a segment; fold it into coverage by
        # shifting the final block back instead of dropping the end of the file.
        if plan[-1][1] < nperseg:
            plan[-1] = (n_samples - block_len, block_len)
        return plan
    starts = np.linspace(0, n_samples - block_len, max_blocks).astype(np.int64)
    return [(int(s), block_len) for s in starts]


def _segments(x: np.ndarray, nperseg: int) -> Iterator[np.ndarray]:
    """Yield batches of 50 %-overlapping segments of *x* (batches bound memory)."""
    hop = max(1, nperseg // 2)
    view = np.lib.stride_tricks.sliding_window_view(x, nperseg)[::hop]
    for i in range(0, len(view), _SEGMENT_BATCH):
        yield view[i : i + _SEGMENT_BATCH]


def compute_spectrum(
    blocks: Iterable[np.ndarray], fs_hz: float, nperseg: int | None = None
) -> Spectrum | None:
    """Welch amplitude spectrum over *blocks* (each a contiguous 1-D array).

    *blocks* is consumed lazily, one block in memory at a time. Blocks shorter
    than *nperseg* still count towards rms/peak but hold no segment. Returns None
    if no segment could be formed (callers clip *nperseg* to short signals).
    """
    nperseg = nperseg or default_nperseg(fs_hz)
    if nperseg < 2:
        return None

    k = np.arange(nperseg)
    window = 0.5 - 0.5 * np.cos(2.0 * np.pi * k / nperseg)  # periodic Hann
    win_sum = float(window.sum())

    power = np.zeros(nperseg // 2 + 1)
    n_segments = 0
    n_blocks = 0
    sum_sq = 0.0
    n_total = 0
    peak = 0.0
    for raw in blocks:
        b = np.asarray(raw, dtype=np.float64)
        if len(b) == 0:
            continue
        sum_sq += float(np.dot(b, b))
        n_total += len(b)
        peak = max(peak, float(np.abs(b).max()))
        if len(b) < nperseg:
            continue
        n_blocks += 1
        for batch in _segments(b, nperseg):
            seg = batch - batch.mean(axis=1, keepdims=True)
            power += (np.abs(np.fft.rfft(seg * window, axis=1)) ** 2).sum(axis=0)
            n_segments += len(batch)

    if n_segments == 0:
        return None

    amplitude = np.sqrt(power / n_segments) * (2.0 / win_sum)
    amplitude[0] /= 2.0  # DC is not mirrored
    if nperseg % 2 == 0:
        amplitude[-1] /= 2.0  # neither is Nyquist

    return Spectrum(
        freqs=np.fft.rfftfreq(nperseg, d=1.0 / fs_hz),
        amplitude=amplitude,
        fs_hz=float(fs_hz),
        nperseg=int(nperseg),
        n_segments=n_segments,
        n_blocks=n_blocks,
        n_samples=n_total,
        rms=float(np.sqrt(sum_sq / n_total)),
        peak=peak,
    )


def find_peaks(
    freqs: np.ndarray,
    amplitude: np.ndarray,
    n_top: int = 5,
    min_separation_hz: float | None = None,
) -> list[dict]:
    """Return up to *n_top* distinct spectral peaks, strongest first.

    A peak is a local maximum (DC excluded). Peaks within *min_separation_hz* of
    a stronger one are dropped, so a single tone's leakage bins don't fill the
    list.
    """
    if len(freqs) < 3:
        return []
    df = float(freqs[1] - freqs[0])
    if min_separation_hz is None:
        min_separation_hz = MIN_PEAK_SEPARATION_BINS * df
    a = amplitude
    inner = np.arange(1, len(a) - 1)
    is_max = (a[inner] > a[inner - 1]) & (a[inner] >= a[inner + 1])
    cand = inner[is_max]
    # Edge bins (just above DC / at Nyquist) can be real peaks too.
    if len(a) > 2 and a[-1] > a[-2]:
        cand = np.append(cand, len(a) - 1)
    if len(a) > 2 and a[1] > a[2]:
        cand = np.append(cand, 1)
    cand = np.unique(cand)
    cand = cand[np.argsort(a[cand])[::-1]]

    chosen: list[int] = []
    for i in cand:
        if all(abs(freqs[i] - freqs[j]) >= min_separation_hz for j in chosen):
            chosen.append(int(i))
            if len(chosen) >= n_top:
                break
    return [{"frequency_hz": float(freqs[i]), "magnitude": float(a[i])} for i in chosen]


def analyse_spectrum(spec: Spectrum, n_top: int = 5) -> dict:
    """Key frequency metrics of *spec* (same keys as before, plus fs/Nyquist)."""
    freqs, amp = spec.freqs, spec.amplitude
    top = find_peaks(freqs, amp, n_top)
    if top:
        dominant = top[0]
    else:  # degenerate (very short) spectrum
        i = int(np.argmax(amp[1:]) + 1) if len(amp) > 1 else 0
        dominant = {"frequency_hz": float(freqs[i]), "magnitude": float(amp[i])}

    band_energy = {
        name: float(np.sum(amp[(freqs >= lo) & (freqs < hi)] ** 2))
        for name, lo, hi in BANDS_HZ
    }
    return {
        "rms": spec.rms,
        "peak": spec.peak,
        "dominant_frequency_hz": dominant["frequency_hz"],
        "dominant_magnitude": dominant["magnitude"],
        "top_frequencies": top,
        "band_energy": band_energy,
        "fs_hz": spec.fs_hz,
        "effective_nyquist_hz": spec.nyquist_hz,
        "frequency_resolution_hz": spec.resolution_hz,
        "nperseg": spec.nperseg,
        "n_segments": spec.n_segments,
        "n_blocks": spec.n_blocks,
        "window": "hann",
    }


def analyse_channel(
    signal: np.ndarray,
    sample_rate_hz: float,
    actual_stride: int = 1,
    n_top: int = 5,
    nperseg: int | None = None,
) -> dict:
    """Spectrum metrics for an in-memory contiguous *signal*.

    *actual_stride* is kept for callers that pre-decimated the signal; the
    spectrum axis then uses the effective rate ``sample_rate_hz / actual_stride``.
    Prefer :func:`compute_spectrum` over blocks read at the native rate.
    """
    n = len(signal)
    if n < 2:
        return {"error": "insufficient samples"}
    nperseg = min(nperseg or default_nperseg(sample_rate_hz / actual_stride), n)
    spec = compute_spectrum([signal], sample_rate_hz / actual_stride, nperseg)
    if spec is None:
        return {"error": "insufficient samples"}
    return analyse_spectrum(spec, n_top)


def plot_spectrum_from(
    spec: Spectrum, channel_name: str = "Fz", channel_unit: str = "N"
) -> bytes:
    """Return SVG bytes of the one-sided amplitude spectrum in *spec*."""
    fig, ax = plt.subplots(figsize=(12, 4))
    ax.plot(spec.freqs[1:], spec.amplitude[1:], linewidth=0.6)
    ax.set_xlabel("Frequency (Hz)")
    ax.set_ylabel(f"Amplitude ({channel_unit})")
    ax.set_title(f"Amplitude Spectrum — {channel_name}")
    ax.grid(alpha=0.3)
    fig.tight_layout()

    buf = io.BytesIO()
    fig.savefig(buf, format="svg", bbox_inches="tight")
    plt.close(fig)
    buf.seek(0)
    return buf.read()


def plot_spectrum(
    signal: np.ndarray,
    sample_rate_hz: float,
    actual_stride: int = 1,
    channel_name: str = "Fz",
    channel_unit: str = "N",
) -> bytes:
    """Return SVG bytes of the amplitude spectrum of an in-memory *signal*."""
    fs = sample_rate_hz / actual_stride
    if len(signal) < 2:
        msg = "insufficient samples"
        raise ValueError(msg)
    spec = compute_spectrum([signal], fs, min(default_nperseg(fs), len(signal)))
    if spec is None:
        msg = "insufficient samples"
        raise ValueError(msg)
    return plot_spectrum_from(spec, channel_name, channel_unit)
