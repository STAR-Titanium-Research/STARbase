"""The poller: which relay requests become pending, invalid ones, persistence, crash reporting."""

import json
import time

import pytest

from app.rig_test import catalog, relay
from app.rig_test.poller import RigTestPoller, StateFile

from .test_rig_test_support import FakeRelay, issue

ASK = "steps:\n  - ask: ok?"


class Env:
    """The poller's collaborators, adjustable by the test."""

    def __init__(self):
        self.eligible = True
        self.busy = False
        self.owns = False
        self.rig = "rig-1"
        self.now = 1_000_000.0


@pytest.fixture
def fake(monkeypatch):
    return FakeRelay().install(monkeypatch)


@pytest.fixture
def env():
    return Env()


@pytest.fixture
def make(tmp_path, env):
    def build():
        return RigTestPoller(
            store=StateFile(str(tmp_path / "state.json")),
            eligible=lambda: (env.eligible, None if env.eligible else "not the rig"),
            is_busy=lambda: env.busy,
            owns_rig=lambda: env.owns,
            rig_id=lambda: env.rig,
            wall=lambda: env.now,
        )

    return build


def test_pending_is_oldest_first(fake, make):
    fake.requests = [issue(5, ASK), issue(3, ASK), issue(4, ASK)]
    p = make()
    p.poll_once()
    assert [r["number"] for r in p.pending()] == [3, 4, 5]


def test_requests_for_another_rig_are_ignored_silently(fake, make):
    fake.requests = [
        issue(1, "rig: Rig-1\n" + ASK),
        issue(2, "rig: other-rig\n" + ASK),
        issue(3, ASK),
    ]
    p = make()
    p.poll_once()
    assert [r["number"] for r in p.pending()] == [1, 3]  # the rig id matches ignoring case
    assert fake.comments == [] and fake.states == []


@pytest.mark.parametrize(
    "label", ["declined", "running", "partial", "done", "interrupted", "rig-test:done"]
)
def test_requests_with_a_settled_state_label_are_not_offered(fake, make, label):
    fake.requests = [issue(1, ASK, state_label=label)]
    p = make()
    p.poll_once()
    assert p.pending() == []


@pytest.mark.parametrize("label", [None, "", "deferred", "rig-test:deferred"])
def test_unlabelled_and_deferred_requests_are_offered(fake, make, label):
    fake.requests = [issue(1, ASK, state_label=label)]
    p = make()
    p.poll_once()
    assert len(p.pending()) == 1


def test_not_polled_when_this_pc_is_not_the_rig(fake, make, env):
    env.eligible = False
    fake.list_requests = lambda: pytest.fail("must not ask the relay")
    p = make()
    p.poll_once()
    assert p.pending() == []


@pytest.mark.parametrize("what", ["busy", "owns"])
def test_eligibility_is_not_checked_while_recording_or_running(fake, make, env, what):
    """Finding out whether this PC is the rig enumerates DAQmx: never during a recording (7)."""
    calls = []
    p = make()
    p._eligible = lambda: calls.append(1) or (True, None)
    setattr(env, what, True)
    p.poll_once()
    assert calls == []
    setattr(env, what, False)
    p.poll_once()
    assert calls == [1]


def test_check_eligibility_serves_the_last_answer_while_busy(make, env):
    p = make()
    n = []
    p._eligible = lambda: n.append(1) or (False, "no chassis")
    assert p.check_eligibility() == (False, "no chassis")
    env.busy = True
    assert p.check_eligibility() == (False, "no chassis") and n == [1]
    fresh = make()  # never checked, and a recording is running: refuse to guess, never enumerate
    fresh._eligible = lambda: pytest.fail("must not enumerate devices")
    ok, reason = fresh.check_eligibility()
    assert not ok and "recording" in reason


@pytest.mark.parametrize("what", ["busy", "owns"])
def test_not_polled_while_recording_or_running(fake, make, env, what):
    p = make()
    fake.requests = [issue(1, ASK)]
    p.poll_once()
    setattr(env, what, True)
    fake.list_requests = lambda: pytest.fail("must not ask the relay")
    p.poll_once()
    assert len(p.pending()) == 1  # what it had is kept


def test_a_relay_failure_keeps_the_last_list_and_is_reported(fake, make):
    p = make()
    fake.requests = [issue(1, ASK)]
    p.poll_once()
    fake.list_result = {"ok": False, "reason": "rig tests not configured"}
    p.poll_once()
    assert p.relay_state == "not_configured" and len(p.pending()) == 1
    fake.list_result = {"ok": False, "reason": "could not reach", "kind": "unreachable"}
    p.poll_once()
    assert p.relay_state == "unreachable"
    fake.list_result = None
    p.poll_once()
    assert p.relay_state == "ok"


