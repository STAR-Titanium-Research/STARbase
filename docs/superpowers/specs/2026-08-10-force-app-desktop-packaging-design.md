# Force App Desktop Packaging — Design

- **Date:** 2026-08-10
- **Implements:** ADR-0010 steps 3–4 (PyInstaller sidecar, auto-update)
- **Status:** Implemented 2026-08-11 — `apps/force-app/desktop/` (Electron shell),
  `apps/force-app/backend/force-app-backend.spec` (PyInstaller sidecar) and
  `.github/workflows/force-app-release.yml`; releases reach rigs through the Caddy-served feed
  (see [`docs/force-app-operations.md`](../../force-app-operations.md))

## Problem

Operating a recording rig today requires a developer environment. The Vue SPA runs from
a Vite dev server (`npm run dev`, port 5180) and the FastAPI backend runs from a Python
virtualenv kept alive by a Windows scheduled task (`ForceAppRecorderBackend`, port 8200,
installed by `apps/force-app/backend/scripts/install_autostart.ps1`, re-checked every
five minutes). Updating a rig means a manual `git pull` on that machine.

That is a developer setup being used in production. The goal is one signed-off installer
per release, an app window rather than a browser tab, and updates that reach field rigs
without anyone opening a terminal.

The audience is several rigs, potentially including other labs — machines that are not
administered by the maintainer.

## Decisions

### Electron, not Tauri

A PyInstaller bundle carrying numpy, scipy and nidaqmx is 150–250 MB whichever shell is
chosen. Electron adds 120–150 MB of Chromium; Tauri adds 5–10 MB by borrowing the system
WebView2. So the realistic comparison is ~350 MB against ~220 MB — the Python payload
dominates, and Tauri's headline size advantage is substantially diluted.

Electron wins on the two things that matter for this specific application:

- **Deterministic rendering.** The UI is unusually WebGL-heavy — Potree octrees plus
  hand-written WebGL FRM rendering. Electron ships its own Chromium, so every rig renders
  identically. Tauri inherits whatever WebView2 version a machine happens to have; it is
  evergreen Chromium and would almost certainly work, but "almost certainly", diagnosed
  remotely, on another lab's PC, is a support cost.
- **`electron-updater` is the most battle-tested unattended-update path**, and updating
  field rigs is the actual requirement rather than a nice-to-have.

Electron also avoids adding a Rust toolchain to a build pipeline that is already Node and
Vite. `abetterplus-rust` exists but is a PyO3 extension crate — it would not be reused by
a Tauri shell.

**Rejected: no shell at all** (MSI installing the backend as a Windows service, plus a
shortcut opening the SPA in the default browser). Less machinery, but it loses the single
window, needs its own update mechanism, and leaves operators managing browser tabs. Not
acceptable for non-expert operators in other labs.

### Package inside the monorepo; do not split the repo first

ADR-0010 sequenced the repo extraction (step 2) before packaging. That ordering is not
required. `apps/force-app/desktop/` plus a path-filtered release workflow gives
independent versioning and releases from inside the monorepo, and step 1 already made
force-app cleanly separable, so extraction stays cheap whenever handover actually
demands it. Doing the irreversible step before knowing what packaging needs is the wrong
order.

### v1 requires Directus; local-only mode is v2

`config.ts` already supports runtime reconfiguration and `LocalCaptureView` already
browses local captures, so the app is part-way to standalone operation. But the SPA gates
everything behind a Directus login, and two features are server-side sidecars: `/filter/*`
signal filtering and `/octrees/*` LOD streaming. Genuine local-only mode means an app that
starts without auth and degrades gracefully when those are absent — a larger piece of work
than the packaging itself, and not what is needed soonest.

v1 therefore targets tailnet-connected rigs with Directus required.

### Tailscale-only update feed, unsigned binaries

The app must stay private: its existence and behaviour should not be publicly visible.
That rules out public GitHub Releases. Private GitHub Releases is worse rather than better
— it requires an access token embedded in every shipped binary, which is leakable and
grants repository access.

The feed is therefore static files behind the Caddy proxy already running on `d1-server`.
In v1 every user is on the tailnet by definition, since Directus is required and only
reachable that way. This is private by construction: not merely access-controlled, but
not routable from the public internet.

**The unsigned decision and the Tailscale-only feed are coupled.** `electron-updater`
verifies update signatures when the app is signed; unsigned, that check is skipped, so
the update channel's trust rests entirely on the transport. An unsigned auto-updater
reachable over the open internet is a remote-code-execution path into the rigs. Over
Tailscale it is acceptable. **If v2 brings in labs that are not on the tailnet, signing
and feed hosting must be revisited together, not separately.**

Unsigned means a SmartScreen "Windows protected your PC" click-through on each install.
Tolerable while every machine is onboarded by hand; a real barrier once managed IT is
involved. An EV certificate (~£300–600/yr plus a hardware token) is the only option that
removes it from the first install.

