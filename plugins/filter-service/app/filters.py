"""FRM signal-filter chain.

Fixed stage order: despike -> detrend -> lowpass -> notch, each
independently enabled. All IIR stages run ZERO-PHASE
(sosfiltfilt/filtfilt) so the FRM spiral geometry never
phase-shifts. Must stay in lock-step with the MATLAB twin
(scripts/matlab/frm_filters.m); test_parity.py guards the pair.
"""

from __future__ import annotations

import os

import numpy as np
from scipy import signal

# despike.window is user-controlled and the Hampel median costs O(n * window): window=2001 on 200k
# samples took 36 s and 6.1 GB. The dashboard's number input has no max, so existing saved chains
# use 11 (the default) or small odd values; 1001 (~40 ms at 25.6 kHz) leaves ample headroom.
MAX_DESPIKE_WINDOW = int(os.environ.get("FILTER_MAX_DESPIKE_WINDOW", "1001"))
# Upper bound on n_samples * window per axis, so a wide window on a multi-million-sample cache
# is refused up front instead of pinning a worker for minutes.
MAX_DESPIKE_WORK = int(float(os.environ.get("FILTER_MAX_DESPIKE_WORK", "2e9")))
# Rows of the sliding-window matrix medianed at once (bounds the working set to ~64 MB).
_HAMPEL_BLOCK_ELEMS = 8_000_000


class ChainError(ValueError):
    """Invalid chain parameters (surfaced as HTTP 422)."""


def _hampel(x: np.ndarray, window: int, sigma: float) -> np.ndarray:
    """Hampel despike: replace samples > sigma * 1.4826*MAD from the rolling median.
    Implemented with stride tricks over an odd centred window (edges left untouched).
    The medians are taken in row blocks so memory stays bounded for any n * window."""
    n = x.size
    if n < window:
        return x
    half = window // 2
    sw = np.lib.stride_tricks.sliding_window_view(x, window)
    m = sw.shape[0]
    block = max(1, _HAMPEL_BLOCK_ELEMS // window)
    out = x.copy()
    for lo in range(0, m, block):
        hi = min(m, lo + block)
        win = sw[lo:hi]
        med = np.median(win, axis=1)
        mad = np.median(np.abs(win - med[:, None]), axis=1)
        thr = sigma * 1.4826 * mad
        centre = x[half + lo : half + hi]
        bad = np.abs(centre - med) > thr
        out[half + lo : half + hi] = np.where(bad, med, centre)
    return out


def _validate(chain: dict, fs: float) -> None:
    nyq = fs / 2
    d = chain.get("despike") or {}
    if d.get("on"):
        w = int(d.get("window", 11))
        if w < 3 or w % 2 == 0:
            raise ChainError("despike.window must be odd and >= 3")
        if w > MAX_DESPIKE_WINDOW:
            raise ChainError(f"despike.window must be <= {MAX_DESPIKE_WINDOW}")
        if float(d.get("sigma", 5)) <= 0:
            raise ChainError("despike.sigma must be > 0")
    t = chain.get("detrend") or {}
    if t.get("on") and t.get("mode", "highpass") == "highpass":
        if not (0 < float(t.get("cutoff_hz", 5)) < nyq):
            raise ChainError(f"detrend.cutoff_hz must be in (0, {nyq:g})")
    hp = chain.get("highpass") or {}
    if hp.get("on"):
        if not (0 < float(hp.get("cutoff_hz", 50)) < nyq):
            raise ChainError(f"highpass.cutoff_hz must be in (0, {nyq:g})")
        if not (1 <= int(hp.get("order", 4)) <= 10):
            raise ChainError("highpass.order must be 1..10")
    lp = chain.get("lowpass") or {}
    if lp.get("on"):
        if not (0 < float(lp.get("cutoff_hz", 2000))):
            raise ChainError("lowpass.cutoff_hz must be > 0")
        if not (1 <= int(lp.get("order", 4)) <= 10):
            raise ChainError("lowpass.order must be 1..10")
    nt = chain.get("notch") or {}
    if nt.get("on"):
        if float(nt.get("q", 30)) <= 0:
            raise ChainError("notch.q must be > 0")
        if not nt.get("harmonics"):
            raise ChainError("notch.harmonics must be a non-empty list")


def apply_chain(
    axes: dict[str, np.ndarray], fs: float, mean_rpm: float, chain: dict
) -> tuple[dict[str, np.ndarray], list[str]]:
    """Apply the chain to each axis array (float64 in, float64 out).

    Returns (filtered axes, skipped-stage notes). Stages whose frequency exceeds the
    Nyquist of THIS signal (preview data may be decimated) are skipped and reported —
    the bake applies them at full rate.
    """
    _validate(chain, fs)
    d0 = chain.get("despike") or {}
    if d0.get("on"):
        n_max = max((v.size for v in axes.values()), default=0)
        if n_max * int(d0.get("window", 11)) > MAX_DESPIKE_WORK:
            raise ChainError(
                f"despike.window {int(d0.get('window', 11))} is too large for "
                f"{n_max} samples; reduce the window"
            )
    nyq = fs / 2
    skipped: list[str] = []
    out = {k: v.astype(np.float64, copy=True) for k, v in axes.items()}

    d = chain.get("despike") or {}
    if d.get("on"):
        w = int(d.get("window", 11))
        sg = float(d.get("sigma", 5))
        for k in out:
            out[k] = _hampel(out[k], w, sg)

    t = chain.get("detrend") or {}
    if t.get("on"):
        if t.get("mode", "highpass") == "dc":
            for k in out:
                out[k] = out[k] - out[k].mean()
        else:
            fc = float(t.get("cutoff_hz", 5))
            if fc >= nyq:
                skipped.append(f"detrend HP {fc:g} Hz >= preview Nyquist {nyq:g} Hz")
            else:
                sos = signal.butter(2, fc / nyq, btype="highpass", output="sos")
                for k in out:
                    out[k] = signal.sosfiltfilt(sos, out[k])

    hp = chain.get("highpass") or {}
    if hp.get("on"):
        fc = float(hp.get("cutoff_hz", 50))
        order = int(hp.get("order", 4))
        if fc >= nyq:
            skipped.append(f"highpass {fc:g} Hz >= preview Nyquist {nyq:g} Hz")
        else:
            sos = signal.butter(order, fc / nyq, btype="highpass", output="sos")
            for k in out:
                out[k] = signal.sosfiltfilt(sos, out[k])

    lp = chain.get("lowpass") or {}
    if lp.get("on"):
        fc = float(lp.get("cutoff_hz", 2000))
        order = int(lp.get("order", 4))
        if fc >= nyq:
            skipped.append(f"lowpass {fc:g} Hz >= preview Nyquist {nyq:g} Hz")
        else:
            sos = signal.butter(order, fc / nyq, btype="lowpass", output="sos")
            for k in out:
                out[k] = signal.sosfiltfilt(sos, out[k])

    nt = chain.get("notch") or {}
    if nt.get("on"):
        f0 = mean_rpm / 60.0
        q = float(nt.get("q", 30))
        for h in nt.get("harmonics", []):
            fh = f0 * float(h)
            if fh <= 0 or fh >= nyq:
                skipped.append(f"notch {h}x ({fh:.1f} Hz) outside (0, {nyq:g}) Hz")
                continue
            b, a = signal.iirnotch(fh / nyq, q)
            for k in out:
                out[k] = signal.filtfilt(b, a, out[k])

    return out, skipped
