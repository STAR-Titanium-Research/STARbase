"""The run state machine: answers, no_response, dependency skips, the hard cap and Cancel."""

import json
from datetime import datetime

import pytest

from app.rig_test import runner as runner_mod
from app.rig_test.runner import AnswerRejectedError, RigTestRunner, RunnerBusyError

from .test_rig_test_support import Clock, FakeRelay, inline_request, wait_for

THREE_ASKS = """
- ask: first
- ask: second
  options: [Yes, No]
  pass: [Yes]
- note: read this
"""


@pytest.fixture
def fake(monkeypatch):
    return FakeRelay().install(monkeypatch)


@pytest.fixture
def make_runner(tmp_path):
    made = []

    def make(**kw):
        kw.setdefault("clock", Clock())
        kw.setdefault("ask_timeout_s", 300.0)
        kw.setdefault("slice_s", 0.005)
        r = RigTestRunner(captures_root=lambda: str(tmp_path), rig_id=lambda: "rig-1", **kw)
        made.append(r)
        return r

    yield make
    for r in made:
        r.cancel()
        r.join()


def _answer_when_asked(r, index, option, note=None):
    wait_for(lambda: (r.snapshot().get("question") or {}).get("step") == index)
    r.answer(index, option, note)


def _finish(r):
    r.join()
    return r.snapshot()


def test_all_steps_pass_gives_done_and_result_files(fake, make_runner, tmp_path):
    r = make_runner()
    r.start(inline_request(THREE_ASKS), {"operator": "op@lab", "app_version": "0.1.40"})
    assert r.owns_rig() and r.current_issue() == 231
    _answer_when_asked(r, 0, "Pass", "all good")
    _answer_when_asked(r, 1, "Yes")
    _answer_when_asked(r, 2, "Continue")
    run = _finish(r)
    assert run["state"] == "done" and not r.owns_rig()
    assert [s["status"] for s in run["steps"]] == ["pass", "pass", "pass"]
    assert run["steps"][0]["answer"] == "Pass" and run["steps"][0]["note"] == "all good"
    assert "question" not in run and "current" not in run
    # the progress comment is created at start, edited after each step, result is a new comment
    assert len(fake.comments) == 2 and fake.comments[0][0] == 231
    assert "running on rig-1" in fake.comments[0][1]
    assert len(fake.edits) >= 6 and all(e[1] == 1001 for e in fake.edits)
    assert fake.comments[1][1].startswith("### Rig test result: done (rig-1, app 0.1.40")
    assert [s for _, s in fake.states] == ["running", "done"]
    saved = json.loads((tmp_path / "rig-tests" / "231" / "result.json").read_text())
    assert saved["state"] == "done" and saved["counts"] == {"pass": 3}
    assert saved["items"][0]["result"] == "pass"


def test_a_failed_step_gives_partial(fake, make_runner):
    r = make_runner()
    r.start(inline_request(THREE_ASKS), {})
    _answer_when_asked(r, 0, "Fail", "broken")
    _answer_when_asked(r, 1, "Yes")
    _answer_when_asked(r, 2, "Continue")
    run = _finish(r)
    assert run["state"] == "partial"
    assert run["steps"][0]["status"] == "fail"
    assert fake.last_state(231) == "partial"


def test_skip_is_not_a_fail(fake, make_runner):
    r = make_runner()
    r.start(inline_request("- ask: only"), {})
    _answer_when_asked(r, 0, "Skip")
    run = _finish(r)
    assert run["steps"][0]["status"] == "no_response" and run["steps"][0]["answer"] == "Skip"
    assert run["state"] == "partial"


def test_a_step_after_a_failed_one_is_skipped(fake, make_runner):
    r = make_runner()
    steps = "- ask: pull the cable\n- ask: still ok?\n  after: 1\n- ask: independent"
    r.start(inline_request(steps), {})
    _answer_when_asked(r, 0, "Fail")
    _answer_when_asked(r, 2, "Pass")  # step 1 never asks
    run = _finish(r)
    assert [s["status"] for s in run["steps"]] == ["fail", "skipped_dependency", "pass"]
    assert run["state"] == "partial"


