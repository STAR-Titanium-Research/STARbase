"""Jobs are enqueued with an explicit, configurable job_timeout (rq default is 180 s)."""

from unittest.mock import MagicMock, patch

import pytest

from app.lib.job_config import DEFAULT_JOB_TIMEOUT_SECONDS, job_timeout_seconds
from app.webhook import app

BODY = {"key": "sess-1", "payload": {"file_storage_pointer": "a/b.d1f"}}
HEADERS = {"X-Worker-Secret": "s3cret"}


@pytest.fixture(autouse=True)
def _secret(monkeypatch):
    monkeypatch.setenv("WORKER_WEBHOOK_SECRET", "s3cret")


def _post():
    with patch("app.webhook._queue") as q:
        q.enqueue.return_value = MagicMock(id="j1")
        r = app.test_client().post("/api/webhook/session", json=BODY, headers=HEADERS)
    return r, q


def test_default_timeout_is_six_hours(monkeypatch):
    monkeypatch.delenv("JOB_TIMEOUT_SECONDS", raising=False)
    r, q = _post()
    assert r.status_code == 202
    assert q.enqueue.call_args.kwargs["job_timeout"] == 6 * 3600
    assert DEFAULT_JOB_TIMEOUT_SECONDS == 6 * 3600


def test_timeout_is_configurable(monkeypatch):
    monkeypatch.setenv("JOB_TIMEOUT_SECONDS", "90000")
    _, q = _post()
    assert q.enqueue.call_args.kwargs["job_timeout"] == 90000


@pytest.mark.parametrize("bad", ["abc", "0", "-5"])
def test_bad_timeout_falls_back_to_default(monkeypatch, bad):
    monkeypatch.setenv("JOB_TIMEOUT_SECONDS", bad)
    assert job_timeout_seconds() == DEFAULT_JOB_TIMEOUT_SECONDS
