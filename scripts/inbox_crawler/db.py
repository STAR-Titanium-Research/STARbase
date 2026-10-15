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
from .fs_readonly import extension
from .hashing import HashOutcome
from .identity import FILENAME_DISK_MAX, file_id, folder_id, guess_type
from .owners import Owner, clean_rel_path

log = logging.getLogger("inbox_crawler.db")

STATE_ID = "00000000-0000-0000-0000-000000000001"
_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
# A request left 'running' longer than this belongs to a daemon that died.
STALE_REQUEST_MINUTES = 15
# An errored hash is tried again no sooner than this.
HASH_RETRY_HOURS = 1
# The fingerprint error written for a linked document whose stored path is not its own (see
# adopted_awaiting_hash), and how many pages of the queue one call looks through.
BAD_PATH_ERROR = "path is not under its owner folder"
BAD_PATH_PAGES = 50
# The session-level advisory lock that makes one crawler (daemon or --once) at a time. An arbitrary fixed
# bigint; it lives on the crawler's own connection, so it goes with a killed process.
CRAWLER_LOCK_KEY = 7_302_150_400_193
# The heartbeat's own connection gives up on a locked or slow status row after these many milliseconds: a
# heartbeat is best effort and must never hold the scan up.
HEARTBEAT_LOCK_TIMEOUT_MS = 2_000
HEARTBEAT_STATEMENT_TIMEOUT_MS = 5_000
HEARTBEAT_CONNECT_TIMEOUT_S = 5


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


def _owner_eq(owner: Owner, prefix: str = "") -> str:
    """The owner filter as one plain equality on the owner's own column (one branch per owner kind), so
    the owner indexes are usable; the id is the single parameter. A person owner has no team and vice
    versa (a table CHECK), so the other column needs no test."""
    return (
        f"{prefix}owner_person_id = %s"
        if owner.kind == "person"
        else f"{prefix}owner_team_id = %s"
    )


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
class Copy:
    cand: Cand
    size: int
    mtime: datetime | None


@dataclass(frozen=True)
class RegisterResult:
    candidate_id: str | None
    created: bool
    duplicate_of: str | None = None


