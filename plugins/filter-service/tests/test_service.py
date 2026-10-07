"""filter-service HTTP behaviour: despike cap (6.8), compute off the event loop, id validation."""

import asyncio
import sys
import threading
import time
from pathlib import Path

import httpx
import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app.main as m  # noqa: E402
from app import filters  # noqa: E402
from app.d1lc import Cache  # noqa: E402
from app.filters import ChainError, apply_chain  # noqa: E402

FS = 25600.0


def make_cache(n=4096, fs=FS):
    t = (np.arange(n) / fs).astype(np.float32)
    rng = np.random.default_rng(1)
    z = np.zeros(n, np.float32)
    return Cache(
        fs,
        0.1,
        10.0,
        0.0,
        float(t[-1]),
        t,
        rng.standard_normal(n).astype(np.float32),
        z.copy(),
        rng.standard_normal(n).astype(np.float32),
        np.full(n, 1500.0, np.float32),
        np.arange(n, dtype=np.float32) / 100,
    )


@pytest.fixture
def client(monkeypatch):
    from fastapi.testclient import TestClient

    cache = make_cache()

    async def fake_get_cache(file_id, req):
        return cache

    monkeypatch.setattr(m, "_get_cache", fake_get_cache)
    return TestClient(m.app)


# --- despike.window cap -------------------------------------------------------


def test_default_window_cap_is_1001():
    assert filters.MAX_DESPIKE_WINDOW == 1001


def test_window_at_cap_is_accepted():
    x = np.random.default_rng(0).standard_normal(3000)
    out, _ = apply_chain(
        {"Fz": x}, FS, 1500, {"despike": {"on": True, "window": 1001, "sigma": 5}}
    )
    assert out["Fz"].shape == x.shape


@pytest.mark.parametrize("window", [1003, 2001, 100_001])
def test_window_over_cap_is_rejected(window):
    x = np.zeros(3000)
    with pytest.raises(ChainError, match="<= 1001"):
        apply_chain(
            {"Fz": x}, FS, 1500, {"despike": {"on": True, "window": window, "sigma": 5}}
        )


@pytest.mark.parametrize("endpoint", ["/run", "/fft", "/spectrogram"])
def test_huge_window_is_422_over_http(client, endpoint):
    chain = {"despike": {"on": True, "window": 2001, "sigma": 5}}
    r = client.post(endpoint, json={"cache_file_id": "f", "chain": chain})
    assert r.status_code == 422
    assert "despike.window" in r.json()["detail"]


def test_disabled_despike_window_is_not_validated():
    x = np.zeros(100)
    apply_chain(
        {"Fz": x}, FS, 1500, {"despike": {"on": False, "window": 99999, "sigma": 5}}
    )


def test_work_cap_rejects_wide_window_on_huge_input(monkeypatch):
    monkeypatch.setattr(filters, "MAX_DESPIKE_WORK", 10_000)
    x = np.zeros(5000)
    chain = {"despike": {"on": True, "window": 11, "sigma": 5}}
    with pytest.raises(ChainError, match="too large"):
        apply_chain({"Fz": x}, FS, 1500, chain)


def _hampel_reference(x, window, sigma):
    """The original un-chunked implementation."""
    n = x.size
    half = window // 2
    sw = np.lib.stride_tricks.sliding_window_view(x, window)
    med = np.median(sw, axis=1)
    mad = np.median(np.abs(sw - med[:, None]), axis=1)
    thr = sigma * 1.4826 * mad
    centre = x[half : n - half]
    out = x.copy()
    bad = np.abs(centre - med) > thr
    out[half : n - half] = np.where(bad, med, centre)
    return out


@pytest.mark.parametrize("block_elems", [11, 100, 1_000, 10**9])
def test_chunked_hampel_matches_reference(monkeypatch, block_elems):
    monkeypatch.setattr(filters, "_HAMPEL_BLOCK_ELEMS", block_elems)
    rng = np.random.default_rng(5)
    x = rng.standard_normal(1234)
    x[rng.choice(1234, 20, replace=False)] += 25
    np.testing.assert_array_equal(
        filters._hampel(x, 11, 5.0), _hampel_reference(x, 11, 5.0)
    )


# --- event loop ---------------------------------------------------------------


def test_compute_runs_off_the_event_loop(monkeypatch):
    seen = {}
    cache = make_cache()

    async def fake_get_cache(file_id, req):
        seen["loop"] = threading.get_ident()
        return cache

    real = m._filtered

    def spy(c, chain):
        seen["compute"] = threading.get_ident()
        return real(c, chain)

    monkeypatch.setattr(m, "_get_cache", fake_get_cache)
    monkeypatch.setattr(m, "_filtered", spy)
    from fastapi.testclient import TestClient

    r = TestClient(m.app).post("/run", json={"cache_file_id": "f", "chain": {}})
    assert r.status_code == 200
    assert seen["compute"] != seen["loop"]


