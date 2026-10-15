"""Webhook routing: which Flow callbacks enqueue a render, and which are skipped."""

from unittest.mock import MagicMock, patch

import pytest
from redis.exceptions import ConnectionError as RedisConnectionError

from app.webhook import app

HEADERS = {"X-Worker-Secret": "s3cret"}
SCAN = "0b0a1c1e-5a53-4b0e-9a3c-0d6f6a0c9e11"


@pytest.fixture(autouse=True)
def _secret(monkeypatch):
    monkeypatch.setenv("WORKER_WEBHOOK_SECRET", "s3cret")


@pytest.fixture
def client():
    return app.test_client()


def _post(client, body, enqueued=True):
    with patch("app.webhook.enqueue_render") as enqueue:
        enqueue.return_value = (MagicMock(id="job-1"), enqueued)
        r = client.post("/api/webhook/scan", json=body, headers=HEADERS)
    return r, enqueue


def test_create_enqueues_a_render(client):
    r, enqueue = _post(
        client,
        {"event": "surface_scans.items.create", "key": SCAN, "payload": {"condition": "worn"}},
    )
    assert r.status_code == 202
    assert r.get_json()["job_id"] == "job-1"
    assert enqueue.call_args.args[1] == SCAN


def test_create_with_explicit_pending_enqueues(client):
    r, _ = _post(client, {"key": SCAN, "payload": {"render_status": "pending"}})
    assert r.status_code == 202


def test_render_again_update_enqueues(client):
    r, enqueue = _post(
        client,
        {"event": "surface_scans.items.update", "key": SCAN, "payload": {"render_status": "pending"}},
    )
    assert r.status_code == 202
    enqueue.assert_called_once()


@pytest.mark.parametrize(
    "payload",
    [{"notes": "edited"}, {"render_status": "rendering"}, {"render_status": "done"}, {}],
)
def test_other_updates_are_skipped(client, payload):
    r, enqueue = _post(
        client, {"event": "surface_scans.items.update", "key": SCAN, "payload": payload}
    )
    assert r.status_code == 200
    assert r.get_json()["status"] == "skipped"
    enqueue.assert_not_called()


def test_a_create_that_is_not_pending_is_skipped(client):
    r, enqueue = _post(client, {"key": SCAN, "payload": {"render_status": "done"}})
    assert r.status_code == 200
    enqueue.assert_not_called()


def test_keys_list_with_one_key_is_accepted(client):
    r, enqueue = _post(client, {"keys": [SCAN], "payload": {}})
    assert r.status_code == 202
    assert enqueue.call_args.args[1] == SCAN


def test_direct_call_with_scan_id(client):
    r, enqueue = _post(client, {"scan_id": SCAN})
    assert r.status_code == 202
    assert enqueue.call_args.args[1] == SCAN


@pytest.mark.parametrize(
    "body", [{}, {"key": "not-a-uuid"}, {"key": "../../etc/passwd"}, {"keys": [SCAN, SCAN]}, []]
)
def test_missing_or_bad_id_is_a_400(client, body):
    r, enqueue = _post(client, body)
    assert r.status_code == 400
    enqueue.assert_not_called()


def test_already_queued_is_a_200_skip(client):
    r, _ = _post(client, {"key": SCAN, "payload": {}}, enqueued=False)
    assert r.status_code == 200
    assert r.get_json()["reason"] == "already queued"


def test_redis_down_is_a_503(client):
    with patch("app.webhook.enqueue_render", side_effect=RedisConnectionError("down")):
        r = client.post("/api/webhook/scan", json={"key": SCAN}, headers=HEADERS)
    assert r.status_code == 503


def test_the_template_route_is_gone(client):
    r = client.post("/api/webhook/session", json={"key": SCAN}, headers=HEADERS)
    assert r.status_code == 404
