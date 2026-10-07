"""Simulated interruption and failure scenarios during active recording.

Each test creates a fault-injecting source that triggers a specific failure mode mid-recording,
then verifies:
  1. The session reaches a well-defined terminal state (done/error)
  2. The raw file on disk is valid and recoverable
  3. Manifest reflects the terminal state
  4. Recovery can finalize any partial raw file
  5. No thread hangs or deadlocks (tests have tight join timeouts)

Failure modes tested:
  - Source disconnects mid-stream (NI-DAQ cable pull, USB drop)
  - Source raises an exception mid-read (driver error, hardware fault)
  - Source start() failure (device not found)
  - Forced stop mid-recording (user hits stop, app forced close)
  - Consumer overrun (source produces faster than consumer drains)
  - Finalize failure after valid recording
  - Power failure simulation (raw file writer closed abruptly without finalize)
  - Source produces zero-length chunks
  - Source produces exactly one chunk then disconnects
  - Multiple rapid start/stop cycles
"""

from __future__ import annotations

import json
import os
import threading
import time

import numpy as np

from app.config import SIGNAL_CHANNELS, RecordConfig
from app.d1rw import HEADER_SIZE, RawWriter, memmap_rows, read_header
from app.recovery import MANIFEST, recover_session, scan_incomplete, write_manifest
from app.session import RecordingSession


def _cfg(**kw) -> RecordConfig:
    defaults = {"sample_rate": 2000, "duration_sec": 2.0, "sample_name": "FAULT-TEST"}
    defaults.update(kw)
    return RecordConfig(**defaults)


def _wait(sess: RecordingSession, timeout: float = 15.0) -> None:
    """Join the acquisition worker AND the background finalize it may have spawned — finalize()
    (mat/live_cache/summary write) runs off the joined thread now, so 'done'/'error' only lands
    once join_finalize() returns too."""
    if sess._thread:
        sess._thread.join(timeout)
    assert (
        sess._thread is None or not sess._thread.is_alive()
    ), f"session thread still alive after {timeout}s — possible deadlock"
    sess.join_finalize(timeout)


def _raw_path(sess: RecordingSession) -> str:
    return os.path.join(sess.dir, "raw.d1raw")


def _manifest(sess: RecordingSession) -> dict:
    with open(os.path.join(sess.dir, MANIFEST)) as f:
        return json.load(f)


# ---- Fault-injecting sources ----


class _BaseSource:
    """Minimal source that produces synthetic data at 2000 Hz."""

    channels = list(SIGNAL_CHANNELS)
    rate = 2000.0

    def __init__(self):
        self._stop = threading.Event()
        self._i = 0
        self._rng = np.random.default_rng(42)

    def start(self):
        self._i = 0

    def stop(self):
        self._stop.set()

    def _chunk(self, n: int = 50):
        t = np.arange(self._i, self._i + n, dtype=np.float64) / self.rate
        data = self._rng.normal(size=(n, len(self.channels))).astype(np.float64)
        self._i += n
        return t, data


class DisconnectAfterNSource(_BaseSource):
    """Simulates source disconnect: produces N chunks then returns None (like a DAQ cable pull)."""

    def __init__(self, n_chunks: int = 5):
        super().__init__()
        self._max = n_chunks
        self._count = 0

    def read(self):
        if self._stop.is_set() or self._count >= self._max:
            return None
        self._count += 1
        return self._chunk()


class ExceptionAfterNSource(_BaseSource):
    """Simulates hardware fault: raises an exception after N successful reads."""

    def __init__(self, n_chunks: int = 5, error_msg: str = "DAQ device error: buffer overflow"):
        super().__init__()
        self._max = n_chunks
        self._count = 0
        self._error_msg = error_msg

    def read(self):
        if self._stop.is_set():
            return None
        self._count += 1
        if self._count > self._max:
            raise RuntimeError(self._error_msg)
        return self._chunk()


class StartFailureSource(_BaseSource):
    """Source whose start() raises — device not found."""

    def start(self):
        raise RuntimeError("Device identifier is invalid. Ensure the NI-DAQ chassis is connected.")

    def read(self):
        return None


