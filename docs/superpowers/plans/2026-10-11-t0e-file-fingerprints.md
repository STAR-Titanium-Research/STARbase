# T0e: file fingerprints — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every linked file gets a content hash, and every `.mat` force file also a hash of its
decoded force data, so a file can be recognised after a move, a rename or a metadata-only edit; the
rule is written into the force-file standard for the future `.mat` migration.

**Architecture:** One migration (159) adds `file_fingerprints`. A host-side script
`scripts/file_fingerprints.py` (the host is the only place that can read the lab share — the Docker
workers have neither the share nor a database driver) computes `content_sha256` by streaming the file,
and for `.mat` files `data_sha256` from the decoded main force array (h5py for v7.3, streamed in
blocks; scipy for v6/v7), and writes one row per file. It is resumable (only new, stale, missing or
errored files), throttled (one global MB/s cap), retries share errors, and re-checks size and mtime
after reading. Phases: `linked` (files linked to operations, samples, tests and force analyses — 187
share files, 137 GB) and `all` (the rest of the share, 2.26 TB, days). Local uploads are read through
`docker exec d1-database-directus-1` (only that container mounts the uploads volume).

**Tech Stack:** PostgreSQL 16 + dbmate, Python 3 (psycopg2, h5py, numpy, scipy), pytest, Docker.

**Spec:** [`docs/superpowers/specs/2026-10-10-record-codes-design.md`](../specs/2026-10-10-record-codes-design.md)
§7, Q43/Q45/Q46. Stage **T0e**.

## Global Constraints

- Worktree `.claude/worktrees/t0-record-codes`, branch `feat/record-codes`; never the main checkout or
  live; trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Migration version `20261010000159` (live tops at `20261010000158`). COMMENTs on everything; down
  exact. The table is not exposed in Directus.
- `data_sha256` definition (spec §7, amended during Task 2): SHA-256 over the array's MATLAB shape
  as two little-endian uint64 (rows, cols), then, **for each column in order**, the 32-byte SHA-256
  digest of that column's values as float64 little-endian (top to bottom). (cols = 0 → the shape
  alone; rows = 0 → each column digest is SHA-256 of nothing.) Computed in one pass over the file:
  read blocks of whole chunk-rows `ds[:, k:k+n]` (all columns) and feed one hasher per column.
  The variable read is `data` when present, else `DATA` (layout from the
  variables, not from `fileVersion`: 22 files declare v1 but carry the v0.9 layout). Not the bytes on
  disk.
- Old `.mat` files are never written to (Q46). The script only reads (`open(..., 'rb')`, h5py `'r'`).
- Staleness key: `size_bytes` = `directus_files.filesize` and `source_mtime` =
  `COALESCE((metadata::jsonb->>'modified')::timestamptz, modified_on)` **as read from the database at
  selection time** (the indexer writes the share mtime into `metadata.modified` and `modified_on` on
  every run; Directus may bump `modified_on` on a metadata edit, `metadata.modified` it does not). The
  on-disk stat is used only for the before/after re-check, never stored.
- Memory: never hold more than one block (default 64 MiB of float64) of a force array at a time per
  worker on the h5py path. The largest file is one 14.6 GB array.
- The script never runs automatically; the coordinator runs the `linked` phase once; the `all` phase
  is the maintainer's to start.

## Decisions where the spec was silent or wrong (flagged)

1. **Host script, not the heavy-data worker** (spec §7 named it): the worker has no Postgres driver
   and no share mount; the host already reads the share (the Force crawler does).
2. **A separate script, not a phase of `force_orchestrator.py`**: no change to the running crawler
   daemon; the two share one rule — do not run the `all` phase while a force crawl is busy.
3. **Status per file** (`done` / `error` / `missing`) with an error message, so unreadable, moved or
   corrupt files are recorded; `missing` and `error` rows are retried on every run (a file may come
   back; a share hiccup is not permanent) — `--skip-failed` turns that off.
4. **Moves:** `scripts/index_archive.py` discovers every FK to `directus_files` from the catalog and
   re-points it when a file moves, so it will also re-point `file_fingerprints`. Fingerprints are
   derived data: when the new row already has its own fingerprint, the old one is dropped instead of
   blocking the move (Task 3).
5. **Local uploads via `docker exec`** into the Directus container.

## Review Focus

1. **Share drops mid-run** → every path looks absent; expected: the run aborts and leaves rows
   untouched, it does not mark all 187 files `missing`. (Task 3 test.)
