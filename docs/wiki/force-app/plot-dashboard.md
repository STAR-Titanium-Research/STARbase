# The Plot dashboard

[← Force App wiki](README.md)

**Plot** is where finished cuts are reviewed. The same dashboard (`packages/force-plotting`) also
runs inside Directus as the *Force Analysis* module, so everything here works the same in the
browser.

![The Plot dashboard](../images/force-app/plot-dashboard.png)

The page has four columns. From left to right:

1. **Samples** and **Operations.** Pick a sample, then one of its cuts.
2. **Sample detail** and **Operation detail**, plus the collapsible **Display**,
   **Signal statistics** and **Signal filters** cards.
3. The **Signals** panel: the per-axis charts. Its title is the current mode, *Force ›* at first.
4. The **FRM map** panel: the point cloud.

Drag the column edges to resize them. The **‹** buttons hide the first two columns for a wider
plot area. Panels 3 and 4 sit on a grid: drag them by the grip (⋮⋮), resize them from the corner,
or add more (see [Adding panels](#adding-panels)).

## Choosing a cut

- **Samples** lists every sample with analysed cuts. Type in *Search samples…* to filter.
- **Operations** lists the selected sample's cuts: pass code, date and peak Fz. The dot on each
  card shows processing state:

  | Dot | Meaning |
  |---|---|
  | green | FRM plot ready (a live cache exists) |
  | blue | processing on the host |
  | yellow | full-resolution octree only, no live cache |
  | red | processing failed |

  The most recently saved recording has a **⚡ Latest** chip. A count badge means the
  [Metadata doctor](#wear-trend-and-metadata-doctor) found problems with that cut.
- **Open ↗** on either detail card opens that sample or operation in Directus.

## Correcting an operation's metadata

The **Operation record (as specified)** block holds editable fields: subtype, cutting speed (as
surface speed m/min or RPM), feed, depth of cut, workpiece Ø (double-click to split into
outer/inner), operator, new edge, coolant and notes. **Sequence** and **Operation code** are
derived and cannot be edited: the operation code is regenerated from the subtype, sequence,
cutting parameters and sample code, just like Directus's own auto-naming.

Change what you need and press **Save changes**. Nothing is written until you confirm a summary
that lists every change as *old → new*, including the regenerated operation code:

![The Save changes summary](../images/force-app/plot-save-changes.png)

**Reset** reverts unsaved edits. A crop-window change (below) is batched into the same summary.

## Signals panel

One chart per axis (**Fx**, **Fy**, **Fz**, toggled with the coloured chips). **RPM** adds the
spindle-speed trace. The panel's title is the mode, as on the Record page: point at **Force ›**
and the other modes slide out beside it (or drop down as a menu in a narrow panel):

| Mode | Shows |
|---|---|
| **Force** | min/max force envelope over time. The shaded band marks the crop window, and the second axis along the top gives the tool's radial position (mm). |
| **FFT** | amplitude spectrum per axis (log scale) |
| **Power** | power spectrum (dB) |
| **Spectro** | time × frequency heatmap per axis |
| **Waterfall** | stacked spectra over time per axis |

| FFT | Spectrogram | Waterfall |
|---|---|---|
| ![FFT](../images/force-app/plot-fft.png) | ![Spectrogram](../images/force-app/plot-spectrogram.png) | ![Waterfall](../images/force-app/plot-waterfall.png) |

*Force* and *FFT* read the series and spectrum stored on the analysis row. The Force App stores
the series when it saves a cut. The spectrum is only stored by the host-side processing of
**archived** captures, so a cut saved from the Force App shows *no data* in FFT mode (see
[Troubleshooting](troubleshooting.md#plot-fft-says-no-data-or-figure--full--diagnostics-are-unavailable)).
*Power*, *Spectro* and *Waterfall* are computed on demand by the **filter service** on d1-server
from the cut's live cache, so they work for every cut that has one.

> The FFT screenshot above is of a Force App cut whose spectrum was added by hand for this wiki,
> computed from its live cache with the filter service's `/fft` endpoint to stand in for the
> host processing. Without that, the same view would show *no data*.

**Zoom.** The ⛶ button turns on rectangular zoom: drag a box on any chart. ↺ resets it. All
charts share the zoom and the hover cursor.

**Crop.** In *Force* mode, drag the edges of the shaded crop band on a chart to change the window
used for statistics and the FRM map. In *Lite* FRM mode a **Save crop** chip then appears in the
panel title. It asks *Save as official crop?* and writes the window to the operation.

### Comparing cuts

In *Force* mode, **Compare → + Add cut** overlays other cuts from the current list as dashed
traces. Use it to see, for example, how force changes across passes with the same edge. **×** on a
chip removes it and **Clear** removes all:

![Comparing two cuts](../images/force-app/plot-compare.png)

## FRM map panel

| View | What it is |
|---|---|
| **Figure** | the pre-rendered FRM image made by host processing (archived captures only). Instant. |
| **Lite** | an interactive point cloud from the live cache. It reacts to crop and feed edits and to filter previews. |
| **Full** | the full-resolution octree, streamed level-of-detail from the octree server. If none exists yet, clicking asks the host to build it (archived captures only). |
| **Gridded** | an interpolated, filled-surface grid octree, also built on the host |

**Fx / Fy / Fz** chooses the coloured axis. **2D / Z = Fx / Fy / Fz** lifts the map into 3D, with
height driven by a force series; drag to rotate, and the slider sets the Z exaggeration:

![The FRM map in 3D](../images/force-app/plot-frm-3d.png)

The download button saves the current view (at its current zoom) as a PNG. Badges in the title
show the fidelity of a gridded view, and whether filters are applied or baked.

## Display

The **Display** card controls the FRM map's appearance: point size, thinning (*show every Nth
point*), colour map and number of steps, and a **colour-scale editor**. The editor shows a
histogram of the axis's force values with draggable saturation and display limits, and **Lock
scale** keeps the limits fixed while you move between cuts.

![The Display card with the colour-scale editor](../images/force-app/plot-display.png)

**Full-resolution render (host)** asks the host to render a high-point-count FRM image.

## Signal statistics

Computed in the browser from the live cache:

![Signal statistics](../images/force-app/plot-stats.png)

- **Mean, RMS, Std, Min/Max** of each axis over the crop window.
- **Dyn. range bits:** log₂(signal span ÷ noise floor) over the whole cached signal. A clean,
  full-range 12-bit capture sits near 12–13. Well below that means the channel was under-ranged
  on the Lab Amp.
- **Rail hits lo/hi %:** how often the signal sat at the amplifier's limits. Sustained rail hits
  (flagged **clip**) mean the channel was over-ranged and the data is clipped.
- **RPM (window):** mean ± spread of spindle speed over the crop window.

> The demo cut in these screenshots shows *clip* on every axis. That is an artefact of the
> simulated signal, not something a real recording would normally show.

## Signal filters

Filters clean up a signal without touching the stored raw data:

![Signal filters with low-pass and notch enabled](../images/force-app/plot-filters.png)

| Filter | Settings |
|---|---|
| **Despike** | window (odd) and σ threshold |
| **Detrend** | high-pass (with cutoff) or DC removal |
| **High-pass**, **Low-pass** | cutoff (Hz) and order |
| **Notch × harmonics** | Q, plus which spindle-frequency harmonics (1×–5×) to notch |

In **Lite** view, the FRM panel previews **raw** and **filtered** side by side, and in *FFT* mode
the filtered spectrum is drawn dashed over the active axis:

![Filter preview](../images/force-app/plot-filters-page.png)

- **Load profile… / Save…** stores and reuses named filter chains.
- **Apply (Lite)** makes the chain this cut's default. *Lite* recomputes it live, but *Full* and
  the *Figure* stay raw.
- **Bake all** reprocesses the cut on the host so every output (Lite, Full, Figure) is filtered.
  It is heavier, needs the force orchestrator, and is **admin-only**.
- **Clear** removes an applied chain.

## Adding panels

**+ Add** in the header adds a panel: another **Signals** or **FRM map** panel, a **Wear trend**
or the **Metadata doctor**. Each panel's **×** closes it. ▦ returns to the default layout, one
Signals and one FRM map panel side by side, and removes any others. Unlike the Record page, the
Plot page resets without asking first.

![The Add menu](../images/force-app/plot-add-menu.png)

### Wear trend and Metadata doctor

![Wear trend and Metadata doctor panels](../images/force-app/plot-wear-doctor.png)

- **Wear trend** plots a force statistic across successive cuts on the same **edge** (or sample),
  against pass number or cumulative cutting length. It needs at least two completed operations
  on the edge. Record the insert and edge on every cut to get a useful trend.
- **Metadata doctor** checks the selected operation (**This op**), or every operation (**All**),
  for places where the two records of a cut disagree: the metadata the `.mat` file itself carries
  and the D1 operation record. Each finding offers a fix where one exists:

  | Finding | Fix offered |
  |---|---|
  | the operation is not linked to a sample | link it |
  | a cutting parameter differs between the `.mat` and the database | adopt the `.mat` value |
  | the stored operation code no longer matches its fields | regenerate the code |
  | the crop window doesn't cover the cut (usually a wrong feed or diameter) | opens the crop editor |

  The optional checks (*Name vs fields*, *Recording vs operation date*) are ticked on in the
  panel's header.

## Local captures

`/plot/local/<capture id>` shows a capture that is on this PC but not in the database, straight
from the recorder backend. The save dialog's **Open in Plot** goes there when you did not upload.
See [Captures, backup and recovery](captures-and-recovery.md#viewing-a-capture-that-isnt-in-the-database).
