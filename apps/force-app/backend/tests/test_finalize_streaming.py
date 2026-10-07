"""#79: finalize streams the raw file in blocks instead of loading it whole. These tests pin the
streamed result to the pre-#79 whole-array one (tests/_legacy_finalize.py, a frozen copy) on small
synthetic captures, across block seams, and check the float64 time that replaced the float32
column. test_finalize_large.py covers the memory bound itself.

What is allowed to differ, and why:
  * Time. The old path read the raw file's float32 Time column; the new one computes
    start + index / fs in float64. capture.mat's Time column, cut_window_sec and the drift slopes
    (fitted against time) therefore move by up to one float32 rounding of t -- the old error,
    not a new one. live_cache.bin stores t as float32 anyway, so it is unchanged.
  * drift_comp. scipy's detrend (lstsq) and the streamed least-squares fit are the same line
    computed in a different order, so the corrected signals agree to ~1e-12 relative, not bitwise.
Everything else -- every other .mat column, RPM, revs, peaks, the live cache, the order spectrum --
is compared exactly.
"""

import json
import os
import shutil

import numpy as np
import pytest
from scipy.io import loadmat

import app.finalize as finalize_mod
import tests._legacy_finalize as legacy
from app.config import SIGNAL_CHANNELS, ExtraChannel, RecordConfig
from app.d1lc import parse_d1lc
from app.d1rw import RawWriter
from app.dsp import (
    DriftCheck,
    LinearFit,
    OrderSpectrum,
    TachoRpm,
    UniformChunk,
    drift_check,
    order_spectrum_quick,
    rpm_from_tacho,
    tacho_threshold,
    uniform_chunk,
)
from app.finalize import finalize, time_column_is_off

F32_REL = float(np.finfo(np.float32).eps)  # one float32 ulp, relative


def _synthetic(
    n, fs, rpm=1500.0, ppr=1, seed=0, drift=0.0, extra_cols=0, tacho=True, stop=None, stop_level=0.0
):
    """A capture shaped like a real one: air-cut lead-in and tail around a cut on all three axes,
    tooth-passing ripple, noise, an optional linear drift, a tacho pulse train whose speed wanders,
    and `extra_cols` hardware Aux columns."""
    rng = np.random.default_rng(seed)
    t = np.arange(n) / fs
    env = ((t > 0.2 * t[-1]) & (t < 0.8 * t[-1])).astype(np.float64)
    speed = rpm * (1.0 + 0.05 * np.sin(2 * np.pi * t / max(t[-1], 1e-9)))
    phase = np.cumsum(speed / 60.0 / fs)
    ripple = 1.0 + 0.2 * np.sin(2 * np.pi * 4 * phase)
    data = np.zeros((n, len(SIGNAL_CHANNELS) + extra_cols))
    for cols, mean in (((0, 1), 30.0), ((2, 3), -12.0), ((4, 5, 6, 7), 55.0)):
        for c in cols:
            data[:, c] = env * mean * ripple + rng.normal(0, 0.5, n) + drift * t
    if tacho:
        data[:, 8] = ((phase * ppr) % 1.0 < 0.15) * 5.0
        if stop is not None:  # the spindle stops: the pulses end and the sensor rests at one level
            data[int(stop * n) :, 8] = stop_level
    for i in range(extra_cols):
        data[:, 9 + i] = rng.normal(3.0, 0.1, n)
    return t, data


def _write(path, t, data, fs, chunk=4096):
    os.makedirs(path, exist_ok=True)
    w = RawWriter(os.path.join(path, "raw.d1raw"), 1 + data.shape[1], rate=fs, start_unix=0.0)
    for i in range(0, t.size, chunk):  # chunked like a live run, though the bytes are the same
        w.append(t[i : i + chunk], data[i : i + chunk])
    w.close()
    return path


def _run_both(tmp_path, t, data, fs, cfg):
    old_dir = _write(str(tmp_path / "old"), t, data, fs)
    new_dir = str(tmp_path / "new")
    os.makedirs(new_dir)
    shutil.copy(os.path.join(old_dir, "raw.d1raw"), new_dir)
    old = legacy.finalize(old_dir, cfg)
    new = finalize(new_dir, cfg)
    return old_dir, old, new_dir, new


