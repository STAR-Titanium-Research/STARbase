"""#186: the live FFT's x resolution. The old reduction kept every step-th Welch bin (240 of
~2049), so a narrow peak that fell between the kept bins vanished and the plot looked blocky."""

import numpy as np
import scipy.signal as ssig

from app import session
from app.dsp import SPECTRUM_MAX_BINS, welch_spectra

FS = 25_000.0


def _full_res_amp(sig: np.ndarray, nperseg: int) -> tuple[np.ndarray, np.ndarray]:
    f, p = ssig.welch(sig, fs=FS, nperseg=nperseg)
    return f, np.sqrt(p)


def test_wire_spectrum_has_at_least_1000_bins():
    sig = np.random.default_rng(1).standard_normal(25_000)
    f, spectra = welch_spectra({"Fz": sig}, fs=FS, nperseg=8192)
    assert f is not None
    assert len(f) >= 1000
    assert len(f) <= SPECTRUM_MAX_BINS
    assert len(spectra["Fz"]) == len(f)
    assert f[0] == 0.0 and f == sorted(f)


def test_live_path_uses_the_longer_window():
    assert session.FFT_NPERSEG == 8192


def test_a_narrow_peak_between_old_stride_picks_keeps_its_amplitude():
    nperseg = 4096
    n = 25_000
    t = np.arange(n) / FS
    f_full, _ = _full_res_amp(np.zeros(n), nperseg)
    step_old = max(1, f_full.size // 240)  # the pre-#186 stride
    # Centre of a bin that the old f[::step] pick skips (half a stride from a kept bin).
    k = 40 * step_old + step_old // 2
    f0 = float(f_full[k])
    assert k % step_old != 0
    sig = np.sin(2 * np.pi * f0 * t)

    _, amp_full = _full_res_amp(sig, nperseg)
    old_peak = amp_full[::step_old].max()
    true_peak = amp_full.max()
    assert old_peak < 0.9 * true_peak, "test setup: the old decimation must lose this peak"

    f, spectra = welch_spectra({"Fz": sig}, fs=FS, nperseg=nperseg)
    assert max(spectra["Fz"]) >= 0.97 * true_peak
    # the reduced peak is still located to within about one pooled group of the true frequency
    group_hz = f_full[-1] / (len(f) - 1) * 1.5
    assert abs(f[int(np.argmax(spectra["Fz"]))] - f0) <= group_hz


def test_peak_survives_at_8192_at_any_frequency():
    n = 25_000
    t = np.arange(n) / FS
    for f0 in (97.3, 1234.5, 4321.1, 9876.5, 12_000.7):
        sig = 3.0 * np.sin(2 * np.pi * f0 * t)
        _, amp_full = _full_res_amp(sig, 8192)
        _, spectra = welch_spectra({"Fz": sig}, fs=FS, nperseg=8192)
        assert max(spectra["Fz"]) >= 0.97 * amp_full.max(), f0


def test_dc_offset_stays_in_its_own_bin():
    sig = 50.0 + 0.01 * np.sin(2 * np.pi * 2000.0 * np.arange(25_000) / FS)
    f, spectra = welch_spectra({"Fz": sig}, fs=FS, nperseg=8192)
    amp = spectra["Fz"]
    assert f[0] == 0.0
    # the 2 kHz tone is not hidden inside a pooled group that also contains the DC bin
    i2k = int(np.argmin(np.abs(np.array(f) - 2000.0)))
    assert max(amp[i2k - 2 : i2k + 3]) > 0.001