2. **Huge v7.3 arrays** → expected: memory stays at one block per worker; the h5py path reads
   `ds[j, k:k+n]` blocks, never a whole column. (Task 2 test with a tiny block size.)
3. **A file that crashes the decoder** → expected: it is recorded `error` and the next run moves on;
   it can never wedge every run at the same oldest file. (Task 3 test.)
4. **A file moved on the share after hashing** → expected: the indexer's move keeps or merges the
   fingerprint, never fails on a duplicate key. (Task 3 test.)
5. **Wrong orientation** → expected: `data_rows` is the sample count (long dimension) for a real
   force file, identical between the v5 and v7.3 readers. (Task 2 test + Task 5 real-file check.)

---

### Task 1: Migration 159 — `file_fingerprints`

**Files:** create `db/migrations/20261010000159_file_fingerprints.sql`; modify `tests/phase1_schema.sh`
(new section), `docs/data-dictionary.md`.

```sql
-- migrate:up
-- File identity (stream T0e, spec 2026-10-10-record-codes §7). Why: codes now follow their fields and
-- file names on the share keep the code at capture time, so a file needs an identity of its own.
-- content_sha256 covers the whole file; data_sha256 (.mat only) covers the decoded force array, so a
-- metadata-only edit (the future .mat metadata migration) keeps it. Filled by scripts/file_fingerprints.py.
SET LOCAL lock_timeout = '10s';
CREATE TABLE file_fingerprints (
    directus_files_id UUID PRIMARY KEY REFERENCES directus_files (id) ON DELETE CASCADE,
    status            TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('done', 'error', 'missing')),
    content_sha256    TEXT CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
    data_sha256       TEXT CHECK (data_sha256 ~ '^[0-9a-f]{64}$'),
    data_variable     TEXT CHECK (data_variable IN ('data', 'DATA')),
    data_rows         BIGINT CHECK (data_rows >= 0),
    data_cols         BIGINT CHECK (data_cols >= 0),
    size_bytes        BIGINT CHECK (size_bytes >= 0),
    source_mtime      TIMESTAMPTZ,
    error_message     TEXT,
    hashed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT file_fingerprints_done_has_hash CHECK (status <> 'done' OR content_sha256 IS NOT NULL)
);
CREATE INDEX file_fingerprints_content_idx ON file_fingerprints (content_sha256);
CREATE INDEX file_fingerprints_data_idx ON file_fingerprints (data_sha256) WHERE data_sha256 IS NOT NULL;
-- + COMMENT ON TABLE, on every column and on both indexes. Wording to convey: content_sha256 = SHA-256
--   of the whole file; data_sha256 = the definition in this plan's Global Constraints, word for word;
--   size_bytes/source_mtime = the directus_files values the hash was taken against (staleness key);
--   status meanings; error_message = why a file could not be (fully) hashed.
-- migrate:down
DROP TABLE IF EXISTS file_fingerprints;
```

- [ ] **Step 1: Tests first** — a new section in `tests/phase1_schema.sh`, in the style of the
  existing sections (each check in a rolled-back transaction): table and both indexes exist; insert a
  fixture `directus_files` row (`storage='star'`, a fresh UUID) and a `done` fingerprint for it; a
  63-char or upper-case hex `content_sha256` is rejected (`check_violation`); `status='done'` with a
  NULL `content_sha256` is rejected; `status='missing'` with NULL hashes is accepted; deleting the
  `directus_files` row removes the fingerprint; every column has a comment. Run
  `bash scripts/dev/schema_test_docker.sh` → the new checks FAIL.
- [ ] **Step 2:** Write the migration. `ROUNDTRIP=1 bash scripts/dev/schema_test_docker.sh` → new
  checks PASS; only the 4 pre-existing FAIL lines remain (campaigns relations, audit trigger coverage,
  2× Lab Member access_rules.json).
- [ ] **Step 3:** `docs/data-dictionary.md` entry (table + columns), next to the other T0 entries.
- [ ] **Step 4:** Commit (`feat(db): file fingerprints table`).

### Task 2: The hashing library (pure, no database)

**Files:** create `scripts/file_fingerprints.py` (library functions only in this task) and
`tests/scripts/test_file_fingerprints.py`; add `"h5py==3.12.*"` to `scripts/dev/script-runner.Dockerfile`'s
pip line, to the script-tests job's pip line in `.github/workflows/ci.yml` (~line 181), and
`h5py>=3.10`, `numpy>=1.26`, `scipy>=1.11` to `scripts/requirements.txt`.

