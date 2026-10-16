# SEM data-bar reader and provenance-owned files: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recognise FEI/Thermo SEM images, read their imaging settings (TIFF metadata, else cell-split OCR of the data bar), save them per image when a person links it, and make files visible and linkable only to their provenance owner.

**Architecture:** Crawler (`scripts/inbox_crawler/`) gets a `FeiProfile` with positive and negative evidence, a metadata reader, an OCR bar reader, owner stamping, `--reclassify` and `--sem-backfill`. One migration set adds the owner columns, a back-fill, `d1_private.sem_image_settings` and one SQL function that is the only place `extracted` becomes settings. The `d1-inbox` extension calls that function in the link transaction. STARbase shows settings and locked files.

**Tech Stack:** Python 3.12 (Pillow, psycopg2, optional rapidocr-onnxruntime), PostgreSQL 16 + dbmate, Directus 11 endpoint extension (plain ESM), Vue (STARbase pages), pytest, node `--test`.

**Spec:** [`docs/superpowers/specs/2026-10-16-sem-data-bar-reader-design.md`](../specs/2026-10-16-sem-data-bar-reader-design.md) (decisions D1 to D13; section numbers below refer to it). ADR: [0022](../../adr/0022-files-belong-to-their-provenance-owner.md). Read `.claude/skills/inbox-crawler-conventions/SKILL.md` before any crawler task and the `db-migration` skill before any migration.

## Global Constraints

- **Read-only crawler.** `fs_readonly.py` is the only module that touches the share; the reader modules take an in-memory `PIL.Image`, never a path or handle, and open nothing, write nothing, spawn nothing, call no network. `tests/scripts/test_inbox_crawler_readonly.py` must pass (extend its import allow-list for new modules only).
- **No research image is ever committed.** Fixtures are synthetic images and metadata text (values only). Real bars are checked on d1-server and in the physical-test backlog.
- **Decoded formats and limit:** TIFF, JPEG, PNG, BMP only; `MAX_PIXELS = 50_000_000` (unchanged).
- **Claim rule (D1):** `kind='sem_image'` needs `SEM_MIN_CONFIDENCE = 0.6` reached with positive evidence: FEI metadata (tag 34682 with `[System] Type=SEM` and a `[PrivateFei]` section: 0.9, or 0.95 with a bar structure), the JEOL text the JEOL profile already finds, or a recognised bar structure with at least two header labels read by OCR (0.8). A bar-shaped strip alone never reaches 0.6. TIFF tag 272 matching `Microscope x<N>` (case-insensitive), or tag 271/272 containing `DirectShow`, is a negative signal that caps confidence at 0.55.
- **Thresholds are relative, never absolute:** contrast-edited exports (about 32 of 37 real PNGs) lower the white dividers from 255 to about 207. A bar top is a row whose mean is above 150 and at least 2.5 times the mean of the row two below; a divider column has more than 90% of the bar's body rows brighter than 0.4 times the bar's maximum. The bar's vertical position is fixed (the bottom 59 to 60 of 943 rows, 119 of 1887) but its columns are not (16 layouts in 120 bars): find cells from dividers.
- **Keys:** numeric, unit in the key, absent when unknown, never null: `kv`, `spot`, `working_distance_mm`, `magnification`, `hfw_um`, `pixel_size_nm`, `scale_bar_um`, `detector`, `mode`, `instrument`, `acquired_at` (ISO 8601 with offset), plus `sources` and `flags` objects and, for OCR-read fields, `ocr_confidence` (ruling R10). Source values: `metadata`, `derived`, `ocr`, `manual`.
- **Ranges (omit with a flag when outside):** `kv` 0.1 to 30, `working_distance_mm` 0.1 to 50, `magnification` 5 to 1,000,000, `spot` 1 to 10. OCR confidence is recorded as `extracted.ocr_confidence` (ruling R10: a field-to-confidence map; `sources` holds only source names), never a threshold.
- **Cross-checks:** `magnification x hfw` (metres) equals 0.2984 or 0.2984 x 0.858 within 2%; the scale-bar label against the bar's pixel length within 5%. A value that cannot be cross-checked gets `flags.check_this = true`.
- **Time:** instrument clock is `Europe/London`; stored as `timestamptz`; the repeated autumn hour takes the first occurrence (`fold=0`); a local time that does not exist (the skipped spring hour) is omitted with `flags.acquired_at = "invalid_local_time"`.
- **OCR is opt-in:** `INBOX_OCR=1`; `INBOX_OCR_DEVICE=auto|cpu|cuda`, default CPU; pins exact versions; every new compose variable has an uncommented `VAR=` line in `.env.example`.
- **Ownership:** `owner_person_id` / `owner_team_id` on `directus_files`, at most one set, `ON DELETE RESTRICT`; protected from members by Directus field lists (the pattern of `people.uni_alias` in migration 193, not a Postgres trigger: Directus uses one database role for everyone); linked files stay unowned; the crawler never overwrites an existing stamp.
- **Inbox contract:** the list and `FoundFile` shape and the existing golden fixtures in `tests/fixtures/d1-inbox/` do not change; only new fixtures are added.
- **Process:** `ruff` 0.6.9 (pre-commit pins it); commit trailer lines `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01EBVFR8T4DyCcZ3JQC8QvuD`; workers commit after every step and never push, merge or rebase.

## Review Focus

Inputs the spec implies but no happy-path test would exercise, most likely first. Each has a test in the task that owns the code.

1. **A dark-strip image that is not an SEM** (optical micrograph "Microscope x20", thermal camera JPEG, EDS map with a legend bar) must stay `image`. Test: Task A2 `test_optical_microscope_tiff_stays_image`, `test_bar_only_is_image_even_with_divider_rows`.
2. **A blurred or compressed bar** (JPEG) must give no value rather than a wrong one: a misread magnification fails the `mag x hfw` or scale-bar check and is omitted. Test: Task B1 `test_blurred_magnification_is_omitted_not_guessed`.
3. **A person corrects a value, then a re-read runs** (back-fill, a second link). The manual value survives. Test: Task C2 `sem_settings: manual field survives a re-save`; Task E3 `test_backfill_keeps_manual_fields`.
4. **A file linked to two records, then one link is undone.** The settings row stays while any link remains. Test: Task D1 `undo keeps settings while another link of the file remains`.
5. **Pathological metadata:** `HV=0`, `HFW=0` (division by zero), a 20,000-character tag that is not INI text, a `Date` that is not a date. No exception; the field is omitted with a flag; the image is not claimed from garbage. Test: Task A1 `test_zero_hfw_omits_magnification`, `test_garbage_tag_is_not_a_claim`.

