---
name: force-debug-capture
description: Runbook for a force-app recording that went wrong. Use for a capture that is missing, incomplete or won't finalize, a "Recording finished" that never appeared, an upload failure, wrong or flat forces, zero RPM, clipped channels, a recovery banner, a missing backup, or plots that stay empty. Starts from whatever the user has (bug-report issue, capture folder, backend.log, screenshot), investigates, and writes a structured report with the cause and the fix.
argument-hint: [issue number, capture id/path, or symptom]
---

# Debug a force capture

Input: `$ARGUMENTS`

## 0. Setup (once per machine)

Rig paths differ per PC. If `.claude/skills/force-debug-capture/config.json` exists, read it.
It is the gitignored copy of `config.example.json`, with keys for the captures root, log dir,
config dir, backend URL, backup-server URL and Directus URL. If it doesn't exist and you need a
path, ask the user with AskUserQuestion. Offer the defaults from `config.example.json` and
`docs/force-app-operations.md` → *Where things are kept*, then save their answers to
`config.json`. In a cloud session there is no rig: work from what the user pastes or attaches, and
from the GitHub issue.

## 1. Collect evidence

| Source | How |
|---|---|
| In-app bug report | GitHub issue on `dpremoli/D1-Database`, labelled `force-app` + `in-app-report` (+ `bug`, `area:*`). The body carries the app version, route, diagnostics and the log tail. Read it with the GitHub MCP tools |
| Capture folder | `python3 .claude/skills/force-debug-capture/inspect_capture.py <folder or captures root>`. It checks raw/manifest/summary/cache/.mat consistency, the incomplete state, tacho, clipping and the `.mat` skip |
| Backend log | `backend.log` (+3 rotated) in `log_dir`, or `GET <backend_url>/logs?level=WARNING&q=<capture id>&limit=2000` on the rig |
| Live state | `GET /record/status`, `/recovery/check`, `/health/check` (the Connectivity Doctor's data), `/backup/status`, `/backup/remote-sessions` |
| Backup copy | backup server `GET /sessions`, `/sessions/{id}/info`. It keeps raw streams for 12 h only |
| Database side | the `manufacturing_operations` / `machining_force_analysis` rows and their files in Directus (`error_message` on the analysis row) |

Note the app version first. Many symptoms were fixed in a specific release
(`apps/force-app/web/src/changelog.ts`). A rig on an old version needs an update, not a code fix.

## 2. Known causes by symptom

| Symptom | Look at |
|---|---|
| Folder has `raw.d1raw`, no `summary.json` | interrupted session. Recovery rebuilds it (`recovery.py`). If it's the *live* session it must not be offered for recovery (#29) |
| Raw ends mid-row | backend or PC died mid-chunk. The data up to the last full row is good |
| `mat_written: false` | capture > `MAT_MAX_BYTES` (1.5 GB). Expected: D1LC and summary are still valid, and the upload skips the `.mat` (#40) |
| Finalize OOM / app crash at stop | full-length float64 copies in `finalize.py`/`dsp.py`. Finalize must work in blocks |
| Flat or garbage forces from NI-DAQ | rotating config falling through to placeholder channels (`infer_dyno_kind`), missing `dyno_gains`, or the sim-chassis fallback (`nidaq_enum.py`) on a rig missing the DAQmx runtime |
| Forces jump mid-run | a Lab Amp write during recording. Every `/labamp/*` write must be `_busy()`-guarded (#33) |
| `tacho_measured: false`, RPM 0 | sensor or wiring, or wrong pulses-per-rev, **not** a code bug unless the raw Tacho column has clean edges |
| Clipped channels | the amp range is too small. Converge/auto-range between cuts (`labamp_autorange.py`) |
| Live FFT/spectrogram blank or stuck | a `RecordClient` computed missing its seq ref (fixed 0.1.31). Check the version |
| Upload disabled / fails | no Sample picked, offline, or the Directus role lacks create permission. A failed save may leave an orphan operation row |
| "upload state unknown" on every capture | Directus unreachable or signed out. Fixed in 0.1.31 for the always-on case |
| Plot FFT/Figure/Full/Diagnostics unavailable for an app-saved cut | expected. Only archive-indexed `.mat` files go through the orchestrator (troubleshooting wiki) |
| Settings revert after restart | config written into the install dir (old versions). It must be `%LOCALAPPDATA%\force-app` |
| App won't start, `whenReady` error | `ELECTRON_RUN_AS_NODE=1` in the environment |

`docs/wiki/force-app/troubleshooting.md` and `captures-and-recovery.md` cover the user-facing side.

## 3. Report

Write it as below. Post it on the issue only if the user asks.

```
## Capture <id> / issue #<n> — <one-line verdict>
**Version:** <app version>  **Source:** sim | nidaq | replay  **State:** <inspector state>
**What happened:** <timeline from log + files, with timestamps>
**Root cause:** <file:line or config/hardware cause, and how you know>
**Data:** <what is recoverable and how: recovery banner, backup server within 12 h, raw.d1raw re-finalize>
**Fix:** <code change (scaffold/test), config change, or "update to vX">  **Needs the rig to confirm:** <yes/no, what>
```

## Gotchas

- **Never modify or delete a capture folder** while investigating. Copy it if you need to experiment.
  `raw.d1raw` is the only original. `/careful` blocks the obvious destructive commands.
- Re-finalizing is safe only on a **copy**. `finalize` rewrites `.mat`, cache and summary in place.
- Don't diagnose a real-rig NI-DAQ or Lab Amp fault from the sim. The four backend tests that fail
  on the rig are a known quirk, not evidence.
- Bug-report bodies are redacted (`X:\Users\…` paths). Don't ask the user for unredacted logs in a
  public issue.
- Anything recorded or uploaded to a real Directus while reproducing goes in
  `apps/force-app/TEST_DATA.md` at the time you create it, so it can be cleaned up.
