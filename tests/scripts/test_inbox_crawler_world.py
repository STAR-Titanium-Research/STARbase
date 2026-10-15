"""A throwaway database world for the inbox crawler's Postgres-backed tests (shared fixture).

`world` builds, in a uniquely named schema that is dropped afterwards, the tables the crawler touches: stand-ins
for what Directus owns (`directus_files`, `directus_folders`, `directus_users`; a migrated database only has
one-column stubs), small stand-ins for `people`, `teams` and the three record tables, and the REAL migrations
for `file_fingerprints` (T0e) and the inbox (193, with `d1_private.` pointed at the throwaway schema). It
touches nothing else in the database. The "share" is a directory under tmp_path.

Skipped when DATABASE_URL is unset or unreachable (CI sets REQUIRE_DB_TESTS=1, which turns a skip into a
failure, see conftest.py). A few smoke tests at the bottom check the fixture itself.
"""

from __future__ import annotations

import os
import sys
import uuid
from dataclasses import dataclass
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

DSN = os.environ.get("DATABASE_URL")
FINGERPRINTS = ROOT / "db/migrations/20261010000159_file_fingerprints.sql"
INBOX = ROOT / "db/migrations/20261015000193_found_files_inbox.sql"
FILE_MTIME = 1_500_000_000  # the default modification time of a file the tests put on the fake share


def migration_up(path: Path, schema: str | None = None) -> str:
    sql = (
        path.read_text(encoding="utf-8")
        .split("-- migrate:up", 1)[1]
        .split("-- migrate:down", 1)[0]
    )
    return sql.replace("d1_private.", f"{schema}.") if schema else sql


STUBS = """
CREATE TABLE directus_users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text);
CREATE TABLE people (person_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), full_name text,
    user_id uuid REFERENCES directus_users (id), active boolean NOT NULL DEFAULT true);
CREATE TABLE teams (team_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text);
CREATE TABLE directus_folders (id uuid PRIMARY KEY, name text NOT NULL, parent uuid);
CREATE TABLE directus_files (id uuid PRIMARY KEY, storage text NOT NULL, filename_disk text,
    filename_download text, title text, type text, folder uuid, filesize bigint, metadata json,
    created_on timestamptz, modified_on timestamptz, uploaded_on timestamptz);
CREATE TABLE physical_samples (sample_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sample_code text,
    short_id text);
CREATE TABLE manufacturing_operations (operation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    pass_code text, short_id text);
CREATE TABLE test_sessions (session_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), test_code text,
    short_id text);
CREATE TABLE insert_edges (edge_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), edge_code text);
CREATE TABLE sample_data_files (id serial PRIMARY KEY, sample_id uuid,
    directus_files_id uuid REFERENCES directus_files (id) ON DELETE CASCADE);
"""


@dataclass
class World:
    conn: object
    schema: str
    root: str  # the "share": a directory under tmp_path (star_group1)
    dsn: str

    def q(self, sql, params=()):
        with self.conn.cursor() as cur:
            cur.execute(sql, params or None)
            return cur.fetchall() if cur.description else None

    def one(self, sql, params=()):
        rows = self.q(sql, params)
        return rows[0] if rows else None

    def person(
        self, alias, *, active=True, scan_while_former=False, user=False, name=None
    ):
        pid = str(uuid.uuid4())
        uid = None
        if user:
            uid = str(uuid.uuid4())
            self.q(
                "INSERT INTO directus_users (id, email) VALUES (%s, %s)",
                (uid, f"{alias}@x.test"),
            )
        self.q(
            "INSERT INTO people (person_id, full_name, user_id, active) VALUES (%s, %s, %s, %s)",
            (pid, name or alias, uid, active),
        )
        if alias is not None:
            self.q(
                "UPDATE people SET uni_alias = %s, scan_while_former = %s WHERE person_id = %s",
                (alias, scan_while_former, pid),
            )
        return pid, uid

    def team(self, folder, name=None):
        tid = str(uuid.uuid4())
        self.q(
            "INSERT INTO teams (team_id, name) VALUES (%s, %s)", (tid, name or folder)
        )
        self.q("UPDATE teams SET share_folder = %s WHERE team_id = %s", (folder, tid))
        return tid

    def sample(self, short_id, code=None):
        sid = str(uuid.uuid4())
        self.q(
            "INSERT INTO physical_samples (sample_id, sample_code, short_id) VALUES (%s, %s, %s)",
            (sid, code, short_id),
        )
        return sid

    def commit(self):
        self.conn.commit()

    def write(self, rel, content=b"x", mtime=None):
        """Put a file in the fake share (test setup only: the crawler itself never writes)."""
        p = Path(self.root, *rel.split("/"))
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(content)
        # An aged file, as one found on a share usually is: the crawler skips a file modified in the last few
        # seconds (it may still be being written). Pass mtime=time.time() to test exactly that.
        stamp = FILE_MTIME if mtime is None else mtime
        os.utime(p, (stamp, stamp))
        return p


@pytest.fixture
def world(tmp_path):
    psycopg2 = pytest.importorskip("psycopg2")
    if not DSN:
        pytest.skip("DATABASE_URL not set")
    try:
        admin = psycopg2.connect(DSN)
    except psycopg2.OperationalError:
        pytest.skip("database not reachable")
    schema = "ic_test_" + uuid.uuid4().hex[:8]
    admin.autocommit = True
    acur = admin.cursor()
    acur.execute(f"CREATE SCHEMA {schema}")
    root = tmp_path / "star_group1"
    root.mkdir()
    conn = psycopg2.connect(DSN)
    try:
        cur = conn.cursor()
        cur.execute(f"SET search_path = {schema}, public")
        cur.execute(STUBS)
        cur.execute(migration_up(FINGERPRINTS))
        cur.execute(migration_up(INBOX, schema))
        conn.commit()
        yield World(conn, schema, str(root), DSN)
    finally:
        conn.rollback()
        conn.close()
        acur.execute(f"DROP SCHEMA {schema} CASCADE")
        admin.close()


def test_the_world_has_the_real_inbox_tables(world):
    names = {
        r[0]
        for r in world.q(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = %s",
            (world.schema,),
        )
    }
    assert {
        "file_candidates",
        "inbox_dirs",
        "inbox_scan_requests",
        "inbox_crawler_state",
        "inbox_prefs",
    } <= names
    assert world.one("SELECT count(*) FROM inbox_crawler_state")[0] == 1


def test_the_world_is_dropped_between_tests(world):
    assert world.one("SELECT count(*) FROM file_candidates")[0] == 0
