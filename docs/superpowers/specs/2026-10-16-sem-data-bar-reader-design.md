# SEM data-bar reader and provenance-owned files: design

**Date:** 2026-10-16
**Status:** Design only; plan [`2026-10-16-sem-reader.md`](../plans/2026-10-16-sem-reader.md). Agreed with the maintainer in a design interview on 2026-10-16 (every decision below was
confirmed by them unless it says "assumed"). ADR: [0022](../../adr/0022-files-belong-to-their-provenance-owner.md).
Terms: `CONTEXT.md` → *Files on the share* (**SEM image**, **data bar**, **imaging settings**, **provenance owner**,
**locked file**). Builds on [found files and the Inbox](2026-10-15-found-files-inbox-design.md) (ADR-0020).
Nothing here is built. **Amended 2026-10-16** after the d1-server session reported real data: the inbox crawler is
live on d1-server (since 2026-10-16, eight people's `Users` folders, about 82,000 files), so existing rows have to be
migrated and re-classified (sections 3, 4 and 7); the numbers below are theirs, not measured here.

## Problem

People save SEM images in their own folders on the lab share. Today the inbox crawler can tag a picture as a
"possible SEM image", but only for JEOL-style bars, and it reads nothing from FEI/Thermo images. The settings
printed in the data bar along the bottom (accelerating voltage, working distance, magnification, spot, detector,
mode, scale bar) never reach the database, so nobody can search or compare images by them. At the same time the
maintainer wants a firm rule about whose files these are: a file in someone's personal folder is theirs, and
linking it to a record must not publish it to the whole lab.

The five sample images (all from a Thermo/FEI Inspect F, XL30SB) show why the current detector fails: the FEI bar
has full-width white divider rows, and `find_data_bar` rejects any bar containing a row brighter than 90
(`DARK_ROW_MAX`), so **none of the five is recognised as SEM**.

**Real data (d1-server, reported 2026-10-16) says the detector is the main bug, not the reading.**
`d1_private.file_candidates` has 1,586 rows with `kind = 'sem_image'`, almost all false positives: thermal-camera
JPEGs, optical micrographs (TIFF tag 272 `Model` = "Microscope x5/x10/x20", made by "DirectShow input device"),
EDS maps and report figures. Images under folders named `/SEM/` are 1,035 `image` and only 15 `sem_image`, so real
FEI images are missed. Only 40 rows have anything extracted, all `{"instrument": "JEOL"}`; none has kV or
magnification. In the maintainer's folder six TIFFs carry the FEI tag (all Inspect F / XL30SB, 1024×943: an
884-row image plus a 59-row bar, with full `[Beam]`, `[EBeam]` and `[Scan]` sections), and `.png` exports of
the same images exist next to them (for example `D2_Bulk_3000x.png`). So tier 1 (metadata) covers every real SEM
TIFF seen so far, exactly, and the PNG exports need the bar.

## Goals

1. Recognise an SEM image in any of the four decoded formats (TIFF, JPEG, PNG, BMP) and read its imaging
   settings from the metadata or the data bar.
2. Save the settings per image when a person links it, on the record's side, undoable with the link.
3. A file is visible and linkable only to its provenance owner; others on a linked record see a locked file.
4. Use a GPU where one is available for the slow path, without requiring one.

## Non-goals

