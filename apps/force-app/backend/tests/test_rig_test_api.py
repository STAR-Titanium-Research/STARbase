"""The /rig-tests REST surface end to end, and the rig lock on every endpoint it covers."""

import json
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient

import app.main as main
from app import recovery
from app.rig_test import LOCKED, eligibility, routes
from app.rig_test import runner as runner_mod
from app.rig_test.poller import StateFile

from .test_rig_test_support import FakeRelay, issue, wait_for

ASK = "steps:\n  - ask: Is the light on?"
LOCK_MESSAGE = "a rig test is running (issue #231); cancel it from the rig-test window"


class _Session:
    id = "20260101-000000-abc123"

    def __init__(self, state):
        self.state = state


@pytest.fixture
def fake(monkeypatch):
    return FakeRelay().install(monkeypatch)


@pytest.fixture
def rig(monkeypatch, tmp_path, fake):
    """A fresh poller, runner and state file wired to the real app, eligible via ALLOW_SIM."""
    monkeypatch.setenv("FORCE_APP_RIG_TEST_ALLOW_SIM", "1")
    monkeypatch.setenv("FORCE_APP_RIG_ID", "rig-1")
    monkeypatch.setattr(routes, "_w", routes._w)  # undone after the test
    monkeypatch.setattr(runner_mod, "_runner", runner_mod._runner)
    routes.configure(
        devices=lambda: main._devices(),
        labamp=lambda: main._labamp,
        is_busy=lambda: main._busy(),
        captures_root=lambda: str(tmp_path / "captures"),
        config_dir=str(tmp_path / "cfg"),
    )
    wiring = routes._w
    yield wiring
    wiring.runner.cancel()
    wiring.runner.join()


@pytest.fixture
def client(rig):
    return TestClient(main.app, raise_server_exceptions=False)


def _offer(rig, fake, number=231, block=ASK):
    fake.requests = [issue(number, block)]
    rig.poller.poll_once()


def _accept(client, number=231, **body):
    return client.post(
        f"/rig-tests/{number}/accept", json={"mode": "full", "upload_busy": False, **body}
    )


def _running(client, rig, fake):
    _offer(rig, fake)
    assert _accept(client, operator="op@lab", app_version="0.1.40").status_code == 200
    wait_for(lambda: client.get("/rig-tests/run").json().get("question"))


# ---- eligibility ----------------------------------------------------------------------------


def test_this_pc_is_not_the_rig_unless_hardware_or_the_override(client, monkeypatch):
    monkeypatch.delenv("FORCE_APP_RIG_TEST_ALLOW_SIM")
    body = client.get("/rig-tests/eligibility").json()
    assert body["eligible"] is False and "simulated" in body["reason"]
    assert body["rig_id"] == "rig-1" and body["relay"] in (
        "ok",
        "unreachable",
        "not_configured",
        "unknown",
    )
    monkeypatch.setenv("FORCE_APP_RIG_TEST_ALLOW_SIM", "1")
    body = client.get("/rig-tests/eligibility").json()
    assert body["eligible"] is True and "reason" not in body


def test_eligibility_rules():
    real = {"simulated": False, "chassis": [{"name": "cDAQ1"}]}
    amp = main.LabAmpClient("http://127.0.0.1:1")
    assert eligibility.check(real, amp) == (True, None)
    assert eligibility.check({"simulated": True, "chassis": [{}]}, amp)[0] is False
    assert eligibility.check({"simulated": False, "chassis": []}, amp)[0] is False
    ok, reason = eligibility.check(real, main.MockLabAmp("http://x"))
    assert not ok and "mock" in reason


def test_rig_id_prefers_the_env_var_then_the_hostname(monkeypatch):
    monkeypatch.setenv("FORCE_APP_RIG_ID", " force-rig-1 ")
    assert eligibility.rig_id() == "force-rig-1"
    monkeypatch.delenv("FORCE_APP_RIG_ID")
    monkeypatch.setattr("socket.gethostname", lambda: "LABPC")
    assert eligibility.rig_id() == "LABPC"


def test_a_non_rig_machine_never_polls_the_relay_or_accepts(client, rig, fake, monkeypatch):
    monkeypatch.delenv("FORCE_APP_RIG_TEST_ALLOW_SIM")
    fake.requests = [issue(231, ASK)]
    fake.list_requests = lambda: pytest.fail("the relay must not be asked")
    rig.poller.poll_once()
    assert client.get("/rig-tests/pending").json()["requests"] == []
    assert _accept(client).status_code == 409