def test_a_dependent_step_runs_when_its_dependency_passed(fake, make_runner):
    r = make_runner()
    r.start(inline_request("- ask: a\n- ask: b\n  after: 1"), {})
    _answer_when_asked(r, 0, "Pass")
    _answer_when_asked(r, 1, "Pass")
    assert _finish(r)["state"] == "done"


def test_no_answer_marks_no_response_after_the_timeout_and_the_run_carries_on(fake, make_runner):
    clock = Clock()
    r = make_runner(clock=clock)
    r.start(inline_request("- ask: a\n- ask: b"), {})  # window 300 s each, cap 600 s
    wait_for(lambda: (r.snapshot().get("question") or {}).get("step") == 0)
    clock.advance(299)
    assert r.snapshot()["steps"][0]["status"] == "active"
    clock.advance(2)
    wait_for(lambda: r.snapshot()["steps"][0]["status"] == "no_response")
    _answer_when_asked(r, 1, "Pass")
    run = _finish(r)
    assert [s["status"] for s in run["steps"]] == ["no_response", "pass"]
    assert run["state"] == "partial"


def test_a_single_default_ask_gets_its_whole_answer_window_before_the_cap(fake, make_runner):
    """B2: est 120 s used to make the cap 180 s, which killed the ask 120 s before its window."""
    clock = Clock()
    r = make_runner(clock=clock)
    r.start(inline_request("- ask: only one"), {})
    wait_for(lambda: r.snapshot().get("question"))
    clock.advance(250)
    assert r.snapshot()["steps"][0]["status"] == "active"
    clock.advance(60)
    run = _finish(r)
    assert run["steps"][0]["status"] == "no_response"  # not "cancelled"
    assert run["state"] == "partial"


def test_the_answer_window_grows_with_a_long_estimate_and_is_300_s_for_a_note(fake, make_runner):
    spec = {"kind": "ask", "est_s": 1200}
    assert runner_mod.step_window_s(spec) == 1800  # 1.5 x est
    assert runner_mod.step_window_s({"kind": "ask", "est_s": 30}) == 300
    assert runner_mod.step_window_s({"kind": "note", "est_s": 1200}) == 300
    clock = Clock()
    r = make_runner(clock=clock)
    r.start(inline_request("- ask: a\n  est: 20m\n- ask: b"), {})
    wait_for(lambda: r.snapshot().get("question"))
    clock.advance(1700)
    assert r.snapshot()["steps"][0]["status"] == "active"
    clock.advance(101)
    wait_for(lambda: r.snapshot()["steps"][0]["status"] == "no_response")


def test_run_cap_is_the_larger_of_1_5x_the_estimates_and_the_windows_up_to_2_hours():
    def ask(est):
        return {"kind": "ask", "est_s": est}

    assert runner_mod.run_cap_s([ask(120)]) == 300  # window 300 > 1.5 x 120
    assert runner_mod.run_cap_s([ask(120), ask(120)]) == 600
    assert runner_mod.run_cap_s([ask(600)] * 3) == 3 * 900  # prose items: window 900 each
    assert runner_mod.run_cap_s([ask(1800)] * 5) == runner_mod.RUN_CAP_MAX_S == 7200
    assert runner_mod.run_cap_s([{"kind": "note", "est_s": 30}] * 2) == 600


def test_the_hard_cap_ends_the_run_as_timed_out(fake, make_runner):
    clock = Clock()
    r = make_runner(clock=clock)
    steps = "\n".join(f"- ask: s{i}\n  est: 25m" for i in range(5))  # windows 2250 s, cap 2 h
    r.start(inline_request(steps), {})
    for i in range(3):  # a slow operator: 2000 s per answer, 6000 s of the 7200 s used
        _answer_when_asked(r, i, "Pass")
        clock.advance(2000)
    wait_for(lambda: (r.snapshot().get("question") or {}).get("step") == 3)
    clock.advance(1300)  # past the cap, but inside step 3's 2250 s window
    run = _finish(r)
    assert run["state"] == "timed_out" and not r.owns_rig()
    assert [s["status"] for s in run["steps"]] == ["pass"] * 3 + ["cancelled"] * 2
    assert fake.last_state(231) == "partial"
    assert "result: timed_out" in fake.comments[-1][1]
    assert "⏱ Timed out" in fake.comments[-1][1]


