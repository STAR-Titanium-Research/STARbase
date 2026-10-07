"""API endpoint tests for recovery, backup config, and storage features."""

import json
import os
import time

import numpy as np
import pytest
from fastapi.testclient import TestClient

import app.main as main
from app.config import RecordConfig
from app.d1rw import RawWriter
from app.main import app as fastapi_app
from app.recovery import write_manifest


def _make_raw(capture_dir: str, n_rows: int = 200, rate: float = 2000.0) -> None:
    os.makedirs(capture_dir, exist_ok=True)
    raw_path = os.path.join(capture_dir, "raw.d1raw")
    w = RawWriter(raw_path, n_cols=10, rate=rate, start_unix=1700000000.0)
    rng = np.random.default_rng(42)
    for i in range(0, n_rows, 50):
        n = min(50, n_rows - i)
        t = np.arange(i, i + n, dtype=np.float64) / rate
        data = rng.normal(size=(n, 9)).astype(np.float64)
        w.append(t, data)
    w.close()


# ---- Recovery API ----


def test_recovery_check_empty(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "CAPTURES_ROOT", str(tmp_path))
    with TestClient(fastapi_app) as client:
        r = client.get("/recovery/check")
        assert r.status_code == 200
        assert r.json()["incomplete"] == []


def test_recovery_check_finds_incomplete(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "CAPTURES_ROOT", str(tmp_path))
    sid = "20240101-120000-abc123"
    _make_raw(str(tmp_path / sid), n_rows=300)

    with TestClient(fastapi_app) as client:
        r = client.get("/recovery/check")
        assert r.status_code == 200
        items = r.json()["incomplete"]
        assert len(items) == 1
        assert items[0]["id"] == sid
        assert items[0]["raw"]["n_rows"] == 300


def test_recovery_check_excludes_the_live_recording_session(tmp_path, monkeypatch):
    # #29: while a recording is actively streaming, its dir has a raw.d1raw and no summary.json
    # yet -- looks identical to a crashed session unless /recovery/check knows to exclude whichever
    # id the live session object says it's currently writing to.
    monkeypatch.setattr(main, "CAPTURES_ROOT", str(tmp_path))
    sid = "20240101-120000-abc123"
    _make_raw(str(tmp_path / sid), n_rows=300)

    class _StubSession:
        id = sid
        state = "recording"

    monkeypatch.setattr(main, "_session", _StubSession())
    with TestClient(fastapi_app) as client:
        r = client.get("/recovery/check")
        assert r.json()["incomplete"] == []


def test_recovery_check_still_lists_a_session_after_recording_ends(tmp_path, monkeypatch):
    # A session lingers with state 'done'/'error' briefly, but by then finalize() already wrote
    # summary.json -- covered by the summary_path check. This asserts the *id* exclusion itself is
    # scoped to genuinely-active states, not "whatever _session last pointed at".
    monkeypatch.setattr(main, "CAPTURES_ROOT", str(tmp_path))
    sid = "20240101-120000-abc123"
    _make_raw(str(tmp_path / sid), n_rows=300)

    class _StubSession:
        id = sid
        state = "idle"

    monkeypatch.setattr(main, "_session", _StubSession())
    with TestClient(fastapi_app) as client:
        r = client.get("/recovery/check")
        assert len(r.json()["incomplete"]) == 1


def test_recovery_recover_success(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "CAPTURES_ROOT", str(tmp_path))
    sid = "20240101-120000-rec001"
    d = str(tmp_path / sid)
    _make_raw(d, n_rows=500)
    cfg = RecordConfig(sample_name="RECOVER-API", sample_rate=2000)
    write_manifest(d, "recording", cfg)

    with TestClient(fastapi_app) as client:
        r = client.post(f"/recovery/recover/{sid}")
        assert r.status_code == 200
        data = r.json()
        assert data["recovered"] is True
        assert data["summary"]["n"] == 500
        assert data["summary"]["sample_name"] == "RECOVER-API"

        # Now should not appear in incomplete list
        r2 = client.get("/recovery/check")
        assert len(r2.json()["incomplete"]) == 0


