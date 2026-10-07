# Diagnostics Workbench

[← Force App wiki](README.md)

The **Diagnostics** section runs deeper analysis on a cut's full-resolution force spiral. It
turns "that looks like a macrozone" into mapped hot-spots and clusters with statistical backing.
It is a specialist tool and is kept out of the everyday Plot dashboard.

![The Diagnostics page before any analysis has been built](../images/force-app/diagnostics.png)

> **About this screenshot.** A diagnostics build runs MATLAB (`process_force.m`) and
> PotreeConverter on d1-server. The demo stack these screenshots came from has neither, so it
> shows the page's empty state: *No diagnostics analysis yet for this operation.* On a real
> install the same page shows the workbench panels described below.

## How it works

All heavy computation happens on the host. The browser only edits recipes, draws regions and
displays results. It never computes statistics itself.

1. **Pick an operation** in the list on the left. It shows every successfully analysed cut,
   grouped by sample (or by campaign: use *Group by*), each tagged with its diagnostics state:
   `✓` built, `…` pending or processing, `✗` failed, `·` not built. Type in the search box to
   filter by pass code, sample or campaign, and use the **Needs build / Built / Error** chips to
   narrow it. Each row has **Plot** (opens the cut in the Plot page) and **Directus** (opens the
   analysis record) links. If your role cannot read campaigns, *Group by* offers Sample only and the
   list loads as usual. Long lists show 100 rows at a time; use *Show more*.
2. **Build.** The app marks the analysis row `diag_status = pending`. The **force orchestrator**
   daemon on d1-server claims it, re-runs MATLAB on the archived `.mat` to emit a dense point
   cloud and live cache, runs the diagnostics **recipe** (below), and publishes a diagnostics
   octree. Large cuts take minutes, and the page polls until the row is `done` or `error`.
3. **Explore** the result in the workbench panels, tune the recipe with fast previews, and
   **Bake** when you are happy. Baking re-runs the build with your recipe, so what you tuned is
   exactly what is stored.

If a build sits at *pending* forever, the orchestrator daemon is not running. See
[Troubleshooting](troubleshooting.md#diagnostics-never-finish-building).

A build re-runs MATLAB on the cut's **archived** `.mat`. A cut saved straight from the Force App
has no archive copy, so its build ends in `✗` with *no archive .mat linked to this analysis row*
until its capture has been copied into the archive and indexed.

## The recipe

A recipe is an ordered list of steps that you can toggle, retune and reorder. The default recipe:

| Step | What it does |
|---|---|
| `frame_transform` | rotates and corrects forces into the workpiece frame, using the tool setup's mount angle and H-matrix |
| `angular_resample` | resamples each revolution onto a fixed angular grid (samples per rev) |
| `tsa` | time-synchronous averaging: the repeating once-per-rev component, and the residual left over |
| `radial_detrend` | removes the slow radial trend, so what remains is local variation |
| `getis_ord` | Getis-Ord Gi* hot-spot statistic (neighbourhood `k`, significance `alpha`) |
| `hdbscan` | density-based clustering of the significant regions, with GLOSH outlier scores |
| `envelope` | band envelope analysis |

Named recipes are saved in the **recipe library** (the footer of the Pipeline panel). *Save as…*
asks for a name and optional notes, *Rename* edits both, and the delete button asks before
removing. *Export* downloads the selected (or current) recipe as a `.d1recipe.json` file and
*Import* reads one back, checking it first and refusing a file with unknown steps, bad values or
a step order that cannot run. A **modified since loaded** badge appears when the recipe you are
editing no longer matches the library recipe you applied.

### Apply a recipe to many operations

Tick the operations you want in the list (or *Tick all* for the filtered list), then press
**Apply recipe to N selected…**, choose a library recipe and **Queue**. For each cut the app makes
the same request as the Bake button, one at a time, and shows progress; *Cancel* stops before the
next one. The summary lists what was queued, **skipped** (already built with an equivalent
recipe, or already queued) and **refused** (with the reason: for example, your role can't request
builds, which stops the run; Lab Members can, read-only roles can't). Tick *Rebuild cuts already built with this recipe* to force those through.
"Queued" means waiting for the orchestrator daemon, which analyses them one after another;
press *Refresh* to watch them turn built. Painted layers are not compared, so a cut whose layers
changed after its last bake needs the rebuild box.

Hand-painted **layers** (mask, label, seed regions) are stored per cut and read at bake time, so
a recipe stays reusable.

## Panels

| Panel | Shows |
|---|---|
| **Spatial view** | the full-resolution cloud, coloured by any channel the recipe produces (residual, Gi*, significance, cluster id, GLOSH, envelope band…). You can have several side by side. |
| **Pipeline** | the recipe editor, with a live preview of any step over a framed region |
| **Signal** | the anomaly signal along the cut, per force channel in the workpiece frame (Fp / Fc / Ff chips, or *All channels* to compare them) |
| **Clusters** | a per-cluster summary table; **Download CSV** / **Copy** exports every row (`cluster_id`, `points`, `fraction_of_cut`, `mean_abs_resid_z`, `max_gi_star`, `r_min_mm`, `r_max_mm`) |
| **Selection inspector** | statistics for the points you have selected |

The workbench can also pop out into its own window (`/diag-panel/<analysis id>`) for a second
monitor.

## Services involved

| Service | Role |
|---|---|
| Force orchestrator (`scripts/force_orchestrator.py`) | claims builds and bakes, runs MATLAB and `scripts/diag` |
| Diag preview service (`plugins/diag-service`, `/diag`) | fast per-step previews while tuning |
| Octree server (`/octrees`) | streams the diagnostics octree to the Spatial view |

Design detail: [`docs/superpowers/specs/`](../../superpowers/README.md), the *diagnostics* specs
dated 2026-08-30 to 2026-09-04.
