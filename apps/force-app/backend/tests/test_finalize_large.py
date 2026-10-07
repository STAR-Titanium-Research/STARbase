"""#79: "Unable to allocate 2.31 GiB" finalizing a 12430 s capture. finalize must now handle a raw
file far larger than any one block in bounded memory. This writes a 2 GB synthetic capture
(50M samples at 25 kHz, 2000 s) and finalizes it under tracemalloc -- numpy reports its buffers
there -- asserting the peak stays a fixed few hundred MB rather than the several GB the
whole-array path needed (one float64 copy of the nine signal columns alone is 3.6 GB here).
"""

import os
import time
import tracemalloc

import numpy as np
import pytest

from app.config import SIGNAL_CHANNELS, RecordConfig
from app.d1lc import parse_d1lc
from app.d1rw import RawWriter
from app.finalize import finalize

FS = 25_000.0
N = 50_000_000
CUT = (12_345_678, 41_234_567)  # first/last sample of the cut
RPM = 1500.0  # one tacho pulse every 1000 samples
PEAK_BUDGET = 600e6  # bytes; the measured peak is ~half this, independent of N


def _write_large(path):
    w = RawWriter(os.path.join(path, "raw.d1raw"), 1 + len(SIGNAL_CHANNELS), FS, start_unix=0.0)
    step = 2_000_000
    for a in range(0, N, step):
        idx = np.arange(a, min(N, a + step))
        t = idx / FS
        phase = idx * (RPM / 60.0 / FS)  # revolutions
        on = (idx >= CUT[0]) & (idx <= CUT[1])
        data = np.zeros((idx.size, len(SIGNAL_CHANNELS)), dtype=np.float32)
        fz = np.where(on, 100.0 + 20.0 * np.sin(2 * np.pi * 4 * phase), 0.0)  # 4th-order ripple
        data[:, 0] = data[:, 1] = np.where(on, 15.0, 0.0)
        for c in (4, 5, 6, 7):
            data[:, c] = fz / 4
        data[:, 8] = (idx % 1000 < 150) * 5.0  # integer period: every interval exactly 1000
        w.append(t, data)
    w.close()


@pytest.fixture
def big_capture(tmp_path):
    d = str(tmp_path / "big")
    os.makedirs(d)
    try:
        _write_large(d)
        yield d
    finally:
        # 2 GB: don't leave it for pytest's tmp retention to accumulate across runs.
        for name in os.listdir(d):
            os.remove(os.path.join(d, name))


@pytest.mark.slow
def test_a_long_capture_finalizes_in_bounded_memory(big_capture):
    cfg = RecordConfig(sample_rate=FS, rpm=RPM, feed=0.05, diam=80)
    tracemalloc.start()
    t0 = time.perf_counter()
    try:
        summary = finalize(big_capture, cfg)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    elapsed = time.perf_counter() - t0
    print(f"\nfinalize of {N:,} rows: peak {peak / 1e6:.0f} MB traced, {elapsed:.1f} s")

    assert peak < PEAK_BUDGET
    assert summary["n"] == N
    assert summary["mat_written"] is False  # 4 GB of DATA: over MAT_MAX_BYTES, skipped as before
    assert summary["tacho_measured"] is True
    # Exact sample times (float64), which the float32 column could not resolve at t ~ 1650 s.
    assert summary["cut_window_sec"] == [CUT[0] / FS, CUT[1] / FS]
    assert summary["duration_sec"] == pytest.approx((N - 1) / FS, abs=1e-9)
    assert summary["peaks"]["Fz"] == pytest.approx(120.0, rel=1e-4)  # sampled sine: crest not hit
    assert summary["local_diag"]["drift"]["detected"] is False
    spec = summary["local_diag"]["order_spectrum"]
    assert summary["local_diag"]["order_spectrum_status"] == "computed"
    assert len(spec["orders"]) == 16 * 4096 + 1  # a 28,900-rev cut, segment-averaged
    assert spec["orders"][int(np.argmax(spec["amplitude"]))] == pytest.approx(4.0)

    with open(os.path.join(big_capture, "live_cache.bin"), "rb") as f:
        lc = parse_d1lc(f.read())
    assert 300_000 <= lc["t"].size <= 600_000
    np.testing.assert_allclose(lc["rpm"][lc["rpm"] > 0], RPM, rtol=1e-6)
    assert lc["revs"][-1] == pytest.approx(N / FS * RPM / 60.0, rel=1e-3)
