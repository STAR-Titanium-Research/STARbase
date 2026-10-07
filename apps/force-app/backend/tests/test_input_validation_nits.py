"""Stream-1 review nits: /labamp/config validates channels and mode; the Doctor guards a
client-supplied directus_url like the filter/octree URLs."""

import pytest
from fastapi.testclient import TestClient

import app.main as main
from app.main import app as fastapi_app


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setattr(main, "CAPTURES_ROOT", str(tmp_path))
    monkeypatch.setattr(main, "_session", None)
    with TestClient(fastapi_app) as c:
        yield c


@pytest.mark.parametrize("channels", [0, -1, 65, "8", "abc", 8.5, None, True, [8], {"n": 8}])
def test_labamp_config_rejects_bad_channels(client, channels):
    before = dict(main._labamp_cfg)
    r = client.post("/labamp/config", json={"channels": channels})
    assert r.status_code == 400, r.text
    assert main._labamp_cfg == before  # nothing persisted


@pytest.mark.parametrize("mode", ["MOCK", "demo", "", None, 1, ["real"]])
def test_labamp_config_rejects_bad_mode(client, mode):
    before = dict(main._labamp_cfg)
    r = client.post("/labamp/config", json={"mode": mode})
    assert r.status_code == 400, r.text
    assert main._labamp_cfg == before


def test_labamp_config_a_bad_field_saves_none_of_the_request(client):
    before = dict(main._labamp_cfg)
    r = client.post("/labamp/config", json={"channels": 4, "mode": "bogus"})
    assert r.status_code == 400
    assert main._labamp_cfg == before


def test_labamp_config_accepts_valid_values(client):
    r = client.post("/labamp/config", json={"channels": 4, "mode": "mock"})
    assert r.status_code == 200
    assert r.json()["channels"] == 4 and r.json()["mode"] == "mock"
    r = client.post("/labamp/config", json={"channels": 8})
    assert r.status_code == 200


@pytest.mark.parametrize(
    "url", ["http://169.254.169.254/latest/meta-data", "file:///etc/passwd", "ftp://x/", "http://"]
)
def test_doctor_does_not_probe_a_disallowed_directus_url(client, url):
    r = client.post("/health/doctor", json={"directus_url": url})
    assert r.status_code == 200, r.text
    f = next(x for x in r.json()["findings"] if x["service"] == "Directus")
    assert f["status"] == "fail"
    assert "invalid or not allowed" in f["diagnosis"]


# ---- analog_fullscale_v: validated on save, tolerated on read ---------------------------------


@pytest.mark.parametrize("v", [0, -5, -0.1, "10", "abc", None, True, False, [10], {"v": 10}])
def test_labamp_config_rejects_bad_analog_fullscale(client, v):
    before = dict(main._labamp_cfg)
    r = client.post("/labamp/config", json={"analog_fullscale_v": v})
    assert r.status_code == 422, r.text
    assert main._labamp_cfg == before  # nothing persisted


@pytest.mark.parametrize("raw", ["NaN", "Infinity", "-Infinity", "1e999"])
def test_labamp_config_rejects_non_finite_analog_fullscale(client, raw):
    before = dict(main._labamp_cfg)
    r = client.post(
        "/labamp/config",
        content=f'{{"analog_fullscale_v": {raw}}}',
        headers={"content-type": "application/json"},
    )
    assert r.status_code == 422, r.text
    assert main._labamp_cfg == before


def test_labamp_config_accepts_a_positive_analog_fullscale(client):
    before = main._labamp_cfg.get("analog_fullscale_v")
    try:
        for v in (5, 2.5, 10.0):
            r = client.post("/labamp/config", json={"analog_fullscale_v": v})
            assert r.status_code == 200, r.text
            assert r.json()["analog_fullscale_v"] == v
    finally:
        client.post("/labamp/config", json={"analog_fullscale_v": before})


@pytest.mark.parametrize("bad", ["abc", None, 0, -3, float("nan"), float("inf"), [5], True])
def test_nidaq_start_falls_back_when_the_stored_analog_fullscale_is_invalid(
    client, monkeypatch, bad, caplog
):
    import logging

    import app.sources.nidaq as nidaq_mod

    seen = {}

    class _Src:
        def __init__(self, cfg, **_kw):
            seen["vfs"] = cfg.analog_fullscale_v
            raise ValueError("stop here")  # past the full-scale lookup; no hardware needed

    monkeypatch.setattr(nidaq_mod, "nidaq_available", lambda: True)
    monkeypatch.setattr(nidaq_mod, "NidaqSource", _Src)
    monkeypatch.setattr(main, "_channel_config", lambda: [])
    monkeypatch.setattr(main.nidaq_enum, "sample_rate_limits", lambda _c: {})
    monkeypatch.setitem(main._labamp_cfg, "analog_fullscale_v", bad)
    with caplog.at_level(logging.WARNING, logger="force_app.main"):
        r = client.post(
            "/record/start", json={"source": "nidaq", "sample_rate": 1000, "dyno_gains": [1]}
        )
    assert r.status_code == 400 and r.json()["detail"] == "stop here"  # not a 500
    assert seen["vfs"] == 10.0  # the default
    assert "analog_fullscale_v" in caplog.text


def test_a_valid_stored_analog_fullscale_is_used_as_is(monkeypatch):
    monkeypatch.setitem(main._labamp_cfg, "analog_fullscale_v", 5.0)
    assert main._analog_fullscale_v() == 5.0
    monkeypatch.setitem(main._labamp_cfg, "analog_fullscale_v", "2.5")  # an older hand-edit
    assert main._analog_fullscale_v() == 2.5
