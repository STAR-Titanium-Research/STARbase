"""Unit tests for FFT analysis and spectrum generation."""

import struct

import numpy as np
import pytest

from app.lib.fft_analysis import analyse_channel, plot_spectrum

D1F_MAGIC = b"D1FORCE\n"
HEADER_SIZE = 64
N_CHANNELS = 6


def make_d1f(path: str, n_samples: int, sample_rate: float, freq_hz: float) -> None:
    """Write a synthetic D1F file with a sine wave on the Fz channel."""
    header = bytearray(HEADER_SIZE)
    header[0:8] = D1F_MAGIC
    header[8:9] = struct.pack("B", 1)
    header[9:10] = struct.pack("B", N_CHANNELS)
    header[10:18] = struct.pack("d", sample_rate)
    header[18:26] = struct.pack("Q", n_samples)

    t = np.arange(n_samples) / sample_rate
    fz = 500.0 * np.sin(2 * np.pi * freq_hz * t).astype(np.float32)
    data = np.column_stack([np.zeros((n_samples,), np.float32)] * N_CHANNELS)
    data[:, 2] = fz  # Fz channel

    with open(path, "wb") as f:
        f.write(bytes(header))
        f.write(data.tobytes())


@pytest.fixture
def sine_signal():
    """1-second sine at 250 Hz, 10 kHz sample rate, 500 N amplitude."""
    sample_rate = 10_000.0
    freq = 250.0
    n = 10_000
    t = np.arange(n) / sample_rate
    return 500.0 * np.sin(2 * np.pi * freq * t), sample_rate, freq


def test_dominant_frequency(sine_signal):
    signal, sample_rate, true_freq = sine_signal
    result = analyse_channel(signal, sample_rate)
    assert result["dominant_frequency_hz"] == pytest.approx(true_freq, rel=0.05)


def test_rms_of_sine(sine_signal):
    signal, sample_rate, _ = sine_signal
    result = analyse_channel(signal, sample_rate)
    expected_rms = 500.0 / np.sqrt(2)
    assert result["rms"] == pytest.approx(expected_rms, rel=0.01)


def test_peak_value(sine_signal):
    signal, sample_rate, _ = sine_signal
    result = analyse_channel(signal, sample_rate)
    assert result["peak"] == pytest.approx(500.0, rel=0.001)


def test_top_frequencies_count(sine_signal):
    signal, sample_rate, _ = sine_signal
    result = analyse_channel(signal, sample_rate, n_top=3)
    assert len(result["top_frequencies"]) == 3


def test_band_energy_keys(sine_signal):
    signal, sample_rate, _ = sine_signal
    result = analyse_channel(signal, sample_rate)
    assert set(result["band_energy"].keys()) == {
        "0_500_hz",
        "500_2000_hz",
        "2000_plus_hz",
    }


def test_dominant_frequency_with_stride():
    """With stride>1 the effective sample rate must be used for the freq axis.

    A 250 Hz tone sampled at 10 kHz then read with stride 4 has an effective
    rate of 2.5 kHz; 250 Hz is still well below Nyquist (1.25 kHz) so the
    dominant frequency must still resolve to ~250 Hz when actual_stride=4.
    """
    sample_rate = 10_000.0
    freq = 250.0
    stride = 4
    effective_n = 4096
    # Build the already-strided signal at the effective rate.
    eff_rate = sample_rate / stride
    t = np.arange(effective_n) / eff_rate
    signal = 500.0 * np.sin(2 * np.pi * freq * t)
    result = analyse_channel(signal, sample_rate, actual_stride=stride)
    assert result["dominant_frequency_hz"] == pytest.approx(freq, rel=0.05)


def test_band_energy_concentrated_in_correct_band(sine_signal):
    """A 250 Hz tone's energy must fall almost entirely in the 0–500 Hz band."""
    signal, sample_rate, _ = sine_signal
    result = analyse_channel(signal, sample_rate)
    bands = result["band_energy"]
    total = bands["0_500_hz"] + bands["500_2000_hz"] + bands["2000_plus_hz"]
    assert total > 0
    assert bands["0_500_hz"] / total > 0.95