- Instruments other than JEOL (existing profile, unvalidated) and FEI/Thermo.
- Editing settings in bulk, or filling `test_sessions.sem_*` (those describe a test, not an image).
- Closing `directus_files` for the legacy archive or for files already linked (ADR-0014's A1b stream).
- Surface-scan privacy (ADR-0021 is reversed by a **separate stream**, section 11).
- Anything that writes to the share: the crawler stays read-only (ADR-0020).

## Decisions

| # | Decision |
|---|---|
| D1 | A new `FeiProfile` in `scripts/inbox_crawler/classify_sem.py`, registered beside `JeolProfile`. `find_data_bar` accepts divider rows. A claim needs **positive evidence** (instrument metadata, or a recognised bar structure with its labels read), and optical-microscope images are a **negative signal** (section 1). *Amended 2026-10-16 from real data.* |
| D2 | Values are read in order of trust: embedded TIFF metadata (exact), then **cell-split OCR of the data bar**: the bar is cut into its cells and only RapidOCR's *recogniser* runs (never its text detector). A trial read every field right on all 246 real FEI bars (section 2). Glyph matching is dropped from v1 and stays a later option. *Amended 2026-10-16 (OCR trial); this reverses the "glyph matching first" decision of the interview, confirmed by the maintainer the same day.* |
| D3 | Magnification from metadata is derived: `ScreenMagCanvasRealWidth / HFW`. A value is kept only if it passes format and range checks; OCR confidence is recorded but is **not** a filter (correct reads scored as low as 0.60). A bar-read magnification is cross-checked: `mag x HFW` must equal one of the two screen-width constants seen on real files (0.2984 m, or 0.858 of that) within 2%, and the scale-bar label must agree with the bar's pixel length. A value that cannot be cross-checked is saved flagged `check_this`; a value that fails is left absent with a "couldn't read X" note. |
| D4 | Keys are numeric with the unit in the name; every value records its source (`metadata`, `derived`, `ocr`, `manual`). Metadata beats the bar when they disagree and the mismatch is noted. |
| D5 | The acquisition time is read as UK time (`Europe/London`) and stored as a `timestamptz`. At the autumn clock change the repeated hour takes the first occurrence. |
| D6 | Settings are saved when a person links the image: a new `d1_private.sem_image_settings` row written by the `d1-inbox` link transaction (additive change), read only through `d1-inbox`. Undo removes it when no other link of the file remains. |
| D7 | The provenance owner is stamped by the crawler when it registers a pointer row: `directus_files.owner_person_id`, or `owner_team_id` for a team folder. Only an administrator can change it. |
| D8 | Raw reads of `directus_files` and `/assets` are filtered on the stamp. Rows with no owner stay open, as today. |
| D9 | Only the owner sees or links the file and its settings. Others on a linked record see a **locked file**. Administrators see them read-only and are audited. Only the owner can correct a value; a correction is `manual` and never overwritten by a re-read. |
| D10 | Linked files stay unowned (nobody loses access they have today). Found files that are not linked yet are owned: the migration stamps the ones the live crawler already registered from `file_candidates`, and the crawler stamps new ones. *Amended 2026-10-16: the interview said "only files registered after the change"; with the crawler live, stamping unlinked found files takes nothing from anyone, and leaving them open would make the privacy rule false for about 82,000 files. Confirmed by the maintainer 2026-10-16, database only: nothing is written to the share.* |
| D11 | `python -m inbox_crawler --sem-backfill` reads already-linked images. Settings of an unowned file follow whoever can read the record. |
| D12 | An optional GPU switch for OCR, `INBOX_OCR_DEVICE=auto\|cpu\|cuda`, CPU by default. The trial ran at about 0.16 s per file on a CPU, and a TIFF with metadata needs no OCR at all, so the GPU is not needed for this corpus; it stays a cheap, low-priority option. *Amended 2026-10-16: the maintainer asked to use the GPU where possible; the measurements say it buys little; confirmed as an optional switch.* |
| D13 | *Assumed:* a file moved between folders keeps its first owner; two copies in two folders are two files with two owners; a team-owned file is visible to members of that team; admin reads go to a small log table. |

## 1. Recognising the image

`classify_image` (unchanged contract: takes an in-memory `io.BytesIO`, never a path) runs every profile and keeps
the highest confidence. `FeiProfile.inspect` claims an image from either signal:

- **Metadata.** A TIFF whose tag 34682 (an INI text) has `[System] Type=SEM` and a `[PrivateFei]` section.
  Confidence 0.9, or 0.95 with a data bar.
- **Data bar.** The bottom strip, found by its divider rows and by the cell structure rather than by a mean
  brightness: full-width bright rows at the top and/or middle, vertical divider columns, text-like content in
  the cells. `PrivateFei.DatabarHeight` gives the height when present; otherwise it is found from the divider
  rows (the trial's `bar_of`, made relative after contrast-edited exports broke the absolute version: the first row in the bottom quarter whose mean is above 150 and at least 2.5 times the mean of the row two below). The same font is
  used at 2×: the 2048-px sample has a 119-px bar, the 1024-px samples a 59-px bar, so nothing may assume a height.

The result stays a guess scored by confidence (at least `SEM_MIN_CONFIDENCE` = 0.6 makes `kind='sem_image'`), worded
"possible SEM image" in the UI until validated on real strips (backlog).

**Positive and negative evidence (amended from real data).** A dark strip with text-like pixels is not evidence of
an SEM: thermal cameras, optical microscopes and report figures have one. A profile therefore claims an image only
with:

- instrument metadata that names the instrument (FEI tag 34682 with `[System] Type=SEM` and `[PrivateFei]`; the
  JEOL text the JEOL profile already looks for), or
- a recognised bar structure **and** at least two bar labels read (`HV`, `WD`, `mag`, `spot`, `mode`, `det`).

Reading the labels needs the OCR tier (section 2), so with `INBOX_OCR` off a PNG, BMP or JPEG without metadata stays
a plain `image`; only a TIFF with the instrument metadata is claimed. A bar-shaped strip alone no longer reaches
`SEM_MIN_CONFIDENCE`; the image stays a plain `image` with the reason
"data-bar-like strip, no SEM evidence". A **negative signal** caps the confidence below the threshold whatever
else is found: TIFF tag 272 (`Model`) matching `Microscope x<N>`, or tag 271/272 naming a DirectShow capture device.
Further negatives (thermal-camera and EDS-map signatures) are added when the maintainer's trial rows show them.
The JEOL profile's current bar-only claims (0.6 and up) are changed by this rule, and JEOL is unvalidated; see
"Open items".

## 2. Reading the settings

### Tier 1: embedded metadata (TIFF)

Exact. Only values the file states, converted:

| Imaging setting | Source key(s) | Conversion |
|---|---|---|
| `kv` | `[Beam] HV` (volts) | `/ 1000` |
| `spot` | `[Beam] Spot` | as is |
| `working_distance_mm` | `[EBeam] WD` (metres) | `* 1000` |
| `magnification` | `[Image] ScreenMagCanvasRealWidth` / `[EBeam] HFW` | derived, rounded to an integer |
| `hfw_um` | `[EBeam] HFW` (metres) | `* 1e6` |
| `pixel_size_nm` | `[Scan] PixelWidth` (metres) | `* 1e9` |
| `detector`, `mode` | `[Detectors] Name`, `Mode` | as is |
| `instrument` | `[System] SystemType`, `Dnumber` | as is |
| `acquired_at` | `[User] Date` (MM/DD/YYYY), `Time` (12-hour) | read as `Europe/London` (D5) |

Verified on the five samples: the derived magnifications are 40.0, 200.0, 1200.0, 1200.0 and 1200.0, equal to the
printed values and to the file names. A TIFF with this metadata is not read from the bar at all.

### Tier 2: cell-split OCR on the bar (no metadata)

Used for PNG, BMP, JPEG and TIFFs without the tag. Real FEI bars are bilevel white on black in a fixed font, two rows
of cells then the scale bar, for example `20.00 kV | ETD | 9.2 mm | 3 000 x | SE | 3.0 | 40 µm`. The method is the
one a trial on d1-server proved (branch `spike/sem-bar-ocr`, `scripts/dev/sem_bar_spike/`; it is not wired into the
crawler), and it has these parts, each of which mattered:

1. **Do not run RapidOCR's text detector on the bar.** It smears the whole bar into one garbage line. Cut the cells
   yourself and call only `RapidOCR().text_recognizer([images])`.
2. **Find the cells.** The vertical divider columns are those where more than 90% of the body rows are brighter than 0.4 times the
   bar's maximum (relative, because contrast-edited exports lower the dividers from 255 to about 207). The header row and the value row are split at the darkest row gap in the middle band
   (30% to 70% of the height), judged on the left 40% of the width. There is **no** horizontal line between the two
   rows inside the cells; the only horizontal lines are under the scale bar on the right, and a full-width row mean
   mistakes that line for a divider.
3. **Prepare each cell crop.** Invert to black on white, scale 2× with Lanczos, add 6 px of white padding.
4. **Map fields by header text, not by position.** Layouts differ: `HV | det | WD | mag | mode | spot` on some bars,
   `mode | HV | spot | WD | mag` (no `det`) on others. A header is matched by its start (`hv`, `det`, `wd`, `mag`,
   `mode`, `spot`; more are ignored). The scale-bar cell carries its label (`40 µm`) on its top row.
5. **Parse tolerantly.** Magnification uses thin spaces and either `x` or `×` (`1 200 x`, `40×`); the micro sign
   comes as `µ` or `μ`; a value carries its unit (`20.00 kV`, `10.3 mm`). `_MAG` in `classify_sem.py` knows only
   commas today and gets spaces and `×`.

The reader lives in a new pure module (section 7): a function of an in-memory image, no files, no subprocess, no
network.

**Evidence.** The trial's test set was 300 TIFFs from SEM-named folders on the share, 246 with FEI tag 34682 (the
ground truth). Right against the metadata: kV, WD, spot and mode 246/246, detector 148/148 (scored only where the
bar shows one), magnification 246/246 (`mag x HFW` is one of two constants, 0.2984 m or 0.858 of that). 13 file
names disagree with the bar; the metadata shows the names are wrong. About 47 s for 300 files over SMB on the CPU.
I re-ran the trial's code on the five samples in this repo's session: every field matched (for example `1 200 x`
read as 1200, `mag x HFW` = 0.2984 for four files and 0.2981 for the file whose bar prints `40×`), and the scale-bar
labels read as `100μm`, `500μm` and `3mm`. The lowest correct confidence was 0.60. **This replaces the evidence
table this section carried earlier,** which came from a cruder pipeline (own line splitting, no padding rules) and
showed dropped digits and wrong WD values; those were faults of that preparation, not of the recogniser.

A second trial ran every FEI-sized PNG, JPEG and BMP in SEM-named folders: 37 of 37 read cleanly (32 are
contrast-edited `*_contrasted.PNG`). The six with a same-name TIFF match it, except one JPEG whose bar says 10 kV and
whose TIFF namesake says 20 kV, which is a different capture under one name, not a misread. JPEG blur was not a
problem at these sizes. The two thresholds above had to become relative for the edited files; the TIFF result stayed
246/246. The bar's vertical position is fixed (the bottom 59 to 60 of 943 rows, 119 of 1887) but its columns are not
(120 bars showed 16 layouts, because cell widths follow the text), so the cells are still found from the dividers.
Most other PNG and BMP files in SEM folders are not exports at all (charts, 256x200 EDS thumbnails, phone photos);
expect "no bar" for them. The synthetic round-trip test in section 9 stays as the regression guard, and SEM2 checks the
real database.

**Dependency.** `rapidocr-onnxruntime==1.2.3` (the tested version) requires `opencv-python`, which is not the headless
build and needs system libraries the `python:3.12-slim` crawler image lacks; the install here is about 380 MB. The
plan must prove the import in that image and pick one of: `opencv-python-headless` with `--no-deps`, or the system
libraries. Models ship in the wheel, so nothing is downloaded at run time. Until the image carries it, `INBOX_OCR`
stays off and a bar-only image gets no values. **Open item:** switch `INBOX_OCR` on by default once the image
carries it and SEM2 passes.

### Value rules (all tiers)

Sanity ranges: `kv` 0.1 to 30, `working_distance_mm` 0.1 to 50, `magnification` 5 to 1,000,000, `spot` 1 to 10. A
value that fails them is omitted with a note. **OCR confidence is recorded in `sources` but never used as a
threshold.** The cross-checks: `mag x HFW` against the two screen-width constants (D3, within 2%, because a printed
`40×` is a rounded 40.05), and, for a bar with no metadata, the scale-bar label against the bar's pixel length and the
magnification. A value that cannot be cross-checked is saved with `flags.check_this = true`. When metadata and the
bar both exist (OCR switched on to cross-check), metadata wins and the mismatch is recorded in `flags`.

`extracted` (what the crawler already writes to `d1_private.file_candidates.extracted`) gets these keys:
`kv`, `spot`, `working_distance_mm`, `magnification`, `hfw_um`, `pixel_size_nm`, `scale_bar_um`, `detector`, `mode`,
`instrument`, `acquired_at` (ISO 8601 with offset), plus `sources` and `flags` objects. Unknown fields are
omitted, never null. The crawler session's rule (numeric, unit in the key) is followed; the string `scale_bar`
the JEOL path emits today becomes `scale_bar_um` too, which touches `parse_text` and its tests.

## 3. Data model

Migrations after 195, the latest when this was written (numbers taken at build time; `db-migration` skill). Reversible; COMMENT on everything.

- `directus_files.owner_person_id UUID NULL REFERENCES people (person_id) ON DELETE RESTRICT` and
  `owner_team_id UUID NULL REFERENCES teams (team_id) ON DELETE RESTRICT`, with
  `CHECK (num_nonnulls(owner_person_id, owner_team_id) <= 1)`. `RESTRICT`, not `SET NULL`: deleting an owner must
  not silently open their files. Members cannot change them: the Lab Member `create` and `update` field lists of `directus_files` leave both
  columns out (the pattern migration 193 uses for `people.uni_alias`); there is no trigger, because Directus uses one
  database role for every user, so a trigger cannot tell an administrator from a member. Indexed (`WHERE owner_person_id IS NOT NULL`, same for team). The migration **back-fills** both columns from
  `d1_private.file_candidates.owner_person_id` / `owner_team_id` (written by the crawler, exactly one per row by
  `file_candidates_one_owner_check`, so a trusted source, unlike the editable `archive_path`) for every candidate
  whose state is not `linked` (D10), so the rule holds at once for the files the live crawler has already
  registered, not only for the ones it meets later. Note the existing candidate FKs use `ON DELETE CASCADE` on
  the owner; the new columns deliberately differ (`RESTRICT`).
- `d1_private.file_candidates.classified_by TEXT` (new, nullable): the profile and version that set `kind`,
  `kind_confidence` and `extracted` (for example `sem-2`). A re-classification pass (section 7) skips rows already
  at the current version.
- `d1_private.sem_image_settings`, one row per file (`directus_files_id UUID PRIMARY KEY REFERENCES directus_files
  ON DELETE CASCADE`): `kv NUMERIC(6,2)`, `spot NUMERIC(4,1)`, `working_distance_mm NUMERIC(6,2)`,
  `magnification INTEGER`, `hfw_um NUMERIC(10,2)`, `pixel_size_nm NUMERIC(12,4)`, `scale_bar_um NUMERIC(12,3)`,
  `detector TEXT`, `mode TEXT`, `instrument TEXT`, `acquired_at TIMESTAMPTZ` (the clock is UK time, D5),
  `sources JSONB NOT NULL DEFAULT '{}'`, `flags JSONB NOT NULL DEFAULT '{}'`, `read_by TEXT NOT NULL` (the profile),
  `read_at`, `corrected_by UUID`, `corrected_at`. Check constraints on the ranges above. No audit trigger
  (derived bookkeeping, as `file_candidates`); the link itself is audited on its junction row.
- `d1_private.sem_settings_access_log` (`file_id`, `read_by_user`, `read_at`, `reason`): one row per administrator
  read of a file that is not theirs.

## 4. Who sees what (D7 to D10)

- **Stamping.** `scan.py`/`db.py` set the owner when they insert a pointer row for a file under `Users/<alias>`
  (the person whose `uni_alias` matches, as `owners.py` resolves it today) or `Shared/<folder>` (the team whose
  `share_folder` matches). They never overwrite an existing stamp. A pointer row the indexer already created and
  that has no links is stamped on the crawler's first encounter; a linked one is left alone (D10). The owner is a
  `person_id`, so an alias renamed or handed to someone else does not move the file.
- **Raw reads.** A Directus permission filter on `directus_files` for the Lab Member and Lab Viewer policies:
  rows with both owner columns null; or `owner_person_id` of the current user's person; or `owner_team_id` in
  their teams. The team test uses a readers table in the style of ADR-0014 if the relational filter is too slow
  (a plan task, with a test). `/assets/<id>` follows the same filter. Administrators are not filtered.
- **On a record.** A junction row (`sample_data_files`, `operation_data_files`, `session_data_files`) can point at
  a file the reader may not read. The record page shows a locked file: that a link exists, nothing else.
- **Settings.** `GET /d1-inbox/sem-settings?file=<id>` returns the row for the owner, the same row read-only for an
  administrator (and logs it), the row for anyone who may read an *unowned* file's record, and a locked-file
  answer (HTTP 200 with `locked: true`, no values) otherwise.
- **Correction.** `PATCH /d1-inbox/sem-settings/<id>` by the owner only, sets `sources.<field> = 'manual'`; a
  re-read (back-fill, a second scan) skips every manual field.

## 5. The d1-inbox changes (additive)

`core/extensions/d1-inbox/index.js`: `POST /link` and `POST /accept-all` write the `sem_image_settings` row from the
candidate's `extracted` inside the same transaction that marks the candidate linked, for `kind='sem_image'` only;
`POST /undo` deletes the row when no junction row of that file remains. The two new routes above are added. The
list, `FoundFile` shape and the golden fixtures do not change; `inboxContract.test.ts` and
`index.contract.test.mjs` get new fixtures, never edited ones. The crawler session asked to be told before this
extension is touched, and has been told it is coming.

## 6. The Inbox and record pages (STARbase)

`packages/starbase-pages/src/inbox`: a found SEM image shows its imaging settings (the `extracted` it already
shows), each with its source and a "check this" mark where flagged, and "couldn't read X" where a value failed
D3. Record pages show a linked image's settings for the owner and a locked file for others. The Inbox list
contract is not changed (section 5).

## 7. The crawler

- `classify_sem.py`: `FeiProfile` (section 1) and the shared value rules (section 2). The cell splitter, the recogniser
  bridge and the text parsing live in a new `sem_bar.py` beside it, pure functions of an in-memory image. `test_inbox_crawler_readonly.py`
  gets the new module on its import allow-list; nothing there touches a path.
- **Re-classification (amended).** Classification runs only when a file is first registered
  (`Scanner._new_file`), so fixing the detector changes nothing for the 1,586 rows already tagged. A new mode,
  `--reclassify`, re-reads image candidates in state `new` (and `dismissed`, so a restored file is right) whose
  `classified_by` is not the current version, reruns `classify_image` on the bytes read through
  `fs_readonly.open_rb`, and updates `kind`, `kind_confidence`, `extracted` and `classified_by`. It never touches
  a `linked` candidate's kind (undo bookkeeping), is resumable and throttled by `read_mb_per_s`, and demotes a false
  `sem_image` to `image` (its auto-link eligibility is unchanged: both kinds are on the auto-link list). It runs
  after the detector fix ships, started by the maintainer, and its counts (promoted, demoted, unchanged) are logged.
- `--sem-backfill` in `__main__.py`: a mode beside `--daemon` and `--once`. It lists pointer rows that are
  linked, image-typed, unowned and without a settings row, opens each through `fs_readonly.open_rb`
  (images are on the allow-list), reads it and writes `sem_image_settings`. Resumable, throttled by
  `read_mb_per_s`, an unreadable file is recorded and skipped.
- **GPU (D12).** `INBOX_OCR_DEVICE` selects the onnxruntime provider for the recogniser: `auto` takes CUDA when
  `onnxruntime-gpu` and a device are present and logs which it chose; `cpu` forces the CPU. The default container is
  CPU-only; a GPU needs a second pip line and a `docker-compose.gpu.yml` override with NVIDIA's runtime. It is low
  priority: the trial ran at about 0.16 s per file on a CPU and metadata-bearing TIFFs skip OCR, so only PNG, BMP and
  JPEG bars are read this way. What the host has (reported by the d1-server session): an RTX 5080 (16 GB,
  Blackwell), host Python with only Pillow and numpy, and Ollama with text-only models (no vision model). The crawler
  runs in `python:3.12-slim`, so CUDA must reach the container and `onnxruntime-gpu` must support Blackwell (CUDA
  12.8 or newer); that is **unverified** and is the optional item SEM4. `INBOX_OCR_DEVICE` is a new compose variable
  and an uncommented `INBOX_OCR_DEVICE=` line in `.env.example`.
- `rapidocr-onnxruntime` is pinned (`==1.2.3`, the version tested) and installed only when `INBOX_OCR=1`; see the
  dependency note in section 2 for the opencv problem in the slim image.

## 8. Error handling

A corrupt or oversized image stays a plain `image` (existing path). A decode that fails inside a profile loses
nothing: the other profiles still run. A bar whose cells cannot be split, a header that matches no known field, or a value that fails its format, range
or cross-check gives no value for that field and a note; it never guesses. A metadata block that parses badly gives the fields it
could parse and a `flags.metadata_error`. A share that drops, or an unreadable file, follows the crawler's
existing abort-and-skip rules. A link whose candidate has no usable settings still links (the settings row is
simply absent).

## 9. Testing

- **Fixtures.** Synthetic bars drawn in the test and the metadata text (values only) of the five samples; no research
  image is committed (the rule in `tests/scripts/test_inbox_crawler_classify.py`). Real bars are checked by SEM1, SEM2
  and the d1-server spike harness. Expected values from the metadata, checked against the printed bar for the OCR.
- **Round trips.** Strip the metadata, save as PNG, BMP and JPEG (several qualities), read, compare with the
  metadata values: every field must equal them, and a mismatch is a test failure, not a flag. Include the maintainer's
  real PNG exports against their TIFFs' metadata.
- **Rules.** Ranges, the scale-bar and magnification checks, the DST edge (the repeated hour, the skipped hour),
  the thin-space thousands separator, `x` and `×`, `µ` and `μ`, a layout without `det`, the 2× bar, and the
  scale-bar line that a full-width row mean mistakes for a divider.
- **Visibility** (`tests/phase1_schema.sh` style and Postgres-backed script tests): owner, non-owner, team member,
  administrator (read and logged), an unowned file, a moved file, an alias handed to someone else, an attempt by
  a Lab Member to change the owner column, `/assets` for an owned and an unowned file.
- **Endpoints and contracts.** `link`, `accept-all`, `undo` (including a file linked twice), the two new routes,
  and the replayed golden fixtures.
- Lint with `ruff` 0.6.9 (pre-commit pins it).

## 10. Rollout

d1-server first (migration, `d1-inbox`), then STARbase, then the crawler, as the inbox feature itself. The
`--reclassify` and `--sem-backfill` runs are the maintainer's to start. The crawler is live, so the build order is
the d1-server session's suggestion, which this spec adopts: (1) the detector fix (FEI metadata check, bar structure,
the optical-microscope negative) with tier 1 metadata, then `--reclassify` to clear the false positives; (2) cell-split
OCR, validated against the metadata of the same TIFFs and then their PNG exports; (3) the migration (owner columns and back-fill,
`sem_image_settings`, `classified_by`), the `d1-inbox` changes and the STARbase pages; (4) the owner filter on
`/assets`; (5) `--sem-backfill`. TIFFs with metadata work on day one; PNG, BMP and JPEG bars wait for the OCR tier and for
rapidocr to be installable in the crawler image (section 2).

