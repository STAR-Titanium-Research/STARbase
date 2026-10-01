# Troubleshooting

[← Force App wiki](README.md)

**Start with the Connectivity Doctor** (**Help → Connectivity Doctor**, or
[Settings → Connectivity](settings.md#connectivity)). It checks every service the app uses and
says what to do about each failure. Then look at the log (**Help → View Logs**).

## Symptoms

### "can't reach the recording backend. Is it running on this machine?"

The window cannot reach the recorder backend on `localhost:8200`.

- In the installed app the shell starts the backend and restarts it if it dies. Quit and reopen
  the app.
- Check **Settings → Connectivity → Recorder URL** is `http://localhost:8200`.
- In development, the backend has to be running (see the [developer guide](developer-guide.md#running-it-from-source)).

### Start is greyed out

**Start** needs a live connection to the backend (the sensor chip in the sidebar must be green),
and no other operation in progress. See the previous item.

### Upload to database is disabled in the save dialog

It needs a **Sample** (*pick a Sample in Metadata to enable database logging*) and a network
connection. Pick the sample, or save locally now and upload the capture later from
[Local Captures](captures-and-recovery.md#local-captures). You can also fix the sample
afterwards with **Edit** there.

### Save fails with a permission error

Your Directus role cannot create the operation, analysis or file records. Ask an administrator
(see [Roles and permissions](../database/roles-and-permissions.md)). If the operation row was
created before the failure, delete it in Directus before trying again (see
[What saving writes](recording.md#what-saving-writes)).

### "Recording finished" never appeared

The dialog opens only if the Record page is open when the recording ends. The capture is safe on
disk. Find it in [Local Captures](captures-and-recovery.md#local-captures).

### Every local capture says "upload state unknown"

The app could not ask the database which captures are uploaded: check the *Directus* row in the
Connectivity Doctor, and that you are signed in. (In v0.1.30 and earlier this happened on every
PC because of a bug; see [Local captures](captures-and-recovery.md#local-captures).)

### Plot: Power / Spectro / Waterfall say "failed" or stay empty

Those views, and the filter previews, are computed by the **filter service** on d1-server. Check
the *Filter service* row in the Connectivity Doctor, and the Filter service URL.

### Plot: FFT says "no data", or Figure / Full / Diagnostics are unavailable

The stored spectrum, the *Figure* image, the *Full* octree and diagnostics builds all come from
the **force orchestrator** on d1-server. It runs MATLAB over `.mat` files **indexed from the
archive share**. A cut saved by the Force App is written straight to the database as finished
(`status = done`), with its capture in Directus's file storage rather than in the archive. The
orchestrator therefore never processes it, and those four views stay unavailable for it.

Everything computed from the cut's live cache still works: the *Force* charts, *Power*,
*Spectro* and *Waterfall*, the *Lite* FRM view, statistics and filters. For the rest, the capture
has to be copied into the archive and indexed (`scripts/index_archive.py`), so that the
orchestrator picks it up like any archived cut. See [Force data](../database/force-data.md) in the
database wiki.

For archived cuts, a blue *processing* dot means the orchestrator is still working on it. A red
dot means it failed, and the analysis row's `error_message` in Directus says why.

### Diagnostics never finish building

A build waits in `pending` until the force orchestrator daemon on d1-server claims it. If it has
been several minutes, the daemon is not running, or cannot find MATLAB or PotreeConverter.
Check `scripts/force_orchestrator.py`'s log on d1-server.

### NI-DAQ page shows a simulated chassis on the rig

The backend falls back to simulation when the NI-DAQmx runtime or the hardware is missing. The
doctor's *NI-DAQ runtime* row says which. Install the runtime from ni.com and restart the app.

### Lab Amp shows "MOCK" on the rig

The Lab Amp source is set to mock. Enter the amp's URL on the [Lab Amp page](hardware.md#connection)
and **Save connection**, or start the backend with `LABAMP_MODE=real`.

### Capture drive choice reverts after a restart

The settings folder could not be written. Settings must live in `%LOCALAPPDATA%\force-app`, not
in the install folder. Recent versions say so instead of failing silently. See
[`force-app-operations.md`](../../force-app-operations.md#where-things-are-kept).

### No update is offered

Updates come from the tailnet-only feed on d1-server, which republishes each GitHub release within
about five minutes. Check that the PC is on Tailscale, and look at `auto-publish.log` on
d1-server (see [`force-app-operations.md`](../../force-app-operations.md#deploying-the-auto-publish-task)).

### The app won't start: "Cannot read properties of undefined (reading 'whenReady')"

Something set `ELECTRON_RUN_AS_NODE=1` in the environment. Remove it.

## Logs

[Settings → Logs](settings.md#logs) shows `backend.log` with filtering and search. **Download**
gives the whole file for a bug report.

## Reporting a bug

[Settings → Report a Bug](settings.md#report-a-bug) files a GitHub issue with diagnostics attached.
Describe what you did, what you expected and what happened instead. If the relay is unreachable,
download the log and open an issue on GitHub by hand using the repository's bug-report template.
