# ruff: noqa: F811
"""The daemon (plan C6): control row, heartbeat, requests, schedule, auto-link, adopted hashing.

Postgres-backed (throwaway schema); the d1-inbox extension is a fake HTTP server in a thread.
"""

from __future__ import annotations

import hashlib
import json
import logging
import sys
import threading
import uuid
from datetime import UTC, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

pytest.importorskip("psycopg2")
import index_archive as ia  # noqa: E402
from inbox_crawler import autolink, daemon, db, fs_readonly  # noqa: E402
from test_inbox_crawler_scan import SpyShare, png, settle  # noqa: E402
from test_inbox_crawler_world import world  # noqa: E402, F401

SECRET = "s3cret-value-123"


def make_daemon(world, *, linker=None, now=None):
    spy = SpyShare(fs_readonly.Share(world.root))
    store = db.Store(world.conn)
    d = daemon.Daemon(
        store,
        spy,
        linker,
        config=daemon.Config(tick_s=0.01, error_sleep_s=0.01),
        **({"now": now} if now else {}),
    )
    return d, spy, store


def state(world):
    cur = world.conn.cursor()
    cur.execute("SELECT * FROM inbox_crawler_state")
    cols = [c[0] for c in cur.description]
    return dict(zip(cols, cur.fetchone(), strict=True))


@pytest.fixture
def populated(world):
    world.person("abc12de", user=True)
    world.write("Users/abc12de/sem/a.png", png((1, 1, 1)))
    world.write("Users/abc12de/notes.pdf", b"%PDF notes")
    settle(world)
    return world


# ---- control row, heartbeat, pause --------------------------------------------------------


def test_a_tick_writes_the_heartbeat_and_scans_when_nothing_has_run_yet(populated):
    world = populated
    d, _, _ = make_daemon(world)
    assert d.tick() == "scheduled"
    s = state(world)
    assert s["last_heartbeat_at"] is not None and s["current_activity"]
    assert (
        s["last_scan_started_at"] is not None and s["last_scan_finished_at"] is not None
    )
    assert s["files_registered"] == 2 and s["error_count"] == 0
    assert s["unmatched_folders"] == []


def test_a_paused_daemon_keeps_its_heartbeat_and_scans_nothing(populated):
    world = populated
    world.q("UPDATE inbox_crawler_state SET desired_state = 'paused'")
    world.q("INSERT INTO inbox_scan_requests (scope) VALUES ('all')")
    world.commit()
    d, spy, _ = make_daemon(world)
    assert d.tick() == "paused"
    s = state(world)
    assert s["current_activity"] == "paused" and s["last_heartbeat_at"] is not None
    assert s["last_scan_started_at"] is None and spy.scandirs == []
    assert (
        world.one("SELECT status FROM inbox_scan_requests")[0] == "queued"
    )  # not claimed
    assert world.one("SELECT count(*) FROM file_candidates")[0] == 0


def test_a_missing_state_row_is_reported_not_crashed_on(populated):
    world = populated
    world.q("DELETE FROM inbox_crawler_state")
    world.commit()
    d, _, _ = make_daemon(world)
    assert d.tick() == "no-state"


def test_the_throttle_follows_the_state_row(populated):
    world = populated
    world.q("UPDATE inbox_crawler_state SET read_mb_per_s = 5")
    world.commit()
    d, _, _ = make_daemon(world)
    d.tick()
    assert d.throttle.rate == 5 * 1024 * 1024


# ---- the schedule ---------------------------------------------------------------------------


def test_the_scheduled_scan_waits_for_the_interval(populated):
    world = populated
    clock = {"t": datetime.now(UTC)}
    d, _, _ = make_daemon(world, now=lambda: clock["t"])
    assert d.tick() == "scheduled"
    assert d.tick() == "idle"  # 30 minutes have not passed
    clock["t"] += timedelta(minutes=29)
    assert d.tick() == "idle"
    clock["t"] += timedelta(minutes=2)
    assert d.tick() == "scheduled"


