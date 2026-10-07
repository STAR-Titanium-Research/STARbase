"""Review 1.3: the recorder API has no auth, so loopback binding is the only mitigation. Neither
the autostart script nor the Doctor's suggested fix may tell anyone to bind all interfaces."""

import pathlib

from fastapi.testclient import TestClient

import app.main as main
from app.main import app as fastapi_app

SCRIPTS = pathlib.Path(__file__).resolve().parents[1] / "scripts"


def test_autostart_script_binds_loopback_only():
    text = (SCRIPTS / "start_recorder.ps1").read_text(encoding="utf-8")
    assert "0.0.0.0" not in text
    assert '"--host", "127.0.0.1"' in text


def test_doctor_fix_command_binds_loopback_only(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "CAPTURES_ROOT", str(tmp_path))
    monkeypatch.delenv("DIRECTUS_URL", raising=False)
    with TestClient(fastapi_app) as client:
        r = client.post("/health/doctor", json={})
        assert r.status_code == 200, r.text
        f = next(x for x in r.json()["findings"] if x["service"] == "Directus")
        assert "--host 127.0.0.1" in f["fix_command"]
        assert "0.0.0.0" not in f["fix_command"]
