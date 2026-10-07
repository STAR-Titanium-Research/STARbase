"""Webhook routing: a session with no file for this worker is skipped (200), not an error."""

from unittest.mock import MagicMock, patch

import pytest

from app.lib import minio_client
from app.webhook import app

HEADERS = {"X-Worker-Secret": "s3cret"}


@pytest.fixture(autouse=True)
def _secret(monkeypatch):
    monkeypatch.setenv("WORKER_WEBHOOK_SECRET", "s3cret")


@pytest.fixture
def client():
    return app.test_client()


def _post(client, body):
    with patch("app.webhook._queue") as q:
        q.enqueue.return_value = MagicMock(id="job-1")
        r = client.post("/api/webhook/session", json=body, headers=HEADERS)
    return r, q


@pytest.mark.parametrize(
    "payload",
    [{}, {"file_storage_pointer": ""}, {"file_storage_pointer": None}],
)
def test_missing_pointer_is_skipped_not_enqueued(client, payload):
    r, q = _post(client, {"key": "sess-1", "payload": payload})
    assert r.status_code == 200
    body = r.get_json()
    assert body["status"] == "skipped"
    assert body["reason"]
    q.enqueue.assert_not_called()


def test_pointer_into_another_store_is_skipped(client):
    r, q = _post(
        client,
        {"key": "sess-1", "payload": {"file_storage_pointer": "smb://host/a/b.mat"}},
    )
    assert r.status_code == 200
    assert r.get_json()["status"] == "skipped"
    q.enqueue.assert_not_called()


def test_minio_pointer_is_enqueued_with_the_bare_key(client):
    pointer = f"minio://{minio_client.BUCKET}/a/b.d1f"
    r, q = _post(
        client, {"key": "sess-1", "payload": {"file_storage_pointer": pointer}}
    )
    assert r.status_code == 202
    assert r.get_json()["job_id"] == "job-1"
    assert q.enqueue.call_args.args[1:] == ("sess-1", "a/b.d1f")


def test_missing_session_id_is_still_a_400(client):
    r, q = _post(client, {"payload": {"file_storage_pointer": "a/b.d1f"}})
    assert r.status_code == 400
    q.enqueue.assert_not_called()


def test_traversal_key_is_still_a_400(client):
    r, q = _post(
        client, {"key": "sess-1", "payload": {"file_storage_pointer": "../etc/passwd"}}
    )
    assert r.status_code == 400
    q.enqueue.assert_not_called()
