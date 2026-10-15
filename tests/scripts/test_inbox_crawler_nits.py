# ruff: noqa: F811
"""Review item 11: auto-link client hardening, attempt expiry, pins, matching below the owner folder, files
still being written, and a bad log level."""

from __future__ import annotations

import logging
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

from inbox_crawler import autolink, recognise  # noqa: E402

SECRET = "s3cret-value-123"

# ---- the auto-link client does not follow redirects and ignores proxy settings -------------------------


class Redirecting:
    """A fake d1-inbox that answers every POST with a redirect, and records every request it receives."""

    def __init__(self, code=302):
        self.seen: list[tuple[str, dict]] = []
        outer = self

        class H(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802
                self.rfile.read(int(self.headers.get("Content-Length", 0)))
                outer.seen.append((self.path, dict(self.headers)))
                self.send_response(code)
                self.send_header("Location", "/somewhere/else")
                self.send_header("Content-Length", "0")
                self.end_headers()

            do_GET = do_POST  # noqa: N815

            def log_message(self, *a):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(
            target=lambda: self.server.serve_forever(poll_interval=0.02), daemon=True
        ).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


@pytest.mark.parametrize("code", [301, 302, 303, 307, 308])
def test_a_redirect_is_not_followed_and_the_secret_goes_nowhere_else(code):
    srv = Redirecting(code)
    try:
        linker = autolink.AutoLinker(srv.url, SECRET, timeout=5)
        with pytest.raises(autolink.AutoLinkUnavailable):
            linker.offer(["c1"])
        assert [p for p, _ in srv.seen] == [
            "/d1-inbox/auto-link"
        ]  # exactly one request, never the Location
    finally:
        srv.close()


def test_proxy_settings_in_the_environment_are_ignored(monkeypatch):
    from test_inbox_crawler_daemon import FakeInbox

    for k in (
        "http_proxy",
        "HTTP_PROXY",
        "https_proxy",
        "HTTPS_PROXY",
        "all_proxy",
        "ALL_PROXY",
    ):
        monkeypatch.setenv(k, "http://127.0.0.1:9")  # nothing listens there
    monkeypatch.delenv("no_proxy", raising=False)
    monkeypatch.delenv("NO_PROXY", raising=False)
    inbox = FakeInbox()
    try:
        out = autolink.AutoLinker(inbox.url, SECRET, timeout=5).offer(["c1"])
        assert out and out[0]["status"] == "linked"
        assert len(inbox.requests) == 1
    finally:
        inbox.close()


def test_the_client_never_sends_anything_but_the_secret_header_and_json():
    srv = Redirecting(500)
    try:
        with pytest.raises(autolink.AutoLinkUnavailable):
            autolink.AutoLinker(srv.url, SECRET, timeout=5).offer(["c1"])
        headers = {k.lower(): v for k, v in srv.seen[0][1].items()}
        assert headers["x-inbox-crawler-secret"] == SECRET
        assert headers["content-type"] == "application/json"
    finally:
        srv.close()


# ---- 'attempted' entries expire after an hour ----------------------------------------------------------


class FakeStore:
    def __init__(self, ids):
        self.ids = ids

    def autolink_person_ids(self):
        return {"p"}

    def autolink_candidates(self, people, limit=200):
        return [{"candidate_id": i} for i in self.ids]


class FakeLinker:
    enabled = True

    def __init__(self, status="skipped"):
        self.asked: list[list[str]] = []
        self.status = status

    def offer(self, ids):
        self.asked.append(list(ids))
        return [
            {"candidate_id": i, "status": self.status, "reason": "NOT_EDITABLE"}
            for i in ids
        ]


def test_a_refused_candidate_is_asked_again_after_an_hour_not_before():
    store, linker, attempted = FakeStore(["c1"]), FakeLinker("skipped"), {}
    t = {"now": 1000.0}
    now = lambda: t["now"]  # noqa: E731
    autolink.run_auto_link(store, linker, attempted, now=now)
    assert linker.asked == [["c1"]]
    t["now"] += autolink.ATTEMPT_TTL_S - 1
    autolink.run_auto_link(store, linker, attempted, now=now)
    assert linker.asked == [["c1"]]  # still remembered
    t["now"] += 2
    autolink.run_auto_link(store, linker, attempted, now=now)
    assert linker.asked == [
        ["c1"],
        ["c1"],
    ]  # expired: asked again (the person may have got edit rights since)


def test_the_expiry_is_an_hour_and_old_entries_do_not_pile_up():
    assert autolink.ATTEMPT_TTL_S == 3600
    attempted = {"gone": 0.0}
    autolink.run_auto_link(FakeStore([]), FakeLinker(), attempted, now=lambda: 10_000.0)
    assert attempted == {}


# ---- the pip pins are exact, the same in both places, and inside what requirements.txt allows ---------


def _specs(text):
    return {
        m.group(1).lower(): m.group(0).strip()
        for m in re.finditer(r"(psycopg2-binary|Pillow)[<>=!~][^\s\"']*", text, re.I)
    }


def _version(spec):
    return tuple(int(x) for x in re.findall(r"\d+", spec.split("=", 1)[1].lstrip("=")))


def test_the_compose_service_and_make_target_pin_exact_versions_that_requirements_allows():
    floor = _specs((ROOT / "scripts/requirements.txt").read_text())
    assert set(floor) == {"psycopg2-binary", "pillow"}
    compose = (ROOT / "docker-compose.yml").read_text()
    block = compose[compose.index("  inbox-crawler:") :]
    block = block[: block.index("\nvolumes:")]
    make = (ROOT / "Makefile").read_text()
    once = make[make.index("inbox-crawler-once:") :].split("\n\n")[0]
    pinned = _specs(block)
    assert pinned == _specs(once)  # the daemon and the one-off scan run the same code
    assert set(pinned) == set(floor)
    for name, spec in pinned.items():
        assert re.fullmatch(
            r"[A-Za-z0-9-]+==\d+(\.\d+)+", spec
        ), spec  # exact, never a range
        assert _version(spec) >= _version(
            floor[name]
        ), spec  # and not below requirements.txt's floor
    assert pinned["pillow"] == "Pillow==12.3.0"
    assert pinned["psycopg2-binary"] == "psycopg2-binary==2.9.13"
    assert "pip install -q psycopg2-binary Pillow" not in block  # no unpinned install


# ---- recognition looks only below the owner's folder ----------------------------------------------------


@pytest.fixture
def lookup():
    return recognise.build_lookup(
        [("3fa9c1d2", "physical_samples", "S1")],
        [("SB-24-0117", "physical_samples", "S2")],
        [],
    )


def test_an_alias_that_looks_like_a_short_id_is_not_a_match(lookup):
    assert (
        recognise.recognise("Users/3fa9c1d2/IMG_0001.tif", lookup).match_strength
        == "short_id"
    )  # whole path
    r = recognise.recognise(
        "Users/3fa9c1d2/IMG_0001.tif", lookup, below="Users/3fa9c1d2"
    )
    assert r.match_strength == "none" and r.matches == []


def test_a_share_folder_that_looks_like_a_code_is_not_a_match(lookup):
    r = recognise.recognise(
        "Shared/SB-24-0117/a.tif", lookup, below="Shared/SB-24-0117"
    )
    assert r.match_strength == "none"


def test_a_name_below_the_owner_folder_still_matches(lookup):
    r = recognise.recognise(
        "Users/3fa9c1d2/sem/3fa9c1d2.tif", lookup, below="Users/3fa9c1d2"
    )
    assert r.match_strength == "short_id" and r.suggested_record_id == "S1"
    r = recognise.recognise("Users/abc/SB-24-0117/a.tif", lookup, below="Users/abc")
    assert r.match_strength == "code"


def test_below_matches_whole_folders_only():
    lk = recognise.build_lookup([("3fa9c1d2", "physical_samples", "S1")], [], [])
    # "Users/abc" is not the owner folder of "Users/abcdef/...": nothing is stripped
    r = recognise.recognise("Users/abcdef/3fa9c1d2.tif", lk, below="Users/abc")
    assert r.match_strength == "short_id"


# ---- a bad log level does not crash the service --------------------------------------------------------


@pytest.mark.parametrize("bad", ["LOUD", "", "10x", "verbose", "None"])
def test_an_invalid_log_level_falls_back_to_info_with_a_warning(
    monkeypatch, caplog, bad
):
    from inbox_crawler import __main__ as cli

    monkeypatch.setenv("INBOX_LOG_LEVEL", bad)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    with caplog.at_level(logging.WARNING):
        assert cli.main(["--once"]) == 2  # stops for the missing DSN, not for the level
    if bad:
        assert "INBOX_LOG_LEVEL" in caplog.text
    assert "DATABASE_URL is required" in caplog.text


def test_a_valid_log_level_is_used(monkeypatch):
    from inbox_crawler import __main__ as cli

    assert cli._log_level("debug") == logging.DEBUG
    assert cli._log_level("WARNING") == logging.WARNING
    assert cli._log_level(None) == logging.INFO


# ---- a file still being written is left for the next scan ----------------------------------------------

psycopg2 = pytest.importorskip("psycopg2")
from test_inbox_crawler_scan import (  # noqa: E402, F401
    baselined,
    cands,
    make,
    png,
    run,
    settle,
)
from test_inbox_crawler_world import world  # noqa: E402, F401


def test_a_file_modified_in_the_last_five_seconds_is_skipped_this_scan(world):
    world.person("abc12de")
    world.write("Users/abc12de/done.png", png((1, 1, 1)))
    world.write("Users/abc12de/writing.png", png((2, 2, 2)), mtime=time.time() - 1)
    world.commit()
    settle(world)
    sc, spy, _ = make(world)
    stats = sc.scan()
    assert list(cands(world)) == ["Users/abc12de/done.png"]
    assert stats.errors == 0 and stats.registered == 1
    assert "Users/abc12de/writing.png" not in spy.opens  # not even read
    # next scan, the file has settled (the clock moved on): it is picked up
    sc2, _, _ = make(world, wall=lambda: time.time() + 10)
    stats2 = sc2.scan()
    assert stats2.registered == 1
    assert "Users/abc12de/writing.png" in cands(world)


def test_a_folder_named_like_a_short_id_does_not_suggest_that_record_for_every_file(
    world,
):
    world.person("3fa9c1d2")  # an alias that happens to be a record's short ID
    sid = world.sample("3fa9c1d2")
    world.write("Users/3fa9c1d2/plain.png", png((1, 1, 1)))
    world.write("Users/3fa9c1d2/sem/3fa9c1d2_scan.png", png((2, 2, 2)))
    world.commit()
    settle(world)
    run(world)
    rows = dict(
        world.q(
            "SELECT rel_path, match_strength || ':' || COALESCE(suggested_record_id::text, '') FROM file_candidates"
        )
    )
    assert rows["Users/3fa9c1d2/plain.png"] == "none:"
    assert rows["Users/3fa9c1d2/sem/3fa9c1d2_scan.png"] == f"short_id:{sid}"
    # and a later refresh does not change that
    from inbox_crawler import db

    store = db.Store(world.conn)
    assert store.refresh_recognition(store.load_lookup()) == 0


def test_a_file_a_little_older_than_five_seconds_is_registered_at_once(world):
    world.person("abc12de")
    world.write("Users/abc12de/a.png", png(), mtime=time.time() - 6)
    world.commit()
    settle(world)
    assert run(world)[0].registered == 1


def test_a_file_dated_slightly_in_the_future_is_also_left_for_later(world):
    world.person("abc12de")
    world.write(
        "Users/abc12de/a.png", png(), mtime=time.time() + 2
    )  # a clock a little ahead
    world.commit()
    settle(world)
    assert run(world)[0].registered == 0


def test_a_skipped_new_file_does_not_stop_the_baseline_or_get_marked_backlog_later(
    world,
):
    world.person("abc12de")
    world.write("Users/abc12de/old.png", png((1, 1, 1)))
    world.write("Users/abc12de/fresh.png", png((2, 2, 2)), mtime=time.time())
    world.commit()
    settle(world)
    run(world)
    assert baselined(world, "Users/abc12de") == (True,)
    sc, _, _ = make(world, wall=lambda: time.time() + 10)
    sc.scan()
    got = cands(world)
    assert got["Users/abc12de/old.png"][1] == "backlog"
    assert got["Users/abc12de/fresh.png"][1] == "new"  # it arrived after the baseline


def test_the_dir_of_a_skipped_file_is_listed_again_next_scan(world):
    world.person("abc12de")
    world.write("Users/abc12de/sub/fresh.png", png(), mtime=time.time())
    world.commit()
    settle(world)
    run(world)
    settle(world)  # the folder itself now looks old and unchanged
    sc, spy, _ = make(world, wall=lambda: time.time() + 10)
    stats = sc.scan()
    assert stats.registered == 1
    assert "Users/abc12de/sub" in spy.scandirs
