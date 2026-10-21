# ruff: noqa: F811
"""The pointer-row write guard of migration 206 (ADR-0023, docs/superpowers/specs/2026-10-21-forged-pointer-rows-options.md).

A directus_files row of the archive share (storage 'star') is created or repointed only by a session that set
d1.archive_writer = 'on': the inbox crawler and the archive indexer. Directus never sets it, so a Lab Member cannot
forge a pointer row (id = uuid5('file:' + path), storage 'star', metadata.archive_path = path) through REST or GraphQL.

Postgres-backed on the crawler's throwaway world (test_inbox_crawler_world.py), which installs the migration's real up section.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

psycopg2 = pytest.importorskip("psycopg2")
from inbox_crawler import db  # noqa: E402
from inbox_crawler.identity import file_id  # noqa: E402
from test_inbox_crawler_world import world  # noqa: E402, F401

PATH = "Users/ab123/scan.al3d"


def as_user(world):
    """The session of a Directus write: the setting is not 'on'."""
    world.q("SELECT set_config('d1.archive_writer', '', false)")


def as_writer(world):
    db.declare_archive_writer(world.conn)


def refused(world, sql, params=()):
    """Run a write that the guard must refuse; the session stays usable (a savepoint is rolled back)."""
    world.q("SAVEPOINT g")
    with pytest.raises(psycopg2.errors.InsufficientPrivilege):
        world.q(sql, params)
    world.q("ROLLBACK TO SAVEPOINT g")


def insert_pointer(world, rel=PATH, storage="star", fid=None):
    fid = fid or str(file_id(rel))
    world.q(
        "INSERT INTO directus_files (id, storage, filename_download, metadata) VALUES (%s, %s, %s, %s)",
        (fid, storage, rel.rsplit("/", 1)[-1], json.dumps({"archive_path": rel})),
    )
    return fid


def test_a_user_cannot_create_a_pointer_row_even_with_the_id_the_indexer_would_derive(
    world,
):
    # the forged row of the hole: id = uuid5('file:' + path), storage 'star', metadata.archive_path = path
    as_user(world)
    refused(
        world,
        "INSERT INTO directus_files (id, storage, metadata) VALUES (%s, 'star', %s)",
        (str(file_id(PATH)), json.dumps({"archive_path": PATH})),
    )
    assert world.one("SELECT count(*) FROM directus_files")[0] == 0


def test_a_user_can_still_create_a_row_of_any_other_storage(world):
    as_user(world)
    fid = insert_pointer(world, storage="local")
    assert world.one("SELECT storage FROM directus_files WHERE id = %s", (fid,)) == (
        "local",
    )


def test_an_archive_writer_can_create_a_pointer_row(world):
    as_writer(world)
    fid = insert_pointer(world)
    assert world.one("SELECT count(*) FROM directus_files WHERE id = %s", (fid,)) == (
        1,
    )


@pytest.mark.parametrize(
    "change",
    [
        "UPDATE directus_files SET metadata = '{\"archive_path\": \"Users/cd456/secret.al3d\"}'",
        "UPDATE directus_files SET metadata = '{}'",
        "UPDATE directus_files SET storage = 'local'",
        "UPDATE directus_files SET filename_disk = 'Users/cd456/secret.al3d'",
        "UPDATE directus_files SET id = gen_random_uuid()",
    ],
)
def test_a_user_cannot_repoint_a_pointer_row(world, change):
    as_writer(world)
    fid = insert_pointer(world)
    as_user(world)
    refused(world, change + " WHERE id = %s", (fid,))
    assert world.one(
        "SELECT storage, metadata::jsonb ->> 'archive_path' FROM directus_files WHERE id = %s",
        (fid,),
    ) == ("star", PATH)


def test_a_user_cannot_turn_their_own_row_into_a_pointer_row(world):
    as_user(world)
    fid = insert_pointer(world, storage="local")
    refused(world, "UPDATE directus_files SET storage = 'star' WHERE id = %s", (fid,))
    refused(
        world,
        "UPDATE directus_files SET storage = 'star', metadata = %s WHERE id = %s",
        (json.dumps({"archive_path": PATH}), fid),
    )


def test_a_user_can_edit_what_is_not_the_pointer(world):
    as_writer(world)
    fid = insert_pointer(world)
    as_user(world)
    world.q(
        "UPDATE directus_files SET title = 'renamed', type = 'image/x', filesize = 5 WHERE id = %s",
        (fid,),
    )
    # another metadata key changes; the archive_path does not
    world.q(
        "UPDATE directus_files SET metadata = %s WHERE id = %s",
        (json.dumps({"archive_path": PATH, "note": "x"}), fid),
    )
    assert world.one(
        "SELECT title, metadata::jsonb ->> 'note' FROM directus_files WHERE id = %s",
        (fid,),
    ) == ("renamed", "x")


def test_a_user_can_delete_a_pointer_row(world):
    as_writer(world)
    fid = insert_pointer(world)
    as_user(world)
    world.q("DELETE FROM directus_files WHERE id = %s", (fid,))
    assert world.one("SELECT count(*) FROM directus_files")[0] == 0


def test_the_crawlers_own_connection_declares_itself_a_writer(world):
    conn = db.connect(world.dsn, world.schema)
    try:
        with conn.cursor() as cur:
            cur.execute("SHOW d1.archive_writer")
            assert cur.fetchone() == ("on",)
            # and it survives a rollback of a later transaction
            cur.execute("SELECT 1")
            conn.rollback()
            cur.execute("SHOW d1.archive_writer")
            assert cur.fetchone() == ("on",)
    finally:
        conn.close()
