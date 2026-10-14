# Form layout and stored values (2026-10-14)

Follows the form QA (`form-qa-report.html`, draft PR #278, migration 173). Decisions were taken in a grilling
session with the maintainer on 2026-10-14; they are listed here in full, so no stream needs that conversation.
Vocabulary: **Sample**, **Field group** (see `CONTEXT.md`). Nothing is applied to live; the maintainer reviews
the forms on the `d1-formqa` preview copy (port 18058) before anything merges.

## Status

| Stream | Worktree | Branch | Base | State |
|---|---|---|---|---|
| M — form metadata (migration 174, configure scripts, specs) | `.claude/worktrees/form-layout-meta` | `feat/form-layout-meta` | `feat/form-layout` | started |
| C — code (labels table, coupon presets, Force App list check, retire importer) | `.claude/worktrees/form-layout-code` | `feat/form-layout-code` | `feat/form-layout` | started |
| D — stored values (migration 175, data) | `.claude/worktrees/form-values` | `data/form-values` | `feat/form-layout` | started |

PR A = `feat/form-layout` (M + C merged in), stacked on #278. PR B = `data/form-values`, stacked on PR A.

## Decisions

1. **Sample is the record.** `physical_samples.item_type` is hidden in the form and defaults to `sample` in the
   database (column default, so STARbase's Register-sample screen and every API caller get it); the 4 rows with
   NULL are set to `sample`. The 16 `equipment` rows (rig kit) stay as they are; moving them to Inventory is a
   later job.
2. **Field groups**: headed, always open (`group-detail` with `start: open`), except **Related records**
   (collapsed, and hidden until the record has been saved once) and **Legacy / system** (collapsed). Every group
   field needs `special = 'alias,no-data,group'`; a conditional group has base `hidden = false` and a "hide
   unless" condition (memory: directus-conditional-groups).
3. **Group order on every record form**: What → Who & where → type-specific groups (parameters before
   results) → Notes & files → Related records → Legacy / system. No two fields in the same parent share a sort.
4. **Scope**: full regrouping of Sample, Operation, Test, Project, Campaign, Raw stock lot. Inventory and Reference
   forms (tools, equipment, insert types, cutting inserts, …) only get their tied sorts made unique.
5. **Co-owners** (sample) and **Secondary Investigators** (project) are not shown to Lab Members (field
   permissions on the Lab Member policy); members share through STARbase's Who has access dialog (ADR-0014).
   Admins and Lab Admins still see them.
6. **Legacy fields**: removed from the forms (hidden, columns kept): every test field among Capture Software,
   Capture Frequency, Raw Data File URI, Data File URI, File Size, Data File Size, Summary Statistics, Plot URIs
   (no live test uses them); operation G-code file and Experiment Sheet URL (never filled). The remaining
   operation legacy fields (Legacy Edge ID, Legacy Machining UID, Force File URI, Capture Software, Capture
   Frequency, NC Program text) go in **Legacy / system** and each shows only when it has a value (a condition on
   the field itself).
7. **Campaign → Project**: `project_id` on operations and tests uses `d1-project-inherit` (as
   `configure_campaigns.sql` already says). The Campaign picker is not filtered by campaign type.
8. **Choices** (stream M; the data conversions are stream D):
   - Geometry: unchanged list; label "Tensile coupon (ISO 6892)" everywhere.
   - Surface Finish: add **As produced** (`as_produced`) and **Medium machined** (`medium_machined`, between
     rough and finish).
   - Equipment Type: the 29 stored values become the choices, with readable labels (value `Sample_Prep`, text
     "Sample prep"); stored values unchanged (the Force App filters on the exact value `Machining`); AM dropped.
   - Insert type `op_type`: label **Application**, choices Finishing / Medium / Roughing.
   - Tools: Op Type adds Parting; Shank Type adds Square and Other.
   - Machining sub-type: drop "Other"; the list is exactly the Force App's 12 MT-/MM- codes.
9. **Dimension labels**: Diameter Ø, Inner diameter Ø, Width, Thickness, Length, Gauge length, Gauge width (mm in
   the input suffix); the axis (x width, y thickness, z length) goes in each field's note.
10. **Collection names** in Data Studio: Samples, Operations, Tests (display names only).
11. **Required in the form** (`directus_fields.required` / condition `required`, which Directus 11 checks in the
    form only, not on API saves — verified on the copy):
    Sample: Material, Manufacturing method, Geometry (when Item Type is sample);
    Operation: Method, Date, and Input sample when Process Category is machining;
    Test: Test Type, Date.
12. **One sub-type list**: a test fails when the Directus choices and the Force App lists
    (`MachineOperatorPanel.vue`, `EditCaptureMetadataDialog.vue`) and `force-plotting`'s list differ.
13. **Labels, not codes**: STARbase pages and the PDF report show choice labels for Geometry, Surface Finish,
    Equipment Type, sub-type, from one table in `@d1/ui` that `d1-report` also uses.
14. **`scripts/migrate_legacy.py` is retired**: it refuses to run without `--i-know-this-is-retired`; the demo seed
    uses the new values.
15. **Coupon presets**: picking Tensile coupon (or Bend bar) offers a "Standard" choice that fills the
    dimensions: ASTM E8/E8M sheet (G 50, W 12.5, L 200, grip 20), ASTM E8/E8M subsize (G 25, W 6, L 100, grip
    10), ISO 6892-1 type 1 (L0 50, b0 12.5, L 200, grip 20), ISO 6892-1 type 2 (L0 80, b0 20, L 250, grip 30);
    thickness is left to the user. In the Data Studio form (the geometry preview interface) and on STARbase's
    Register-sample screen. Values to be checked against the standards by the maintainer.

## Form specs (stream M)

Labels in quotes; `→` means "shown when". Type-specific groups carry the discriminator condition on the group.

**Sample**: What ("Sample Code", "Nickname", "Status") · Material & origin (Material*, Manufacturing method*,
Stock Category, Manufacturing Date) · Geometry (Geometry*, Weight, the dimension fields in the order Diameter,
Inner diameter, Width, Thickness, Length, Gauge length, Gauge width, Shape Preview full width) · Surface &
mounting (Surface Finish, Mounted?, Mounting Method → mounted) · Who & where (Owner, Project, Co-owners,
Location, Export Controlled?) · Notes · Related records (Campaigns, Operations as input, Produced by, Child
samples, Test sessions, Linked data files, Open/copy linked files) · Legacy / system (Short ID, Created by,
created/updated). Item Type hidden. Report buttons stay first.

**Operation**: What (Method*, Process Category, Input sample (*machining), Output sample, Date*, Operation
Sub-type → machining, Operation Code full width) · Who & where (Machine, Operator, Owner, Additional operators,
Campaign, Project) · Tooling → machining (Tool, Insert Edge, New Edge Used?, Material) [Material sits in Who &
where for other categories if simpler; it must appear once] · Cutting parameters → machining (pass #,
spindle speed, Vc, feed, ap, ae, cutting length, workpiece Ø, coolant used/pressure, chips collected/ref) · Data
capture → machining (Force Data Captured?, Tachometer Used?) · one group per other category (Sintering —
keep its two existing groups inside it —, Heat treatment, Deformation, Additive, Sample preparation (prefill +
steps)) · Notes & files (Outcome notes, NC program upload if any, Data File Links) · Related records (Force
Analyses → machining, Fast Run → sintering, Open/copy linked files) · Legacy / system (the legacy fields of
decision 6, Short ID, Created by).

**Test**: What (Test Type*, Test Category, Subject full width, Session Date*, Status) · Who & where (Machine,
Operator, Owner, Additional operators, Campaign, Project) · "<Type> parameters" and "<Type> results" groups per
test type (results = measured outcomes: e.g. hardness mean/std/min/max, tensile Rp0.2/UTS/A%/Z%/E/fracture
mode; list the split per type in the migration comment) · Notes & files (Notes, Linked Data Files) · Related
records (Open/copy linked files) · Legacy / system (Test Code, Short ID, Created by; legacy fields hidden).

**Project**: What (Project Name*, Project Code, Active?, Start, End, Description, Image) · Who (Principal
Investigator, Secondary Investigators + its notice, Export Controlled?) · Related records (Campaigns, Project
Items, Rollup) · Legacy / system (Created by).

**Campaign**: What (Name*, Campaign Type*, Campaign Code, Status, Start, End) · Who & where (Project, Owner) ·
Notes · Related records (Samples, Campaign Operations) · Legacy / system (Created by).

**Raw stock lot**: What (Lot Code*, Stock Type*, Material, Received Date) · Supplier (Supplier, Supplier Part #,
Certificate URL) · Quantity (Inbound Mass*, Remaining Mass*, Purity %, Mesh Size µm → powder) · Export
Controlled? · Notes. The certificate, purity and mesh columns have no `directus_fields` rows today (they render
first with raw names): add them.

## Verification

- `ROUNDTRIP=1 bash scripts/dev/schema_test_docker.sh`: no FAIL lines (phase1 gains checks for: no tied sorts in
  the six collections, every group renderable, every stored value of a dropdown is a choice — the last one on a
  copy only).
- UI specs 01–09, 17 on the preview copy with the migrations applied (labels updated in the specs), plus a census of
  every create form as admin and Lab Member (field order per group, no console errors).
- `npm test -w @d1/ui`, typechecks, `npm run build:extensions`, `npm run build:starbase`, `scripts/sync_geometry.sh --check`.
