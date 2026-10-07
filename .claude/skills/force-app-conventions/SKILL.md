---
name: force-app-conventions
description: Background knowledge for any change to the force-capture app or its shared plotting. Covers the recorder backend, web UI, Electron shell, backup server, bug-report relay, @d1/force-plotting, the Directus force dashboard, the filter/diag services and the force file formats. Load before editing or reviewing files there. It lists the invariants that recent bugs came from.
user-invocable: false
paths:
  - apps/force-app/**
  - packages/force-plotting/**
  - core/extensions/d1-force-dashboard/**
  - plugins/filter-service/**
  - plugins/diag-service/**
  - scripts/diag/**
  - scripts/force_orchestrator.py
  - scripts/matlab/**
---

# Force app: what to know before changing it

The full map (components, ports, who calls whom) is in [references/architecture.md](references/architecture.md).
The binary and `.mat` formats and their lockstep rules are in [references/formats.md](references/formats.md).
Read the matching one before a structural change. `docs/wiki/force-app/developer-guide.md` is the
human version.

## Invariants: each one has broken before

1. **Recording state lives in the backend**, not a component. The Record page and the shell's
   banner reconnect to `/record/status` and `/record/stream`. Never hold recording truth only in
   Vue state.
2. **`RecordClient` is a plain class.** Only `frameSeq`, `fftSeq` and `status` are reactive. A
   `computed` reading `fft`, `trace` or `frm` must also read the matching seq ref, or it caches its
   first value forever. This caused the blank live FFT and the frozen spectrogram channel up to v0.1.30.
3. **Don't change hardware state mid-recording.** Every `/labamp/*` write is guarded by `_busy()`,
   because the amp's outputs feed the channels being sampled (#33). New endpoints that touch the amp,
   NI-DAQ config or storage must use the same guard.
4. **Captures can exceed what a `.mat` can hold.** Above `MAT_MAX_BYTES` (1.5 GB, MAT5's 32-bit
   limit) finalize skips the `.mat` and sets `summary.mat_written: false`. Uploads, Plot and anything
   else must handle a missing `.mat` (#40). Finalize must not allocate full-length float64 copies.
5. **`raw.d1raw` is the source of truth** and is never modified. Drift compensation and gains go into
   the `.mat` and the live cache only.
6. **Column order is a contract**: `Time, Fx1, Fx2, Fy1, Fy2, Fz1–Fz4, Tacho`. Extra (Aux/virtual)
   channels are only ever appended after column 10. Readers identify layouts by `VariableNames`, never
   by column count (`docs/force-file-standards.md`).
7. **Upload order is deliberate**: operation row → files → analysis row (`uploadCutToDatabase()` in
   `record/workspace.ts`). Credit the **recording** user, not whoever is signed in at upload time.
8. **Offline is a first-class mode.** A 401 the client can't refresh must not sign the operator out
   mid-shift (`authStore.ts`, `offlineAuth.ts`). Anything that writes to Directus must queue or say
   it can't, not crash.
9. **Directus can't filter on keys inside JSON fields.** Anything you'll query goes in a real
   column, which means a migration (`db-migration` skill).
10. **`setForceHost()` must run at bootstrap** in every host (web app and `d1-force-dashboard`), or
   FrmCloud throws. Plotting code reaches Directus, assets and services only through `ForceHost`
   (`packages/force-plotting/src/host.ts`), never by importing a host's client.
11. **Persisted layouts outlive releases.** Adding a panel type to the Plot dashboard must not bump
    `RIGHT_KEY` (`ForceDashboard.vue`), and the Record page's saved layout (`RecordPage.vue`
    `LS_KEY`) must still load. Unknown panel types are skipped, not fatal.
12. **Theme**: plot canvases take their background from `var(--plot-bg, …)`. `npm run lint:theme -w
    force-app-web` enforces it.
13. **Config, logs and captures never live in the install dir** (PyInstaller makes it read-only).
    They go under `%LOCALAPPDATA%\force-app` and the configured capture drive (`config.py`).
14. **Safety prompts stay.** The alarm-test gate before the first Start, the quit guard and the
    discard confirmation are deliberate (fbda167). Don't remove them to simplify a flow or a test.

## Where the tests are

| Area | Command | In CI |
|---|---|---|
| backend | `cd apps/force-app/backend && python -m pytest` | `force-app-python` + release |
| backup-server / bug-report-relay | `python -m pytest` in their folders | `force-app-python` (+ release for backup-server) |
| web | `npm test -w force-app-web`, `npm run typecheck -w force-app-web`, `npm run lint:theme -w force-app-web` | `force-app-js` |
| plotting | `npm test -w @d1/force-plotting`, `npm run typecheck -w @d1/force-plotting` | `force-app-js` |
| desktop | `npm test -w force-app-desktop`, `npm run typecheck -w force-app-desktop`; `npm run test:e2e -w force-app-desktop` (packaged app) | unit: `force-app-js` + release; e2e: release only (Windows) |
| Directus dashboard | `npm run build:extension` | `force-app-js` |
| filter / diag services | `python -m pytest` in `plugins/filter-service`, `plugins/diag-service` | `force-app-python` |
| `scripts/diag` | `python -m pytest tests/scripts` | no (golden tests are machine-sensitive) |

`ci.yml`'s `force-app-js` and `force-app-python` jobs run all of this on every PR. Run the suites
for what you touched **before** pushing anyway (`ci-local`), and use `force-app-verify` for
anything a unit test can't show. The packaged-app e2e suite still runs only on the Windows
release runner.

## Gotchas

- `main.py` is ~2,200 lines and the most-changed file. Add an endpoint next to its siblings
  (`/record/*`, `/captures/*`, `/labamp/*`, `/nidaq/*`) with a `tests/test_<area>_api.py`.
- `backend/tests/conftest.py`'s autouse `isolate_backup_config` stops tests from overwriting the
  developer's real backup config. Keep new config-writing tests behind the same isolation.
- `diag-service` builds with the **repo root** as context and copies `scripts/diag/` verbatim. A
  change to `scripts/diag` is a change to the service.
- After editing the Directus extension, rebuild (`npm run build:extension`) and
  `docker restart d1-database-directus-1`. After editing the Caddyfile, `docker compose restart proxy`.
- `ELECTRON_RUN_AS_NODE=1` in the environment crashes the shell at `whenReady`. It isn't a code bug.
- Backend Python follows ruff with line length 100 (`backend/pyproject.toml`).
