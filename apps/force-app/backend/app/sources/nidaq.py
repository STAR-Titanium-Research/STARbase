"""NidaqSource — real NI-DAQ continuous acquisition (slice 2b), following the MATLAB app's method
(a continuous voltage AI task over the 8 Kistler dyno channels + tacho, read in chunks). Implements
the same AcquisitionSource contract as SimSource/ReplaySource, so the whole downstream pipeline is
unchanged — only the source swaps.

Built from the MATLAB `ABetterFactoryPlusApp` acquisition path + the nidaqmx docs. It is UNIT-TESTED
with a fake task/reader; it must be VALIDATED ON THE RIG (a working NI-DAQmx runtime + the dyno
or an NI-MAX simulated device) — this dev machine has no functional DAQmx runtime.

nidaqmx is imported lazily (only when a real task is built), so the backend runs fine without the NI
driver for the sim/replay paths.
"""

from __future__ import annotations

import logging
import threading
import time

import numpy as np

from ..config import DEFAULT_NIDAQ_CHANNELS, SIGNAL_CHANNELS, ExtraChannel, RecordConfig

log = logging.getLogger("force_app.nidaq")


class NidaqUnavailableError(Exception):
    """NI-DAQmx runtime / python package not available on this host."""


def _import_nidaqmx():
    try:
        import nidaqmx  # noqa: WPS433
        from nidaqmx import constants  # noqa: WPS433
        from nidaqmx.stream_readers import AnalogMultiChannelReader  # noqa: WPS433

        return nidaqmx, constants, AnalogMultiChannelReader
    except Exception as e:  # ImportError, or DAQmx DLL load failure
        raise NidaqUnavailableError(f"NI-DAQmx not available: {e}") from e


def nidaq_available() -> bool:
    """True if the nidaqmx package + DAQmx runtime can be imported (not that a device exists)."""
    try:
        _import_nidaqmx()
        return True
    except NidaqUnavailableError:
        return False


