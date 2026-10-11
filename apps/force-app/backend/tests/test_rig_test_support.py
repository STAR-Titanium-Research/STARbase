"""Shared helpers for the rig-test tests (no tests of its own): a fake relay and request builders."""

from __future__ import annotations

import time

from app.rig_test import catalog, relay

BODY = "Please run these.\n\n```rig-test\n{block}\n```\n"


class FakeRelay:
    """Stands in for app.rig_test.relay: records every call, serves `requests`."""

    def __init__(self):
        self.requests: list[dict] = []
        self.comments: list[tuple[int, str]] = []
        self.edits: list[tuple[int, object, str]] = []
        self.states: list[tuple[int, str]] = []
        self.list_result: dict | None = None  # overrides the list answer, e.g. a failure
        self._next_id = 1000

    def install(self, monkeypatch) -> FakeRelay:
        monkeypatch.setattr(relay, "list_requests", self.list_requests)
        monkeypatch.setattr(relay, "post_comment", self.post_comment)
        monkeypatch.setattr(relay, "edit_comment", self.edit_comment)
        monkeypatch.setattr(relay, "set_state", self.set_state)
        return self

    def list_requests(self) -> dict:
        return self.list_result or {"ok": True, "requests": list(self.requests)}

    def post_comment(self, number, body) -> dict:
        self._next_id += 1
        self.comments.append((number, body))
        return {"ok": True, "id": self._next_id}

    def edit_comment(self, number, comment_id, body) -> dict:
        self.edits.append((number, comment_id, body))
        return {"ok": True}

    def set_state(self, number, state) -> dict:
        self.states.append((number, state))
        return {"ok": True}

    def last_state(self, number: int) -> str | None:
        return next((s for n, s in reversed(self.states) if n == number), None)


def issue(number: int = 231, block: str = "items: [R4]", **extra) -> dict:
    """A relay issue dict whose body holds `block` as its rig-test fence."""
    return {
        "number": number,
        "title": f"Rig test {number}",
        "body": BODY.format(block=block),
        "url": f"https://github.com/o/r/issues/{number}",
        "requested_by": "dpremoli",
        "created_at": f"2026-10-11T10:{number % 60:02d}:00Z",
        "state_label": None,
        **extra,
    }


def inline_request(steps_yaml: str, number: int = 231) -> dict:
    """A contract Request built from inline `steps:` (no catalogue involved)."""
    block = "steps:\n" + "\n".join("  " + line for line in steps_yaml.strip().splitlines())
    resolved = catalog.parse_request(BODY.format(block=block), catalog={})
    return resolved.as_request(number, issue(number))


def wait_for(cond, timeout: float = 5.0) -> None:
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return
        time.sleep(0.01)
    raise AssertionError("timed out waiting for condition")


class Clock:
    """A manual monotonic clock for the runner."""

    def __init__(self, t: float = 1000.0):
        self.t = t

    def __call__(self) -> float:
        return self.t

    def advance(self, seconds: float) -> None:
        self.t += seconds