# ---- pending, snooze, decline -----------------------------------------------------------------


def test_pending_lists_the_contract_request(client, rig, fake):
    _offer(rig, fake)
    (req,) = client.get("/rig-tests/pending").json()["requests"]
    assert req["number"] == 231 and req["requested_by"] == "dpremoli"
    assert req["estimate_s"] == {"full": 120, "automated": 0} and req["needs_operator_steps"] == 1
    step = req["items"][0]["steps"][0]
    assert step == {
        "index": 0, "item_id": "inline", "kind": "ask", "text": "Is the light on?",
        "options": ["Pass", "Fail", "Skip"], "pass": ["Pass"], "est_s": 120,
    }  # fmt: skip


def test_pending_reports_busy_and_lists_the_snoozed_requests(client, rig, fake, monkeypatch):
    fake.requests = [issue(231, ASK), issue(232, ASK), issue(233, ASK)]
    rig.poller.poll_once()
    body = client.get("/rig-tests/pending").json()
    assert set(body) == {"requests", "snoozed", "busy"}
    assert body["busy"] is False and body["snoozed"] == []
    client.post("/rig-tests/232/snooze", json={"until": "2999-01-01T10:00:00"})
    client.post("/rig-tests/233/snooze", json={"until": "after_recording"})
    body = client.get("/rig-tests/pending").json()
    assert [r["number"] for r in body["requests"]] == [231]
    by_number = {r["number"]: r for r in body["snoozed"]}
    assert set(by_number) == {232, 233}
    assert by_number[233]["snoozed_until"] == "after_recording"
    until = datetime.fromisoformat(by_number[232]["snoozed_until"])  # an ISO 8601 time
    assert until.tzinfo is not None and until > datetime.now(UTC)
    assert by_number[232]["title"] == "Rig test 232" and "items" in by_number[232]
    for state in ("recording", "finalizing"):
        monkeypatch.setattr(main, "_session", _Session(state))
        assert client.get("/rig-tests/pending").json()["busy"] is True
    monkeypatch.setattr(main, "_session", None)
    monkeypatch.setattr(recovery, "_discarding", {"20260101-000000-x"})
    assert client.get("/rig-tests/pending").json()["busy"] is True  # what accept refuses on
    monkeypatch.setattr(recovery, "_discarding", set())
    assert client.get("/rig-tests/pending").json()["busy"] is False


def test_the_run_carries_the_title_and_url_of_its_issue(client, rig, fake):
    _running(client, rig, fake)
    run = client.get("/rig-tests/run").json()
    assert run["title"] == "Rig test 231"
    assert run["url"] == "https://github.com/o/r/issues/231"


def test_relay_state_is_unknown_until_the_first_answer(client, rig, fake):
    assert client.get("/rig-tests/eligibility").json()["relay"] == "unknown"
    rig.poller.poll_once()
    assert client.get("/rig-tests/eligibility").json()["relay"] == "ok"


def test_decline_text_may_be_300_characters_and_no_more(client, rig, fake):
    _offer(rig, fake)
    long = client.post("/rig-tests/231/decline", json={"reason_code": "other", "text": "x" * 301})
    assert long.status_code == 422
    ok = client.post("/rig-tests/231/decline", json={"reason_code": "other", "text": "x" * 300})
    assert ok.status_code == 200


def test_snooze_hides_the_request_and_posts_the_comment_and_label(client, rig, fake):
    _offer(rig, fake)
    r = client.post("/rig-tests/231/snooze", json={"until": "2999-01-01T10:00:00"})
    assert r.json() == {"ok": True}
    assert client.get("/rig-tests/pending").json()["requests"] == []
    assert fake.last_state(231) == "deferred"
    ((number, body),) = fake.comments
    assert number == 231 and body.startswith("**Rig test #231 snoozed** on rig-1 until ")


def test_snooze_after_this_recording_waits_for_it_to_end(client, rig, fake, monkeypatch):
    _offer(rig, fake)
    monkeypatch.setattr(main, "_session", _Session("recording"))
    assert (
        client.post("/rig-tests/231/snooze", json={"until": "after_recording"}).status_code == 200
    )
    assert "recording is finished" in fake.comments[0][1]
    assert client.get("/rig-tests/pending").json()["requests"] == []
    monkeypatch.setattr(main, "_session", None)
    assert [r["number"] for r in client.get("/rig-tests/pending").json()["requests"]] == [231]