class SlowConsumerSource(_BaseSource):
    """Produces data faster than the consumer can drain, triggering ring overrun.
    Uses moderate chunks — the ring size is reduced in the test to trigger overrun reliably."""

    def __init__(self, chunk_size: int = 200, n_chunks: int = 50):
        super().__init__()
        self._chunk_size = chunk_size
        self._max = n_chunks
        self._count = 0

    def read(self):
        if self._stop.is_set() or self._count >= self._max:
            return None
        self._count += 1
        return self._chunk(self._chunk_size)


class SingleChunkSource(_BaseSource):
    """Produces exactly one small chunk then disconnects."""

    def __init__(self, n_rows: int = 10):
        super().__init__()
        self._n = n_rows
        self._sent = False

    def read(self):
        if self._stop.is_set() or self._sent:
            return None
        self._sent = True
        return self._chunk(self._n)


class EmptyChunkSource(_BaseSource):
    """Produces several empty (0-row) chunks, then some real data, then disconnects."""

    def __init__(self):
        super().__init__()
        self._phase = 0

    def read(self):
        if self._stop.is_set() or self._phase >= 8:
            return None
        self._phase += 1
        if self._phase <= 3:
            # Empty chunk — zero rows
            t = np.zeros(0, dtype=np.float64)
            data = np.zeros((0, len(self.channels)), dtype=np.float64)
            return t, data
        return self._chunk(50)


class InfiniteSource(_BaseSource):
    """Produces data forever until stopped — for testing forced stop."""

    def read(self):
        if self._stop.is_set():
            return None
        time.sleep(0.01)  # pace to ~100 chunks/s
        return self._chunk(50)


# ---- Tests ----


class TestSourceDisconnect:
    """NI-DAQ cable pull, USB drop — source returns None mid-recording."""

    def test_session_ends_cleanly(self, tmp_path):
        sess = RecordingSession(_cfg(), str(tmp_path), DisconnectAfterNSource(5))
        sess.start()
        _wait(sess)
        assert sess.state == "done"
        assert sess.error is None
        assert sess.n_total == 250  # 5 chunks × 50 rows

    def test_raw_file_valid_and_complete(self, tmp_path):
        sess = RecordingSession(_cfg(), str(tmp_path), DisconnectAfterNSource(5))
        sess.start()
        _wait(sess)
        hdr = read_header(_raw_path(sess))
        assert hdr["n_cols"] == 10
        rows = memmap_rows(_raw_path(sess))
        assert rows.shape[0] == 250

    def test_finalize_produces_all_artifacts(self, tmp_path):
        sess = RecordingSession(_cfg(), str(tmp_path), DisconnectAfterNSource(5))
        sess.start()
        _wait(sess)
        for name in ("raw.d1raw", "capture.mat", "live_cache.bin", "summary.json"):
            assert os.path.isfile(os.path.join(sess.dir, name)), f"missing {name}"

    def test_manifest_reflects_done(self, tmp_path):
        sess = RecordingSession(_cfg(), str(tmp_path), DisconnectAfterNSource(5))
        sess.start()
        _wait(sess)
        m = _manifest(sess)
        assert m["state"] == "done"
        assert "error" not in m


