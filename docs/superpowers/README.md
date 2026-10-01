# Feature designs

`specs/` holds the design document behind each substantial feature: the problem, the options
weighed and the decision taken. Each opens with a **Status** line saying whether it has shipped
and where the implementation lives. Specs stay after a feature ships, because code, migrations and
config cite them for their rationale.

Implementation plans — step-by-step task lists written for agentic execution — live in `plans/`
only while the work is in flight. Once the feature has shipped and been verified against the code,
its plan is deleted and the git history is the record. The folder does not exist when no plan is
open.

| Spec | Area | Status |
|---|---|---|
| [Lab data model & UX](specs/2026-07-03-lab-data-model-and-ux.md) | LIMS schema / Directus | Implemented |
| [Tacho linear fit + pulses-per-rev](specs/2026-07-10-tacho-linear-fit-pulses-per-rev-design.md) | Force analysis | Implemented |
| [FRM full-resolution viewer](specs/2026-07-11-frm-full-resolution-viewer-design.md) | Force plotting | Implemented |
| [FRM interpolated-grid octree](specs/2026-07-13-frm-interpolated-grid-octree-design.md) | Force plotting | Implemented |
| [FRM filtering suite](specs/2026-07-21-frm-filtering-suite-design.md) | Force plotting | Implemented |
| [FAST recipes + machine metadata](specs/2026-07-22-fast-recipes-and-metadata-design.md) | FAST sintering | Implemented |
| [Force capture v2.0 schema](specs/2026-07-27-force-capture-v2-schema-design.md) | Force file format | **Design only** |
| [Recording 2a — sim + live streaming](specs/2026-07-30-recording-2a-sim-streaming-design.md) | force-app | Implemented |
| [Recording 2d — Directus sync](specs/2026-07-30-recording-2d-directus-sync-design.md) | force-app | Implemented |
| [Recording 2e/2c — alarms + LabAmp](specs/2026-07-30-recording-2e-2c-alarms-labamp-design.md) | force-app | Implemented |
| [NI-DAQ channel model](specs/2026-08-02-nidaq-channel-model-design.md) | force-app | Implemented |
| [Desktop packaging](specs/2026-08-10-force-app-desktop-packaging-design.md) | force-app | Implemented |
| [Replay playback transport](specs/2026-08-26-replay-playback-transport-design.md) | force-app | Implemented |
| [Diagnostics Workbench](specs/2026-08-30-diagnostics-workbench-design.md) | Diagnostics | Implemented (UI superseded) |
| [Diagnostics Recipe Workbench](specs/2026-09-01-diagnostics-recipe-workbench-design.md) | Diagnostics | Implemented |
| [Diagnostics Phase F — segmentation + library](specs/2026-09-03-diagnostics-phase-f-segmentation-and-library-design.md) | Diagnostics | Implemented |
| [Diagnostics Phase G — interactive full-res](specs/2026-09-03-diagnostics-phase-g-interactive-fullres-design.md) | Diagnostics | Implemented |
| [Diagnostics Phase H](specs/2026-09-04-diagnostics-workbench-phase-h-design.md) | Diagnostics | Implemented |
| [Milling path models + polar plot](specs/2026-09-07-milling-path-models-and-polar-design.md) | force-app / plotting | Implemented |

Add a row when a new spec lands, and update its Status line (and this table) when it ships.
