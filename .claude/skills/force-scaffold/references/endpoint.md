# Adding a backend endpoint (e.g. `POST /dsp/spectrum`, 8247288)

| File | Change |
|---|---|
| `apps/force-app/backend/app/main.py` | the route, placed next to its family (`/record/*`, `/captures/*`, `/labamp/*`, `/nidaq/*`, `/backup/*`, `/storage/*`). Request bodies are pydantic models. Put real logic in a module (`dsp.py`, `storage.py`, …) and keep the handler thin |
| `apps/force-app/backend/tests/test_<area>_api.py` | FastAPI `TestClient` tests: happy path, validation error (422), and the guard case |
| `apps/force-app/web/src/<area>/<area>Api.ts` (e.g. `record/labampApi.ts`, `nidaq/nidaqApi.ts`) | the typed client. Base URL from `config.recorderUrl`, never hard-coded |
| the calling component | use the client, and handle "backend unreachable" (the sidecar may be restarting) |

## Rules

- **Busy guard.** Anything that changes hardware (Lab Amp, NI-DAQ), storage location or capture
  files must refuse with `409` while `_busy()` is true. Mid-recording writes corrupt the capture (#33).
- **Blocking I/O off the event loop.** LAN calls to the amp, disk scans and big numpy work go through
  `await run_in_threadpool(...)`. A blocking handler stalls `/record/stream` for every client.
- **Stateless where possible.** `/dsp/spectrum` takes the samples and returns the result, so live
  and replay share one scipy implementation. Prefer that over a server-side cache keyed by session.
- **Paths from config.** Captures, config and logs come from `config.py` (`FORCE_APP_CAPTURES`,
  `FORCE_APP_CONFIG_DIR`, `FORCE_APP_LOG_DIR`). The install dir is read-only when frozen.
- **No secrets in responses or logs.** Bug-report and log endpoints redact Windows account paths
  (`X:\Users\<name>`). Keep new diagnostic output going through the same redaction.
- **Tests must not touch real config.** `conftest.py`'s autouse `isolate_backup_config` covers backup
  config. For a new config file, add the same isolation.

## Verify

```sh
cd apps/force-app/backend && python -m pytest tests/test_<area>_api.py -q && python -m pytest -q
npm test -w force-app-web && npm run typecheck -w force-app-web
```
Then `force-app-verify`'s `backend.sh start` and call the route with `curl`, and through the UI if
it has one.
