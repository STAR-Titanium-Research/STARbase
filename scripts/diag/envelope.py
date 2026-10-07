"""Event-band (envelope) analysis: recover a repetition rate the dynamometer's own
structural resonance is amplifying but cannot itself directly measure.

Above roughly fn/5 (the dynamometer's valid quantitative bandwidth -- see the design spec and
frame_transform's module docstring), the sensor stops measuring cutting force honestly and
starts ringing at its own resonance instead. That ringing is still useful: if something in
the process (chip segmentation, an impact) is exciting that resonance at some rate, the
resonance's AMPLITUDE is modulated at that rate even though its own frequency is far above
what the sensor can resolve. Band-pass around the resonance, take the Hilbert envelope, and
the envelope's own spectrum recovers the modulation rate -- the standard AM-demodulation
trick, also how bearing-fault diagnostics recovers a fault's repetition rate from a carrier
frequency the sensor can measure even when the fault rate itself is out of direct reach.

Deliberately time-domain: this operates on the FULL-RATE raw signal, not the angular-resampled
data the rest of this package's pipeline works in. The frequency content this recovers lives
in Hz (a real, physical rate), which the angular domain's orders-per-revolution deliberately
discards.
"""

from __future__ import annotations

import numpy as np
from scipy.signal import butter, hilbert, sosfiltfilt, welch


def bandpass_envelope(
    sig: np.ndarray, fs: float, f_center: float, bandwidth_frac: float = 0.2
) -> np.ndarray:
    """Band-pass `sig` around `f_center` (width `bandwidth_frac` of `f_center`, split evenly
    above and below) and return the Hilbert envelope -- same length as `sig`, non-negative.

    Raises ValueError if `f_center` is not strictly positive, or if the requested band does
    not fit strictly inside (0, Nyquist): asking for a band that touches or exceeds Nyquist
    would alias rather than isolate the resonance, which is worse than refusing outright.
    """
    sig = np.asarray(sig, dtype=np.float64)
    if f_center <= 0:
        raise ValueError(f"f_center must be > 0, got {f_center}")
    nyquist = fs / 2.0
    lo = f_center * (1.0 - bandwidth_frac / 2.0)
    hi = f_center * (1.0 + bandwidth_frac / 2.0)
    if lo <= 0.0 or hi >= nyquist:
        raise ValueError(
            f"requested band [{lo:.1f}, {hi:.1f}] Hz does not fit strictly inside "
            f"(0, Nyquist={nyquist:.1f}) Hz at fs={fs:.1f} Hz"
        )
    # Second-order sections, not (b, a): the transfer-function form of a narrow band-pass at
    # a low normalised frequency (fc=200 or 500 Hz at fs=100 kHz is ~0.002-0.005 of Nyquist)
    # is so ill-conditioned that filtfilt returns garbage (~1e92, or NaN).
    sos = butter(4, [lo / nyquist, hi / nyquist], btype="band", output="sos")
    filtered = sosfiltfilt(sos, sig)
    return np.abs(hilbert(filtered))


def envelope_spectrum(
    envelope: np.ndarray, fs: float, max_freq: float | None = None
) -> tuple[np.ndarray, np.ndarray]:
    """Amplitude spectrum of the envelope itself (Welch), optionally capped at `max_freq` --
    the modulation-rate content lives at low frequencies relative to the carrier, so most
    callers cap this well below fs/2."""
    envelope = np.asarray(envelope, dtype=np.float64)
    nperseg = min(4096, envelope.size)
    freqs, power = welch(envelope - envelope.mean(), fs=fs, nperseg=nperseg)
    amplitude = np.sqrt(power)
    if max_freq is not None:
        keep = freqs <= max_freq
        freqs, amplitude = freqs[keep], amplitude[keep]
    return freqs, amplitude
