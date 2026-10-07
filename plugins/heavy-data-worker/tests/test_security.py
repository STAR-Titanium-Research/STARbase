"""check_secret fails closed: no configured secret means no non-health request."""

from unittest.mock import MagicMock, patch

import pytest

from app.webhook import app

BODY = {"key": "sess-1", "payload": {"file_storage_pointer": "a/b.d1f"}}


@pytest.fixture
def client():
    return app.test_client()


@pytest.mark.parametrize("value", [None, ""])
def test_unset_or_empty_secret_rejects_everything_but_health(
    client, monkeypatch, value
):
    if value is None:
        monkeypatch.delenv("WORKER_WEBHOOK_SECRET", raising=False)
    else:
        monkeypatch.setenv("WORKER_WEBHOOK_SECRET", value)
    # Even a request that sends an empty header must not slip through.
    r = client.post("/api/webhook/session", json=BODY, headers={"X-Worker-Secret": ""})
    assert r.status_code == 503
    r = client.post("/api/webhook/session", json=BODY)
    assert r.status_code == 503
    assert client.get("/health").status_code == 200


def test_wrong_secret_is_401(client, monkeypatch):
    monkeypatch.setenv("WORKER_WEBHOOK_SECRET", "s3cret")
    r = client.post(
        "/api/webhook/session", json=BODY, headers={"X-Worker-Secret": "nope"}
    )
    assert r.status_code == 401
    r = client.post("/api/webhook/session", json=BODY)
    assert r.status_code == 401


def test_non_ascii_header_does_not_crash(client, monkeypatch):
    monkeypatch.setenv("WORKER_WEBHOOK_SECRET", "s3cret")
    r = client.post(
        "/api/webhook/session", json=BODY, headers={"X-Worker-Secret": "sécret"}
    )
    assert r.status_code == 401


def test_right_secret_is_accepted(client, monkeypatch):
    monkeypatch.setenv("WORKER_WEBHOOK_SECRET", "s3cret")
    job = MagicMock(id="job-1")
    with patch("app.webhook._queue") as q:
        q.enqueue.return_value = job
        r = client.post(
            "/api/webhook/session", json=BODY, headers={"X-Worker-Secret": "s3cret"}
        )
    assert r.status_code == 202
    assert r.get_json()["job_id"] == "job-1"


def test_health_is_always_ok(client, monkeypatch):
    monkeypatch.setenv("WORKER_WEBHOOK_SECRET", "s3cret")
    assert client.get("/health").status_code == 200