def test_recovery_recover_404_for_missing(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "CAPTURES_ROOT", str(tmp_path))
    with TestClient(fastapi_app) as client:
        r = client.post("/recovery/recover/nonexistent-session")
        assert r.status_code == 404


def test_recovery_recover_400_for_already_finalized(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "CAPTURES_ROOT", str(tmp_path))
    sid = "20240101-120000-alrfin"
    d = str(tmp_path / sid)
    _make_raw(d, n_rows=100)
    with open(os.path.join(d, "summary.json"), "w") as f:
        json.dump({"n": 100}, f)

    with TestClient(fastapi_app) as client:
        r = client.post(f"/recovery/recover/{sid}")
        assert r.status_code == 400


def test_recovery_discard_success(tmp_path, monkeypatch):
    # The endpoint returns as soon as the delete is scheduled, not once it finishes (see
    # recovery_discard in main.py — a large raw.d1raw shouldn't hang the request), so the directory
    # removal is asserted with a short poll rather than immediately after the response.
    monkeypatch.setattr(main, "CAPTURES_ROOT", str(tmp_path))
    sid = "20240101-120000-disc01"
    _make_raw(str(tmp_path / sid), n_rows=100)

    with TestClient(fastapi_app) as client:
        r = client.post(f"/recovery/discard/{sid}")
        assert r.status_code == 200
        assert r.json()["discarded"] is True
        deadline = time.time() + 5
        while os.path.exists(str(tmp_path / sid)) and time.time() < deadline:
            time.sleep(0.05)
        assert not os.path.exists(str(tmp_path / sid))


def test_recovery_discard_404_for_missing(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "CAPTURES_ROOT", str(tmp_path))
    with TestClient(fastapi_app) as client:
        r = client.post("/recovery/discard/ghost-session")
        assert r.status_code == 404


# ---- Manifest written during recording lifecycle ----


def test_session_writes_manifest_on_start_and_done(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "CAPTURES_ROOT", str(tmp_path))
    with TestClient(fastapi_app) as client:
        r = client.post("/record/start", json={"sample_rate": 2000, "duration_sec": 0.3})
        assert r.status_code == 200
        cid = r.json()["id"]

        # Manifest should exist immediately
        manifest_path = os.path.join(str(tmp_path), cid, "manifest.json")
        assert os.path.isfile(manifest_path)
        with open(manifest_path) as f:
            m = json.load(f)
        assert m["state"] in ("recording", "finalizing", "done")

        # Wait for completion. Poll the MANIFEST FILE, not just /record/status: the status
        # endpoint flips to "done" a beat before _finalize_async's last manifest rewrite lands,
        # and a contended CI runner widens that gap enough to fail an assertion that reads the
        # file immediately after the status loop. Generous budget (60 s) — a 0.3 s capture
        # finalises in ~1 s locally and the loop breaks the instant it is done, so a healthy
        # machine still finishes in about a second; the ceiling only matters on a hammered runner.
        m = {}
        for _ in range(600):
            st = client.get("/record/status").json()
            with open(manifest_path) as f:
                m = json.load(f)
            if m.get("state") in ("done", "error") and st["state"] in ("done", "error"):
                break
            time.sleep(0.1)

        assert m["state"] == "done"


