"""Live railing (R5): the near-full-scale test shared with finalize, applied per live block."""

import json

import numpy as np

from app.clipping import RAIL_FRACTION, RailDetector, near_full_scale
from app.config import SIGNAL_CHANNELS, RecordConfig
from app.session import RecordingSession

GAINS = [50.0, 50.0, 50.0, 50.0, 100.0, 100.0, 100.0, 100.0]  # N/V
VFS = 10.0


def _block(n=200, fill=0.0, rail_col=None, rail_v=None, negative=False):
    """A (n, 9) raw-volt block: 8 sensor columns + tacho, optionally with one railed channel."""
    data = np.full((n, 9), fill, dtype=np.float32)
    if rail_col is not None:
        data[n // 2, rail_col] = -rail_v if negative else rail_v
    return data


def test_near_full_scale_threshold_and_degenerate_ranges():
    rng = np.array([100.0, 100.0, 0.0, -5.0])
    peak = np.array([RAIL_FRACTION * 100.0, RAIL_FRACTION * 100.0 - 0.01, 1e9, 1e9])
    assert near_full_scale(peak, rng).tolist() == [True, False, False, False]


def test_railed_block_flags_only_the_railed_channel():
    det = RailDetector(GAINS, VFS)
    assert det.update(_block(fill=1.0)) is False  # well inside the range
    assert det.railed == []
    assert det.update(_block(rail_col=5, rail_v=9.95)) is True  # 99.5 % of +/-10 V
    assert det.railed == [5]


def test_negative_rail_counts():
    det = RailDetector(GAINS, VFS)
    assert det.update(_block(rail_col=2, rail_v=10.0, negative=True)) is True
    assert det.railed == [2]


def test_just_below_threshold_does_not_rail():
    det = RailDetector(GAINS, VFS)
    assert det.update(_block(rail_col=0, rail_v=9.8)) is False
    assert det.railed == []


def test_latches_and_only_reports_new_channels():
    det = RailDetector(GAINS, VFS)
    assert det.update(_block(rail_col=1, rail_v=10.0)) is True
    # Quiet block afterwards: still latched, nothing new.
    assert det.update(_block(fill=0.1)) is False
    assert det.railed == [1]
    # Same channel again: not new. A second channel: new, both listed.
    assert det.update(_block(rail_col=1, rail_v=10.0)) is False
    assert det.update(_block(rail_col=6, rail_v=10.0)) is True
    assert det.railed == [1, 6]


def test_tacho_column_never_rails():
    det = RailDetector(GAINS, VFS)
    block = _block()
    block[:, 8] = 10.0  # a 10 V tacho pulse train is normal
    assert det.update(block) is False and det.railed == []


def test_disabled_without_per_channel_gains():
    # Sim/replay data is already in newtons: no gains, no range, never railed.
    for gains in ([], None, [1.0] * 7):
        det = RailDetector(gains, VFS)
        assert det.enabled is False
        assert det.update(_block(rail_col=0, rail_v=1e6)) is False
        assert det.railed == []


def test_empty_block_is_ignored():
    det = RailDetector(GAINS, VFS)
    assert det.update(np.zeros((0, 9), dtype=np.float32)) is False


def test_matches_finalize_definition():
    """The live test and finalize's whole-capture test agree on the same peak: the live one works
    in volts x gain, finalize in newtons against gain x full-scale."""
    peaks_v = np.array([9.89, 9.85, 9.91, 5.0, 9.99, 10.0, 0.0, 9.0])
    ranges = np.array(GAINS) * VFS
    finalize_side = near_full_scale(peaks_v * np.array(GAINS), ranges)
    det = RailDetector(GAINS, VFS)
    block = np.zeros((8, 9), dtype=np.float32)
    block[np.arange(8), np.arange(8)] = peaks_v.astype(np.float32)
    det.update(block)
    assert det.railed == [int(i) for i in np.flatnonzero(finalize_side)]


def test_hot_path_is_vectorised():
    """A 1 M-row block is one min and one max per column, not a Python loop: well under a second
    even on a slow CI box."""
    import time

    det = RailDetector(GAINS, VFS)
    big = np.random.default_rng(0).uniform(-1, 1, (1_000_000, 9)).astype(np.float32)
    t0 = time.perf_counter()
    det.update(big)
    assert time.perf_counter() - t0 < 1.0


class _RailSource:
    """Three chunks of raw volts; the middle one rails channel 3 (Fy2)."""

    channels = list(SIGNAL_CHANNELS)
    rate = 1000.0

    def __init__(self):
        self._i = 0

    def start(self):
        pass

    def stop(self):
        pass

    def read(self):
        if self._i >= 3:
            return None
        n = 100
        t = (np.arange(n) + self._i * n) / self.rate
        data = np.full((n, 9), 0.5, dtype=np.float32)
        if self._i == 1:
            data[10, 3] = 10.0
        self._i += 1
        return t, data


class _Bus:
    def __init__(self):
        self.messages = []

    def publish(self, message):
        self.messages.append(message)


def test_session_streams_and_reports_railed_channel(tmp_path):
    cfg = RecordConfig(sample_rate=1000, duration_sec=0.3, dyno_gains=GAINS, analog_fullscale_v=VFS)
    bus = _Bus()
    sess = RecordingSession(cfg, str(tmp_path), _RailSource(), broadcaster=bus)
    sess.start()
    sess._thread.join(15)
    sess.join_finalize(30)
    railed_msgs = [
        json.loads(m)
        for m in bus.messages
        if isinstance(m, str) and json.loads(m).get("type") == "railed"
    ]
    assert railed_msgs == [{"type": "railed", "channels": [3]}]  # once, not per block
    assert sess.status()["railed"] == [3]
    # finalize agrees: the same channel is flagged in the capture's ranging summary.
    assert sess.summary["channels_ranging"]["clipped"][3] is True
    assert sum(sess.summary["channels_ranging"]["clipped"]) == 1


def test_session_without_gains_never_reports_railed(tmp_path):
    cfg = RecordConfig(sample_rate=1000, duration_sec=0.3)
    bus = _Bus()
    sess = RecordingSession(cfg, str(tmp_path), _RailSource(), broadcaster=bus)
    sess.start()
    sess._thread.join(15)
    sess.join_finalize(30)
    assert sess.status()["railed"] == []
    assert not any(isinstance(m, str) and '"railed"' in m for m in bus.messages)


# ---- The rail test must use the Lab Amp's full scale, not RecordConfig's default 10 V ----


class _RailAtVoltsSource(_RailSource):
    """Rails channel 3 at 5.0 V: full scale on a 5 V rig, only half scale on a 10 V one."""

    def __init__(self, cfg=None, physical_channels=None, extra_channels=None):
        super().__init__()

    def read(self):
        out = super().read()
        if out is not None:
            _t, data = out
            data[data == 10.0] = 5.0
        return out


def test_nidaq_start_uses_the_lab_amp_full_scale_for_railing(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient

    import app.main as main
    import app.sources.nidaq as nidaq_mod

    monkeypatch.setattr(nidaq_mod, "nidaq_available", lambda: True)
    monkeypatch.setattr(nidaq_mod, "NidaqSource", _RailAtVoltsSource)
    monkeypatch.setattr(main.nidaq_enum, "sample_rate_limits", lambda _c: {})
    monkeypatch.setattr(main, "CAPTURES_ROOT", str(tmp_path))
    monkeypatch.setattr(main, "_session", None)
    monkeypatch.setitem(main._labamp_cfg, "analog_fullscale_v", 5.0)  # Lab Amp settings / env
    body = {"source": "nidaq", "sample_rate": 1000, "duration_sec": 0.3, "dyno_gains": GAINS}
    try:
        with TestClient(main.app) as client:
            assert client.post("/record/start", json=body).status_code == 200
            sess = main._session
            sess._thread.join(15)
            sess.join_finalize(30)
            assert sess.cfg.analog_fullscale_v == 5.0
            assert client.get("/record/status").json()["railed"] == [3]  # live detector
            assert sess.summary["channels_ranging"]["clipped"][3] is True  # and finalize
            assert sum(sess.summary["channels_ranging"]["clipped"]) == 1
    finally:
        monkeypatch.setattr(main, "_session", None)
