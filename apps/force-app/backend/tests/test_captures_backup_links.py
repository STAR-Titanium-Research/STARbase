"""Captures <-> remote backup cross-links, the Doctor's crashed-recordings finding, and the
/record/start sample-rate pre-flight (#82, #83, #84, #86, #91, #92)."""

from __future__ import annotations

import json
import os
import time

import numpy as np
import pytest
from fastapi.testclient import TestClient

import app.main as main
from app import backup as backup_mod
from app import nidaq_enum, recovery
from app.config import RecordConfig
from app.d1rw import RawWriter
from app.main import app as fastapi_app
from app.recovery import write_manifest


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "CAPTURES_ROOT", str(tmp_path))
    monkeypatch.setattr(main, "_session", None)
    with TestClient(fastapi_app) as c:
        yield c


def _incomplete(root, cid: str, *, rows: int = 200, sample_name: str | None = "S-1") -> str:
    d = os.path.join(str(root), cid)
    os.makedirs(d, exist_ok=True)
    w = RawWriter(os.path.join(d, "raw.d1raw"), n_cols=10, rate=2000.0, start_unix=time.time())
    if rows:
        w.append(np.arange(rows) / 2000.0, np.zeros((rows, 9)))
    w.close()
    if sample_name is not None:
        write_manifest(d, "recording", RecordConfig(sample_rate=2000, sample_name=sample_name))
    return d


def _finalized(root, cid: str, name: str = "DONE-1") -> str:
    d = os.path.join(str(root), cid)
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "summary.json"), "w") as f:
        json.dump({"sample_name": name}, f)
    return d


# ---- #82: browse labels an unfinalized capture from its manifest -----------------------------


def test_browse_names_an_incomplete_capture_from_its_manifest(client, tmp_path):
    _incomplete(tmp_path, "20261001-100000-aaa", sample_name="TI64-07")
    _incomplete(tmp_path, "20261001-090000-bbb", rows=0, sample_name=None)
    rows = {c["id"]: c for c in client.get("/captures/browse").json()["captures"]}
    a = rows["20261001-100000-aaa"]
    assert a["finalized"] is False
    assert a["sample_name"] == "TI64-07"
    assert a["recoverable"] is True and a["n"] == 200
    b = rows["20261001-090000-bbb"]
    assert "sample_name" not in b  # no manifest: still listed, just unnamed
    assert b["recoverable"] is False  # 0 rows: Recover has nothing to work with


# ---- #91: deleting/discarding locally tombstones the remote copy -----------------------------


