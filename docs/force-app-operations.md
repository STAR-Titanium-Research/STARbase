# force-app — operations

Running, deploying and troubleshooting the machining force-capture app: the Electron desktop
shell, its recorder backend, and the live-backup server that protects a recording in flight.

Design rationale lives elsewhere and is not repeated here — see
[ADR-0010](adr/0010-force-app-extraction-and-electron-packaging.md) for the extraction and
packaging decisions, and `superpowers/specs/` for the per-feature design documents.

## The pieces

| Piece | Where it runs | What it is |
|---|---|---|
| Desktop shell | acquisition PC | Electron app, `apps/force-app/desktop` |
| Recorder backend | acquisition PC | FastAPI sidecar spawned by the shell, `apps/force-app/backend`. Needs the NI-DAQ hardware, so it is never containerised |
| Web UI | served by the shell | Vue SPA, `apps/force-app/web`. Also served by Caddy at `/app/` for browser use |
| Backup server | `d1-server` | Receives streamed raw captures, `apps/force-app/backup-server` |
| Directus + Postgres | `d1-server` | The archive the finished captures upload into |

## Running it in development

```powershell
npm install                              # repo root
npm run build:web:desktop
npm run build -w force-app-desktop
npm run dev -w force-app-desktop
```

The app should show a loading screen, spawn the sidecar from
`apps/force-app/backend/.venv`, and load the login page over `app://force/`.

To run the backend alone: `.venv\Scripts\python -m uvicorn app.main:app --host 127.0.0.1 --port 8200`.

## Where things are kept

| What | Where | Override |
|---|---|---|
| Recordings | the configured capture drive (Settings > General) | `FORCE_APP_CAPTURES` |
| `storage_config.json`, `backup_config.json` | `%LOCALAPPDATA%\force-app` | `FORCE_APP_CONFIG_DIR` |
| `backend.log` (+ 3 rotated) | `%LOCALAPPDATA%\force-app\logs`, or Electron's `userData\logs` when launched by the shell | `FORCE_APP_LOG_DIR` |
| LabAmp / NI-DAQ channel config | under the capture drive | — |

Settings must **not** live inside the package: under PyInstaller that resolves into the install
directory (Program Files by default), which a standard user cannot write to. That used to be the
case, and the write failure was swallowed — choosing a capture drive appeared to work and silently
reverted on restart. Both files are now read with a fallback to the old location, so an existing
install keeps its configured drive and the next save migrates it. If they genuinely cannot be
written the app says so rather than reporting success. Logging degrades to stderr-only in the same
situation; it never blocks startup.

Logs are readable in-app at **Settings > Logs** (also **Help > View Logs**), with level filtering,
search and download. Local recordings are listed at **Settings > Local Captures**, which is also
the only way to delete a finished capture — nothing else in the app can, so they otherwise
accumulate forever.

## Deploying the live-backup server

During a recording the backend tails `raw.d1raw` and streams it to this server in ~4 MB chunks. If
the acquisition machine loses its disk, its power, or the recording process, the raw can be pulled
back and finalized into a normal `.mat` + `live_cache`. It is a crash safety net with hours-scale
retention, **not** an archive — the archive path is the Directus upload.

Deployed and verified end to end on 2026-08-23.

```bash
# on d1-server, in the repo root
docker compose up -d backup-server
docker compose restart proxy       # NOT `up -d proxy` — see below
curl https://d1-server.tail54eeb6.ts.net/backup-ingest/health
```

Expect `{"ok": true, "storage_path": "/data", ...}`. Then in the app: **Settings > Live Backup**,
tick Enable, set the URL to `https://d1-server.tail54eeb6.ts.net/backup-ingest`, Test connection,
Save.

**Restart the proxy explicitly after changing the Caddyfile.** It is a bind mount, so editing it
does not change the container spec and `docker compose up -d proxy` leaves the old config loaded in
memory — the new route simply 404s. `docker compose restart proxy` (or
`docker exec <proxy> caddy reload --config /etc/caddy/Caddyfile`) is what applies it.

TLS for `d1-server.tail54eeb6.ts.net` is terminated by **Tailscale serve**, which forwards to Caddy
on `localhost:80`. Caddy's own site block is plain `:80` by design; it is not doing certificate
management here.