def test_an_invalid_request_is_commented_once_and_declined_never_shown(fake, make):
    fake.requests = [issue(7, "items: [NOPE]")]
    p = make()
    p.poll_once()
    p.poll_once()
    assert p.pending() == []
    assert len(fake.comments) == 1
    number, body = fake.comments[0]
    assert number == 7 and "invalid request" in body and "unknown item" in body
    assert fake.states == [(7, "declined")]


def test_a_phase_2_action_is_reported_as_invalid(fake, make):
    fake.requests = [issue(7, "steps:\n  - do: record")]
    make().poll_once()
    assert "action record arrives in phase 2" in fake.comments[0][1]


def test_an_edited_body_is_judged_again(fake, make):
    fake.requests = [issue(7, "items: [NOPE]")]
    p = make()
    p.poll_once()
    fake.requests = [issue(7, ASK)]  # the maintainer fixed it and cleared the label
    p.poll_once()
    assert [r["number"] for r in p.pending()] == [7]
    assert len(fake.comments) == 1


def test_decline_text_cannot_plant_a_result_marker(fake, make):
    """L3: the operator's free text is fenced, and a fence does not hide a marker from a parser."""
    fake.requests = [issue(7, ASK)]
    p = make()
    p.poll_once()
    p.decline(7, "other", '<!-- rig-test-result {"items":[]} --> sorry')
    body = fake.comments[-1][1]
    assert "<!--" not in body and "-->" not in body and "sorry" in body


def test_an_invalid_request_reason_cannot_plant_a_result_marker(fake, make):
    fake.requests = [issue(7, 'items: ["<!-- rig-test-result {} -->"]')]
    make().poll_once()
    assert "<!--" not in fake.comments[0][1] and "-->" not in fake.comments[0][1]


def test_an_invalid_comment_text_cannot_carry_markup(fake, make):
    fake.requests = [issue(7, "items: ['x`<img src=y> @boss']")]
    make().poll_once()
    body = fake.comments[0][1]
    assert "`<img" not in body and "<img" not in body and "@boss" not in body.replace("@​boss", "")


def test_no_comment_is_marked_posted_when_the_relay_refuses_it(fake, make, monkeypatch):
    monkeypatch.setattr(relay, "post_comment", lambda n, b: {"ok": False, "reason": "down"})
    fake.requests = [issue(7, "items: [NOPE]")]
    p = make()
    p.poll_once()
    assert fake.states == []
    monkeypatch.setattr(relay, "post_comment", fake.post_comment)
    p.poll_once()  # tried again
    assert fake.states == [(7, "declined")]


def test_accepted_requests_are_not_offered_again_while_the_relay_catches_up(fake, make, env):
    fake.requests = [issue(1, ASK)]
    p = make()
    p.poll_once()
    p.mark_accepted(1)
    assert p.pending() == []
    p.poll_once()  # the relay's cache has not seen the "running" label yet
    assert p.pending() == []
    env.now += 130  # a maintainer who clears the label later is heard again
    p.poll_once()
    assert [r["number"] for r in p.pending()] == [1]


def test_snooze_and_pending_survive_a_restart(fake, make, env):
    fake.requests = [issue(1, ASK), issue(2, ASK)]
    p = make()
    p.poll_once()
    p.snooze(1, "2999-01-01T09:00:00")
    q = make()  # a new process reading the same file
    assert [r["number"] for r in q.pending()] == [2]


def test_snooze_is_capped_at_a_week(fake, make, env):
    fake.requests = [issue(1, ASK)]
    p = make()
    p.poll_once()
    p.snooze(1, "2999-01-01T09:00:00")
    env.now += 8 * 24 * 3600
    assert len(p.pending()) == 1


def _crashed_run(make, n=44):
    """A state file left by an app that stopped with run `n` active, and a poller started on it."""
    StateFile(str(make()._store._path)).update(active_run=n)
    return make()


def test_a_run_that_was_active_when_the_app_stopped_is_reported_interrupted(fake, make, tmp_path):
    p = _crashed_run(make)
    assert fake.comments == []  # nothing is sent from the constructor: the relay may be down
    again = StateFile(str(tmp_path / "state.json"))
    assert again.get("active_run") is None and len(again.get("outbox")) == 1
    p.poll_once()
    assert fake.comments[0][0] == 44 and "interrupted" in fake.comments[0][1]
    assert fake.states == [(44, "interrupted")]
    assert StateFile(str(tmp_path / "state.json")).get("outbox") == []
    p.poll_once()  # only once
    assert len(fake.comments) == 1