def test_recovery_excludes_the_currently_active_recording(tmp_path, monkeypatch):
    """Regression, reproduced live: RecordPage.vue calls /recovery/check on every mount, not just
    app launch — a recording that is simply still running (no summary.json yet because it hasn't
    finished) looks identical on disk to a crashed one and got listed as 'incomplete'. Discarding
    it hit shutil.rmtree on a directory whose raw.d1raw was still open by the live acquisition
    thread: PermissionError, swallowed in a background task, while the real recording kept running
    untouched underneath — a confusing, seemingly-stuck delete with no error surfaced anywhere.
    """
    monkeypatch.setattr(main, "CAPTURES_ROOT", str(tmp_path))
    with TestClient(fastapi_app) as client:
        r = client.post("/record/start", json={"sample_rate": 2000, "duration_sec": 2.0})
        assert r.status_code == 200, r.text
        cid = r.json()["id"]

        # Confirm it is genuinely still recording before asserting anything about it.
        assert client.get("/record/status").json()["state"] == "recording"

        check = client.get("/recovery/check").json()
        assert cid not in {
            s["id"] for s in check["incomplete"]
        }, "an in-progress recording must never be offered as recoverable/discardable"

        # Defense in depth: even a stale client-side list must not be able to act on it.
        r_discard = client.post(f"/recovery/discard/{cid}")
        assert r_discard.status_code == 400
        r_recover = client.post(f"/recovery/recover/{cid}")
        assert r_recover.status_code == 400

        # And the recording is provably unaffected — let it finish normally.
        for _ in range(100):
            if client.get("/record/status").json()["state"] in ("done", "error"):
                break
            time.sleep(0.1)
        assert client.get("/record/status").json()["state"] == "done"


# ---- Backup config API ----


def test_backup_config_defaults(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "CAPTURES_ROOT", str(tmp_path))
    with TestClient(fastapi_app) as client:
        r = client.get("/backup/config")
        assert r.status_code == 200
        cfg = r.json()
        assert cfg["enabled"] is False
        assert cfg["server_url"] == ""


def test_backup_config_save_and_load(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "CAPTURES_ROOT", str(tmp_path))
    with TestClient(fastapi_app) as client:
        r = client.post(
            "/backup/config",
            json={
                "enabled": True,
                "server_url": "http://backuphost:8210",
                "retention_hours": 24,
            },
        )
        assert r.status_code == 200
        cfg = r.json()
        assert cfg["enabled"] is True
        assert cfg["server_url"] == "http://backuphost:8210"
        # An older UI may still send retention_hours: accepted, ignored (#93).
        assert "retention_hours" not in cfg

        # Verify persisted
        r2 = client.get("/backup/config")
        cfg2 = r2.json()
        assert cfg2["enabled"] is True


def test_backup_status_no_active_session(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "CAPTURES_ROOT", str(tmp_path))
    with TestClient(fastapi_app) as client:
        r = client.get("/backup/status")
        assert r.status_code == 200
        data = r.json()
        assert data["active"] is None


# ---- Storage API ----


def test_storage_config_get(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "CAPTURES_ROOT", str(tmp_path))
    with TestClient(fastapi_app) as client:
        r = client.get("/storage/config")
        assert r.status_code == 200
        data = r.json()
        assert "free_gb" in data
        assert "total_gb" in data
        assert "captures_root" in data


def test_disk_usage_reports_none_when_stat_fails(monkeypatch):
    """A failed stat must read as UNKNOWN, not as a full disk.

    Returning 0 here made `Session._watch_disk` force-stop a healthy recording over one transient
    error — the exact recordings the disk guard exists to protect.
    """
    from app import storage

    def _boom(_path):
        raise OSError("drive disconnected")

    monkeypatch.setattr(storage.shutil, "disk_usage", _boom)
    usage = storage.disk_usage_for("D:\\nonexistent")
    assert usage["free_gb"] is None
    assert usage["total_gb"] is None


