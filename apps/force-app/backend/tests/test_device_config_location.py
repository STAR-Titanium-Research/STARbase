"""labamp.json, nidaq_sim.json and nidaq_channels.json live in the config dir, not the captures
folder, so moving the recording folder (#101) keeps the operator's channel and gain assignment."""

from __future__ import annotations

import json
import os
import subprocess
import sys

import pytest
from fastapi.testclient import TestClient

from app import channels as chan
from app import main
from app.main import app


def _custom_channels() -> list[dict]:
    return [chan.make_channel("Probe", "Aux", physical="cDAQ1Mod3/ai5")]


@pytest.fixture
def roots(tmp_path, monkeypatch):
    old_root = tmp_path / "old-captures"
    old_root.mkdir()
    monkeypatch.setattr(main, "CAPTURES_ROOT", str(old_root))
    monkeypatch.setattr(main, "STORAGE_CONFIG_PATH", str(tmp_path / "cfg" / "storage_config.json"))
    monkeypatch.setattr(main, "_session", None)
    return old_root


def test_default_paths_are_under_the_config_dir_not_the_captures_folder(tmp_path):
    env = {
        **os.environ,
        "FORCE_APP_CONFIG_DIR": str(tmp_path / "cfgdir"),
        "FORCE_APP_CAPTURES": str(tmp_path / "caps"),
        "FORCE_APP_LOG_DIR": str(tmp_path / "logs"),
    }
    code = (
        "import app.main as m;"
        "print(m.LABAMP_CONFIG_PATH);print(m.NIDAQ_SIM_PATH);print(m.NIDAQ_CHANNELS_PATH)"
    )
    out = subprocess.run(
        [sys.executable, "-c", code],
        env=env,
        capture_output=True,
        text=True,
        check=True,
        cwd=os.path.dirname(os.path.dirname(__file__)),
    ).stdout.split()
    assert out == [
        str(tmp_path / "cfgdir" / "labamp.json"),
        str(tmp_path / "cfgdir" / "nidaq_sim.json"),
        str(tmp_path / "cfgdir" / "nidaq_channels.json"),
    ]


def test_channel_config_migrates_from_the_captures_folder_and_keeps_the_old_file(roots):
    old = roots / "nidaq_channels.json"
    old.write_text(json.dumps({"channels": _custom_channels()}))
    assert not os.path.exists(main.NIDAQ_CHANNELS_PATH)

    main._migrate_device_configs()
    got = main._channel_config()

    assert [c["name"] for c in got] == ["Probe"]  # NOT re-autoassigned
    with open(main.NIDAQ_CHANNELS_PATH) as f:
        assert json.load(f)["channels"][0]["name"] == "Probe"
    assert old.exists()  # never deleted


def test_sim_layout_migrates_from_the_captures_folder(roots):
    layout = {"chassis": [{"name": "cDAQ9", "slots": 4, "modules": []}]}
    (roots / "nidaq_sim.json").write_text(json.dumps(layout))

    main._migrate_device_configs()

    assert main._sim_layout() == layout
    assert os.path.exists(main.NIDAQ_SIM_PATH)
    assert (roots / "nidaq_sim.json").exists()


def test_labamp_config_migrates_from_the_captures_folder(roots):
    (roots / "labamp.json").write_text(json.dumps({"base_url": "http://10.0.0.9", "channels": 4}))

    main._migrate_device_configs()
    cfg = main._load_labamp_config()

    assert cfg["base_url"] == "http://10.0.0.9" and cfg["channels"] == 4
    with open(main.LABAMP_CONFIG_PATH) as f:
        assert json.load(f)["base_url"] == "http://10.0.0.9"
    assert (roots / "labamp.json").exists()


def test_the_new_file_wins_over_an_old_one(roots):
    (roots / "nidaq_channels.json").write_text(json.dumps({"channels": _custom_channels()}))
    newer = [chan.make_channel("Newer", "Aux", physical="cDAQ1Mod3/ai6")]
    with open(main.NIDAQ_CHANNELS_PATH, "w") as f:
        json.dump({"channels": newer}, f)

    main._migrate_device_configs()

    assert [c["name"] for c in main._channel_config()] == ["Newer"]


def test_an_unreadable_new_file_is_not_overwritten_by_the_old_one(roots):
    (roots / "nidaq_channels.json").write_text(json.dumps({"channels": _custom_channels()}))
    with open(main.NIDAQ_CHANNELS_PATH, "w") as f:
        f.write("{not json")

    main._migrate_device_configs()

    with open(main.NIDAQ_CHANNELS_PATH) as f:
        assert f.read() == "{not json"


def test_legacy_package_captures_dir_is_a_migration_source_too(roots):
    os.makedirs(main.LEGACY_CONFIG_DIR)
    with open(os.path.join(main.LEGACY_CONFIG_DIR, "nidaq_channels.json"), "w") as f:
        json.dump({"channels": _custom_channels()}, f)

    main._migrate_device_configs()

    assert [c["name"] for c in main._channel_config()] == ["Probe"]


def test_switching_the_captures_folder_keeps_the_channel_config(roots, tmp_path):
    with TestClient(app) as client:
        assert (
            client.put("/nidaq/channels", json={"channels": _custom_channels()}).status_code == 200
        )
        new_root = tmp_path / "new-drive" / "captures"

        res = client.post("/storage/config", json={"captures_root": str(new_root)})
        assert res.status_code == 200 and main.CAPTURES_ROOT == str(new_root)

        got = client.get("/nidaq/channels").json()["channels"]
        assert [c["name"] for c in got] == ["Probe"]  # still the operator's, not autoassigned
        # And nothing was written into either captures folder.
        assert not (roots / "nidaq_channels.json").exists()
        assert not (new_root / "nidaq_channels.json").exists()


def test_a_labamp_config_in_a_newly_chosen_folder_is_not_adopted(roots, tmp_path):
    # Migration is a one-time startup step from the INITIAL root; a stale labamp.json sitting in a
    # folder the operator picks later must not be pulled in on the next read.
    main._migrate_device_configs()
    with TestClient(app) as client:
        new_root = tmp_path / "new-drive" / "captures"
        new_root.mkdir(parents=True)
        (new_root / "labamp.json").write_text(
            json.dumps({"base_url": "http://stale", "channels": 2})
        )

        res = client.post("/storage/config", json={"captures_root": str(new_root)})
        assert res.status_code == 200 and main.CAPTURES_ROOT == str(new_root)

        cfg = main._load_labamp_config()
        assert cfg["base_url"] != "http://stale"
        assert not os.path.exists(main.LABAMP_CONFIG_PATH)
