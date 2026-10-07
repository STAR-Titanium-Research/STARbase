"""Shared test fixtures.

The important one here is `isolate_backup_config`: without it, running the suite rewrites the
developer's real backup settings. `backup.BACKUP_CONFIG_PATH` is deliberately an absolute,
drive-independent path in production (so the settings survive changing the recording drive), which
means monkeypatching `main.CAPTURES_ROOT` — what most tests do to sandbox themselves — no longer
redirects it. Tests that POST to /backup/config would then write the installed config for real, and
later tests reading it would see that leftover state instead of the defaults they assert on.
"""

import os
import tempfile

# `app.main` reads its state at import: it migrates and loads labamp.json and resolves the captures,
# config and log dirs. The fixtures below run too late to redirect that, so a developer's real
# config (e.g. a labamp.json with a different channel count) would leak into every test. Point all
# of it at a throwaway dir before the import.
_STATE = tempfile.mkdtemp(prefix="force-app-tests-")
for _var, _sub in (
    ("FORCE_APP_CONFIG_DIR", "config"),
    ("FORCE_APP_CAPTURES", "captures"),
    ("FORCE_APP_LOG_DIR", "logs"),
    ("XDG_STATE_HOME", "xdg-state"),
    ("LOCALAPPDATA", "localappdata"),
):
    os.environ[_var] = os.path.join(_STATE, _sub)
# The Host/Origin guard (app/origin_guard.py) only admits loopback names; Starlette's TestClient
# sends `Host: testserver`. Tests of the guard itself talk to 127.0.0.1 and clear this.
os.environ["RECORDER_ALLOWED_HOSTS"] = "testserver"

import pytest  # noqa: E402

from app import backup as backup_mod  # noqa: E402
from app import main as main_mod  # noqa: E402


@pytest.fixture(autouse=True)
def isolate_backup_config(tmp_path_factory, monkeypatch):
    """Point the backup config at a per-test temp file, for every test in the suite.

    Autouse and unconditional on purpose: this guards a real file outside the repo tree, so it must
    not depend on individual tests remembering to opt in.
    """
    path = tmp_path_factory.mktemp("backup-config") / "backup_config.json"
    monkeypatch.setattr(backup_mod, "BACKUP_CONFIG_PATH", str(path))
    return path


@pytest.fixture(autouse=True)
def isolate_device_config(tmp_path_factory, monkeypatch):
    """Point labamp.json / nidaq_*.json (and their migration sources) at a per-test temp dir.

    Like the backup config, these live in the per-user config dir rather than under the captures
    folder, so monkeypatching `main.CAPTURES_ROOT` no longer sandboxes them.
    """
    d = tmp_path_factory.mktemp("device-config")
    monkeypatch.setattr(main_mod, "LABAMP_CONFIG_PATH", str(d / "labamp.json"))
    monkeypatch.setattr(main_mod, "NIDAQ_SIM_PATH", str(d / "nidaq_sim.json"))
    monkeypatch.setattr(main_mod, "NIDAQ_CHANNELS_PATH", str(d / "nidaq_channels.json"))
    monkeypatch.setattr(main_mod, "LEGACY_CONFIG_DIR", str(d / "legacy-captures"))
    return d