CASES = {
    "plain": dict(cfg={}),
    "drift_comp": dict(cfg={"drift_comp": True}, synth={"drift": 0.8}),
    "per_channel_gains": dict(cfg={"dyno_gains": [1.5, 2, 2.5, 3, 0.5, 0.75, 1.25, 4]}),
    "ppr2": dict(cfg={"ppr": 2}, synth={"ppr": 2, "rpm": 900.0}),
    "no_tacho": dict(cfg={}, synth={"tacho": False}),
    "tacho_stops_low": dict(cfg={}, synth={"stop": 0.3}),
    "tacho_stops_high": dict(cfg={}, synth={"stop": 0.3, "stop_level": 5.0}),
    "tacho_stops_in_cut": dict(cfg={}, synth={"stop": 0.6}),
    "extra_channels": dict(
        cfg={
            "drift_comp": True,
            "extra_channels": [
                ExtraChannel(name="Temp", source="hardware", physical="cDAQ1Mod3/ai1"),
                ExtraChannel(name="Fr", source="virtual", formula="sqrt(Fx*Fx + Fy*Fy) + Temp"),
                ExtraChannel(name="Bad", source="virtual", formula="Gone * 2"),
            ],
        },
        synth={"extra_cols": 1, "drift": -0.3},
    ),
}


@pytest.mark.parametrize("block_rows", [997, 1_000_000])
@pytest.mark.parametrize("case", list(CASES))
def test_streamed_finalize_matches_the_whole_array_one(tmp_path, monkeypatch, case, block_rows):
    # 997-row blocks put a seam through every tacho interval, the cut-window edges and the live
    # cache's stride grid; the default size covers the single-block path.
    monkeypatch.setattr(finalize_mod, "BLOCK_ROWS", block_rows)
    for mod in (finalize_mod, legacy):
        monkeypatch.setattr(mod, "LIVE_CACHE_TARGET", 7_000)  # stride 8: a real decimation
    spec = CASES[case]
    fs, n = 5000.0, 60_000
    t, data = _synthetic(n, fs, **spec.get("synth", {}))
    cfg = RecordConfig(sample_rate=fs, feed=0.05, diam=80, **spec["cfg"])
    old_dir, old, new_dir, new = _run_both(tmp_path, t, data, fs, cfg)
    corrected = bool(cfg.drift_comp)
    sig_tol = dict(rtol=1e-11, atol=1e-9) if corrected else dict(rtol=0, atol=0)

    # .mat: every signal column exact (or ~1e-12 under drift_comp); Time is now exact.
    mo = loadmat(os.path.join(old_dir, "capture.mat"))
    mn = loadmat(os.path.join(new_dir, "capture.mat"))
    assert mn["DATA"].shape == mo["DATA"].shape
    np.testing.assert_allclose(mn["DATA"][:, 1:], mo["DATA"][:, 1:], **sig_tol)
    np.testing.assert_array_equal(mn["DATA"][:, 0], np.arange(n) / fs)
    np.testing.assert_allclose(mn["DATA"][:, 0], mo["DATA"][:, 0], rtol=F32_REL, atol=0)
    assert [str(v) for v in mn["VariableNames"].ravel()] == [
        str(v) for v in mo["VariableNames"].ravel()
    ]
    assert mn["metadata"].dtype.names == mo["metadata"].dtype.names
    for name in mo["metadata"].dtype.names:
        assert str(mn["metadata"][name][0, 0]) == str(mo["metadata"][name][0, 0])

    # live_cache.bin: byte-identical (t is float32 there either way), unless drift_comp is on.
    with open(os.path.join(old_dir, "live_cache.bin"), "rb") as f:
        lc_old = f.read()
    with open(os.path.join(new_dir, "live_cache.bin"), "rb") as f:
        lc_new = f.read()
    if corrected:
        po, pn = parse_d1lc(lc_old), parse_d1lc(lc_new)
        for key in ("t", "rpm", "revs"):
            np.testing.assert_array_equal(pn[key], po[key])
        for key in ("fx", "fy", "fz"):
            np.testing.assert_allclose(pn[key], po[key], rtol=1e-6, atol=1e-4)  # float32 storage
        assert lc_new[:32] == lc_old[:32]
    else:
        assert lc_new == lc_old

    # summary.json: same keys and values, with the documented tolerances.
    with open(os.path.join(new_dir, "summary.json")) as f:
        assert json.load(f) == new
    assert list(new) == list(old)
    for key in old:
        if key in ("file_sizes_mb", "local_diag", "cut_window_sec", "duration_sec", "peaks"):
            continue
        assert new[key] == old[key], key
    np.testing.assert_allclose(new["cut_window_sec"], old["cut_window_sec"], rtol=F32_REL)
    np.testing.assert_allclose(new["duration_sec"], old["duration_sec"], rtol=F32_REL)
    assert set(new["file_sizes_mb"]) == set(old["file_sizes_mb"])
    for ax in ("Fx", "Fy", "Fz"):
        np.testing.assert_allclose(new["peaks"][ax], old["peaks"][ax], **sig_tol)
    ld_new, ld_old = new["local_diag"], old["local_diag"]
    assert ld_new["order_spectrum_status"] == ld_old["order_spectrum_status"]
    if ld_old["order_spectrum"] is None:
        assert ld_new["order_spectrum"] is None
    else:
        os_new, os_old = ld_new["order_spectrum"], ld_old["order_spectrum"]
        assert os_new["orders"] == os_old["orders"]
        # Bitwise except under drift_comp, where Fz itself carries the ~1e-12 detrend difference.
        np.testing.assert_allclose(os_new["amplitude"], os_old["amplitude"], **sig_tol)
    drift_new, drift_old = ld_new["drift"], ld_old["drift"]
    assert drift_new["detected"] == drift_old["detected"]
    for ax in ("Fx", "Fy", "Fz"):
        assert drift_new[ax]["detected"] == drift_old[ax]["detected"]
        for k in ("slope_n_per_sec", "excursion_frac"):
            # Fitted against float64 time now, instead of float32-rounded time.
            np.testing.assert_allclose(drift_new[ax][k], drift_old[ax][k], rtol=1e-5, atol=1e-9)


