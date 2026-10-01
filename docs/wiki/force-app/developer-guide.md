# Developer guide

[← Force App wiki](README.md)

For people changing the Force App. The user-facing pages of this wiki describe behaviour. This one
describes the code.

## Layout

| Path | What |
|---|---|
| `apps/force-app/web/` | Vue 3 + Vite single-page app: every screen. Built twice: `dist/` (base `/app/`, served by Caddy for browsers) and `dist-desktop/` (base `/`, loaded by the shell over `app://force/`). |
| `apps/force-app/desktop/` | Electron shell: sidecar supervisor, `app://` protocol, menus, auto-updater, window state |
| `apps/force-app/backend/` | FastAPI recorder sidecar: acquisition sources (`sim`, `nidaq`), the `raw.d1raw` writer, finalize to `.mat` + live cache, Lab Amp proxy, recovery, live backup, logs, bug reports |
| `apps/force-app/backup-server/` | the live-backup ingest server deployed on d1-server |
| `apps/force-app/bug-report-relay/` | forwards in-app bug reports to GitHub issues |
| `packages/force-plotting/` | shared plotting: `ForceDashboard` (the Plot page), `FrmCloud`, `PolarPlot`, the Diagnostics Workbench and the geometry modules. The Directus extension `core/extensions/d1-force-dashboard` hosts the same dashboard. |
| `plugins/filter-service/` | FastAPI service for filter previews and spectra (`/run`, `/fft`, `/spectrogram`) |
| `plugins/diag-service/` | the diagnostics preview service (`/diag`) |
| `scripts/force_orchestrator.py`, `scripts/diag/`, `scripts/matlab/` | host-side processing: MATLAB `process_force.m`, octrees, diagnostics bakes |

## Running it from source

### Windows, with the desktop shell

From the repo root:

```powershell
npm install
npm run build:web:desktop
npm run build -w force-app-desktop
npm run dev -w force-app-desktop
```

The shell spawns the backend from `apps/force-app/backend/.venv`. Create it once:

```powershell
cd apps\force-app\backend
py -3.11 -m venv .venv
.venv\Scripts\pip install -e ".[dev]"      # add ,nidaq on the acquisition PC
```

### Any OS, in a browser, without hardware

This is how the screenshots in this wiki were made. You need a Directus to sign in to. Either
point the app at an existing one, or run the stack from the [database wiki's developer
guide](../database/developer-guide.md).

```bash
# 1. Recorder backend (simulated NI-DAQ, mock Lab Amp)
cd apps/force-app/backend
python -m venv .venv && .venv/bin/pip install -e ".[dev]"
FORCE_APP_CAPTURES=/tmp/fa/captures FORCE_APP_CONFIG_DIR=/tmp/fa/config \
FORCE_APP_LOG_DIR=/tmp/fa/logs LABAMP_MODE=mock \
  .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8200

# 2. Web UI on http://localhost:5180 (from the repo root)
npm install
npm run dev -w force-app-web

# 3. Optional: the filter service, for Plot's Power/Spectro/Waterfall and filters
cd plugins/filter-service
DIRECTUS_URL=http://localhost:8055 FILTER_CORS_ORIGINS=http://localhost:5180 \
  ../../apps/force-app/backend/.venv/bin/python -m uvicorn app.main:app --port 8000
```

Then open `http://localhost:5180`. Set the endpoints in **Settings → Connectivity → Service
endpoints**: Directus `http://localhost:8055`, filter service `http://localhost:8000`. They are
stored in `localStorage` under `force-app.config.override`. You can also build with
`VITE_DIRECTUS_URL`, `VITE_RECORDER_URL`, `VITE_FILTER_URL`, `VITE_DIAG_URL` and
`VITE_OCTREE_URL`, or drop a `config.json` next to `index.html`.

Directus must allow the app's origin in CORS: `CORS_ENABLED=true` and
`CORS_ORIGIN=http://localhost:5180,app://force`.

## Tests

```powershell
npm run test        -w @d1/force-plotting     # plotting / geometry unit tests (vitest)
npm run test        -w force-app-web           # SPA unit tests
npm run test        -w force-app-desktop       # Electron main-process unit tests
npm run test:e2e    -w force-app-desktop       # Playwright, driving the real built app
cd apps/force-app/backend       && .venv\Scripts\pytest
cd apps/force-app/backup-server && ..\backend\.venv\Scripts\pytest
cd plugins/filter-service       && pytest
```

Four backend tests fail on the acquisition PC itself because they expect the simulated
hardware. This is known (see [force-app-operations.md](../../force-app-operations.md#known-quirks--dont-chase-these)).
The [hardware checklist](../../force-app-operations.md#hardware-checklist) covers what the rig
needs a human for.

## Releasing

1. Bump `apps/force-app/desktop/package.json`'s `version`.
2. Add an entry at the top of `apps/force-app/web/src/changelog.ts`. This is what
   **Settings → About → What's new** shows.
3. Tag `force-app-v<version>` and push the tag.

`.github/workflows/force-app-release.yml` checks that the tag matches `package.json`, runs the
backend, backup-server and desktop unit tests, freezes the backend with PyInstaller
(`force-app-backend.spec`), packages the NSIS installer (`ForceApp-Setup-<version>.exe`), runs
the Playwright smoke tests against it and attaches it to a GitHub Release. A scheduled
task on d1-server republishes it to the update feed within about five minutes, and installed apps
pick it up from there (see [force-app-operations.md](../../force-app-operations.md#deploying-the-auto-publish-task)).

## Things worth knowing before changing code

- **Recording state lives in the backend**, not the page. The Record page reconnects to it; the
  shell's banner polls `/record/status`. Don't hold recording state only in a component.
- **Replay is playback, not recording**: `record/playback/engine.ts` drives the same live
  client from an archived cache and writes nothing. Spectra come from the backend's stateless
  `/dsp/spectrum`, so replay and live use the same scipy code.
- **`RecordClient` is a plain class, not a reactive object.** Only its `ref`s (`frameSeq`,
  `fftSeq`, `status`) are reactive, so a `computed` that reads other fields (`fft`, `trace`,
  `frm`) must also read the matching sequence ref, or it caches its first result forever. That
  is why, in v0.1.30 and earlier, the live FFT panel stayed blank and Spectrogram / Waterfall
  ignored a change of channel.
- **Upload order is deliberate**: the operation row first (its id is needed), then the files, then
  the analysis row. See `uploadCutToDatabase()` in `record/workspace.ts`.
- **Directus can't filter on keys inside JSON fields** (`recorded_metadata.capture_id`). Store
  anything you need to query in a real column.
- Design documents for most features are in [`docs/superpowers/specs/`](../../superpowers/README.md),
  and the packaging decisions are in [ADR-0010](../../adr/0010-force-app-extraction-and-electron-packaging.md).