def test_watch_disk_ignores_unknown_free_space(tmp_path, monkeypatch):
    """An unreadable drive must not trip the forced-stop path."""
    from app import session as session_mod

    monkeypatch.setattr(session_mod, "disk_usage_for", lambda _p: {"free_gb": None})

    class _FakeSession:
        state = "recording"
        captures_root = str(tmp_path)
        backup = None
        disk_action = None
        error = None
        stopped = False

        def stop(self, wait=True):
            self.stopped = True

        def _publish_control(self, msg):
            pass

        def _enable_backup_now(self):
            return False

    s = _FakeSession()
    # Pre-set the stop event so the watcher takes exactly one pass and exits.
    import threading

    s._stop = threading.Event()

    def _wait(_timeout):
        s._stop.set()
        return True

    s._stop.wait = _wait  # type: ignore[method-assign]
    session_mod.RecordingSession._watch_disk(s)  # type: ignore[arg-type]

    assert s.stopped is False, "unknown free space must not force-stop the recording"
    assert s.disk_action is None
    assert s.error is None


def test_estimate_recording_size_uses_float32_rows():
    """The raw writer emits float32 — assuming float64 doubled every size estimate."""
    from app import storage

    # 1000 Hz * 10 s * 10 cols * 4 bytes = 400_000 bytes
    assert storage.estimate_recording_size_gb(1000, 10, 10) == pytest.approx(400_000 / 1e9)


def test_storage_drives_list(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "CAPTURES_ROOT", str(tmp_path))
    with TestClient(fastapi_app) as client:
        r = client.get("/storage/drives")
        assert r.status_code == 200
        data = r.json()
        assert "drives" in data
        assert "current" in data


# ---- Finalize file_sizes_mb ----


def test_finalize_includes_file_sizes(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "CAPTURES_ROOT", str(tmp_path))
    with TestClient(fastapi_app) as client:
        r = client.post("/record/start", json={"sample_rate": 2000, "duration_sec": 0.3})
        assert r.status_code == 200
        cid = r.json()["id"]

        for _ in range(100):
            st = client.get("/record/status").json()
            if st["state"] in ("done", "error"):
                break
            time.sleep(0.1)
        assert st["state"] == "done"

        summ = client.get(f"/captures/{cid}/summary").json()
        assert "file_sizes_mb" in summ
        assert "raw.d1raw" in summ["file_sizes_mb"]
        assert summ["file_sizes_mb"]["raw.d1raw"] > 0


# ---- Connectivity Doctor: NI-DAQ runtime finding ----
#
# nidaq_available() is mocked here rather than relying on ambient host state: unlike the design
# doc's assumption of a driver-less dev machine, this build machine has NI-DAQmx 26.0 actually
# installed (from earlier NI-DAQ acquisition work this session), so leaving it unmocked would make
# the warn-path assertion flaky/host-dependent. Mocking both branches exercises the actual
# health_doctor() code path deterministically, same as the other isolation done in this file.


def test_health_doctor_reports_nidaq_runtime_status(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "CAPTURES_ROOT", str(tmp_path))
    monkeypatch.setattr(main, "nidaq_available", lambda: False)
    with TestClient(fastapi_app) as client:
        r = client.post("/health/doctor", json={})
        assert r.status_code == 200, r.text
        findings = r.json()["findings"]
        nidaq = next(f for f in findings if f["service"] == "NI-DAQ runtime")
        # No NI-DAQmx driver available, so the finding must warn, not silently pass as "ok" —
        # that's the whole point of the check.
        assert nidaq["status"] == "warn"
        assert "NI-DAQmx" in nidaq["message"]


def test_health_doctor_reports_nidaq_runtime_ok_when_available(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "CAPTURES_ROOT", str(tmp_path))
    monkeypatch.setattr(main, "nidaq_available", lambda: True)
    with TestClient(fastapi_app) as client:
        r = client.post("/health/doctor", json={})
        assert r.status_code == 200, r.text
        findings = r.json()["findings"]
        nidaq = next(f for f in findings if f["service"] == "NI-DAQ runtime")
        assert nidaq["status"] == "ok"


