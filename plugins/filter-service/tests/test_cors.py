"""CORS for the standalone apps: exact origins, with credentials (STARbase sends the Directus session
cookie, ADR-0013; the Force App sends a Bearer token, which credentials do not harm). Never '*'."""

import sys
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app.main as m  # noqa: E402

STAR = "https://starbase.tail54eeb6.ts.net"


def _client(origins: str) -> TestClient:
    app = FastAPI()

    @app.get("/health")
    def health():
        return {"ok": True}

    app.add_middleware(CORSMiddleware, **m.cors_options(origins))
    return TestClient(app)


def test_no_origins_means_no_cors():
    assert m.cors_options("") is None
    assert m.cors_options(" , ") is None


def test_a_wildcard_is_never_allowed():
    assert m.cors_options("*") is None
    assert m.cors_options(f"*,{STAR}")["allow_origins"] == [STAR]


def test_starbase_gets_a_credentialed_preflight():
    r = _client(f"http://localhost:5180,{STAR}").options(
        "/health",
        headers={
            "Origin": STAR,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )
    assert r.status_code == 200
    assert r.headers["access-control-allow-origin"] == STAR
    assert r.headers["access-control-allow-credentials"] == "true"


def test_another_origin_is_refused():
    r = _client(STAR).options(
        "/health",
        headers={
            "Origin": "https://evil.example",
            "Access-Control-Request-Method": "POST",
        },
    )
    assert "access-control-allow-origin" not in r.headers