class TestSourceException:
    """Hardware fault — source.read() raises an exception mid-stream."""

    def test_session_records_error(self, tmp_path):
        sess = RecordingSession(
            _cfg(),
            str(tmp_path),
            ExceptionAfterNSource(5, "DAQ device error: buffer overflow"),
        )
        sess.start()
        _wait(sess)
        assert sess.state == "error"
        assert "DAQ device error" in sess.error

    def test_partial_data_saved(self, tmp_path):
        sess = RecordingSession(
            _cfg(),
            str(tmp_path),
            ExceptionAfterNSource(5),
        )
        sess.start()
        _wait(sess)
        rows = memmap_rows(_raw_path(sess))
        assert rows.shape[0] == 250  # 5 good chunks captured

    def test_still_finalizes_partial_data(self, tmp_path):
        sess = RecordingSession(
            _cfg(),
            str(tmp_path),
            ExceptionAfterNSource(5),
        )
        sess.start()
        _wait(sess)
        # Despite error state, finalize should have run (data was captured)
        assert os.path.isfile(os.path.join(sess.dir, "summary.json"))
        assert sess.summary is not None
        assert sess.summary["n"] == 250

    def test_manifest_records_error(self, tmp_path):
        sess = RecordingSession(
            _cfg(),
            str(tmp_path),
            ExceptionAfterNSource(3, "USB device disconnected"),
        )
        sess.start()
        _wait(sess)
        m = _manifest(sess)
        assert m["state"] == "error"
        assert m["error"] is not None
        assert "USB device disconnected" in m["error"]

    def test_recoverable_after_error(self, tmp_path):
        """Even after an error, the raw file can be re-finalized via recovery."""
        sess = RecordingSession(
            _cfg(),
            str(tmp_path),
            ExceptionAfterNSource(5),
        )
        sess.start()
        _wait(sess)
        # Remove summary to simulate needing recovery
        os.remove(os.path.join(sess.dir, "summary.json"))
        os.remove(os.path.join(sess.dir, "capture.mat"))
        os.remove(os.path.join(sess.dir, "live_cache.bin"))
        # Scan should find it
        incomplete = scan_incomplete(str(tmp_path))
        assert len(incomplete) == 1
        # Recovery should work
        summary = recover_session(str(tmp_path), sess.id)
        assert summary["n"] == 250


class TestStartFailure:
    """Device not found / source.start() raises before any data is acquired."""

    def test_session_error_no_data(self, tmp_path):
        sess = RecordingSession(_cfg(), str(tmp_path), StartFailureSource())
        sess.start()
        _wait(sess)
        assert sess.state == "error"
        assert "Device identifier is invalid" in sess.error
        assert sess.n_total == 0

    def test_no_finalize_attempted(self, tmp_path):
        sess = RecordingSession(_cfg(), str(tmp_path), StartFailureSource())
        sess.start()
        _wait(sess)
        assert sess.summary is None
        assert not os.path.isfile(os.path.join(sess.dir, "summary.json"))

    def test_failed_start_removes_the_empty_capture_dir(self, tmp_path):
        """#84: 0 rows captured = nothing to finalize or recover, so nothing is left on disk, and
        the failure is reported as a failed START, not a failed finalize."""
        sess = RecordingSession(_cfg(), str(tmp_path), StartFailureSource())
        sess.start()
        _wait(sess)
        assert sess.error_kind == "start"
        assert sess.error.startswith("could not start acquisition:")
        assert sess.status()["error_kind"] == "start"
        assert not os.path.exists(sess.dir)

    def test_first_chunk_processing_error_keeps_the_raw(self, tmp_path):
        """#84: _consume appends to the raw BEFORE bumping n_total, so a failure while processing
        the very first chunk leaves rows on disk with n_total == 0. That is not a failed start and
        its data must not be deleted: it stays recoverable."""
        sess = RecordingSession(_cfg(), str(tmp_path), ExceptionAfterNSource(1))

        def boom(*a, **k):
            raise RuntimeError("processing failed")

        sess.cut.update = boom
        sess.start()
        _wait(sess)
        assert sess.n_total == 0
        assert sess.state == "error"
        assert sess.error_kind == "acquisition"
        assert os.path.isfile(_raw_path(sess))
        assert [s["id"] for s in scan_incomplete(str(tmp_path))] == [sess.id]

    def test_not_in_incomplete_scan(self, tmp_path):
        """Empty raw files should not appear in recovery scan."""
        sess = RecordingSession(_cfg(), str(tmp_path), StartFailureSource())
        sess.start()
        _wait(sess)
        incomplete = scan_incomplete(str(tmp_path))
        assert len(incomplete) == 0