Retention defaults to 12 h (`BACKUP_RETENTION_HOURS` in `.env`). Raw captures are multi-GB; the
named `backup-raw` volume is what keeps them across a container recreate, so do not replace it with
a path inside the container's own filesystem.

Validate the proxy config after touching it:

```bash
docker run --rm -v "$PWD/infra/caddy/Caddyfile:/etc/caddy/Caddyfile:ro" \
  caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile
```

Two host quirks on the current `d1-server`, neither a repo problem:

- `docker` is not on `PATH` and the compose CLI plugin is not registered, so the commands above
  need the standalone `docker-compose.exe` from Docker Desktop's `resources\bin`. Adding that
  directory to the system `PATH` would make them work as written.
- From **Git Bash on Windows**, prefix that `docker run` with `MSYS_NO_PATHCONV=1` or the
  `-v $PWD/...:/etc/caddy/...` mount path gets mangled. WSL, PowerShell and Linux are unaffected.

## Deploying the auto-publish task

Every `force-app-v*` tag builds an installer and attaches it to a GitHub Release (CI), but
`electron-updater` only sees it once that Release's `*.exe` + `latest.yml` land in the
Caddy-served feed at `/force-app-updates/`. That publish step is automated: a Windows Scheduled
Task on d1-server polls GitHub every few minutes and republishes the moment a new release
appears — no one needs to run a script by hand after a release ships.

One-time setup, on d1-server, in the repo root:

```powershell
gh auth login   # once per machine, if not already done — see publish-release.ps1's header
cd apps\force-app\desktop\scripts
.\install-auto-publish-task.ps1
```

This registers the `force-app-auto-publish-release` Scheduled Task (polls every 5 minutes by
default; pass `-IntervalMinutes N` to change it) and runs it once immediately. It keeps the same
pull-based trust model `publish-release.ps1` already used — d1-server has outbound internet and
its own `gh` login; no tailnet-reaching credential is added to GitHub Actions.

Troubleshooting:

- Log: `infra\force-app-updates\auto-publish.log` (only writes an entry when it actually
  publishes something, or hits an error — steady-state polls are silent).
- Last published tag: `infra\force-app-updates\.published-tag`.
- Force an immediate check: `Start-ScheduledTask -TaskName force-app-auto-publish-release`.
- Re-running `install-auto-publish-task.ps1` replaces the task definition; safe after moving the
  repo or changing the interval.

### Security posture — read before exposing anything

The backup server has **no authentication at all**: anyone who can reach it can list, download or
delete any stored capture. That is deliberate and consistent with `/recorder` and `/octrees`, which
are equally unauthenticated — the whole Caddy instance is reachable only over Tailscale, and
ADR-0010 already makes tailnet privacy load-bearing (the installer is unsigned, and its update feed
is trusted purely because the transport is private).

So the service is intentionally **not** published on a host port in `docker-compose.yml`; reaching
it only through Caddy keeps it behind the single tailnet-only TLS entry point. Do not add a
`ports:` mapping for 8210. If this host ever becomes publicly reachable, this route needs real auth
first.

### Offline sign-in (v0.1.32)

Each rig stores, per account that has signed in online on it, a salted PBKDF2-SHA256 hash of the
password (310,000 rounds) and the Directus profile, in the app's localStorage, valid 30 days from
the last time the server vouched for the account (online sign-in or background session refresh). It cannot create a Directus token, so an offline session can record and
queue but not write to Directus. It is deliberately **not** a provisioned list of every user's
hash: Directus's argon2 hashes are not exposed by its API, and copying them to every rig would let
anyone with a rig's disk attack all lab passwords offline. To revoke an account everywhere, disable
it in Directus: the rig's entry stops working at its 30-day expiry, or at once on that rig's next
online attempt with the old password. See the wiki page [Working offline](wiki/force-app/working-offline.md).

## Hardware checklist

Automated tests cover most of this (`apps/force-app/desktop/tests/`, and the backend suite), but
these need the rig and a human:

- [ ] NI-DAQ enumeration on Settings > NI-DAQ shows the **real** hardware, not the simulated
      chassis. `app/nidaq_enum.py` falls back to simulation when the driver or hardware is missing,
      so confirm it isn't doing that.