def test_time_is_float64_at_long_capture_offsets(tmp_path):
    """#79's second half: at t ~ 12430 s a float32 stamp is only good to ~1 ms, so 25 kHz samples
    shared stamps in groups of ~25. The archived Time (and the cut window found on it) must step
    by exactly 1/fs there, as it does near t = 0."""
    fs, n, start = 25_000.0, 50_000, 12_430.0
    t = start + np.arange(n) / fs
    data = np.zeros((n, len(SIGNAL_CHANNELS)))
    first_on = 31_337
    data[first_on:, 4] = 100.0  # Fz1: the cut starts at a known sample
    d = _write(str(tmp_path), t, data, fs)
    assert np.unique(t.astype(np.float32)).size < n // 10  # the column really is quantised

    summary = finalize(d, RecordConfig(sample_rate=fs))

    time = loadmat(os.path.join(d, "capture.mat"))["DATA"][:, 0]
    np.testing.assert_allclose(np.diff(time), 1.0 / fs, rtol=0, atol=1e-9)
    assert time[0] == start
    assert abs(summary["cut_window_sec"][0] - (start + first_on / fs)) < 1e-9
    assert abs(summary["duration_sec"] - (n - 1) / fs) < 1e-9


def test_a_non_uniform_time_column_is_kept(tmp_path):
    """Only uniform index/rate stamps are recomputed: a column that departs from them by more than
    its own rounding (here a 0.5 s gap mid-capture) carries real timing and is archived as-is."""
    fs, n = 1000.0, 5000
    t = np.arange(n) / fs
    t[2500:] += 0.5
    data = np.zeros((n, len(SIGNAL_CHANNELS)))
    data[:, 4] = 10.0
    d = _write(str(tmp_path), t, data, fs)

    summary = finalize(d, RecordConfig(sample_rate=fs))

    time = loadmat(os.path.join(d, "capture.mat"))["DATA"][:, 0]
    np.testing.assert_array_equal(time, t.astype(np.float32).astype(np.float64))
    assert summary["duration_sec"] == pytest.approx(t[-1] - t[0], abs=1e-6)


def test_uniform_stamps_at_an_inexact_rate_are_not_mistaken_for_non_uniform_timing():
    """The sources stamp t = idx / rate in float64 but the header holds the rate as float32, so for
    a rate float32 can't represent (10000.1 Hz) the formula drifts from the stamps by up to
    ~t * 2**-24. Written out, that is a 300M-row capture; the check only sees (stamps, formula)
    pairs, so a window of rows at that offset stands in for it. At this window the pre-fix
    tolerance (half a sample + the stored value's float32 spacing) flagged it falsely and finalize
    silently fell back to the float32 column."""
    fs_true = 10_000.1
    fs = float(np.float32(fs_true))
    assert fs != fs_true
    idx = np.arange(300_000_000, 300_200_000)  # t ~ 30000 s
    col = (idx / fs_true).astype(np.float32)
    expected = idx / fs

    old_tol = 0.5 / fs + np.spacing(np.abs(col)).astype(np.float64)
    assert np.any(np.abs(col.astype(np.float64) - expected) > old_tol)  # the old check misfired
    assert not time_column_is_off(col, expected, fs)

    # ...while real non-uniform timing at that offset still is: a 0.5 s gap, or a 10 s pause.
    for gap in (0.5, 10.0):
        gapped = (idx / fs_true + np.where(idx >= idx[100_000], gap, 0.0)).astype(np.float32)
        assert time_column_is_off(gapped, expected, fs)


