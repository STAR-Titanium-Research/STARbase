"""The poller: which relay requests become pending, invalid ones, persistence, crash reporting."""

import pytest

from app.rig_test import relay
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


def test_a_run_that_was_active_when_the_app_stopped_is_reported_interrupted(fake, make):
    store = StateFile(str(make()._store._path))
    store.update(active_run=44)
    p = make()
    p._report_interrupted_run()
    assert fake.comments[0][0] == 44 and "interrupted" in fake.comments[0][1]
    assert fake.states == [(44, "interrupted")]
    assert StateFile(store._path).get("active_run") is None
    p._report_interrupted_run()  # only once
    assert len(fake.comments) == 1


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


def test_the_real_relay_client_never_raises(monkeypatch):
    monkeypatch.setenv("FORCE_APP_BUG_REPORT_RELAY_URL", "http://127.0.0.1:1")  # nothing there
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
