"""The operator's D1 sign-in (ADR-0012 decision 2, amended 2026-10-12): the web lends its access
token to the backend, which sends it to the relay as a bearer, keeps it in memory only, never leaks
it, and does not call the relay without it."""

import time

import httpx
import pytest

import app.main as main
from app.rig_test import relay

TOKEN = "d1-access-token-0123456789"


def later(seconds: float = 3600) -> float:
    return (time.time() + seconds) * 1000


@pytest.fixture(autouse=True)
def _clean_session(monkeypatch):
    monkeypatch.setenv("FORCE_APP_BUG_REPORT_RELAY_URL", "http://relay.invalid")
    relay.clear_session()
    yield
    relay.clear_session()


def _record_requests(monkeypatch, reply):
    sent = []

    def fake_request(method, url, **kw):
        sent.append((method, url, kw))
        return reply(method, url, kw)

    monkeypatch.setattr(httpx, "request", fake_request)
    return sent


def _ok(*_):
    return httpx.Response(200, json={"ok": True, "requests": []})


def test_no_session_means_no_request_at_all(monkeypatch):
    sent = _record_requests(monkeypatch, _ok)
    for res in (relay.list_requests(), relay.post_comment(5, "x"), relay.set_state(5, "done")):
        assert res == {"ok": False, "reason": relay.SIGNED_OUT, "kind": "signed_out"}
        assert relay.relay_status(res) == "signed_out"
    assert sent == []


def test_every_relay_call_sends_the_bearer(monkeypatch):
    relay.set_session(TOKEN, later())
    sent = _record_requests(monkeypatch, _ok)
    relay.list_requests()
    relay.post_comment(5, "x")
    relay.edit_comment(5, 9, "x")
    relay.set_state(5, "done")
    assert len(sent) == 4
    assert all(kw["headers"] == {"Authorization": f"Bearer {TOKEN}"} for _, _, kw in sent)


def test_an_expired_session_counts_as_signed_out(monkeypatch):
    relay.set_session(TOKEN, later(-1))
    assert relay.session_present() is False
    sent = _record_requests(monkeypatch, _ok)
    assert relay.list_requests()["kind"] == "signed_out"
    assert sent == []


@pytest.mark.parametrize("bad", ["", "has a space", "café", "line\nbreak", "x" * 4097])
def test_an_unusable_token_is_refused_and_the_old_one_kept(bad):
    relay.set_session(TOKEN, later())
    with pytest.raises(ValueError):
        relay.set_session(bad, later())
    assert relay.session_present() is True


def test_set_session_says_whether_the_token_changed():
    assert relay.set_session(TOKEN, later()) is True
    assert relay.set_session(TOKEN, later(7200)) is False  # same token, new expiry
    assert relay.set_session(TOKEN + "2", later()) is True


def test_a_rejected_sign_in_clears_the_session(monkeypatch):
    relay.set_session(TOKEN, later())
    _record_requests(
        monkeypatch,
        lambda *_: httpx.Response(403, json={"ok": False, "reason": "D1 sign-in rejected"}),
    )
    res = relay.list_requests()
    assert res["kind"] == "signin_rejected" and relay.relay_status(res) == "signin_rejected"
    assert relay.session_present() is False


def test_a_rejection_does_not_clear_a_newer_token(monkeypatch):
    relay.set_session(TOKEN, later())

    def refused_while_the_web_refreshed(*_):
        relay.set_session("newer-token", later())
        return httpx.Response(403, json={"ok": False, "reason": "D1 sign-in rejected"})

    _record_requests(monkeypatch, refused_while_the_web_refreshed)
    relay.list_requests()
    assert relay.session_present() is True


def test_d1_unavailable_is_unreachable_so_the_outbox_keeps_the_result(monkeypatch):
    relay.set_session(TOKEN, later())
    _record_requests(
        monkeypatch, lambda *_: httpx.Response(503, json={"ok": False, "reason": "D1 unavailable"})
    )
    res = relay.post_comment(5, "result")
    assert res["kind"] == "unreachable" and relay.relay_status(res) == "unreachable"


def test_the_token_never_appears_in_an_error_text(monkeypatch):
    relay.set_session(TOKEN, later())

    def boom(method, url, **kw):
        raise httpx.LocalProtocolError(f"Illegal header value {kw['headers']['Authorization']!r}")

    monkeypatch.setattr(httpx, "request", boom)
    res = relay.post_comment(5, "x")
    assert res["ok"] is False and TOKEN not in repr(res)


def test_the_token_is_not_in_the_bug_report_diagnostics():
    relay.set_session(TOKEN, later())
    assert TOKEN not in "\n".join(main._diag_lines())


def test_the_old_token_env_var_and_file_are_ignored(monkeypatch, tmp_path):
    monkeypatch.setenv("FORCE_APP_RIG_TEST_TOKEN", "old-shared-token")
    (tmp_path / "rig_test_token").write_text("old-shared-token", encoding="utf-8")
    sent = _record_requests(monkeypatch, _ok)
    assert relay.list_requests()["kind"] == "signed_out"
    assert sent == []
