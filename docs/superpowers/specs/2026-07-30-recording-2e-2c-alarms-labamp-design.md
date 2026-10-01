# Recording — Slices 2e (Safety Alarms) & 2c (Kistler LabAmp Control)

**Status:** implemented 2026-07-31, in order 2e → 2c (`apps/force-app/web/src/record/alarms.ts`,
`apps/force-app/backend/app/labamp.py`). 2c was built from the vendor docs + the MATLAB app's calls
and mock-verified first, as the real amp wasn't on the development network; it now runs against the
real amplifier on the acquisition PC. Vendor docs live in `docs/hardware/kistler-labamp/`.

## Context

The recording workspace (2a/2a.1/2d) streams live force + FRM and logs runs to Directus. Two
capabilities from the original brief remain: **safety alarms** (halt/alert on excessive force or
RPM) and **lab-amp control** (set the Kistler amp mode, read its sensor configuration).

## 2e — Safety Alarms

Reproduces the MATLAB app's software alarms (high-force / high-RPM) on our live stream. Latching:
once a threshold is breached the alarm fires and stays until acknowledged (safety-first).

- **Evaluation (frontend):** the D1LF frames already carry the running peak Fx/Fy/Fz and current
  RPM. An `alarms.ts` controller evaluates each frame: `|peak axis| ≥ forceThreshold` → high-force;
  `rpm ≥ rpmThreshold` → high-RPM. Latches + records which axis/value tripped.
- **Config:** force threshold (N), RPM threshold (default = `cfg.rpm × 1.02`, matching MATLAB),
  per-alarm enable, audio on/off. Persisted to localStorage.
- **Alert:** a prominent full-width overlay banner in the workspace + a looping attention tone via
  the Web Audio API (browsers can't force system volume as the MATLAB app did). **Acknowledge**
  silences + clears the latch; alarms reset on a new run.
- **UI:** an `AlarmsPanel` (thresholds, arm/disarm, live status, a Test button) added to the panel
  grid; the overlay is global to the record page.
- No backend change.

## 2c — Kistler LabAmp Control + Settings

The amp is link-local, so the **backend** owns the HTTP conversation; the frontend panel calls the
backend, which proxies to the amp. Mirrors the MATLAB `%% Kistler DAQ API calls`.

- **Backend `app/labamp.py`** — `LabAmpClient(base_url, timeout)` over `httpx`:
  - `set_operation_mode(mode)` → `POST /api/$/operationMode/set {"mode":…}`
  - `get_operation_mode()` → best-effort read (`/api/$/operationMode/get`, fallback via param)
  - `export_params()` → `POST /api/param/export`
  - `get_params(paths)` / `set_params(map)` → `POST /api/param/get|set`
  - `sensor_table(n)` → `get_params` for `/sensor/i/{name,serialNumber,physicalQuantity,sensitivity,range}` → rows
  - `signal_get(channels)` → `POST /api/$/signal/get {"type":"SENSOR","channels":[…]}`
  - `ping()` → reachability. All parse the `{"result":0,"data":…}` envelope; `result != 0` → error.
  - **`MockLabAmp`** with the same interface returns realistic canned data (8-sensor table, mode),
    so the UI is demoable without hardware. Selected by `LABAMP_MODE=mock` (or when `ampIP` unset).
- **Backend endpoints** (`app/main.py`, CORS as elsewhere): `GET /labamp/status` (reachable + mode +
  ampIP), `POST /labamp/mode {mode}`, `GET /labamp/sensors`, `GET /labamp/export`,
  `GET/POST /labamp/config` (ampIP, channels, mode=real|mock). Config persisted to a small
  `labamp.json` under the captures root / env.
- **Optional record integration:** a “control amp on record” toggle → RESET→MEASURE on START, RESET
  on STOP (as the MATLAB app did), only when a client is configured/reachable.
- **Frontend `LabAmpPanel.vue`** (new workspace panel): connection status + ampIP field, MEASURE/RESET
  toggle, the per-sensor table (name/serial/quantity/sensitivity/range), refresh, and an
  “Export config” download. Talks to the backend `/labamp/*` (via `VITE_RECORDER_URL`).

## Verification
- **2e** (`tests/ui/verify_recording_2e.mjs`): set a low force threshold, run a sim cut whose peak
  exceeds it → assert the alarm overlay appears + panel shows tripped; **Acknowledge** → overlay
  clears. (Audio not asserted.)
- **2c backend** (pytest): `LabAmpClient` request/response parsing against a mocked httpx (envelope,
  `result != 0` error, sensor-table assembly); `MockLabAmp` returns a full table + mode toggle.
- **2c frontend** (`tests/ui/verify_recording_2c.mjs`): run the backend in `LABAMP_MODE=mock`; open
  the LabAmp panel → status connected, sensor table renders, MEASURE/RESET toggle round-trips.

## Out of scope
Real-amp validation (rig), the amp's hardware Signal Event Monitor, DAQ-streaming acquisition off
the amp (NI-DAQ is the acquisition path — slice 2b), a broader app-wide settings page beyond LabAmp.
