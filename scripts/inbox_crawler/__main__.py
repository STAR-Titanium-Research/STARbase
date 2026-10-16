"""python -m inbox_crawler --daemon | --once | --reclassify | --sem-backfill

Environment:
    DATABASE_URL               required, the Postgres DSN (never printed).
    ARCHIVE_ROOT               the star_group1 root (default /mnt/archive/star_group1); mounted read-only.
    D1_INBOX_URL               the Directus base URL for auto-link (default http://directus:8055).
    D1_INBOX_CRAWLER_SECRET    the shared secret for POST /d1-inbox/auto-link; empty switches auto-link off.
    INBOX_OCR                  1 to read the FEI data bar with rapidocr-onnxruntime (default off; the crawler
                               image does not install it yet, see backlog SEM7: without it no bar is read). With
                               it on, a FEI TIFF that has a bar is read too, as a cross-check of its metadata.
    INBOX_OCR_DEVICE           auto|cpu|cuda for that OCR (default cpu; auto takes the GPU when onnxruntime has one).
    INBOX_TICK_S               seconds between claims of scan requests (default 30).
    INBOX_PRIVATE_SCHEMA       the schema holding the inbox tables (default d1_private; tests use another).
    STORAGE_NAME, ROOT_FOLDER  as for scripts/index_archive.py (defaults star, star_group1).
    INBOX_LOG_LEVEL            DEBUG logs every file the crawler opens (default INFO).
    INBOX_PERSON_DIR           the top-level folder of the personal folders (default Users; the lab share's is User).
    INBOX_ONLY_FOLDERS         trial runs: scan only these comma-separated folder names (default: everyone).

Modes (exactly one; each takes the single-crawler database lock and exits 1 when another crawler holds it):
    --daemon      run forever, polling inbox_crawler_state.
    --once        one scan of everyone, then exit.
    --reclassify  one pass over the undecided image candidates (state new or dismissed) that the current
                  classifier version has not looked at: each is re-read through the read-only share
                  (throttled by the state row's read_mb_per_s, with INBOX_OCR as above), promoted to
                  sem_image or demoted to image, and stamped with the version. Never touches a linked row;
                  resumable and idempotent (a second run reads only the rows the first one skipped). Logs
                  the promoted, demoted and unchanged counts.
                  Only a permanent read failure (no permission, refused by the allow-list, over 64 MB) is
                  marked, so it is not retried; a missing file or a transient error is skipped and stays
                  queued for the next run (a missing file does not count toward an abort).
                  --force (only with --reclassify) ignores classified_by and re-reads every eligible row once:
                  run `--reclassify --force` once after rapidocr is installed and INBOX_OCR=1 is set, to
                  promote bar-only PNG/JPEG/BMP exports (without --force a second run reads nothing).
                  Exit 0 when it ran to its end or was stopped; exit 1 when it ABORTED because the share root
                  stopped answering (or its Users folder, as on an unmounted share), or 25 transient reads failed in a row (nothing after that point is marked, what was
                  committed stays), or the pass failed, or the lock is held; 2 for a configuration error.
    --sem-backfill  one pass over the pointer rows that are linked (to a sample, operation, test session or
                  surface scan), image-typed, unowned (no provenance owner) and have no imaging-settings row:
                  each is read through the read-only share (throttled, INBOX_OCR as above), and when it is an
                  SEM image d1_private.save_sem_settings writes its settings (read_by 'backfill'; a person's
                  corrections are never overwritten, and a re-read that carries fewer values keeps the
                  stored ones). Resumable, one visit per row per run; an unreadable file is logged and
                  skipped. Logs the saved count. Same exit codes and the same share abort as --reclassify.
"""

from __future__ import annotations

import argparse
import logging
import os
import signal
import sys
import threading

from . import autolink, daemon, db, fs_readonly, hashing, maintenance, owners

log = logging.getLogger("inbox_crawler")


_LEVELS = {
    "DEBUG": logging.DEBUG,
    "INFO": logging.INFO,
    "WARNING": logging.WARNING,
    "ERROR": logging.ERROR,
    "CRITICAL": logging.CRITICAL,
}


