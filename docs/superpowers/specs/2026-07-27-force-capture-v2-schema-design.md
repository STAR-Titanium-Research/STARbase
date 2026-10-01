# Force Capture v2.0 — Self-Describing Multi-Stream Schema

**Status:** design — **not yet implemented.** The recorder still writes the v1.0 layout
(`apps/force-app/backend/app/finalize.py`), `process_force.m` has no v2.0 reader, and
`scripts/matlab/migrate_force_to_v2.m` is a draft of the archive migration. The rotating-dyno
channel preset (`apps/force-app/backend/app/channels.py`) is blocked on this format.
**Date:** 2026-07-27
**Related:** [`docs/force-file-standards.md`](../../force-file-standards.md)

## Goal

Define one self-describing `.mat` format (v2.0) that becomes the **single target for every
force capture** — both new captures written by the FFA app and all 262 legacy captures in the
archive, migrated up. v2.0 replaces the four incompatible legacy layouts (v0.1 / v0.5 / v0.9 /
v1.0) with a stream-oriented schema that:

1. supports a **variable number of channels** instead of a fixed 10-column matrix;
2. carries **per-channel descriptors** — role, unit, bit precision, device, calibration;
3. holds **multiple streams at independent sample rates** (e.g. force @ 51.2 kHz and machine-tool
   position @ 333 Hz) in one file;
4. represents **incomplete captures honestly** (missing tacho, missing force corners) rather than
   silently mis-parsing them.

This is not a green-field invention. It formalizes and unifies a model the FFA capture app
(`ABetterFactoryPlusApp.mlapp`) already half-implements.

## What the app already does (the basis for v2.0)

Read from the app source, 2026-07-27. Acquisition today is three separate things:

1. **Dyno** — the Kistler force plate. `metadata.Dyno.Devices`, `metadata.Dyno.Gain`, plus a
   signed `AmpSettings` LabAmp export. Produces channels `Fx1,Fx2,Fy1,Fy2,Fz1,Fz2,Fz3,Fz4`.
2. **Stream1..Stream6** — six general NI-DAQ streams. Each is a struct with `.Device`,
   `.Channels`, `.MeasurementType`, `.DeviceIndex`, `.RateLim`, `.VariableName`. Written to
   `metadata.Stream<n>` only when `.Device` is non-empty (hence archive files show only
   `Stream1` = tacho). Var-names appended as `"<StreamName> (<channel>)"`.
3. **Machine Controller** — `app.ControllerDataStreams`, the positional/machine data. **Exists in
   the app but its save path is commented out** (`document.xml` lines 942–948, 960–964); when
   wired it wrote a *separate* `MT<filename>.mat`.

| Machine | Rate | Channels |
|---|---|---|
| EVO 40 | 333 Hz | `MachineCycle, sNomX/Y/Z/C/B, sActX/Y/Z/C/B, sActS1, Power_Elec_S1, Power_Mech_S1, Torque_S1, SpLoad, vActS1` |
| ECOSPEED | 500 Hz | `Xact, Yact, Zact, Spact, V_Xact…V_Zcom` |

Dyno + Stream1..6 are **co-sampled into one `DATA` matrix** at a single NI rate — that is exactly
today's v1.0 layout. The machine-controller stream runs at a **different** rate and has no home in
the current file. v2.0 unifies all of it and finishes the machine-tool path.

## File layout

A v2.0 `.mat` has three small descriptor variables and one pair of large arrays per stream:

```
formatVersion          = 2.0                  % scalar — the discriminator
capture                = struct(...)          % operation/sample metadata (small)
streams                = struct(...)          % stream + channel descriptors (small)
AmpSettings            = struct(...)          % signed LabAmp export, verbatim (as today)

stream__force__data    = [Nf x Cf  double]    % big arrays kept TOP-LEVEL
stream__force__time    = [Nf x 1   double]
stream__tacho__data    = [Nf x 1   double]
stream__tacho__time    = [Nf x 1   double]
stream__machine__data  = [Nm x Cm  double]    % (future) different rate -> own Nm, own time
stream__machine__time  = [Nm x 1   double]
```

**Why the big arrays are top-level, not nested in `streams`.** `matfile` partial loading only
works on top-level variables, never on fields inside a struct. The archive contains multi-GB
force matrices (up to 11.8 GB). If sample arrays lived inside the `streams` struct, every read
would pull the whole file into RAM. The `streams` descriptor therefore holds a *pointer*
(`data_var` / `time_var`) to each top-level array. The `stream__<name>__data` naming is only a
convention; the descriptor is authoritative.

