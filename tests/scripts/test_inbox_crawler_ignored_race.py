# ruff: noqa: F811
"""Ignored folders (spec section 15), review fixes: a rule that arrives while a scan runs, and the exact re-check.

M1: the owner's rules are read when the crawler starts the owner, before it lists a folder, before each batch of
registrations and (at most every RULES_TTL_S) before it reads a file, so a rule added while a big folder is being
walked stops the walk: nothing under a rule found at that moment is registered, classified, hashed or
thumbnailed, and a revived or restored file under a rule is never made `new` by the scan. The share is a real
temp tree; the "another session adds a rule" moment is a hook on the spy share (as `vanish_after` is).

Minor1: Postgres lower() and Python str.lower() disagree for a few letters (a final sigma, a dotted capital I);
the SQL clause is a pre-filter and the rows are checked again with owners.is_ignored.
Minor7: `_not_ignored` is one NOT EXISTS per owner kind (the partial owner indexes are usable) and the table
check is asked once per Store.
"""

from __future__ import annotations

import sys
from datetime import timedelta
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

pytest.importorskip("psycopg2")
from inbox_crawler import db, owners, scan  # noqa: E402
from test_inbox_crawler_daemon import add_candidate, make_daemon  # noqa: E402
from test_inbox_crawler_ignored_scan import (  # noqa: E402
    ME,
    PAPER,
    bump,
    papers,  # noqa: F401
    states,
    touched,
)
from test_inbox_crawler_scan import cands, make, png, run, settle  # noqa: E402
from test_inbox_crawler_world import world  # noqa: E402, F401


def after_first(spy, method: str, match, action) -> list:
    """Run `action` once, right after the spy's `method` ('scandir', 'stat' or 'open_rb') first answers for a
    path `match` accepts: the moment another session adds a rule. Returns the list of paths it fired on."""
    real = getattr(spy, method)
    fired: list[str] = []

    def hooked(rel="", *a, **kw):
        out = real(rel, *a, **kw)
        if not fired and match(rel):
            fired.append(rel)
            action()
        return out

    setattr(spy, method, hooked)
    return fired


# ---- a rule added between folders ------------------------------------------------------------------


def test_a_rule_added_between_folders_stops_the_walk_of_the_next_one(papers):
    world, pid = papers
    sc, spy, _ = make(world)
    # the root's listing is done when its scandir answers: the next folder popped is World-Ti Paper
    fired = after_first(
        spy,
        "scandir",
        lambda rel: rel == ME,
        lambda: world.ignore("World-Ti Paper", person=pid),
    )
    stats = sc.scan()
    assert fired == [ME]
    assert not stats.aborted and stats.errors == 0
    assert PAPER not in spy.scandirs and f"{PAPER}/Drafts" not in spy.scandirs
    assert [p for p in spy.opens if under_(p, PAPER)] == []
    got = cands(world)
    assert f"{PAPER}/x.png" not in got and f"{PAPER}/Drafts/y.png" not in got
    assert (
        f"{PAPER} 2/z.png" in got and f"{ME}/keep/a.png" in got
    )  # the rest is scanned
    assert stats.ignored_dirs >= 1


def under_(rel: str, folder: str) -> bool:
    return rel == folder or rel.startswith(folder + "/")


def test_the_same_scan_without_the_rule_registers_them(papers):
    """The control: the hook's rule is what keeps them out."""
    world, _pid = papers
    run(world)
    got = cands(world)
    assert f"{PAPER}/x.png" in got and f"{PAPER}/Drafts/y.png" in got


# ---- a rule added right before registration --------------------------------------------------------


@pytest.fixture
def big_folder(world, monkeypatch):
    """One folder of six images the scan has to register, and a lookalike folder."""
    pid, _ = world.person("abc12de", user=True)
    for i in range(6):
        world.write(f"{PAPER}/f{i}.png", png((i, 10, 10)))
    world.write(f"{PAPER} 2/z.png", png((9, 9, 9)))
    settle(world)
    return world, pid


