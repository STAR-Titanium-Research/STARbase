# FAST Sintering Data in Directus: A Separate System

> **Status: not built as written.** The FAST path in production predates this
> rewrite and kept a different shape — sintering runs are `manufacturing_operations`
> rows, which section 1 below says not to touch. The `sintering_*` collections and
> the `/sinter/series` endpoint were never created. Two principles did hold: the
> timeseries stay in files rather than Postgres rows, and the FAST dashboard shares
> no plotting code with machining force analysis.
>
> How the FAST data path was actually built:
>
> | Piece | Where |
> |---|---|
> | Runs — one `manufacturing_operations` row each, with typed `sintering_*` columns | `scripts/import_fast25.py` (from `ECS_Analysis.MDB`), `scripts/import_fast250.py` (from the export run list) |
> | Traces — a normalised CSV per run in the Directus File Library, catalogued in `fast_run_data` | `scripts/fast_orchestrator.py`, decoding FAST 25 `.HIS` with `scripts/fast_his.py` |
> | Recipes — `fast_recipes`, linked from each run | [FAST recipes design](./superpowers/specs/2026-07-22-fast-recipes-and-metadata-design.md) |
> | Sheet-only QA fields from the Excel logs | `scripts/clear_fast_logs.py`, `scripts/apply_fast_qa_backup.py` |
> | UI | the `d1-fast-dashboard` Directus module |

**Principle:** FAST 25 / FAST 250 are **sintering** operations. The existing Force Dashboard is for **machining** force analysis (Fx/Fy/Fz, FRM point clouds, octrees). They are unrelated workflows and must not be merged.

**This document specifies a standalone sintering path** — new Directus collections, a new endpoint, and a new dashboard — that touches **none** of the machining/FRM code.

---

## 1. What stays completely untouched

The following are **out of scope** and get **zero changes**:

| Component | Purpose | Leave alone |
|-----------|---------|-------------|
| `manufacturing_operations` | Machining operation definitions | ✅ untouched |
| `machining_force_analysis` | Force analysis metadata + `live_cache_file` | ✅ untouched |
| `d1-force-dashboard` plugin | Fx/Fy/Fz charts, FRM cloud, octree | ✅ untouched |
| `ForceChart.vue`, `FrmCloud.vue`, `FrmOctree.vue` | Machining visualisation | ✅ untouched |
| `/filter/run`, `/filter/fft` | Machining cache/FFT service | ✅ untouched |
| `.mat` → `live_cache.bin` pipeline | Machining timeseries | ✅ untouched |

No operation-type detection, no shared chart component, no branching inside the Force Dashboard. If a change would edit a file under `d1-force-dashboard/src`, it's the wrong change.

---

## 2. Architecture at a glance

```
MACHINING (existing — DO NOT TOUCH)        SINTERING (new — fully separate)
────────────────────────────────────       ─────────────────────────────────
manufacturing_operations                    sintering_runs         (metadata)
machining_force_analysis                    sintering_recipes      (metadata)
  live_cache_file (binary) ──┐              sintering_channels     (unit dictionary)
  /filter/run ───────────────┘                source CSV / .HIS file ──┐
Force Dashboard                               /sinter/series ───────────┘
  (Fx/Fy/Fz, FRM cloud, octree)             NEW Sintering Dashboard
                                              (pick channels, browse runs, compare)
```

Two dashboards, two endpoints, no shared plotting code.

---

## 3. Key decision: timeseries stay in files, not Postgres

The machining side already proves the right pattern: it does **not** store every 25.6 kHz sample in Postgres. It keeps a binary **`live_cache_file`** and serves it through `/filter/run`, which decimates on demand. Metadata lives in the DB; the signal lives in a file.

Sintering copies this **pattern** (not the plugin):

- **Directus DB:** run metadata + recipe metadata — the fields you browse/filter by.
- **Files:** the timeseries itself. FAST 250 CSVs already exist; FAST 25 `.HIS` is extracted to an equivalent per-run file.
- **Endpoint:** `/sinter/series` reads one run's file and returns the requested channel(s), decimated for the web.

