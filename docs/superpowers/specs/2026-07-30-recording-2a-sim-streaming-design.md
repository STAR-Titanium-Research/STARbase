# Recording — Slice 2a: Sim Acquisition + Live Streaming + Recording UI

**Status:** implemented 2026-07-30. First slice of Phase 2 (recording/acquisition) of the
standalone force app.

## Context

Phase 1 shipped the standalone plotting app (`apps/force-app/web`). Phase 2 reimplements the
recording side of the MATLAB `ABetterFactoryPlusApp`: hardware acquisition, live plotting, live
FRM, metadata, alarms, and 2-way Directus sync. Phase 2 is sliced into 2a–2e; this spec is **2a**.

**2a builds the real-time backbone with no hardware.** A local FastAPI backend synthesises a
turning cut, runs the producer/consumer buffering design, and streams decimated live frames over a
WebSocket to a new Recording section in the web app. On STOP it writes the capture to local files.
This de-risks the hardest parts (real-time streaming, bounded-ring buffering, the finalize/writer
pipeline, live UI) before any hardware exists.

**Key design choice:** the sim emits the **same raw channel layout as the NI-DAQ** (8 Kistler dyno
sub-channels + tacho), *not* pre-summed forces. So the entire downstream pipeline — channel
summing, gain, FRM integration, `.mat`/`live_cache` writing — is the real code 2b reuses unchanged;
only the *source* swaps (sim → `nidaqmx`). Sim and future DAQ implement one interface: yield chunks
of `[n_samples × n_channels]` raw values + timestamps.

### Decisions locked (brainstorming 2026-07-30)
- Hardware-free first; first slice = 2a.
- **NumPy-only** compute for 2a (vectorised per-chunk FRM/decimation). Wire in the `abfp_core` Rust
  crate later (2b+) when real 100 kHz rates demand it — the source/consumer interface stays put.
- **2a writes local files on STOP** (raw memmap + `.mat` + `live_cache.bin` + `summary.json`), no
  Directus. Writing `live_cache.bin` in the exact `D1LC` format lets the finished cut render through
  the **existing** `FrmCloud`/`ForceChart` with no new display code.

## Architecture

```
Recording UI (/record, Vue)                    Local FastAPI backend (apps/force-app/backend)
  config → POST /record/start  ───────────────▶  RecordingSession
  START/STOP                                        source (SimSource)  ──produces chunks──▶ Ring
  WS /record/stream  ◀──D1LF binary frames───       Ring ──▶ consumers:
    LiveForcePlot (rolling 3-axis, canvas)              • RawWriter  → memmap .d1raw (D1RW)
    LiveFrm (three.js accumulating spiral)              • Decimator  → min/max trace  ┐
  readouts (elapsed, rpm, peaks, N)                     • FrmIntegrator → new points  ┘→ WS frame
  STOP → GET /captures/{id}/live_cache.bin           STOP → finalize: memmap → sum/gain →
    render finished cut via existing FrmCloud             .mat (v1.0) + live_cache.bin (D1LC) + summary.json
```

## Backend (`apps/force-app/backend`)

Python 3.11+, FastAPI + uvicorn, numpy, scipy, python-mat (`scipy.io.savemat`). Layout:

- **`app/sources/base.py`** — `AcquisitionSource` protocol: `channels: list[str]`, `rate: float`,
  `start()`, `read() -> (timestamps: np.ndarray, data: np.ndarray[n, n_ch])`, `stop()`. The
  contract 2b's `NidaqSource` will also satisfy.
- **`app/sources/sim.py`** — `SimSource`: synthesises a turning cut at `rate` Hz. Channels
  `[Time?] Fx1,Fx2,Fy1,Fy2,Fz1,Fz2,Fz3,Fz4,Tacho` (9 signal channels; time carried separately).
  Profile: brief air-cut → ramp-up → steady cut (mean force per axis + gaussian noise + a small
  periodic component so the FRM spiral shows structure) → ramp-down. Tacho = a pulse train at
  `rpm·ppr/60`; RPM derived from it downstream (same path as real). Emits fixed-size chunks on a
  wall-clock cadence so the stream feels live.
- **`app/acquisition/ring.py`** — `Ring`: a pre-allocated `np.ndarray` circular buffer with a
  bounded handoff `queue.Queue` of chunk views; the producer copies each chunk and returns
  immediately (never blocks on consumers).
- **`app/acquisition/consumers.py`**:
  - `RawWriter` — append-only `.d1raw`: `D1RW` header (magic, version, n_channels, rate, ISO start,
    channel names) then interleaved `float32` rows. `fsync` periodically. Source of truth.
  - `Decimator` — per chunk, min/max reduce each summed axis to ~2 px-pairs so the rolling plot
    shows the envelope regardless of Fs.
  - `FrmIntegrator` — vectorised: integrate tacho→θ (`cumsum(rpm·2π/60·dt)`), ρ
    (`cumsum(-feed/10·rpm/60·dt)`), `pol2cart`, colour by chosen axis; emit only the NEW points
    since the last frame. Mirrors `process_force.m` FRM geometry and the MATLAB `LiveFRMPlot`.