## Architecture

```
apps/force-app/
  desktop/            <- new: Electron main + preload + builder config
  backend/            <- existing FastAPI; frozen by PyInstaller
  web/                <- existing Vue SPA; built and embedded
```

### Process model

Electron main spawns the frozen backend as a child process, polls it until healthy, then
loads the renderer. The renderer is the existing SPA build, unchanged.

**The SPA must not be loaded from `file://`.** That yields origin `null`, which breaks
CORS preflights and Bearer auth against Directus. Instead register a custom scheme (e.g.
`app://force`) as `standard` + `secure` + `corsEnabled`, giving a real, stable origin.
That origin must then be added to Directus's `CORS_ORIGIN` on `d1-server` — a deploy-side
change, the same class of step the standalone `/app/` deployment already required.

**PyInstaller one-folder, not one-file.** One-file re-extracts ~200 MB of scipy to a temp
directory on every launch: slow, and a reliable antivirus trigger.

### Sidecar lifecycle

Main owns the backend process, replacing the scheduled task and its five-minute watchdog:

- **Start:** spawn, then poll `GET /health` until ready with a timeout, showing a visible
  "starting" state rather than a blank window.
- **Port:** default 8200, but probe first and fall back to a free port, writing the chosen
  value into the renderer's `recorderUrl`. A stale process holding 8200 must not wedge the
  app.
- **Supervise:** on unexpected exit, restart with exponential backoff and a capped attempt
  count. After the cap, show a persistent error banner with the backend's stderr tail —
  never fail silently.
- **Quit:** kill the whole process tree. An orphaned uvicorn holding the port would block
  the next launch.
- **Recover:** after any restart, call `GET /recovery/check` and surface an orphaned
  session to the operator. A rig that crashes mid-cut must not quietly lose the recording.

The installer must offer to remove the existing `ForceAppRecorderBackend` scheduled task.
Leaving it in place gives two backends contending for port 8200.

### Diagnostics

`GET /health/check` is the existing Connectivity Doctor. Surface it from a desktop menu
item, since remote diagnosis on someone else's machine is the expected support mode.

### Configuration

`config.json` written to `app.getPath('userData')`, seeded on first run with the tailnet
Directus URL; `recorderUrl` set to `http://127.0.0.1:<port>`. Settings > General already
edits this at runtime, so the SPA needs no change.

## Build and release

`.github/workflows/force-app-release.yml`, Windows runner, path-filtered to
`apps/force-app/**` and `packages/force-plotting/**`, triggered by `force-app-v*` tags:

1. `npm ci`
2. `npm run build -w force-app-web`
3. PyInstaller the backend (one-folder)
4. `electron-builder`
5. Upload the installer and `latest.yml` as workflow artifacts

**CI cannot publish directly to the feed.** GitHub-hosted runners cannot reach
`d1-server` — it is tailnet-only, which is precisely why the feed is private. Publishing
is therefore a *pull*, not a push: a small script run on `d1-server` fetches the tagged
release artifacts with the `gh` CLI and drops them into the Caddy-served directory.
`d1-server` has outbound internet, so this needs no inbound access and no Tailscale auth
key stored in GitHub secrets.

The alternative — joining the tailnet inside CI via `tailscale/github-action` with an
ephemeral auth key — would allow a true push, but puts a credential that grants tailnet
access into GitHub secrets. Not worth it for a release cadence measured in weeks.

Both the installer and `latest.yml` must land in the feed directory; `electron-updater`
needs the metadata file alongside the binary or clients will never see the update.

CI cannot exercise NI-DAQ hardware. The backend already has sim and replay sources with
tests (`test_sim_consumers.py`, `test_replay.py`), so headless smoke coverage is feasible
without a DAQ card.

## Testing

- Existing backend pytest suite continues unchanged.
- **Packaged-app smoke test:** launch the built app with Playwright's Electron support
  (`_electron.launch`), assert the sidecar reaches healthy, the renderer loads, and the
  recorder status endpoint responds. This is the test that would catch a broken bundle,
  which unit tests cannot.
- **Sidecar supervision test:** kill the backend process and assert the app restarts it
  and surfaces the recovery prompt.

## Out of scope for v1

- Local-only / no-Directus operation
- macOS and Linux builds
- Offline fallbacks for `/filter/*` and `/octrees/*`
- Code signing

## Risks

- **Bundle size ~350 MB.** Acceptable for a LAN/tailnet download; would need revisiting
  for wider distribution.
- **Unsigned installers** will be blocked outright by some managed IT, which is the
  scenario "other labs" implies. This is the most likely thing to force a decision change.
- **PyInstaller and nidaqmx** — the NI-DAQmx runtime is a separate system install and
  cannot be bundled. The installer must detect its absence and say so clearly rather than
  failing at first recording.
- **Antivirus false positives** on an unsigned Electron app spawning a frozen Python
  binary are common. Signing is the real mitigation.