def test_a_rule_added_while_a_file_is_hashed_registers_nothing_of_it(
    big_folder, monkeypatch
):
    """The rule lands after the first file was read: the look-again before it is used finds it, so the file is
    not classified, registered or given pictures, and no further file in the folder is opened."""
    world, pid = big_folder
    monkeypatch.setattr(scan, "RULES_TTL_S", 0.0)  # look at the rules before every file
    sc, spy, _ = make(world)
    fired = after_first(
        spy,
        "open_rb",
        lambda rel: rel.startswith(PAPER + "/"),
        lambda: world.ignore("World-Ti Paper", person=pid),
    )
    stats = sc.scan()
    assert len(fired) == 1
    assert not stats.aborted
    assert [
        p for p in spy.opens if under_(p, PAPER)
    ] == fired  # read once, then no more
    assert [r for r in cands(world) if under_(r, PAPER)] == []
    for table in ("file_thumbnails", "file_fingerprints"):
        q = (
            "SELECT count(*) FROM file_thumbnails t JOIN file_candidates c ON c.candidate_id = t.candidate_id "
            "WHERE c.rel_path LIKE %s"
            if table == "file_thumbnails"
            else "SELECT count(*) FROM file_fingerprints f JOIN directus_files d ON d.id = f.directus_files_id "
            "WHERE d.metadata->>'archive_path' LIKE %s"
        )
        assert world.one(q, (PAPER + "/%",)) == (0,), table
    assert f"{PAPER} 2/z.png" in cands(world)  # the lookalike is not covered


def test_a_rule_added_mid_folder_stops_the_folder_within_a_batch(
    big_folder, monkeypatch
):
    """With the default look-again interval (a few seconds, never reached here) the batch boundary is what
    notices the rule: files after the first batch are neither opened nor registered."""
    world, pid = big_folder
    monkeypatch.setattr(scan, "COMMIT_EVERY", 2)
    sc, spy, _ = make(world)
    second = f"{PAPER}/f1.png"
    fired = after_first(
        spy,
        "open_rb",
        lambda rel: rel == second,
        lambda: world.ignore("World-Ti Paper", person=pid),
    )
    sc.scan()
    assert fired == [second]
    got = sorted(r for r in cands(world) if under_(r, PAPER))
    assert got == [f"{PAPER}/f0.png", f"{PAPER}/f1.png"]  # the batch that was under way
    assert [p for p in spy.opens if under_(p, PAPER)] == got
    assert f"{PAPER} 2/z.png" in cands(world)


# ---- a restored or revived file under a rule is never made new by the scan ---------------------------


def test_a_restored_file_under_a_rule_stays_as_the_person_left_it(papers):
    """Dismissed by the rule, then restored by hand (state new): the scan neither lists the folder, nor marks the
    file gone, nor makes any other row new."""
    world, pid = papers
    run(world)
    world.ignore("World-Ti Paper", person=pid)
    world.q(
        "UPDATE file_candidates SET state = 'dismissed' WHERE rel_path LIKE %s",
        (PAPER + "/%",),
    )
    world.q(
        "UPDATE file_candidates SET state = 'new' WHERE rel_path = %s",
        (f"{PAPER}/x.png",),
    )  # restored
    world.commit()
    before = states(world)
    settle(world)
    bump(world, ME)
    bump(world, PAPER)
    stats, spy, _ = run(world)
    assert touched(spy, PAPER) == []
    assert states(world) == before
    assert stats.errors == 0


def test_a_gone_file_under_a_rule_added_mid_scan_is_not_revived(papers):
    world, pid = papers
    run(world)
    world.q(
        "UPDATE file_candidates SET state = 'gone' WHERE rel_path = %s",
        (f"{PAPER}/x.png",),
    )
    world.commit()
    settle(world)
    bump(world, ME)
    bump(world, PAPER)
    sc, spy, _ = make(world)
    after_first(
        spy,
        "scandir",
        lambda rel: rel == ME,
        lambda: world.ignore("World-Ti Paper", person=pid),
    )
    sc.scan()
    assert PAPER not in spy.scandirs
    assert (
        states(world)[f"{PAPER}/x.png"] == "gone"
    )  # the file is on the share, but not revived


def test_a_gone_file_is_revived_when_nothing_ignores_it(papers):
    """The control for the test above."""
    world, _pid = papers
    run(world)
    world.q(
        "UPDATE file_candidates SET state = 'gone' WHERE rel_path = %s",
        (f"{PAPER}/x.png",),
    )
    world.commit()
    settle(world)
    bump(world, ME)
    bump(world, PAPER)
    run(world)
    assert states(world)[f"{PAPER}/x.png"] == "new"


# ---- the exact re-check behind the SQL pre-filter ------------------------------------------------------