- **`app/stream/frame.py`** — `D1LF` live-frame codec: little-endian header (magic `D1LF`, version,
  seq, t_sec, rpm, peakFx, peakFy, peakFz, nTotal, nTrace, nPts) + `float32` trace min/max +
  `float32` FRM point batch `(x, y, c)`. Compact binary; the frontend parses it like `liveCache.ts`.
- **`app/finalize.py`** — on STOP: `np.memmap` the `.d1raw` in blocks (constant memory) → sum
  (Fx=Fx1+Fx2, Fy=Fy1+Fy2, Fz=Fz1+Fz2+Fz3+Fz4) → gain (unity for sim) → compute rpm + revs_cum +
  cut-start/end secs → write **`live_cache.bin`** (`D1LC`, byte-identical to
  `plugins/filter-service/app/d1lc.py::serialise` / `process_force.m`), **`.mat`** (v1.0:
  `DATA=[Time,Fx1..Fz4,Tacho]`, `metadata` struct with the 20 recording fields + `VariableNames`),
  and **`summary.json`** (peaks, duration, N, Fs, config). Into `captures/<id>/`.
- **`app/session.py`** — `RecordingSession` state machine (`idle→recording→finalizing→done`),
  owns the source thread + ring + consumers + WS broadcast bridge (thread→asyncio via
  `run_coroutine_threadsafe`).
- **`app/main.py`** — FastAPI: `POST /record/start` (config → new session), `POST /record/stop`,
  `GET /record/status`, `GET /captures`, `GET /captures/{id}/live_cache.bin` (+ `.mat`, summary),
  `WS /record/stream`. CORS for the SPA origin (same pattern as the filter-service).

## Frontend (`apps/force-app/web`)

- Enable the **Recording** tile in `SelectPage.vue`; add `/record` route (guarded).
- **`src/record/RecordPage.vue`** — orchestrator: config form, START/STOP, live panels, readouts,
  and (post-STOP) the finished-cut view.
- **`src/record/liveClient.ts`** — WebSocket client: connects to `VITE_RECORDER_URL`, decodes
  `D1LF` frames, exposes reactive live state (trace ring, FRM points, scalars).
- **`src/record/LiveForcePlot.vue`** — Canvas 2D rolling window of Fx/Fy/Fz (last N seconds), using
  the axis colours (`#dc2626/#16a34a/#2563eb`).
- **`src/record/LiveFrm.vue`** — three.js accumulating point cloud; appends each frame's new points;
  reuses `COLORMAPS` from `src/force/liveCloud.ts`.
- **Finished view** — reuse the existing `FrmCloud.vue` + `ForceChart.vue`, pointed at the backend's
  `live_cache.bin` (fetch as arraybuffer, feed `parseCache`). Confirms the `D1LC` round-trip.
- **Config**: add `VITE_RECORDER_URL` (default `http://localhost:8200`) to `config.ts` + `.env.*`.

## Testing / Verification

**Backend unit tests** (`apps/force-app/backend/tests/`, pytest):
- `D1LC` round-trip: `finalize` output parses back equal via `filter-service`'s `parse` (shared format).
- `.mat` round-trip: `scipy.io.loadmat` recovers `DATA` shape `[N,10]`, `VariableNames`, `metadata`.
- `Ring`: no data loss / no producer block under a fast producer + slow consumer.
- `Decimator`: preserves per-window min & max.
- `SimSource`: emits `rate·duration ± chunk` samples, correct channel count, plausible force ramp.
- `FrmIntegrator`: total integrated revs ≈ `rpm/60·duration`; point count matches samples.

**End-to-end** (Playwright, `tests/ui/verify_recording_2a.mjs`): start backend + web dev server;
log in → Recording tile → configure a short sim run → START; assert live frames arrive (trace
updates, FRM point count grows, elapsed advances); STOP; assert `captures/<id>/` has `.d1raw`,
`.mat`, `live_cache.bin`, `summary.json`, and the finished-cut `FrmCloud` renders (canvas present).
Manual: run `uvicorn`, drive from the browser, eyeball the live spiral forming.

## Out of scope (later slices)
Real NI-DAQ (`nidaqmx`) and `abfp_core` (2b); Kistler LabAmp control + settings (2c); metadata form +
Directus sample dropdown + run write-back + offline queue (2d); safety alarms (2e); machine-tool
capture and desktop packaging (Phase 3).
