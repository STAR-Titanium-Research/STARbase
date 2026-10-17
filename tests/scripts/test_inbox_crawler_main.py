# ruff: noqa: F811
"""python -m inbox_crawler: configuration, exit codes, and that no secret reaches the log."""

from __future__ import annotations

import logging
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

pytest.importorskip("psycopg2")
from inbox_crawler import __main__ as cli  # noqa: E402
from test_inbox_crawler_scan import png, settle  # noqa: E402
from test_inbox_crawler_world import world  # noqa: E402, F401

PASSWORD = "hunter2-very-secret"


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for k in (
        "DATABASE_URL",
        "D1_INBOX_URL",
        "D1_INBOX_CRAWLER_SECRET",
        "INBOX_OCR",
        "ARCHIVE_ROOT",
    ):
        monkeypatch.delenv(k, raising=False)


def test_a_mode_is_required():
    with pytest.raises(SystemExit):
        cli.main([])


def test_no_database_url_is_a_configuration_error(caplog):
    assert cli.main(["--once"]) == 2
    assert "DATABASE_URL is required" in caplog.text


@pytest.mark.parametrize(
    "dsn",
    [
        f"postgres://u:{PASSWORD}@127.0.0.1:9/nodb?sslmode=disable&connect_timeout=1",
        f"host=127.0.0.1 port=9 user=u password={PASSWORD} dbname=x connect_timeout=1",
        f"not a dsn password={PASSWORD} ((",
    ],
)
def test_a_bad_dsn_is_reported_without_echoing_it(monkeypatch, caplog, dsn):
    monkeypatch.setenv("DATABASE_URL", dsn)
    with caplog.at_level(logging.DEBUG):
        assert cli.main(["--once"]) == 2
    assert PASSWORD not in caplog.text
    assert "cannot connect" in caplog.text


def test_a_missing_archive_root_stops_before_anything_is_scanned(
    world, monkeypatch, caplog, tmp_path
):
    monkeypatch.setenv("DATABASE_URL", world.dsn)
    monkeypatch.setenv("INBOX_PRIVATE_SCHEMA", world.schema)
    assert cli.main(["--once", "--root", str(tmp_path / "not-mounted")]) == 2
    assert "ARCHIVE_ROOT" in caplog.text


def test_a_bad_inbox_url_is_a_configuration_error(world, monkeypatch, caplog):
    monkeypatch.setenv("DATABASE_URL", world.dsn)
    monkeypatch.setenv("INBOX_PRIVATE_SCHEMA", world.schema)
    monkeypatch.setenv("D1_INBOX_URL", "file:///etc/passwd")
    assert cli.main(["--once", "--root", world.root]) == 2


def test_once_scans_everyone_and_exits_zero(world, monkeypatch, caplog):
    world.person("abc12de")
    world.write("Users/abc12de/a.png", png())
    settle(world)
    world.commit()
    monkeypatch.setenv("DATABASE_URL", world.dsn)
    monkeypatch.setenv("INBOX_PRIVATE_SCHEMA", world.schema)
    monkeypatch.setenv("D1_INBOX_CRAWLER_SECRET", PASSWORD)
    monkeypatch.setenv("D1_INBOX_URL", "http://127.0.0.1:9")
    with caplog.at_level(logging.DEBUG):
        assert cli.main(["--once", "--root", world.root]) == 0
    assert world.one("SELECT count(*) FROM file_candidates")[0] == 1
    assert "READ-ONLY" in caplog.text
    assert PASSWORD not in caplog.text and world.dsn not in caplog.text


def test_once_exits_one_when_the_scan_aborts(world, monkeypatch):
    world.person("abc12de")
    world.write("Users/abc12de/a.png", png())
    settle(world)
    world.commit()
    import shutil

    shutil.rmtree(Path(world.root, "Users"))  # the root is there, the share is not
    monkeypatch.setenv("DATABASE_URL", world.dsn)
    monkeypatch.setenv("INBOX_PRIVATE_SCHEMA", world.schema)
    assert cli.main(["--once", "--root", world.root]) == 1
