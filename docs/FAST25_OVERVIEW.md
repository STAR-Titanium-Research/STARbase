# FAST Machine Data Integration Documentation

Complete specifications for FAST 25 and FAST 250 sintering apparatus data architecture and import strategy.

---

## 📋 Documentation Index

### FAST 25 (Database-Backed)

1. **[FAST25_DATA_ARCHITECTURE.md](./FAST25_DATA_ARCHITECTURE.md)** — Complete data model
   - Run history database (9,735 experiments)
   - Recipe master database (4,995 definitions)
   - Measurement archives (10,193 timeseries files)
   - QA/compliance logs (1,888 Excel records)
   - System configuration databases
   - Cross-source validation examples
   - PostgreSQL/Directus schema

2. **[FAST25_FILE_READING_GUIDE.md](./FAST25_FILE_READING_GUIDE.md)** — Implementation guide
   - Code examples for each file type
   - Library recommendations (access-parser, pandas, numpy, etc.)
   - Security best practices (defusedxml for XML)
   - Performance benchmarks
   - Complete import example
   - Troubleshooting guide

3. **Supporting databases** (not yet written up) — Additional context
   - Instrument definitions (246 MB MDB)
   - System configuration (alarms, parameters, measurement points)
   - Schema and export formats
   - Monitoring logs and diagnostics
   - Import priority (Phase 1/2/3)

