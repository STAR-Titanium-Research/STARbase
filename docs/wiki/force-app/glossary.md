# Glossary

[← Force App wiki](README.md)

| Term | Meaning |
|---|---|
| **Capture** | one recording on the capture drive, identified by its capture id (`YYYYMMDD-HHMMSS-xxxxxx`) |
| **Capture drive** | where recordings are written; chosen in Settings → General |
| **Crop window** | the part of a recording treated as the actual cut (tool in contact). Auto-detected, adjustable in the save dialog and on the Plot page. |
| **Cut start** | the moment the tool touches the workpiece, detected from the force rising above the baseline |
| **`d1raw`** | the raw acquisition file format (`raw.d1raw`), written continuously and never modified |
| **`d1lc`** / live cache | the decimated signal cache (`live_cache.bin`) the Plot page, replay and filter service read |
| **Diag build / bake** | host-side diagnostics processing of one cut (see [Diagnostics](diagnostics.md)) |
| **DoC** | depth of cut (mm) |
| **Drift compensation** | removing the slow linear drift a charge amplifier adds over a recording, from the saved outputs only |
| **Dynamometer (dyno)** | the Kistler multi-component force sensor; its individual sensors are the sub-channels Fx1…Fz4 |
| **Edge** | one cutting edge of an insert. Force and wear are tracked per edge. |
| **Envelope / series** | the min/max force per time bin stored on the analysis row, which the Force charts draw |
| **FFT** | Fast Fourier Transform: the amplitude spectrum of a signal |
| **Filter chain** | an ordered set of signal filters (despike, detrend, high/low-pass, notch) |
| **Finalize** | turning `raw.d1raw` into `capture.mat` + `live_cache.bin` + `summary.json` after a recording stops |
| **FRM** | Force-Revolution Map: force plotted against spindle angle and revolution as a spiral; the cut's "fingerprint" |
| **Fx / Fy / Fz** | the summed force components (N). Mz is torque; Fxy is the in-plane resultant. |
| **Gi\*** | Getis-Ord hot-spot statistic, used by Diagnostics |
| **Lab Amp** | the Kistler charge amplifier between the dynamometer and the NI-DAQ |
| **Lite / Full / Figure / Gridded** | the four FRM views on the Plot page (live-cache cloud / full-resolution octree / pre-rendered image / interpolated surface) |
| **MEASURE / RESET** | the Lab Amp's two operating modes |
| **NI-DAQ** | the National Instruments data-acquisition chassis (cDAQ) and its C-series modules |
| **Octree** | a level-of-detail point-cloud format (Potree) for streaming millions of points |
| **Operation** | one machining pass, stored as a `manufacturing_operations` row |
| **Operation code / pass code** | the auto-generated operation name, e.g. `101-AA-MF-2026-09-01-MT-R4-301.59MPM_0.15feed_0.1DoC` (sample code, subtype, sequence, cutting parameters) |
| **Operation type / subtype** | the kind of cut, e.g. *Turning – Facing* (MT-F), *Turning – Roughing* (MT-R) |
| **Orchestrator** | `scripts/force_orchestrator.py` on d1-server: runs MATLAB processing, builds octrees, bakes filters and diagnostics |
| **Pulses/rev (PPR)** | tacho pulses per spindle revolution |
| **Rail hits** | samples at the amplifier's output limits, meaning the signal is clipped |
| **Replay** | playing an archived cut through the live panels without recording |
| **Sample** | the physical workpiece being machined (a D1 `samples` row) |
| **Surface speed (Vc)** | cutting speed at the tool, m/min; `Vc = π · D · RPM / 1000` |
| **Tacho** | the once-per-revolution spindle pulse used for angle and RPM |
| **Virtual channel** | a channel computed from others by a formula during acquisition |