Streams at different rates have different row counts, so they cannot share a matrix and are
naturally separate top-level variables regardless.

## Stream descriptor

`streams` has one field per stream, formalizing the app's `Dyno` / `Stream<n>` /
`MachineController` structs:

```matlab
streams.force = struct( ...
    'source',           'Dyno', ...          % Dyno | Stream<n> | MachineController
    'device',           {{'Force1_Mod1'}}, ...% app: Dyno.Devices / Stream.Device
    'device_index',     [], ...              % app: Stream.DeviceIndex
    'measurement_type', 'Charge', ...        % app: Stream.MeasurementType
    'rate_hz',          51200, ...
    'rate_limits',      [0.1 800000], ...    % app: Stream.RateLim
    'gain',             1, ...               % app: Dyno.Gain
    'n_samples',        Nf, ...
    'data_var',         'stream__force__data', ...
    'time_var',         'stream__force__time', ...
    'amp_settings_var', 'AmpSettings', ...    % force stream only; '' otherwise
    'channels',         chstruct );          % 1xC struct, see below
```

Standard stream names: `force` (ex-Dyno), `tacho` (ex-Stream1), `machine` (ex-MachineController),
and `aux1..auxN` for any other Stream<n>. Names come from the descriptor, not hard-coded.

## Channel descriptor

One entry per column of the stream's data array. Adds `role` / `unit` / `bits` on top of what the
app records:

```matlab
channels(k) = struct( ...
    'name',           'Fz1', ...      % app VariableName / channel id
    'role',           'force_raw', ...% controlled vocabulary, see below
    'axis',           'z', ...        % x|y|z|c|b|s1|''
    'unit',           'N', ...        % N|V|mm|deg|mm/s|W|Nm|pulse
    'bits',           16, ...         % true ADC resolution — RECORD ONLY
    'device',         'Force1_Mod1', ...
    'sensitivity',    8.021, ...      % from AmpSettings when known, else NaN
    'physical_range', 200, ...        % from AmpSettings when known, else NaN
    'derived',        false );        % true => computed on read, not stored
```

**`bits` is record-only.** It documents the ADC's true resolution; samples remain `double`. No
integer packing in v2.0 — numerical results are byte-identical to today. The descriptor leaves
room to add a `storage` field later (e.g. `int32+scale`) without a version bump.

### Role vocabulary

`force_raw`, `force_sum` (derived), `tacho`, `position_actual`, `position_nominal`, `velocity`,
`spindle_power`, `spindle_torque`, `spindle_load`, `machine_cycle`, `time`, `voltage_raw`.
New roles may be added without a version bump; readers must ignore roles they don't recognise.

## Semantics

**Raw-only force storage.** v2.0 stores only raw corners `Fx1…Fz4`. The summed `Fx/Fy/Fz` are
reconstructed on read from `role='force_raw'` grouped by `axis` (the sum-dyno rule:
`Fx=Fx1+Fx2`, `Fy=Fy1+Fy2`, `Fz=Fz1+Fz2+Fz3+Fz4`). Summed axes are represented as `derived`
channels (`derived=true`), not stored. This removes the v0.1 redundancy and makes truncation
self-describing.

**Explicit per-stream time.** Each stream stores its own `time` vector, honest about jitter and
dropped samples in live capture. Streams that are uniform still store the vector (cheap relative to
the data matrix); `rate_hz` remains as the nominal rate.

**Cross-stream alignment.** `capture.time_sync_model` records how streams relate:
`'shared_origin'` (all `time` values on one clock, t=0 at the trigger — alignment is timestamp
matching) or `'sync_offsets'` (each stream has a local clock; `streams.<name>.t0_offset` relates
it to the master). Set at capture time; the reader applies offsets only in the second model.

**Completeness.** `capture.completeness` is a struct flagging any missing expected channels
(e.g. `Fz3`, `Fz4`, `tacho`). Derived quantities that depend on absent channels (full `Fz`, RPM)
are flagged underdetermined instead of computed silently.

## capture (metadata) block

Carries forward the 23 v1.0 FFA fields verbatim (`SampleName, OpType, Operation, OperationType,
TriggerTime, Rate, CutDiameter, SurfaceSpeed, MaxRPM, Notes, Feed, DepthOfCut, Insert, EdgeID,
Machine, Tool, New_Edge, Swarf, SwarfID, Coolant`, plus `Dyno`/`Stream1` retained for
back-reference), and adds:

- `schemaVersion = 2`
- `time_sync_model` — `'shared_origin' | 'sync_offsets'`
- `completeness` — struct of missing/derived flags
- `provenance` — for migrated files: `{from_layout, source_file, tool, when}`