# (folder on the share, rule). Python and Postgres lower-case these differently:
#   a final sigma: Python 'ΑΣ'.lower() is 'ας', Postgres (C.UTF-8) gives 'ασ';
#   a dotted capital I: Python 'İ'.lower() is 'i' + U+0307, Postgres gives 'i'.
# Whatever the database does, a folder Python's owners.is_ignored says is ignored must never be read.
FUZZ = [
    ("ΑΣ", "ας"),
    ("ΟΔΟΣ/Sub", "οδος"),
    ("İstanbul", "i̇stanbul"),
    ("İstanbul", "istanbul"),
    ("Straße", "STRASSE"),
    ("Straße", "straße"),
    ("World-Ti Paper", "world-ti paper"),
    ("World-Ti Paper 2", "World-Ti Paper"),
    ("Ünï", "ünï"),
]


@pytest.fixture
def fuzz_world(world):
    """Per case two images in the folder: `err` has an earlier failed hash (for the retry queue) and `pic` has
    not (for the thumbnail backfill; it is also offered to auto-link, which wants a short ID)."""
    pid, _ = world.person("abc12de", user=True)
    sid = world.sample("3fa9c1d2")
    made = []
    for n, (folder, rule) in enumerate(FUZZ):
        ids = []
        for tag in ("err", "pic"):
            cid, fid = add_candidate(
                world,
                pid,
                f"{ME}/{folder}/{tag}{n}.png",
                strength="short_id",
                collection="physical_samples",
                record=sid,
            )
            world.q(
                "UPDATE file_candidates SET size_bytes = 100, source_mtime = now() WHERE candidate_id = %s",
                (cid,),
            )
            if tag == "err":
                world.q(
                    "INSERT INTO file_fingerprints (directus_files_id, status, error_message, hashed_at) "
                    "VALUES (%s, 'error', 'earlier', now() - interval '3 hours')",
                    (fid,),
                )
            ids.append(cid)
        made.append((ids[0], ids[1], folder, rule))
    for rule in sorted(
        {r.lower() for *_x, r in made}
    ):  # one rule per spelling the database accepts
        world.ignore(rule, person=pid)
    rules = [r for *_x, r in made]
    rows = [
        (err, pic, folder, owners.is_ignored(folder, rules))
        for err, pic, folder, _rule in made
    ]
    world.commit()
    return world, pid, rows


def test_every_candidate_query_drops_what_python_ignores(fuzz_world):
    world, pid, rows = fuzz_world
    store = db.Store(world.conn)
    thumbs = {t.candidate_id for t in store.candidates_missing_thumbnails(100)}
    hashes = {r[0] for r in store.errored_hashes(100)}
    links = {c["candidate_id"] for c in store.autolink_candidates({pid}, 100)}
    assert any(r[3] for r in rows) and not all(
        r[3] for r in rows
    )  # the table has both kinds
    for err, pic, folder, ignored in rows:
        if (
            ignored
        ):  # the dangerous direction: SQL must never hand over what Python excludes
            assert err not in hashes and pic not in thumbs, folder
            assert err not in links and pic not in links, folder
    # and the plain case is still offered: the folder that only starts like a rule
    err, pic, _f, _i = next(r for r in rows if r[2] == "World-Ti Paper 2")
    assert pic in thumbs and err in hashes and pic in links


def test_the_sigma_and_dotted_i_cases_are_ones_the_sql_clause_alone_lets_through(
    fuzz_world,
):
    """Why the Python re-check exists: the SQL clause alone hands these over when the database lower-cases them
    differently from Python (the C.UTF-8 database of CI and the dev container does for a final sigma)."""
    world, _pid, rows = fuzz_world
    store = db.Store(world.conn)
    kept_by_sql = {
        r[0]
        for r in world.q(
            "SELECT c.candidate_id::text FROM file_candidates c WHERE true"
            + store._not_ignored("c")
        )
    }
    through = [f for err, _pic, f, ignored in rows if ignored and err in kept_by_sql]
    if world.one("SELECT lower('ΑΣ')")[0] != "ας":
        assert "ΑΣ" in through
    # while the queries themselves do not hand it over
    assert "ΑΣ" not in {r[2].split("/")[2] for r in store.errored_hashes(100)}