def test_a_snooze_comes_due_by_the_clock(client, rig, fake):
    _offer(rig, fake)
    now = [1_000_000.0]
    rig.poller._wall = lambda: now[0]
    client.post("/rig-tests/231/snooze", json={"until": "after_recording"})
    assert client.get("/rig-tests/pending").json()["requests"] == []
    now[0] += 5 * 3600  # never recorded: the 4 h fallback releases it
    assert len(client.get("/rig-tests/pending").json()["requests"]) == 1


def test_bad_snoozes_are_refused(client, rig, fake):
    _offer(rig, fake)
    assert client.post("/rig-tests/231/snooze", json={"until": "tomorrow-ish"}).status_code == 422
    assert (
        client.post("/rig-tests/231/snooze", json={"until": "2000-01-01T00:00:00"}).status_code
        == 422
    )
    assert (
        client.post("/rig-tests/999/snooze", json={"until": "after_recording"}).status_code == 404
    )
    assert fake.comments == []


def test_decline_posts_the_reason_and_label_and_removes_the_request(client, rig, fake):
    _offer(rig, fake)
    r = client.post(
        "/rig-tests/231/decline",
        json={"reason_code": "machine_in_use", "text": "Sam is mid-cut ``` C:\\Users\\sam\\x"},
    )
    assert r.json() == {"ok": True}
    assert fake.last_state(231) == "declined"
    body = fake.comments[0][1]
    assert body.startswith(
        "**Rig test #231 declined** on rig-1: Someone else is using the machine."
    )
    assert body.count("```") == 2 and "sam\\x" not in body and "<redacted>" in body
    assert client.get("/rig-tests/pending").json()["requests"] == []
    rig.poller.poll_once()  # the relay's cache still lists it unlabelled: we keep our decision
    assert client.get("/rig-tests/pending").json()["requests"] == []


def test_decline_rejects_unknown_reasons_and_requests(client, rig, fake):
    _offer(rig, fake)
    assert client.post("/rig-tests/231/decline", json={"reason_code": "because"}).status_code == 422
    assert client.post("/rig-tests/5/decline", json={"reason_code": "other"}).status_code == 404


# ---- accept ---------------------------------------------------------------------------------


def test_accept_refused_while_recording_or_finalizing(client, rig, fake, monkeypatch):
    _offer(rig, fake)
    for state in ("recording", "finalizing"):
        monkeypatch.setattr(main, "_session", _Session(state))
        r = _accept(client)
        assert r.status_code == 409 and "recording" in r.json()["detail"]
    assert not rig.runner.owns_rig() and fake.comments == []


def test_accept_refused_during_recovery_restore_or_discard(client, rig, fake, monkeypatch):
    _offer(rig, fake)
    for name in ("_recovering", "_discarding"):
        monkeypatch.setattr(recovery, name, {"20260101-000000-x"})
        r = _accept(client)
        assert r.status_code == 409 and "restore, recovery or discard" in r.json()["detail"]
        monkeypatch.setattr(recovery, name, set())
    assert not rig.runner.owns_rig()


def test_accept_refused_while_an_upload_is_in_flight(client, rig, fake):
    _offer(rig, fake)
    r = _accept(client, upload_busy=True)
    assert r.status_code == 409 and "upload" in r.json()["detail"]
    assert not rig.runner.owns_rig()


def test_accept_needs_a_pending_request_and_full_mode(client, rig, fake):
    assert _accept(client, number=7).status_code == 404  # nothing was ever offered
    _offer(rig, fake)
    r = client.post("/rig-tests/231/accept", json={"mode": "automated", "upload_busy": False})
    assert r.status_code == 422
    assert not rig.runner.owns_rig()


def test_a_second_accept_while_running_is_refused(client, rig, fake):
    _running(client, rig, fake)
    fake.requests = [issue(232, ASK)]
    rig.poller._store.update(pending=[])
    assert _accept(client, number=232).status_code == 409


# ---- a whole run over HTTP --------------------------------------------------------------------