4. **QA logs** (not yet written up) — Compliance and quality tracking
   - Excel log structure (1,888 entries across 2022-2026)
   - Why they're separate from run database
   - Link strategy (Recipe # + Date/Time)
   - Use cases and compliance requirements

### FAST 250 (Manual Export Format)

5. **[FAST250_DATA_ARCHITECTURE.md](./FAST250_DATA_ARCHITECTURE.md)** — CSV + RCP data model
   - Run timeseries CSV files (331 runs, 2020-2026)
   - German locale numeric format handling
   - Recipe definitions (.RCP files, 100+ recipes)
   - Material/temperature/pressure extraction
   - PostgreSQL/Directus schema
   - Monthly directory structure

6. **[FAST250_FILE_READING_GUIDE.md](./FAST250_FILE_READING_GUIDE.md)** — Parsing CSV and RCP
   - Pandas CSV import with German decimal separator
   - Recipe file parsing and metadata extraction
   - Complete multi-file import example
   - Performance benchmarks (~10-15 min for 331 runs)
   - Troubleshooting (encoding, locale, memory)

### Directus Integration

7. **[FAST_DIRECTUS_INTEGRATION.md](./FAST_DIRECTUS_INTEGRATION.md)** — a proposed separate
   sintering schema, endpoint and dashboard. **Not built as written** — see its status note
   and *How the FAST data path was actually built* below.

How the FAST data path was actually built:

| Piece | Where |
|---|---|
| Runs — one `manufacturing_operations` row each, with typed `sintering_*` columns | `scripts/import_fast25.py` (from `ECS_Analysis.MDB`), `scripts/import_fast250.py` (from the export run list) |
| Traces — a normalised CSV per run in the Directus File Library, catalogued in `fast_run_data` | `scripts/fast_orchestrator.py`, decoding FAST 25 `.HIS` with `scripts/fast_his.py` |
| Recipes — `fast_recipes`, linked from each run | [FAST recipes design](./superpowers/specs/2026-07-22-fast-recipes-and-metadata-design.md) |
| Sheet-only QA fields from the Excel logs | `scripts/clear_fast_logs.py`, `scripts/apply_fast_qa_backup.py` |
| UI | the `d1-fast-dashboard` Directus module |

---

## 🎯 Quick Start

### For FAST 25 (Database Backend)

1. Read **FAST25_DATA_ARCHITECTURE.md** (10 min)
   - Understand the three core data sources
   - Review cross-source validation example
   - Check PostgreSQL schema

2. Read **FAST25_FILE_READING_GUIDE.md** (15 min)
   - See code examples for parsing each format
   - Copy-paste the complete import example
   - Benchmark: ~2 hours for full import

3. Implement Phase 1 importer
   - ECS_Analysis.mdb (9,735 runs)
   - ECS_Prog.mdb (4,995 recipes)
   - EMD archives (.HIS timeseries, .ERG events)
   - Excel QA logs

### For FAST 250 (Manual Exports)

1. Read **FAST250_DATA_ARCHITECTURE.md** (10 min)
   - Understand CSV + RCP file structure
   - German locale decimal handling
   - PostgreSQL schema

2. Read **FAST250_FILE_READING_GUIDE.md** (10 min)
   - See pandas CSV import with German decimals
   - See recipe file parsing
   - Copy-paste the complete import example
   - Benchmark: ~10-15 minutes for 331 runs

3. Implement importer
   - Parse PROGS/*.rcp (100+ recipes)
   - Parse CSV/YYYY-MM/*.csv (331 runs)
   - Link runs to recipes
   - Store in PostgreSQL/Directus

### For Plotting / Data Visualization

1. Focus on **FAST25_FILE_READING_GUIDE.md** section 4 (.HIS timeseries)
   - Numpy example for reading measurement data
   - Matplotlib integration

2. Add context from the supporting databases (see above; not yet written up)
   - Measurement point definitions (units, ranges)
   - Alarm thresholds
   - Sensor calibration data

### For System Administration

1. Read **FAST25_DATA_ARCHITECTURE.md** sections 1-3
   - File locations and sizes
   - Update strategy (UpdateCounter polling)
   - Backup/retention recommendations

2. Review the supporting databases (see above; not yet written up)
   - Where to find configuration databases
   - ECS_Instruments.MDB location and size

---

## 📊 Data Overview

### FAST 25 (Database Backend)

| Source | Record Type | Count | Size | Period |
|--------|-------------|-------|------|--------|
| ECS_Analysis.mdb | Runs (Versuch) | 9,735 | 6.4 MB | 2010-2026 |
| ECS_Prog.mdb | Recipes (Rezept) | 4,995 | 13 MB | 2011-2026 |
| EMD Archives | Measurement files | 10,193 | 1.1 GB | 2010-2026 |
| Excel QA Logs | Compliance entries | 1,888 | <1 MB | 2022-2026 only |
| ECS_CONFIG.mdb | System config | Various | 0.8 MB | Live |
| ECS_Instruments.mdb | Sensor definitions | Various | 246 MB | Live |

**Total:** ~1.4 GB of structured data spanning 16 years

### FAST 250 (Manual Exports)

| Source | Record Type | Count | Size | Period |
|--------|-------------|-------|------|--------|
| CSV Files | Run timeseries | 331 | ~500 MB | 2020-2026 |
| RCP Files | Recipes | 100+ | ~250 KB | 2020-2026 |
| Export Files | Summary snapshots | 2 | <1 MB | 2026-07 |

**Total:** ~500 MB of timeseries data spanning 6 years (sparse, gaps in months)

### Data Relationships

```
Recipes (4,995)
    ↓ via ProgrammNr
Runs (9,735)
    ├→ EMD Archives (10,193 .HIS/.ERG files)
    └→ QA Logs (1,888 Excel entries, ~50% coverage)
         ↓ join via Recipe # + Date/Time
    
Configuration (Alarms, Parameters, Instruments)
    ↓ provides context
Everything (for plotting, validation, compliance)
```

---

## 🔄 Import Strategy

### Phase 1: Core (Essential)

**Time:** ~2 hours  
**Tools:** Python + access-parser + pandas + numpy

```python
# 1. Load databases
ECS_Analysis.mdb::Versuch           # 9,735 runs
ECS_Prog.mdb::Rezept                # 4,995 recipes

# 2. Extract EMD archives
EMD files (.HIS timeseries, .ERG event logs)

# 3. Import Excel QA logs
FCT HP D 25 log sheet [2022-2026].xlsx
```

### Phase 2: Context (Recommended)

**Time:** ~30 minutes  
**Value:** Enables plotting with proper units/ranges

```python
# 1. Load system configuration
ECS_CONFIG.mdb::Alarm               # 501 alarm definitions
ECS_CONFIG.mdb::Messwerte           # 250 measurement points (units, ranges)
ECS_CONFIG.mdb::Parameter           # 400 system parameters

# 2. Load instrument definitions
ECS_Instruments.mdb::ECS_InstrDefinition    # 17 sensor types
ECS_Instruments.mdb::ECS_NameSpaces         # 137K OPC point names
```

### Phase 3: Diagnostics (Optional)

**Time:** Variable  
**Value:** Historical troubleshooting

```python
# 1. Import monitoring logs
ECS2000/Monitoring/*/

# 2. Parse schema files
System/Schemata/*.xslt              # CSV export templates
System/Schemata/*.xsd               # Schema definitions
```

---

## 🛠️ Implementation Checklist

> The original import plan, kept for reference; its boxes were never tracked. What was
> built is summarised under *Directus Integration* above.

### Setup (All Machines)
- [ ] Install Python libraries: `access-parser`, `pandas`, `openpyxl`, `numpy`, `defusedxml`
- [ ] Create PostgreSQL/Directus database
- [ ] Set up git repository for importer code

### FAST 25: Phase 1 (Core Import)
- [ ] Parse ECS_Analysis.mdb → load Versuch table (9,735 rows)
- [ ] Parse ECS_Prog.mdb → load Rezept table (4,995 rows)
- [ ] Extract EMD archives → parse .HIS (timeseries) and .ERG (events)
- [ ] Load Excel QA logs (1,888 rows across 5 years)
- [ ] Create Runs, Recipes, QA_Logs, Events, Measurements tables
- [ ] Link QA logs to runs via Recipe # + Date/Time
- [ ] Validate data integrity (cross-source examples in FAST25_DATA_ARCHITECTURE.md)

### FAST 25: Phase 2 (Context Data)
- [ ] Load ECS_CONFIG.mdb (Alarms, Messwerte, Parameters)
- [ ] Load ECS_Instruments.mdb (sensor definitions)
- [ ] Create Alarms, MeasurementPoints, Sensors, Parameters tables
- [ ] Link to Runs via foreign keys

### FAST 250: Core Import
- [ ] Parse PROGS/*.rcp files (100+ recipes)
- [ ] Parse CSV/YYYY-MM/*.csv files (331 runs)
- [ ] Handle German locale (comma decimal separator)
- [ ] Create Runs, Recipes, Measurements tables
- [ ] Link runs to recipes via CSV header
- [ ] Validate timestamp continuity

### Shared: Visualization
- [ ] Build plotting templates using timeseries data
- [ ] Create run explorer/dashboard
- [ ] Add material/temperature filtering
- [ ] Create run comparison views

### Shared: Deployment
- [ ] Test data integrity
- [ ] Implement error handling and logging
- [ ] Document API endpoints for dashboard
- [ ] Set up periodic sync (if applicable)

---

## 📁 File Locations (Relative to Data Dump Root)

```
FAST Machines Data/
│
├── FAST 25/
│   └── ECS2000/
│       ├── Data/
│       │   ├── ECS_Analysis.MDB              ← Run history (9,735 runs)
│       │   ├── Batch/                        ← EMD archives (10,193 files)
│       │   │   ├── 2010/12/V01_6201_*.EMD
│       │   │   └── ... (organized by date)
│       │   └── [monitoring logs]
│       │
│       ├── Recipes/1001/
│       │   ├── ECS_Prog.mdb                  ← Recipe definitions (4,995)
│       │   └── R_HPD 25_*.REZ                ← Recipe archives (21+)
│       │
│       └── System/Database/
│           ├── ECS_CONFIG.MDB                ← System config (0.8 MB)
│           └── ECS_Instruments.MDB           ← Sensors (246 MB)
│
├── FAST 250/
│   ├── CSV/                                  ← Timeseries data (331 files)
│   │   ├── 2020-02/
│   │   ├── 2020-03/
│   │   └── ... through 2026-07/
│   │       ├── 328_07-07-2026_133852.csv    ← Run #328 (1M+ rows)
│   │       └── [2-5 MB per file]
│   │
│   └── PROGS/                                ← Recipe definitions (100+)
│       ├── AT_D250_Ti-6-4_1100C_35MPa.rcp
│       ├── D105_IN718_Briq_1075_35MPa.rcp
│       └── [~2.5 KB per file]
│
└── Logs/ (FAST 25 only, separate from machine data)
    ├── FCT HP D 25 log sheet 2022.xlsx
    └── FCT HP D 25 log sheet 2026.xlsx  (1,888 entries total)
```

---

## ⚠️ Security & Best Practices

### XML Parsing
Always use `defusedxml` (protects against XXE attacks):
```python
from defusedxml import ElementTree as ET

tree = ET.parse("schema.xsd")
```

### Binary Parsing
Verify structure before interpreting as floats:
```python
import struct

# Verify header: 01 00 23 00
value = struct.unpack("<f", data[4:8])[0]  # '<' = little-endian
```

### Database Security
- Use connection pooling for high-throughput imports
- Validate all external input (Excel files, JSON, etc.)
- Encrypt credentials (connection strings in .env)

---

## 📞 Support

### Common Issues

**Q: "access-parser not found"**  
A: Install with `pip install access-parser`

**Q: EMD files are "corrupt"**  
A: They're valid ZIP files. Python's `zipfile` module reads them fine.

**Q: .HIS floats look wrong**  
A: Verify endianness with `struct.unpack('<f', ...)` (little-endian)

**Q: How do I incrementally sync new runs?**  
A: Check `Refresh.UpdateCounter` in ECS_Analysis.mdb; fetch new runs when it changes.

---

## 📚 References

### FAST 25
- **Master Specification:** FAST25_DATA_ARCHITECTURE.md
- **Code Examples:** FAST25_FILE_READING_GUIDE.md
- **Context Databases / QA Strategy:** described in this document; no separate write-up yet

### FAST 250
- **Master Specification:** FAST250_DATA_ARCHITECTURE.md
- **Code Examples:** FAST250_FILE_READING_GUIDE.md

---

## 🔗 Related Documents

- [../system_requirements_specification.md](../system_requirements_specification.md) — Overall D1 Database SRS
