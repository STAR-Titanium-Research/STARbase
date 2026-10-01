"""End-to-end: run a short non-realtime session, then assert the finalized artifacts are correct
and that the live_cache.bin parses back through the shared D1LC format."""

import json
import os

import numpy as np
from scipy.io import loadmat

from app import d1lc
from app.config import SIGNAL_CHANNELS, ExtraChannel, RecordConfig
from app.session import RecordingSession
from app.sources.sim import SimSource


def test_session_source_start_failure(tmp_path):
    """A source whose start() raises (e.g. an invalid NI-DAQ device) must end in state=error, not
    hang or crash the worker (regression: consumer.join before start)."""

    class BoomSource:
        channels = list(SIGNAL_CHANNELS)
        rate = 1000.0

        def start(self):
            raise RuntimeError("Device identifier is invalid")

        def read(self):
            return None

        def stop(self):
            pass

    cfg = RecordConfig(sample_rate=1000, duration_sec=0.1)
    sess = RecordingSession(cfg, str(tmp_path), BoomSource(), broadcaster=None)
    sess.start()
    sess._thread.join(15)
    assert sess.state == "error"
    assert "Device identifier is invalid" in (sess.error or "")


def test_session_end_to_end(tmp_path):
    cfg = RecordConfig(
        sample_rate=4000,
        duration_sec=1.0,
        rpm=1200,
        feed=0.05,
        diam=80,
        extra_metadata={"Insert": "CNMG-1204", "Tool": "PCLNR"},
    )
    sess = RecordingSession(cfg, str(tmp_path), SimSource(cfg, realtime=False), broadcaster=None)
    sess.start()
    sess._thread.join(30)  # runs to natural completion (finite sim), then finalizes in background
    sess.join_finalize(30)
    assert sess.state == "done", sess.error
    assert sess.n_total > 0

    d = sess.dir
    for name in ("raw.d1raw", "capture.mat", "live_cache.bin", "summary.json"):
        assert os.path.isfile(os.path.join(d, name)), f"missing {name}"

    # .mat: v1.0 10-column DATA + metadata
    m = loadmat(os.path.join(d, "capture.mat"))
    assert m["DATA"].shape[1] == 10
    assert m["DATA"].shape[0] == sess.n_total
    assert float(m["metadata"]["fileVersion"][0][0][0][0]) == 1.0

    # live_cache.bin parses via the shared D1LC format (same as filter-service/client)
    buf = open(os.path.join(d, "live_cache.bin"), "rb").read()
    hdr = d1lc.read_d1lc_header(buf)
    assert hdr["n"] > 0
    assert abs(hdr["diam"] - 80.0) < 1e-3 and abs(hdr["feed"] - 0.05) < 1e-6
    arr = np.frombuffer(buf, dtype="<f4", count=hdr["n"] * 6, offset=32).reshape(6, hdr["n"])
    # Fz (index 3) should show real cutting force; revs (index 5) increases
    assert np.max(np.abs(arr[3])) > 10.0
    assert arr[5][-1] > arr[5][0]
    # extra metadata was stamped into the .mat struct (scipy nests strings in arrays)
    assert "CNMG-1204" in str(m["metadata"]["Insert"])

    summ = json.load(open(os.path.join(d, "summary.json")))
    assert summ["local_diag"]["order_spectrum_status"] == "computed"
    assert len(summ["local_diag"]["order_spectrum"]["orders"]) > 0
    assert "detected" in summ["local_diag"]["drift"]


def test_session_does_not_publish_a_tacho_fault_during_warm_up(tmp_path):
    """Regression: FrmIntegrator used to seed _tacho_ok=False, so the very first chunk processed by
    ANY real recording published {"type": "tacho", "ok": false} over the control channel before
    there had been any chance to measure a pulse — timing an edge-pair takes at least one pulse
    period, almost always spanning a chunk boundary. alarms.ts::evaluateTacho() latches that
    immediately with no grace period, so this raised a false "No tacho signal" alarm at the start
    of every single healthy nidaq recording. SimSource stands in for real hardware here — it
    genuinely emits a pulse train (see test_frm_integrator_continuity), so this is exercising the
    real session/broadcaster wiring, not just FrmIntegrator in isolation.
    """

    class FakeBroadcaster:
        def __init__(self):
            self.published: list = []

        def publish(self, msg) -> None:
            self.published.append(msg)

    cfg = RecordConfig(sample_rate=5000, duration_sec=1.0, rpm=1500, ppr=1)
    bc = FakeBroadcaster()
    sess = RecordingSession(cfg, str(tmp_path), SimSource(cfg, realtime=False), broadcaster=bc)
    sess.start()
    sess._thread.join(15)
    sess.join_finalize(15)
    assert sess.state == "done", sess.error

    control_msgs = []
    for m in bc.published:
        if isinstance(m, str):  # binary D1LF frames are also published — skip those
            try:
                control_msgs.append(json.loads(m))
            except ValueError:
                pass
    tacho_msgs = [m for m in control_msgs if m.get("type") == "tacho"]
    assert not any(
        m.get("ok") is False for m in tacho_msgs
    ), f"a healthy, genuinely-pulsing tacho must never be reported as a confirmed fault: {tacho_msgs}"


def test_session_streams_a_virtual_channel_live(tmp_path):
    """A virtual channel's value must actually reach the wire during acquisition, not just get
    computed at finalize time — it rides the D1LF frame's existing generic per-sub-channel
    envelope (`nSub`), appended after the fixed 9, so no new frame version was needed for this.
    """
    from app.stream.frame import decode_frame

    class FakeBroadcaster:
        def __init__(self):
            self.published: list = []

        def publish(self, msg) -> None:
            self.published.append(msg)

    cfg = RecordConfig(
        sample_rate=5000,
        duration_sec=0.5,
        extra_channels=[ExtraChannel(name="DoubleFx", source="virtual", formula="Fx * 2")],
    )
    bc = FakeBroadcaster()
    sess = RecordingSession(cfg, str(tmp_path), SimSource(cfg, realtime=False), broadcaster=bc)
    sess.start()
    sess._thread.join(15)
    sess.join_finalize(15)
    assert sess.state == "done", sess.error

    frames = [decode_frame(m) for m in bc.published if isinstance(m, bytes | bytearray)]
    assert frames, "expected at least one live frame"
    with_points = [f for f in frames if f["sub"].shape[0] > 0]
    assert with_points, "expected at least one frame with sub-channel data"

    # 8 dyno sub-channels + Tacho + 1 virtual = 10; the virtual channel is the LAST column, min/max
    # pair at index 9 (0-indexed) of the (nTrace, nSub*2) block.
    f = with_points[-1]
    assert f["sub"].shape[1] == 10 * 2
    doubled_min, doubled_max = f["sub"][:, 18], f["sub"][:, 19]
    fx_min, fx_max = f["trace"][:, 1], f["trace"][:, 2]  # Fx's own min/max, columns 1-2 of trace
    assert np.allclose(doubled_min, fx_min * 2, atol=1e-3)
    assert np.allclose(doubled_max, fx_max * 2, atol=1e-3)


def test_start_writes_raw_header(tmp_path):
    cfg = RecordConfig(sample_rate=2000, duration_sec=0.5)
    sess = RecordingSession(cfg, str(tmp_path), SimSource(cfg, realtime=False), broadcaster=None)
    sess.start()
    sess._thread.join(30)
    with open(os.path.join(sess.dir, "raw.d1raw"), "rb") as f:
        magic = f.read(4)
    assert magic == b"D1RW"
