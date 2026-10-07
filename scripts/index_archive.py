#!/usr/bin/env python3
"""Index the read-only SMB archive into the Directus File Library.

Walks the star_group1 subtree of the university file store and registers each
link-worthy file as a *pointer* row in directus_files (storage='star'), mirroring
the directory tree into directus_folders. No bytes are copied: Directus and the
worker plugins read the file from their own read-only `/mnt/archive` mount, and
the canonical relative path is also stored in directus_files.metadata.archive_path
so plugins can resolve a link without depending on filename_disk.

This makes the archive browsable in the Directus File Library (click-through, like
Explorer) so users can link a specific file to a manufacturing operation via the
"Linked Data Files" picker. It does NOT serve downloads through Directus.

Idempotent: folder/file IDs are deterministic (uuid5 of the relative path), so
re-runs upsert in place — safe as a nightly cron to keep the index current.

Usage
-----
    # In a container with the archive_share volume + DB on the compose network:
    make index-archive

    # On the host, against the mapped drive and the local DB:
    DATABASE_URL="postgres://d1:$POSTGRES_PASSWORD@localhost:5432/d1_database" \
        ARCHIVE_ROOT='Z:\\star_group1' python scripts/index_archive.py

    # Preview only (no DB writes):
    ... python scripts/index_archive.py --dry-run

Environment
-----------
    DATABASE_URL   required — Postgres DSN.
    ARCHIVE_ROOT   path to the star_group1 root (default /mnt/archive/star_group1).
                   MUST equal Directus's STORAGE_STAR_ROOT so filename_disk resolves.
    STORAGE_NAME   Directus storage location name (default 'star').
    ROOT_FOLDER    File Library name for the top folder (default 'star_group1').
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import logging
import mimetypes
import os
import sys
import time
import uuid
from datetime import UTC, datetime
from pathlib import PurePosixPath

# psycopg2 is imported lazily inside main() so --dry-run needs no DB driver.

log = logging.getLogger("index_archive")

# Deterministic namespace — every run produces the same IDs for the same paths,
# so re-runs upsert rather than duplicate.
_NS = uuid.uuid5(uuid.NAMESPACE_DNS, "d1-database.archive-index.v1")

# Link-worthy extensions.
ALLOWED_EXT = {
    ".mat",
    ".m",
    ".fig",
    ".mlx",  # MATLAB
    ".doc",
    ".docx",  # Word
    ".pdf",  # PDF
    ".xls",
    ".xlsx",
    ".csv",  # Excel / CSV
    ".pptx",  # PowerPoint
    ".tif",
    ".tiff",  # TIFF
    ".jpg",
    ".jpeg",
    ".png",
    ".bmp",
    ".nef",
    ".psd",  # images (incl. Nikon RAW, Photoshop)
    ".h5oina",
    ".ctf",
    ".ang",
    ".cpr",
    ".crc",  # EBSD
    ".h5",
    ".dat",
    ".sef",
    ".dm3",
    ".dwd",
    ".mst",
    ".out",
    ".cfg",  # instrument / raw data
    ".stl",
    ".ply",  # 3D meshes
    ".mp4",  # video
}

# mimetypes doesn't know the science/office formats on Windows; be explicit so
# `type` is never NULL (Directus uses it for the icon + detail panel).
_EXTRA_MIME = {
    ".mat": "application/x-matlab-data",
    ".fig": "application/x-matlab-figure",
    ".mlx": "application/x-matlab-live-script",
    ".m": "text/x-matlab",
    ".h5oina": "application/x-hdf5",
    ".ctf": "application/octet-stream",
    ".ang": "application/octet-stream",
    ".cpr": "application/octet-stream",
    ".crc": "application/octet-stream",
    ".pdf": "application/pdf",
    ".csv": "text/csv",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".h5": "application/x-hdf5",
    ".nef": "image/x-nikon-nef",
    ".psd": "image/vnd.adobe.photoshop",
    ".stl": "model/stl",
    ".dm3": "application/octet-stream",
    ".sef": "application/octet-stream",
    ".dat": "application/octet-stream",
    ".dwd": "application/octet-stream",
    ".mst": "application/octet-stream",
    ".out": "application/octet-stream",
    ".cfg": "application/octet-stream",
    ".ply": "application/octet-stream",
}

# directus_files.filename_disk is varchar(255). Deep archive paths can exceed that;
# when they do we leave filename_disk NULL (the link still works via archive_path).
_FILENAME_DISK_MAX = 255

BATCH = 1000

# Light fingerprint: size + sha256 of the first and last 64 KB. Survives a
# move/rename (content unchanged) while reading at most 128 KB per file — a
# ~1000x cheaper read than a full hash for big .mat/.h5/.tif files. READ-ONLY
# (opened 'rb', never written). References to a moved file are auto-re-pointed,
# but only when the match is unambiguous (see is_confident_move): a head/tail
# fingerprint cannot tell apart two zero-padded or otherwise near-identical files.
_FP_CHUNK = 64 * 1024

# Junction tables (table, parent column). A re-point that would duplicate an
# existing (parent, new file) link drops the old link instead of failing.
_JUNCTIONS = [
    ("operation_data_files", "operation_id"),
    ("sample_data_files", "sample_id"),
    ("session_data_files", "session_id"),
]

_PG_UNIQUE_VIOLATION = "23505"

_FILE_FK_SQL = """
SELECT c.conrelid::regclass::text,
       quote_ident(a.attname),
       array_length(c.conkey, 1)