# ---- Connectivity Doctor: NI-DAQ hardware finding ----
#
# The driver being installed says nothing about a chassis actually being plugged in and powered —
# that's the "software present, hardware absent" gap these tests cover. _devices() is mocked
# directly (rather than the underlying nidaqmx System) since it's the exact seam health_doctor()
# reads from, and it already unifies the real/simulated-fallback paths into one {simulated, chassis,
# standalone} shape.


def test_health_doctor_warns_when_nidaq_hardware_is_simulated(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "CAPTURES_ROOT", str(tmp_path))
    monkeypatch.setattr(main, "nidaq_available", lambda: True)
    monkeypatch.setattr(
        main, "_devices", lambda: {"simulated": True, "chassis": [], "standalone": []}
    )
    with TestClient(fastapi_app) as client:
        r = client.post("/health/doctor", json={})
        findings = r.json()["findings"]
        hw = next(f for f in findings if f["service"] == "NI-DAQ hardware")
        # warn, not fail: a dev machine with no rig attached is a normal, expected state.
        assert hw["status"] == "warn"
        assert "simulated" in hw["message"].lower()


def test_health_doctor_oks_nidaq_hardware_when_a_real_chassis_answers(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "CAPTURES_ROOT", str(tmp_path))
    monkeypatch.setattr(main, "nidaq_available", lambda: True)
    monkeypatch.setattr(
        main,
        "_devices",
        lambda: {"simulated": False, "chassis": [{"name": "STAR_DAQ"}], "standalone": []},
    )
    with TestClient(fastapi_app) as client:
        r = client.post("/health/doctor", json={})
        findings = r.json()["findings"]
        hw = next(f for f in findings if f["service"] == "NI-DAQ hardware")
        assert hw["status"] == "ok"
        assert "STAR_DAQ" in hw["message"]


def test_health_doctor_warns_when_nidaq_enumerates_nothing_at_all(tmp_path, monkeypatch):
    """Not the same as the simulated-fallback case: simulated=False but genuinely empty means
    System.local() itself returned no devices, a different failure worth a different message."""
    monkeypatch.setattr(main, "CAPTURES_ROOT", str(tmp_path))
    monkeypatch.setattr(main, "nidaq_available", lambda: True)
    monkeypatch.setattr(
        main, "_devices", lambda: {"simulated": False, "chassis": [], "standalone": []}
    )
    with TestClient(fastapi_app) as client:
        r = client.post("/health/doctor", json={})
        findings = r.json()["findings"]
        hw = next(f for f in findings if f["service"] == "NI-DAQ hardware")
        assert hw["status"] == "warn"


def test_health_doctor_skips_nidaq_hardware_check_without_the_runtime(tmp_path, monkeypatch):
    """No driver => enumeration always falls back to simulated for that same reason, so a second
    finding would just repeat the runtime warning under a different name."""
    monkeypatch.setattr(main, "CAPTURES_ROOT", str(tmp_path))
    monkeypatch.setattr(main, "nidaq_available", lambda: False)
    with TestClient(fastapi_app) as client:
        r = client.post("/health/doctor", json={})
        findings = r.json()["findings"]
        assert not any(f["service"] == "NI-DAQ hardware" for f in findings)


# ---- Connectivity Doctor: LabAmp finding ----
#
# Regression coverage for replacing a bare TCP-port probe with a real protocol call
# (get_operation_mode()): a device answering on the port without speaking the LabAmp protocol must
# now be distinguishable from one that's genuinely unreachable, and from mock mode.


class _FakeAmpClient:
    """Stands in for LabAmpClient so the doctor's own timeout/retry logic is exercised without a
    real network call. main.py imports LabAmpClient by name, so patching that name is the seam."""

    def __init__(self, base_url, timeout=10.0, **_):
        self.base_url = base_url

    def get_operation_mode(self):
        return _FakeAmpClient.mode