def test_accept_answer_and_result_over_http(client, rig, fake, tmp_path):
    _running(client, rig, fake)
    run = client.get("/rig-tests/run").json()
    assert run["state"] == "running" and run["number"] == 231
    assert run["question"]["text"] == "Is the light on?"
    assert client.get("/rig-tests/pending").json()["requests"] == []
    assert (
        client.post("/rig-tests/run/answer", json={"step": 5, "option": "Pass"}).status_code == 409
    )
    assert (
        client.post("/rig-tests/run/answer", json={"step": 0, "option": "Nope"}).status_code == 400
    )
    ok = client.post("/rig-tests/run/answer", json={"step": 0, "option": "Pass", "note": "yes"})
    assert ok.json() == {"ok": True}
    wait_for(lambda: client.get("/rig-tests/run").json()["state"] == "done")
    rig.runner.join()
    assert fake.last_state(231) == "done"
    assert "accepted by op@lab" in fake.comments[0][1] + fake.edits[-1][2]
    hist = client.get("/rig-tests/history").json()["runs"]
    assert len(hist) == 1
    assert hist[0]["number"] == 231 and hist[0]["state"] == "done"
    assert hist[0]["pass"] == 1 and hist[0]["fail"] == 0 and hist[0]["total"] == 1
    assert hist[0]["items"] == [{"id": "inline", "result": "pass"}]
    # once the label is set the relay lists the issue as done: it is never offered again
    fake.requests = [issue(231, ASK, state_label="done")]
    rig.poller.poll_once()
    assert client.get("/rig-tests/pending").json()["requests"] == []


def test_cancel_over_http(client, rig, fake):
    _running(client, rig, fake)
    assert client.post("/rig-tests/run/cancel").json() == {"ok": True}
    wait_for(lambda: client.get("/rig-tests/run").json()["state"] == "cancelled")
    rig.runner.join()
    assert not rig.runner.owns_rig()
    assert client.post("/rig-tests/run/cancel").json() == {"ok": True}  # idempotent


def test_run_is_idle_with_nothing_started(client):
    assert client.get("/rig-tests/run").json() == {"state": "idle"}
    assert client.get("/rig-tests/history").json() == {"runs": []}


def test_history_keeps_the_latest_50_and_skips_damaged_files(client, rig, tmp_path):
    root = tmp_path / "captures" / "rig-tests"
    for n in range(1, 56):
        d = root / str(n)
        d.mkdir(parents=True)
        (d / "result.json").write_text(
            json.dumps({"number": n, "state": "done", "started_at": f"2026-10-11T10:{n:02d}:00",
                        "counts": {"pass": 2, "fail": 1}, "items": [{"id": "R4", "result": "fail"}]})
        )  # fmt: skip
    (root / "56").mkdir()
    (root / "56" / "result.json").write_text("{not json")
    runs = client.get("/rig-tests/history").json()["runs"]
    assert len(runs) == 50 and runs[0]["number"] == 55 and runs[-1]["number"] == 6
    assert runs[0]["total"] == 3 and runs[0]["fail"] == 1


# ---- the rig lock ----------------------------------------------------------------------------

# A body for each locked endpoint that is rejected on its own merits once the lock is gone (so the
# "after" half never changes the rig), except the ones that are harmless on the sim/mock rig.
_BODIES = {
    ("POST", "/record/start"): {"json": {"duration_sec": -1}},
    ("POST", "/record/start_replay"): {"files": {"file": ("x.bin", b"nope")}},
    ("POST", "/labamp/mode"): {"json": {"mode": "BOGUS"}},
    ("POST", "/labamp/autorange/apply"): {"json": {"headroom": 1.5}},
    ("POST", "/labamp/autorange/converge"): {"json": {"peaks": [40] * 8, "apply": True}},
    ("POST", "/labamp/sensors/write"): {"json": {}},
    ("POST", "/labamp/config"): {"json": {"channels": 99}},
    ("PUT", "/nidaq/channels"): {"json": {"channels": "not a list"}},
    ("POST", "/nidaq/channels/autoassign"): {"json": {}},
    ("POST", "/nidaq/tacho/start"): {"json": {"freq_hz": 0}},
    ("POST", "/storage/config"): {"json": {}},
}


def test_every_locked_endpoint_has_a_probe():
    assert set(_BODIES) == set(LOCKED)


@pytest.mark.parametrize("method,path", sorted(LOCKED))
def test_locked_endpoint_is_409_during_an_automated_step_and_not_after(
    client, rig, fake, method, path
):
    _running(client, rig, fake)
    rig.runner.set_automated_step_active(True)  # phase 2's executor does this around an action
    r = client.request(method, path, **_BODIES[(method, path)])
    assert r.status_code == 409 and r.json()["detail"] == LOCK_MESSAGE
    rig.runner.set_automated_step_active(False)
    r = client.request(method, path, **_BODIES[(method, path)])
    assert r.status_code != 409 or r.json()["detail"] != LOCK_MESSAGE