def test_question_expires_at_is_the_step_deadline_or_the_run_deadline_whichever_is_first(
    fake, make_runner
):
    clock = Clock()
    epoch = 1_760_000_000.0
    r = make_runner(clock=clock, wall=lambda: epoch + (clock.t - 1000.0))
    r.start(inline_request("- ask: a\n- ask: b"), {})
    wait_for(lambda: r.snapshot().get("question"))
    snap = r.snapshot()
    first = datetime.fromisoformat(snap["question"]["expires_at"]).timestamp()
    assert first == epoch + 300  # the step window, well inside the 600 s cap
    assert datetime.fromisoformat(snap["deadline_at"]).timestamp() == epoch + 600
    clock.advance(200)
    r.answer(0, "Pass", None)
    wait_for(lambda: (r.snapshot().get("question") or {}).get("step") == 1)
    second = datetime.fromisoformat(r.snapshot()["question"]["expires_at"]).timestamp()
    assert second == epoch + 500  # 200 s in, +300 s window: still before the cap at 600 s
    r.answer(1, "Pass", None)
    _finish(r)

    r2 = make_runner(clock=Clock(2000.0), wall=lambda: epoch)
    steps = "\n".join(f"- ask: s{i}\n  est: 25m" for i in range(5))  # windows 2250 s, cap 7200 s
    r2.start(inline_request(steps, number=232), {})
    for i in range(3):
        _answer_when_asked(r2, i, "Pass")
        r2._clock.advance(2000)
    wait_for(lambda: (r2.snapshot().get("question") or {}).get("step") == 3)
    # 6000 s used, 1200 s left of the cap: the countdown shows 1200 s, not the 2250 s window
    expires = datetime.fromisoformat(r2.snapshot()["question"]["expires_at"]).timestamp()
    assert expires == epoch + 1200


def test_cancel_during_an_ask_ends_the_run_and_reports(fake, make_runner, tmp_path):
    r = make_runner()
    r.start(inline_request(THREE_ASKS), {})
    wait_for(lambda: r.snapshot().get("question"))
    r.cancel()
    run = _finish(r)
    assert run["state"] == "cancelled" and not r.owns_rig()
    assert [s["status"] for s in run["steps"]] == ["cancelled"] * 3
    assert "Rig test result: cancelled" in fake.comments[-1][1]
    assert fake.last_state(231) == "partial"
    saved = json.loads((tmp_path / "rig-tests" / "231" / "result.json").read_text())
    assert saved["state"] == "cancelled"


def test_cancel_when_idle_or_after_the_end_is_harmless(fake, make_runner):
    r = make_runner()
    r.cancel()
    assert r.snapshot() == {"state": "idle"}
    r.start(inline_request("- note: x"), {})
    _answer_when_asked(r, 0, "Continue")
    r.join()
    r.cancel()
    assert r.snapshot()["state"] == "done"


def test_only_one_run_at_a_time(fake, make_runner):
    r = make_runner()
    r.start(inline_request("- ask: a"), {})
    with pytest.raises(RunnerBusyError):
        r.start(inline_request("- ask: b", number=232), {})
    r.cancel()
    r.join()
    r.start(inline_request("- ask: b", number=232), {})  # free again
    assert r.current_issue() == 232


def test_answers_must_match_the_open_question(fake, make_runner):
    r = make_runner()
    with pytest.raises(AnswerRejectedError) as idle:
        r.answer(0, "Pass", None)
    assert idle.value.conflict
    r.start(inline_request("- ask: a\n- ask: b"), {})
    wait_for(lambda: r.snapshot().get("question"))
    with pytest.raises(AnswerRejectedError) as wrong_step:
        r.answer(1, "Pass", None)
    assert wrong_step.value.conflict
    with pytest.raises(AnswerRejectedError) as bad_option:
        r.answer(0, "Maybe", None)
    assert not bad_option.value.conflict
    r.answer(0, "Pass", None)
    with pytest.raises(AnswerRejectedError):  # a second answer to the same question
        r.answer(0, "Fail", None)


