"""finalize() archiving extra (Aux/virtual) channels into capture.mat, appended after the fixed
10-column [Time, Fx1..Fz4, Tacho] layout — never touching raw.d1raw, never reordering the base 10."""

import os

import numpy as np
from scipy.io import loadmat

from app.config import SIGNAL_CHANNELS, ExtraChannel, RecordConfig
from app.d1rw import RawWriter
from app.finalize import finalize


def _write_raw(tmp_path, n, fs, extra_cols: int = 0, hw_value: float = 0.0):
    """A raw file with the fixed 9 signal columns (steady Fx/Fy/Fz + a real tacho pulse train) plus
    `extra_cols` additional constant-valued columns, standing in for real hardware Aux channels."""
    p = str(tmp_path)
    os.makedirs(p, exist_ok=True)
    n_cols = 1 + len(SIGNAL_CHANNELS) + extra_cols
    w = RawWriter(os.path.join(p, "raw.d1raw"), n_cols=n_cols, rate=fs, start_unix=0.0)
    t = np.arange(n) / fs
    data = np.zeros((n, len(SIGNAL_CHANNELS) + extra_cols))
    data[:, 0] = 10.0  # Fx1
    data[:, 4] = 20.0  # Fz1
    data[:, 8] = ((np.cumsum(np.full(n, 1200 / 60.0 / fs)) % 1.0) < 0.15) * 5.0  # tacho
    for i in range(extra_cols):
        data[:, 9 + i] = hw_value
    w.append(t, data)
    w.close()
    return p


def test_no_extra_channels_produces_the_original_10_column_layout(tmp_path):
    """A capture with none configured — which includes every capture recorded before extra
    channels existed — must be byte-for-byte the same shape as before this feature existed."""
    fs, n = 2000, 4000
    d = _write_raw(tmp_path, n, fs)
    cfg = RecordConfig(sample_rate=fs)

    summary = finalize(d, cfg)

    assert summary["channels"] == ["Time"] + SIGNAL_CHANNELS
    m = loadmat(os.path.join(d, "capture.mat"))
    assert m["DATA"].shape[1] == 10


def test_a_hardware_extra_channel_is_appended_after_the_fixed_ten(tmp_path):
    fs, n = 2000, 4000
    d = _write_raw(tmp_path, n, fs, extra_cols=1, hw_value=99.0)
    cfg = RecordConfig(
        sample_rate=fs,
        extra_channels=[ExtraChannel(name="Temp", source="hardware", physical="cDAQ1Mod3/ai1")],
    )

    summary = finalize(d, cfg)

    assert summary["channels"] == ["Time"] + SIGNAL_CHANNELS + ["Temp"]
    m = loadmat(os.path.join(d, "capture.mat"))
    assert m["DATA"].shape[1] == 11
    assert np.allclose(m["DATA"][:, 10], 99.0)  # untouched passthrough — no gain applied to Aux


def test_a_virtual_channel_is_computed_from_the_gain_corrected_signals(tmp_path):
    fs, n = 2000, 4000
    d = _write_raw(tmp_path, n, fs)
    cfg = RecordConfig(
        sample_rate=fs,
        dyno_gains=[2.0] * 8,  # Fx1(=10) * 2 = 20
        extra_channels=[ExtraChannel(name="DoubleFx1", source="virtual", formula="Fx1 * 1")],
    )

    finalize(d, cfg)

    m = loadmat(os.path.join(d, "capture.mat"))
    # scipy nests object-array strings (same as the existing metadata["Insert"] check elsewhere in
    # this test suite) — a substring check sidesteps unwrapping the exact nesting depth.
    assert "DoubleFx1" in str(m["VariableNames"])
    assert np.allclose(m["DATA"][:, 10], 20.0)  # reads the GAINED Fx1, not the raw voltage


def test_raw_d1raw_is_never_widened_for_a_virtual_channel(tmp_path):
    """Only real hardware Aux channels widen the raw file — a virtual channel is purely derived
    and must never be written into the archival source-of-truth file."""
    fs, n = 2000, 2000
    d = _write_raw(tmp_path, n, fs)
    raw_size_before = os.path.getsize(os.path.join(d, "raw.d1raw"))
    cfg = RecordConfig(
        sample_rate=fs,
        extra_channels=[ExtraChannel(name="V", source="virtual", formula="Fx1 + 1")],
    )

    finalize(d, cfg)

    assert os.path.getsize(os.path.join(d, "raw.d1raw")) == raw_size_before


def test_a_broken_virtual_formula_does_not_fail_finalize(tmp_path):
    """A formula that referenced a channel later removed must not take the whole finalize down —
    the rest of the capture still needs to archive successfully."""
    fs, n = 2000, 2000
    d = _write_raw(tmp_path, n, fs)
    cfg = RecordConfig(
        sample_rate=fs,
        extra_channels=[ExtraChannel(name="Bad", source="virtual", formula="Ghost + 1")],
    )

    summary = finalize(d, cfg)  # must not raise

    m = loadmat(os.path.join(d, "capture.mat"))
    assert np.allclose(m["DATA"][:, 10], 0.0)
    assert summary["channels"][-1] == "Bad"