def test_a_row_only_python_rejects_does_not_starve_the_ones_behind_it(world):
    """Three rejected rows first, one good one after: a page of one still finds the good one."""
    pid, _ = world.person("abc12de", user=True)
    world.ignore(
        "ας", person=pid
    )  # Python: covers folder ΑΣ; the SQL clause alone does not (C.UTF-8)
    bad = []
    for n in range(3):
        cid, fid = add_candidate(world, pid, f"{ME}/ΑΣ/b{n}.png")
        bad.append(cid)
    good, _ = add_candidate(world, pid, f"{ME}/keep/good.png")
    world.q(
        "UPDATE file_candidates SET size_bytes = 1, source_mtime = now(), first_seen_at = now() "
        "WHERE candidate_id = ANY(%s::uuid[])",
        ([*bad, good],),
    )
    # the rejected ones are the newest, and the thumbnail order is newest first: they come first
    world.q(
        "UPDATE file_candidates SET first_seen_at = now() + interval '1 hour' WHERE candidate_id = ANY(%s::uuid[])",
        (bad,),
    )
    world.commit()
    store = db.Store(world.conn)
    got = [t.candidate_id for t in store.candidates_missing_thumbnails(1)]
    assert got == [good]


# ---- the SQL clause: one NOT EXISTS per owner kind, the table check asked once ------------------------


def test_the_clause_has_one_not_exists_per_owner_kind_each_on_one_column(world):
    store = db.Store(world.conn)
    clause = store._not_ignored("c")
    assert clause.count("NOT EXISTS") == 2
    assert " OR " not in clause
    assert "ig.owner_person_id = c.owner_person_id" in clause
    assert "ig.owner_team_id = c.owner_team_id" in clause


def test_the_clause_can_use_the_partial_owner_indexes(world):
    pid, _ = world.person("abc12de")
    team = world.team("Machining")
    world.ignore("a", person=pid)
    world.ignore("b", team=team)
    world.commit()
    store = db.Store(world.conn)
    world.q("SET LOCAL enable_seqscan = off")
    plan = "\n".join(
        r[0]
        for r in world.q(
            "EXPLAIN SELECT 1 FROM file_candidates c WHERE true"
            + store._not_ignored("c")
        )
    )
    assert "idx_inbox_ignored_dirs_owner_person" in plan, plan
    assert "idx_inbox_ignored_dirs_owner_team" in plan, plan


def test_the_table_check_is_one_round_trip_per_store(world, monkeypatch):
    pid, _ = world.person("abc12de")
    store = db.Store(world.conn)
    asked = []
    real = store._one

    def counting(query, params=()):
        if "to_regclass('inbox_ignored_dirs')" in query:
            asked.append(1)
        return real(query, params)

    monkeypatch.setattr(store, "_one", counting)
    for _ in range(3):
        store.candidates_missing_thumbnails(10)
        store.errored_hashes(10)
        store.autolink_candidates({pid})
        store.load_ignored_for(
            owners.Owner("person", pid, ME, "abc12de", claim="abc12de")
        )
    assert len(asked) == 1


def test_a_missing_table_is_looked_for_again_after_a_while(world):
    store = db.Store(world.conn)
    world.q("ALTER TABLE inbox_ignored_dirs RENAME TO inbox_ignored_dirs_away")
    world.commit()
    assert store._not_ignored("c") == ""  # no table: nothing to apply
    world.q("ALTER TABLE inbox_ignored_dirs_away RENAME TO inbox_ignored_dirs")
    world.commit()
    assert (
        store._not_ignored("c") == ""
    )  # still the earlier answer: it is not asked every call
    found, asked = store._ignored_table
    store._ignored_table = (
        found,
        asked - db.IGNORED_TABLE_RECHECK - timedelta(seconds=1),
    )
    assert "NOT EXISTS" in store._not_ignored("c")  # asked again, found


def test_the_daemon_step_reads_nothing_under_a_rule_added_after_it_was_offered(world):
    """The daemon's hash retry asks the store each tick, so a rule added between ticks holds at once."""
    pid, _ = world.person("abc12de")
    world.write(f"{PAPER}/x.png", png((1, 2, 3)))
    settle(world)
    _c, fid = add_candidate(world, pid, f"{PAPER}/x.png")
    world.q(
        "INSERT INTO file_fingerprints (directus_files_id, status, error_message, hashed_at) "
        "VALUES (%s, 'error', 'earlier', now() - interval '3 hours')",
        (fid,),
    )
    world.commit()
    d, spy, _ = make_daemon(world)
    world.ignore("World-Ti Paper", person=pid)
    world.commit()
    assert d.hash_pending() == 0
    assert touched(spy, PAPER) == []