## 11. Surface scans and the other session

Making surface scans private reverses ADR-0021, migration 192's lab-member rules, the `d1-surface-scan` endpoint and
the CONTEXT.md line "Adding it makes the file visible to every lab member". The maintainer chose a **separate stream**,
run by the surface-scan session on top of the owner stamp (D7), after this one lands. Both peer sessions were told.
Until then scans keep ADR-0021's behaviour, except that a scan's *file* may become locked once it is owned.

## Physical test backlog (added to `docs/runbooks/physical-test-backlog.md` by the implementing PRs)

- **SEM1 — FEI TIFFs through the real crawler.** Put the five samples in a real personal folder, scan, expect each
  tagged "possible SEM image" with the settings above, link one, expect the settings saved and visible only to you.
- **SEM2 — PNG/BMP/JPEG exports.** Run real exports from the instrument software; expect the OCR values to equal
  the printed bar (and the TIFF metadata of the same image), and any doubtful one flagged.
- **SEM3 — Two accounts.** Link a file to a sample both can read; expect the second account sees a locked file and
  cannot open `/assets/<id>`; an administrator sees it read-only and the log gains a row.
- **SEM4 — GPU (optional).** On the crawler host, `INBOX_OCR_DEVICE=auto` with a real NVIDIA device and Docker GPU passthrough;
  expect the log to say it chose CUDA, and the back-fill to run faster than on the CPU; note the card.