def test_an_empty_raw_file_is_refused(tmp_path):
    d = _write(str(tmp_path), np.zeros(0), np.zeros((0, len(SIGNAL_CHANNELS))), 1000.0)
    with pytest.raises(ValueError, match="no samples"):
        finalize(d, RecordConfig(sample_rate=1000.0))


# --- the streaming dsp helpers against their whole-array originals ---


def _chunks(x, rng):
    cuts = np.sort(rng.choice(np.arange(1, x.size), size=min(40, x.size - 1), replace=False))
    return np.split(x, cuts)


@pytest.mark.parametrize("seed", range(5))
def test_tacho_rpm_streamed_is_bitwise_the_whole_array_result(seed):
    rng = np.random.default_rng(seed)
    fs, n = 2000.0, 40_000
    t, data = _synthetic(n, fs, rpm=float(rng.uniform(300, 3000)), ppr=int(rng.integers(1, 4)))
    tacho = data[:, 8]
    ppr = 2
    want, measured = legacy.rpm_from_tacho(tacho, fs, ppr)
    got, got_measured = rpm_from_tacho(tacho, fs, ppr)
    assert got_measured == measured
    np.testing.assert_array_equal(got, want)

    # Random chunk sizes for the tacho reader AND the requested ranges, independently.
    stream = TachoRpm(iter(_chunks(tacho, rng)), n, fs, ppr, tacho.min(), tacho.max())
    bounds = np.concatenate(([0], np.sort(rng.choice(np.arange(1, n), 30, replace=False)), [n]))
    pieces = [stream.rpm(int(a), int(b)) for a, b in zip(bounds[:-1], bounds[1:])]
    np.testing.assert_array_equal(np.concatenate(pieces), want)


def test_tacho_rpm_unmeasured_cases_match():
    for tacho in (np.zeros(500), np.r_[np.zeros(250), np.full(250, 5.0)], np.zeros(1)):
        want = legacy.rpm_from_tacho(tacho, 1000.0, 1)
        got = rpm_from_tacho(tacho, 1000.0, 1)
        assert got[1] is want[1] is False
        np.testing.assert_array_equal(got[0], want[0])


@pytest.mark.parametrize("seed", range(3))
def test_order_spectrum_streamed_is_bitwise_the_whole_array_result(seed):
    rng = np.random.default_rng(seed)
    n = 30_000
    revs = np.cumsum(rng.uniform(0.5, 1.5, n) / 100.0)
    sig = np.sin(2 * np.pi * 3 * revs) + rng.normal(0, 0.1, n)
    want = legacy.order_spectrum_quick(revs, sig)
    assert want[0]
    assert order_spectrum_quick(revs, sig) == want
    acc = OrderSpectrum()
    for i in _chunks(np.arange(n), rng):  # split revs and sig at the same random seams
        acc.add(revs[i], sig[i])
    assert acc.result() == want


def test_order_spectrum_long_cut_is_segment_averaged_and_bounded():
    """A cut longer than one segment is Welch-averaged: fixed length, still finds the order."""
    rng = np.random.default_rng(1)
    revs = np.arange(400_000) / 32.0  # 12500 revolutions at 32 samples/rev
    sig = 2.0 * np.sin(2 * np.pi * 4 * revs) + rng.normal(0, 0.5, revs.size)
    acc = OrderSpectrum(segment_points=1 << 12)  # 64 revolutions per segment
    for i in range(0, revs.size, 9_999):
        acc.add(revs[i : i + 9_999], sig[i : i + 9_999])
    orders, amp = acc.result()
    assert len(orders) == 16 * 64 + 1  # 1/64-order resolution up to order 16, however long the cut
    assert orders[int(np.argmax(amp))] == pytest.approx(4.0)
    assert max(amp) == pytest.approx(2.0, rel=0.05)


