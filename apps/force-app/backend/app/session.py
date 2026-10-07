"""RecordingSession — owns one run's lifecycle: source → ring → consumers → live frames, then
finalize on stop/completion. State machine: idle → recording → finalizing → done (or error)."""

from __future__ import annotations

import json
import logging
import os
import shutil
import threading
import time
import uuid

import numpy as np

from . import virtual_channels
from .acquisition.consumers import CutDetector, Decimator, FrmIntegrator
from .acquisition.ring import Ring
from .backup import BackupStreamer, mark_remote_deleted
from .backup import load_config as load_backup_config
from .clipping import RailDetector
from .config import RecordConfig
from .d1rw import RawWriter
from .dsp import sum_axes, tacho_column, welch_spectra
from .finalize import finalize
from .recovery import raw_info, write_manifest
from .storage import disk_usage_for
from .stream.broadcast import Broadcaster
from .stream.frame import encode_frame

log = logging.getLogger("force_app.session")

# The 8 dyno sub-channels in raw-file column order (data[:, :8]) — matches the client SUB_NAMES.
SUB_NAMES = ["Fx1", "Fx2", "Fy1", "Fy2", "Fz1", "Fz2", "Fz3", "Fz4", "Tacho"]

# Disk-full protection during an active recording (independent of the frontend's own low-disk UI
# alarm, which is advisory only). At DISK_BACKUP_GB, if remote backup is configured but wasn't
# already streaming, switch it on now — BackupStreamer always reads from just after the raw
# header, so it catches the whole recording up, not just what's written from here on. At
# DISK_STOP_GB — a genuine "about to fill the disk" floor — force-stop regardless, since a
# completely full system disk can make Windows itself misbehave, not just this recording.
DISK_BACKUP_GB = 3.0
DISK_STOP_GB = 1.0
DISK_CHECK_INTERVAL = 10.0
RAIL_REPUBLISH_SEC = 2.0


def _raw_rows(capture_dir: str) -> int:
    """Rows actually in the capture's raw file (0 when it is missing or has only its header)."""
    info = raw_info(capture_dir)
    return info["n_rows"] if info else 0