## Status

One row per stream. Update when a stream starts, finishes, is reviewed or is merged; commit with the next code push (CI minutes are paid).

| Stream | Area | Agent profile | Worktree id | Branch | Depends on | State |
|---|---|---|---|---|---|---|
| A | Detector, metadata tier, JEOL demotion | `inbox-crawler-implementer` | `sem-a` | `feat/sem-reader-a-detect` | none | merged into the integration branch |
| B | Cell-split OCR tier, packaging | `inbox-crawler-implementer` | `sem-b` | `feat/sem-reader-b-ocr` | A | merged into the integration branch |
| C | Migrations: owner columns, settings table and function, permissions | `d1-server-implementer` | `sem-c` | `feat/sem-reader-c-db` | none | merged into the integration branch |
| D | `d1-inbox` endpoint | `d1-server-implementer` | `sem-d` | `feat/sem-reader-d-endpoint` | C | merged into the integration branch |
| E | Crawler: stamping, `--reclassify`, `--sem-backfill` | `inbox-crawler-implementer` | `sem-e` | `feat/sem-reader-e-crawler` | A, B, C | merged into the integration branch |
| F | STARbase pages | `directus-ui-implementer` | `sem-f` | `feat/sem-reader-f-ui` | D | merged into the integration branch |

All six streams merged into the integration branch and reviewed. The whole-branch review's fix wave (C1, I1-I5, M1-M3) and the `/simplify` cleanup are merged too; a scoped re-review of the fix wave is the last gate before PR #341 merges.

**Coordinator duties (this session, not a worker):** run A and C first (parallel, Sonnet, high effort); review each stream branch before merging it into the integration branch `claude/gracious-heisenberg-x7to0t`; **before D starts, message session `session_01YGVh6kfgvqZMHaVmHn39dw` (the inbox-crawler chat asked to be told before `core/extensions/d1-inbox` or `inboxContract` change)**; open one PR per stream (or one for the whole branch when small) when ready, not per commit. Build order from the spec (section 10): A (+ `--reclassify` from E) first because the detector is the live bug.

## File structure

| File | Responsibility | Stream |
|---|---|---|
| `scripts/inbox_crawler/sem_meta.py` (new) | FEI metadata to values; UK time parsing | A |
| `scripts/inbox_crawler/classify_sem.py` | profiles, evidence rules, `FeiProfile`, `CLASSIFIER_VERSION` | A, B |
| `scripts/inbox_crawler/kinds.py` | `Classification.classified_by` | A |
| `scripts/inbox_crawler/sem_bar.py` (new) | cell cutting, recogniser bridge, bar parsing and checks | B |
| `scripts/inbox_crawler/db.py`, `scan.py`, `__main__.py`, `daemon.py` | stamping, `--reclassify`, `--sem-backfill`, bar reader wiring | B, E |
| `db/migrations/20261016*_*.sql` (new, numbers taken at build time; 195 is the latest today) | owner columns and back-fill; settings table, log, function, `classified_by`; Directus permission rows | C |
| `scripts/access_rules.json`, `scripts/gen_access_rules.py` | the `directus_files` read filter and owner field lists | C |
| `core/extensions/d1-inbox/index.js` | link, accept-all, undo, two routes, admin read-only | D |
| `packages/starbase-pages/src/inbox/*`, record-page file lists | settings display, locked file | F |
| `docker-compose.yml`, `Makefile`, `.env.example`, `docs/runbooks/inbox-crawler.md` | OCR packaging and variables | B |
| `docs/runbooks/physical-test-backlog.md`, `docs/data-dictionary.md` | backlog SEM1 to SEM7, new tables and columns | each stream, in its last task |

---

## Stream A: detector and metadata tier (`inbox-crawler-implementer`)

### Task A1: FEI metadata reader and UK time

**Files:**
- Create: `scripts/inbox_crawler/sem_meta.py`
- Test: `tests/scripts/test_inbox_crawler_sem_meta.py`

**Interfaces:**
- Produces: `parse_london_time(text: str) -> datetime | None` (accepts `DD.MM.YYYY HH:MM:SS`, the `[PrivateFei] TimeOfCreation` format); `fei_metadata(img) -> dict | None` returning the Global-Constraints keys plus `bar_height_px: int` when `DatabarHeight` exists, with `sources` (every key `metadata`, `magnification` `derived`) and `flags`; `None` when tag 34682 is absent, not text, longer than 20,000 characters, unparseable, or lacks `[System] Type=SEM` and `[PrivateFei]`.