def test_linear_fit_and_drift_check_match_polyfit():
    rng = np.random.default_rng(3)
    x = np.sort(rng.uniform(1e4, 2e4, 50_000))
    y = np.column_stack([0.3 * x + rng.normal(0, 50, x.size), -2e-3 * x + 7])
    fit = LinearFit()
    for i in range(0, x.size, 777):
        fit.add(x[i : i + 777], y[i : i + 777])
    for j in range(2):
        np.testing.assert_allclose(fit.slope[j], np.polyfit(x, y[:, j], 1)[0], rtol=1e-9)
        line = np.polyval(np.polyfit(x, y[:, j], 1), x)
        np.testing.assert_allclose(fit.trend(x)[:, j], line, rtol=1e-9, atol=1e-9)

    axes = {"Fx": y[:, 0], "Fy": y[:, 1], "Fz": rng.normal(0, 1, x.size)}
    want = legacy.drift_check(x, axes)
    assert drift_check(x, axes)["detected"] == want["detected"]
    acc = DriftCheck(list(axes))
    for i in range(0, x.size, 1234):
        acc.add(x[i : i + 1234], {k: v[i : i + 1234] for k, v in axes.items()})
    got = acc.result()
    for ax in axes:
        assert got[ax]["detected"] == want[ax]["detected"]
        np.testing.assert_allclose(
            got[ax]["slope_n_per_sec"], want[ax]["slope_n_per_sec"], rtol=1e-8
        )


def _count_block_reads(tmp_path, monkeypatch, tacho_kwargs, block_rows=1_000, n=60_000):
    monkeypatch.setattr(finalize_mod, "BLOCK_ROWS", block_rows)
    reads = []
    real = finalize_mod.read_rows
    monkeypatch.setattr(
        finalize_mod,
        "read_rows",
        lambda path, a, b, n_cols: reads.append(a) or real(path, a, b, n_cols),
    )
    fs = 5000.0
    t, data = _synthetic(n, fs, **tacho_kwargs)
    d = _write(str(tmp_path / "cap"), t, data, fs)
    finalize(d, RecordConfig(sample_rate=fs, feed=0.05, diam=80))
    return len(reads), -(-n // block_rows)


@pytest.mark.parametrize("level", [0.0, 5.0])
def test_a_stopped_tacho_does_not_double_the_final_pass_reads(tmp_path, monkeypatch, level):
    """Once the pulses stop, TachoRpm has to look to the end of the file for a later edge, and the
    2-block cache then forced the main loop to re-read all of it: 3 reads a block instead of 2
    (pass 1 + final). The stopped tail is now read zero extra times."""
    reads, blocks = _count_block_reads(tmp_path, monkeypatch, dict(stop=0.1, stop_level=level))
    assert reads <= 2 * blocks + 4, (reads, blocks)  # was ~3 * blocks


def test_a_running_tacho_still_reads_each_block_twice(tmp_path, monkeypatch):
    reads, blocks = _count_block_reads(tmp_path, monkeypatch, {})
    assert reads <= 2 * blocks + 4, (reads, blocks)


def test_tacho_rpm_with_uniform_chunks_is_the_array_result():
    """UniformChunk stands in for a chunk wholly on one side of the threshold, edge included."""
    rng = np.random.default_rng(3)
    fs, ppr = 2000.0, 1
    for level in (0.0, 5.0):
        _, data = _synthetic(40_000, fs, stop=0.25, stop_level=level)
        tacho = data[:, 8]
        lo, hi = float(tacho.min()), float(tacho.max())
        thr = tacho_threshold(lo, hi)
        want, _ = rpm_from_tacho(tacho, fs, ppr)
        for size in (97, 1000, 4096):
            chunks = []
            for i in range(0, tacho.size, size):
                c = tacho[i : i + size]
                chunks.append(uniform_chunk(c.size, float(c.min()), float(c.max()), thr) or c)
            assert any(isinstance(c, UniformChunk) for c in chunks)
            stream = TachoRpm(iter(chunks), tacho.size, fs, ppr, lo, hi)
            bounds = np.concatenate(
                ([0], np.sort(rng.choice(np.arange(1, 40_000), 20, False)), [40_000])
            )
            got = np.concatenate(
                [stream.rpm(int(a), int(b)) for a, b in zip(bounds[:-1], bounds[1:])]
            )
            np.testing.assert_array_equal(got, want)


def test_a_chunk_with_a_nan_is_never_uniform():
    assert uniform_chunk(10, float("nan"), float("nan"), 2.5) is None
    assert uniform_chunk(10, 0.0, 1.0, float("nan")) is None
    assert uniform_chunk(10, 3.0, 5.0, 2.5) == UniformChunk(10, True)
    assert uniform_chunk(10, 0.0, 2.5, 2.5) == UniformChunk(10, False)  # `above` is strict >
    assert uniform_chunk(10, 0.0, 5.0, 2.5) is None
