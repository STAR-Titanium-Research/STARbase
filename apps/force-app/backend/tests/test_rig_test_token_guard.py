"""The shared rig token (M1): the relay refuses callers without it, so the backend must send it,
must not poll without it, and must never leak it into a report, a comment or an error."""

import httpx
import pytest
from fastapi.testclient import TestClient

import app.main as main
from app.rig_test import relay, routes

from .test_rig_test_support import FakeRelay, issue

SECRET = "s3cret-rig-token-0123456789"


@pytest.fixture(autouse=True)
def _no_ambient_token(monkeypatch, tmp_path):
    monkeypatch.delenv("FORCE_APP_RIG_TEST_TOKEN", raising=False)
    monkeypatch.setattr(relay, "_config_dir", str(tmp_path))
    monkeypatch.setenv("FORCE_APP_BUG_REPORT_RELAY_URL", "http://relay.invalid")


def _record_requests(monkeypatch, reply):
    sent = []

    def fake_request(method, url, **kw):
        sent.append((method, url, kw))
        return reply(method, url, kw)

    monkeypatch.setattr(httpx, "request", fake_request)
    return sent


def _ok(*_):
    return httpx.Response(200, json={"ok": True, "requests": []})


def test_token_comes_from_the_env_var_first_then_the_first_line_of_the_file(monkeypatch, tmp_path):
    assert relay.token() == ""
    (tmp_path / relay.TOKEN_FILE).write_text(f"{SECRET}\nsecond line ignored\n", encoding="utf-8")
    assert relay.token() == SECRET
    monkeypatch.setenv("FORCE_APP_RIG_TEST_TOKEN", " from-env ")
    assert relay.token() == "from-env"


@pytest.mark.parametrize("content", ["", "\n", "has a space inside", "café", "x" * 300])
def test_an_unusable_token_file_counts_as_no_token(tmp_path, content):
    (tmp_path / relay.TOKEN_FILE).write_text(content, encoding="utf-8")
    assert relay.token() == ""


def test_every_relay_call_sends_the_token_header(monkeypatch):
    monkeypatch.setenv("FORCE_APP_RIG_TEST_TOKEN", SECRET)
    sent = _record_requests(monkeypatch, _ok)
    relay.list_requests()
    relay.post_comment(5, "x")
    relay.edit_comment(5, 9, "x")
    relay.set_state(5, "done")
    assert len(sent) == 4
    assert all(kw["headers"] == {"X-Rig-Token": SECRET} for _, _, kw in sent)


def test_no_token_means_no_request_at_all(monkeypatch):
    sent = _record_requests(monkeypatch, _ok)
    for res in (relay.list_requests(), relay.post_comment(5, "x"), relay.set_state(5, "done")):
        assert res["ok"] is False and res["reason"] == relay.TOKEN_MISSING
        assert relay.relay_status(res) == "not_configured"
    assert sent == []


def test_a_rejected_token_is_its_own_state(monkeypatch):
    monkeypatch.setenv("FORCE_APP_RIG_TEST_TOKEN", SECRET)
    _record_requests(
        monkeypatch,
        lambda *_: httpx.Response(403, json={"ok": False, "reason": "rig token rejected"}),
    )
    res = relay.list_requests()
    assert res["ok"] is False and relay.relay_status(res) == "token_rejected"


def test_the_token_never_appears_in_an_error_text(monkeypatch):
    monkeypatch.setenv("FORCE_APP_RIG_TEST_TOKEN", SECRET)

    def boom(method, url, **kw):
        raise httpx.LocalProtocolError(f"Illegal header value {kw['headers']['X-Rig-Token']!r}")

    monkeypatch.setattr(httpx, "request", boom)
    res = relay.post_comment(5, "x")
    assert res["ok"] is False and SECRET not in repr(res)


def test_the_token_is_not_in_the_bug_report_diagnostics(monkeypatch):
    monkeypatch.setenv("FORCE_APP_RIG_TEST_TOKEN", SECRET)
    assert SECRET not in "\n".join(main._diag_lines())


def test_without_a_token_this_pc_is_not_eligible_and_never_polls(monkeypatch, tmp_path):
    monkeypatch.setenv("FORCE_APP_RIG_TEST_ALLOW_SIM", "1")
    monkeypatch.setenv("FORCE_APP_RIG_ID", "rig-1")
    monkeypatch.setattr(routes, "_w", routes._w)
    fake = FakeRelay().install(monkeypatch)
    fake.requests = [issue(231)]
    monkeypatch.setattr(
        relay, "list_requests", lambda: pytest.fail("the relay must not be asked without a token")
    )
    routes.configure(
        devices=lambda: main._devices(),
        labamp=lambda: main._labamp,
        is_busy=lambda: False,
        captures_root=lambda: str(tmp_path / "captures"),
        config_dir=str(tmp_path / "cfg"),
    )
    w = routes._w
    w.poller.poll_once()
    client = TestClient(main.app, raise_server_exceptions=False)
    body = client.get("/rig-tests/eligibility").json()
    assert body["eligible"] is False
    assert body["reason"] == "rig test token not set (see Settings → Rig tests)"
    assert client.get("/rig-tests/pending").json()["requests"] == []
    # putting the token in the config folder is enough, no restart
    (tmp_path / "cfg").mkdir(exist_ok=True)
    (tmp_path / "cfg" / relay.TOKEN_FILE).write_text(SECRET, encoding="utf-8")
    assert client.get("/rig-tests/eligibility").json()["eligible"] is True
    w.runner.cancel()
    w.runner.join()