def _log_level(name: str | None) -> int:
    """INBOX_LOG_LEVEL as a logging level; anything that is not one falls back to INFO."""
    return _LEVELS.get((name or "").strip().upper(), logging.INFO)


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
    mode.add_argument(
        "--reclassify",
        action="store_true",
        help="re-read undecided image candidates with the current classifier version, then exit",
    )
    mode.add_argument(
        "--sem-backfill",
        action="store_true",
        help="save imaging settings for linked, unowned SEM images that have none, then exit",
    )
    ap.add_argument(
        "--force",
        action="store_true",
        help="with --reclassify: ignore classified_by and re-read every eligible image candidate",
    )
    ap.add_argument(
        "--root",
        default=os.environ.get("ARCHIVE_ROOT", "/mnt/archive/star_group1"),
        help="the star_group1 root; every path the crawler stores is relative to it",
    )
    args = ap.parse_args(argv)
    if args.force and not args.reclassify:
        ap.error("--force is only valid with --reclassify")
    return args


def main(argv=None) -> int:
    args = _parse(argv)
    raw_level = os.environ.get("INBOX_LOG_LEVEL")
    logging.basicConfig(
        level=_log_level(raw_level),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    if raw_level and raw_level.strip().upper() not in _LEVELS:
        log.warning(
            "INBOX_LOG_LEVEL=%r is not a log level (use DEBUG, INFO, WARNING, ERROR); using INFO",
            raw_level,
        )
    try:
        owners.set_person_base(os.environ.get("INBOX_PERSON_DIR"))
        owners.set_only_folders(os.environ.get("INBOX_ONLY_FOLDERS"))
    except ValueError as exc:
        log.error("%s", exc)
        return 2
    if owners.ONLY_FOLDERS is not None:
        log.warning(
            "INBOX_ONLY_FOLDERS is set: scanning only %s",
            ", ".join(sorted(owners.ONLY_FOLDERS)),
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
    one_pass = args.reclassify or args.sem_backfill
    linker = None
    if not one_pass:  # a pass over existing rows never auto-links
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
        heartbeat_dsn=dsn,
        private_schema=schema,
    )
    if not store.try_crawler_lock():
        log.error(
            "another inbox crawler holds the database lock (a daemon, or a --once run): "
            "%s",
            "not starting a second daemon"
            if args.daemon
            else "refusing to run alongside it",
        )
        return 1
    stop = threading.Event()
    if one_pass:
        return _run_pass(args, store, share, stop)
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
        old.close_heartbeat()
        try:
            old.conn.close()
        except Exception:  # noqa: BLE001
            pass
        holder["conn"] = db.connect(dsn, schema)
        new = db.Store(
            holder["conn"],
            storage=old.storage,
            root_folder_name=old.root_folder_name,
            heartbeat_dsn=dsn,
            private_schema=schema,
        )
        # The lock went with the old connection: take it again, or someone else has it now.
        if not new.try_crawler_lock():
            raise RuntimeError("the single-crawler lock is held by another process")
        return new

    d.run_forever(reconnect)
    return 0


def _run_pass(args, store: db.Store, share, stop: threading.Event) -> int:
    """--reclassify or --sem-backfill: one pass under the lock the caller took. SIGTERM or SIGINT stops it between files (what
    is done is committed; run it again to finish)."""
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())
    throttle = hashing.Throttle(None)
    state = store.load_state()
    store.commit()
    if state is not None:
        throttle.set_rate(hashing.mb_per_s(state["read_mb_per_s"]))
    log.info("reading %s READ-ONLY", args.root)
    try:
        extra = {"force": args.force} if args.reclassify else {}
        stats = (
            maintenance.reclassify if args.reclassify else maintenance.sem_backfill
        )(
            store,
            share,
            throttle=throttle,
            ocr=os.environ.get("INBOX_OCR") == "1",
            stop=stop.is_set,
            **extra,
        )
    except Exception as exc:  # noqa: BLE001 (the class only: the text can echo the DSN)
        store.rollback()
        log.error("the pass failed: %s", type(exc).__name__)
        return 1
    return 1 if stats.aborted else 0


if __name__ == "__main__":
    sys.exit(main())
