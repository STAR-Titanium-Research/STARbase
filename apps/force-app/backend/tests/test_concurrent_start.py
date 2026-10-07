"""Review 1.5: /record/start and /record/start_replay check _busy() and then await (thread pool,
amp round-trip, upload read) before assigning the module-global session. Two overlapping POSTs both
passed the check, both started, and the first session was orphaned (recording, unreachable, never
stopped). The check is now repeated with no await before the assignment."""

import asyncio
import os

import httpx
import pytest

import app.main as main
from app.main import app as fastapi_app
from app.sources.sim import SimSource
from tests.test_replay import _make_cache


def _captures(root) -> list[str]:
    return [d for d in os.listdir(root) if os.path.isdir(os.path.join(root, d))]


def _stop_session():
    s = main._session
    if s is not None:
        s.stop(wait=True, timeout=10)
        s.join_finalize(10)


async def _two(make_request):
    transport = httpx.ASGITransport(app=fastapi_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8200") as c:
        return await asyncio.gather(make_request(c), make_request(c))


def test_two_overlapping_nidaq_starts_only_one_wins(monkeypatch, tmp_path):
    import time

    import app.sources.nidaq as nidaq_mod

    class _FakeNidaqSource(SimSource):
        def __init__(self, cfg, physical_channels=None, extra_channels=None):
            super().__init__(cfg, realtime=True)

    monkeypatch.setattr(nidaq_mod, "nidaq_available", lambda: True)
    monkeypatch.setattr(nidaq_mod, "NidaqSource", _FakeNidaqSource)

    def _slow_limits(_channels):
        time.sleep(0.3)  # the await in /record/start that lets the second POST in
        return {}

    monkeypatch.setattr(main.nidaq_enum, "sample_rate_limits", _slow_limits)
    monkeypatch.setattr(main, "CAPTURES_ROOT", str(tmp_path))
    monkeypatch.setattr(main, "_session", None)
    body = {"source": "nidaq", "sample_rate": 2000, "duration_sec": 5, "dyno_gains": [1.0] * 8}

    async def _post(c):
        return await c.post("/record/start", json=body)

    try:
        results = asyncio.run(_two(_post))
        codes = sorted(r.status_code for r in results)
        assert codes == [200, 409], [r.text for r in results]
        assert len(_captures(tmp_path)) == 1  # no orphaned second session
    finally:
        _stop_session()


def test_two_overlapping_replay_starts_only_one_wins(monkeypatch, tmp_path):
    from starlette.datastructures import UploadFile

    cache, _ = _make_cache(tmp_path)
    root = tmp_path / "captures"
    root.mkdir()
    orig_read = UploadFile.read

    async def _slow_read(self, size=-1):
        await asyncio.sleep(0.2)  # the await in /record/start_replay
        return await orig_read(self, size)

    monkeypatch.setattr(UploadFile, "read", _slow_read)
    monkeypatch.setattr(main, "CAPTURES_ROOT", str(root))
    monkeypatch.setattr(main, "_session", None)

    async def _post(c):
        return await c.post(
            "/record/start_replay",
            files={"file": ("live_cache.bin", cache, "application/octet-stream")},
            data={"sample_name": "R"},
        )

    try:
        results = asyncio.run(_two(_post))
        codes = sorted(r.status_code for r in results)
        assert codes == [200, 409], [r.text for r in results]
        assert len(_captures(root)) == 1
    finally:
        _stop_session()


@pytest.fixture(autouse=True)
def _no_leftover_session(monkeypatch):
    yield
    monkeypatch.setattr(main, "_session", None)