def test_health_doctor_oks_labamp_when_it_answers(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "CAPTURES_ROOT", str(tmp_path))
    monkeypatch.setattr(main, "_labamp_cfg", {"base_url": "http://169.254.143.59", "mode": "real"})
    _FakeAmpClient.mode = "MEASURE"
    monkeypatch.setattr(main, "LabAmpClient", _FakeAmpClient)
    with TestClient(fastapi_app) as client:
        r = client.post("/health/doctor", json={})
        findings = r.json()["findings"]
        amp = next(f for f in findings if f["service"] == "LabAmp")
        assert amp["status"] == "ok"
        assert "MEASURE" in amp["message"]


def test_health_doctor_fails_labamp_when_something_else_answers_the_port(tmp_path, monkeypatch):
    """The old TCP-only probe would have called this 'ok' — anything accepting the connection
    passed. A real protocol call must fail it instead."""
    monkeypatch.setattr(main, "CAPTURES_ROOT", str(tmp_path))
    monkeypatch.setattr(main, "_labamp_cfg", {"base_url": "http://169.254.143.59", "mode": "real"})

    class _WrongDevice(_FakeAmpClient):
        def get_operation_mode(self):
            from app.labamp import LabAmpError

            raise LabAmpError("LabAmp non-JSON response for /api/$/operationMode/get")

    monkeypatch.setattr(main, "LabAmpClient", _WrongDevice)
    with TestClient(fastapi_app) as client:
        r = client.post("/health/doctor", json={})
        findings = r.json()["findings"]
        amp = next(f for f in findings if f["service"] == "LabAmp")
        assert amp["status"] == "fail"
        assert "link-local" in amp["diagnosis"]  # 169.254.x.x — the guidance must still fire