def test_a_long_note_is_cut(fake, make_runner):
    r = make_runner()
    r.start(inline_request("- ask: a"), {})
    _answer_when_asked(r, 0, "Pass", "x" * 5000)
    assert len(_finish(r)["steps"][0]["note"]) == runner_mod.MAX_NOTE


def test_a_finished_run_stays_visible_for_a_while_then_goes_idle(fake, make_runner):
    # A real epoch, not a small number: on Windows, datetime.fromtimestamp() refuses timestamps
    # near 1970 (OSError 22), which is what `_iso` hits when the run records started_at.
    wall = [1_760_000_000.0]
    r = make_runner(wall=lambda: wall[0])
    r.start(inline_request("- note: x"), {})
    _answer_when_asked(r, 0, "Continue")
    assert _finish(r)["state"] == "done"
    wall[0] += runner_mod.FINISHED_TTL_S + 1
    assert r.snapshot() == {"state": "idle"}


def test_relay_failures_never_change_how_the_run_ends(monkeypatch, make_runner):
    def down(*a, **k):
        return {"ok": False, "reason": "unreachable"}

    for name in ("post_comment", "edit_comment", "set_state"):
        monkeypatch.setattr("app.rig_test.relay." + name, down)
    r = make_runner()
    r.start(inline_request("- ask: a"), {})
    _answer_when_asked(r, 0, "Pass")
    assert _finish(r)["state"] == "done"


def test_a_result_the_relay_did_not_take_goes_to_the_outbox(monkeypatch, make_runner):
    down = {"ok": False, "reason": "unreachable", "kind": "unreachable"}
    monkeypatch.setattr("app.rig_test.relay.post_comment", lambda n, b: down)
    monkeypatch.setattr("app.rig_test.relay.edit_comment", lambda n, c, b: down)
    monkeypatch.setattr("app.rig_test.relay.set_state", lambda n, s: down)
    queued = []
    r = make_runner(on_unsent=lambda n, body, state: queued.append((n, body, state)))
    r.start(inline_request("- ask: a"), {})
    _answer_when_asked(r, 0, "Pass")
    assert _finish(r)["state"] == "done"
    ((n, body, state),) = queued
    assert n == 231 and state == "done" and body.startswith("### Rig test result: done")


def test_only_the_part_the_relay_refused_is_queued(monkeypatch, fake, make_runner):
    monkeypatch.setattr("app.rig_test.relay.set_state", lambda n, s: {"ok": False})
    queued = []
    r = make_runner(on_unsent=lambda n, body, state: queued.append((n, body, state)))
    r.start(inline_request("- ask: a"), {})
    _answer_when_asked(r, 0, "Fail")
    _finish(r)
    assert queued == [(231, None, "partial")]  # the comment was posted, the label was not


def test_nothing_is_queued_when_everything_was_sent(fake, make_runner):
    queued = []
    r = make_runner(on_unsent=lambda *a: queued.append(a))
    r.start(inline_request("- ask: a"), {})
    _answer_when_asked(r, 0, "Pass")
    _finish(r)
    assert queued == []


def test_active_run_is_recorded_and_cleared(fake, make_runner):
    seen = []
    r = make_runner(on_active=seen.append)
    r.start(inline_request("- note: x"), {})
    _answer_when_asked(r, 0, "Continue")
    r.join()
    assert seen == [231, None]


def test_a_broken_active_hook_does_not_stop_the_run(fake, make_runner):
    def boom(_n):
        raise OSError("disk")

    r = make_runner(on_active=boom)
    r.start(inline_request("- note: x"), {})
    _answer_when_asked(r, 0, "Continue")
    assert _finish(r)["state"] == "done"


def test_request_text_is_only_displayed_never_used_as_a_path(fake, make_runner, tmp_path):
    r = make_runner()
    nasty = "../../../etc/passwd; $(rm -rf /) C:\\\\Windows\\\\x"
    r.start(inline_request(f"- ask: '{nasty}'"), {})
    _answer_when_asked(r, 0, "Pass")
    _finish(r)
    written = sorted(p.relative_to(tmp_path).as_posix() for p in tmp_path.rglob("*") if p.is_file())
    assert written == ["rig-tests/231/result.json"]