**Why not one-row-per-sample in Postgres?** 9,735 FAST 25 runs × ~5,000 samples × 40 channels ≈ **1.9 billion rows (~100 GB)** — a pile of CSVs exploded into billions of rows only to be decimated straight back down for a chart. File-backed avoids this entirely and matches how machining already works.

---

## 4. New Directus collections (metadata only)

### `sintering_runs`
```sql
CREATE TABLE sintering_runs (
  id UUID PRIMARY KEY,
  machine VARCHAR(20),            -- 'FAST 25' | 'FAST 250'
  machine_id VARCHAR(50),         -- '8649 UOS' (250) or device code (25)
  run_number INTEGER,             -- run id / sequence
  start_datetime TIMESTAMP,
  end_datetime TIMESTAMP,
  duration_s INTEGER,

  recipe_id UUID REFERENCES sintering_recipes(id),

  -- denormalised summary for browsing/filtering (cheap, no timeseries)
  material VARCHAR(100),
  atmosphere VARCHAR(50),
  operator VARCHAR(100),
  max_temp_c NUMERIC,
  max_force_kn NUMERIC,
  notes TEXT,

  -- pointer to the timeseries FILE (not the data itself)
  series_file VARCHAR(255),       -- path/id of the CSV or cached .HIS
  series_format VARCHAR(20),      -- 'csv_fast250' | 'his_fast25'
  sample_count INTEGER,

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_sintering_runs_machine_date ON sintering_runs(machine, start_datetime);
CREATE INDEX idx_sintering_runs_recipe ON sintering_runs(recipe_id);
```

### `sintering_recipes`
```sql
CREATE TABLE sintering_recipes (
  id UUID PRIMARY KEY,
  name VARCHAR(255) UNIQUE,
  machine VARCHAR(20),
  material VARCHAR(100),
  temperature_c INTEGER,
  pressure_mpa INTEGER,
  hold_time_minutes INTEGER,
  heating_rate_c_per_min NUMERIC,
  file_path VARCHAR(255),         -- .RCP (250) or DB ref (25)
  description TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
```

### `sintering_channels` (unit dictionary — small, static)
```sql
CREATE TABLE sintering_channels (
  id UUID PRIMARY KEY,
  key VARCHAR(100) UNIQUE,        -- matches the CSV column header exactly
  display_name VARCHAR(100),      -- 'Pyro (top)'
  unit VARCHAR(50),               -- '°C' | 'kN' | 'mbar' | '%'
  group_name VARCHAR(50),         -- 'Temperature' | 'Pressure' | 'Force' | 'Power' | 'Gas' | 'Cooling'
  typical_min NUMERIC,
  typical_max NUMERIC
);
```
Seed once with the ~40 FAST channels (the column list is in
[FAST250_DATA_ARCHITECTURE.md](./FAST250_DATA_ARCHITECTURE.md)). Drives axis labels
and the channel picker — no per-run data here.

**Note:** there is **no** `sintering_measurements` table. Timeseries are files.

---

## 5. New endpoint: `/sinter/series`

Standalone service (mirrors what `/filter/run` does for machining, but independent code):

```
GET /sinter/series?run=<uuid>&channels=Pyro top [°C],AV pressing force [kN]&target=4000
```

```python
@app.get("/sinter/series")
def sinter_series(
    run: str,
    channels: str,
    target: int = 4000,
    start_s: float | None = None,
    end_s: float | None = None,
):
    r = db.get(SinteringRun, run)
    if not r:
        raise HTTPException(404)

    # read the run's FILE (not a billion DB rows)
    if r.series_format == "csv_fast250":
        df = read_fast250_csv(r.series_file)  # German-locale aware
    else:
        df = read_fast25_his(r.series_file)  # cached .HIS → columns

    wanted = [c.strip() for c in channels.split(",")]
    t = df["time_offset_seconds"].to_numpy()
    if start_s is not None:
        df = df[t >= start_s]
    if end_s is not None:
        df = df[t <= end_s]

    # decimate for the web (same idea as /filter/run's targetPoints)
    stride = max(1, len(df) // target)
    df = df.iloc[::stride]

    return {
        "t": df["time_offset_seconds"].tolist(),
        "series": {c: df[c].tolist() for c in wanted if c in df.columns},
        "units": {c: unit_for(c) for c in wanted},
        "points": len(df),
    }
```