FROM pg_constraint c
JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
WHERE c.contype = 'f'
  AND c.confrelid = 'directus_files'::regclass
  AND c.conrelid <> 'directus_files'::regclass
ORDER BY 1, 2
"""


def find_file_fk_columns(cur) -> list[tuple[str, str, int]]:
    """Every (table, column, n_columns) holding a FK to directus_files, from the catalog.

    Discovered rather than hard-coded: machining_force_analysis (ON DELETE CASCADE),
    archive_metadata_edits, fast_run_data, tools/equipment images and anything a
    later migration adds all reference directus_files.
    """
    cur.execute(_FILE_FK_SQL)
    return [(t, c, int(n)) for t, c, n in cur.fetchall()]


def is_confident_move(
    old_name: str | None,
    new_rel: str,
    n_new_matches: int,
    n_old_candidates: int,
) -> bool:
    """Decide whether a fingerprint match is safe to auto-re-point.

    The fingerprint is size + head/tail 64 KB, so it is not unique for padded or
    near-identical files. Cheap guards: exactly one new file carries the fingerprint,
    exactly one vanished row carries it, and the file name is unchanged (a move to
    another folder, not a rename). Anything else is flagged missing for a human.
    """
    if n_new_matches != 1 or n_old_candidates != 1:
        return False
    return bool(old_name) and old_name == PurePosixPath(new_rel).name


def repoint_file_references(
    cur, fks: list[tuple[str, str, int]], old_id: str, new_id: str
) -> int:
    """Re-point every FK to directus_files from old_id to new_id; return the references left.

    Each UPDATE runs in a savepoint: a unique violation (the new file already has its
    own force-analysis row, say) leaves that reference on the old row rather than
    aborting the sweep. Multi-column FKs are never rewritten, only counted.
    """
    junction_parent = dict(_JUNCTIONS)
    remaining = 0
    for table, col, ncols in fks:
        if ncols == 1:
            parent = junction_parent.get(table)
            if parent:
                cur.execute(
                    f"DELETE FROM {table} d WHERE d.{col}=%s AND EXISTS "
                    f"(SELECT 1 FROM {table} e WHERE e.{parent}=d.{parent} AND e.{col}=%s)",
                    (old_id, new_id),
                )
            cur.execute("SAVEPOINT repoint_fk")
            try:
                cur.execute(
                    f"UPDATE {table} SET {col}=%s WHERE {col}=%s", (new_id, old_id)
                )
            except Exception as exc:
                if getattr(exc, "pgcode", None) != _PG_UNIQUE_VIOLATION:
                    raise
                cur.execute("ROLLBACK TO SAVEPOINT repoint_fk")
                log.warning(
                    "%s.%s: new file already linked; keeping the reference on the old row",
                    table,
                    col,
                )
            cur.execute("RELEASE SAVEPOINT repoint_fk")
        cur.execute(f"SELECT count(*) FROM {table} WHERE {col}=%s", (old_id,))
        remaining += cur.fetchone()[0]
    return remaining


def fingerprint(path: str, size: int) -> str | None:
    """size + sha256(head 64KB)+sha256(tail 64KB). None on read error."""
    try:
        h = hashlib.sha256()
        with open(path, "rb") as f:  # read-only; never mutates the file
            if size <= 2 * _FP_CHUNK:
                h.update(f.read())
            else:
                h.update(f.read(_FP_CHUNK))
                f.seek(-_FP_CHUNK, os.SEEK_END)
                h.update(f.read(_FP_CHUNK))
        return f"{size}:{h.hexdigest()}"
    except OSError:
        return None


def folder_id(relpath: str) -> uuid.UUID:
    return uuid.uuid5(_NS, "folder:" + relpath)


def file_id(relpath: str) -> uuid.UUID:
    return uuid.uuid5(_NS, "file:" + relpath)


def guess_type(name: str) -> str:
    ext = PurePosixPath(name).suffix.lower()
    return (
        _EXTRA_MIME.get(ext)
        or mimetypes.guess_type(name)[0]
        or "application/octet-stream"
    )


def main() -> int:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true", help="count only; no DB writes")
    ap.add_argument(
        "--root",
        default=os.environ.get("ARCHIVE_ROOT", "/mnt/archive/star_group1"),
        help="the star_group1 root; all archive_path values are relative to this",
    )
    ap.add_argument(
        "--subdir",
        default="",
        help="scan only this subpath under --root (paths stay relative to --root). For test runs.",
    )
    ap.add_argument(
        "--limit",
        type=int,
        default=0,
        help="stop after N files (0 = no limit). For test runs.",
    )
    ap.add_argument(
        "--fingerprint",
        action="store_true",
        help="compute a light head/tail fingerprint per file so links survive "
        "moves to another folder (same file name; reads up to 128 KB/file; cached across runs).",
    )
    ap.add_argument(
        "--fp-workers",
        type=int,
        default=16,
        help="parallel threads for fingerprint reads (SMB is latency-bound).",
    )
    args = ap.parse_args()

    root = args.root
    subdir = args.subdir.strip().strip("/\\")
    scan_root = os.path.join(root, subdir) if subdir else root
    storage = os.environ.get("STORAGE_NAME", "star")
    root_folder_name = os.environ.get("ROOT_FOLDER", "star_group1")

    if not os.path.isdir(root):
        log.error("ARCHIVE_ROOT does not exist or is not a directory: %s", root)
        return 2
    if subdir and not os.path.isdir(scan_root):
        log.error("--subdir does not exist under root: %s", scan_root)
        return 2
    log.info("Scanning %s (paths relative to %s), READ-ONLY.", scan_root, root)

    conn = None
    if not args.dry_run:
        import psycopg2
        import psycopg2.extras

        dsn = os.environ.get("DATABASE_URL")
        if not dsn:
            log.error("DATABASE_URL is required (omit only with --dry-run)")
            return 2
        conn = psycopg2.connect(dsn)
        conn.autocommit = False

    now = datetime.now(UTC)
    # Folders we've already ensured this run (memoised) → avoid redundant upserts.
    seen_folders: set[str] = set()
    seen_ids: set[str] = set()  # every file id touched this run (for missing sweep)
    # fingerprint -> [(file id, rel path), ...] for move detection; more than one
    # entry means identical-looking files, which are never auto-matched.
    seen_fp: dict[str, list[tuple]] = {}
    pending: list[tuple] = []  # files awaiting (parallel) fingerprint + insert
    folder_rows: list[tuple] = []
    file_rows: list[tuple] = []
    n_files = 0
    n_skipped = 0
    n_dirs = 0
    n_fp_computed = 0
    start_t = time.monotonic()
    last_log = start_t

    # Reuse prior fingerprints for unchanged files (keyed by id → size, modified).
    fp_cache: dict[str, tuple] = {}
    if args.fingerprint and conn is not None:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id::text, filesize, metadata::jsonb->>'modified', "
                "metadata::jsonb->>'fingerprint' FROM directus_files WHERE storage=%s",
                (storage,),
            )
            for fid_, sz_, mod_, fp_ in cur.fetchall():
                if fp_:
                    fp_cache[fid_] = (sz_, mod_, fp_)
        log.info(
            "fingerprint cache: %d prior fingerprints loaded (unchanged files skip the read).",
            len(fp_cache),
        )

    def flush_folders() -> None:
        if not folder_rows or conn is None:
            folder_rows.clear()
            return
        with conn.cursor() as cur:
            psycopg2.extras.execute_values(
                cur,
                "INSERT INTO directus_folders (id, name, parent) VALUES %s "
                "ON CONFLICT (id) DO NOTHING",
                folder_rows,
            )
        folder_rows.clear()

    def flush_files() -> None:
        if not file_rows or conn is None:
            file_rows.clear()
            return
        with conn.cursor() as cur:
            psycopg2.extras.execute_values(
                cur,
                """
                INSERT INTO directus_files
                    (id, storage, filename_disk, filename_download, title, type, folder,
                     filesize, metadata, created_on, modified_on, uploaded_on)
                VALUES %s
                ON CONFLICT (id) DO UPDATE SET
                    storage           = EXCLUDED.storage,
                    filename_disk     = EXCLUDED.filename_disk,
                    filename_download = EXCLUDED.filename_download,
                    title             = EXCLUDED.title,
                    type              = EXCLUDED.type,
                    folder            = EXCLUDED.folder,
                    filesize          = EXCLUDED.filesize,
                    metadata          = EXCLUDED.metadata,
                    modified_on       = EXCLUDED.modified_on
                """,
                file_rows,
            )
        file_rows.clear()

    def flush_batch() -> None:
        """Fingerprint the pending files (in parallel), build rows, insert, commit."""
        nonlocal n_fp_computed
        if not pending:
            return
        fps: dict[int, str] = {}
        if args.fingerprint:
            to_compute = []  # (index, fullpath, size)
            for i, e in enumerate(pending):
                fid_, size_, mtime_ = e[0], e[7], e[8]
                cached = fp_cache.get(fid_)
                if cached and cached[0] == size_ and cached[1] == mtime_.isoformat():
                    fps[i] = cached[2]  # unchanged → reuse, no read
                else:
                    to_compute.append((i, e[2], size_))
            if to_compute:
                with concurrent.futures.ThreadPoolExecutor(
                    max_workers=args.fp_workers
                ) as ex:
                    futs = {
                        ex.submit(fingerprint, path, sz): idx
                        for idx, path, sz in to_compute
                    }
                    for fut in concurrent.futures.as_completed(futs):
                        r = fut.result()
                        if r:
                            fps[futs[fut]] = r
                n_fp_computed += len(to_compute)

        for i, e in enumerate(pending):
            (
                fid_,
                rel_,
                _full,
                name_,
                title_,
                disk_,
                dirfid_,
                size_,
                mtime_,
                ctime_,
                ext_,
            ) = e
            fp = fps.get(i)
            if fp:
                seen_fp.setdefault(fp, []).append((fid_, rel_))
            meta = {
                "archive_path": rel_,
                "source": "uosfstore/shared/star_group1",
                "extension": ext_,
                "size_bytes": size_,
                "modified": mtime_.isoformat(),
                "created": ctime_.isoformat(),
                "indexed_on": now.isoformat(),
            }
            if fp:
                meta["fingerprint"] = fp
            file_rows.append(
                (
                    fid_,
                    storage,
                    disk_,
                    name_,
                    title_,
                    guess_type(name_),
                    dirfid_,
                    size_,
                    json.dumps(meta),
                    ctime_,
                    mtime_,
                    now,
                )
            )
        pending.clear()
        flush_folders()  # parents before children (FK-free, but keeps order sane)
        flush_files()
        if conn is not None:
            conn.commit()

    def ensure_folder(rel_dir: str) -> uuid.UUID:
        """Ensure the folder row (and all its ancestors) exist; return its id."""
        fid = folder_id(rel_dir)
        if rel_dir in seen_folders:
            return fid
        if rel_dir == "":
            folder_rows.append((str(fid), root_folder_name, None))
        else:
            parent = PurePosixPath(rel_dir).parent
            parent_rel = "" if str(parent) == "." else str(parent)
            parent_id = ensure_folder(parent_rel)
            folder_rows.append((str(fid), PurePosixPath(rel_dir).name, str(parent_id)))
        seen_folders.add(rel_dir)
        return fid

    ensure_folder("")  # the top-level star_group1 folder

    stop = False
    for dirpath, _dirnames, filenames in os.walk(scan_root):
        # Skip dedup quarantine folders (identical duplicates moved aside).
        _dirnames[:] = [d for d in _dirnames if d != "_dedup_removed"]
        rel_dir_os = os.path.relpath(dirpath, root)
        rel_dir = (
            ""
            if rel_dir_os == "."
            else PurePosixPath(
                *PurePosixPath(rel_dir_os.replace(os.sep, "/")).parts
            ).as_posix()
        )
        dir_fid = None  # resolved lazily, only if this dir has an allowed file

        for name in filenames:
            ext = PurePosixPath(name).suffix.lower()
            if ext not in ALLOWED_EXT:
                n_skipped += 1
                continue

            rel = name if rel_dir == "" else f"{rel_dir}/{name}"
            try:
                # os.stat = a single READ-ONLY metadata call (size + timestamps).
                st = os.stat(os.path.join(dirpath, name))
            except OSError as exc:  # transient SMB hiccup — skip, next run picks it up
                log.warning("stat failed, skipping %s: %s", rel, exc)
                continue

            size = st.st_size
            mtime = datetime.fromtimestamp(st.st_mtime, tz=UTC)
            # On Windows (host indexing) st_ctime is the file CREATION time.
            ctime = datetime.fromtimestamp(st.st_ctime, tz=UTC)

            if dir_fid is None:
                dir_fid = ensure_folder(rel_dir)

            fid = str(file_id(rel))
            title = PurePosixPath(name).stem  # human-readable name shown in the Library
            filename_disk = rel if len(rel) <= _FILENAME_DISK_MAX else None

            # Defer fingerprint + row build to flush_batch, which reads files in
            # parallel (SMB is latency-bound). created_on/modified_on there carry
            # the file's real timestamps.
            pending.append(
                (
                    fid,
                    rel,
                    os.path.join(dirpath, name),
                    name,
                    title,
                    filename_disk,
                    str(dir_fid),
                    size,
                    mtime,
                    ctime,
                    ext,
                )
            )
            seen_ids.add(fid)
            n_files += 1

            if len(pending) >= BATCH:
                flush_batch()
                log.info("indexed %d files (%d skipped)…", n_files, n_skipped)

            if args.limit and n_files >= args.limit:
                log.info("reached --limit %d, stopping.", args.limit)
                stop = True
                break

        # Time-based progress so you get a heartbeat even through long stretches of
        # non-matching files (e.g. tens of thousands of .dat/.jpg being skipped).
        n_dirs += 1
        t = time.monotonic()
        if t - last_log >= 10:
            el = t - start_t
            log.info(
                "progress: %d dirs, %d files indexed, %d skipped, %.0fs (%.0f files/s)…",
                n_dirs,
                n_files,
                n_skipped,
                el,
                (n_files / el if el > 0 else 0),
            )
            last_log = t
        if stop:
            break

    flush_batch()  # remaining pending files

    # Broken-link detection. Only on a FULL run — a scoped/limited run doesn't see
    # the whole tree, so it can't tell what's genuinely gone. Flag star rows whose
    # path was NOT seen this run; do NOT delete them, so any sample links survive
    # and a human can re-point them. Reappeared files self-clear: their upsert
    # overwrote metadata without the missing flag.
    if conn is not None and not subdir and args.limit == 0:
        n_moved = 0
        with conn.cursor() as cur:
            cur.execute(
                "CREATE TEMP TABLE _seen_ids (id uuid PRIMARY KEY) ON COMMIT DROP"
            )
            psycopg2.extras.execute_values(
                cur,
                "INSERT INTO _seen_ids (id) VALUES %s ON CONFLICT DO NOTHING",
                [(i,) for i in seen_ids],
                page_size=1000,
            )

            # Candidates = star rows NOT seen this run (moved, renamed, or deleted).
            cur.execute(
                "SELECT df.id::text, df.metadata::jsonb->>'fingerprint', df.filename_download "
                "FROM directus_files df "
                "WHERE df.storage=%s AND NOT EXISTS (SELECT 1 FROM _seen_ids s WHERE s.id = df.id)",
                (storage,),
            )
            candidates = cur.fetchall()
            n_old_by_fp: dict[str, int] = {}
            for _oid, fp, _nm in candidates:
                if fp:
                    n_old_by_fp[fp] = n_old_by_fp.get(fp, 0) + 1
            fks = find_file_fk_columns(cur)

            missing_ids = []
            n_ambiguous = 0
            for old_id, fp, old_name in candidates:
                matches = seen_fp.get(fp, []) if fp else []
                if matches and is_confident_move(
                    old_name, matches[0][1], len(matches), n_old_by_fp[fp]
                ):
                    # Same content, same name, unique on both sides → it MOVED.
                    # Re-point every reference (all FKs to directus_files, from the
                    # catalog), then delete the old row only if nothing references it.
                    new_id, _new_path = matches[0]
                    if new_id == old_id:
                        continue
                    left = repoint_file_references(cur, fks, old_id, new_id)
                    if left == 0:
                        cur.execute("DELETE FROM directus_files WHERE id=%s", (old_id,))
                        n_moved += 1
                    else:
                        log.warning(
                            "moved file %s still has %d reference(s); keeping the old row, "
                            "marked missing",
                            old_id,
                            left,
                        )
                        missing_ids.append(old_id)
                else:
                    if matches:
                        n_ambiguous += 1
                        log.warning(
                            "not auto-re-pointing %s: fingerprint match is ambiguous or "
                            "the file name changed (%d new candidate(s))",
                            old_id,
                            len(matches),
                        )
                    missing_ids.append(old_id)

            newly_missing = 0
            if missing_ids:
                # Genuinely gone (no content match) → flag but KEEP, so any links
                # survive for a human to re-point.
                cur.execute(
                    "UPDATE directus_files df SET metadata = (jsonb_set(jsonb_set("
                    "COALESCE(df.metadata::jsonb,'{}'::jsonb),'{missing}','true'::jsonb,true),"
                    "'{missing_since}',to_jsonb(COALESCE(df.metadata::jsonb->>'missing_since',%s)),true))::json "
                    "WHERE df.id = ANY(%s::uuid[]) "
                    "AND COALESCE(df.metadata::jsonb->>'missing','false') <> 'true'",
                    (now.isoformat(), missing_ids),
                )
                newly_missing = cur.rowcount

            cur.execute(
                "SELECT count(*) FROM directus_files "
                "WHERE storage = %s AND (metadata::jsonb->>'missing') = 'true'",
                (storage,),
            )
            total_missing = cur.fetchone()[0]
        conn.commit()
        log.info(
            "sweep: %d moved (links re-pointed), %d newly missing "
            "(%d ambiguous matches left for a human), %d total missing (kept, not deleted).",
            n_moved,
            newly_missing,
            n_ambiguous,
            total_missing,
        )

    if conn is not None:
        conn.close()

    verb = "would index" if args.dry_run else "indexed"
    fp_note = f" | {n_fp_computed} fingerprints computed" if args.fingerprint else ""
    log.info(
        "Done: %s %d files into %d folders (%d non-matching skipped)%s.",
        verb,
        n_files,
        len(seen_folders),
        n_skipped,
        fp_note,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
