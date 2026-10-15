"""python -m inbox_crawler --daemon | --once

Environment:
    DATABASE_URL               required, the Postgres DSN (never printed).
    ARCHIVE_ROOT               the star_group1 root (default /mnt/archive/star_group1); mounted read-only.
    D1_INBOX_URL               the Directus base URL for auto-link (default http://directus:8055).
    D1_INBOX_CRAWLER_SECRET    the shared secret for POST /d1-inbox/auto-link; empty switches auto-link off.
    INBOX_OCR                  1 to read data-bar text with pytesseract (default off, not validated yet).
    INBOX_TICK_S               seconds between claims of scan requests (default 30).
    INBOX_PRIVATE_SCHEMA       the schema holding the inbox tables (default d1_private; tests use another).
    STORAGE_NAME, ROOT_FOLDER  as for scripts/index_archive.py (defaults star, star_group1).
    INBOX_LOG_LEVEL            DEBUG logs every file the crawler opens (default INFO).
"""

from __future__ import annotations

import argparse
import logging
import os
import signal
import sys
import threading

from . import autolink, daemon, db, fs_readonly, hashing

log = logging.getLogger("inbox_crawler")


def _parse(argv):
    ap = argparse.ArgumentParser(
        prog="inbox_crawler", description=__doc__.split("\n")[0]
    )
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument(
        "--daemon", action="store_true", help="run forever, polling inbox_crawler_state"
    )
    mode.add_argument(
        "--once", action="store_true", help="one scan of everyone, then exit"
    )
    ap.add_argument(
        "--root",
        default=os.environ.get("ARCHIVE_ROOT", "/mnt/archive/star_group1"),
        help="the star_group1 root; every path the crawler stores is relative to it",
    )
    return ap.parse_args(argv)


def main(argv=None) -> int:
    args = _parse(argv)
    logging.basicConfig(
        level=os.environ.get("INBOX_LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        log.error("DATABASE_URL is required")
        return 2
    schema = os.environ.get("INBOX_PRIVATE_SCHEMA", "d1_private")
    try:
        conn = db.connect(dsn, schema)
    except Exception as exc:  # never log the exception text: it can echo the DSN
        log.error("cannot connect to the database (%s)", type(exc).__name__)
        return 2
    holder = {"conn": conn}
    try:
        return _run(args, dsn, schema, holder)
    finally:
        try:
            holder["conn"].close()
        except Exception:  # noqa: BLE001
            pass


def _run(args, dsn: str, schema: str, holder: dict) -> int:
    share = fs_readonly.Share(args.root)
    try:
        root_ok = share.stat("").is_dir
    except OSError:
        root_ok = False
    if not root_ok:
        log.error("ARCHIVE_ROOT does not exist or is not a directory: %s", args.root)
        return 2
    try:
        linker = autolink.AutoLinker(
            os.environ.get("D1_INBOX_URL", "http://directus:8055"),
            os.environ.get("D1_INBOX_CRAWLER_SECRET", ""),
        )
    except ValueError as exc:
        log.error("%s", exc)
        return 2
    if not linker.enabled:
        log.info("D1_INBOX_CRAWLER_SECRET is not set: auto-link is off")

    store = db.Store(
        holder["conn"],
        storage=os.environ.get("STORAGE_NAME", "star"),
        root_folder_name=os.environ.get("ROOT_FOLDER", "star_group1"),
    )
    stop = threading.Event()
    d = daemon.Daemon(
        store,
        share,
        linker,
        config=daemon.Config(
            ocr=os.environ.get("INBOX_OCR") == "1",
            tick_s=float(os.environ.get("INBOX_TICK_S", "30")),
        ),
        stop=stop,
    )
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())

    log.info("reading %s READ-ONLY", args.root)
    if args.once:
        state = store.load_state()
        if state is not None:
            d.throttle.set_rate(hashing.mb_per_s(state["read_mb_per_s"]))
        stats = d.run_scan(None, full=True)
        d.hash_pending()
        return 1 if stats.aborted else 0

    def reconnect(old):
        try:
            old.conn.close()
        except Exception:  # noqa: BLE001
            pass
        holder["conn"] = db.connect(dsn, schema)
        return db.Store(
            holder["conn"], storage=old.storage, root_folder_name=old.root_folder_name
        )

    d.run_forever(reconnect)
    return 0


if __name__ == "__main__":
    sys.exit(main())