def test_health_doctor_labamp_diagnosis_skips_link_local_hint_for_a_normal_ip(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(main, "CAPTURES_ROOT", str(tmp_path))
    monkeypatch.setattr(main, "_labamp_cfg", {"base_url": "http://192.168.1.50", "mode": "real"})

    class _Unreachable(_FakeAmpClient):
        def get_operation_mode(self):
            from app.labamp import LabAmpError

            raise LabAmpError("LabAmp unreachable at http://192.168.1.50: connection refused")

    monkeypatch.setattr(main, "LabAmpClient", _Unreachable)
    with TestClient(fastapi_app) as client:
        r = client.post("/health/doctor", json={})
        findings = r.json()["findings"]
        amp = next(f for f in findings if f["service"] == "LabAmp")
        assert amp["status"] == "fail"
        assert "link-local" not in amp["diagnosis"]


# ---- /support/report-bug: LabAmp probe timeout + console_tail privacy gate ----
#
# `create_issue` (which would otherwise POST to the real bug-report relay over the network) is
# faked so these tests are deterministic and don't touch the network; the fake just records what
# it was called with so the test can inspect it.


def _install_fake_create_issue(monkeypatch):
    calls: list[dict] = []

    async def _fake(**kwargs):
        calls.append(kwargs)
        return {"ok": True, "url": "https://example.invalid/issues/1"}

    monkeypatch.setattr(main.bug_report, "create_issue", _fake)
    return calls


def test_report_bug_labamp_probe_uses_a_bounded_timeout_not_the_shared_clients_10s(
    tmp_path, monkeypatch
):
    """Regression: the diagnostics probe used to call the SHARED `_labamp` client directly, which
    defaults to a 10s timeout — so filing a report while the amp is unreachable (exactly the
    scenario this diagnostic exists for) could stall the request for up to 10s. It must build its
    own client with a short, explicit timeout instead, same as health_doctor()'s equivalent check.
    """
    monkeypatch.setattr(main, "CAPTURES_ROOT", str(tmp_path))
    monkeypatch.setattr(main, "_labamp_cfg", {"base_url": "http://169.254.9.9", "mode": "real"})
    monkeypatch.setattr(main, "_labamp", object())  # anything that isn't a MockLabAmp

    seen_timeouts: list[float] = []

    class _SlowAmp:
        def __init__(self, base_url, timeout=10.0, **_):
            seen_timeouts.append(timeout)

        def get_operation_mode(self):
            from app.labamp import LabAmpError

            raise LabAmpError("simulated: amp unreachable")

    monkeypatch.setattr(main, "LabAmpClient", _SlowAmp)
    calls = _install_fake_create_issue(monkeypatch)

    with TestClient(fastapi_app) as client:
        r = client.post(
            "/support/report-bug",
            data={"title": "amp seems dead", "include_logs": "true"},
        )
        assert r.status_code == 200, r.text

    assert seen_timeouts == [3.0], "the diagnostics probe must use its own short timeout"
    diagnostics = calls[0]["diagnostics"]
    assert "labamp:" in diagnostics
    assert "<unavailable:" in diagnostics  # the probe's failure is recorded, not raised


def test_report_bug_omits_console_tail_when_logs_are_declined(tmp_path, monkeypatch):
    """Regression: the server forwarded console_tail unconditionally regardless of include_logs —
    the UI only sends it when that checkbox is on, but nothing enforced the guarantee server-side.
    A modified or future client could attach the renderer console even when logs were declined."""
    monkeypatch.setattr(main, "CAPTURES_ROOT", str(tmp_path))
    calls = _install_fake_create_issue(monkeypatch)

    with TestClient(fastapi_app) as client:
        r = client.post(
            "/support/report-bug",
            data={
                "title": "something broke",
                "include_logs": "false",
                "console_tail": "this should never be attached",
            },
        )
        assert r.status_code == 200, r.text

    assert calls[0]["console_tail"] == ""
    assert calls[0]["log_tail"] == ""
    assert calls[0]["diagnostics"] == ""


def test_report_bug_includes_console_tail_when_logs_are_included(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "CAPTURES_ROOT", str(tmp_path))
    calls = _install_fake_create_issue(monkeypatch)

    with TestClient(fastapi_app) as client:
        r = client.post(
            "/support/report-bug",
            data={
                "title": "something broke",
                "include_logs": "true",
                "console_tail": "console line 1\nconsole line 2",
            },
        )
        assert r.status_code == 200, r.text

    assert "console line 1" in calls[0]["console_tail"]


def test_report_bug_forwards_kind_and_defaults_to_bug(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "CAPTURES_ROOT", str(tmp_path))
    calls = _install_fake_create_issue(monkeypatch)

    with TestClient(fastapi_app) as client:
        client.post("/support/report-bug", data={"title": "no kind sent"})
        client.post("/support/report-bug", data={"title": "a feature idea", "kind": "feature"})

    assert calls[0]["kind"] == "bug"
    assert calls[1]["kind"] == "feature"


def test_report_bug_forwards_area_and_defaults_to_general(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "CAPTURES_ROOT", str(tmp_path))
    calls = _install_fake_create_issue(monkeypatch)

    with TestClient(fastapi_app) as client:
        client.post("/support/report-bug", data={"title": "no area sent"})
        client.post("/support/report-bug", data={"title": "a plotting bug", "area": "plotting"})
        # #95: several areas arrive as a repeated form field.
        client.post(
            "/support/report-bug",
            data={"title": "two areas", "area": ["plotting", "recording"]},
        )

    assert calls[0]["area"] == ["general"]
    assert calls[1]["area"] == ["plotting"]
    assert calls[2]["area"] == ["plotting", "recording"]


def test_report_bug_issues_proxies_the_relay(monkeypatch):
    async def _fake_list_issues():
        return {"ok": True, "issues": [{"number": 3, "title": "[Bug] x"}]}

    monkeypatch.setattr(main.bug_report, "list_issues", _fake_list_issues)

    with TestClient(fastapi_app) as client:
        r = client.get("/support/report-bug/issues")

    assert r.status_code == 200
    assert r.json() == {"ok": True, "issues": [{"number": 3, "title": "[Bug] x"}]}
