"""Invariant 3 (review 1.4): NI-DAQ state must not change mid-recording. The tacho generator drives
PFI0, the tacho input of the channel being sampled, and the channel list / simulated chassis feed
the live source and the next start -- so every write endpoint is refused with 409 while a recording
is recording or finalizing. Same shape as test_labamp_busy_guard.py."""

import pytest
from fastapi.testclient import TestClient

import app.main as main
from app import channels as chan
from app.main import app as fastapi_app


class _StubSession:
    id = "20260101-000000-abc123"

    def __init__(self, state="recording"):
        self.state = state


WRITES = [
    ("post", "/nidaq/tacho/start", {"json": {"freq_hz": 20}}),
    ("post", "/nidaq/tacho/stop", {}),
    ("post", "/nidaq/sim/card", {"json": {"slot": 3, "product_type": "NI 9215"}}),
    ("delete", "/nidaq/sim/card?slot=3", {}),
    ("put", "/nidaq/channels", {"json": {"channels": []}}),
    ("post", "/nidaq/channels/autoassign", {}),
]


@pytest.mark.parametrize("state", ["recording", "finalizing"])
@pytest.mark.parametrize("method,url,kw", WRITES)
def test_nidaq_writes_refused_while_busy(monkeypatch, tmp_path, state, method, url, kw):
    monkeypatch.setattr(main, "CAPTURES_ROOT", str(tmp_path))
    monkeypatch.setattr(main, "_session", _StubSession(state))
    with TestClient(fastapi_app) as client:
        before = client.get("/nidaq/channels").json()
        r = getattr(client, method)(url, **kw)
        assert r.status_code == 409, r.text
        assert "recording is in progress" in r.json()["detail"]
        # nothing was changed
        assert client.get("/nidaq/channels").json() == before


@pytest.mark.parametrize("method,url,kw", WRITES)
def test_nidaq_writes_allowed_when_idle(monkeypatch, tmp_path, method, url, kw):
    monkeypatch.setattr(main, "CAPTURES_ROOT", str(tmp_path))
    monkeypatch.setattr(main, "_session", None)
    with TestClient(fastapi_app) as client:
        r = getattr(client, method)(url, **kw)
        assert r.status_code != 409, r.text


def test_tacho_status_and_reads_stay_available_while_recording(monkeypatch, tmp_path):
    monkeypatch.setattr(main, "CAPTURES_ROOT", str(tmp_path))
    monkeypatch.setattr(main, "_session", _StubSession())
    with TestClient(fastapi_app) as client:
        assert client.get("/nidaq/tacho/status").status_code == 200
        assert client.get("/nidaq/channels").status_code == 200
        assert client.get("/nidaq/devices").status_code == 200
        r = client.post("/nidaq/channels/validate-formula", json={"formula": "Fx + 1"})
        assert r.status_code == 200 and r.json()["valid"] is True


def test_put_channels_does_not_overwrite_the_saved_file_while_busy(monkeypatch, tmp_path):
    path = tmp_path / "nidaq_channels.json"
    monkeypatch.setattr(main, "NIDAQ_CHANNELS_PATH", str(path))
    with TestClient(fastapi_app) as client:
        good = {"channels": [chan.make_channel("Fx1", "Fx", physical="cDAQ1Mod1/ai0")]}
        assert client.put("/nidaq/channels", json=good).status_code == 200
        saved = path.read_text()
        monkeypatch.setattr(main, "_session", _StubSession())
        assert client.put("/nidaq/channels", json={"channels": []}).status_code == 409
        assert path.read_text() == saved