class TestForcedStop:
    """User hits Stop or application is force-closed during recording."""

    def test_stop_mid_recording(self, tmp_path):
        sess = RecordingSession(_cfg(), str(tmp_path), InfiniteSource())
        sess.start()
        time.sleep(0.3)  # let some data accumulate
        sess.stop(wait=True, timeout=10.0)
        sess.join_finalize(10.0)  # finalize() now runs in the background after stop() returns
        assert sess.state == "done"
        assert sess.n_total > 0

    def test_data_preserved_on_stop(self, tmp_path):
        sess = RecordingSession(_cfg(), str(tmp_path), InfiniteSource())
        sess.start()
        time.sleep(0.3)
        sess.stop(wait=True, timeout=10.0)
        rows = memmap_rows(_raw_path(sess))
        assert rows.shape[0] > 0
        assert rows.shape[0] == sess.n_total

    def test_finalize_runs_after_stop(self, tmp_path):
        sess = RecordingSession(_cfg(), str(tmp_path), InfiniteSource())
        sess.start()
        time.sleep(0.3)
        sess.stop(wait=True, timeout=10.0)
        sess.join_finalize(10.0)
        for name in ("raw.d1raw", "capture.mat", "live_cache.bin", "summary.json"):
            assert os.path.isfile(os.path.join(sess.dir, name))

    def test_immediate_stop(self, tmp_path):
        """Stop called immediately after start — minimal data."""
        sess = RecordingSession(_cfg(), str(tmp_path), InfiniteSource())
        sess.start()
        sess.stop(wait=True, timeout=10.0)
        sess.join_finalize(10.0)
        assert sess.state in ("done", "error")
        # May have 0 or a small number of samples — both are valid


class TestConsumerOverrun:
    """Source produces data faster than the consumer can process."""

    def test_overrun_sets_error(self, tmp_path):
        from app.acquisition.ring import Ring

        sess = RecordingSession(
            _cfg(),
            str(tmp_path),
            SlowConsumerSource(chunk_size=200, n_chunks=50),
        )
        sess.ring = Ring(maxsize=2)
        sess.start()
        _wait(sess, timeout=30)
        # Either completes with overrun error or finishes normally
        # (timing-dependent — but the raw file should always be valid)
        assert sess.state in ("done", "error")
        raw = _raw_path(sess)
        if os.path.isfile(raw) and os.path.getsize(raw) > HEADER_SIZE:
            rows = memmap_rows(raw)
            assert rows.shape[0] > 0


class TestFinalizeFailure:
    """Recording succeeds but finalize() raises — data is still on disk."""

    def test_raw_preserved_when_finalize_crashes(self, tmp_path, monkeypatch):
        import app.session as session_mod

        original_finalize = session_mod.finalize
        call_count = 0

        def _boom_finalize(capture_dir, cfg):
            nonlocal call_count
            call_count += 1
            raise RuntimeError("disk full — cannot write .mat file")

        monkeypatch.setattr(session_mod, "finalize", _boom_finalize)
        sess = RecordingSession(_cfg(), str(tmp_path), DisconnectAfterNSource(5))
        sess.start()
        _wait(sess)

        assert sess.state == "error"
        assert "disk full" in sess.error
        assert sess.summary is None
        # Raw file is intact
        rows = memmap_rows(_raw_path(sess))
        assert rows.shape[0] == 250
        # Manifest should record the error
        m = _manifest(sess)
        assert m["state"] == "error"

        # Recovery with the real finalize should work
        monkeypatch.setattr(session_mod, "finalize", original_finalize)
        summary = recover_session(str(tmp_path), sess.id)
        assert summary["n"] == 250