`Rate` remains authoritative for the force `Fs` (the `AmpSettings` LabAmp `samplingRate` is a
device snapshot and can disagree — see force-file-standards §3.3).

## Reader integration (`process_force.m`)

Precedence, additive only — no legacy file re-parses differently:

```
if formatVersion >= 2  (or `streams` present)   -> v2.0 stream reader
elseif VariableNames present                    -> use it   (v1.0 / v0.9 / v0.1)
elseif `data`  (lowercase)                      -> v0.5
elseif `DATA`  (uppercase)                      -> v0.1
```

The v2.0 reader: resolve the `force` stream via the descriptor, sum raw corners by axis, resolve
the `tacho` stream for RPM (skip if absent), and expose `machine`/`aux` streams to callers that
want them. The existing v0.1/v0.5/v0.9/v1.0 branches stay exactly as fixed in the
VariableNames-first patch.

## Migration — all 262 captures to v2.0

Every migration is a **pure column remap into named streams**: no resampling, no arithmetic,
nothing discarded, source file opened read-only, output written chunked to a new v7.3 file.

| From | → `force` stream | → `tacho` stream | Notes |
|---|---|---|---|
| v1.0 (38) | `DATA(:,2:9)` | `DATA(:,10)` | time = `DATA(:,1)` |
| v0.5 (147) | `data(:,1:8)` | `data(:,9)` | time = `timestamps` |
| v0.1 (38) | `DATA(:,5:12)` | `DATA(:,13)` | drop pre-summed `DATA(:,2:4)`; time = `DATA(:,1)` |
| v0.9 (39) | `DATA(:,5:10)` partial | none | `completeness`: Fz3/Fz4/tacho absent; RPM underdetermined |

Counts per [`force_captures_inventory.csv`](../../force-archive-census/force_captures_inventory.csv); the 26 non-force
`.mat` (SRAS, ToF/cube, workspace dumps, tap tests) are excluded from migration. `AmpSettings`,
where present (41 files), is copied verbatim; pre-v1.0 files have none and that gap is permanent.

Migration writes new files and never mutates originals; the existing dedup/quarantine convention
(`_dedup_removed/`) applies to any superseded copies. Because ~86 captures are v6/v7 (no `matfile`
partial write), migration reads them in row chunks rather than whole.

## Components

1. **`docs/force-file-standards.md`** — extend with the v2.0 section (this schema as the standard).
2. **`scripts/matlab/read_force.m`** *(new)* — the single v2.0-aware loader; `process_force.m`
   delegates channel resolution to it. Returns `Fx/Fy/Fz/tacho/t` plus the stream/channel
   descriptors and completeness flags.
3. **`scripts/matlab/migrate_force_to_v2.m`** *(new)* — one-file migration with the layout mapping
   above; chunked, read-only source, verify-after-write (probe-row exact match), `provenance`
   stamped. Supersedes the interim `upgrade_force_v05_to_v10.m`.
4. **`scripts/matlab/crawl_force_structure.m`** — already emits the signature the migration keys
   on; add a `v2.0` recognised layout to `grade()`.
5. **FFA app (`ABetterFactoryPlusApp.mlapp`)** — separate follow-up: write v2.0 natively and
   re-enable the machine-controller capture into the `machine` stream. Out of scope for the
   first implementation plan (app lives in another repo); the read + migration side lands first.

## Testing

- **Migration round-trip:** for one file per source layout, assert the v2.0 `force`/`tacho`
  columns are byte-identical to the legacy reader's channels (extend `test_pick_channels.m`).
- **Reader parity:** `read_force` on a migrated v2.0 file yields `Fx/Fy/Fz/tacho` identical to
  `process_force` on its legacy original (probe rows, exact).
- **Truncated honesty:** a migrated v0.9 file reports `tacho` absent and RPM underdetermined,
  and does not fabricate a tacho column.
- **Partial-load proof:** reading one channel from a migrated multi-GB v7.3 file does not load the
  whole matrix (peak-memory check).
- **Descriptor validity:** every stored column has a channel descriptor; every `derived` channel
  is reconstructable from stored `force_raw` channels.

## Open questions / non-goals

- **Integer storage** (int+scale packing) is explicitly deferred; the descriptor reserves a
  `storage` field for it. Non-goal for v2.0.
- **FFA app native v2.0 writing** and finishing the machine-tool save are a separate plan.
- **DB / metadata value corrections** (wrong SampleName, feed/DoC disagreements) are a separate
  track — v2.0 is a structural standard; it does not decide which parameter values are correct.