- **SEM6 — Re-classification on the real database.** After the detector fix, run `--reclassify`; expect the
  logged promoted, demoted and unchanged counts, the maintainer's six FEI TIFFs (and their PNG exports) tagged
  `sem_image`, and the thermal-camera JPEGs, "Microscope x20" optical TIFFs and EDS maps back to `image`.
- **SEM5 — The back-fill.** `--sem-backfill` on the real database; expect it resumable and the unowned settings visible to record readers.

## Open items for review

- `ON DELETE RESTRICT` on the owner columns means a person with owned files cannot be deleted; confirm "deactivate
  instead" is acceptable, or choose a different rule.
- The Directus filter's team test may need a readers table (ADR-0014 pattern); decided in the plan with a measurement.
- A linked junction row still exposes the file's id to a non-owner; the placeholder hides the name and values but
  not that a link exists. Accepted by D9.
- PNG, BMP and JPEG bars read cleanly on the maintainer's real exports (37 of 37); SEM2 repeats it on the real database.
- `rapidocr-onnxruntime` needs `opencv-python` and about 380 MB; whether it imports in `python:3.12-slim` and which
  fix to take is a plan task.
- **Decided 2026-10-16 (maintainer):** D2 cell-split OCR replaces glyph matching; D12 the GPU switch stays optional;
  the positive-evidence rule demotes every bar-only JEOL claim to `image`; D10 stamping of unlinked found files
  stays inside Directus (the `directus_files` pointer rows; nothing is written to the share).
- Whether `onnxruntime-gpu` runs on the RTX 5080 inside the crawler container (optional SEM4).
- The JEOL profile remains unvalidated (backlog IF8).
