---
name: inbox-crawler-conventions
description: Background knowledge for any change to the inbox crawler (scripts/inbox_crawler/, tests/scripts/test_inbox_crawler_*, the inbox-crawler compose service). Load before editing or reviewing it. States the read-only and allow-list invariants and how the tests enforce them.
user-invocable: false
paths:
  - scripts/inbox_crawler/**
  - tests/scripts/test_inbox_crawler_*
---
# Inbox crawler conventions

Spec: `docs/superpowers/specs/2026-10-15-found-files-inbox-design.md`. Decision: `docs/adr/0020-*`.
Words follow `CONTEXT.md` § Files on the share: **found file**, **inbox**, **backlog**, **link**, **personal
folder**, **team folder**, **uni alias**. The crawler is the **inbox crawler**; `force_orchestrator.py` is the
**force crawler**.

## Invariants (a violation is a blocker)

1. **Read-only against the share, always.** Exactly one module, `fs_readonly.py`, touches the share, and it
   exposes only `scandir`, `stat` and `open_rb`. No other module imports `os`, `shutil` or `pathlib` for
   anything but pure path maths (`os.path`/`PurePath` string work is fine). Never call `remove`, `unlink`,
   `rename`, `replace`, `rmdir`, `mkdir`, `makedirs`, `chmod`, `chown`, `truncate`, `utime`, `symlink`,
   `copy*`, `move*`, `write*`, or `open` with any mode other than `rb` on a share path.
2. **An allow-list decides what is read.** `open_rb(path, adopted=False)` refuses a path whose extension is not
   in `READ_ALLOWLIST` (images `.tif .tiff .jpg .jpeg .png .bmp`; surface scans from `SCAN_EXTENSIONS`,
   v1 `.al3d`) unless `adopted=True`, which the caller may pass only for a candidate a person has linked
   (`state='linked'`). Documents, `.mat`, camera raw and unknown types are listed by name, size and mtime only.
3. **Idempotent and resumable.** A re-run changes nothing it already settled; killing it mid-scan loses
   nothing; an unreadable file is recorded and skipped, never retried in a tight loop; a share that drops
   mid-scan (every path looks absent) aborts the scan and marks nothing `gone`.
4. **Identity matches the indexer.** `directus_files.id` is the indexer's uuid5 of the path relative to
   `star_group1`; import the rule, do not copy it. `storage='star'`.
5. **The crawler never creates a link.** It never writes a link or a link bookkeeping column; it only re-points
   existing file references when a file moves, via the indexer's `repoint_file_references`. Linking and
   auto-linking go through the `d1-inbox` extension.
6. **No secrets in logs.** Never print `SMB_PASS` or `DATABASE_URL`.

## Checks to run before each commit

- `python -m pytest tests/scripts/test_inbox_crawler_*.py -q` (Postgres-backed tests need the scratch
  Postgres: see `scripts/dev/script-runner.Dockerfile` and `tests/scripts/conftest.py`).
- `tests/scripts/test_inbox_crawler_readonly.py` must pass: it AST-scans the package for the forbidden calls
  above and checks `open_rb` refusals.
- `ruff`/`pre-commit run --files <changed>` as the repo's lint does.

## Testing the unreadable

Use temporary directories, never a real share. Simulate a vanished share by making the root disappear
between listing and stat. Simulate unreadable files with a path that raises `PermissionError` through a fake
`fs_readonly` backend, not by `chmod` on test data.