class Store:
    def __init__(
        self,
        conn,
        *,
        storage: str = "star",
        root_folder_name: str = "star_group1",
        heartbeat_dsn: str | None = None,
        private_schema: str | None = None,
    ):
        self.conn = conn
        self.storage = storage
        self.root_folder_name = root_folder_name
        # The heartbeat is written on a connection of its own (see heartbeat()). Without an explicit DSN it
        # reuses the scan connection's own parameters; without a schema, that connection's search_path.
        self._heartbeat_dsn = heartbeat_dsn
        self._heartbeat_path = (
            None if private_schema is None else f"{private_schema}, public"
        )
        self._heartbeat_conn = None
        self._heartbeat_failing = False
        self._folders_done: set[str] = set()
        self._warned: set[str] = (
            set()
        )  # candidates already complained about (once per process)

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

    def try_crawler_lock(self) -> bool:
        """Take the single-crawler advisory lock on this connection, without waiting. False when another
        connection (another daemon, or a --once run) holds it. Postgres releases it when the connection
        ends, and it is not tied to a transaction, so commits and rollbacks leave it alone."""
        row = self._one("SELECT pg_try_advisory_lock(%s)", (CRAWLER_LOCK_KEY,))
        self.commit()
        return bool(row and row[0])

    def daemon_started(self) -> None:
        self._run(
            "UPDATE inbox_crawler_state SET daemon_started_at = now(), last_heartbeat_at = now(), "
            "current_activity = 'starting', updated_at = now() WHERE id = %s",
            (STATE_ID,),
        )
        self.commit()

    def heartbeat(self, activity: str | None) -> None:
        """Best effort: a failed status write must never take the daemon down.

        Written on a separate autocommit connection, never on the scan's. The scan connection holds the
        owner's unfinished registrations in an open transaction (committed only after the owner's alias
        check), so a heartbeat on it would commit that work unchecked, and a failed one would roll it back
        silently. This one can neither: on any failure it only logs, and tries a new connection next time."""
        try:
            conn = self._heartbeat_connection()
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE inbox_crawler_state SET current_activity = %s, last_heartbeat_at = now(), "
                    "updated_at = now() WHERE id = %s",
                    ((activity or "")[:900] or None, STATE_ID),
                )
            self._heartbeat_failing = False
        except Exception as exc:  # noqa: BLE001
            self._drop_heartbeat_connection()
            # Once per run of failures: a heartbeat fires every few seconds. Never the exception text, which
            # can echo the DSN.
            if not self._heartbeat_failing:
                self._heartbeat_failing = True
                log.warning(
                    "heartbeat not written (%s); the scan is not affected",
                    type(exc).__name__,
                )

    def _heartbeat_connection(self):
        if self._heartbeat_conn is not None and not self._heartbeat_conn.closed:
            return self._heartbeat_conn
        import psycopg2

        dsn = self._heartbeat_dsn
        if not dsn:
            info = self.conn.info
            dsn = psycopg2.extensions.make_dsn(
                **{**info.dsn_parameters, "password": info.password}
            )
        if self._heartbeat_path is None:
            self._heartbeat_path = self._scan_search_path()
        conn = psycopg2.connect(
            dsn,
            connect_timeout=HEARTBEAT_CONNECT_TIMEOUT_S,
            options=(
                f"-c lock_timeout={HEARTBEAT_LOCK_TIMEOUT_MS} "
                f"-c statement_timeout={HEARTBEAT_STATEMENT_TIMEOUT_MS}"
            ),
        )
        try:
            conn.autocommit = True
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT set_config('search_path', %s, false)",
                    (self._heartbeat_path,),
                )
        except Exception:
            conn.close()
            raise
        self._heartbeat_conn = conn
        return conn

    def _scan_search_path(self) -> str:
        """The scan connection's search_path, read without leaving a transaction open that was not."""
        import psycopg2

        was_idle = (
            self.conn.info.transaction_status
            == psycopg2.extensions.TRANSACTION_STATUS_IDLE
        )
        try:
            row = self._one("SHOW search_path")
        finally:
            if was_idle:
                self.conn.rollback()
        return row[0]

    def _drop_heartbeat_connection(self) -> None:
        conn, self._heartbeat_conn = self._heartbeat_conn, None
        if conn is not None:
            try:
                conn.close()
            except Exception:  # noqa: BLE001
                pass

    def close_heartbeat(self) -> None:
        self._drop_heartbeat_connection()

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
        for example when the share dropped, leaves it where it was). last_error is replaced by a new
        error, and cleared by a scan of everyone that ran to its end with none (so the admin tab stops
        showing a problem that has gone); a one-person or unfinished scan leaves it alone."""
        new_error = (last_error or None) and last_error[:900]
        self._run(
            "UPDATE inbox_crawler_state SET "
            " last_scan_finished_at = CASE WHEN %s AND %s THEN now() ELSE last_scan_finished_at END,"
            " files_registered = files_registered + %s, error_count = error_count + %s,"
            " last_error = CASE WHEN %s::text IS NOT NULL THEN %s::text "
            "   WHEN %s AND %s THEN NULL ELSE last_error END,"
            " unmatched_folders = COALESCE(%s::jsonb, unmatched_folders), updated_at = now() "
            "WHERE id = %s",
            (
                completed,
                full,
                registered,
                errors,
                new_error,
                new_error,
                completed,
                full,
                None if unmatched is None else json.dumps(sorted(unmatched)),
                STATE_ID,
            ),
        )
        self.commit()

    # ---- scan requests ---------------------------------------------------------------

    def fail_stale_requests(
        self, older_than_minutes: int | None = STALE_REQUEST_MINUTES
    ) -> int:
        """Fail requests a dead daemon left 'running', so the person can ask again (one queued or running
        request per person). With a number: those running longer than that, which every tick clears (a
        request this daemon claimed is finished within the same tick, so none of ours is ever running at
        its start). With None: every running request, for start-up (there is one daemon)."""
        n = self._run(
            "UPDATE inbox_scan_requests SET status = 'failed', finished_at = now(), "
            "error = 'the crawler stopped while it was scanning; ask again' "
            "WHERE status = 'running' "
            "AND (%s::int IS NULL OR started_at < now() - make_interval(mins => %s))",
            (older_than_minutes, older_than_minutes),
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

    def load_teams_of(self, person_id: str) -> list[dict]:
        """The teams with a share folder that this person is a member of, for a one-person scan. Only an
        ACTIVE person (people.active): that is who the Inbox shows a team's files to, and so who can ask."""
        rows = self._all(
            "SELECT t.team_id::text, t.share_folder, t.name FROM teams t "
            "JOIN team_members m ON m.team_id = t.team_id "
            "JOIN people p ON p.person_id = m.person_id "
            "WHERE m.person_id = %s AND p.active AND t.share_folder IS NOT NULL ORDER BY t.team_id",
            (person_id,),
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
            "SELECT rel_path, dir_mtime, last_listed_at FROM inbox_dirs WHERE "
            + _owner_eq(owner),
            (owner.id,),
        )
        return {r[0]: DirRow(r[1], r[2]) for r in rows}

    def owner_baselined(self, owner: Owner) -> bool:
        """True once the owner's first complete scan has ended. A missing root row (never scanned, or
        wiped by an alias change) is 'not baselined': the next scan is a first scan. The row must be the
        owner's own: a folder handed to someone else is not already baselined for them."""
        row = self._one(
            "SELECT baselined_at FROM inbox_dirs WHERE rel_path = %s AND "
            + _owner_eq(owner),
            (owner.root, owner.id),
        )
        return bool(row and row[0] is not None)

    def upsert_dir(
        self, owner: Owner, rel: str, mtime: datetime | None, listed: bool
    ) -> bool:
        """Cache a directory for the owner. False when the path already has a row of ANOTHER owner (a
        folder that changed hands): that row is left alone and this directory is not cached."""
        col = "owner_person_id" if owner.kind == "person" else "owner_team_id"
        n = self._run(
            "INSERT INTO inbox_dirs (rel_path, " + col + ", dir_mtime, last_listed_at) "
            "VALUES (%s, %s, %s, CASE WHEN %s THEN now() END) "
            "ON CONFLICT (rel_path) DO UPDATE SET dir_mtime = EXCLUDED.dir_mtime, "
            "  last_listed_at = CASE WHEN %s THEN now() ELSE inbox_dirs.last_listed_at END "
            "WHERE inbox_dirs." + col + " = EXCLUDED." + col,
            (rel, owner.id, mtime, listed, listed),
        )
        return n > 0

    def forget_dirs_under(self, owner: Owner, prefixes: list[str]) -> None:
        """Drop cache rows of directories that no longer exist (and everything below them)."""
        for p in prefixes:
            self._run(
                "DELETE FROM inbox_dirs WHERE (rel_path = %s OR left(rel_path, %s) = %s) AND "
                + _owner_eq(owner),
                (p, len(p) + 1, p + "/", owner.id),
            )

    def mark_baselined(self, owner: Owner) -> None:
        self._run(
            "UPDATE inbox_dirs SET baselined_at = now() WHERE rel_path = %s AND baselined_at IS NULL AND "
            + _owner_eq(owner),
            (owner.root, owner.id),
        )

    def owner_claim_unchanged(self, owner: Owner) -> bool:
        """Does the owner still hold the folder the scan started with (people.uni_alias, teams.share_folder)?
        The row is read FOR SHARE: a change to it waits for this transaction's commit, so work committed
        after a True answer is work for an owner who still had the folder, and the trigger that cleans up
        after a change then sees it."""
        if owner.kind == "person":
            row = self._one(
                "SELECT uni_alias FROM people WHERE person_id = %s FOR SHARE",
                (owner.id,),
            )
        else:
            row = self._one(
                "SELECT share_folder FROM teams WHERE team_id = %s FOR SHARE",
                (owner.id,),
            )
        return row is not None and row[0] == owner.claim

    def drop_foreign_state(self, owner: Owner) -> None:
        """A folder that changed hands: whatever another owner left under this owner's folder (cache rows,
        and candidates that are not linked) is stale and would hide or leak files. Linked rows stay, as
        the migration's own cleanup leaves them."""
        mine = _owner_eq(owner)
        n = len(owner.root) + 1
        under = "(rel_path = %s OR left(rel_path, %s) = %s)"
        self._run(
            "DELETE FROM inbox_dirs WHERE " + under + " AND NOT (" + mine + ")",
            (owner.root, n, owner.root + "/", owner.id),
        )
        self._run(
            "DELETE FROM file_candidates WHERE left(rel_path, %s) = %s AND NOT ("
            + mine
            + ") "
            "AND state IN ('new', 'gone', 'dismissed')",
            (n, owner.root + "/", owner.id),
        )

    # ---- candidates ------------------------------------------------------------------

    def load_candidates(self, owner: Owner) -> dict[str, Cand]:
        """Every candidate of the owner by relative path, in every state (the scan decides what is new,
        what vanished and what came back from this in memory)."""
        rows = self._all(
            "SELECT rel_path, candidate_id::text, directus_files_id::text, state, kind "
            "FROM file_candidates WHERE " + _owner_eq(owner),
            (owner.id,),
        )
        return {r[0]: Cand(r[1], r[2], r[0], r[3], r[4]) for r in rows}

    def resync_paths(self, owner: Owner) -> int:
        """Re-read each of the owner's candidates' rel_path from its pointer row (metadata.archive_path).
        The indexer re-points a moved file's references, the candidate included, to the pointer row at the
        new path but cannot touch rel_path, which would then name a path that is gone.

        metadata.archive_path is editable by any Lab Member, so it is only believed when it is a clean path
        (no '..', backslash, empty or '.' part) under this owner's folder AND the pointer row's own id is
        the indexer's uuid5 of that very path. A real move always satisfies the last rule: the indexer
        re-points the candidate to the row of the NEW path, whose id is uuid5(new path) and whose
        archive_path is that path. An edited archive_path names another file, so the ids disagree and the
        candidate keeps its path (the D2 rule: only a person's own, linked files are ever read)."""
        rows = self._all(
            "SELECT c.candidate_id::text, c.directus_files_id::text, df.metadata::jsonb->>'archive_path' "
            "FROM file_candidates c JOIN directus_files df ON df.id = c.directus_files_id WHERE "
            + _owner_eq(owner, "c.")
            + " "
            "AND df.metadata::jsonb->>'archive_path' IS NOT NULL "
            "AND c.rel_path <> df.metadata::jsonb->>'archive_path' "
            "AND left(df.metadata::jsonb->>'archive_path', %s) = %s",
            (owner.id, len(owner.root) + 1, owner.root + "/"),
        )
        done = 0
        for candidate_id, files_id, archive_path in rows:
            if not clean_rel_path(archive_path, owner.root) or (
                str(file_id(archive_path)) != files_id
            ):
                log.warning(
                    "not re-syncing candidate %s: its pointer row names a path that is not its own",
                    candidate_id,
                )
                continue
            done += self._run(
                "UPDATE file_candidates SET rel_path = %s WHERE candidate_id = %s",
                (archive_path, candidate_id),
            )
        return done

    def _has_surface_scans(self) -> bool:
        """Does the database have the surface-scan table (migration 192)? An older one does not."""
        row = self._one("SELECT to_regclass('surface_scans') IS NOT NULL")
        return bool(row and row[0])

    def already_linked(self, files_ids: list[str]) -> set[str]:
        """Which of these pointer-row ids are already linked to a sample, operation or test (by Data Studio's
        picker or by the d1-inbox extension), or already a surface scan (added in the Alicona feature's own
        dialog, which offers every star .al3d, the crawler's included). Such a file is not a found file:
        nobody needs to link it."""
        if not files_ids:
            return set()
        scans = (
            " UNION SELECT directus_files_id::text FROM surface_scans WHERE directus_files_id = ANY(%s::uuid[])"
            if self._has_surface_scans()
            else ""
        )
        rows = self._all(
            "SELECT directus_files_id::text FROM sample_data_files WHERE directus_files_id = ANY(%s::uuid[]) "
            "UNION SELECT directus_files_id::text FROM operation_data_files WHERE directus_files_id = ANY(%s::uuid[]) "
            "UNION SELECT directus_files_id::text FROM session_data_files WHERE directus_files_id = ANY(%s::uuid[])"
            + scans,
            (files_ids,) * (4 if scans else 3),
        )
        return {r[0] for r in rows}

    def drop_linked_elsewhere(self, owner: Owner) -> int:
        """Delete the owner's UNDECIDED candidates (new or gone) whose file has meanwhile been linked in one
        of the three junctions or added as a surface scan: the extension would refuse to link them again
        (already on the record) and the Inbox would show them for ever. Linked and dismissed rows are never
        touched."""
        scans = (
            "  OR EXISTS (SELECT 1 FROM surface_scans j WHERE j.directus_files_id = c.directus_files_id)"
            if self._has_surface_scans()
            else ""
        )
        return self._run(
            "DELETE FROM file_candidates c WHERE "
            + _owner_eq(owner, "c.")
            + " AND c.state IN ('new', 'gone') "
            "AND (EXISTS (SELECT 1 FROM sample_data_files j WHERE j.directus_files_id = c.directus_files_id) "
            "  OR EXISTS (SELECT 1 FROM operation_data_files j WHERE j.directus_files_id = c.directus_files_id) "
            "  OR EXISTS (SELECT 1 FROM session_data_files j WHERE j.directus_files_id = c.directus_files_id)"
            + scans
            + ")",
            (owner.id,),
        )

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
                # lower-cased with its dot, as the indexer writes it (its sweep keys on this)
                "extension": "" if extension(name) == "." else extension(name),
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

    def copies_of(self, original: Cand, owner: Owner) -> list:
        """The owner's undecided candidates recorded as copies of `original` (same content hash, found
        while it was still there). Returns objects with .cand, .size, .mtime."""
        rows = self._all(
            "SELECT candidate_id::text, directus_files_id::text, rel_path, kind, size_bytes, source_mtime "
            "FROM file_candidates WHERE duplicate_of = %s AND state = 'new' AND "
            + _owner_eq(owner),
            (original.candidate_id, owner.id),
        )
        return [
            Copy(Cand(r[0], r[1], r[2], "new", r[3]), r[4] or 0, r[5]) for r in rows
        ]

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
            # an owner's folder is always Users/<alias> or Shared/<folder>: look only below it
            r = recognise.recognise(rel, lookup, below="/".join(rel.split("/")[:2]))
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
        Only state 'linked' rows are read: an undone link stops the read.

        Nothing is returned for a row whose stored path is not its own: the path must be clean, below the
        owner's folder (spelled as the share spells it, SMB being case-insensitive) and the row's id must be
        the indexer's uuid5 of it. Such a row is never read. It gets an 'error' fingerprint row instead
        (BAD_PATH_ERROR), which takes it out of this queue for an hour like any failed hash, so a pile of
        them (linked documents left under an old alias) cannot starve the rows behind it. Written here and
        committed here: nothing else is pending on the scan connection when the daemon asks."""
        out: list[tuple[str, str, str]] = []
        taken: set[str] = set()
        page = max(limit, 1) * 10
        for _ in range(BAD_PATH_PAGES):
            rows = self._all(
                "SELECT c.candidate_id::text, c.directus_files_id::text, c.rel_path, "
                " CASE WHEN c.owner_person_id IS NOT NULL THEN 'Users' ELSE 'Shared' END, "
                " COALESCE(p.uni_alias, t.share_folder) "
                "FROM file_candidates c "
                "LEFT JOIN file_fingerprints f ON f.directus_files_id = c.directus_files_id "
                "LEFT JOIN people p ON p.person_id = c.owner_person_id "
                "LEFT JOIN teams t ON t.team_id = c.owner_team_id "
                "WHERE c.adopted_at IS NOT NULL AND c.state = 'linked' "
                "  AND (f.directus_files_id IS NULL OR (f.status = 'error' AND f.hashed_at < now() - make_interval(hours => %s))) "
                "ORDER BY c.adopted_at, c.candidate_id LIMIT %s",
                (HASH_RETRY_HOURS, page),
            )
            bad = []
            for cid, fid, rel, base, folder in rows:
                if self._own_path(rel, fid, base, folder):
                    if cid not in taken:
                        taken.add(cid)
                        out.append((cid, fid, rel))
                        if len(out) >= limit:
                            break
                else:
                    bad.append(fid)
                    if cid not in self._warned:
                        self._warned.add(cid)
                        log.warning(
                            "not reading candidate %s: its stored path is not its own",
                            cid,
                        )
            for fid in bad:
                self.upsert_fingerprint(
                    fid, HashOutcome("error", error=BAD_PATH_ERROR), None, None
                )
            if bad:
                self.commit()
            # Done when enough rows are found, the queue is shorter than a page, or this page had no bad
            # row to drop (so the next page would be the same one).
            if len(out) >= limit or len(rows) < page or not bad:
                break
        return out

    @staticmethod
    def _own_path(rel: str, files_id: str, base: str, folder: str | None) -> bool:
        if not folder or not clean_rel_path(rel):
            return False
        parts = rel.split("/")
        return (
            parts[0] == base
            and parts[1].lower() == folder.lower()
            and len(parts) > 2
            and str(file_id(rel)) == files_id
        )

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
        are SEM images or other images (never surface scans or documents), are not copies and
        were not auto-linked and undone by the person (auto_undone_at)."""
        if not person_ids:
            return []
        rows = self._all(
            "SELECT candidate_id::text, owner_person_id::text, suggested_collection, "
            " suggested_record_id::text, kind FROM file_candidates "
            "WHERE state = 'new' AND origin = 'new' AND match_strength = 'short_id' "
            "  AND suggested_record_id IS NOT NULL AND duplicate_of IS NULL "
            "  AND auto_undone_at IS NULL "
            "  AND kind IN ('sem_image', 'image') "
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