**Interfaces (produced, used by Task 3):**

```python
class FingerprintError(Exception): ...            # base
class NoForceArray(FingerprintError): ...         # neither 'data' nor 'DATA'
class BadForceArray(FingerprintError): ...        # not 2-D or not numeric
class UnreadableMat(FingerprintError): ...        # file cannot be parsed as a .mat

def content_sha256(stream_or_path, chunk: int = 8 << 20, throttle: "Throttle | None" = None) -> tuple[str, int]
    # accepts a path or a binary file object (Task 3 passes `docker exec ... cat` stdout); returns (hex, bytes read)
def mat_data_sha256(path, block_bytes: int = 64 << 20, throttle: "Throttle | None" = None) -> tuple[str, str, int, int]
    # returns (hex, variable, rows, cols) — rows/cols are the MATLAB shape
class Throttle:                                     # thread-safe global byte-rate cap
    def __init__(self, max_bytes_per_s: float | None): ...
    def consume(self, n: int) -> None: ...          # blocks so total rate across all threads <= cap; no-op if cap is None
```

Algorithm for `mat_data_sha256`:
- Detect v7.3: the file is HDF5 when bytes 512..519 equal `b"\x89HDF\r\n\x1a\n"` (MATLAB v7.3 files
  have a 512-byte header then HDF5) — also accept the signature at offset 0. Else treat as v5/v6/v7.
- **HDF5 path (h5py):** open `'r'`; pick dataset `data` if present else `DATA`; HDF5 stores the
  MATLAB array transposed, so `ds.shape == (cols, rows)` → `rows, cols = ds.shape[1], ds.shape[0]`.
  Hash `struct.pack('<QQ', rows, cols)`, then for `j in range(cols)`, for `k` in steps of
  `n = max(1, block_bytes // 8)`: `np.ascontiguousarray(ds[j, k:k+n], dtype='<f8').tobytes()`. This is
  MATLAB column-major order. Non-numeric dtype → `BadForceArray`; `ds.ndim != 2` → `BadForceArray`.
  `throttle.consume` is called with the bytes read per block.
- **v5 path (scipy):** `scipy.io.loadmat(path, variable_names=['data', 'DATA'])` (raises → wrap as
  `UnreadableMat`); pick `data` else `DATA`; must be a 2-D numeric ndarray; `rows, cols = a.shape`;
  hash the shape header, then for each column `np.ascontiguousarray(a[:, j], dtype='<f8').tobytes()`
  (column by column, no whole-array Fortran copy).
- Any `OSError` propagates unchanged (Task 3 retries those); h5py/scipy parse errors become
  `UnreadableMat`.

- [ ] **Step 1: Tests first** (`tests/scripts/test_file_fingerprints.py`, pure — no DB, use `tmp_path`):
  - helper `write_v73(path, name, a)`: write a MATLAB-v7.3-shaped file with h5py:
    `h5py.File(path, 'w', userblock_size=512)` and `create_dataset(name, data=a.T)` (so the HDF5 shape
    is `(cols, rows)`), then write 512 header bytes starting with `b"MATLAB 7.3 MAT-file"` into the
    userblock (open `'r+b'`, seek 0, write, pad to 512).
  - a 1000×4 float matrix written with `scipy.io.savemat` (v5) and with `write_v73` gives the **same**
    `data_sha256`, `rows == 1000`, `cols == 4`; and equals a hand-computed reference
    `sha256(pack('<QQ',1000,4) + a.astype('<f8').tobytes(order='F'))`.
  - the HDF5 path with `block_bytes=24` (3 values per block, forcing many blocks per column) gives the
    same hash — pins the streaming.
  - int16 data hashes as float64 (same hash as the float copy).
  - a file with both `data` and `DATA` uses `data`; a file with only `DATA` uses it; neither →
    `NoForceArray`; a 3-D array → `BadForceArray`; a text file renamed `.mat` → `UnreadableMat`.
  - metadata-only change: the same `data` saved with an extra variable (`info`) → same
    `data_sha256`, different `content_sha256`.
  - `content_sha256(path)` equals `hashlib.sha256(bytes).hexdigest()` and returns the byte count; works
    on a `BytesIO` too.
  - `Throttle(None).consume(...)` never sleeps; `Throttle(1000)` consuming 3000 bytes from two threads
    takes ≥ ~2 s (allow slack; mark the timing test so it stays under 5 s).
  Run `bash scripts/dev/script_tests_docker.sh` → new tests FAIL (module missing). Record the baseline
  count of the rest (434 passed at T0d).
