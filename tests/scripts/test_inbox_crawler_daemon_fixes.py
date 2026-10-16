# ruff: noqa: F811
"""Review fixes for the daemon: stale requests (item 5), and the auto-link client and eligibility (item 11)."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

pytest.importorskip("psycopg2")
from test_inbox_crawler_daemon import make_daemon  # noqa: E402, F401
from test_inbox_crawler_world import world  # noqa: E402, F401

# ---- item 5: a request left 'running' never locks a person out --------------------------------------


def running(world, person_id, minutes_ago):
    world.q(
        "INSERT INTO inbox_scan_requests (scope, person_id, status, started_at) "
        "VALUES ('person', %s, 'running', now() - make_interval(mins => %s))",
        (person_id, minutes_ago),
    )
    world.commit()


def statuses(world):
    return [
        r[0]
        for r in world.q("SELECT status FROM inbox_scan_requests ORDER BY requested_at")
    ]


def test_at_start_up_every_running_request_is_failed_whatever_its_age(world):
    p1, _ = world.person("aaa11")
    p2, _ = world.person("bbb22")
    running(
        world, p1, 1
    )  # even one that started a minute ago: there is one daemon, and it just started
    running(world, p2, 120)
    d, _, _ = make_daemon(world)
    d.stop_event.set()
    d.run_forever(lambda s: s)
    assert statuses(world) == ["failed", "failed"]
    assert "ask again" in world.one("SELECT error FROM inbox_scan_requests LIMIT 1")[0]


def test_a_stale_running_request_is_failed_by_the_next_tick(world):
    pid, _ = world.person("aaa11")
    running(world, pid, 30)
    d, _, _ = make_daemon(world)
    d.tick()
    assert statuses(world) == ["failed"]
    # so the person can ask again (one queued or running request per person)
    world.q(
        "INSERT INTO inbox_scan_requests (scope, person_id) VALUES ('person', %s)",
        (pid,),
    )
    world.commit()


def test_a_running_request_that_is_not_stale_yet_is_left_alone_by_a_tick(world):
    pid, _ = world.person("aaa11")
    running(world, pid, 2)
    d, _, _ = make_daemon(world)
    d.tick()
    assert statuses(world) == ["running"]


def test_the_stale_reset_runs_on_every_tick_not_only_at_start(world):
    pid, _ = world.person("aaa11")
    d, _, _ = make_daemon(world)
    d.tick()
    running(world, pid, 45)  # left behind after the daemon was already up
    d.tick()
    assert statuses(world) == ["failed"]


def test_a_paused_daemon_still_clears_stale_requests(world):
    pid, _ = world.person("aaa11")
    running(world, pid, 45)
    world.q("UPDATE inbox_crawler_state SET desired_state = 'paused'")
    world.commit()
    d, _, _ = make_daemon(world)
    assert d.tick() == "paused"
    assert statuses(world) == ["failed"]