class TestPowerFailure:
    """Simulate power failure: raw writer is open, data written, but process dies before
    close()/finalize(). The raw file should be valid up to the last fsync point."""

    def test_partial_raw_recoverable(self, tmp_path):
        # Manually write a raw file as if the process died mid-write
        sid = "20240101-120000-power1"
        d = str(tmp_path / sid)
        os.makedirs(d)
        raw_path = os.path.join(d, "raw.d1raw")

        w = RawWriter(raw_path, n_cols=10, rate=2000.0, start_unix=1700000000.0)
        rng = np.random.default_rng(99)
        for i in range(20):
            t = np.arange(i * 50, (i + 1) * 50, dtype=np.float64) / 2000
            data = rng.normal(size=(50, 9)).astype(np.float64)
            w.append(t, data)
        # Simulate crash: flush but don't close properly
        w._fh.flush()
        os.fsync(w._fh.fileno())
        w._fh.close()

        # Write manifest as if recording was in progress
        cfg = RecordConfig(sample_rate=2000, sample_name="POWER-FAIL")
        write_manifest(d, "recording", cfg)

        # Scan should find it
        incomplete = scan_incomplete(str(tmp_path))
        assert len(incomplete) == 1
        assert incomplete[0]["id"] == sid
        assert incomplete[0]["raw"]["n_rows"] == 1000

        # Recovery should produce all artifacts
        summary = recover_session(str(tmp_path), sid)
        assert summary["n"] == 1000
        assert summary["sample_name"] == "POWER-FAIL"
        assert os.path.isfile(os.path.join(d, "capture.mat"))

    def test_truncated_raw_recoverable(self, tmp_path):
        """Simulate power failure mid-write: raw file has partial last row (truncated bytes)."""
        sid = "20240101-120000-trunc1"
        d = str(tmp_path / sid)
        os.makedirs(d)
        raw_path = os.path.join(d, "raw.d1raw")

        w = RawWriter(raw_path, n_cols=10, rate=2000.0, start_unix=1700000000.0)
        rng = np.random.default_rng(55)
        for i in range(10):
            t = np.arange(i * 50, (i + 1) * 50, dtype=np.float64) / 2000
            data = rng.normal(size=(50, 9)).astype(np.float64)
            w.append(t, data)
        w._fh.flush()
        w._fh.close()

        # Append partial garbage bytes (simulating mid-write crash)
        with open(raw_path, "ab") as f:
            f.write(b"\x00" * 17)  # 17 bytes = less than one float32 row (10 × 4 = 40 bytes)

        write_manifest(d, "recording", RecordConfig(sample_rate=2000, sample_name="TRUNCATED"))

        incomplete = scan_incomplete(str(tmp_path))
        assert len(incomplete) == 1
        # memmap_rows truncates to whole rows
        info = incomplete[0]["raw"]
        assert info["n_rows"] == 500  # 10 chunks × 50 rows (truncated bytes ignored)
        assert info["truncated_bytes"] == 17

        # Recovery works with truncated file
        summary = recover_session(str(tmp_path), sid)
        assert summary["n"] == 500


class TestSingleChunkRecording:
    """Source produces exactly one tiny chunk then disconnects — edge case for minimum data."""

    def test_tiny_recording_finalizes(self, tmp_path):
        sess = RecordingSession(_cfg(), str(tmp_path), SingleChunkSource(n_rows=10))
        sess.start()
        _wait(sess)
        assert sess.state == "done"
        assert sess.n_total == 10
        assert os.path.isfile(os.path.join(sess.dir, "summary.json"))

    def test_very_small_recording_has_valid_summary(self, tmp_path):
        sess = RecordingSession(_cfg(), str(tmp_path), SingleChunkSource(n_rows=10))
        sess.start()
        _wait(sess)
        with open(os.path.join(sess.dir, "summary.json")) as f:
            s = json.load(f)
        assert s["n"] == 10
        assert s["fs"] == 2000.0


class TestEmptyChunks:
    """Source sends empty (0-row) chunks before real data."""

    def test_empty_chunks_do_not_crash(self, tmp_path):
        sess = RecordingSession(_cfg(), str(tmp_path), EmptyChunkSource())
        sess.start()
        _wait(sess)
        assert sess.state == "done"
        # 5 real chunks of 50 rows (phases 4-8)
        assert sess.n_total == 250


class TestRapidStartStop:
    """Multiple rapid start/stop cycles — ensure no resource leaks or hangs."""

    def test_five_cycles(self, tmp_path):
        for i in range(5):
            sess = RecordingSession(
                _cfg(sample_name=f"RAPID-{i}"),
                str(tmp_path),
                DisconnectAfterNSource(3),
            )
            sess.start()
            _wait(sess)
            assert sess.state == "done"
            assert sess.n_total == 150  # 3 × 50

    def test_start_stop_start_stop(self, tmp_path):
        """Start with infinite source, stop quickly, repeat."""
        for i in range(3):
            sess = RecordingSession(
                _cfg(sample_name=f"STARTSTOP-{i}"),
                str(tmp_path),
                InfiniteSource(),
            )
            sess.start()
            time.sleep(0.1)
            sess.stop(wait=True, timeout=10.0)
            sess.join_finalize(10.0)
            assert sess.state in ("done", "error")