def test_health_answers_while_a_slow_filter_runs(monkeypatch):
    cache = make_cache()

    async def fake_get_cache(file_id, req):
        return cache

    def slow(c, chain):
        time.sleep(0.8)  # a CPU-heavy chain
        return c, []

    monkeypatch.setattr(m, "_get_cache", fake_get_cache)
    monkeypatch.setattr(m, "_filtered", slow)

    async def scenario():
        transport = httpx.ASGITransport(app=m.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as cl:
            run = asyncio.create_task(
                cl.post("/run", json={"cache_file_id": "f", "chain": {}})
            )
            await asyncio.sleep(0.15)
            t0 = time.perf_counter()
            h = await cl.get("/health")
            health_s = time.perf_counter() - t0
            r = await run
            return h.status_code, health_s, r.status_code

    health_status, health_s, run_status = asyncio.run(scenario())
    assert (health_status, run_status) == (200, 200)
    assert health_s < 0.4  # would be ~0.65 s if the loop were blocked


def test_lru_is_thread_safe(monkeypatch):
    monkeypatch.setattr(m, "LRU_CAP", 4)
    m._lru.clear()
    errors = []

    def work(i):
        try:
            for j in range(300):
                m._lru_put(f"{i}-{j % 9}", make_cache(8))
                m._lru_get(f"{i}-{(j + 1) % 9}")
        except BaseException as e:  # noqa: BLE001
            errors.append(e)

    ts = [threading.Thread(target=work, args=(i,)) for i in range(8)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    assert not errors
    assert len(m._lru) <= 4


# --- id validation ------------------------------------------------------------

GOOD_ID = "3f2b8c1e-7a44-4f0e-9d0b-0a1b2c3d4e5f"


class _FakeAsyncClient:
    """Stands in for httpx.AsyncClient; records every URL it is asked for."""

    urls: list[str] = []

    def __init__(self, *a, **k):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def get(self, url, **k):
        type(self).urls.append(url)
        return httpx.Response(404)

    async def head(self, url, **k):
        type(self).urls.append(url)
        return httpx.Response(404)


@pytest.mark.parametrize(
    "bad", ["../users/me", "x?fields=*", "abc", "../../items/x", "a/b", "%2e%2e"]
)
def test_non_uuid_cache_file_id_is_422_and_never_reaches_directus(monkeypatch, bad):
    from fastapi.testclient import TestClient

    _FakeAsyncClient.urls = []
    m._lru.clear()
    monkeypatch.setattr(m.httpx, "AsyncClient", _FakeAsyncClient)
    r = TestClient(m.app).post("/run", json={"cache_file_id": bad, "chain": {}})
    assert r.status_code == 422
    assert _FakeAsyncClient.urls == []


def test_uuid_cache_file_id_builds_the_canonical_url(monkeypatch):
    from fastapi.testclient import TestClient

    _FakeAsyncClient.urls = []
    m._lru.clear()
    monkeypatch.setattr(m.httpx, "AsyncClient", _FakeAsyncClient)
    r = TestClient(m.app).post(
        "/run", json={"cache_file_id": GOOD_ID.upper(), "chain": {}}
    )
    assert r.status_code == 404  # Directus (fake) said so; the id was accepted
    assert _FakeAsyncClient.urls == [f"{m.DIRECTUS_URL}/assets/{GOOD_ID}"]


def test_fft_overlay_is_rms_amplitude_in_newtons():
    """/fft must read in the same unit as the main spectrum (sqrt of MATLAB pspectrum power = N rms),
    not the N/sqrt(Hz) of a welch density: a sine of amplitude A peaks at A/sqrt(2)."""
    amp, f0, n = (
        50.0,
        1000.0,
        1 << 14,
    )  # 1000 Hz sits exactly on a bin (25600/16384 Hz apart)
    t = np.arange(n) / FS
    z = np.zeros(n, np.float32)
    c = Cache(
        FS,
        0.1,
        10.0,
        0.0,
        float(t[-1]),
        t.astype(np.float32),
        z.copy(),
        z.copy(),
        (amp * np.sin(2 * np.pi * f0 * t)).astype(np.float32),
        np.full(n, 1500.0, np.float32),
        np.arange(n, dtype=np.float32) / 100,
    )
    out = m._fft_compute(c, {}, "Fz")
    peak = int(np.argmax(out["amp"]))
    assert out["f"][peak] == pytest.approx(f0, abs=2.0)
    assert out["amp"][peak] == pytest.approx(amp / np.sqrt(2), rel=0.02)
