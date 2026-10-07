# Force data formats

Every format here has more than one implementation, written in different languages by different
people. **A format change is a change to every copy at once, behind a version bump, with a
round-trip test on each side.**

## Binary formats (all little-endian)

| Format | What | Header | Implementations (keep in step) | Tests |
|---|---|---|---|---|
| **D1RW** `raw.d1raw` | append-only raw stream while recording; source of truth | 32 B: `4s` magic `b"D1RW"`, u32 version, u32 n_cols, f32 rate, f64 start_unix, 8 pad. Then float32 rows, col 0 = Time | `backend/app/d1rw.py`; reader in `backup-server/server.py` (chunked ingest) | `backend/tests/test_formats.py`, `backup-server/test_server.py` |
| **D1LC** `live_cache.bin` | decimated finished-cut cache every viewer renders from | 32 B: u32 magic `0x44314C43`, u32 version, u32 N, f32 Fs, feed, diam, cs_sec, ce_sec. Then float32[N] × 6: t, Fx, Fy, Fz, rpm, revs_cum. v2 appends a named trailer; readers populate only `{Mz, X, Y, Z}` | `backend/app/d1lc.py`, `plugins/filter-service/app/d1lc.py`, `scripts/diag/d1lc.py`, `scripts/matlab/process_force.m::write_live_cache`, `packages/force-plotting/src/liveCache.ts` | `backend/tests/test_d1lc.py`, `filter-service/tests/test_filters.py`, `force-plotting/src/liveCache.test.ts`, `tests/scripts/diag/test_pipeline.py` |
| **D1LF** WebSocket frame | live frames on `/record/stream` | 48 B: `4s` magic `b"D1LF"`, u32 version (now **3**), seq, t_sec, rpm, peaks, nTotal, nTrace, nSub, nPts. Then trace[nTrace×7], sub[nTrace×nSub×2], pts[nPts×5] = x, y, cx, cy, cz | `backend/app/stream/frame.py` (writer), `web/src/record/liveClient.ts` (reader) | `backend/tests/test_api.py`, `web` vitest |
| **D1AN** `base.d1an` | diagnostics columns | see `scripts/diag/d1an.py` | `scripts/diag/d1an.py`, `force-plotting/src/diagViewport.ts`, `diagPreview.ts`, `diagAttrs.ts` | `tests/scripts/diag/*`, `diag*.test.ts` |

**Magic gotcha:** D1RW and D1LF write the magic as 4 raw bytes (`b"D1RW"`). D1LC writes it as a
u32, so the bytes on disk are `CL1D`. Each reader checks the encoding its writer uses, so don't
"fix" one to match the other.

Version rules that held so far: a new version is **additive** (trailer or wider block),
version-gated in every reader, and v(n-1) files still parse. A writer that has nothing new to write
emits the old version byte-identically (D1LC v1 when there are no extras).

## `.mat` (v1.0, written by `backend/app/finalize.py`)

- `DATA` columns: `Time, Fx1, Fx2, Fy1, Fy2, Fz1, Fz2, Fz3, Fz4, Tacho`, plus `VariableNames`.
  Aux and virtual channels are appended **after column 10**, never inserted.
- Skipped above `MAT_MAX_BYTES = 1_500_000_000` (MAT5's 32-bit size field). `summary.json` then has
  `mat_written: false` and `mat_skip_reason`. The capture is still valid via D1RW + D1LC.
- MATLAB (`scripts/matlab/process_force.m`, run by `scripts/force_orchestrator.py`) reads these
  files read-only from the archive share.

## Archive layouts (`docs/force-file-standards.md`: read it before touching any reader)

- Four historical layouts: v0.1 (13 columns, already summed), v0.5 (lowercase `data` + `timestamps`),
  v1.0 (above), v0.9 truncated (10 columns, no tacho).
- **Identify by `VariableNames`, never by column count.** v0.9 and v1.0-without-extras both have 10 columns.
- `fileVersion` overrides inference. Stamping it on a file without restructuring its matrix silently
  corrupts it (22 archive files are graded "X" for exactly this).
- Don't re-sum v0.1. `metadata.Rate` is authoritative over the Lab Amp's `samplingRate`.
  `AmpSettings` is an opaque signed blob: pass it through, don't parse it.
- `SampleName` inside files is often stale. The filename `{sample_code}-F{n}` is the reliable key.
- `matfile` partial writes work only on v7.3 files.

## `summary.json` (per capture folder)

Written atomically at finalize: `fs`, `n`, `duration_sec`, `channels`, `peaks`, `cut_window_sec`,
`tacho_measured`, `mat_written`/`mat_skip_reason`, `file_sizes_mb`, `channels_ranging`, `metadata`,
`config`, `files`. A folder with `raw.d1raw` and no `summary.json` is either live or
crashed-incomplete. `recovery.py` tells them apart by the live session id (#29).
