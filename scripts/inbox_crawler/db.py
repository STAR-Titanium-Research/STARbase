"""Everything the crawler reads from and writes to Postgres, in one place.

Tables: `d1_private.file_candidates`, `inbox_dirs`, `inbox_scan_requests`, `inbox_crawler_state`,
`inbox_prefs` (migration 193), plus `directus_files`, `directus_folders`, `file_fingerprints`, `people`,
`teams`, `short_ids` and the record tables it reads for recognition. The crawler never writes a junction
row or a link (invariant 5): that is the d1-inbox extension's job.

The connection's search_path is `<private schema>, public`, so the SQL below names tables bare. Tests point
the private schema at a throwaway schema that carries every table.

Methods do not commit unless they say so; the scan loop commits at the points that make a restart safe.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from . import identity, recognise
from .hashing import HashOutcome
from .identity import FILENAME_DISK_MAX, file_id, folder_id, guess_type
from .owners import Owner

log = logging.getLogger("inbox_crawler.db")

STATE_ID = "00000000-0000-0000-0000-000000000001"
_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
# A request left 'running' longer than this belongs to a daemon that died.
STALE_REQUEST_MINUTES = 15
# An errored hash is tried again no sooner than this.
HASH_RETRY_HOURS = 1


def connect(dsn: str, private_schema: str = "d1_private"):
    """A connection with the private schema first on the search path. Never logs the DSN."""
    import psycopg2
    from psycopg2 import sql

    conn = psycopg2.connect(dsn)
    conn.autocommit = False
    with conn.cursor() as cur:
        cur.execute(
            sql.SQL("SET search_path TO {}, public").format(
                sql.Identifier(private_schema)
            )
        )
    conn.commit()
    return conn


def to_datetime(mtime_ns: int) -> datetime:
    """A file's modification time as an exact (microsecond) timestamp, so equal times compare equal."""
    return _EPOCH + timedelta(microseconds=mtime_ns // 1000)


@dataclass(frozen=True)
class DirRow:
    dir_mtime: datetime | None
    last_listed_at: datetime | None


@dataclass(frozen=True)
class Cand:
    candidate_id: str
    directus_files_id: str
    rel_path: str
    state: str
    kind: str


@dataclass(frozen=True)
class RegisterResult:
    candidate_id: str | None
    created: bool
    duplicate_of: str | None = None


class Store:
    def __init__(
        self, conn, *, storage: str = "star", root_folder_name: str = "star_group1"
    ):
        self.conn = conn
        self.storage = storage
        self.root_folder_name = root_folder_name
        self._folders_done: set[str] = set()

    # ---- plumbing --------------------------------------------------------------------

    def commit(self) -> None:
        self.conn.commit()

    def rollback(self) -> None:
        self.conn.rollback()
        self._folders_done.clear()  # the folder rows may have been rolled back with it

    def _all(self, query: str, params=()):
        with self.conn.cursor() as cur:
            cur.execute(query, params)
            return cur.fetchall()

    def _one(self, query: str, params=()):
        with self.conn.cursor() as cur:
            cur.execute(query, params)
            return cur.fetchone()

    def _run(self, query: str, params=()) -> int:
        with self.conn.cursor() as cur:
            cur.execute(query, params)
            return cur.rowcount

    # ---- the singleton state row -----------------------------------------------------

    def load_state(self) -> dict | None:
        with self.conn.cursor() as cur:
            cur.execute("SELECT * FROM inbox_crawler_state WHERE id = %s", (STATE_ID,))
            row = cur.fetchone()
            if row is None:
                return None
            return dict(zip([d[0] for d in cur.description], row, strict=True))

    def daemon_started(self) -> None:
        self._run(
            "UPDATE inbox_crawler_state SET daemon_started_at = now(), last_heartbeat_at = now(), "
            "current_activity = 'starting', updated_at = now() WHERE id = %s",
            (STATE_ID,),
        )
        self.commit()

    def heartbeat(self, activity: str | None) -> None:
        """Best effort: a failed status write must never take the daemon down."""
        try:
            self._run(
                "UPDATE inbox_crawler_state SET current_activity = %s, last_heartbeat_at = now(), "
                "updated_at = now() WHERE id = %s",
                ((activity or "")[:900] or None, STATE_ID),
            )
            self.commit()
        except Exception:  # noqa: BLE001
            try:
                self.rollback()
            except Exception:  # noqa: BLE001
                pass

    def scan_started(self) -> None:
        """A scan of everyone began (a one-person request does not move the schedule)."""
        self._run(
            "UPDATE inbox_crawler_state SET last_scan_started_at = now(), updated_at = now() "
            "WHERE id = %s",
            (STATE_ID,),
        )
        self.commit()

    def scan_finished(
        self,
        *,
        registered: int,
        errors: int,
        last_error: str | None,
        unmatched: list[str] | None,
        completed: bool,
        full: bool = True,
    ) -> None:
        """Counters always; last_scan_finished_at only for a scan that ran to its end (an aborted one,
        for example when the share dropped, leaves it where it was)."""
        self._run(
            "UPDATE inbox_crawler_state SET "
            " last_scan_finished_at = CASE WHEN %s AND %s THEN now() ELSE last_scan_finished_at END,"
            " files_registered = files_registered + %s, error_count = error_count + %s,"
            " last_error = COALESCE(%s, last_error),"
            " unmatched_folders = COALESCE(%s::jsonb, unmatched_folders), updated_at = now() "
            "WHERE id = %s",
            (
                completed,
                full,
                registered,
                errors,
                (last_error or None) and last_error[:900],
                None if unmatched is None else json.dumps(sorted(unmatched)),
                STATE_ID,
            ),
        )
        self.commit()

    # ---- scan requests ---------------------------------------------------------------

    def fail_stale_requests(self) -> int:
        """On start-up: a request still 'running' after STALE_REQUEST_MINUTES was claimed by a daemon
        that died. Fail it, so the person can ask again (one queued or running request per person)."""
        n = self._run(
            "UPDATE inbox_scan_requests SET status = 'failed', finished_at = now(), "
            "error = 'the crawler stopped while it was scanning; ask again' "
            "WHERE status = 'running' AND started_at < now() - make_interval(mins => %s)",
            (STALE_REQUEST_MINUTES,),
        )
        self.commit()
        return n

    def claim_request(self) -> dict | None:
        """The oldest queued request, now 'running'. FOR UPDATE SKIP LOCKED: two daemons never share one."""
        with self.conn.cursor() as cur:
            cur.execute(
                "UPDATE inbox_scan_requests SET status = 'running', started_at = now() "
                "WHERE request_id = (SELECT request_id FROM inbox_scan_requests WHERE status = 'queued' "
                "  ORDER BY requested_at, request_id FOR UPDATE SKIP LOCKED LIMIT 1) "
                "RETURNING request_id::text, scope, person_id::text"
            )
            row = cur.fetchone()
        self.commit()
        if row is None:
            return None
        return {"request_id": row[0], "scope": row[1], "person_id": row[2]}

    def finish_request(self, request_id: str, error: str | None) -> None:
        self._run(
            "UPDATE inbox_scan_requests SET status = %s, finished_at = now(), error = %s "
            "WHERE request_id = %s",
            (
                "failed" if error else "done",
                (error or None) and error[:500],
                request_id,
            ),
        )
        self.commit()

    # ---- who owns what, and what a path may name -------------------------------------

    def load_people(self) -> list[dict]:
        rows = self._all(
            "SELECT person_id::text, uni_alias, active, scan_while_former, user_id::text "
            "FROM people WHERE uni_alias IS NOT NULL ORDER BY person_id"
        )
        return [
            {
                "person_id": r[0],
                "uni_alias": r[1],
                "active": r[2],
                "scan_while_former": r[3],
                "user_id": r[4],
            }
            for r in rows
        ]

    def load_teams(self) -> list[dict]:
        rows = self._all(
            "SELECT team_id::text, share_folder, name FROM teams "
            "WHERE share_folder IS NOT NULL ORDER BY team_id"
        )
        return [{"team_id": r[0], "share_folder": r[1], "name": r[2]} for r in rows]

    def autolink_person_ids(self) -> set[str]:
        """People whose login has switched auto-link on (inbox_prefs, owned by the d1-inbox extension)."""
        rows = self._all(
            "SELECT p.person_id::text FROM people p JOIN inbox_prefs i ON i.user_id = p.user_id "
            "WHERE i.auto_link"
        )
        return {r[0] for r in rows}

    def load_lookup(self) -> recognise.Lookup:
        """Short IDs and codes of the live records. A short ID of a deleted record stays in short_ids
        for ever, so the ID is taken from the record's own row."""
        short_rows = self._all(
            "SELECT short_id, 'physical_samples', sample_id::text FROM physical_samples "
            "UNION ALL SELECT short_id, 'manufacturing_operations', operation_id::text "
            "  FROM manufacturing_operations "
            "UNION ALL SELECT short_id, 'test_sessions', session_id::text FROM test_sessions"
        )
        code_rows = self._all(
            "SELECT sample_code, 'physical_samples', sample_id::text FROM physical_samples "
            "UNION ALL SELECT pass_code, 'manufacturing_operations', operation_id::text "
            "  FROM manufacturing_operations "
            "UNION ALL SELECT test_code, 'test_sessions', session_id::text FROM test_sessions"
        )
        edge_rows = self._all(
            "SELECT edge_code, 'insert_edges', edge_id::text FROM insert_edges"
        )
        return recognise.build_lookup(short_rows, code_rows, edge_rows)

    # ---- the folder cache ------------------------------------------------------------

    def load_dirs(self, owner: Owner) -> dict[str, DirRow]:
        rows = self._all(
            "SELECT rel_path, dir_mtime, last_listed_at FROM inbox_dirs "
            "WHERE owner_person_id IS NOT DISTINCT FROM %s AND owner_team_id IS NOT DISTINCT FROM %s",
            (owner.person_id, owner.team_id),
        )
        return {r[0]: DirRow(r[1], r[2]) for r in rows}

    def owner_baselined(self, owner: Owner) -> bool:
        """True once the owner's first complete scan has ended. A missing root row (never scanned, or
        wiped by an alias change) is 'not baselined': the next scan is a first scan."""
        row = self._one(
            "SELECT baselined_at FROM inbox_dirs WHERE rel_path = %s", (owner.root,)
        )
        return bool(row and row[0] is not None)

    def upsert_dir(
        self, owner: Owner, rel: str, mtime: datetime | None, listed: bool
    ) -> None:
        self._run(
            "INSERT INTO inbox_dirs (rel_path, owner_person_id, owner_team_id, dir_mtime, last_listed_at) "
            "VALUES (%s, %s, %s, %s, CASE WHEN %s THEN now() END) "
            "ON CONFLICT (rel_path) DO UPDATE SET dir_mtime = EXCLUDED.dir_mtime, "
            "  last_listed_at = CASE WHEN %s THEN now() ELSE inbox_dirs.last_listed_at END",
            (rel, owner.person_id, owner.team_id, mtime, listed, listed),
        )

    def forget_dirs_under(self, owner: Owner, prefixes: list[str]) -> None:
        """Drop cache rows of directories that no longer exist (and everything below them)."""
        for p in prefixes:
            self._run(
                "DELETE FROM inbox_dirs WHERE (rel_path = %s OR left(rel_path, %s) = %s) "
                "AND owner_person_id IS NOT DISTINCT FROM %s AND owner_team_id IS NOT DISTINCT FROM %s",
                (p, len(p) + 1, p + "/", owner.person_id, owner.team_id),
            )

    def mark_baselined(self, owner: Owner) -> None:
        self._run(
            "UPDATE inbox_dirs SET baselined_at = now() WHERE rel_path = %s AND baselined_at IS NULL",
            (owner.root,),
        )

    # ---- candidates ------------------------------------------------------------------

    def load_candidates(self, owner: Owner) -> dict[str, Cand]:
        """Every candidate of the owner by relative path, in every state (the scan decides what is new,
        what vanished and what came back from this in memory)."""
        rows = self._all(
            "SELECT rel_path, candidate_id::text, directus_files_id::text, state, kind "
            "FROM file_candidates "
            "WHERE owner_person_id IS NOT DISTINCT FROM %s AND owner_team_id IS NOT DISTINCT FROM %s",
            (owner.person_id, owner.team_id),
        )
        return {r[0]: Cand(r[1], r[2], r[0], r[3], r[4]) for r in rows}

    def mark_gone(self, candidate_ids: list[str]) -> int:
        """Undecided candidates that vanished from the share. Decided ones (linked, dismissed) are
        never touched. Copies of a vanished original become originals again."""
        if not candidate_ids:
            return 0
        n = self._run(
            "UPDATE file_candidates SET state = 'gone' WHERE candidate_id = ANY(%s::uuid[]) AND state = 'new'",
            (candidate_ids,),
        )
        self._run(
            "UPDATE file_candidates SET duplicate_of = NULL WHERE duplicate_of = ANY(%s::uuid[])",
            (candidate_ids,),
        )
        return n

    def revive(self, candidate_id: str) -> None:
        """A 'gone' file that is on the share again."""
        self._run(
            "UPDATE file_candidates SET state = 'new' WHERE candidate_id = %s AND state = 'gone'",
            (candidate_id,),
        )

    def fingerprint_of(self, files_id: str) -> str | None:
        row = self._one(
            "SELECT content_sha256 FROM file_fingerprints WHERE directus_files_id = %s AND status = 'done'",
            (files_id,),
        )
        return row[0] if row else None

    def upsert_fingerprint(
        self,
        files_id: str,
        outcome: HashOutcome,
        size: int | None,
        mtime: datetime | None,
    ) -> None:
        self._run(
            "INSERT INTO file_fingerprints (directus_files_id, status, content_sha256, size_bytes, "
            " source_mtime, error_message, hashed_at) VALUES (%s, %s, %s, %s, %s, %s, now()) "
            "ON CONFLICT (directus_files_id) DO UPDATE SET status = EXCLUDED.status, "
            " content_sha256 = EXCLUDED.content_sha256, size_bytes = EXCLUDED.size_bytes, "
            " source_mtime = EXCLUDED.source_mtime, error_message = EXCLUDED.error_message, "
            " hashed_at = now()",
            (files_id, outcome.status, outcome.sha256, size, mtime, outcome.error),
        )

    def find_original(self, sha256: str, exclude_files_id: str) -> str | None:
        """The earliest candidate whose file has this content (a copy points at it as `duplicate_of`)."""
        row = self._one(
            "SELECT c.candidate_id::text FROM file_candidates c "
            "JOIN file_fingerprints f ON f.directus_files_id = c.directus_files_id "
            "WHERE f.status = 'done' AND f.content_sha256 = %s AND c.directus_files_id <> %s "
            "  AND c.state <> 'gone' AND c.duplicate_of IS NULL "
            "ORDER BY c.first_seen_at, c.candidate_id LIMIT 1",
            (sha256, exclude_files_id),
        )
        return row[0] if row else None

    def set_duplicate_of(self, candidate_id: str, original_id: str | None) -> None:
        self._run(
            "UPDATE file_candidates SET duplicate_of = %s WHERE candidate_id = %s",
            (original_id, candidate_id),
        )

    # ---- registering a file ----------------------------------------------------------

    def _ensure_folder(self, rel_dir: str) -> str:
        fid = str(folder_id(rel_dir))
        if rel_dir in self._folders_done:
            return fid
        if rel_dir == "":
            self._run(
                "INSERT INTO directus_folders (id, name, parent) VALUES (%s, %s, NULL) ON CONFLICT (id) DO NOTHING",
                (fid, self.root_folder_name),
            )
        else:
            head, _, name = rel_dir.rpartition("/")
            parent = self._ensure_folder(head)
            self._run(
                "INSERT INTO directus_folders (id, name, parent) VALUES (%s, %s, %s) ON CONFLICT (id) DO NOTHING",
                (fid, name, parent),
            )
        self._folders_done.add(rel_dir)
        return fid

    def register_file(
        self,
        *,
        owner: Owner,
        rel: str,
        size: int,
        mtime: datetime,
        classification,
        recognition: recognise.Recognition,
        origin: str,
        hashed: HashOutcome | None,
    ) -> RegisterResult:
        """The pointer row, its folder chain, the fingerprint and the candidate row, in one savepoint.

        Idempotent: `directus_files` and `directus_folders` rows that exist (the indexer's, or a
        previous run's) are left alone, and an existing candidate for the file is left alone.
        """
        fid = str(file_id(rel))
        rel_dir, _, name = rel.rpartition("/")
        with self.conn.cursor() as cur:
            cur.execute("SAVEPOINT register_file")
        try:
            dir_id = self._ensure_folder(rel_dir)
            now = datetime.now(UTC)
            meta = {
                "archive_path": rel,
                "source": "uosfstore/shared/star_group1",
                "extension": ("." + name.rsplit(".", 1)[1].lower())
                if "." in name
                else "",
                "size_bytes": size,
                "modified": mtime.isoformat(),
                "indexed_on": now.isoformat(),
                "found_by": "inbox_crawler",
            }
            self._run(
                "INSERT INTO directus_files (id, storage, filename_disk, filename_download, title, type, "
                " folder, filesize, metadata, created_on, modified_on, uploaded_on) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) ON CONFLICT (id) DO NOTHING",
                (
                    fid,
                    self.storage,
                    rel if len(rel) <= FILENAME_DISK_MAX else None,
                    name,
                    name.rsplit(".", 1)[0] if "." in name else name,
                    guess_type(name),
                    dir_id,
                    size,
                    json.dumps(meta),
                    mtime,
                    mtime,
                    now,
                ),
            )
            duplicate_of = None
            if hashed is not None:
                self.upsert_fingerprint(fid, hashed, size, mtime)
                if hashed.status == "done" and hashed.sha256:
                    duplicate_of = self.find_original(hashed.sha256, fid)
            with self.conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO file_candidates (directus_files_id, owner_person_id, owner_team_id, kind, "
                    " kind_confidence, extracted, origin, match_strength, matches, suggested_collection, "
                    " suggested_record_id, duplicate_of, rel_path, size_bytes, source_mtime) "
                    "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) "
                    "ON CONFLICT (directus_files_id) DO NOTHING RETURNING candidate_id::text",
                    (
                        fid,
                        owner.person_id,
                        owner.team_id,
                        classification.kind,
                        classification.confidence,
                        json.dumps(classification.extracted),
                        origin,
                        recognition.match_strength,
                        json.dumps(recognition.matches),
                        recognition.suggested_collection,
                        recognition.suggested_record_id,
                        duplicate_of,
                        rel,
                        size,
                        mtime,
                    ),
                )
                row = cur.fetchone()
            with self.conn.cursor() as cur:
                cur.execute("RELEASE SAVEPOINT register_file")
        except Exception:
            with self.conn.cursor() as cur:
                cur.execute("ROLLBACK TO SAVEPOINT register_file")
                cur.execute("RELEASE SAVEPOINT register_file")
            self._folders_done.clear()
            raise
        if row is None:
            existing = self._one(
                "SELECT candidate_id::text FROM file_candidates WHERE directus_files_id = %s",
                (fid,),
            )
            return RegisterResult(existing[0] if existing else None, False)
        return RegisterResult(row[0], True, duplicate_of)

    def repoint_candidate(
        self, old: Cand, new: Cand, new_size: int, new_mtime: datetime
    ) -> bool:
        """A vanished undecided file turned up at a new path with the same content: keep the old
        candidate (its first_seen_at, origin and state) and point it at the new file. The candidate
        row made for the new path is dropped. Every other reference to the old pointer row (a link made
        in Data Studio, the fingerprint) moves with it, by the indexer's own routine; the old pointer
        row is deleted only when nothing references it any more. Returns whether it was re-pointed."""
        index_archive = identity.index_archive

        with self.conn.cursor() as cur:
            cur.execute("SAVEPOINT repoint")
        try:
            with self.conn.cursor() as cur:
                cur.execute(
                    "DELETE FROM file_candidates WHERE candidate_id = %s",
                    (new.candidate_id,),
                )
                fks = index_archive.find_file_fk_columns(cur)
                left = index_archive.repoint_file_references(
                    cur, fks, old.directus_files_id, new.directus_files_id
                )
                cur.execute(
                    "UPDATE file_candidates SET rel_path = %s, size_bytes = %s, source_mtime = %s "
                    "WHERE candidate_id = %s",
                    (new.rel_path, new_size, new_mtime, old.candidate_id),
                )
                if left == 0:
                    cur.execute(
                        "DELETE FROM directus_files WHERE id = %s",
                        (old.directus_files_id,),
                    )
                cur.execute("RELEASE SAVEPOINT repoint")
        except Exception:
            with self.conn.cursor() as cur:
                cur.execute("ROLLBACK TO SAVEPOINT repoint")
                cur.execute("RELEASE SAVEPOINT repoint")
            raise
        return True

    def refresh_recognition(self, lookup: recognise.Lookup) -> int:
        """Re-read the path of every undecided candidate against today's records: a record made after
        its file arrived still gets suggested. Returns how many rows changed."""
        rows = self._all(
            "SELECT candidate_id::text, rel_path, match_strength, matches, suggested_collection, "
            " suggested_record_id::text FROM file_candidates WHERE state = 'new'"
        )
        changed = 0
        for cid, rel, strength, matches, coll, rec in rows:
            r = recognise.recognise(rel, lookup)
            if (
                r.match_strength == strength
                and r.suggested_collection == coll
                and r.suggested_record_id == rec
                and r.matches == (matches or [])
            ):
                continue
            self._run(
                "UPDATE file_candidates SET match_strength = %s, matches = %s, suggested_collection = %s, "
                " suggested_record_id = %s WHERE candidate_id = %s AND state = 'new'",
                (
                    r.match_strength,
                    json.dumps(r.matches),
                    r.suggested_collection,
                    r.suggested_record_id,
                    cid,
                ),
            )
            changed += 1
        return changed

    # ---- hashing queues --------------------------------------------------------------

    def adopted_awaiting_hash(self, limit: int = 20) -> list[tuple[str, str, str]]:
        """Candidates a person has linked (and so agreed to be read once) that have no fingerprint yet,
        or whose last try failed more than an hour ago: (candidate_id, directus_files_id, rel_path).
        Only state 'linked' rows are read: an undone link stops the read."""
        rows = self._all(
            "SELECT c.candidate_id::text, c.directus_files_id::text, c.rel_path "
            "FROM file_candidates c LEFT JOIN file_fingerprints f ON f.directus_files_id = c.directus_files_id "
            "WHERE c.adopted_at IS NOT NULL AND c.state = 'linked' "
            "  AND (f.directus_files_id IS NULL OR (f.status = 'error' AND f.hashed_at < now() - make_interval(hours => %s))) "
            "ORDER BY c.adopted_at LIMIT %s",
            (HASH_RETRY_HOURS, limit),
        )
        return [tuple(r) for r in rows]

    def errored_hashes(self, limit: int = 20) -> list[tuple[str, str, str]]:
        """Images and scans whose discovery hash failed at least an hour ago and are still undecided."""
        rows = self._all(
            "SELECT c.candidate_id::text, c.directus_files_id::text, c.rel_path "
            "FROM file_candidates c JOIN file_fingerprints f ON f.directus_files_id = c.directus_files_id "
            "WHERE c.state = 'new' AND c.kind IN ('image', 'sem_image', 'surface_scan') "
            "  AND f.status = 'error' AND f.hashed_at < now() - make_interval(hours => %s) "
            "ORDER BY f.hashed_at LIMIT %s",
            (HASH_RETRY_HOURS, limit),
        )
        return [tuple(r) for r in rows]

    # ---- auto-link ---------------------------------------------------------------------

    def autolink_candidates(self, person_ids: set[str], limit: int = 200) -> list[dict]:
        """Undecided new files of opted-in people that name exactly one record by an exact short ID,
        are images or surface scans (never documents) and are not copies."""
        if not person_ids:
            return []
        rows = self._all(
            "SELECT candidate_id::text, owner_person_id::text, suggested_collection, "
            " suggested_record_id::text, kind FROM file_candidates "
            "WHERE state = 'new' AND origin = 'new' AND match_strength = 'short_id' "
            "  AND suggested_record_id IS NOT NULL AND duplicate_of IS NULL "
            "  AND kind IN ('sem_image', 'image', 'surface_scan') "
            "  AND owner_person_id = ANY(%s::uuid[]) "
            "ORDER BY first_seen_at, candidate_id LIMIT %s",
            (sorted(person_ids), limit),
        )
        return [
            {
                "candidate_id": r[0],
                "person_id": r[1],
                "collection": r[2],
                "record_id": r[3],
                "kind": r[4],
            }
            for r in rows
        ]
