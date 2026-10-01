# Force Capture (`.mat`) File Standards

Machining force captures (FRM — Force/Rotation Maps) are MATLAB `.mat` files written by the
FFA capture app. **Four** distinct layouts exist in the archive — three version generations plus
a truncated variant — and two of them share the same column count, so they can only be told
apart by `VariableNames` (§4). This document is the authoritative description of all four, the
metadata schema, and the rules for migrating an old file to the current standard.

**Canonical implementations**

| Role | Location |
|---|---|
| Capture / write (source of truth) | `FFA-Fingerprint/Dev/3_Apps/ABetterFactoryPlusApp/ABetterFactoryPlusApp.mlapp` (outside this repo) |
| D1 read twin | [`scripts/matlab/process_force.m`](../scripts/matlab/process_force.m) (`LoadFile` mirror at lines 67–103) |
| Structure crawler | [`scripts/matlab/crawl_force_structure.m`](../scripts/matlab/crawl_force_structure.m) |

Reference file used to derive the v1.0 spec below:
`Z:\star_group1\Shared\Machining\FRM\11. LPC Trials (Dennis)\2. Data\Force\122-AA-MM-2025-6-5-F11-30MPM_0.1feed_0.1DoC.mat`
(11.8 GB, `DATA` 182,922,240 × 10).

---

## 1. Version detection

Version is **inferred from the data layout**, but an explicit `metadata.fileVersion` **overrides
the inference and selects the parser**:

```matlab
if     ismember('data', vars)   % lowercase -> inferred v0.5
elseif ismember('DATA', vars)   % uppercase -> inferred v0.1
end
if isfield(meta, 'fileVersion'); ver = double(meta.fileVersion); end   % this WINS
```

> **The migration trap.** Stamping `fileVersion = 1.0` onto a file whose matrix is still in the
> v0.5 layout makes both the FFA app and D1 apply the 10-column v1.0 column map to 9-column
> data. The result is silently wrong force channels — no error, no warning. `fileVersion` is a
> *declaration about the matrix*, not a metadata quality badge. See §6.

---

## 2. Data layouts

| | v0.1 | v0.5 | v1.0 (current) |
|---|---|---|---|
| Matrix variable | `DATA` (uppercase) | `data` (lowercase) | `DATA` (uppercase) |
| Time source | `DATA(:,1)` | separate `timestamps` variable | `DATA(:,1)` (in-matrix) |
| Force columns | `DATA(:,2:4)` — **already summed** Fx/Fy/Fz | `data(:,1:8)` — 8 raw dyno channels | `DATA(:,2:9)` — 8 raw dyno channels |
| Needs sum-dyno | no | yes | yes |
| Tacho column | `DATA(:,13)` | `data(:,9)` | `DATA(:,10)` |
| Min columns | 13 | 9 | 10 |
| `VariableNames` | **present (cell 1×13)** | absent | present (cell 1×10) |
| `AmpSettings` | absent | absent | present |

If the time vector is missing or its length disagrees with the force rows, `process_force.m`
falls back to a synthetic `t = (0:N-1)'/Fs`.

### v1.0 column map

Carried in the file itself as the `VariableNames` cell:

| Col | Name | Meaning |
|---:|---|---|
| 1 | `Time` | seconds |
| 2 | `Fx1` | dyno charge channel x1 |
| 3 | `Fx2` | dyno charge channel x2 |
| 4 | `Fy1` | dyno charge channel y1 |
| 5 | `Fy2` | dyno charge channel y2 |
| 6 | `Fz1` | dyno charge channel z1 |
| 7 | `Fz2` | dyno charge channel z2 |
| 8 | `Fz3` | dyno charge channel z3 |
| 9 | `Fz4` | dyno charge channel z4 |
| 10 | `Tacho (ai0)` | tacho pulse train (voltage, separate NI device) |

### v0.1 column map

Also carried in the file as a `VariableNames` cell (1×13). v0.1 stores the summed axes
**and** the 8 raw corner channels side by side:

| Col | Name | | Col | Name |
|---:|---|---|---:|---|
| 1 | `Time` | | 8 | `Fy2` |
| 2 | `Fx` (summed) | | 9 | `Fz1` |
| 3 | `Fy` (summed) | | 10 | `Fz2` |
| 4 | `Fz` (summed) | | 11 | `Fz3` |
| 5 | `Fx1` | | 12 | `Fz4` |
| 6 | `Fx2` | | 13 | `Tacho (ai0)` |
| 7 | `Fy1` | | | |