- [ ] **Step 1: Write the failing tests.** Fixture `FEI_TEXT` is an INI string with the values (not the images) of Isaac_004: `[System] Type=SEM`, `SystemType=Inspect F`, `Dnumber=9923499`; `[Beam] HV=2000`, `Spot=3.5`; `[EBeam] HFW=0.00745157`, `WD=0.0159235`; `[Scan] PixelWidth=7.27692e-006`; `[Image] ScreenMagCanvasRealWidth=0.29840`; `[Detectors] Name=ETD`, `Mode=SE`; `[PrivateFei] DatabarHeight=59`, `TimeOfCreation=07.08.2025 14:59:45`. Build the image with a helper that writes the text into tag 34682 (`TiffImagePlugin.ImageFileDirectory_v2`, `ifd[34682] = text`, `Image.save(..., format="TIFF", tiffinfo=ifd)`). Assertions: `kv == 2.0`, `spot == 3.5`, `working_distance_mm == 15.92`, `magnification == 40`, `hfw_um == pytest.approx(7451.57)`, `pixel_size_nm == pytest.approx(7276.92)`, `detector == "ETD"`, `mode == "SE"`, `instrument == "Inspect F (9923499)"`, `acquired_at.isoformat() == "2025-08-07T14:59:45+01:00"`, `bar_height_px == 59`, `sources["magnification"] == "derived"`. Time cases in `test_parse_london_time`: `26.10.2025 01:30:00` gives offset `+01:00` (first occurrence), `30.03.2025 01:30:00` gives `None`, `15.01.2026 09:00:00` gives `+00:00`. Pathological: `test_zero_hfw_omits_magnification` (`HFW=0`: no `magnification`, `flags["magnification"] == "no_hfw"`), `test_zero_hv_omits_kv`, `test_garbage_tag_is_not_a_claim` (a 25,000-character non-INI string returns `None`), `test_bad_date_omits_acquired_at` (`TimeOfCreation=garbage`: no `acquired_at`, other fields present), `test_missing_private_fei_is_not_a_claim`.
- [ ] **Step 2: Run** `python -m pytest tests/scripts/test_inbox_crawler_sem_meta.py -q`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement `fei_metadata` and `parse_london_time`** in `sem_meta.py`. Use `configparser.ConfigParser(strict=False, interpolation=None)`; `zoneinfo.ZoneInfo("Europe/London")`; a time does not exist when `dt.astimezone(UTC).astimezone(tz).replace(tzinfo=None) != dt`. Magnification is `round(ScreenMagCanvasRealWidth / HFW)`; round `working_distance_mm` to 2 places; apply the range rules.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(inbox-crawler): FEI metadata reader and UK instrument time`.

### Task A2: evidence rules, `FeiProfile`, JEOL demotion

**Files:**
- Modify: `scripts/inbox_crawler/classify_sem.py` (`find_data_bar`, `JeolProfile.inspect`, `PROFILES`, `classify_image`), `scripts/inbox_crawler/kinds.py` (`Classification`)
- Test: `tests/scripts/test_inbox_crawler_classify.py` (update the bar-only JEOL cases), new `tests/scripts/test_inbox_crawler_classify_fei.py`

**Interfaces:**
- Consumes: Task A1 `fei_metadata`.
- Produces: `Classification.classified_by: str = ""`; `CLASSIFIER_VERSION = "sem-2"` (set on every `Classification` `classify_image` returns, including plain images and "not decoded"); `negative_signal(img) -> str | None` (reason text or `None`); `find_fei_bar(gray) -> int | None` (top row `y` of the first row in the bottom quarter whose mean is above 150 and at least 2.5 times the mean of the row two below); `bar_structure(gray, y: int) -> int | None` (number of vertical divider columns: more than 90% of the body rows brighter than 0.4 times the bar's maximum, counted per group of adjacent columns; `None` below 3); `class FeiProfile` with `name = "FEI"` and `inspect(img, ocr, ocr_func) -> ProfileResult | None`, registered in `PROFILES`.

- [ ] **Step 1: Write the failing tests** in `test_inbox_crawler_classify_fei.py` with synthetic builders: `make_fei_tiff(meta=True, model=None, make=None)` (noisy grey image with a 59-row bar at the bottom: a white top row, white vertical lines every 150 px, text from `ImageDraw`, optional tag 34682 from Task A1's fixture, optional tags 272/271). Tests: `test_fei_metadata_tiff_is_sem_image` (kind `sem_image`, confidence 0.95, `extracted["kv"] == 2.0`, `extracted["sources"]["magnification"] == "derived"`, `classified_by == "sem-2"`); `test_fei_metadata_without_bar_is_still_sem_image` (confidence 0.9); `test_optical_microscope_tiff_stays_image` (bar plus tag 272 `"Microscope x20"` plus tag 271 `"DirectShow input device"`: `kind == "image"`, reason contains `"optical"`); `test_directshow_device_stays_image`; `test_bar_only_is_image_even_with_divider_rows` (no metadata, structure present, `ocr=False`: `kind == "image"`, reason `"data-bar-like strip, no SEM evidence"`); `test_find_fei_bar_accepts_divider_rows` (returns the bar's top `y`, where the old `find_data_bar` returns `None`); `test_contrast_edited_bar_is_found` (the same bar with the dividers at 207 instead of 255: same `y`, same divider count); `test_classified_by_on_plain_image`; `test_jeol_bar_only_no_longer_claims` (the existing synthetic JEOL bar without metadata now gives `image`); `test_jeol_metadata_still_claims` (tag text with "JEOL": `sem_image`, `extracted["instrument"] == "JEOL"`).
- [ ] **Step 2: Run** `python -m pytest tests/scripts/test_inbox_crawler_classify_fei.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement.** `FeiProfile.inspect` claims from metadata only in this task (the OCR claim is Task B2): confidence 0.9, plus 0.05 when `bar_structure` is not `None`; `extracted` is `fei_metadata(img)` with `acquired_at` as ISO text and `bar_height_px` dropped. A negative signal caps any profile's confidence at 0.55 inside `classify_image` (after profiles run) and sets the reason. `JeolProfile.inspect`: when `jeol_meta` is false the confidence is `min(conf, 0.55)`. The data-bar-only reason is set by `classify_image` when a bar structure exists and no profile claimed.
- [ ] **Step 4: Update every existing test in `tests/scripts/test_inbox_crawler_classify*.py` and `test_inbox_crawler_*` that expects `sem_image` from a bar alone** (find them with `grep -rn "sem_image" tests/scripts`); they now expect `image`, or add JEOL metadata to keep them `sem_image`. Run `python -m pytest tests/scripts/test_inbox_crawler_*.py -q`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(inbox-crawler): FEI profile, positive evidence and optical-microscope negative, JEOL bar-only demoted`.

### Task A3: numeric scale bar and tolerant magnification text

**Files:**
- Modify: `scripts/inbox_crawler/classify_sem.py` (`_MAG`, `parse_text`, `_UNITS`)
- Test: `tests/scripts/test_inbox_crawler_classify.py`

**Interfaces:**
- Produces: `parse_text(text, *, scale_bar=False)` now returns `scale_bar_um: float` instead of the string `scale_bar`; magnification accepts a thin space, no-break space and ordinary space as thousands separators and either `x` or `×`.

- [ ] **Step 1: Write the failing tests:** `parse_text("1 200 x")["magnification"] == 1200`, `"1 200 x"`, `"40×"` gives 40, `"3 000 x"` gives 3000; `parse_text("500 µm", scale_bar=True)["scale_bar_um"] == 500.0`, `"3 mm"` gives 3000.0, `"200 nm"` gives 0.2, `"100μm"` (Greek mu) gives 100.0; `"scale_bar" not in` the result.
- [ ] **Step 2: Run** the new tests. Expected: FAIL.
- [ ] **Step 3: Implement** in `parse_text`; replace every user of the old key (`grep -rn "scale_bar" scripts packages core tests`) and update their tests and the `inboxModel` display name only if a UI file reads it (Stream F owns UI; list the file in the commit message if found).
- [ ] **Step 4: Run** `python -m pytest tests/scripts/test_inbox_crawler_*.py -q`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(inbox-crawler): numeric scale_bar_um and tolerant magnification text`.