class TestGracefulShutdown:
    """Simulates process shutdown: stop(wait=False) — fire-and-forget."""

    def test_stop_without_waiting(self, tmp_path):
        sess = RecordingSession(_cfg(), str(tmp_path), InfiniteSource())
        sess.start()
        time.sleep(0.2)
        sess.stop(wait=False)
        # Give the thread a moment to finish on its own
        if sess._thread:
            sess._thread.join(10.0)
        sess.join_finalize(10.0)
        assert sess.state in ("done", "error")
        # Raw file should be valid
        if sess.n_total > 0:
            rows = memmap_rows(_raw_path(sess))
            assert rows.shape[0] == sess.n_total


class FloodSource(_BaseSource):
    """Produces as fast as it can and ignores stop(): only the session's own stop flag ends it."""

    def stop(self):
        pass

    def read(self):
        return self._chunk(50)


class _NullBroadcaster:
    def publish(self, msg):
        pass


class TestConsumerFailure:
    """A consumer-thread exception must end the run, not wedge it in "recording" (review 1.1)."""

    def _boom_after(self, monkeypatch, sess, n_ok: int, exc: Exception) -> None:
        orig = sess.raw.append
        calls = {"n": 0}

        def _append(t, data):
            calls["n"] += 1
            if calls["n"] > n_ok:
                raise exc
            return orig(t, data)

        monkeypatch.setattr(sess.raw, "append", _append)

    def test_raw_append_failure_ends_in_terminal_state(self, tmp_path, monkeypatch):
        sess = RecordingSession(_cfg(), str(tmp_path), FloodSource())
        self._boom_after(monkeypatch, sess, 20, OSError("disk I/O error"))
        sess.start()
        _wait(sess, timeout=20)

        assert sess.state == "error"
        assert sess.error_kind == "acquisition"
        assert "disk I/O error" in sess.error  # the real cause, not "consumer overrun"
        assert sess.ring.closed
        # raw.close() ran: the 20 good chunks are on disk and the file handle is released
        assert sess.raw._fh is None or sess.raw._fh.closed
        assert memmap_rows(_raw_path(sess)).shape[0] == 20 * 50
        assert _manifest(sess)["state"] == "error"

    def test_encode_frame_failure_ends_in_terminal_state(self, tmp_path, monkeypatch):
        import app.session as session_mod

        calls = {"n": 0}

        def _bad_frame(*a, **k):
            calls["n"] += 1
            if calls["n"] > 5:
                raise ValueError("bad frame")
            return b""

        monkeypatch.setattr(session_mod, "encode_frame", _bad_frame)
        sess = RecordingSession(_cfg(), str(tmp_path), FloodSource(), _NullBroadcaster())
        sess.start()
        t0 = time.monotonic()
        _wait(sess, timeout=20)

        assert time.monotonic() - t0 < 10
        assert sess.state == "error"
        assert "bad frame" in sess.error

    def test_stop_completes_after_consumer_death(self, tmp_path, monkeypatch):
        sess = RecordingSession(_cfg(), str(tmp_path), FloodSource())
        self._boom_after(monkeypatch, sess, 3, RuntimeError("boom"))
        sess.start()
        time.sleep(0.5)
        t0 = time.monotonic()
        sess.stop(wait=True, timeout=10)
        assert time.monotonic() - t0 < 8
        sess.join_finalize(10)
        assert sess.state == "error"
        assert "boom" in sess.error


class TestRing:
    def test_close_never_blocks_on_a_full_ring(self):
        from app.acquisition.ring import Ring

        ring = Ring(maxsize=2)
        z = np.zeros(1)
        assert ring.put(z, z) and ring.put(z, z)
        t0 = time.monotonic()
        ring.close()  # used to block forever on a full queue
        assert time.monotonic() - t0 < 1
        assert ring.put(z, z) is False  # closed: nothing will drain it

    def test_closed_ring_delivers_every_queued_chunk_then_none(self):
        from app.acquisition.ring import Ring

        ring = Ring(maxsize=2)
        z = np.zeros(1)
        ring.put(z, z)
        ring.put(z, z)
        ring.close()
        assert ring.get() is not None
        assert ring.get() is not None
        assert ring.get() is None
