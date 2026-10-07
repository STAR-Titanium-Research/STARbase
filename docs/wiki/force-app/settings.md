# Settings

[← Force App wiki](README.md)

**Settings** has nine tabs. You can link straight to one with `/settings?tab=<id>`, for example
`/settings?tab=logs`.

- [General](#general)
- [Recording](#recording)
- [Safety Alarms](#safety-alarms)
- [Connectivity](#connectivity)
- [Live Backup](#live-backup)
- [Local Captures](#local-captures)
- [Logs](#logs)
- [Report a Bug](#report-a-bug)
- [About](#about)

## General

![Settings → General](../images/force-app/settings-general.png)

- **Appearance:** dark or light theme.
- **Recording storage:** the drive recordings are written to. The backend creates a
  `force-app-captures` folder on the drive you pick. Use a fast local SSD: high-rate acquisition
  writes continuously, and a slow or network drive risks dropped data. The bar shows how full
  the drive is.

## Recording

![Settings → Recording](../images/force-app/settings-recording.png)

The long form of the three toggles next to **Start** on the Record page:

- **Detect cut start.** The live FRM spiral holds at the origin until the cut is detected.
  **Detection threshold** (N) is the absolute |Fz| that counts as "the cut has started". Leave it
  blank for adaptive detection (the baseline noise floor plus a margin). Set a value only if a
  particular setup's baseline is unusually noisy and adaptive detection fires too early or late.
- **Drift compensation.** A linear drift correction, matching the MATLAB app, applied to the saved
  `.mat` and live cache. It removes the slow linear trend that charge amplifiers typically add
  across a recording. The raw capture (`.d1raw`) is never touched, so switching this on or off
  later and re-deriving the outputs loses nothing.
- **Converging auto-range.** After each cut, recommends new per-channel Lab Amp ranges from that
  cut's peaks and applies them to the next one. It only takes effect on NI-DAQ recordings. The
  headroom setting lives on the [Lab Amp page](hardware.md#auto-range).

## Safety Alarms

![Settings → Safety Alarms](../images/force-app/settings-alarms.png)

Alarms watch the live force stream while recording. When a threshold is breached, a full-screen
banner (and optionally a tone) latches on the Record page until someone acknowledges it.

| Alarm | Default | Notes |
|---|---|---|
| **High-force alarm** | 400 N per-axis peak | set it to a safe fraction of your dynamometer or setup limit |
| **High-RPM alarm** | 0 = automatic | automatic trips at the configured spindle speed × 1.02 |
| **Low disk space alarm** | 5 GB free | recording also stops cleanly when the drive is actually full, so no data is lost |
| **Early warning** | on, 80 % of the force limit | an amber banner on the Record page when a force axis reaches that share of the limit. No tone, nothing latches; **Dismiss** hides it for the cut. Change the percentage (1-99) beside it |
| **Stop the recording when the force alarm trips** | off | stops the cut the same way the **Stop** button does, then the save dialog opens. Only the high-force alarm does this, not RPM, tacho or disk. **It only works while the Record page is open**: the alarms are checked there, so if you switch to another page during a cut the recording keeps going and nothing stops it |
| **Audible alert** | on | a looping tone alongside the banner |
| **Set the tone volume** | off | unticked, the app raises the system volume to maximum when an alarm sounds. Ticked, you choose the tone's level (5-100 %) and the system volume is left alone |

The alarm banner stays on top of the save dialog, so a recording stopped by an alarm can still be
silenced (press **A**, or click **Acknowledge**) while you decide what to save.

The alarm banner is announced to screen readers as an alert; the early-warning and disk banners as
status messages. Alarms and warnings apply to Record mode only, never to Replay.

**Test alarm** fires the banner and tone so you can check they would be noticed. The Record page
also offers this test at the first Start of each session.

## Connectivity

![Settings → Connectivity](../images/force-app/settings-connectivity.png)

**Connectivity Doctor** checks everything the app depends on and suggests a fix for each
problem. It runs when the tab opens; press **Run doctor** to repeat it. The checks are: recorder
backend, internet, Directus, Lab Amp, NI-DAQ runtime, filter service, octree server, backup
server and disk space. Where the app can fix a problem itself, the finding has a **Fix now**
button. Where a command fixes it, **Copy** puts the command on the clipboard. In the screenshot,
*NI-DAQ runtime* warns because the demo PC has no NI-DAQmx driver, and *Octree server* fails
because none was running. Both are expected off the rig.

In the installed app, when the recorder backend is down the doctor offers **Restart recorder**.
It stops and restarts the backend, then runs the check again. It will not restart while a recording
is in progress or still being saved. If the recorder does not answer the status check but the app
still thinks it is running (it may be busy recording), the app asks "The recorder isn't answering,
a recording may be in progress. Restart anyway?" and leaves it alone unless you choose **Restart
anyway**. If the app already knows the backend has stopped, it restarts without asking. In a browser or a development build the doctor shows the
command to start the backend by hand instead.

**Service endpoints** are the URLs the app uses:

| Endpoint | Default | Used for |
|---|---|---|
| Recorder URL | `http://localhost:8200` | the local backend (and the Lab Amp proxy) |
| Directus URL | set at build time | sign-in, items, files |
| Filter service URL | `/filter` | filter previews and spectra on the Plot page |
| Octree server URL | `/octrees` | *Full* and *Gridded* FRM views, diagnostics |

**Save** stores your changes in this browser profile, where they take effect at once, and runs
the doctor again to check the new addresses. **Reset to defaults** undoes them. A deployment can
also ship a `config.json` next to the app to set them. The order of precedence is build defaults,
then `config.json`, then these overrides.

## Live Backup

![Settings → Live Backup](../images/force-app/settings-backup.png)

With **Enable live backup** ticked, the backend streams the raw recording to the backup server on
d1-server while the cut runs. If the PC dies mid-cut, the recording can be restored from there.

- **Backup server URL:** the `/backup-ingest` endpoint behind the shared proxy (the default
  points at d1-server's tailnet address).
- **Retention (hours):** how long the server keeps backups before purging them (12 by default).
- **Test connection** checks the server before you rely on it. **Save** applies the settings.
- **Remote backups → Fetch remote backups** lists what the server holds, so you can restore one
  whose local copy was lost.

The sidebar's cloud chip shows streaming progress during a recording. See
[Captures, backup and recovery](captures-and-recovery.md#live-backup) for how the pieces fit.

## Local Captures

![Settings → Local Captures](../images/force-app/settings-captures.png)

Every recording on this PC's capture drive, with its size, duration, sample count and date. This
tab is **the only place a finished capture can be deleted**, so recordings otherwise pile up.
See [Captures, backup and recovery](captures-and-recovery.md#local-captures) for the upload-state
tags, editing metadata and uploading.

**Finding captures.** The list loads 200 at a time, newest first; the footer says "Showing N of
TOTAL" and **Load more** fetches the next page (nothing is capped any more). The **search box**
matches the sample name, the capture id, the source and a date (`2026-10-02`). The chips filter by
status (**Not uploaded**, **Uploaded**, **Incomplete**), and **Sort** orders by date or size. The
**Uploaded** and **Not uploaded** chips depend on the database, so they work on the pages loaded so
far and keep loading pages until a screenful matches; the footer shows how many were checked.

**Deleting several at once.** Tick captures (or **Select all shown**) and press **Delete
selected**. The confirm lists each capture with its size and upload state, the total space it frees,
and a red warning for any that is not uploaded and has no complete remote backup (the only copy).
Deletion runs one capture at a time, can be cancelled between captures, carries on past a failure,
and ends with a summary of what was deleted, failed or skipped and the space actually freed.
Incomplete captures can't be ticked (recover them, or delete them one by one), nor can the recording
in progress or one being recovered. A capture that is uploading right now can't be ticked, and bulk delete and Free up space are
disabled while **Upload N unsynced** runs (and the reverse). Bulk delete is unavailable while the
database can't be reached,
because it can't tell which captures are the only copy.

**Free up space.** Pick a number of days and press **Preview**: it scans every finalized capture and
lists the ones that are fully uploaded to the database (run, files and analysis record, not just a
run record left by an upload that died) and older than that. Captures that are not
uploaded, partially uploaded, incomplete, waiting in the upload queue or of unknown state are never included, whatever
their age. **Delete** asks again, looks every candidate up once more, then re-checks each capture
(still on disk, still fully uploaded, nothing running for it) right before deleting it, and
reports the result. A capture that is uploading is skipped.

**Upload N unsynced** shows "Uploading n of m" with the capture in flight, and **Cancel** stops after
the current capture. It counts the captures loaded in the list.

## Logs

![Settings → Logs](../images/force-app/settings-logs.png)

The recorder backend's log: recording start and stop timing, finalize duration, hardware warnings
and errors. You can filter by **Level** and **Search**, choose how many **Lines** to show, and
turn on **Auto-refresh** and **Follow latest**. **Copy** and **Download** export what is shown.
**Backend verbosity** changes how much the backend logs from now on. The file's path is shown
under the log (`backend.log`, rotated to three backups).

## Report a Bug

![Settings → Report a Bug](../images/force-app/settings-report-bug.png)

Files an issue straight into the project's GitHub. Choose **Bug** or **Feature request** and an
**Area**, then write a title and describe what happened. **Include diagnostics** (on by default)
attaches the recent backend log, this window's console and the machine state: amp mode, NI-DAQ
devices, channel map and disk space. No personal data beyond your login email is included, and
your Windows account name is stripped. **Recently reported** lists what you have filed.

Reports go through the **bug-report relay** on d1-server. The red message in the screenshot
(*could not reach the bug-report relay: 403*) is what you see when the relay is unreachable, as
it was on the demo stack.

## About

![Settings → About](../images/force-app/settings-about.png)

The installed version, **Check for updates** / **Update now** (desktop app only), and **What's
new**: the changelog bundled with each build, newest first, with a link to all releases on
GitHub.