---

## Stream B: cell-split OCR tier (`inbox-crawler-implementer`; after A)

### Task B1: `sem_bar.py` (cells, bar reading, parsing, checks)

**Files:**
- Create: `scripts/inbox_crawler/sem_bar.py`
- Test: `tests/scripts/test_inbox_crawler_sem_bar.py` (`pytest.importorskip("numpy")`)

**Interfaces:**
- Consumes: Task A3 `parse_text`-style conversions (reuse `_UNITS`), Task A1 value ranges (move them to one shared constant in `sem_meta.py` if A1 has them local).
- Produces: `Recogniser = Callable[[list], list[tuple[str, float]]]` (a list of RGB numpy arrays in, `(text, confidence)` out, same order); `cut_cells(bar) -> list[BarCell]` where `BarCell` is a dataclass `(x0: int, x1: int, header: Image, value: Image)`, empty when fewer than 3 cells; `read_bar(bar, recognise: Recogniser) -> dict[str, tuple[str, float]]` keyed `hv det wd mag mode spot scale`; `scale_bar_length_px(bar) -> int | None`; `parse_bar(read: dict, *, image_width: int, scale_px: int | None, hfw_um: float | None = None) -> BarValues` (`BarValues` dataclass: `values: dict`, `sources: dict`, `flags: dict`); `CANVAS_M = (0.2984, 0.2984 * 0.858)`.