Reads one file, returns decimated columns. No machining code involved.

---

## 6. New Sintering Dashboard (its own module)

A **separate** Directus module/panel — not a fork of the Force Dashboard. Different UX because the job is different (multi-channel process curves, not an FRM point cloud):

- **Run browser** — filter `sintering_runs` by machine / material / temperature / date.
- **Channel picker** — checkboxes over `sintering_channels`, grouped (Temperature / Pressure / Force / …). Pick any subset.
- **Chart** — one line per selected channel; channels sharing a unit share a Y-axis, others get a second axis. X = process time (s). Data from `/sinter/series`.
- **Segment shading** — colour the `Technol. Step` regions (Standby → Vacuum → Heating → Pressing → Cooling).
- **Run compare** — overlay the same channel across 2–3 runs.

Build it as a fresh Vue module. It may reuse generic pieces (a plain SVG line chart), but it does **not** import `ForceChart.vue`/`FrmCloud.vue` or share their assumptions.

---

## 7. Import (ETL) — populates metadata + stages files

Two importers converge on the same schema:

**FAST 250 (CSV):**
1. Walk `CSV/YYYY-MM/*.csv`; per file → one `sintering_runs` row (run id, times, recipe from header, summary stats).
2. Copy/register the CSV as `series_file` (`series_format='csv_fast250'`).
3. Ensure the run's recipe exists in `sintering_recipes` (parse from `PROGS/*.rcp` + filename).

**FAST 25 (MDB + .HIS):**
1. `ECS_Analysis.mdb::Versuch` → `sintering_runs`; `ECS_Prog.mdb::Rezept` → `sintering_recipes`.
2. Extract each `.EMD`'s `.HIS` to a per-run cached file → `series_file` (`series_format='his_fast25'`).

Parsing details live in the file-reading guides; nothing here writes samples into Postgres.

---

## 8. Checklist

**Schema**
- [ ] Create `sintering_runs`, `sintering_recipes`, `sintering_channels`
- [ ] Seed `sintering_channels` with the ~40 FAST channels (+ units, groups)
- [ ] Confirm **no** measurements table exists (timeseries are files)

**Import**
- [ ] FAST 250: CSV → runs + recipes + staged files
- [ ] FAST 25: MDB → runs + recipes; `.HIS` → staged files
- [ ] Spot-check 10 runs (times, summary stats, file resolves)

**Serve + view**
- [ ] Implement `/sinter/series` (file read + decimate)
- [ ] Build the standalone Sintering Dashboard (browser, channel picker, chart)
- [ ] Confirm the Force Dashboard is byte-for-byte unchanged

---

## 9. Notes

- **FAST 25 vs 250** differ only at import (MDB+`.HIS` vs manual CSV); they share the run/recipe/channel schema and the one dashboard.
- **Networked FAST 250 (future):** the file-backed model already fits a poll-and-stage helper — new exports just drop new `series_file`s and rows. No schema change needed.
- **Summary stats** (`max_temp_c`, `max_force_kn`) are computed once at import so the run browser filters without opening files.

---

## References

- [FAST25_DATA_ARCHITECTURE.md](./FAST25_DATA_ARCHITECTURE.md) — FAST 25 data spec
- [FAST250_DATA_ARCHITECTURE.md](./FAST250_DATA_ARCHITECTURE.md) — FAST 250 data spec + full channel list
- [FAST250_FILE_READING_GUIDE.md](./FAST250_FILE_READING_GUIDE.md) — CSV/RCP parsing code