def test_plot_spectrum_returns_svg(sine_signal):
    signal, sample_rate, _ = sine_signal
    svg = plot_spectrum(signal, sample_rate, actual_stride=1)
    assert svg.startswith(b"<?xml") or b"<svg" in svg[:200]


def test_d1f_reader(tmp_path):
    """Verify read_channel extracts the correct channel from a D1F file."""
    from app.lib.d1f_reader import parse_header, read_channel

    path = str(tmp_path / "test.d1f")
    make_d1f(path, n_samples=10_000, sample_rate=10_000.0, freq_hz=100.0)

    with open(path, "rb") as f:
        h = parse_header(f)

    assert h["n_samples"] == 10_000
    assert h["n_channels"] == N_CHANNELS

    fz = read_channel(path, h, channel_index=2, max_samples=10_000)
    assert fz.shape[0] == 10_000
    assert np.abs(fz).max() == pytest.approx(500.0, rel=0.01)

    fx = read_channel(path, h, channel_index=0, max_samples=10_000)
    assert np.allclose(fx, 0.0)


# ---------------------------------------------------------------------------
# Welch / contiguous-block analysis (review finding 6.3)
# ---------------------------------------------------------------------------


def _make_d1f_tones(path, n_samples, fs, tones, n_channels=3, chunk=500_000):
    """Write a D1F with *tones* [(freq_hz, amp)] on channel index 2, in chunks."""
    header = bytearray(HEADER_SIZE)
    header[0:8] = D1F_MAGIC
    header[8:9] = struct.pack("B", 1)
    header[9:10] = struct.pack("B", n_channels)
    header[10:18] = struct.pack("d", fs)
    header[18:26] = struct.pack("Q", n_samples)
    with open(path, "wb") as f:
        f.write(bytes(header))
        for s in range(0, n_samples, chunk):
            idx = np.arange(s, min(n_samples, s + chunk))
            t = idx / fs
            row = np.zeros((len(idx), n_channels), np.float32)
            for freq, amp in tones:
                row[:, 2] += (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)
            f.write(row.tobytes())


def _run_job(monkeypatch, path):
    """Run analyse_session on *path* with MinIO/Directus mocked; return fft_analysis."""
    import shutil
    from unittest.mock import MagicMock

    from app.jobs import analyse_session as job

    patched = []
    monkeypatch.setattr(
        job.minio_client, "download_file", lambda key, dst: shutil.copy(path, dst)
    )
    monkeypatch.setattr(job.minio_client, "put_object", MagicMock())
    row = {"status": "registered", "summary_stats": {}, "plot_uris": [], "version": 1}
    monkeypatch.setattr(job.directus_client, "get_test_session", lambda i: dict(row))
    monkeypatch.setattr(
        job.directus_client,
        "patch_test_session",
        lambda i, payload, version=None: patched.append(payload),
    )
    job.analyse_session("sess", "a/b.d1f")
    final = next(p for p in reversed(patched) if "summary_stats" in p)
    return final["summary_stats"]["fft_analysis"]


def test_large_file_tone_not_aliased(tmp_path, monkeypatch):
    """1 kHz at 20 kHz in a file big enough to have triggered the old stride.

    The old code strided every n//131072-th sample (21 here), giving an effective
    Nyquist of ~480 Hz and reporting the tone at an alias; the 500-2000 Hz band
    was structurally empty.
    """
    n = 2_800_000  # old stride = 21
    path = str(tmp_path / "big.d1f")
    _make_d1f_tones(path, n, 20_000.0, [(1000.0, 500.0)])

    res = _run_job(monkeypatch, path)

    assert res["dominant_frequency_hz"] == pytest.approx(1000.0, abs=1.0)
    assert res["dominant_magnitude"] == pytest.approx(
        500.0, rel=0.05
    )  # Hann scalloping loss
    bands = res["band_energy"]
    total = sum(bands.values())
    assert bands["500_2000_hz"] / total > 0.95
    assert res["fs_hz"] == 20_000.0
    assert res["effective_nyquist_hz"] == 10_000.0
    assert res["effective_sample_rate_hz"] == 20_000.0
    assert res["stride"] == 1
    assert res["n_samples_total"] == n


