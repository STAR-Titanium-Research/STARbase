---
name: force-app-verify
description: Use to prove a force-app change actually works, not just that unit tests pass. Covers changes to the recorder backend (apps/force-app/backend), the web UI (apps/force-app/web) or the shared plotting package that the Record page uses. Runs the backend hardware-free (sim NI-DAQ, mock Lab Amp), drives a real recording through the HTTP API and through the real UI in headless Chromium, checks the capture files, and returns screenshots. Works in cloud sessions with no rig, no Directus and no Docker.
argument-hint: [route, e.g. /record or /settings]
---

# Verify the force app hardware-free

The goal is evidence that the change does what it should, in the running app: a passing check,
a screenshot that shows it, or a clear statement of what couldn't be exercised here.

## The rig you have

- `scripts/backend.sh start|stop|status`: uvicorn on :8200 with `LABAMP_MODE=mock`, the sim
  source, and throwaway `FORCE_APP_CAPTURES/CONFIG_DIR/LOG_DIR` under `/tmp/fa`. Your real
  settings and captures are never touched. It creates `apps/force-app/backend/.venv` on first use.
- `scripts/sim_record.py [--duration 3 --rate 5000 --json '{...RecordConfig}']`: start → poll →
  finalize over HTTP, then assert on `summary.json` (n ≈ duration × rate, fs, v1.0 column order,
  peaks, `mat_written`, `tacho_measured`), the D1LC header and the `.mat` magic. `--json` passes
  any `RecordConfig` field (`app/config.py`), e.g. `extra_channels` or `drift_comp`.
- `scripts/ui_smoke.mjs [--route /record] [--record]`: headless Chromium against Vite on :5180.
  It seeds a fake session, stubs every Directus call with empty data, forces the sim source,
  screenshots the route to `/tmp/fa/shots/`, and with `--record` presses Start, gets past the
  alarm-test prompt and checks that the backend started a new session with samples.

```sh
bash .claude/skills/force-app-verify/scripts/backend.sh start
python3 .claude/skills/force-app-verify/scripts/sim_record.py
(npm run dev -w force-app-web > /tmp/fa/vite.out 2>&1 &)   # :5180, fixed for CORS
node .claude/skills/force-app-verify/scripts/ui_smoke.mjs --route /record --record
```

**Plot page linking** (`scripts/plot_link_smoke.mjs`): proves the FRM map <-> Signals linking
(right-click menus, pinned marker and ring, hover ring, crop items, Escape, right-drag) on the
Plot dashboard. It records a 4 s sim cut (or takes `--capture <id>`), serves that capture's
`live_cache.bin` as the stubbed `/assets/<id>`, builds the analysis row's `series` envelope from it
and stubs the rest of Directus (one sample, one operation). Needs the backend and Vite up as above,
then `node .claude/skills/force-app-verify/scripts/plot_link_smoke.mjs`. It asserts, prints
PASS/FAIL per check, exits 1 on any failure and writes `/tmp/fa/shots/plot-link-*.png`. The
right-drag check synthesizes Windows event ordering, because Chromium on Linux/macOS fires
`contextmenu` on press; the native drag is reported as INFO only.

Then **look at the screenshots** with the Read tool. A run with no console errors that shows a
blank panel is a failure. Extend the scripts, or write a one-off next to them, to exercise the
specific thing you changed: a new panel, a channel, a settings field. Assert on it rather than
eyeballing it when you can. Stop both servers when done (`backend.sh stop`, then kill the Vite
process).

## Choosing what to run

| Changed | Minimum evidence |
|---|---|
| `backend/app/*` (record, finalize, channels, formats) | `pytest` in `apps/force-app/backend` + `sim_record.py`, with `--json` covering the changed path |
| `web/src/record/*`, live panels, playback | `npm test -w force-app-web` + `ui_smoke.mjs --record` + screenshots of the affected panel |
| `packages/force-plotting/*` used live | `npm test -w @d1/force-plotting` + `ui_smoke.mjs --record` |
| Plot page linking (map <-> charts) | `npm test -w @d1/force-plotting` + `plot_link_smoke.mjs` |
| Plot page / Diagnostics (other Directus data) | unit tests + **say it needs a real Directus**: the stub returns no rows |
| `desktop/*` (Electron shell) | `npm test -w force-app-desktop`. Packaging and `test:e2e` need the Windows release runner |

## Gotchas

- **Desktop unit tests on Linux**: the sidecar `stop()` test is skipped off Windows (it needs
  `taskkill`). `scheduledTask.test.ts` needs the Electron binary, so don't install with
  `--ignore-scripts`. Anything else red is real.
- **Four backend tests fail on the real rig** (`test_autorange.py` ×2, `test_labamp.py`,
  `test_nidaq_config.py`) because they expect the sim fallback. Here they must pass.
- **The NI-DAQ path can't run here.** `source: "nidaq"` returns 503 without the DAQmx runtime, and
  `nidaq_enum.py` silently falls back to a simulated chassis. Channel-mapping logic is covered by
  `test_channels.py`/`test_nidaq*.py`. Real acquisition, rates and hot-plug need the rig, so list
  them under "needs hardware".
- **Material Symbols ligatures are in accessible names.** The Start button is
  `"fiber_manual_record Start"`, and `"flagCut start"` also matches `/start/`. Anchor your
  selectors (see `ui_smoke.mjs`).
- **A safety prompt gates the first Start** of a session ("Test the alarms first?"). Tests click
  "Start without testing". Don't remove the prompt to make a test simpler.
- **Start asks "Start anyway" when no Sample is picked** (pre-flight, `data-testid="start-anyway"`).
  `ui_smoke.mjs` clicks it. The railed-channel warning needs per-channel gains, which the UI can't
  set: start the run over HTTP with `dyno_gains` (and `analog_fullscale_v`, since sim data is
  already in newtons) and open the Record page, which adopts the running cut.
- **Playwright's bundled browser may be missing** in cloud sessions. `ui_smoke.mjs` falls back to
  `/opt/pw-browsers/chromium`; reuse that in any script you write. Never run `playwright install`.
- **Vite must be on :5180** (Directus CORS lists that origin). If the port is taken, find and stop
  the old dev server rather than changing the port.
- Sim captures land in `/tmp/fa/captures`, never in Directus. Nothing needs a `TEST_DATA.md` row
  unless you pointed the app at a real Directus and uploaded something. Then add one.