- [ ] **Step 2:** Implement the library in `scripts/file_fingerprints.py` (module docstring: what the
  two hashes are, the definition, why — link spec §7).
- [ ] **Step 3:** Rebuild the runner image (the script bumps/rebuilds on Dockerfile change — check
  `scripts/dev/script_tests_docker.sh`; force a rebuild if it caches by tag) and run the suite → new
  tests PASS, no new failures.
- [ ] **Step 4:** Commit (`feat(scripts): content and force-data hashes for files`).

### Task 3: The runner (database, share, resumable) + moves in the indexer

**Files:** extend `scripts/file_fingerprints.py` with selection, a runner and a CLI; extend
`tests/scripts/test_file_fingerprints.py` (DB-level tests follow the skip conventions in
`tests/scripts/conftest.py`); modify `scripts/index_archive.py` (`repoint_file_references`) and
`tests/scripts/test_index_archive.py`.

**Interfaces:** consumes Task 2's functions. Produces
`select_files(cur, phase: str, include_local: bool, retry_failed: bool, limit: int | None) -> list[FileJob]`
(`FileJob` = dataclass `id, storage, archive_path, filename_disk, filename_download, size_bytes, source_mtime`),
`resolve_path(job, archive_root) -> str`, `fingerprint_job(job, archive_root, throttle, block_bytes) -> dict`
(the row values), `upsert_fingerprint(cur, file_id, row: dict)`, `main(argv)`.

CLI: `python scripts/file_fingerprints.py --phase linked|all [--workers 1] [--max-mb-s 60]
[--limit N] [--skip-failed] [--include-local] [--archive-root PATH] [--dry-run]`.
`DATABASE_URL` from the environment (like the other scripts).

- **Selection** (`select_files`): `directus_files` rows with `storage = 'star'` (plus `'local'` when
  `--include-local`); phase `linked` restricts to ids present in `operation_data_files`,
  `sample_data_files`, `session_data_files` or `machining_force_analysis` (read the actual column
  names from `db/migrations`); a row is selected when it has no fingerprint, or its stored
  `size_bytes`/`source_mtime` differ from the current staleness key (Global Constraints), or its status
  is `missing`/`error` (unless `--skip-failed`). Order: linked-ness irrelevant within a phase; order
  by `hashed_at NULLS FIRST, id` so never-tried files go first and a failing file moves to the back.
- **Paths** (`resolve_path`): `star` → `os.path.join(archive_root, *archive_path.split('/'))`
  (default root: `force_orchestrator.ARCHIVE_UNC` — import the constant or re-read the same
  `ARCHIVE_UNC` env var with the same default; never `filename_disk`); `local` → stream
  `docker exec d1-database-directus-1 cat /directus/uploads/<filename_disk>` stdout into
  `content_sha256` (and for a `.mat`, copy to a temp file first, then `mat_data_sha256` on it; delete
  the temp file).
- **Share health:** before selecting, `os.path.isdir(archive_root)` must be true or the run exits 2
  with a clear message and writes nothing. During the run, after **5 consecutive** missing files, stop,
  re-check the root; if it is gone, exit 2 (rows already written stay; the 5 are not marked); if it is
  there, mark them `missing` and carry on.
- **Per file** (`fingerprint_job`): stat before → if absent, `status='missing'`. Upsert a provisional
  row first (`status='error'`, `error_message='hashing started'`, staleness key filled) and commit, so
  a hard crash leaves the file recorded and it goes to the back of the queue. Then content hash; if the
  name ends in `.mat` (case-insensitive), the data hash (`FingerprintError` → `status='error'`,
  `error_message=str(exc)`, `content_sha256` kept). Stat after → if size or mtime moved, leave the
  provisional row with `error_message='file changed while hashing'`. `OSError` → retry 3× with
  backoff (2, 4, 8 s), then `status='error'`. Success → `status='done'`, `error_message=NULL`.
- **Concurrency:** `--workers` threads (default 1); each worker has its **own** psycopg2 connection;
  one shared `Throttle(max_mb_s * 1e6)`. Commit per file. Progress line every 10 files (done / error /
  missing / GB read / MB/s / ETA) and a final summary; exit 0 when the queue is drained.
