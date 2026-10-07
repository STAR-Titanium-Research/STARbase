"""NidaqSource logic with a fake DAQ task/reader (real hardware is validated on the rig)."""

import numpy as np
import pytest

from app.config import SIGNAL_CHANNELS, ExtraChannel, RecordConfig
from app.sources.nidaq import NidaqSource, nidaq_available


class FakeReader:
    def __init__(self):
        self.calls = 0

    def read_many_sample(self, buf, number_of_samples_per_channel, timeout=10.0):
        assert buf.shape[1] == number_of_samples_per_channel
        buf[:] = np.random.default_rng(self.calls).normal(size=buf.shape)
        self.calls += 1


class FakeTask:
    def __init__(self):
        self.started = False
        self.closed = False

    def start(self):
        self.started = True

    def stop(self):
        pass

    def close(self):
        self.closed = True


def _src(rate=2000):
    cfg = RecordConfig(sample_rate=rate, source="nidaq")
    return NidaqSource(cfg, _task=FakeTask(), _reader=FakeReader())


def test_shape_and_index_advance():
    src = _src()
    src.start()
    assert src._task.started is True
    t, data = src.read()
    assert data.shape == (src.chunk, len(SIGNAL_CHANNELS))  # (n, 9)
    assert t.size == src.chunk
    t2, _ = src.read()
    assert t2[0] > t[-1]  # sample index advances
    assert np.allclose(np.diff(t), 1.0 / src.rate)  # uniform at the configured rate


def test_stop_ends_stream_and_closes_task():
    src = _src()
    src.start()
    src.read()
    src.stop()
    assert src.read() is None  # no more data after stop


def test_channel_count_mismatch_rejected():
    cfg = RecordConfig(sample_rate=1000, source="nidaq")
    with pytest.raises(ValueError):
        NidaqSource(
            cfg, physical_channels=["Dev1/ai0", "Dev1/ai1"], _task=FakeTask(), _reader=FakeReader()
        )


def test_nidaq_available_is_bool():
    assert isinstance(nidaq_available(), bool)


# ---- extra (real Aux) channels widen the acquired channel count ----


def test_a_real_aux_channel_widens_the_acquired_channels():
    cfg = RecordConfig(sample_rate=2000, source="nidaq")
    extra = [ExtraChannel(name="Temp", source="hardware", physical="cDAQ1Mod3/ai1")]
    physical = [f"Dev1/ai{i}" for i in range(9)] + ["cDAQ1Mod3/ai1"]
    src = NidaqSource(
        cfg,
        physical_channels=physical,
        extra_channels=extra,
        _task=FakeTask(),
        _reader=FakeReader(),
    )
    assert src.channels == list(SIGNAL_CHANNELS) + ["Temp"]
    src.start()
    t, data = src.read()
    assert data.shape == (src.chunk, 10)  # 9 fixed + 1 real Aux


def test_a_virtual_channel_does_not_widen_acquisition_at_all():
    """Virtual channels are computed, never acquired — configuring one must not change how many
    physical channels NidaqSource expects or reads."""
    cfg = RecordConfig(sample_rate=2000, source="nidaq")
    extra = [ExtraChannel(name="Resultant", source="virtual", formula="sqrt(Fx1*Fx1)")]
    src = NidaqSource(cfg, extra_channels=extra, _task=FakeTask(), _reader=FakeReader())
    assert src.channels == list(SIGNAL_CHANNELS)  # unchanged — 9, not 10
    src.start()
    _t, data = src.read()
    assert data.shape == (src.chunk, 9)


def test_mismatch_message_accounts_for_extra_hardware_channels():
    cfg = RecordConfig(sample_rate=1000, source="nidaq")
    extra = [ExtraChannel(name="Temp", source="hardware", physical="cDAQ1Mod3/ai1")]
    with pytest.raises(ValueError, match="10 .*9 fixed \\+ 1 extra hardware"):
        NidaqSource(
            cfg,
            physical_channels=["Dev1/ai0"],  # only 1, but 10 are now expected
            extra_channels=extra,
            _task=FakeTask(),
            _reader=FakeReader(),
        )


# ---- Read-timeout tolerance (see NidaqSource.READ_STALL_BUDGET_SEC) ----


class _TimeoutThenOkReader:
    """Times out `n` times, then succeeds — a transient stall on the chassis."""

    def __init__(self, n: int):
        self.remaining = n
        self.calls = 0

    def read_many_sample(self, buf, number_of_samples_per_channel, timeout=10.0):
        self.calls += 1
        if self.remaining > 0:
            self.remaining -= 1
            raise RuntimeError("Some or all of the samples requested have not yet been acquired")
        buf[:] = 0.0


class _FaultReader:
    def read_many_sample(self, buf, number_of_samples_per_channel, timeout=10.0):
        raise RuntimeError("Device could not be found")  # not a timeout


def test_transient_read_timeout_is_retried_not_fatal():
    """A short per-read timeout must not turn a hiccup into a lost recording."""
    src = NidaqSource(
        RecordConfig(sample_rate=2000, source="nidaq"),
        _task=FakeTask(),
        _reader=_TimeoutThenOkReader(2),
    )
    src.start()
    t, data = src.read()
    assert data.shape == (src.chunk, len(SIGNAL_CHANNELS))
    assert src._reader.calls == 3  # two timeouts, then the good read


def test_a_real_fault_still_propagates_immediately():
    src = NidaqSource(
        RecordConfig(sample_rate=2000, source="nidaq"), _task=FakeTask(), _reader=_FaultReader()
    )
    src.start()
    with pytest.raises(RuntimeError, match="could not be found"):
        src.read()


def test_timeouts_past_the_budget_are_fatal():
    src = NidaqSource(
        RecordConfig(sample_rate=2000, source="nidaq"),
        _task=FakeTask(),
        _reader=_TimeoutThenOkReader(10_000),
    )
    src.READ_STALL_BUDGET_SEC = 0.0  # budget already spent on the first failure
    src.start()
    with pytest.raises(RuntimeError, match="not yet been acquired"):
        src.read()


def test_stop_during_a_timeout_run_ends_the_stream_cleanly():
    """Stop must win over the retry loop rather than being held for the whole budget."""
    src = NidaqSource(
        RecordConfig(sample_rate=2000, source="nidaq"),
        _task=FakeTask(),
        _reader=_TimeoutThenOkReader(10_000),
    )
    src.start()

    real_read = src._reader.read_many_sample

    def stop_then_timeout(buf, number_of_samples_per_channel, timeout=10.0):
        src._stop.set()  # a stop lands while this read is in flight
        return real_read(buf, number_of_samples_per_channel, timeout)

    src._reader.read_many_sample = stop_then_timeout
    assert src.read() is None