def test_delete_capture_marks_the_remote_backup_deleted(client, tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(
        backup_mod,
        "mark_remote_deleted",
        lambda url, sid, timeout=4.0: calls.append((url, sid)) or True,
    )
    backup_mod.save_config(str(tmp_path), {"enabled": True, "server_url": "http://b:8210"})
    _finalized(tmp_path, "cap-1")
    body = client.delete("/captures/cap-1").json()
    assert body["deleted"] is True and body["remote_marked_deleted"] is True
    assert calls == [("http://b:8210", "cap-1")]


def test_delete_capture_without_a_backup_server_does_not_call_out(client, tmp_path, monkeypatch):
    monkeypatch.setattr(backup_mod, "mark_remote_deleted", lambda *a, **k: pytest.fail("called"))
    _finalized(tmp_path, "cap-2")
    assert client.delete("/captures/cap-2").json()["remote_marked_deleted"] is None


def test_discard_marks_the_remote_backup_deleted(client, tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(
        backup_mod, "mark_remote_deleted", lambda url, sid, timeout=4.0: calls.append(sid) or True
    )
    backup_mod.save_config(str(tmp_path), {"enabled": True, "server_url": "http://b:8210"})
    _incomplete(tmp_path, "crash-1")
    assert client.post("/recovery/discard/crash-1").status_code == 200
    deadline = time.time() + 5
    while (calls != ["crash-1"] or "crash-1" in recovery._discarding) and time.time() < deadline:
        time.sleep(0.02)
    assert calls == ["crash-1"]
    assert not os.path.exists(os.path.join(str(tmp_path), "crash-1"))


def test_mark_remote_deleted_never_raises_on_an_unreachable_server():
    assert backup_mod.mark_remote_deleted("http://127.0.0.1:9", "x", timeout=1.0) is False
    assert backup_mod.mark_remote_deleted("", "x") is False


# ---- #92 / #91: /backup/remote-sessions ------------------------------------------------------


def test_remote_sessions_not_configured(client):
    body = client.get("/backup/remote-sessions").json()
    assert body["configured"] is False and body["sessions"] == []


def test_remote_sessions_unreachable_is_an_error_not_an_empty_list(client, tmp_path):
    backup_mod.save_config(str(tmp_path), {"enabled": True, "server_url": "http://127.0.0.1:9"})
    r = client.get("/backup/remote-sessions")
    assert r.status_code == 502
    assert "could not reach the backup server" in r.json()["detail"]


def test_remote_sessions_are_cross_referenced_with_local_captures(client, tmp_path, monkeypatch):
    backup_mod.save_config(str(tmp_path), {"enabled": True, "server_url": "http://b:8210"})
    _finalized(tmp_path, "fin", name="LOCAL-NAME")
    _incomplete(tmp_path, "inc")
    now = time.time()
    remote = [
        {"id": "fin", "state": "complete", "meta": {"config": {}}},
        {"id": "inc", "state": "streaming", "meta": {"config": {"sample_name": "INC"}}},
        {"id": "gone", "state": "complete", "meta": {"config": {"sample_name": "GONE"}}},
        {
            "id": "tomb",
            "state": "deleted",
            "meta": {"updated_at": now, "config": {"sample_name": "T"}},
        },
    ]
    monkeypatch.setattr(
        backup_mod,
        "fetch_remote_sessions",
        lambda url, timeout=8.0: {"sessions": remote, "retention_hours": 12},
    )
    body = client.get("/backup/remote-sessions").json()
    assert body["configured"] is True and body["retention_hours"] == 12
    by = {s["id"]: s for s in body["sessions"]}
    assert (by["fin"]["local_status"], by["fin"]["backup_state"]) == ("finalized", "complete")
    assert by["fin"]["name"] == "LOCAL-NAME"  # falls back to the local summary
    # "streaming" with no live recording behind it = the stream was cut off.
    assert (by["inc"]["local_status"], by["inc"]["backup_state"]) == ("incomplete", "interrupted")
    assert by["inc"]["name"] == "INC"
    assert (by["gone"]["local_status"], by["gone"]["backup_state"]) == ("missing", "complete")
    assert (by["tomb"]["local_status"], by["tomb"]["backup_state"]) == ("deleted", "deleted")
    # Older servers don't send expires_at; derived from updated_at + retention.
    assert by["tomb"]["expires_at"] == pytest.approx(now + 12 * 3600)


# ---- #82: a failed restore leaves nothing behind ---------------------------------------------


def test_failed_restore_removes_the_directory_it_created(client, tmp_path, monkeypatch):
    backup_mod.save_config(str(tmp_path), {"enabled": True, "server_url": "http://b:8210"})

    def _download(url, sid, dest, timeout=120.0):
        with open(dest, "wb") as f:
            f.write(b"partial")
        return 7

    monkeypatch.setattr(backup_mod, "download_remote_raw", _download)
    monkeypatch.setattr(backup_mod, "fetch_remote_session_config", lambda *a, **k: {})
    r = client.post("/backup/restore/sess-x")
    assert r.status_code == 502
    assert "still on the server" in r.json()["detail"]
    assert not os.path.exists(os.path.join(str(tmp_path), "sess-x"))


def test_failed_restore_leaves_a_pre_existing_directory_alone(client, tmp_path, monkeypatch):
    backup_mod.save_config(str(tmp_path), {"enabled": True, "server_url": "http://b:8210"})
    _incomplete(tmp_path, "sess-y")

    def _boom(*a, **k):
        raise OSError("connection reset")

    monkeypatch.setattr(backup_mod, "download_remote_raw", _boom)
    assert client.post("/backup/restore/sess-y").status_code == 502
    assert os.path.isdir(os.path.join(str(tmp_path), "sess-y"))


# ---- #83: the Doctor's crashed-recordings finding --------------------------------------------


def _doctor(client) -> dict:
    r = client.post("/health/doctor", json={})
    assert r.status_code == 200, r.text
    return r.json()


def test_doctor_crashed_finding_links_to_local_captures_and_lists_items(client, tmp_path):
    _incomplete(tmp_path, "crash-a", sample_name="CR-A")
    f = next(x for x in _doctor(client)["findings"] if x["service"] == "Crashed recordings")
    assert f["link"]["to"].startswith("/settings?tab=captures")
    assert "Record page" not in f["fix"]
    assert f["fix_label"] == "Discard all…"
    assert [(i["id"], i["sample_name"]) for i in f["items"]] == [("crash-a", "CR-A")]


def test_doctor_is_not_healthy_while_discards_are_running(client, monkeypatch):
    monkeypatch.setattr(recovery, "_discarding", {"crash-b"})
    body = _doctor(client)
    pending = next(x for x in body["findings"] if x["service"] == "Discarding recordings")
    assert pending["pending"] is True and pending["status"] == "warn"
    assert body["healthy"] is False


# ---- #84: /record/start pre-flights the sample rate ------------------------------------------


def test_sample_rate_problem_shapes():
    assert main.sample_rate_problem(50_000, {"max": 51_367.188, "min": None}) is None
    hi = main.sample_rate_problem(52_000, {"max": 51_367.188, "min": 1_000.0})
    assert hi["field"] == "sample_rate" and hi["max"] == 51_367.188 and hi["min"] == 1_000.0
    assert "51,367 Hz maximum" in hi["message"]
    lo = main.sample_rate_problem(500, {"max": None, "min": 1_000.0})
    assert lo["field"] == "sample_rate" and "minimum" in lo["message"]
    assert main.sample_rate_problem(1e9, {"max": None, "min": None}) is None  # nothing to check


def test_record_start_rejects_a_rate_above_the_hardware_max(client, tmp_path, monkeypatch):
    import app.sources.nidaq as nidaq_src

    monkeypatch.setattr(nidaq_src, "nidaq_available", lambda: True)
    monkeypatch.setattr(main, "_channel_config", lambda: [])
    monkeypatch.setattr(
        nidaq_enum,
        "sample_rate_limits",
        lambda chans, system=None: {"max": 51_367.188, "min": None},
    )
    chans = [f"cDAQ9Mod1/ai{i}" for i in range(9)]
    r = client.post(
        "/record/start",
        json={"source": "nidaq", "sample_rate": 52_000, "nidaq_channels": chans, "dyno_gains": [1]},
    )
    assert r.status_code == 400
    detail = r.json()["detail"]
    assert detail["field"] == "sample_rate" and detail["max"] == 51_367.188
    # Refused before any session (and so any capture directory) exists.
    assert main._session is None
    assert not [n for n in os.listdir(str(tmp_path)) if os.path.isdir(tmp_path / n)]


# ---- #86: device presence for the NI-DAQ source button ---------------------------------------


class _Dev:
    def __init__(self, name, *, simulated=False, max_rate=None, min_rate=None):
        self.name = name
        self.product_type = "NI 9234"
        self.ai_physical_chans = []
        self.ci_physical_chans = []
        self.compact_daq_chassis_device = None
        self.compact_daq_slot_num = 0
        self.chassis_module_devices = []
        self.is_simulated = simulated
        if max_rate is not None:
            self.ai_max_multi_chan_rate = max_rate
        if min_rate is not None:
            self.ai_min_rate = min_rate


class _System:
    def __init__(self, devices):
        self.devices = devices


class _BrokenSystem:
    @property
    def devices(self):
        raise OSError("DAQmx driver not loaded")


def test_describe_devices_no_runtime():
    d = nidaq_enum.describe_devices(system=_BrokenSystem())
    assert d["runtime_available"] is False and d["hardware_present"] is False
    assert d["simulated"] is True  # the editable simulated tree is still served


def test_describe_devices_runtime_but_nothing_connected():
    d = nidaq_enum.describe_devices(system=_System([]))
    assert d["runtime_available"] is True and d["hardware_present"] is False


def test_describe_devices_real_and_nimax_simulated_hardware_count_as_present():
    real = nidaq_enum.describe_devices(system=_System([_Dev("Dev1")]))
    assert real["hardware_present"] is True and real["nimax_simulated"] is False
    sim = nidaq_enum.describe_devices(system=_System([_Dev("SimDev1", simulated=True)]))
    assert sim["hardware_present"] is True and sim["nimax_simulated"] is True


def test_nidaq_devices_endpoint_reports_presence(client, tmp_path, monkeypatch):
    monkeypatch.setattr(main, "NIDAQ_SIM_PATH", str(tmp_path / "nidaq_sim.json"))
    monkeypatch.setattr(nidaq_enum, "_local_system", lambda: None)
    d = client.get("/nidaq/devices").json()
    assert d["hardware_present"] is False and d["runtime_available"] is False


def test_sample_rate_limits_reports_floor_and_ceiling():
    sys_ = _System(
        [
            _Dev("M1", max_rate=100_000.0, min_rate=1_000.0),
            _Dev("M2", max_rate=51_367.188, min_rate=1_652.0),
        ]
    )
    lim = nidaq_enum.sample_rate_limits(["M1/ai0", "M2/ai0"], system=sys_)
    assert lim == {"max": 51_367.188, "min": 1_652.0}
    assert nidaq_enum.max_sample_rate(["M1/ai0", "M2/ai0"], system=sys_) == 51_367.188