def test_the_interval_comes_from_the_state_row(populated):
    world = populated
    world.q("UPDATE inbox_crawler_state SET interval_minutes = 5")
    world.commit()
    clock = {"t": datetime.now(UTC)}
    d, _, _ = make_daemon(world, now=lambda: clock["t"])
    d.tick()
    clock["t"] += timedelta(minutes=6)
    assert d.tick() == "scheduled"


def test_an_aborted_scan_does_not_advance_the_finished_time(populated):
    world = populated
    d, spy, _ = make_daemon(world)
    spy.vanish_after = 0
    assert d.tick() == "scheduled"
    s = state(world)
    assert s["last_scan_started_at"] is not None
    assert s["last_scan_finished_at"] is None
    assert "nothing marked gone" in s["last_error"] and s["error_count"] == 1
    assert world.one("SELECT count(*) FROM file_candidates")[0] == 0


def test_unmatched_folders_are_written_for_the_admin_list(populated):
    world = populated
    world.write("Users/zz9/x.png", png())
    world.write("Shared/Old project/y.png", png())
    settle(world)
    d, _, _ = make_daemon(world)
    d.tick()
    assert state(world)["unmatched_folders"] == ["Shared/Old project", "Users/zz9"]


# ---- requests ---------------------------------------------------------------------------------


def test_a_person_request_scans_that_person_and_ends_done(populated):
    world = populated
    pid = world.one("SELECT person_id::text FROM people")[0]
    world.write("Users/other1/x.png", png())
    world.person("other1")
    settle(world)
    world.q(
        "INSERT INTO inbox_scan_requests (scope, person_id) VALUES ('person', %s)",
        (pid,),
    )
    world.commit()
    d, _, _ = make_daemon(world)
    assert d.tick() == "request"
    row = world.one(
        "SELECT status, started_at IS NOT NULL, finished_at IS NOT NULL, error FROM inbox_scan_requests"
    )
    assert row == ("done", True, True, None)
    assert (
        world.one("SELECT count(*) FROM file_candidates")[0] == 2
    )  # only abc12de's folder
    assert (
        state(world)["last_scan_started_at"] is None
    )  # a one-person scan does not move the schedule


def test_an_all_request_scans_everyone(populated):
    world = populated
    world.person("other1")
    world.write("Users/other1/x.png", png())
    settle(world)
    world.q("INSERT INTO inbox_scan_requests (scope) VALUES ('all')")
    world.commit()
    d, _, _ = make_daemon(world)
    d.tick()
    assert world.one("SELECT status FROM inbox_scan_requests")[0] == "done"
    assert world.one("SELECT count(*) FROM file_candidates")[0] == 3
    assert state(world)["last_scan_started_at"] is not None


def test_a_request_for_someone_with_no_folder_fails_with_a_reason(world):
    pid, _ = world.person("abc12de")  # an alias, but no folder on the share
    world.write("Users/abc12de_not/x.png", png())
    world.q(
        "INSERT INTO inbox_scan_requests (scope, person_id) VALUES ('person', %s)",
        (pid,),
    )
    world.commit()
    d, _, _ = make_daemon(world)
    d.tick()
    row = world.one("SELECT status, error FROM inbox_scan_requests")
    assert row[0] == "failed" and "no folder to scan" in row[1]


def test_a_request_during_a_share_drop_fails_so_the_person_can_ask_again(populated):
    world = populated
    pid = world.one("SELECT person_id::text FROM people")[0]
    world.q(
        "INSERT INTO inbox_scan_requests (scope, person_id) VALUES ('person', %s)",
        (pid,),
    )
    world.commit()
    d, spy, _ = make_daemon(world)
    spy.vanish_after = 0
    d.tick()
    row = world.one("SELECT status, error FROM inbox_scan_requests")
    assert row[0] == "failed" and row[1]