@pytest.mark.parametrize("method,path", sorted(LOCKED))
def test_manual_steps_leave_the_rig_free_for_the_operator(client, rig, fake, method, path):
    """Phase 1 steps are all ask/note: the operator must be able to record, change the amp mode and
    edit channels while the question is open (B1)."""
    _running(client, rig, fake)
    assert rig.runner.owns_rig() and not rig.runner.automated_step_active()
    r = client.request(method, path, **_BODIES[(method, path)])
    assert r.status_code != 409 or r.json()["detail"] != LOCK_MESSAGE


def test_the_flag_ends_with_the_run_and_means_nothing_without_one(client, rig, fake):
    rig.runner.set_automated_step_active(True)  # no run: not locked
    assert not rig.runner.automated_step_active()
    assert client.post("/nidaq/tacho/stop").status_code == 200
    rig.runner.set_automated_step_active(False)
    _running(client, rig, fake)
    rig.runner.set_automated_step_active(True)
    assert rig.runner.automated_step_active()
    client.post("/rig-tests/run/cancel")
    rig.runner.join()
    assert not rig.runner.automated_step_active()


def test_reads_stay_open_during_a_run(client, rig, fake):
    _running(client, rig, fake)
    rig.runner.set_automated_step_active(True)
    for path in ("/health", "/record/status", "/labamp/status", "/captures", "/nidaq/devices"):
        assert client.get(path).status_code == 200, path


def test_nidaq_changes_outside_the_table_are_refused_by_the_busy_helper(client, rig, fake):
    """`_refuse_nidaq_change_if_busy()` carries the check itself, so endpoints that are not in the
    LOCKED table (tacho stop, simulated cards) are covered too."""
    _running(client, rig, fake)
    rig.runner.set_automated_step_active(True)
    for method, path, kw in (
        ("POST", "/nidaq/tacho/stop", {}),
        ("POST", "/nidaq/sim/card", {"json": {"slot": 1, "product_type": "x"}}),
        ("DELETE", "/nidaq/sim/card?slot=1", {}),
    ):
        r = client.request(method, path, **kw)
        assert r.status_code == 409 and r.json()["detail"] == LOCK_MESSAGE, path


def _flip_on_nth_busy_call(monkeypatch, rig, nth):
    real_busy, calls = main._busy, []

    def busy():
        calls.append(1)
        if len(calls) == nth:  # the re-check after the awaits: an automated step starts just before
            rig.runner.set_automated_step_active(True)
        return real_busy()

    monkeypatch.setattr(main, "_busy", busy)
    monkeypatch.setattr(main, "_session", None)


def test_record_start_rechecks_the_lock_after_its_awaits(client, rig, fake, monkeypatch):
    """/record/start re-checks `_busy()` after its awaits, so an automated step can begin between
    its first check and the assignment. The re-check must refuse then too."""
    _running(client, rig, fake)
    _flip_on_nth_busy_call(monkeypatch, rig, 2)
    r = client.post("/record/start", json={})
    assert r.status_code == 409 and r.json()["detail"] == LOCK_MESSAGE
    assert main._session is None


def test_autorange_converge_rechecks_the_lock_before_writing_the_amp(
    client, rig, fake, monkeypatch
):
    _running(client, rig, fake)
    _flip_on_nth_busy_call(monkeypatch, rig, 1)  # the apply branch's own check is the first
    r = client.post("/labamp/autorange/converge", json={"peaks": [40] * 8, "apply": True})
    assert r.status_code == 409 and r.json()["detail"] == LOCK_MESSAGE


def test_the_results_folder_is_not_listed_as_a_capture(client, rig, monkeypatch, tmp_path):
    root = tmp_path / "captures"
    (root / "rig-tests" / "231").mkdir(parents=True)
    (root / "20260101-000000-abc123").mkdir()
    monkeypatch.setattr(main, "CAPTURES_ROOT", str(root))
    assert client.get("/captures").json() == {"captures": ["20260101-000000-abc123"]}
    ids = [c["id"] for c in client.get("/captures/browse").json()["captures"]]
    assert ids == ["20260101-000000-abc123"]


def test_state_file_survives_a_restart(rig, fake, client, tmp_path):
    _offer(rig, fake)
    client.post("/rig-tests/231/snooze", json={"until": "2999-01-01T10:00:00"})
    again = StateFile(str(tmp_path / "cfg" / "rig_tests_state.json"))
    assert "231" in again.get("snoozes") and again.get("pending")[0]["number"] == 231
