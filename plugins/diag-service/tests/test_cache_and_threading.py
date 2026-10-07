"""Cache invalidation on rebake (6.7) and off-event-loop compute (6.8).

A rebake rewrites base.d1an / full.d1an at the SAME path. The LRUs used to be keyed on
diag_path only, so the old bytes kept being served until the container restarted.
"""

from __future__ import annotations

import os
import sys
import threading

import numpy as np
import pytest

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
for _p in (
    os.path.join(_REPO, "scripts"),
    os.path.join(_REPO, "plugins", "diag-service"),
):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from diag.d1an import read_d1an, write_d1an  # noqa: E402
from diag.recipe import DEFAULT_RECIPE  # noqa: E402

from tests.test_preview import _write_base_d1an  # noqa: E402

PREVIEW = {"analysis_id": "a1", "recipe": DEFAULT_RECIPE, "layers": None}
VIEWPORT = {
    "analysis_id": "a1",
    "bbox": [-40, -40, 40, 40],
    "step": {"op": "getis_ord", "params": {"k": 20}},
}


@pytest.fixture
def env(tmp_path, monkeypatch):
    base_dir = tmp_path / "octrees" / "diag" / "op-under-test"
    (base_dir / "full").mkdir(parents=True)
    _write_base_d1an(str(base_dir / "base.d1an"))
    rng = np.random.default_rng(0)
    n = 5_000
    write_d1an(
        str(base_dir / "full" / "full.d1an"),
        {
            "x": rng.uniform(-40, 40, n).astype(np.float32),
            "y": rng.uniform(-40, 40, n).astype(np.float32),
            "resid_z": rng.normal(0, 1, n).astype(np.float32),
        },
    )
    monkeypatch.setenv("OCTREE_ROOT", str(tmp_path / "octrees"))

    import app.main as m

    for lru in (m._base_lru, m._result_lru, m._full_lru, m._viewport_lru):
        lru.clear()

    async def _allow(analysis_id, req):
        return {"diag_path": "op-under-test", "diag_status": "done"}

    monkeypatch.setattr(m, "_resolve_and_authorize", _allow)

    from fastapi.testclient import TestClient

    return TestClient(m.app), base_dir, m


def _bump_mtime(path, seconds=10):
    st = os.stat(path)
    os.utime(path, ns=(st.st_atime_ns, st.st_mtime_ns + seconds * 1_000_000_000))


def test_preview_cache_invalidated_by_rebake_mtime(env):
    client, base_dir, _ = env
    base = str(base_dir / "base.d1an")
    first = client.post("/preview", json=PREVIEW)
    assert first.headers["x-diag-cache"] == "miss"
    assert client.post("/preview", json=PREVIEW).headers["x-diag-cache"] == "hit"

    cols = read_d1an(base)
    cols["sig_fp"] = np.asarray(cols["sig_fp"]) * 3.0
    write_d1an(base, cols)
    _bump_mtime(base)

    after = client.post("/preview", json=PREVIEW)
    assert after.status_code == 200
    assert after.headers["x-diag-cache"] == "miss"
    assert after.content != first.content  # computed from the rebaked data
    # and the new result is cached in turn
    assert client.post("/preview", json=PREVIEW).headers["x-diag-cache"] == "hit"


def test_preview_cache_invalidated_by_size_change_alone(env):
    client, base_dir, _ = env
    base = str(base_dir / "base.d1an")
    first = client.post("/preview", json=PREVIEW)
    st = os.stat(base)

    cols = read_d1an(base)
    cols["sig_fp"] = np.asarray(cols["sig_fp"]) * 3.0
    cols["extra"] = np.zeros(len(cols["t"]))  # file grows
    write_d1an(base, cols)
    os.utime(base, ns=(st.st_atime_ns, st.st_mtime_ns))  # same mtime as before

    after = client.post("/preview", json=PREVIEW)
    assert after.headers["x-diag-cache"] == "miss"
    assert after.content != first.content


def test_base_lru_reloads_when_file_changes(env):
    _, base_dir, m = env
    base = str(base_dir / "base.d1an")
    sig1 = m._file_sig(base)
    c1 = m._load_base("op-under-test", sig1)
    assert m._load_base("op-under-test", sig1) is c1  # served from cache

    cols = read_d1an(base)
    cols["sig_fp"] = np.asarray(cols["sig_fp"]) * 2.0
    write_d1an(base, cols)
    _bump_mtime(base)
    sig2 = m._file_sig(base)
    assert sig2 != sig1
    c2 = m._load_base("op-under-test", sig2)
    assert c2 is not c1
    assert len(m._base_lru) == 1  # replaced, not accumulated


def test_viewport_cache_invalidated_by_rebake(env):
    client, base_dir, _ = env
    full = str(base_dir / "full" / "full.d1an")
    first = client.post("/viewport", json=VIEWPORT)
    assert first.status_code == 200, first.text
    assert first.headers["x-diag-cache"] == "miss"
    assert client.post("/viewport", json=VIEWPORT).headers["x-diag-cache"] == "hit"

    cols = read_d1an(full)
    cols["resid_z"] = np.asarray(cols["resid_z"]) + 9.0 * (np.asarray(cols["x"]) > 0)
    write_d1an(full, cols)
    _bump_mtime(full)

    after = client.post("/viewport", json=VIEWPORT)
    assert after.headers["x-diag-cache"] == "miss"
    assert after.content != first.content


def test_compute_runs_off_the_event_loop(env, monkeypatch):
    """The recipe runs in a worker thread, not on the loop thread that serves /health."""
    client, _, m = env
    seen: dict[str, int] = {}

    async def _allow(analysis_id, req):
        seen["loop"] = threading.get_ident()
        return {"diag_path": "op-under-test", "diag_status": "done"}

    real = m.run_recipe

    def spy(*a, **k):
        seen["compute"] = threading.get_ident()
        return real(*a, **k)

    monkeypatch.setattr(m, "_resolve_and_authorize", _allow)
    monkeypatch.setattr(m, "run_recipe", spy)
    assert client.post("/preview", json=PREVIEW).status_code == 200
    assert seen["compute"] != seen["loop"]
    assert seen["compute"] != threading.get_ident()


def test_concurrent_requests_share_the_lru_safely(env):
    """Hammer the LRUs from several threads; no exception, caps respected."""
    _, _, m = env
    errors: list[BaseException] = []

    def work(i):
        try:
            for j in range(200):
                m._lru_put(m._result_lru, (i, j % 40), b"x", 8)
                m._lru_get(m._result_lru, (i, (j + 3) % 40))
        except BaseException as e:  # noqa: BLE001
            errors.append(e)

    threads = [threading.Thread(target=work, args=(i,)) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert not errors
    assert len(m._result_lru) <= 8