- [ ] **Step 1: Write the failing tests.** Synthetic bar builder `make_bar(labels, values, scale_len)`: white top row, white vertical dividers between cells, header text on the upper half, value text on the lower half, no horizontal line between them, a horizontal line of `scale_len` px in the right cell. Tests: `test_cut_cells_finds_every_cell` (6 cells for a 6-cell bar; header and value crops non-empty); `test_cut_cells_ignores_scale_bar_line` (the scale-bar line must not become the header/value split); `test_cut_cells_on_contrast_edited_bar` (dividers and text scaled to 207 maximum: the same cells); `test_read_bar_maps_by_header_text` (fake recogniser scripted `[("HV",.7),("20.00 kV",.8), ...]` in cell order; a second bar with order `mode HV spot WD mag` gives the same mapping); `test_read_bar_scale_cell_label_on_top_row`; `test_parse_bar_values` (`"20.00 kV"` gives `kv == 20.0`, `"10.3 mm"` gives `working_distance_mm == 10.3`, `"1 200 x"` gives `magnification == 1200`, `"100μm"` gives `scale_bar_um == 100.0`, `sources` all `"ocr"`); `test_low_confidence_is_not_a_filter` (confidence 0.60 value kept); `test_magnification_cross_check_passes` (`hfw_um=248.67`, mag 1200: `0.2984 / 1200 = 248.67e-6`); `test_blurred_magnification_is_omitted_not_guessed` (read `"200"` while `hfw_um=248.67`: no `magnification`, `flags["magnification"] == "hfw_mismatch"`); `test_scale_bar_cross_check` (label 100 µm, `scale_px` and `image_width` chosen so `implied = scale_px * 0.2984e6 / (mag * image_width)` is within 5%: kept; 20% off: `scale_bar_um` omitted, `flags["scale_bar_um"] == "length_mismatch"`); `test_no_cross_check_flags_check_this` (no `hfw_um`, no `scale_px`: values kept, `flags["check_this"] is True`); `test_out_of_range_kv_omitted` (`"250 kV"`); `test_garbage_cell_gives_no_value` (`""` for `wd`: no `working_distance_mm`).
- [ ] **Step 2: Run** `python -m pytest tests/scripts/test_inbox_crawler_sem_bar.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement `cut_cells`.** The method that was proven on 246 real bars (branch `spike/sem-bar-ocr`, `scripts/dev/sem_bar_spike/cells.py`; read it, port it, do not import it): divider columns are those with more than 90% of the body rows (rows 2 to height-1) brighter than 0.4 times the bar's maximum (the spike's absolute `> 200` was made relative on 2026-10-16 after contrast-edited exports); header/value split at the middle of the darkest run of rows in the 30% to 70% band, judged on the mean of the left 40% of the width; crops inset 2 px; cells narrower than 12 px dropped.
- [ ] **Step 4: Implement `read_bar`:** per cell, `ImageOps.invert`, resize 2x `LANCZOS`, `ImageOps.expand(border=6, fill=255)`, convert RGB; one `recognise([...])` call for all crops; header text lowercased and matched by `startswith` against `hv det wd mag mode spot`; if no header matches but the header text matches `\d\s*[nuμµm]m$`, it is the `scale` cell (label on the top row).
- [ ] **Step 5: Implement `parse_bar`, `scale_bar_length_px`** (longest run above 200 of at least 20 px in any single row of the rightmost cell) and the checks from Global Constraints; numbers parsed with thin, no-break and ordinary spaces removed.
- [ ] **Step 6: Run the tests.** Expected: PASS. **Step 7: Commit** `feat(inbox-crawler): cell-split data-bar reader with format, range and cross-checks`.

### Task B2: the bar reader in `FeiProfile` and the default recogniser

**Files:**
- Modify: `scripts/inbox_crawler/classify_sem.py` (`FeiProfile`, `classify_image`, remove `default_ocr`), `scripts/inbox_crawler/scan.py` and `daemon.py` and `__main__.py` (carry the reader like `ocr_func`), `tests/scripts/test_inbox_crawler_readonly.py` (allow-list: add `sem_bar`, `sem_meta`, `zoneinfo`, `numpy`, `rapidocr_onnxruntime` for the reader modules only)
- Test: `tests/scripts/test_inbox_crawler_classify_fei.py`

**Interfaces:**
- Consumes: Tasks A2 and B1.
- Produces: `sem_bar.default_bar_reader(device: str = "cpu") -> Recogniser` (lazy `from rapidocr_onnxruntime import RapidOCR`; returns `RapidOCR().text_recognizer`; `device` `auto|cpu|cuda` picks the onnxruntime providers, `auto` taking `CUDAExecutionProvider` when available and logging the choice); `classify_image(fh, *, ocr=False, profiles=None, ocr_func=None, bar_reader=None)`: when `ocr` is true and `bar_reader` is `None`, `sem_bar.default_bar_reader(os.environ.get("INBOX_OCR_DEVICE", "cpu"))` is built once per process.

- [ ] **Step 1: Write the failing tests:** `test_png_bar_with_two_labels_is_sem_image_when_ocr_on` (synthetic PNG of a 6-cell bar, no metadata, `bar_reader` a scripted fake returning `hv`, `wd`, `mag`, `mode`, `spot`: kind `sem_image`, confidence 0.8, `extracted["kv"]`, `extracted["sources"]["kv"] == "ocr"`); `test_png_bar_ocr_off_stays_image`; `test_one_label_is_not_enough` (only `hv` read: `image`); `test_metadata_wins_over_bar_and_mismatch_is_noted` (TIFF with metadata and a fake reader returning a different kV: `extracted["kv"]` from metadata, `extracted["flags"]["kv"] == "bar_mismatch"`); `test_reader_exception_does_not_lose_the_image` (reader raises: still classified from metadata or plain `image`).
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement** the OCR claim path in `FeiProfile.inspect` (bar via `find_fei_bar`, `cut_cells`/`read_bar`/`parse_bar` with `hfw_um` from metadata when present). Remove `default_ocr` (pytesseract was never installed or validated; JEOL OCR runs only when a caller passes `ocr_func`). **Step 4: Run** `python -m pytest tests/scripts/test_inbox_crawler_*.py -q`. Expected: PASS (including the read-only test). **Step 5: Commit** `feat(inbox-crawler): FEI bar claim and values from OCR when INBOX_OCR=1`.

### Task B3: packaging, variables, runbook

**Files:**
- Modify: `docker-compose.yml` (service `inbox-crawler` command), `Makefile` (`inbox-crawler-once` has its own copy of the pip line: change both identically), `.env.example`, `docs/runbooks/inbox-crawler.md` (settings table), `docs/runbooks/physical-test-backlog.md`

- [ ] **Step 1:** `INBOX_OCR_DEVICE: ${INBOX_OCR_DEVICE:-cpu}` in the compose environment block and `INBOX_OCR_DEVICE=` in `.env.example` with a comment (also update the `INBOX_OCR` comment: it now reads the FEI data bar and needs rapidocr, not pytesseract).
- [ ] **Step 2: Packaging.** `rapidocr-onnxruntime` requires the non-headless `opencv-python`, which `python:3.12-slim` may not import (needs libGL). With `INBOX_OCR=1` the pip line installs `--no-deps rapidocr-onnxruntime==1.2.3` and then its dependencies with `opencv-python-headless` in place of `opencv-python`, exact versions from a passing install. Verify in a clean image: `docker run --rm python:3.12-slim sh -c "<the pip line> && python -c 'import zoneinfo, rapidocr_onnxruntime; zoneinfo.ZoneInfo(\"Europe/London\"); rapidocr_onnxruntime.RapidOCR(); print(\"ok\")'"`. Expected: `ok`. If Docker is unavailable in the session, say so in the commit message and rely on backlog **SEM7**; do not guess versions.
- [ ] **Step 3:** backlog items (bold ids, what to do, what to expect, this PR): **SEM1** FEI TIFFs through the real crawler; **SEM2** real PNG/BMP/JPEG exports against their TIFFs' metadata; **SEM4** (optional) `INBOX_OCR_DEVICE=auto` on the crawler host (RTX 5080, Docker GPU passthrough, onnxruntime-gpu on Blackwell); **SEM7** the crawler image installs and imports rapidocr and `zoneinfo` (the check in Step 2).
- [ ] **Step 4: Run** the repo's compose check as CI does (`node --test tests/starbase_compose.test.mjs`) and `pre-commit run --files <changed>`. Expected: PASS. **Step 5: Commit** `chore(inbox-crawler): OCR packaging, INBOX_OCR_DEVICE, runbook and backlog items`.

---

## Stream C: migrations (`d1-server-implementer`; parallel with A)

Use the `db-migration` skill. Take the next free migration numbers when you start (195 is the latest; another session may have added more) and rebase on `main` before opening the PR. Every table, column and function gets a COMMENT; each down migration is exact; `scripts/ci/migration_roundtrip.sh` must pass.

### Task C1: owner columns, back-fill, the Directus read filter

**Files:**
- Create: `db/migrations/<n>_file_provenance_owner.sql`
- Modify: `scripts/access_rules.json` ("custom" entries for `directus_files`), `scripts/gen_access_rules.py` only if it cannot express the filter, `scripts/configure_users_and_policies.sql` (its generated block), `tests/phase1_schema.sh`, `docs/data-dictionary.md`

**Interfaces:**
- Produces: `directus_files.owner_person_id UUID REFERENCES people (person_id) ON DELETE RESTRICT`, `directus_files.owner_team_id UUID REFERENCES teams (team_id) ON DELETE RESTRICT`, `CHECK (num_nonnulls(owner_person_id, owner_team_id) <= 1)`, partial indexes on each; a Directus read filter on `directus_files` for the Lab Member and Lab Viewer policies; Lab Member `create` and `update` field lists on `directus_files` that exclude both columns.

- [ ] **Step 1: Write the failing schema tests** in `tests/phase1_schema.sh` (the file's `ok`/`bad` and `rl_check` style): the two columns exist with the FKs and `RESTRICT`; the CHECK refuses both set; back-fill: seed one `file_candidates` row per state (`new`, `dismissed`, `gone`, `linked`) with owners, run the migration's back-fill statement, expect the first three stamped from the candidate's owner and the `linked` one left null; a `directus_files` row with no candidate stays null; deleting a `people` row that owns a file is refused; `rl_check` for the Lab Member `directus_files` create/update field lists leaving out exactly `owner_person_id,owner_team_id`; the migration's generated-rules drift check (`tests/scripts/test_access_rules.py`) passes.
- [ ] **Step 2: Run** `make schema-test` (needs `DATABASE_URL`). Expected: FAIL.
- [ ] **Step 3: Write the migration:** the columns, CHECK, indexes, COMMENTs; the back-fill `UPDATE directus_files f SET owner_person_id = c.owner_person_id, owner_team_id = c.owner_team_id FROM d1_private.file_candidates c WHERE c.directus_files_id = f.id AND c.state <> 'linked' AND f.owner_person_id IS NULL AND f.owner_team_id IS NULL`; the down drops the columns.
- [ ] **Step 4: The read filter.** In `access_rules.json` "custom" for `("directus_files", "read")` write a Directus filter: owner columns both null, or `owner_person_id.user_id = $CURRENT_USER`, or the caller is in the owner team. **First probe** (against the repo's Directus test stack used by `tests/phase3_api.sh`; if none is available, say so in the commit message) whether Directus accepts the team test as a relational path; per `access_rules.json`'s comment `_some` is legal only directly under a top-level O2M. If it does not, use the ADR-0014 pattern instead: a `d1_private` readers table `file_readers (directus_files_id, user_id)` kept by triggers for owned files, and a top-level `readers._some.user_id = $CURRENT_USER` alias, with its own tests. The administrator policy has no filter. Regenerate with `python scripts/gen_access_rules.py --write` and paste per its docstring; the drift tests must pass.
- [ ] **Step 5: Run** `make schema-test` and `python -m pytest tests/scripts/test_access_rules.py -q`. Expected: PASS. **Step 6: Commit** `feat(db): provenance owner on directus_files, back-fill from file_candidates, read filter`.

### Task C2: settings table, access log, `save_sem_settings`, `classified_by`

**Files:**
- Create: `db/migrations/<n+1>_sem_image_settings.sql`
- Modify: `tests/phase1_schema.sh`, `docs/data-dictionary.md`

**Interfaces:**
- Produces: `d1_private.sem_image_settings` (spec section 3 columns: `directus_files_id UUID PRIMARY KEY REFERENCES directus_files ON DELETE CASCADE`, `kv NUMERIC(6,2)`, `spot NUMERIC(4,1)`, `working_distance_mm NUMERIC(6,2)`, `magnification INTEGER`, `hfw_um NUMERIC(10,2)`, `pixel_size_nm NUMERIC(12,4)`, `scale_bar_um NUMERIC(12,3)`, `detector TEXT`, `mode TEXT`, `instrument TEXT`, `acquired_at TIMESTAMPTZ`, `sources JSONB NOT NULL DEFAULT '{}'`, `flags JSONB NOT NULL DEFAULT '{}'`, `read_by TEXT NOT NULL`, `read_at TIMESTAMPTZ NOT NULL DEFAULT now()`, `corrected_by UUID`, `corrected_at TIMESTAMPTZ`; CHECKs for the ranges); `d1_private.sem_settings_access_log (id BIGSERIAL PRIMARY KEY, directus_files_id UUID NOT NULL, read_by_user UUID NOT NULL, read_at TIMESTAMPTZ NOT NULL DEFAULT now(), reason TEXT NOT NULL)`; `d1_private.file_candidates.classified_by TEXT`; `d1_private.save_sem_settings(p_files_id uuid, p_extracted jsonb, p_read_by text) RETURNS boolean` (SQL, `SECURITY INVOKER`, the **only** place `extracted` becomes columns: maps the Global-Constraints keys, drops a value outside its range, upserts, skips every field whose `sources.<field>` in the existing row is `manual`, returns whether a row exists afterwards); `d1_private.correct_sem_setting(p_files_id uuid, p_field text, p_value jsonb, p_user uuid) RETURNS void` (sets the column from `p_value`, `sources.<field> = 'manual'`, `corrected_by`, `corrected_at`; refuses unknown fields and out-of-range values).

- [ ] **Step 1: Write the failing SQL tests** (`tests/phase1_schema.sh`): `save_sem_settings` maps a full `extracted` (`kv 2.0`, `spot 3.5`, `working_distance_mm 15.92`, `magnification 40`, `acquired_at "2025-08-07T14:59:45+01:00"`, `sources`) to the row; a second call with a different `kv` updates it; `sem_settings: manual field survives a re-save` (after `correct_sem_setting(..., 'kv', '20.5', user)` a re-save with `kv 2.0` keeps 20.5 and updates the other fields); `kv 250` is dropped and the rest saved; an empty `extracted` returns false and writes no row; `correct_sem_setting` refuses `field = 'read_by'`; deleting the `directus_files` row cascades; the log table refuses a null `reason`.
- [ ] **Step 2: Run** `make schema-test`. Expected: FAIL. **Step 3: Write the migration** with COMMENTs and an exact down. **Step 4: Run** `make schema-test`. Expected: PASS. **Step 5: Commit** `feat(db): sem_image_settings, save_sem_settings, access log, classified_by`.

### Task C3: stream-C closing checks

- [ ] Run the repo's migration review: invoke the `migration-review` skill on both migrations and fix findings. Run `bash scripts/ci/migration_roundtrip.sh` (rolls back every migration and re-applies). Add backlog items **SEM3** (two accounts and a locked file) and **SEM5**'s database half to `docs/runbooks/physical-test-backlog.md`. Commit `docs(db): backlog items for the provenance owner`.

---

## Stream D: `d1-inbox` endpoint (`d1-server-implementer`; after C)

Coordinator messages the crawler chat first (see Status). Files: `core/extensions/d1-inbox/index.js`, `index.test.mjs`, `contract_fixtures.mjs`, `index.contract.test.mjs`, `sql_check.mjs`, new fixtures in `tests/fixtures/d1-inbox/`. Run: `cd core/extensions/d1-inbox && node --test index.test.mjs index.contract.test.mjs` (confirm the exact invocation from `.github/workflows/ci.yml` near the d1-inbox lines) and `make schema-test` (it prepares the extension's SQL against the real schema).

### Task D1: settings saved on link, removed on undo

**Interfaces:**
- Consumes: Task C2 `d1_private.save_sem_settings`.
- Produces: `performLink` calls `SELECT d1_private.save_sem_settings(?, ?::jsonb, ?)` for every newly linked entry whose `cand.kind === 'sem_image'`, in the same transaction, with the candidate's `extracted` and `read_by = 'inbox'`; `CANDIDATE_COLUMNS` gains `c.extracted`; undo deletes a file's settings row only when no row remains in `sample_data_files`, `operation_data_files` or `session_data_files` for that file.

- [ ] **Step 1: Write the failing tests** in `index.test.mjs` (the file's fake-knex style): `link saves settings for a sem_image` (the recorded raw call has the function name, the file id and the candidate's `extracted`), `link of a plain image saves none`, `a rollback after the settings call leaves nothing` (the existing transaction test pattern), `undo removes the settings when no link of the file remains`, `undo keeps settings while another link of the file remains` (a second junction row for the same file in another collection), `accept-all links save settings`, `auto-link saves settings`.
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement** in `performLink` and the undo transaction. **Step 4: Run both node suites and `make schema-test`.** Expected: PASS. **Step 5: Commit** `feat(d1-inbox): save imaging settings with the link, remove them with the last link`.

### Task D2: read and correct routes; admin read-only

**Interfaces:**
- Produces: `GET /d1-inbox/sem-settings?file=<uuid>` returning `{ data: { locked: false, settings: {...}, sources, flags } }` for the owner (person or team member) and for anyone who may read an unowned file's record, the same read-only for an administrator **plus one `sem_settings_access_log` row with `reason = 'admin_read'`**, and `{ data: { locked: true } }` (HTTP 200, no values) otherwise; `PATCH /d1-inbox/sem-settings/<uuid>` body `{ field, value }` calling `d1_private.correct_sem_setting`, owner only (403 otherwise); `canSee`-based link, accept-all, dismiss, restore and undo are refused with `403 FORBIDDEN` for an administrator who is not the candidate's owner or a member of the owning team (administrators keep list and summary visibility).

- [ ] **Step 1: Write the failing tests:** owner gets values; a team member gets team-owned values; another member gets `locked: true` and no values anywhere in the JSON; an administrator gets values and a log insert; the log insert is not made for the owner; PATCH by the owner sets `sources.kv = 'manual'`; PATCH by anyone else is 403; PATCH of `read_by` is 400; an administrator linking someone else's file gets 403 (`test_admin_cannot_link_others_files`); contract fixtures `sem_settings_owner.json`, `sem_settings_locked.json`, `sem_settings_admin.json` written from the real shapers (never edit an existing fixture).
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3: Implement** the routes next to `/summary` and the header comment of `index.js` (the route list at the top of the file must name them). **Step 4: Run** both node suites, `make schema-test`, then the Explorer UI job's contract replay locally (`npm test` for `packages/starbase-pages`, see Stream F). Expected: PASS. **Step 5: Commit** `feat(d1-inbox): read and correct imaging settings, locked files, administrators read-only`.

---

## Stream E: crawler stamping, re-classification, back-fill (`inbox-crawler-implementer`; after A, B, C)

Tests use the Postgres-backed world fixtures of `tests/scripts/test_inbox_crawler_world.py` (study it first); run `python -m pytest tests/scripts/test_inbox_crawler_*.py -q`.

### Task E1: stamp the owner at registration

**Interfaces:**
- Produces: `Store.register_file` writes `owner_person_id` / `owner_team_id` into the `directus_files` insert; `Store.stamp_owner(files_id: str, owner: Owner) -> bool` updates an existing unstamped pointer row only when `Store.already_linked([files_id])` is empty and both owner columns are null; neither ever overwrites a stamp.

- [ ] **Step 1: Write the failing tests:** `test_new_file_is_stamped_with_the_owner` (person and team folders); `test_existing_unlinked_row_is_stamped_on_first_encounter`; `test_linked_row_is_not_stamped`; `test_stamp_is_never_overwritten` (a second owner scanning the same path leaves the first); `test_alias_handed_to_someone_else_does_not_move_the_file` (owner stays the `person_id`). **Step 2:** run, FAIL. **Step 3:** implement in `db.py` and call `stamp_owner` from `scan.py` where an already-registered candidate is met. **Step 4:** run, PASS. **Step 5: Commit** `feat(inbox-crawler): stamp the provenance owner on pointer rows`.

### Task E2: `--reclassify`

**Interfaces:**
- Produces: `python -m inbox_crawler --reclassify`, a third mutually exclusive mode: `Store.reclassify_batch(limit: int) -> list[tuple[str, str, str, str]]` (candidate id, files id, rel path, current kind) of image candidates in state `new` or `dismissed` with `kind IN ('image','sem_image')` and `classified_by IS DISTINCT FROM CLASSIFIER_VERSION`; `Store.set_classification(candidate_id, classification)` updating `kind`, `kind_confidence`, `extracted`, `classified_by` only; the mode reads each file through `fs_readonly.open_rb` into `io.BytesIO`, throttled by the existing `read_mb_per_s`, takes the crawler's advisory lock, is resumable, logs promoted, demoted and unchanged counts, never touches a `linked` row, and records an unreadable file as classified with the current version and a reason in the log (no tight retry).

- [ ] **Step 1: Write the failing tests:** `test_reclassify_demotes_a_false_sem_image` (a candidate `sem_image` whose bytes are a plain dark-strip image becomes `image`); `test_reclassify_promotes_a_fei_tiff` (a candidate `image` whose bytes are the synthetic FEI TIFF becomes `sem_image` with `extracted["kv"]`); `test_reclassify_skips_linked_rows`; `test_reclassify_is_idempotent` (a second run changes nothing and reads no files); `test_unreadable_file_is_not_retried_in_a_loop`; `test_reclassify_refuses_when_another_crawler_holds_the_lock`; `test_reclassify_only_opens_allowlisted_images` (the read-only test's pattern). **Step 2:** run, FAIL. **Step 3:** implement in `__main__.py` and a new function in `daemon.py` or `scan.py`. **Step 4:** run (including `test_inbox_crawler_readonly.py`), PASS. **Step 5: Commit** `feat(inbox-crawler): --reclassify re-reads image candidates with the current detector`.

### Task E3: `--sem-backfill`

**Interfaces:**
- Produces: `python -m inbox_crawler --sem-backfill`: `Store.backfill_batch(limit: int)` returning pointer rows that are image-typed (extension in `fs_readonly.IMAGE_EXTENSIONS`), linked in one of the three junction tables, unowned (both owner columns null) and without a `sem_image_settings` row; for each, read through `open_rb`, `classify_image(..., ocr=True)`, and when the result is `sem_image` call `SELECT d1_private.save_sem_settings(%s, %s::jsonb, 'backfill')`; resumable, throttled, lock-guarded.

- [ ] **Step 1: Write the failing tests:** `test_backfill_writes_settings_for_a_linked_unowned_fei_tiff`; `test_backfill_skips_owned_files`; `test_backfill_skips_files_that_have_settings`; `test_backfill_keeps_manual_fields` (a manual `kv` survives); `test_backfill_skips_non_sem_images`; `test_backfill_is_resumable` (a killed run, a second run finishes the rest). **Step 2:** run, FAIL. **Step 3:** implement. **Step 4:** run, PASS. **Step 5:** add the backlog items **SEM5** (the back-fill on the real database) and **SEM6** (`--reclassify` on the real database: promoted, demoted, unchanged counts, the maintainer's six FEI TIFFs and their PNG exports `sem_image`, thermal JPEGs, "Microscope x20" optical TIFFs and EDS maps back to `image`), add `--reclassify` and `--sem-backfill` to `docs/runbooks/inbox-crawler.md` and `__main__.py`'s docstring. **Step 6: Commit** `feat(inbox-crawler): --sem-backfill for linked images; runbook and backlog`.

---

## Stream F: STARbase pages (`directus-ui-implementer`; after D)

Read `.claude/skills/directus-ui-conventions/SKILL.md` first. Files: `packages/starbase-pages/src/inbox/` (`inboxModel.ts`, `InboxRow.vue`, `inboxApi.ts` and their tests, `fakeInboxServer.ts`), `tests/ui/starbase/stubInbox.ts`, and the component that lists a record's linked files (find it with `grep -rn "sample_data_files\|session_data_files\|operation_data_files" packages apps core/extensions --include=*.vue --include=*.ts`). Run `npm test --workspace packages/starbase-pages` and the typechecks the "Explorer UI" CI job runs (see `docs/ci-cd.md`).

### Task F1: settings in the Inbox row

- [ ] **Step 1: Write the failing tests** in `inboxModel.test.ts`: a `sem_image` row with `extracted` shows labelled values with units in a fixed order (`kV`, `working distance`, `magnification`, `spot`, `detector`, `mode`, `scale bar`, `taken`), each with a source label (`metadata`, `derived`, `OCR`); a value with `flags.check_this` shows a "check this" mark; a failed field (`flags.<field>` set, value absent) shows "couldn't read <field>"; `acquired_at` is shown as UK time with the offset; a row with no extracted keys shows nothing extra. **Step 2:** run, FAIL. **Step 3:** implement in `inboxModel.ts` (pure formatting) and `InboxRow.vue` (render). **Step 4:** run, PASS. **Step 5: Commit** `feat(starbase): imaging settings, sources and flags in the Inbox row`.

### Task F2: record page: settings and locked file

**Interfaces:**
- Consumes: Task D2 `GET /d1-inbox/sem-settings?file=<uuid>` and `PATCH /d1-inbox/sem-settings/<uuid>`; the client functions `getSemSettings(fileId)` and `correctSemSetting(fileId, field, value)` in `inboxApi.ts` (new).

- [ ] **Step 1: Write the failing tests:** a linked file whose answer is `locked: true` renders a locked file (a lock icon and "A file from another person's folder"; no name, no values, no download link); an owner's answer renders the settings and an edit control per field that calls `correctSemSetting` and then shows `manual`; a non-owner never sees the edit control; the fake server (`fakeInboxServer.ts`) and `stubInbox.ts` gain both routes from the new contract fixtures `sem_settings_owner.json`, `sem_settings_locked.json`. **Step 2:** run, FAIL. **Step 3:** implement in the record page component. **Step 4:** run the package tests and typechecks, PASS. **Step 5: Commit** `feat(starbase): imaging settings on the record page, locked files for others`.

---

## Self-review (run once, against the spec)

- **Coverage:** D1 (A2, B2), D2 (A1, B1, B2), D3 (A1 ranges, B1 checks), D4 (Global Constraints, B1), D5 (A1), D6 (C2, D1), D7 (C1, E1), D8 (C1), D9 (D2, F2), D10 (C1 back-fill, E1), D11 (E3), D12 (B2, B3), D13 (C1 constraints, E1 tests); spec section 7 `--reclassify` (E2); sections 5 and 6 (D1, D2, F1, F2); section 9 testing (each task); physical backlog SEM1, SEM2, SEM4, SEM7 (B3), SEM3 (C3), SEM5, SEM6 (E3).
- **Deviation from the spec, to confirm:** spec section 9 says golden fixtures are "cropped data bars of the five samples". The repo rule in `tests/scripts/test_inbox_crawler_classify.py` ("No research image is ever committed") wins: fixtures are synthetic bars and metadata text with the values only; real bars are validated by SEM1, SEM2 and the d1-server spike harness. Likewise the spec's "trigger refuses an update of the owner columns" is replaced by Directus field lists (Global Constraints), because the database role is shared.
- **Types:** `fei_metadata` keys (A1) equal the Global-Constraints keys and `save_sem_settings`'s mapping (C2); `BarValues.values` (B1) uses the same keys; `Classification.classified_by` (A2) feeds `set_classification` (E2).
- **Proportion:** the plan states signatures, tests and values; the one algorithm given by reference is the proven cell cutter (`spike/sem-bar-ocr`).