class RecordingSession:
    def __init__(
        self, cfg: RecordConfig, captures_root: str, source, broadcaster: Broadcaster | None = None
    ):
        self.cfg = cfg
        self.captures_root = captures_root
        self.id = time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]
        self.dir = os.path.join(captures_root, self.id)
        os.makedirs(self.dir, exist_ok=True)
        self.broadcaster = broadcaster
        self.backup: BackupStreamer | None = None
        self.state = "idle"
        self.error: str | None = None
        # Which stage failed, when state is "error" (#84): "start" = nothing was captured (the
        # source never produced a sample — e.g. DAQmx refused the rate), and the empty capture
        # directory is removed; "acquisition" = it failed mid-run but the data captured so far was
        # finalized; "finalize" = data was captured but writing the outputs failed, so the raw is
        # still on disk for recovery. The UI words each case differently.
        self.error_kind: str | None = None
        self.summary: dict | None = None
        self.n_total = 0
        self.peaks = [0.0, 0.0, 0.0]
        self._t_last = 0.0

        self.source = source  # SimSource or ReplaySource (any AcquisitionSource)
        self.ring = Ring(maxsize=128)
        self.raw = RawWriter(
            os.path.join(self.dir, "raw.d1raw"),
            n_cols=1 + len(self.source.channels),
            rate=self.source.rate,
            start_unix=time.time(),
        )
        self.decimator = Decimator(bins=2)
        self.frm = FrmIntegrator(cfg, fs=self.source.rate)
        self.cut = CutDetector(cfg, self.source.rate)
        self.cut_started_t: float | None = None
        # Live railing test on the raw volts (see clipping.py); needs the per-channel gains, so
        # it is inert for sim/replay. Its latched set is streamed and reported in status().
        self.rails = RailDetector(cfg.dyno_gains, cfg.analog_fullscale_v)
        self._rail_sent = 0.0
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._finalize_thread: threading.Thread | None = None
        self._disk_thread: threading.Thread | None = None
        self.disk_action: dict | None = None  # last thing the disk watcher did, for the UI
        # None (not False) so the first chunk always publishes, giving the client its initial state
        # instead of leaving it to assume one. False => the tacho is not producing readable pulses.
        self._tacho_ok: bool | None = None
        # Names of virtual channels whose formula has already failed once this session — logged
        # once, not once per chunk (this runs tens of times a second).
        self._extra_eval_errors: set[str] = set()

        # Rolling windows per channel for the live spectra (per-channel FFT / power / spectrogram /
        # waterfall), plus a wall-clock throttle. We keep the 3 summed axes AND the 8 dyno
        # sub-channels so the client can draw a spectrum for any selected channel, like the force.
        self._fft_axis = cfg.axis if cfg.axis in ("Fx", "Fy", "Fz") else "Fz"
        self._fft_names = ["Fx", "Fy", "Fz", *SUB_NAMES]
        self._fft_bufs: dict[str, np.ndarray] = {
            n: np.zeros(0, dtype=np.float64) for n in self._fft_names
        }
        self._fft_cap = int(max(2048, min(200_000, self.source.rate)))  # ~1 s, bounded
        self._fft_last = 0.0
        # Chunks since the last fold into _fft_bufs. Folding (concatenate + trim a ~1 s window per
        # channel) only when a spectrum is due, not per chunk, avoids re-copying 12 windows tens of
        # times a second for spectra published a few times a second.
        self._fft_pending: dict[str, list[np.ndarray]] = {n: [] for n in self._fft_names}
        self._fft_pending_n = 0

    # ---- lifecycle ----
    def start(self) -> None:
        self.state = "recording"
        write_manifest(self.dir, "recording", self.cfg)
        self._enable_backup_now()  # starts it now if configured; a no-op if it isn't
        self._thread = threading.Thread(target=self._run, name=f"rec-{self.id}", daemon=True)
        self._thread.start()
        self._disk_thread = threading.Thread(
            target=self._watch_disk, name=f"rec-disk-{self.id}", daemon=True
        )
        self._disk_thread.start()

    def stop(self, wait: bool = True, timeout: float = 30.0) -> None:
        t0 = time.perf_counter()
        self._stop.set()
        self.source.stop()
        log.info("session.stop: source.stop() returned in %.2fs", time.perf_counter() - t0)
        if wait and self._thread:
            t1 = time.perf_counter()
            self._thread.join(timeout)
            dt = time.perf_counter() - t1
            if self._thread.is_alive():
                log.warning(
                    "session.stop: acquisition thread still alive after %.2fs join timeout", dt
                )
            else:
                log.info("session.stop: acquisition thread joined in %.2fs", dt)

    def _watch_disk(self) -> None:
        """Runs for the life of the recording. Two escalating responses to a filling disk, cheaper
        than the frontend polling loop and independent of it — this keeps protecting the recording
        even if the browser tab is closed or the network to it drops."""
        backed_up_by_watcher = False
        while not self._stop.is_set() and self.state == "recording":
            try:
                free_gb = disk_usage_for(self.captures_root).get("free_gb")
            except Exception:
                free_gb = None
            # `None` means the stat failed, not that the disk is full — never act on it. Skipping a
            # check is harmless (the next one is DISK_CHECK_INTERVAL away); killing a good recording
            # over a transient stat error is not.
            if free_gb is None:
                self._stop.wait(DISK_CHECK_INTERVAL)
                continue
            if free_gb < DISK_STOP_GB:
                self.disk_action = {"action": "forced_stop", "free_gb": free_gb}
                self._publish_control({"type": "disk_action", **self.disk_action})
                # Deliberately NOT set on self.error: the recording itself is intact and finalize
                # will succeed, so the terminal state must stay "done" or the frontend refuses to
                # load/save it — i.e. the recordings this guard exists to protect would be exactly
                # the ones the user loses. `disk_action` already carries the reason for the UI.
                self.stop(wait=False)
                return
            if free_gb < DISK_BACKUP_GB and self.backup is None and not backed_up_by_watcher:
                backed_up_by_watcher = True
                if self._enable_backup_now():
                    self.disk_action = {"action": "backup_started", "free_gb": free_gb}
                else:
                    self.disk_action = {"action": "backup_unavailable", "free_gb": free_gb}
                self._publish_control({"type": "disk_action", **self.disk_action})
            self._stop.wait(DISK_CHECK_INTERVAL)

    def _enable_backup_now(self) -> bool:
        """Turn on remote backup mid-recording. BackupStreamer always tails from right after the
        raw header, so this catches up the whole recording so far, not just what's written after
        this point — a genuine safety net, not just a "protect what's left" measure."""
        if self.backup is not None:
            return False
        bcfg = load_backup_config(self.captures_root)
        if not bcfg.get("enabled") or not bcfg.get("server_url"):
            return False
        try:
            self.backup = BackupStreamer(
                self.id, os.path.join(self.dir, "raw.d1raw"), bcfg["server_url"], self.cfg
            )
            self.backup.start()
            return True
        except Exception:
            self.backup = None
            return False

    def join_finalize(self, timeout: float | None = None) -> None:
        """Block until the background finalize (mat/live_cache/summary write) completes, if one is
        running. stop() no longer waits for this — only the caller who truly needs the finished
        artifacts (e.g. graceful shutdown, before the process may be killed) should call it."""
        if self._finalize_thread:
            self._finalize_thread.join(timeout)

    # ---- worker ----
    def _run(self) -> None:
        # Start the consumer FIRST so it's always joinable — if source.start() raises (e.g. an
        # invalid NI-DAQ device), ring.close() below unblocks it cleanly.
        consumer = threading.Thread(
            target=self._consume, name=f"rec-consume-{self.id}", daemon=True
        )
        consumer.start()
        started = False
        try:
            self.source.start()
            started = True
            while not self._stop.is_set():
                chunk = self.source.read()
                if chunk is None:
                    break
                if not self.ring.put(chunk[0], chunk[1], timeout=5.0):
                    # A closed ring means the consumer already died and recorded why: keep that.
                    self.error = self.error or "consumer overrun"
                    break
        except Exception as e:
            self.error = (
                f"acquisition error: {e}" if started else f"could not start acquisition: {e}"
            )
        finally:
            self.ring.close()
            t_consumer = time.perf_counter()
            consumer.join(timeout=10.0)
            log.info(
                "session._run: consumer thread joined in %.2fs", time.perf_counter() - t_consumer
            )
            t_raw = time.perf_counter()
            self.raw.close()
            log.info(
                "session._run: raw.close() (flush+fsync) took %.2fs", time.perf_counter() - t_raw
            )
            if self.backup:
                self.backup.stop()
            if self.n_total > 0:
                # finalize() does the CPU-heavy work (full-resolution compressed .mat write, D1LC
                # decimation) — run it off this thread so stop()'s join() (and thus the /record/stop
                # HTTP response) returns as soon as the raw capture is safely flushed, instead of
                # blocking for however long that write takes. The "done" state/summary reach the
                # client via the WS control message published below, same as before.
                self.state = "finalizing"
                write_manifest(self.dir, "finalizing", self.cfg)
                self._finalize_thread = threading.Thread(
                    target=self._finalize_async, name=f"rec-finalize-{self.id}", daemon=True
                )
                self._finalize_thread.start()
            else:
                self.state = "error" if self.error else "done"
                if self.error and (_raw_rows(self.dir) == 0):
                    # Failed before a single sample reached the raw file. There is nothing to
                    # finalize or recover — recovery skips a 0-row raw, so the directory would just
                    # sit on disk as an unnamed "incomplete" capture forever. Remove it.
                    self.error_kind = "start"
                    shutil.rmtree(self.dir, ignore_errors=True)
                else:
                    # n_total is bumped AFTER the raw append in _consume, so a failure while
                    # processing the very first chunk leaves rows on disk with n_total == 0. That
                    # data is real: keep the directory (recoverable from Local Captures) and call it
                    # an acquisition failure, not a failed start.
                    if self.error:
                        self.error_kind = "acquisition"
                    write_manifest(self.dir, self.state, self.cfg, self.error)
                self._publish_control(
                    {
                        "type": "done",
                        "id": self.id,
                        "state": self.state,
                        "error": self.error,
                        "error_kind": self.error_kind,
                        "summary": self.summary,
                    }
                )
                if self.error_kind == "start" and self.backup is not None:
                    # The streamer may have registered the (header-only) session already; label
                    # it like any other deleted capture so it expires instead of reading as a
                    # backup. After the publish: it is a network call and the UI shouldn't wait.
                    mark_remote_deleted(self.backup.server_url, self.id)

    def _finalize_async(self) -> None:
        t0 = time.perf_counter()
        log.info("session._finalize_async: starting (n_total=%d)", self.n_total)
        try:
            self.summary = finalize(self.dir, self.cfg)
            self.state = "error" if self.error else "done"
            if self.error:
                self.error_kind = "acquisition"
        except Exception as e:
            self.error = self.error or f"finalize error: {e}"  # keep the original cause
            self.error_kind = "finalize"
            self.state = "error"
        log.info(
            "session._finalize_async: finished in %.2fs (state=%s)",
            time.perf_counter() - t0,
            self.state,
        )
        write_manifest(self.dir, self.state, self.cfg, self.error)
        self._publish_control(
            {
                "type": "done",
                "id": self.id,
                "state": self.state,
                "error": self.error,
                "error_kind": self.error_kind,
                "summary": self.summary,
            }
        )

    def _extra_values(self, data: np.ndarray, axes: dict[str, np.ndarray]) -> np.ndarray:
        """This chunk's value for every configured extra (Aux/virtual) channel — see
        virtual_channels.compute_extra_columns for the shared logic (also used by finalize.py, so
        the two can't disagree). `data` is this chunk straight from the acquisition source: columns
        0-7 are the dyno sub-channels, 8 is Tacho, and 9+ are any real hardware extra channels
        NidaqSource appended (never gain-corrected here — same as the live Fx/Fy/Fz preview, which
        is also pre-gain; finalize.py's archived values are the gain/drift-corrected ones)."""
        hw_raw = data[:, 9:] if data.shape[1] > 9 else None

        def _on_error(name: str, e: virtual_channels.FormulaError) -> None:
            if name not in self._extra_eval_errors:  # log once per session, not once per chunk
                self._extra_eval_errors.add(name)
                log.warning("virtual channel '%s' evaluation failed: %s", name, e)

        return virtual_channels.compute_extra_columns(
            self.cfg.extra_channels, data[:, :8], data[:, 8], axes, hw_raw, on_error=_on_error
        )

    def _consume(self) -> None:
        """Consumer thread. Any failure here (a disk error on the raw append, a bad frame...) must
        end the run cleanly: record why, stop the source, and let `_run` reach raw.close(), backup
        stop and finalize, instead of leaving the producer wedged on a full ring while the session
        reads "recording" forever."""
        try:
            self._consume_loop()
        except Exception as e:
            log.exception("session consumer thread failed; stopping the recording")
            self.error = self.error or f"consumer error: {e}"
            self._stop.set()
            self.ring.close()  # producer's next put() returns False instead of waiting
            try:
                self.source.stop()
            except Exception:
                log.exception("source.stop() failed after a consumer error")
            # Free slots so a producer already blocked in put() wakes up now, not after its timeout.
            self.ring.drain()

    def _consume_loop(self) -> None:
        seq = 0
        while True:
            item = self.ring.get()
            if item is None:
                break
            t, data = item
            if t.size == 0:
                continue
            self.raw.append(t, data)  # never dropped — source of truth
            # Published when a channel newly rails, then re-sent every RAIL_REPUBLISH_SEC while
            # any is railed: a slow client's queue drops control messages under backpressure, and
            # this is the one the operator must not miss.
            newly = self.rails.update(data)
            if newly or (
                self.rails.any and time.monotonic() - self._rail_sent > RAIL_REPUBLISH_SEC
            ):
                self._rail_sent = time.monotonic()
                self._publish_control({"type": "railed", "channels": self.rails.railed})
            axes = sum_axes(data)
            for i, ax in enumerate(("Fx", "Fy", "Fz")):
                self.peaks[i] = max(self.peaks[i], float(np.max(np.abs(axes[ax]))))
            # Causal cut-start detection: reset the FRM spiral origin + tell the UI when it begins.
            ct = self.cut.update(t, np.abs(axes["Fz"]))
            if ct is not None:
                self.cut_started_t = ct
                self.frm.mark_cut_start()
                self._publish_control({"type": "cutstart", "t": ct})
            trace = self.decimator.process(t, axes)
            # Per-sub-channel envelopes (the 8 dyno columns, plus any configured Aux/virtual extra)
            # so the client can plot any single sensor live, not just the summed axes.
            extra = self._extra_values(data, axes)
            sub_cols = np.concatenate([data[:, :9], extra], axis=1) if extra.size else data[:, :9]
            sub = self.decimator.process_cols(t, np.asarray(sub_cols, dtype=np.float64))
            pts, rpm, tacho_ok = self.frm.process(t, axes, tacho_column(data))
            # Only on a transition — this runs per chunk (tens of times a second), and the client
            # only needs to know when the tacho starts or stops being readable.
            if tacho_ok != self._tacho_ok:
                self._tacho_ok = tacho_ok
                self._publish_control({"type": "tacho", "ok": tacho_ok})
            self.n_total += t.size
            self._t_last = float(t[-1])
            if self.broadcaster is not None:
                frame = encode_frame(
                    seq, self._t_last, rpm, tuple(self.peaks), self.n_total, trace, pts, sub=sub
                )
                self.broadcaster.publish(frame)
            self._update_fft(axes, data)
            seq += 1

    def _update_fft(self, axes: dict, data: np.ndarray) -> None:
        """Maintain per-channel rolling windows and publish their Welch amplitude spectra a few
        times a second (a JSON control message). The client draws a spectrum per selected channel
        and accumulates the frames into the spectrogram/waterfall views — only the current spectra
        cross the wire. `axis`/`amp` are kept for back-compat with the old single-axis view."""
        if self.broadcaster is None:
            return
        for n in ("Fx", "Fy", "Fz"):
            y = axes.get(n)
            if y is not None:
                self._fft_pending[n].append(y)
        subcols = np.asarray(data[:, :9], dtype=np.float64)
        for j, n in enumerate(SUB_NAMES):
            if j < subcols.shape[1]:
                # A copy, not a view: the source may reuse its chunk buffer.
                self._fft_pending[n].append(subcols[:, j].copy())
        self._fft_pending_n += data.shape[0]
        now = time.perf_counter()
        if now - self._fft_last < 0.3:
            if self._fft_pending_n >= self._fft_cap:  # bound memory if spectra are slow to come due
                self._fold_fft_pending()
            return
        self._fold_fft_pending()
        if self._fft_bufs[self._fft_axis].size < 256:
            return
        self._fft_last = now
        fs = float(self.source.rate)
        nper = int(min(self._fft_bufs[self._fft_axis].size, 4096))
        fout, spectra_out = welch_spectra(self._fft_bufs, fs=fs, nperseg=nper)
        if fout is None:
            return
        self._publish_control(
            {
                "type": "fft",
                "fs": fs,
                "f": fout,
                "spectra": spectra_out,
                "axis": self._fft_axis,  # back-compat
                "amp": spectra_out.get(self._fft_axis, []),  # back-compat
            }
        )

    def _fold_fft_pending(self) -> None:
        for n, parts in self._fft_pending.items():
            if parts:
                self._fft_bufs[n] = np.concatenate([self._fft_bufs[n], *parts])[-self._fft_cap :]
                parts.clear()
        self._fft_pending_n = 0

    def _publish_control(self, msg: dict) -> None:
        if self.broadcaster is not None:
            self.broadcaster.publish(json.dumps(msg))

    # ---- status ----
    def status(self) -> dict:
        s = {
            "id": self.id,
            "state": self.state,
            "error": self.error,
            "error_kind": self.error_kind,
            "elapsed_sec": round(self._t_last, 3),
            "n_total": self.n_total,
            "peaks": {"Fx": self.peaks[0], "Fy": self.peaks[1], "Fz": self.peaks[2]},
            "config": self.cfg.model_dump(),
            # None until the first chunk is processed; False => tacho producing no readable pulses.
            "tacho_ok": self._tacho_ok,
            # Indices (0-7, Fx1..Fz4) of the sensor channels that have railed this cut.
            "railed": self.rails.railed,
        }
        if self.backup:
            s["backup"] = self.backup.status()
        if self.disk_action:
            s["disk_action"] = self.disk_action
        return s