def test_sampled_blocks_path_for_huge_files(tmp_path, monkeypatch):
    """With few blocks allowed, only a bounded part of the file is read."""
    from app.jobs import analyse_session as job

    monkeypatch.setattr(job, "FFT_MAX_BLOCKS", 2)
    monkeypatch.setattr(job, "FFT_NPERSEG", 4096)
    path = str(tmp_path / "big.d1f")
    _make_d1f_tones(path, 600_000, 20_000.0, [(1000.0, 500.0)])
    res = _run_job(monkeypatch, path)
    assert res["n_blocks"] == 2
    assert res["n_samples_analysed"] == 2 * 8 * 4096
    assert res["dominant_frequency_hz"] == pytest.approx(1000.0, abs=6.0)


def test_two_tones_give_two_distinct_peaks():
    fs = 20_000.0
    n = 400_000
    t = np.arange(n) / fs
    sig = 300.0 * np.sin(2 * np.pi * 1000.0 * t) + 200.0 * np.sin(
        2 * np.pi * 3500.0 * t
    )
    res = analyse_channel(sig, fs, n_top=5)
    top = res["top_frequencies"]
    assert top[0]["frequency_hz"] == pytest.approx(1000.0, abs=1.0)
    assert top[1]["frequency_hz"] == pytest.approx(3500.0, abs=1.0)
    assert top[0]["magnitude"] == pytest.approx(300.0, rel=0.05)
    assert top[1]["magnitude"] == pytest.approx(200.0, rel=0.05)
    freqs = sorted(p["frequency_hz"] for p in top)
    min_gap = min(b - a for a, b in zip(freqs, freqs[1:], strict=False))
    assert min_gap >= 8 * res["frequency_resolution_hz"] * 0.999


def test_nyquist_and_dc_not_doubled():
    from app.lib.fft_analysis import compute_spectrum

    n = 1 << 14
    # Alternating +-1 is a unit-amplitude tone exactly at Nyquist.
    alt = np.where(np.arange(n) % 2 == 0, 1.0, -1.0)
    spec = compute_spectrum([alt], 100.0, nperseg=1024)
    assert spec.amplitude[-1] == pytest.approx(1.0, rel=1e-6)
    # A constant is DC only; per-segment mean removal leaves nothing.
    spec = compute_spectrum([np.full(n, 7.0)], 100.0, nperseg=1024)
    assert spec.amplitude.max() < 1e-9


def test_amplitude_scaling_of_bin_centred_tone():
    from app.lib.fft_analysis import compute_spectrum

    fs, nperseg = 1024.0, 1024
    t = np.arange(8 * nperseg) / fs
    spec = compute_spectrum([2.5 * np.sin(2 * np.pi * 64.0 * t)], fs, nperseg)
    assert spec.amplitude[64] == pytest.approx(2.5, rel=1e-6)
    assert spec.nyquist_hz == 512.0


def test_plan_blocks_is_bounded_and_ordered():
    from app.lib.fft_analysis import plan_blocks

    n = 100 * 1024**3 // 24  # a 100 GB, 6-channel file
    plan = plan_blocks(n, 65536, max_blocks=32)
    assert len(plan) == 32
    starts = [s for s, _ in plan]
    assert starts == sorted(starts) and starts[0] == 0
    assert all(c == 8 * 65536 for _, c in plan)
    assert plan[-1][0] + plan[-1][1] <= n
    # small file: whole file, one block
    assert plan_blocks(1000, 65536) == [(0, 1000)]
    # medium file: covered completely, no gaps
    plan = plan_blocks(3_000_000, 65536, max_blocks=32)
    assert plan[0][0] == 0 and plan[-1][0] + plan[-1][1] == 3_000_000


def test_short_signal_still_analysed():
    res = analyse_channel(np.sin(np.arange(100) * 0.3), 100.0)
    assert res["nperseg"] == 100
    assert analyse_channel(np.array([1.0]), 100.0) == {"error": "insufficient samples"}