- [ ] A real NI-DAQ recording renders live force/FRM from actual channel data.
- [ ] Kill the backend mid-recording (`Stop-Process -Name force-app-backend`, or the `python.exe`
      running uvicorn in dev). The supervisor should restart it and route back to Record, where the
      recovery banner picks up the interrupted session.
- [ ] A second copy of the app focuses the running window instead of opening a second one.
- [x] **Live backup end to end — done 2026-08-23.** A real 25 kHz NI-DAQ recording (112,500
      samples, 4,500,032 bytes) streamed to `d1-server` over Tailscale and reached 100 %. The raw
      pulled back is **byte-identical** (matching SHA-256), the recording config survived the round
      trip, and re-finalizing the restored raw reproduced the original exactly — same sample count,
      rate, duration, and all three per-axis peaks.
- [x] **Network drop mid-recording — done 2026-08-23.** A 395,000-sample (15.8 MB) run with the
      link cut partway through: the backup chip went `paused` / disconnected and `bytes_sent`
      froze, the recording carried on locally untouched (`done`, no error), and on restore the
      streamer caught up the whole backlog and finished at 100 %. The raw is **byte-identical**
      across the outage and re-finalizes to match the original. The link was cut at the socket the
      streamer uses rather than by unplugging Tailscale, so this proves the recorder recovers, not
      that Tailscale does.

      Note for anyone watching the chip: the percentage *falls* during an outage (69 % → 24 % in
      that run). It is `bytes_sent / bytes_total`, and the denominator keeps growing while the
      numerator is frozen — a growing backlog, not lost data.
- [ ] **A packaged install as a standard user.** `npm run package -w force-app-desktop`, install to
      the default Program Files location, then confirm the capture drive choice survives a restart
      and that logs still appear in Settings > Logs. This is the one scenario the config-location
      fix targets and it has not been exercised on a real install.
- [ ] Frozen backend picks up NI-DAQmx: `.\scripts\build_frozen.ps1`, run
      `.\dist\force-app-backend\force-app-backend.exe --port 8291`, then `POST /health/doctor` and
      confirm the `"NI-DAQ runtime"` finding is `"ok"`, not `"warn"`.

## Known quirks — don't chase these

- **Four backend tests fail on the acquisition PC** (`test_autorange.py` ×2, `test_labamp.py`,
  `test_nidaq_config.py`). They expect the simulated NI-DAQ/LabAmp fallback, and this machine has
  the real hardware. Pre-existing and unrelated to any change.
- **`electron-updater` finds nothing on launch** until the auto-publish task's next poll picks up
  the release (up to `IntervalMinutes`, 5 by default — see "Deploying the auto-publish task"). If
  it has been well over that and still nothing, check `infra\force-app-updates\auto-publish.log`
  on d1-server before assuming the app is broken.
- **The installer is unsigned** by design for v1 (ADR-0010's open decisions), so SmartScreen warns.
- **`Cannot read properties of undefined (reading 'whenReady')`** on launch means something set
  `ELECTRON_RUN_AS_NODE=1` in the shell. Check `$env:ELECTRON_RUN_AS_NODE`.
- **The `build` and `nidaq` extras are optional** and only needed for the PyInstaller freeze.

## Testing

```powershell
cd apps\force-app\backend;      .venv\Scripts\pytest          # backend
cd apps\force-app\backup-server; ..\backend\.venv\Scripts\pytest   # backup server (own directory)
cd apps\force-app\web;          npm test                      # web unit
cd apps\force-app\desktop;      npm test                      # shell unit
cd apps\force-app\desktop;      npx playwright test           # e2e, drives the real app
```

The Playwright suite launches the real Electron app against the real backend, and is what the
release CI runs as its gate. It degrades gracefully without real hardware: `save-flow.spec.ts`
records through whatever source the app actually resolves to (real NI-DAQ here; the app's own
auto-detect falls back to sim when no chassis is found, e.g. on a CI runner), and
`captures-tab.spec.ts` is happy with an empty captures list. It is self-cleaning: dev-mode launches
share one `userData` profile, so each test removes the fake auth token it seeds, and the save-flow
test deletes the capture it creates — otherwise every run litters the operator's capture drive.
`logs-tab.spec.ts` manufactures its own log line via a side-effect-free endpoint call rather than
assuming the backend has already logged something — true on a long-lived dev profile, false on a
genuinely fresh install, which is exactly the gap that first broke this in CI.
