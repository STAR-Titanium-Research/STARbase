# Changing a force file format (e.g. D1LC v2 trailer, 1489c4b)

Read `../../force-app-conventions/references/formats.md` first. It lists every implementation of
each format.

## The pattern that has worked

1. **Bump the version** in the writer, and write the new version only when there is something new
   to write. Otherwise emit the old version byte-for-byte (D1LC v1 with no extras).
2. **Additive layout**: a trailer or a wider block. Never move or resize existing fields.
3. **Every reader accepts v(n-1) and v(n)**, gated on the header version. An unknown future version
   is a clear error, not a misparse.
4. **Change every implementation in the same change.** For D1LC that's five:
   - `apps/force-app/backend/app/d1lc.py`
   - `plugins/filter-service/app/d1lc.py`
   - `scripts/diag/d1lc.py`
   - `scripts/matlab/process_force.m::write_live_cache`
   - `packages/force-plotting/src/liveCache.ts`

   For D1LF it's two: `backend/app/stream/frame.py` and `web/src/record/liveClient.ts`.
   For D1RW: `backend/app/d1rw.py` and the reader in `backup-server/server.py`.
5. **Round-trip tests on both sides**, including a fixture of the *old* version: `test_d1lc.py`,
   `liveCache.test.ts`, `filter-service/tests/test_filters.py`, `tests/scripts/diag/test_pipeline.py`,
   `test_formats.py`. A TS reader test fed bytes from the Python writer catches endianness and
   padding drift.
6. Update the module docstrings (they document the layout) and, for a design change, the relevant
   spec.

## Gotchas

- Magic encodings differ: D1RW/D1LF write 4 raw bytes, D1LC writes a u32 (`CL1D` on disk).
- The MATLAB writer can't be tested here. Mark it "needs MATLAB on d1-server", and keep the change
  mechanical enough to review by eye.
- `diag-service` copies `scripts/diag/` at build time, so its image must be rebuilt to pick up a
  `scripts/diag/d1lc.py` change.
- Archived files are never rewritten. New readers must keep reading every file already in the
  archive and MinIO.
- `.mat` layout changes are archive-format changes: they go in `docs/force-file-standards.md`, with
  a new `fileVersion` and a reader branch keyed on `VariableNames`.
