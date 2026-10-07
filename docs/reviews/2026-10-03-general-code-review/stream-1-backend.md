# Stream 1 — `apps/force-app/backend`, `backup-server`, `bug-report-relay` (raw reviewer report)

Unverified reviewer output unless noted; the consolidated report records which findings the
coordinator checked. Findings 1 and 2 were reproduced by the reviewer by running code.

## Blocking

1. **A consumer-thread exception hangs the session in "recording" forever.**
   `backend/app/session.py:332-371` (`_consume` has no try/except) with
   `backend/app/acquisition/ring.py:38-40` (`Ring.close()` is an untimed `Queue.put`), called from
   `_run`'s `finally` (`session.py:228`). The producer fills the 128-slot ring, `put(timeout=5)`
   sets "consumer overrun", then `close()` blocks forever: no `raw.close()`/fsync, no
   `backup.stop()`, no finalize; `/record/stop` can't complete. Repro: `OSError` injected into
   `raw.append` on chunk 20 → after 12 s `state=recording error='consumer overrun'`, run thread
   alive, `qsize=128`, 100 rows on disk. Fix: try/except in `_consume` that records `self.error`
   and signals stop; make `close()` non-blocking.
2. **Virtual-channel formulas that pass validation crash at record time.**
   `backend/app/virtual_channels.py:107-123`, `:170-177` (catches only `FormulaError`),
   `backend/app/channels.py:181-205`. `min(Fx)`, `sqrt()` (`TypeError`) and `1/0`
   (`ZeroDivisionError`) are accepted by `PUT /nidaq/channels`, then kill the consumer (→ 1);
   finalize and recovery raise too. Fix: arity checks in `_validate`; wrap `evaluate` so any
   `Exception` becomes `FormulaError`.
3. **Autostart binds the unauthenticated recorder to all interfaces.**
   `backend/scripts/start_recorder.ps1:35` passes `--host 0.0.0.0`; the Doctor fix text at
   `backend/app/main.py:954` shows the same. `main.py:2362-2365` documents loopback binding as the
   only mitigation for the API having no auth (`DELETE /captures/{id}`, `/record/stop`,
   `/storage/config`, `/labamp/*`, `/logs/download`, the live WS). Fix: `127.0.0.1`.
4. **Invariant 3: NI-DAQ endpoints lack the `_busy()` guard.** `main.py:2526`
   (`/nidaq/tacho/start`), `:2557` (stop), `:2441`, `:2456`, `:2469`, `:2503`. The tacho generator
   drives PFI0, the tacho input of the channel being sampled, so toggling it mid-recording corrupts
   RPM. No test calls `/nidaq/tacho`.

## Should fix

5. `main.py:1737` → `:1777`, `:1794` → `:1803` — `/record/start` checks `_busy()` then awaits
   before assigning `_session`; `start_replay` awaits `file.read()` (`:1821`). Two overlapping POSTs
   both start; the first session is orphaned. Re-check immediately before construction.
6. `recovery.py:199-206` — `is_safe_id("C:")` is True; on Windows `ntpath.join(root, "C:", …)`
   escapes the root, so `DELETE /captures/C:` could `rmtree("C:")` (cwd-relative). Backup
   `_session_dir` likewise. **Uncertain** (not run on Windows). Reject `:`; check `commonpath`.
7. `main.py:324-334` — no Origin/Host check: a visited web page can no-cors POST `/record/stop`,
   send empty-type JSON bodies to `/record/start` and `/storage/config`, and open the WS (no CORS
   on WebSockets). **Uncertain** (not browser-tested). Add Origin/Host middleware incl. the WS
   handshake.
8. `main.py:1831-1840` vs `config.py:68` (`le=600`) — replaying a cut longer than 600 s raises
   `ValidationError` → bare 500. Clamp or return 422.
9. `backup-server/server.py:233-247` — a duplicate `/ingest/start` truncates `raw.d1rw` (432 → 32
   bytes in a TestClient repro) and clears the tombstone. Not hit by the current client; any retry
   or replay would.
10. `bug-report-relay/server.py:101-103` — `time.mktime` on GitHub's UTC `expires_at` (off by the
    host's UTC offset); no cache clear/retry on 401. Latent (container runs UTC). Use
    `calendar.timegm`.
11. `ruff check` fails: UP031 at `backend/tests/test_nidaq.py:78`.

## Nits

`backup-server/server.py:348-353` `session_info` bypasses `_session_dir`; `:236` bad hex → 500;
`:297-304`, `:326-327` non-atomic `meta.json` writes; `bug-report-relay/server.py:113` `title` has
no `max_length`; truncated D1LC upload raises `struct.error` → 500; `main.py:2380-2399`
`/labamp/config` persists unvalidated `channels`/`mode`; `main.py:911` Doctor probes a
body-supplied `directus_url` without `_validate_outbound_url`; `stop_recorder.ps1` uses
`Stop-Process -Force` (skips graceful finalize).

## Checked and fine

D1RW offset-idempotent chunks; finalize block/stride arithmetic, drift/gain/tacho passes,
`MAT_MAX_BYTES`; D1LC v1/v2 gating; `_claim_capture` and restore ordering; the AST-whitelisted
formula evaluator; the `_capture_file` filename check (apart from 6).

## Test gaps

Consumer dying while the source produces; formula arity / constant division; busy guard on
`/nidaq/tacho/*`; `is_safe_id` with drive letters; duplicate `/ingest/start` with data; concurrent
`/record/start`; replay > 600 s.

## Checks run

backend `ruff check` 1 error (UP031); `pytest` 441 passed, 1 deselected. backup-server 39 passed.
bug-report-relay 8 passed.