def test_a_request_that_blows_up_still_ends_failed(populated, monkeypatch):
    world = populated
    world.q("INSERT INTO inbox_scan_requests (scope) VALUES ('all')")
    world.commit()
    d, _, _ = make_daemon(world)

    def boom(*a, **k):
        raise RuntimeError("postgres://u:SECRET@h/db is down")

    monkeypatch.setattr(d, "run_scan", boom)
    d.tick()
    row = world.one("SELECT status, error FROM inbox_scan_requests")
    assert row[0] == "failed" and "RuntimeError" in row[1] and "SECRET" not in row[1]


def test_requests_are_claimed_oldest_first_one_per_tick(populated):
    world = populated
    for _ in range(2):
        world.q("INSERT INTO inbox_scan_requests (scope) VALUES ('all')")
        world.q("SELECT pg_sleep(0.01)")
    world.commit()
    d, _, _ = make_daemon(world)
    d.tick()
    assert sorted(r[0] for r in world.q("SELECT status FROM inbox_scan_requests")) == [
        "done",
        "queued",
    ]


def test_two_daemons_never_claim_the_same_request(world):
    for _ in range(2):
        world.q("INSERT INTO inbox_scan_requests (scope) VALUES ('all')")
    world.commit()
    import psycopg2

    other_conn = psycopg2.connect(world.dsn)
    with other_conn.cursor() as cur:
        cur.execute(f"SET search_path = {world.schema}, public")
    other_conn.commit()
    try:
        a = db.Store(world.conn)
        b = db.Store(other_conn)
        # a holds a lock on the oldest queued request while b claims
        with world.conn.cursor() as cur:
            cur.execute(
                "SELECT request_id FROM inbox_scan_requests WHERE status = 'queued' "
                "ORDER BY requested_at, request_id LIMIT 1 FOR UPDATE"
            )
            locked = cur.fetchone()[0]
        got_b = b.claim_request()
        assert got_b is not None and got_b["request_id"] != str(locked)
        world.conn.rollback()
        got_a = a.claim_request()
        assert got_a is not None and got_a["request_id"] != got_b["request_id"]
        assert a.claim_request() is None
    finally:
        other_conn.close()


def test_stale_running_requests_fail_on_start_and_fresh_ones_stay(world):
    pid, _ = world.person("abc12de")
    p2, _ = world.person("zzz99")
    world.q(
        "INSERT INTO inbox_scan_requests (scope, person_id, status, started_at) "
        "VALUES ('person', %s, 'running', now() - interval '30 minutes')",
        (pid,),
    )
    world.q(
        "INSERT INTO inbox_scan_requests (scope, person_id, status, started_at) "
        "VALUES ('person', %s, 'running', now() - interval '5 minutes')",
        (p2,),
    )
    world.commit()
    assert db.Store(world.conn).fail_stale_requests() == 1
    rows = dict(world.q("SELECT person_id::text, status FROM inbox_scan_requests"))
    assert rows[pid] == "failed" and rows[p2] == "running"
    assert (
        "ask again"
        in world.one("SELECT error FROM inbox_scan_requests WHERE status = 'failed'")[0]
    )


# ---- hashing what a person linked ------------------------------------------------------------


def add_candidate(
    world,
    person_id,
    rel,
    *,
    kind="image",
    state="new",
    origin="new",
    strength="none",
    collection=None,
    record=None,
    adopted=False,
    duplicate_of=None,
    team_id=None,
    content=None,
):
    fid = str(ia.file_id(rel))
    world.q(
        "INSERT INTO directus_files (id, storage, filename_download) VALUES (%s, 'star', %s) ON CONFLICT DO NOTHING",
        (fid, rel.rsplit("/", 1)[-1]),
    )
    cid = str(uuid.uuid4())
    link = (
        ", link_kind, linked_collection, linked_junction_id, link_batch_id"
        if state == "linked"
        else ""
    )
    linkv = (
        ", 'manual', 'physical_samples', gen_random_uuid(), gen_random_uuid()"
        if state == "linked"
        else ""
    )
    world.q(
        "INSERT INTO file_candidates (candidate_id, directus_files_id, owner_person_id, owner_team_id, kind, "
        "state, origin, match_strength, suggested_collection, suggested_record_id, duplicate_of, rel_path, "
        f"adopted_at{link}) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, "
        f"{'now()' if adopted else 'NULL'}{linkv})",
        (
            cid,
            fid,
            None if team_id else person_id,
            team_id,
            kind,
            state,
            origin,
            strength,
            collection,
            record,
            duplicate_of,
            rel,
        ),
    )
    world.commit()
    return cid, fid