- **`--dry-run`:** print each selected file, its resolved path and whether `os.path.exists` is true,
  plus totals (count, GB, how many paths exist); reads no file content, writes nothing.
- **Indexer moves** (`index_archive.py`, `repoint_file_references`): before the generic UPDATE, for
  table `file_fingerprints` delete the **old** file's fingerprint when the new file already has one
  (`DELETE FROM file_fingerprints WHERE directus_files_id=%s AND EXISTS (SELECT 1 FROM file_fingerprints
  WHERE directus_files_id=%s)`, old, new) — same shape as the junction-table dedupe. Update the
  docstring.

- [ ] **Step 1: Tests first** (DB-level, a migrated database, temp files in `tmp_path` standing in for
  the share, `archive_root=tmp_path`, fixture `directus_files` rows with `metadata.archive_path`,
  `metadata.modified`, `filesize`; link some via `operation_data_files` with a fixture op):
  1. a linked `.mat` (v5) gets a `done` row with both hashes and its shape; a linked `.txt` gets a
     `done` row with `data_sha256` NULL;
  2. a second run selects nothing;
  3. changing the fixture's `filesize` (or `metadata.modified`) makes it stale and re-hashed;
     changing only `modified_on` does not;
  4. a missing path → `missing`; the next run retries it; once the file appears it becomes `done`;
  5. a broken `.mat` → `error` with a message, `content_sha256` set, and it sorts behind never-tried
     files on the next selection;
  6. `--phase linked` ignores an unlinked file; `--phase all` takes it;
  7. archive root missing → exit code 2, no rows written;
  8. 5 consecutive missing files with the root deleted mid-run (simulate by deleting `tmp_path`
     contents and the dir after the first file) → exit 2, the missing ones not marked;
  9. the provisional row: patch `mat_data_sha256` to raise `SystemExit`/`KeyboardInterrupt`-like
     `BaseException` after the provisional commit → the row exists with `error_message='hashing
     started'`;
  10. `--dry-run` writes nothing and reports existence;
  11. indexer: with the migration applied, a fingerprint on OLD and none on NEW → re-pointed to NEW
      (`left == 0`); fingerprints on both → OLD's dropped, NEW's kept, `left == 0`. Add these next to
      the existing DB tests in `test_index_archive.py` (~line 149-210).
  Run the script tests → the new tests FAIL.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Script tests → all new PASS, no new failures vs the Task 2 count.
- [ ] **Step 4:** Commit (`feat(scripts): resumable file fingerprint runner; moves keep fingerprints`).

### Task 4: Standard and docs

**Files:** `docs/force-file-standards.md` — a new §3.4 "Record identity" (`RecordID`, `RecordShortID`
written only by new files' writers; readers use `isfield`; spec Q43) and a §6 subsection "Fingerprints
and migrations" (the two hashes; the exact `data_sha256` definition from Global Constraints; the
variable choice; a migration that rewrites the force matrix must record the new `data_sha256` against
the same `directus_files` row and keep the old one in its notes; old files are never rewritten — Q46);
`scripts/README.md` (the runner: phases, flags, the share-load rule "don't run `--phase all` during a
force crawl; ~83 MB/s single stream", how to read results:
`SELECT status, count(*) FROM file_fingerprints GROUP BY 1`); the spec's Status line and §7 (host
script, not the heavy-data worker; `missing`/`error` statuses); the round-2 plan's T0 row.

- [ ] Write; check every heading/anchor referenced from elsewhere still resolves; commit
  (`docs: file fingerprints in the force-file standard`).

### Task 5 (coordinator): verify, apply and run the linked phase

1. `bash scripts/dev/directus_smoke.sh` with 159 included (restored copy of live): Directus starts,
   existing cases pass; plus a file upload and delete through Directus on the copy (the new FK cascades).
2. Live pre-checks (no other pending migration, live tops at 158), backup, apply 159 with dbmate
   from the main checkout (copy the migration in, untracked, as for 150–158). No Directus restart
   needed (the table is not exposed).
3. On the host: `--phase linked --dry-run` — every path must exist (catches a Windows/UNC join bug the
   Linux tests cannot).
4. Hash one real v7.3 and one real v5 force file with `--limit`; check `data_rows`/`data_cols` against
   the sample counts the dashboard or `machining_force_analysis` already know (orientation check).
5. `--phase linked --workers 2 --max-mb-s 60` at a quiet time; record counts (done / error /
   missing) and duration in the Outcome. Leave `--phase all` (≈2.26 TB, days) to the maintainer.
