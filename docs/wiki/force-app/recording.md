# Recording a cut

[← Force App wiki](README.md)

The **Record** page is where cuts are acquired. The left-hand **Recording & Metadata** panel
sets up the cut. The panels to its right show it live (see [Live panels](live-panels.md)).

![The Record page before a cut](../images/force-app/record-idle.png)

## 1. Choose a source

The three-way switch at the top of the panel picks where the signal comes from:

| Source | What it does | Writes a capture? |
|---|---|---|
| **Simulated** | generates a synthetic cut: a ramp-in, steady cutting at the configured mean forces with noise, then a ramp-out. For training, demos and testing without the rig. | yes |
| **Replay file** | plays back a cut that is already in the database. See [Replaying an archived cut](replay.md). | **no**, playback only |
| **NI-DAQ** | acquires from the real NI-DAQ chassis via the Lab Amp. Needs the NI-DAQmx runtime and the hardware. | yes |

On first launch the app picks **NI-DAQ** automatically if it finds real hardware, and
**Simulated** otherwise. After that it remembers your last choice.

## 2. Fill in the cut parameters

![Parameters and metadata filled in](../images/force-app/record-ready.png)

| Field | Notes |
|---|---|
| **Sample** | search by sample code and pick from the list. **Required for saving to the database:** the database row is linked to it. |
| **Spindle (RPM)**, **Feed (mm/rev)** | the programmed cutting parameters |
| **Diameter (mm)** | the workpiece diameter. **Double-click** to split it into *Outer Ø* and *Inner Ø* for tube or annular stock (double-click again to merge). |
| **Sample rate (Hz)** | acquisition rate per channel. On NI-DAQ it turns red if it exceeds what the assigned hardware can do. |
| **Pulses/rev** | tacho pulses per spindle revolution (1 for the standard once-per-rev tacho) |
| **Machine**, **Operator** | searchable lists from the database. Machines are filtered by the operation type's category. |
| **Operation type** | e.g. *Turning – Facing*, *Turning – Roughing*. It decides the database *method* the run is logged under. |
| **Tooling → Insert / Edge / Tool** | the insert and the individual cutting edge. The edge is what wear trends are tracked by (see [Wear trend](plot-dashboard.md#wear-trend-and-metadata-doctor)). |

Depth of cut, coolant, cutting length, operation sequence, chips reference and notes are in the
folded sections further down the panel. You can also fill them in or correct them after the cut
on the [Plot dashboard](plot-dashboard.md#correcting-an-operations-metadata).

### The setup is remembered

The app remembers the setup between launches, so you do not re-pick the same sample, machine and
operator every morning: the spindle, feed, diameter, sample rate and pulses/rev values, the
**Sample**, **Machine**, **Operator** and **Operation type** picks, and the depth, coolant and
cutting-length fields. Insert, edge and tool are not remembered across launches (they change
cut to cut), and neither are the per-cut fields: notes, pass code, operation sequence, chips
reference, chips collected and the new-edge mark. The setup is kept in this computer's app
storage, per user profile, and is not sent anywhere.

**Clear setup**, at the bottom of the panel, puts every field back to blank or its default and
forgets the remembered copy. Choosing **Replay file** clears Sample, Machine and Operation type
for the replay search as before, but does not erase the remembered setup: it is put back in the
form as soon as you return to Simulated or NI-DAQ (whatever a replayed cut filled in is dropped),
and it is there at the next launch. The same goes for the per-cut fields and the insert, edge and
tool picks: they come back as they were before you opened Replay, so the next cut is never linked
to the archived cut's edge, sequence or notes.

## 3. Recording behaviour toggles

Three toggles sit at the bottom of the panel, just above **Start**, so they are checked right
before each cut. They are the same switches as in [Settings → Recording](settings.md#recording),
which explains them in full and holds the cut-detection threshold:

| Toggle | Effect |
|---|---|
| **Cut start** (detect cut start) | the live FRM map holds at the origin until the tool touches down, so air-cut revolutions don't crowd the fingerprint |
| **Drift** (drift compensation) | applies a linear drift correction (the same one the MATLAB app used) to the **saved outputs** (`.mat` and live cache). The raw capture is never modified, so turning this on or off later loses nothing. |
| **Converge** (converging auto-range) | NI-DAQ only. After each cut, recommends new per-channel Lab Amp ranges from that cut's peaks and applies them to the next cut, so a badly ranged channel converges on the amp's full resolution. On Simulated/Replay it previews the recommendation only, and says so under the toggles. |

## 4. Start

### Pre-flight checks

A row of small chips above **Start** shows what is and isn't ready. Hover a chip for the detail.
Anything that needs attention also gets a line of its own with **Show me**, which rings the control
that fixes it (or opens the page that owns it).

| Chip | Checks | If it isn't right |
|---|---|---|
| **Sample** | a Sample is picked | warning. See *Start anyway* below. |
| **Signed in** / **Offline session** | there is a sign-in to upload with | an offline session is only a note: the cut is saved on this PC and uploaded after you sign in again. Not signed in at all is a warning. |
| **Lab Amp** (NI-DAQ) | the amp answers | a warning if it doesn't: without the amp's ranges Start uses the channel model's gains if it has them, and otherwise records in volts, not newtons. **Start** resets the amp and sets it to MEASURE itself, so RESET beforehand is normal and shows as fine. |
| **Tacho** (NI-DAQ) | tacho pulses seen | shown as *not checked*: the recorder only sees the tacho once samples are flowing, so the check is the Tacho alarm during the cut. |
| **Disk** | free space on the capture drive, as *about N min at this rate* | a warning under 30 minutes, red under 5. The runway is free space minus the 1 GB at which the recorder force-stops, divided by the sample rate × 10 columns × 4 bytes. **Show me** goes to the sample rate. |
| **Channels** (NI-DAQ) | the saved channel list can record | red for a rotating-dyno layout or one input wired to two channels, a warning if a force channel or the Tacho has no input yet. **Show me** opens the NI-DAQ page at the channel list. Skipped (*not checked*) when the Record page's own channel list isn't the default one, because Start then sends that list and ignores the saved channel model. |

A chip that couldn't be read yet (the recorder is still starting, the amp page didn't answer) shows
as *not checked*, never as a failure. The list refreshes every 15 seconds while you wait, and
Replay has no checks.

**Start anyway.** A missing Sample is a warning, not a block: pressing **Start** with no Sample asks
*Start without a Sample?* and **Start anyway** goes on. The cut can be linked to a Sample later
(for example when you were offline), but it can't be uploaded until it is. Everything that already
stopped a start still does: the NI-DAQ sample-rate limit disables **Start**, the low-disk prompt and
the alarm test below are unchanged.

Press **Start**. The first time in each session the app offers to test the safety alarms:

![The alarm-test prompt](../images/force-app/alarm-test-prompt.png)

**Test alarms now** fires the alarm banner and tone so you can confirm you would notice them.
**Start without testing** is fine if you have already checked them on this machine today. The
thresholds are set in [Settings → Safety Alarms](settings.md#safety-alarms).

While you cut, a force axis that reaches the **early-warning level** (80 % of the force limit by
default) raises an amber banner, with no tone and nothing to acknowledge. If the limit itself is
reached the red alarm takes over. You can also have the alarm stop the recording for you; that is
off by default (see the settings page). This only works while the Record page is open, because the
alarms are checked there: stay on the Record page during a cut. After an alarm stops a cut the
alarm banner stays above the save dialog, and **A** or **Acknowledge** still silences it.

While recording, the parameter fields lock and **Start** becomes **Stop**:

![A cut in progress](../images/force-app/record-live.png)

### Keyboard shortcuts

The Record page has a **Keyboard shortcuts** line under **Start** that lists these. On a Mac use
Cmd instead of Ctrl.

| Keys | Does |
|---|---|
| Ctrl+Enter | **Start**, exactly as the button: the pre-flight prompt, the alarm test, the low-disk prompt and the sample-rate block all still apply |
| Ctrl+. | **Stop** |
| A | acknowledge a safety alarm, while the alarm banner shows (you are still asked to confirm) |
| Ctrl+N | **New**, once a cut is finished |
| Enter | the save dialog's main button (**Save**, or **Open in Plot** once saved) |

Space and Esc are never used to start or stop. The shortcuts are ignored while you type in a field
(except Enter in the save dialog) and in Replay. **A** is the exception to the save dialog rule: it
silences a showing alarm even while the save dialog is open.

Three limits to know about:

- **Ctrl+N cannot be overridden in a browser tab.** Browsers reserve it to open a new window, so in
  Chrome or Edge use the **New** button. In the desktop app Ctrl+N works.
- **The shortcuts do not work in a pop-out panel window.** They listen on the Record page itself;
  click back on the main window first.
- The **Help** menu's own shortcuts in the desktop app (View Logs, Report a Bug, Open Captures
  Folder) are Ctrl+Shift on Windows and Cmd+Shift on macOS.

A recording stops when you press **Stop**. It also stops by itself when a simulated run reaches
its planned length, or when the capture drive runs out of space.

### Railed channels

If a sensor channel reaches full scale while you are cutting, the app tells you during the cut, not
after it. A railed channel has saturated the Lab Amp's analog output, so its peaks are flattened
and only a wider range fixes it, which you can only change between cuts.

- A red **Railed** tile appears in the Overview strip naming the channel (`Fy2`, `Fz1`, …).
- A red dot appears on the Force Plot's **Sub** button, and a red **railed** badge beside the
  channel in its list.
- A red banner says *Ch Fy2 railed - re-range before the next cut*. It shows **once per cut**:
  **Dismiss** keeps it away until the next cut, even if more channels rail. The tile and badges
  stay until you press **New** or start the next cut. They show in Record mode only, never when
  you play back an archived cut.

A channel counts as railed when its peak reaches **99 %** of its full scale (its gain times the
Lab Amp's analog full-scale voltage, which you set in the Lab Amp settings or `ANALOG_FULLSCALE_V`). That is the same test the saved capture uses for its per-channel clipping flags,
which the **Converge** toggle reads to widen the range for the next cut. The live warning only
works on the NI-DAQ source with per-channel gains known, which come from the Lab Amp's ranges
(Lab Amp reachable at Start) **or** from the `gain_n_per_v` set on each channel in the NI-DAQ
channel model. With neither, there is no warning, and the cut is recorded in **volts, not
newtons** (the recorder falls back to a gain of 1), so the Lab Amp pre-flight chip says so when the
amp is unreachable. Simulated data is already in newtons with no range to compare against, so it
never rails.

## 5. Save or discard

When the recording stops, the **Recording finished** dialog opens. It first works through
*Stopping acquisition → Writing capture files (.mat, live cache) → Loading recorded trace*, with a
timer on each stage, and then shows the whole cut:

![The save dialog](../images/force-app/save-dialog.png)

- **Adjust the cut window.** The shaded region is the automatically detected cut (tool in contact).
  Drag its edges to correct it. The dialog then shows the adjusted and auto-detected times, with a
  **Reset** button.
- **Upload to database** (ticked by default when online) creates the operation record and
  attaches the capture files (see [what gets written](#what-saving-writes)). It is disabled when
  no Sample is picked, and when the PC is offline.
- **Save a local copy (.mat / .csv)** additionally downloads a copy of the capture as
  `<capture id>.mat` / `.csv`. The `.mat` option is unavailable for captures too large to export.
- **Open in Plot** jumps straight to the finished cut. The capture files are already on disk, so
  this is always safe.
- **Save** does what is ticked. On success the dialog says *Saved. Logged to the database.* and
  offers **Start new run** or **Open in Plot**:

![Saved](../images/force-app/record-finished.png)

**Don't save** asks for confirmation first:

![The discard confirmation](../images/force-app/discard-confirm.png)

Discarding only skips the database record and the local export. The raw capture stays on the
capture drive and is listed in [Settings → Local Captures](captures-and-recovery.md#local-captures),
where you can upload it later or delete it.

If finalizing fails, the dialog says so and nothing is uploaded. The raw capture can still be
recovered (see [Crash recovery](captures-and-recovery.md#crash-recovery)).

### What saving writes

Saving a cut makes, in order:

1. a **`manufacturing_operations`** row: the sample, machine, operator, method (from the
   operation type), cutting parameters, tooling and a `recorded_metadata` block holding the
   capture id, peaks and source;
2. two uploaded **files**: `capture.mat` (full resolution, when small enough) and
   `live_cache.bin` (the decimated cache the Plot page reads);
3. a **`machining_force_analysis`** row linking the operation to those files. It also stores a
   min/max *series envelope* for the charts, the peaks, and the crop window if you moved it.

The analysis row is saved as already finished (`status = done`). Everything the Plot page
computes from the live cache works straight away. The host-side processing on d1-server (the
stored FFT, the FRM *Figure*, the full-resolution octree and diagnostics) only runs on captures
indexed from the archive share, so it does not run on a cut saved this way. See
[Force data in the database](../database/force-data.md#two-ways-in).

> **Partial failures.** Step 1 happens before the uploads. If the file upload is refused (for
> example because your role cannot create files), the operation row already exists and is left
> without an analysis. Delete it in Directus, or ask an admin to fix the permission and save
> again from Local Captures.

## Starting the next cut

After saving, press **New** (or **Start new run** in the dialog) to clear the plots. The sample,
machine, operator and tooling stay filled in. The per-cut values reset: if the **operation
sequence** is a whole number it goes up by one (so the Cut ID `{sample}-{TYPE}{seq}` does not
repeat), and **chips reference**, **chips collected** and the **new edge** mark are cleared. A
typed pass code and the notes are left as they are, so change them if they no longer apply.

**Discarding** a cut does not step the sequence or clear those fields: the retake is the same cut.

## Leaving the page mid-cut

Recording runs in the backend, not the page. You can switch to Plot or Settings while a cut runs.
A banner on every other page shows its progress (see [Getting started](getting-started.md#while-a-recording-is-running)).

You do not have to be on the Record page when the cut ends. The page checks with the recorder
whenever you come back to it, and if the cut finished (or is still being saved) while you were
away, the save dialog opens then. The capture is finalized on disk either way and is listed in
[Settings → Local Captures](captures-and-recovery.md#local-captures), which is where an
un-uploaded capture gets uploaded later.

One case is not offered again: if you **reload or restart the app** and the cut has already finished,
the page starts with no memory of it and does not open the dialog. A cut that is still being saved
at that point is offered. Either way, find the finished cut in Local Captures.