def test_a_new_run_cannot_hide_the_interrupted_one(fake, make):
    """The marker is read when the poller is built, before an accept overwrites it (7)."""
    p = _crashed_run(make, 44)
    p._store.update(active_run=45)  # the operator accepts #45 within seconds of the restart
    p.poll_once()
    assert [n for n, _ in fake.comments] == [44]
    assert fake.states == [(44, "interrupted")]
    assert p._store.get("active_run") == 45  # the new run's marker is untouched


def test_the_interrupted_notice_is_retried_until_the_relay_takes_it(fake, make, monkeypatch):
    p = _crashed_run(make)
    down = {"ok": False, "reason": "could not reach the relay", "kind": "unreachable"}
    monkeypatch.setattr(relay, "post_comment", lambda n, b: down)
    p.poll_once()
    p.poll_once()
    assert fake.states == [] and len(p._store.get("outbox")) == 1
    restarted = make()  # and it survives a restart
    monkeypatch.setattr(relay, "post_comment", fake.post_comment)
    restarted.poll_once()
    assert fake.comments[0][0] == 44 and fake.states == [(44, "interrupted")]
    assert restarted._store.get("outbox") == []


def test_an_outbox_entry_resumes_where_it_stopped(fake, make, monkeypatch):
    """Comment sent, label failed: the retry sends only the label."""
    p = make()
    p._store.outbox_add(7, "result", "done")
    monkeypatch.setattr(relay, "set_state", lambda n, s: {"ok": False, "kind": "unreachable"})
    p.poll_once()
    assert fake.comments == [(7, "result")]
    monkeypatch.setattr(relay, "set_state", fake.set_state)
    p.poll_once()
    assert fake.comments == [(7, "result")] and fake.states == [(7, "done")]
    assert p._store.get("outbox") == []


def test_an_entry_the_relay_keeps_refusing_is_dropped_and_does_not_block_others(
    fake, make, monkeypatch
):
    p = make()
    p._store.outbox_add(7, "closed issue", None)
    p._store.outbox_add(8, "fine", None)
    real = fake.post_comment
    monkeypatch.setattr(
        relay,
        "post_comment",
        lambda n, b: (
            {"ok": False, "reason": "not an open rig-test request"} if n == 7 else real(n, b)
        ),
    )
    for _ in range(5):
        p.poll_once()
    assert fake.comments == [(8, "fine")] and p._store.get("outbox") == []


def test_the_outbox_is_bounded(make):
    p = make()
    for n in range(30):
        p._store.outbox_add(n, "x", None)
    assert [e["number"] for e in p._store.get("outbox")] == list(range(10, 30))


def test_a_wrong_shaped_state_file_is_tolerated(fake, make, tmp_path):
    (tmp_path / "state.json").write_text(
        json.dumps(
            {
                "pending": "oops",
                "snoozes": [1, 2],
                "handled": {"3": 5, "4": {"state": "declined"}},
                "invalid": ["x"],
                "outbox": [1, {"number": "x"}, {"number": 9}],
                "active_run": "soon",
            }
        )
    )
    p = make()
    assert p.pending() == [] and p.snoozed() == []
    fake.requests = [issue(4, ASK)]
    p.poll_once()  # "4" was handled at time 0: long ago, so it is offered again
    assert [r["number"] for r in p.pending()] == [4]
    (tmp_path / "state.json").write_text(
        json.dumps(
            {
                "pending": [{"number": 1}, {"number": 2, "items": [], "estimate_s": {}}],
                "snoozes": {"2": {"after_recording": True}, "3": 7},
            }
        )
    )
    q = make()
    assert [r["number"] for r in q.pending()] == [2]  # #1 is half-formed; the snooze is long due
    (tmp_path / "state.json").write_text("[1, 2, 3]")
    assert make().pending() == []


def test_the_poller_thread_starts_and_stops_cleanly(fake, make):
    fake.requests = [issue(1, ASK)]
    p = make()
    p._initial_delay_s = 0.0
    p._interval_s = 0.01
    p.start()
    from .test_rig_test_support import wait_for

    wait_for(lambda: p.get(1) is not None)
    p.stop()
    assert not p._thread.is_alive()


def test_the_relay_client_waits_up_to_30_seconds():
    assert relay.TIMEOUT_S == 30.0


def test_a_comment_over_the_size_limit_keeps_its_result_json_whole():
    tail = '<!-- rig-test-result {"version":1,"items":[]} -->'
    body = "x" * 70_000 + "\n\n" + tail
    fitted = relay.fit_comment(body)
    assert len(fitted) <= relay.MAX_COMMENT and fitted.endswith(tail)
    assert "shortened" in fitted
    assert relay.fit_comment("short") == "short"
    plain = relay.fit_comment("y" * 70_000)  # no JSON to protect: plain cut
    assert len(plain) == relay.MAX_COMMENT