`process_force.m` reads the pre-summed `D(:,2:4)` and ignores columns 5–12 — but those raw
channels **are present**, which makes a v0.1 → v1.0 upgrade lossless (see §6).

### Sum-dyno

4-corner Kistler plate → 3 force axes ([`process_force.m:336-339`](../scripts/matlab/process_force.m#L336-L339)):

```
Fx = x1 + x2
Fy = y1 + y2
Fz = z1 + z2 + z3 + z4
```

Applies to v0.5 and v1.0. v0.1 files store the summed axes directly and must **not** be summed again.

---

## 3. Metadata schema

### 3.1 Legacy set (`FFA_metadataFields`, 16 fields)

`SampleName, OpType, TriggerTime, Rate, CutDiameter, SurfaceSpeed, MaxRPM, Notes, Feed,
DepthOfCut, Insert, Machine, Tool, New_Edge, Swarf, Coolant`

The app's `OverwriteMetadata` defaults any missing field to `''`. Older files may also carry
`MachineName` — the app still reads it, so **do not strip it**.

### 3.2 Current set (v1.0 — 23 top-level fields)

Observed on the reference file. Types are as written by the capture app.

| Field | Type | Example | Notes |
|---|---|---|---|
| `SampleName` | char | `122-AA-MM-2025-6-2` | see caveat in §7 |
| `OpType` | **string** | `"VC"` | inconsistent — every other text field is `char` |
| `Operation` | char | `Turning` | **new in v1.0** |
| `OperationType` | char | `Finishing` | **new in v1.0** |
| `TriggerTime` | char | `2025-11-20T14:24:47.192Z` | ISO-8601 UTC; older files may hold a `datetime` |
| `Rate` | double | `51200` | sample rate, Hz |
| `CutDiameter` | double | `565` | mm; frequently wrong, per-op override exists in D1 |
| `SurfaceSpeed` | double | `30` | m/min |
| `MaxRPM` | double | `500` | tacho fallback when pulse fit fails |
| `Notes` | char | `''` | |
| `Feed` | double | `0.1` | mm/rev |
| `DepthOfCut` | double | `0.1` | mm |
| `Insert` | char | `CNMG 12 04 08-SM H13A` | |
| `EdgeID` | char | `H13A-#4-fD` | **new in v1.0** |
| `Machine` | char | `C-62` | |
| `Tool` | char | `QS-PCLNL 2525-12C` | |
| `New_Edge` | logical | `true` | |
| `Swarf` | logical | `false` | |
| `SwarfID` | logical | `false` | **new in v1.0**; typed logical but named like an ID |
| `Coolant` | double | `0` | |
| `fileVersion` | double | `1` | selects the parser — see §1 |
| `Dyno` | struct | `.Devices` (cell), `.Gain` (double) | |
| `Stream1` | struct | `.Device`, `.DeviceIndex`, `.Channels`, `.MeasurementType`, `.RateLim`, `.VariableName` | tacho stream |

Reference `Dyno` / `Stream1` values: `Dyno.Devices = {'Force1_Mod1'}`, `Dyno.Gain = 1`;
`Stream1.DeviceIndex = 4`, `MeasurementType = 'Voltage'`, `RateLim = [0.1 800000]`,
`VariableName = 'Tacho'`.

### 3.3 `AmpSettings` (top-level variable, v1.0 only)

A verbatim export of the Kistler **5167A81 "STAR-LabAmp"** configuration — *not* authored by
the capture app, and SHA-256 signed, so it must be copied as an opaque blob, never synthesised.

```
AmpSettings.header.signature.{type,hash}
AmpSettings.header.data.{timeOfExport, serialNumber, type, deviceName,
                         softwareVersion, schemaMajor, schemaMinor, version}
AmpSettings.settings.signature.{type,hash}
AmpSettings.settings.data.daq.{samplingRate, fileFormat, includeHeader, ...}
AmpSettings.settings.data.measChannel.x1..x8.sensor.type.charge.{sensitivity, physicalRange, physicalUnit}
AmpSettings.settings.data.signalMonitor...
```

Reference channel calibration (`sensitivity`, pC/N, `physicalRange` 200 N, unit `N`):

| Channel | Name | Sensitivity |
|---|---|---|
| x1, x2 | x1, x2 | 8.128 |
| x3, x4 | y1, y2 | 4.123 |
| x5–x8 | z1–z4 | 8.021 |

**Known discrepancy:** `AmpSettings.settings.data.daq.samplingRate` reads `2.5e4` while
`metadata.Rate` is `51200`. The LabAmp block is a device-config snapshot and is not guaranteed
to describe the acquired stream. **`metadata.Rate` is authoritative for `Fs`**; treat the
LabAmp `samplingRate` as informational only.

---

## 4. Layout signatures — column count is NOT enough

> **The single most important rule in this document.** Two different layouts both have
> **10 columns and an uppercase `DATA`**. They are only distinguishable by `VariableNames`.
> Any migration, parser or validator that keys on the column count will silently corrupt one
> of them.

A full crawl of the archive (288 files, 2026-07-24) found exactly four distinct signatures:

| # files | Cols | `VariableNames` | Meaning |
|---:|---:|---|---|
| 173 | 9 | *(absent)* | **v0.5** — 8 raw dyno + tacho |
| 38 | 13 | `Time,Fx,Fy,Fz,Fx1,Fx2,Fy1,Fy2,Fz1,Fz2,Fz3,Fz4,Tacho (ai0)` | **v0.1** — summed + all 8 raw + tacho |
| 38 | 10 | `Time,Fx1,Fx2,Fy1,Fy2,Fz1,Fz2,Fz3,Fz4,Tacho (ai0)` | **v1.0** — the current standard |
| **39** | **10** | `Time,Fx,Fy,Fz,Fx1,Fx2,Fy1,Fy2,Fz1,Fz2` | **v0.9 "truncated"** — see below |

### The v0.9 truncated variant (39 files)

This is the **v0.1 13-column layout cut off at column 10**. It is missing `Fz3`, `Fz4` and —
critically — **`Tacho`**. Consequences:

- **No tacho ⇒ no RPM ⇒ no FRM map is possible** for these captures. `process_force.m` falls
  back to a constant `MaxRPM`, which produces a plausible-looking but meaningless angular map.
- `Fz` is only recoverable from the **pre-summed column 4**; corners `Fz3`/`Fz4` are gone, so
  `Fz1+Fz2` is *not* the full Fz.
- It cannot be upgraded to v1.0. It should be tagged as a distinct, terminal format.

Because its column count is 10, it is **indistinguishable from v1.0 by count alone** — hence the
rule at the top of this section.

---

## 5. Conformance levels

| Level | Meaning |
|---|---|
| **A — current** | v1.0 signature, `fileVersion = 1`, all 23 metadata fields, `VariableNames` + `AmpSettings` |
| **B — current layout, thin metadata** | v1.0 signature but missing v1.0-only fields (`Operation`, `OperationType`, `EdgeID`, `SwarfID`) and/or `AmpSettings` |
| **C — legacy layout, has metadata** | v0.5 / v0.1 signature with a usable `metadata` struct |
| **D — legacy, no metadata** | no `metadata` variable (e.g. the `_raw` files) |
| **V — truncated (v0.9)** | the 10-col no-tacho signature; terminal format, not upgradeable |
| **X — inconsistent** | declared version contradicts the actual signature → **mis-parsed today** |
| **N — not a force capture** | no recognisable force layout (`Disc_B2.mat`, `ExtractedGrains.mat`) |

### X, in detail — the 22 files that matter most

**22 real machining captures declare `fileVersion = 1` while carrying the v0.9 signature.**
Samples 97, 99, 102, 112, 114 (Oct–Dec 2024). Because `fileVersion` overrides layout inference
(§1), `process_force.m` takes the v1.0 branch and computes:

```matlab
forces = sumdyno(D(:, 2:9));   % D(:,2:9) is actually [Fx Fy Fz Fx1 Fx2 Fy1 Fy2 Fz1]
tacho  = D(:, 10);             % actually Fz2 -- a force channel, not a tacho
```

which yields

| Output | Actually computed | Correct? |
|---|---|---|
| `Fx` | `Fx + Fy` | no |
| `Fy` | `Fz + Fx1` | no |
| `Fz` | `Fx2 + Fy1 + Fy2 + Fz1` | no |
| `RPM` | tacho-fit over `Fz2` | no |

**Every force channel and the RPM are wrong, silently, with no error raised.** These files
currently grade as "A/B — current" on metadata completeness, which is exactly why the check must
be on the signature, not the field list. This is the highest-priority remediation group.

---

### Archive census — 2026-07-24

Full crawl of `Z:\star_group1\Shared\Machining\FRM`, 288 `.mat` files, 225 GB.
Inventory: [`force_structure_inventory.csv`](force-archive-census/force_structure_inventory.csv).

| Grade | Files | % | Action |
|---|---:|---:|---|
| C — legacy layout, has metadata | 182 | 63% | bulk metadata enrichment; v0.1 (38) upgradeable to v1.0, v0.5 (144) needs matrix restructure |
| A — current | 37 | 13% | none |
| N — not a force capture | 26 | 9% | exclude from the migration entirely |
| **X — declares v1.0, wrong columns** | **22** | **8%** | **highest priority — silently mis-parsed today** |
| V — truncated (no tacho) | 17 | 6% | tag as terminal; no FRM possible |
| D — legacy, no metadata | 3 | 1% | metadata from filename only |
| X — inconsistent (other) | 1 | 0% | `101-AA-MF-2024-11-1-F1`: correct v1.0 columns, just missing the `fileVersion` stamp |

MAT format split: **202 v7.3** / **86 v6/v7**. Only the v7.3 files support `matfile` partial
writes; the 86 v6/v7 files must be fully rewritten to change anything, which for multi-GB
captures is the dominant cost of the migration.

**One corrupt file:** `122-AA-MM-2025-6-5-F1-30MPM_0.1feed_0.1DoC.mat` (5.8 GB, v7.3) reports
**zero readable variables** — MATLAB raises "Unable to read some of the variables due to unknown
MAT-file error". Its `_raw` sibling (5.7 GB, `data` + `timestamps`) is intact, so the capture is
recoverable by re-deriving the processed file from the raw one.

---

## 6. Migration rules

**Safe (already done for `SampleName`):** correcting the *value* of a field that already exists.
Use a partial write so the multi-GB matrix is never rewritten:

```matlab
mf = matfile(path, 'Writable', true);
m = mf.metadata;  m.SampleName = '...';  mf.metadata = m;   % touches only `metadata`
```

Requires a **v7.3** file for a true partial write; on a v7 file MATLAB rewrites the whole file.
Check the format before writing (the crawler records it).

**Safe:** *adding* metadata fields (`Operation`, `OperationType`, `EdgeID`, `SwarfID`, `Notes`)
to a file whose `fileVersion` you leave alone. Readers key off `isfield`, so extra fields are inert.

**Unsafe — requires restructuring the matrix in the same operation:**

- setting or changing `fileVersion`
- upgrading a v0.5 or v0.1 file to the v1.0 layout

A genuine v0.5 → v1.0 upgrade must, atomically:

1. rebuild the matrix as `[t, x1, x2, y1, y2, z1, z2, z3, z4, tacho]` — i.e. prepend `timestamps`
   as column 1 and drop the separate `timestamps` variable;
2. write `VariableNames`;
3. only then set `metadata.fileVersion = 1`.

A v0.1 → v1.0 upgrade **is lossless** — v0.1 carries the 8 raw corner channels in columns 5–12
alongside the pre-summed axes, so the target matrix is a pure column selection:

```matlab
DATA_v10 = DATA_v01(:, [1 5 6 7 8 9 10 11 12 13]);   % Time, Fx1..Fz4, Tacho
```

Verify against the file's own `VariableNames` rather than assuming the index list — it is present
on v0.1 files and is the authoritative column map. The summed columns 2–4 are then discarded
(they are recomputable via sum-dyno).

**Permanent gaps.** Pre-v1.0 files have no `AmpSettings` — the amplifier calibration for those
captures was never recorded and cannot be reconstructed. Accepted.

---

## 7. Data-quality caveats

- **`metadata.SampleName` is often stale**, carried over from a previous capture. Even the
  reference file shows this: `SampleName = 122-AA-MM-2025-6-**2**` against a filename of
  `122-AA-MM-2025-6-**5**`. The **filename** (`{sample_code}-F{n}`) is the more reliable key;
  cross-check against `physical_samples.sample_code`.
- An operation's identity is **sample code + operation count `F#`** — not a date. Dates inside
  filenames and `pass_code`s are frequently wrong (operator dates, zero-pad drift).
- `CutDiameter` is frequently wrong; D1 carries a per-operation `outer_diam` override
  ([`process_force.m:87`](../scripts/matlab/process_force.m#L87)).
- `OpType` being `string` where siblings are `char` breaks naive `strcmp`/`ischar` guards.

---

## 8. Related

- Memory: `mat-metadata-migration`, `mat-operation-linking`
- [`docs/data-dictionary.md`](data-dictionary.md)