def test_a_linked_document_is_read_once_and_fingerprinted(populated):
    world = populated
    pid = world.one("SELECT person_id::text FROM people")[0]
    d, spy, _ = make_daemon(world)
    d.tick()  # registers everything; the pdf is listed only
    assert "Users/abc12de/notes.pdf" not in spy.opens
    world.q(
        "UPDATE file_candidates SET state = 'linked', adopted_at = now(), link_kind = 'manual', "
        "linked_collection = 'physical_samples', linked_junction_id = gen_random_uuid(), "
        "link_batch_id = gen_random_uuid() WHERE rel_path = 'Users/abc12de/notes.pdf'"
    )
    world.commit()
    d.tick()
    assert spy.opens.count("Users/abc12de/notes.pdf") == 1
    row = world.one(
        "SELECT f.status, f.content_sha256, f.size_bytes FROM file_fingerprints f JOIN file_candidates c "
        "ON c.directus_files_id = f.directus_files_id WHERE c.rel_path = 'Users/abc12de/notes.pdf'"
    )
    assert row == ("done", hashlib.sha256(b"%PDF notes").hexdigest(), 10)
    d.tick()
    d.tick()
    assert spy.opens.count("Users/abc12de/notes.pdf") == 1  # once, not every tick
    assert pid


def test_a_document_is_not_read_before_it_is_linked_or_after_an_undo(populated):
    world = populated
    d, spy, _ = make_daemon(world)
    d.tick()
    # adopted earlier, link undone since: state is back to 'new' but adopted_at stays set
    world.q(
        "UPDATE file_candidates SET adopted_at = now() WHERE rel_path = 'Users/abc12de/notes.pdf'"
    )
    world.commit()
    d.tick()
    # linked but never adopted (should not happen; still not read)
    assert "Users/abc12de/notes.pdf" not in spy.opens
    world.q(
        "UPDATE file_candidates SET adopted_at = NULL, state = 'linked', link_kind = 'manual', "
        "linked_collection = 'physical_samples', linked_junction_id = gen_random_uuid(), "
        "link_batch_id = gen_random_uuid() WHERE rel_path = 'Users/abc12de/notes.pdf'"
    )
    world.commit()
    d.tick()
    assert "Users/abc12de/notes.pdf" not in spy.opens


def test_a_failed_hash_is_retried_after_an_hour_not_before(populated):
    world = populated
    d, spy, _ = make_daemon(world)
    spy.fail[("open", "Users/abc12de/sem/a.png")] = PermissionError("denied")
    d.tick()
    assert spy.opens.count("Users/abc12de/sem/a.png") == 1
    d.tick()
    assert spy.opens.count("Users/abc12de/sem/a.png") == 1  # too soon
    spy.fail.clear()
    world.q(
        "UPDATE file_fingerprints SET hashed_at = now() - interval '2 hours' WHERE status = 'error'"
    )
    world.commit()
    d.tick()
    assert spy.opens.count("Users/abc12de/sem/a.png") == 2
    assert (
        world.one("SELECT count(*) FROM file_fingerprints WHERE status = 'done'")[0]
        == 1
    )


# ---- auto-link --------------------------------------------------------------------------------


