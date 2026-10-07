"""analysis_id is interpolated into a Directus URL path: only UUIDs may reach it."""

from __future__ import annotations

import asyncio
import os
import sys
from types import SimpleNamespace

import httpx
import pytest

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
for _p in (
    os.path.join(_REPO, "scripts"),
    os.path.join(_REPO, "plugins", "diag-service"),
):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from fastapi import HTTPException  # noqa: E402

import app.main as m  # noqa: E402

GOOD_ID = "3f2b8c1e-7a44-4f0e-9d0b-0a1b2c3d4e5f"


class _FakeAsyncClient:
    urls: list[str] = []

    def __init__(self, *a, **k):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def get(self, url, **k):
        type(self).urls.append(url)
        return httpx.Response(
            200, json={"data": {"diag_path": "p", "diag_status": "done"}}
        )


REQ = SimpleNamespace(headers={})


@pytest.mark.parametrize(
    "bad", ["../users/me", "x?fields=*", "a1", "../../items/x", "a/b", "%2e%2e", ""]
)
def test_non_uuid_analysis_id_is_422_and_never_reaches_directus(monkeypatch, bad):
    _FakeAsyncClient.urls = []
    monkeypatch.setattr(m.httpx, "AsyncClient", _FakeAsyncClient)
    with pytest.raises(HTTPException) as e:
        asyncio.run(m._resolve_and_authorize(bad, REQ))
    assert e.value.status_code == 422
    assert _FakeAsyncClient.urls == []


def test_uuid_analysis_id_builds_the_canonical_url(monkeypatch):
    _FakeAsyncClient.urls = []
    monkeypatch.setattr(m.httpx, "AsyncClient", _FakeAsyncClient)
    row = asyncio.run(m._resolve_and_authorize(GOOD_ID.upper(), REQ))
    assert row["diag_status"] == "done"
    assert _FakeAsyncClient.urls == [
        f"{m.DIRECTUS_URL}/items/machining_force_analysis/{GOOD_ID}"
    ]