class NidaqSource:
    # Bounds the blocking hardware read below — NOT how long a chunk normally takes (that's
    # chunk_sec, ~50ms), but the worst case a manual stop() has to wait for the *in-flight* read to
    # notice the task was stopped and unblock. Previously 10.0s (a value copied from the MATLAB
    # app's acquisition-error timeout, not chosen for stop responsiveness) — on real hardware this
    # is exactly the path that was flagged as never validated against a physical DAQ chassis (see
    # docs/force-app-desktop-hardware-testing-handoff.md), and a stop landing mid-read could stall
    # the whole /record/stop response, and therefore the save dialog, for up to that long.
    READ_TIMEOUT_SEC = 2.0
    # How long a run of consecutive read timeouts is tolerated before the acquisition is declared
    # failed. Matches the tolerance the original single 10s timeout provided, but split into short
    # waits so stop() is never stuck behind one — responsiveness and stall-tolerance are separate
    # concerns and this keeps them that way.
    READ_STALL_BUDGET_SEC = 10.0

    def __init__(
        self,
        cfg: RecordConfig,
        physical_channels: list[str] | None = None,
        chunk_sec: float = 0.05,
        _task=None,
        _reader=None,
        extra_channels: list[ExtraChannel] | None = None,
    ):
        # The fixed 9, plus any real (hardware) Aux channels — genuinely acquired, so they need a
        # physical channel string same as the fixed 9 do. Virtual channels are deliberately excluded
        # here: they're computed downstream from these values, never read from the DAQ themselves.
        hardware_extra = [c for c in (extra_channels or []) if c.source == "hardware"]
        self.channels = list(SIGNAL_CHANNELS) + [c.name for c in hardware_extra]
        self.rate = float(cfg.sample_rate)
        self.physical = (
            list(physical_channels) if physical_channels else list(DEFAULT_NIDAQ_CHANNELS)
        )
        if len(self.physical) != len(self.channels):
            raise ValueError(
                f"expected {len(self.channels)} NI-DAQ channels "
                f"({len(SIGNAL_CHANNELS)} fixed + {len(hardware_extra)} extra hardware), "
                f"got {len(self.physical)}"
            )
        self.chunk = max(1, int(round(self.rate * chunk_sec)))
        # Injected for tests; built from nidaqmx in start() otherwise.
        self._task = _task
        self._reader = _reader
        self._buf = np.zeros((len(self.channels), self.chunk), dtype=np.float64)
        self._i = 0
        self._stop = threading.Event()
        # Serializes all direct DAQmx task access between the acquisition thread (read(), inside
        # session._run) and whichever thread calls stop() (session.stop(), off the FastAPI event
        # loop). stop()/close() on a task with a read in flight on another thread is not something
        # the DAQmx driver is guaranteed to handle cleanly — this lock plus the short read timeout
        # above means stop() only ever has to wait for the CURRENT read to hit its own short
        # timeout, never a fresh one, and the task is never touched from two threads at once.
        self._task_lock = threading.Lock()

    def start(self) -> None:
        self._stop.clear()
        self._i = 0
        if self._task is None:
            nidaqmx, constants, reader_cls = _import_nidaqmx()
            task = nidaqmx.Task()
            for ch in self.physical:
                task.ai_channels.add_ai_voltage_chan(ch)
            # Continuous hardware-timed sampling at the configured rate; a generous buffer avoids
            # overruns while the consumer keeps up.
            task.timing.cfg_samp_clk_timing(
                self.rate,
                sample_mode=constants.AcquisitionType.CONTINUOUS,
                samps_per_chan=max(self.chunk * 8, 100_000),
            )
            self._reader = reader_cls(task.in_stream)
            self._task = task
        self._task.start()

    # DAQmx "some or all of the samples requested have not yet been acquired" — the plain timeout,
    # as opposed to a real fault (overrun, device gone, task aborted).
    _DAQ_TIMEOUT_CODE = -200284

    @staticmethod
    def _is_timeout(exc: Exception) -> bool:
        code = getattr(exc, "error_code", None)
        if code is not None:
            return code == NidaqSource._DAQ_TIMEOUT_CODE
        # Injected fakes and any driver build that doesn't carry an error_code: fall back to the
        # message. Deliberately narrow — anything unrecognised is treated as a real fault.
        return "not yet been acquired" in str(exc).lower() or "timeout" in str(exc).lower()

    def read(self) -> tuple[np.ndarray, np.ndarray] | None:
        if self._stop.is_set():
            return None
        t_read0 = time.perf_counter()
        while True:
            with self._task_lock:
                # Re-check inside the lock: stop() may have taken it and cleared self._task while
                # this call was waiting to acquire it.
                if self._stop.is_set() or self._task is None:
                    return None
                try:
                    # Blocking read of one chunk (hardware-paced). Reader fills (n_channels, chunk).
                    self._reader.read_many_sample(
                        self._buf,
                        number_of_samples_per_channel=self.chunk,
                        timeout=self.READ_TIMEOUT_SEC,
                    )
                    break
                except Exception as e:
                    # A stop() during a blocking read aborts the task: end of stream.
                    if self._stop.is_set():
                        return None
                    # A plain timeout is NOT fatal. The short per-read timeout exists so a manual
                    # stop is never stuck behind a long one — it is not a judgement that the rig has
                    # failed. Killing a recording mid-cut over a transient stall would throw away
                    # the very data this is capturing, so retry until the total wait exceeds the
                    # tolerance a single long read used to provide. Anything that is not a timeout
                    # is a real fault and propagates immediately.
                    if not self._is_timeout(e):
                        raise
                    if time.perf_counter() - t_read0 >= self.READ_STALL_BUDGET_SEC:
                        raise
                    log.warning(
                        "NidaqSource.read() timed out after %.1fs, retrying (budget %.0fs)",
                        time.perf_counter() - t_read0,
                        self.READ_STALL_BUDGET_SEC,
                    )
        dt = time.perf_counter() - t_read0
        if dt > self.READ_TIMEOUT_SEC * 0.5:
            log.warning("NidaqSource.read() took %.2fs for a %d-sample chunk", dt, self.chunk)
        n = self.chunk
        idx = np.arange(self._i, self._i + n)
        self._i += n
        t = idx / self.rate
        return t, self._buf.T.copy()

    def stop(self) -> None:
        self._stop.set()
        t0 = time.perf_counter()
        with self._task_lock:
            task, self._task = self._task, None
        if task is not None:
            try:
                task.stop()
                task.close()
            except Exception:
                pass
        dt = time.perf_counter() - t0
        if dt > 0.2:
            log.warning(
                "NidaqSource.stop() waited %.2fs for the in-flight read to release the task", dt
            )
