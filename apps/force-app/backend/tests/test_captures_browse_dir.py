"""#96: each local capture reports the folder its files are in."""

from __future__ import annotations

import os

from fastapi.testclient import TestClient

from app import main
from app.main import app


def test_browse_reports_each_captures_absolute_folder(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "CAPTURES_ROOT", str(tmp_path))
    monkeypatch.setattr(main, "_session", None)
    os.makedirs(tmp_path / "20261002-100000-abc")
    with TestClient(app) as c:
        (entry,) = c.get("/captures/browse").json()["captures"]

    assert entry["dir"] == str(tmp_path / "20261002-100000-abc")
    assert os.path.isabs(entry["dir"])