class FakeInbox:
    """A fake d1-inbox extension: records what it is sent, answers from `reply`."""

    def __init__(self):
        self.requests: list[dict] = []
        self.status = 200
        self.reply = None  # callable(ids) -> results list
        outer = self

        class H(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802
                n = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(n) or b"{}")
                outer.requests.append(
                    {"path": self.path, "headers": dict(self.headers), "body": body}
                )
                ids = body.get("candidate_ids", [])
                results = (
                    outer.reply
                    or (
                        lambda ids: [
                            {
                                "candidate_id": i,
                                "status": "linked",
                                "link_batch_id": "b",
                            }
                            for i in ids
                        ]
                    )
                )(ids)
                data = json.dumps({"data": {"results": results}}).encode()
                self.send_response(outer.status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

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


@pytest.fixture
def inbox():
    f = FakeInbox()
    yield f
    f.close()


@pytest.fixture
def linkable(world):
    """An opted-in person, a sample, and a helper that adds eligible and ineligible candidates."""
    pid, uid = world.person("abc12de", user=True)
    sid = world.sample("3fa9c1d2")
    world.q("INSERT INTO inbox_prefs (user_id, auto_link) VALUES (%s, true)", (uid,))
    world.commit()
    return world, pid, uid, sid


def eligible(world, pid, sid, rel="Users/abc12de/3fa9c1d2.png", **kw):
    kw.setdefault("strength", "short_id")
    return add_candidate(
        world, pid, rel, collection="physical_samples", record=sid, **kw
    )[0]


def run_autolink(world, inbox, attempted=None, secret=SECRET):
    store = db.Store(world.conn)
    linker = autolink.AutoLinker(inbox.url, secret, timeout=5)
    attempted = {} if attempted is None else attempted
    return autolink.run_auto_link(store, linker, attempted), attempted


def test_an_exact_short_id_image_of_an_opted_in_person_is_offered(linkable, inbox):
    world, pid, _, sid = linkable
    cid = eligible(world, pid, sid)
    counts, attempted = run_autolink(world, inbox)
    assert counts == {"offered": 1, "linked": 1, "skipped": 0, "errors": 0}
    (req,) = inbox.requests
    assert req["path"] == "/d1-inbox/auto-link"
    assert req["headers"]["X-Inbox-Crawler-Secret"] == SECRET
    assert req["body"] == {"candidate_ids": [cid]}
    assert set(attempted) == {cid}


@pytest.mark.parametrize("kind", ["sem_image", "image"])
def test_the_two_image_kinds_are_offered(linkable, inbox, kind):
    world, pid, _, sid = linkable
    eligible(world, pid, sid, kind=kind)
    assert run_autolink(world, inbox)[0]["offered"] == 1


@pytest.mark.parametrize(
    "case",
    [
        {"kind": "document"},
        {"kind": "other"},
        {
            "kind": "surface_scan"
        },  # adding a scan needs a condition only a person can choose
        {"origin": "backlog"},
        {"state": "dismissed"},
        {"state": "linked"},
        {"strength": "code"},
        {"strength": "edge_code"},
        {"strength": "none"},
        {"duplicate_of": "COPY"},
    ],
    ids=lambda c: "-".join(f"{k}={v}" for k, v in c.items()),
)
def test_nothing_else_is_ever_offered(linkable, inbox, case):
    world, pid, _, sid = linkable
    case = dict(case)
    if case.get("duplicate_of") == "COPY":
        case["duplicate_of"] = add_candidate(world, pid, "Users/abc12de/orig.png")[0]
    eligible(world, pid, sid, **case)
    counts, _ = run_autolink(world, inbox)
    assert counts["offered"] == 0 and inbox.requests == []


def test_an_ambiguous_match_is_never_offered(linkable, inbox):
    world, pid, _, _ = linkable
    add_candidate(
        world, pid, "Users/abc12de/two.png", strength="short_id"
    )  # two records: no suggestion
    assert run_autolink(world, inbox)[0]["offered"] == 0


def test_a_person_who_opted_out_or_never_chose_is_never_offered(world, inbox):
    pid_off, uid_off = world.person("off1", user=True)
    pid_none, _ = world.person("none1", user=True)
    pid_nologin, _ = world.person("nologin1")
    sid = world.sample("3fa9c1d2")
    world.q(
        "INSERT INTO inbox_prefs (user_id, auto_link) VALUES (%s, false)", (uid_off,)
    )
    world.commit()
    for pid, n in ((pid_off, "a"), (pid_none, "b"), (pid_nologin, "c")):
        eligible(world, pid, sid, rel=f"Users/x/{n}/3fa9c1d2.png")
    assert run_autolink(world, inbox)[0]["offered"] == 0 and inbox.requests == []


def test_a_team_file_is_never_offered(linkable, inbox):
    world, pid, _, sid = linkable
    tid = world.team("Machining")
    add_candidate(
        world,
        None,
        "Shared/Machining/3fa9c1d2.png",
        strength="short_id",
        collection="physical_samples",
        record=sid,
        team_id=tid,
    )
    assert run_autolink(world, inbox)[0]["offered"] == 0


def test_no_secret_means_no_request_at_all(linkable, inbox):
    world, pid, _, sid = linkable
    eligible(world, pid, sid)
    counts, _ = run_autolink(world, inbox, secret="")
    assert counts["offered"] == 0 and inbox.requests == []


def test_a_definite_answer_is_not_asked_again_but_an_error_is(linkable, inbox):
    world, pid, _, sid = linkable
    done = eligible(world, pid, sid, rel="Users/abc12de/3fa9c1d2_a.png")
    skipped = eligible(world, pid, sid, rel="Users/abc12de/3fa9c1d2_b.png")
    failed = eligible(world, pid, sid, rel="Users/abc12de/3fa9c1d2_c.png")
    status = {done: "linked", skipped: "skipped", failed: "error"}
    inbox.reply = lambda ids: [
        {"candidate_id": i, "status": status[i], "reason": "X"} for i in ids
    ]
    _, attempted = run_autolink(world, inbox)
    assert set(attempted) == {done, skipped}
    inbox.requests.clear()
    run_autolink(world, inbox, attempted)
    assert [r["body"]["candidate_ids"] for r in inbox.requests] == [[failed]]


def test_batches_of_twenty(linkable, inbox):
    world, pid, _, sid = linkable
    for i in range(45):
        eligible(world, pid, sid, rel=f"Users/abc12de/3fa9c1d2_{i}.png")
    run_autolink(world, inbox)
    assert [len(r["body"]["candidate_ids"]) for r in inbox.requests] == [20, 20, 5]


@pytest.mark.parametrize("status", [500, 502, 404])
def test_a_failing_extension_leaves_the_candidates_for_next_time(
    linkable, inbox, status, caplog
):
    world, pid, _, sid = linkable
    eligible(world, pid, sid)
    inbox.status = status
    with caplog.at_level(logging.INFO):
        counts, attempted = run_autolink(world, inbox)
    assert attempted == {} and counts["linked"] == 0
    assert SECRET not in caplog.text


@pytest.mark.parametrize("status", [401, 403])
def test_a_refused_secret_is_reported_without_the_secret(
    linkable, inbox, status, caplog
):
    world, pid, _, sid = linkable
    eligible(world, pid, sid, rel="Users/abc12de/3fa9c1d2_a.png")
    eligible(world, pid, sid, rel="Users/abc12de/3fa9c1d2_b.png")
    inbox.status = status
    with caplog.at_level(logging.INFO):
        counts, attempted = run_autolink(world, inbox)
    assert attempted == {} and len(inbox.requests) == 1  # it stops asking
    assert "D1_INBOX_CRAWLER_SECRET" in caplog.text and SECRET not in caplog.text


def test_an_unreachable_extension_does_not_stop_the_crawler(linkable, caplog):
    world, pid, _, sid = linkable
    eligible(world, pid, sid)
    store = db.Store(world.conn)
    linker = autolink.AutoLinker("http://127.0.0.1:9", SECRET, timeout=1)
    with caplog.at_level(logging.INFO):
        counts = autolink.run_auto_link(store, linker, {})
    assert counts["linked"] == 0 and SECRET not in caplog.text


def test_the_crawler_never_writes_a_link_itself(linkable, inbox):
    world, pid, _, sid = linkable
    world.q(
        "CREATE TABLE IF NOT EXISTS operation_data_files (id serial, directus_files_id uuid)"
    )
    world.q(
        "CREATE TABLE IF NOT EXISTS session_data_files (id serial, directus_files_id uuid)"
    )
    eligible(world, pid, sid)
    run_autolink(world, inbox)
    for t in ("sample_data_files", "operation_data_files", "session_data_files"):
        assert world.one(f"SELECT count(*) FROM {t}")[0] == 0
    assert (
        world.one("SELECT state FROM file_candidates")[0] == "new"
    )  # only the extension changes it


def test_the_daemon_runs_auto_link_after_a_scan(world, inbox):
    pid, uid = world.person("abc12de", user=True)
    sid = world.sample("3fa9c1d2")
    world.q("INSERT INTO inbox_prefs (user_id, auto_link) VALUES (%s, true)", (uid,))
    world.write("Users/abc12de/seed.png", png((5, 5, 5)))
    settle(world)
    world.commit()
    linker = autolink.AutoLinker(inbox.url, SECRET, timeout=5)
    d, _, _ = make_daemon(world, linker=linker)
    d.tick()  # the first scan is the baseline: nothing there is new
    assert inbox.requests == []
    world.write("Users/abc12de/IMG_3fa9c1d2.png", png((6, 6, 6)))
    world.write("Users/abc12de/readme_3fa9c1d2.pdf", b"%PDF")
    world.write("Users/abc12de/IMG_00000000.png", png((7, 7, 7)))
    world.q(
        "UPDATE inbox_crawler_state SET interval_minutes = 1, last_scan_started_at = now() - interval '1 hour'"
    )
    world.commit()
    d.tick()
    (req,) = inbox.requests
    cid = world.one(
        "SELECT candidate_id::text FROM file_candidates WHERE rel_path LIKE '%IMG_3fa9c1d2.png'"
    )[0]
    assert req["body"]["candidate_ids"] == [
        cid
    ]  # the image; not the document, not the non-match
    assert sid


# ---- the loop -----------------------------------------------------------------------------------


def test_a_failed_iteration_is_survived_without_leaking_its_message(populated, caplog):
    world = populated
    d, _, store = make_daemon(world)
    calls = {"n": 0, "reconnects": 0}

    def tick():
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("could not connect: postgres://u:HUNTER2@h/db")
        d.stop_event.set()
        return "idle"

    d.tick = tick

    def reconnect(old):
        calls["reconnects"] += 1
        return old

    with caplog.at_level(logging.DEBUG):
        d.run_forever(reconnect)
    assert calls["n"] == 2 and calls["reconnects"] == 1
    assert "HUNTER2" not in caplog.text and "RuntimeError" in caplog.text
    assert state(world)["current_activity"] == "stopped"


def test_the_daemon_start_resets_stale_requests_and_records_the_start(world):
    pid, _ = world.person("abc12de")
    world.q(
        "INSERT INTO inbox_scan_requests (scope, person_id, status, started_at) "
        "VALUES ('person', %s, 'running', now() - interval '1 hour')",
        (pid,),
    )
    world.commit()
    d, _, _ = make_daemon(world)
    d.stop_event.set()
    d.run_forever(lambda s: s)
    assert world.one("SELECT status FROM inbox_scan_requests")[0] == "failed"
    assert state(world)["daemon_started_at"] is not None
