# Force app architecture

```
 acquisition PC (Windows)                                d1-server (docker compose, tailnet)
 ┌───────────────────────────────────────────┐          ┌──────────────────────────────────────┐
 │ Electron shell  apps/force-app/desktop     │          │ Caddy proxy  infra/caddy/Caddyfile    │
 │  sidecar.ts ─ spawns/health-polls ─┐       │          │  /app/*  web/dist (browser build)     │
 │  protocol.ts app://force/  ← web/dist-desktop         │  /filter/*  → plugins/filter-service  │
 │  updater.ts ← feed /force-app-updates/     │  HTTPS   │  /diag/*    → plugins/diag-service    │
 │                                    ▼       │ ───────► │  /backup-ingest/* → backup-server     │
 │ FastAPI backend :8200  apps/force-app/backend         │  /bug-report-relay/* → relay → GitHub │
 │  sources/{sim,replay,nidaq}.py → session.py│          │ Directus :8055 (+ MinIO via /files)   │
 │  raw.d1raw → finalize.py → .mat + D1LC     │          │ force_orchestrator.py + MATLAB        │
 │  /labamp/* ──LAN──► Lab Amp                │          │   (archive .mat → machining_force_    │
 │  /record/stream (WS, D1LF frames)          │          │    analysis, octrees, diagnostics)    │
 └───────────────────────────────────────────┘          └──────────────────────────────────────┘
        ▲ web UI (Vue 3) talks to: backend (localhost:8200), Directus (Bearer), /filter, /diag, /octrees
```

## Components

| Path | Stack | Notes |
|---|---|---|
| `apps/force-app/backend/` | Python 3.11, FastAPI/uvicorn on `127.0.0.1:8200` | Never containerised. Endpoints all in `app/main.py`: `/record/*`, WS `/record/stream`, `/captures/*`, `/labamp/*`, `/nidaq/*`, `/backup/*`, `/recovery/*`, `/dsp/spectrum`, `/storage/*`, `/logs*`, `/support/report-bug`, `/health`, `/health/check`. Sources implement `AcquisitionSource` (`sources/base.py`). Frozen with PyInstaller (`force-app-backend.spec`). Extras: `[dev,build,nidaq]`. |
| `apps/force-app/web/` | Vue 3 + Vite + TS (`force-app-web`) | `build` → `dist/` (base `/app/`); `build:desktop` → `dist-desktop/` (base `/`). Areas: `record/`, `settings/`, `nidaq/`, `labamp/`, `force/`. Endpoints from `src/config.ts`: env `VITE_*` < `/config.json` < localStorage `force-app.config.override`. Dev server on **:5180** (Directus CORS). |
| `apps/force-app/desktop/` | Electron 43 + TS (`force-app-desktop`) | `main.ts`, `sidecar.ts` (supervisor, backoff restarts, Windows `taskkill /T`), `protocol.ts`, `updater.ts`, `preload.ts`. `electron-builder.yml`: NSIS, unsigned, `ForceApp-Setup-${version}`, keep `electronVersion` in step with the installed Electron. |
| `apps/force-app/backup-server/` | single-file FastAPI, :8210 | Receives chunked D1RW, 12 h retention, volume `backup-raw`. Tailnet-only and unauthenticated by design. **Never add a `ports:` mapping.** |
| `apps/force-app/bug-report-relay/` | FastAPI, :8211 | Holds the GitHub App key; files issues on `dpremoli/D1-Database` labelled `in-app-report`. Payload caps: body 100 000 chars, ≤ 20 labels. |
| `packages/force-plotting/` | Vue components from source, no build | `ForceDashboard`, `FrmCloud`, `FrmOctree`, `PolarPlot`, `SpectrumView`, `DiagnosticsWorkbench`, `ContextMenu`, modules `liveCache`, `path`, `angle`, `polar`, `colorScale`, `cloudPick` (map-point picking), `octreePick`, `chartMark`. Hosts plug in via `setForceHost()` (`src/host.ts`). |
| `core/extensions/d1-force-dashboard/` | Directus module | Second host of the plotting package. Build with `npm run build:extension`, then restart Directus. |
| `plugins/filter-service/` | FastAPI | Filter, FFT, spectrogram over D1LC. Forwards the caller's Directus credentials. |
| `plugins/diag-service/` | FastAPI | `/preview`, `/viewport` over D1AN. Built from the **repo root**, and copies `scripts/diag/` in. |
| `scripts/force_orchestrator.py` + `scripts/matlab/process_force.m` | host-side | Processes **archive** `.mat` files into `machining_force_analysis`, figures, octrees, diagnostics. Cuts uploaded by the app are `status = done` and are not processed. |

## Data flow of one cut

1. `POST /record/start` → `RecordingSession` appends float32 rows to `raw.d1raw`, streams D1LF frames
   over `/record/stream`, and mirrors chunks to the backup server if configured.
2. `POST /record/stop` → finalize runs in the background: `capture.mat` (if ≤ `MAT_MAX_BYTES`),
   `live_cache.bin` (D1LC) and `summary.json`.
3. Save dialog → `uploadCutToDatabase()` (`web/src/record/workspace.ts`): `manufacturing_operations`
   row → files through Directus `/files` (stored in MinIO) → `machining_force_analysis` row.
   Cold retry: `record/uploadCapture.ts`.
4. The Plot page reads the analysis row and D1LC through Directus. Power, spectrogram and waterfall go
   through filter-service. Figure, Full octree, stored FFT and Diagnostics come only from the
   orchestrator's output.

## Most-changed files (where conflicts and regressions cluster)

`backend/app/main.py`, `web/src/record/RecordPage.vue`, `force-plotting/src/index.ts`,
`force-plotting/src/ForceDashboard.vue`, `web/src/record/workspace.ts`.