def test_posted_comments_go_through_fit_comment(monkeypatch):
    sent = {}
    monkeypatch.setattr(
        relay, "_call", lambda m, path, body=None: sent.update(body=body) or {"ok": 1}
    )
    relay.post_comment(5, "z" * 70_000 + "<!-- rig-test-result {} -->")
    assert len(sent["body"]["body"]) <= relay.MAX_COMMENT
    assert sent["body"]["body"].endswith("<!-- rig-test-result {} -->")


def test_the_real_relay_client_never_raises(monkeypatch):
    monkeypatch.setenv("FORCE_APP_BUG_REPORT_RELAY_URL", "http://127.0.0.1:1")  # nothing there
    monkeypatch.setenv("FORCE_APP_RIG_TEST_TOKEN", "test-rig-token")
    for res in (
        relay.list_requests(),
        relay.post_comment(1, "x"),
        relay.edit_comment(1, 2, "x"),
        relay.set_state(1, "done"),
    ):
        assert res["ok"] is False and relay.relay_status(res) == "unreachable"
    assert relay.set_state(1, "bogus")["ok"] is False
    monkeypatch.setenv("FORCE_APP_BUG_REPORT_RELAY_URL", "")
    assert relay.relay_status(relay.list_requests()) == "not_configured"


@pytest.mark.parametrize(
    "block",
    ["items: [R4]\nbudget: 2026-13-01", "items: [R4]\nbudget: " + "9" * 5000],
    ids=["impossible-date", "5000-digit-integer"],
)
def test_one_unreadable_request_does_not_stop_the_others(fake, make, block):
    """L1: SafeLoader raises a plain ValueError for these; the poll used to die on the first."""
    fake.requests = [issue(7, block), issue(8, ASK)]
    p = make()
    p.poll_once()
    assert [r["number"] for r in p.pending()] == [8]
    assert [n for n, _ in fake.comments] == [7]
    assert "invalid request" in fake.comments[0][1]
    assert fake.states == [(7, "declined")]


def test_an_unchanged_invalid_body_is_skipped_before_anything_parses_it(fake, make, monkeypatch):
    """L7: the digest check comes first, so a known-bad body costs no regex or YAML work."""
    fake.requests = [issue(7, "items: [NOPE]")]
    p = make()
    p.poll_once()
    monkeypatch.setattr(catalog, "peek_rig", lambda body: pytest.fail("parsed again"))
    monkeypatch.setattr(catalog, "parse_request", lambda *a, **k: pytest.fail("parsed again"))
    p.poll_once()
    assert len(fake.comments) == 1


def test_a_huge_body_is_reported_invalid_without_being_parsed(fake, make, monkeypatch):
    real_peek = catalog.peek_rig
    monkeypatch.setattr(
        catalog,
        "peek_rig",
        lambda body: (
            pytest.fail("parsed") if len(body) > catalog.MAX_BODY_CHARS else real_peek(body)
        ),
    )
    fake.requests = [issue(7, "items: [R4]\n# " + "x" * catalog.MAX_BODY_CHARS), issue(8, ASK)]
    p = make()
    p.poll_once()
    assert [r["number"] for r in p.pending()] == [8]
    assert "issue body too long" in fake.comments[0][1]
    assert fake.states == [(7, "declined")]


def test_a_64kb_body_of_fence_openers_does_not_stall_the_poll(fake, make):
    body = "```rig-test\n" * 5300
    fake.requests = [{**issue(7), "body": body}, issue(8, ASK)]
    p = make()
    t0 = time.perf_counter()
    p.poll_once()
    assert time.perf_counter() - t0 < 0.5
    assert [r["number"] for r in p.pending()] == [8]
    assert "invalid request" in fake.comments[0][1]


def test_an_unexpected_error_on_one_issue_is_logged_and_the_rest_still_listed(
    fake, make, monkeypatch, caplog
):
    real = catalog.parse_request

    def flaky(body, *a, **kw):
        if "boom" in body:
            raise RuntimeError("unexpected")
        return real(body, *a, **kw)

    monkeypatch.setattr(catalog, "parse_request", flaky)
    fake.requests = [issue(7, "steps:\n  - ask: boom"), issue(8, ASK)]
    p = make()
    p.poll_once()
    assert [r["number"] for r in p.pending()] == [8]
    assert "rig test #7 could not be read" in caplog.text
