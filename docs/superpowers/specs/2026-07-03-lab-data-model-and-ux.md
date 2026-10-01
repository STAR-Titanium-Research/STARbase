# Lab data-model & UX overhaul — design

**Date:** 2026-07-03
**Status:** Implemented 2026-07-03 — all five sub-projects shipped as migrations
`20260703000054`–`20260703000066`, the `d1-equipment-code` hook and the facility → machine
cascade in `d1-machine-picker`.
**Author:** Claude (Opus 4.8), reviewed by maintainer

## Context

A batch of bugs/requests surfaced that cluster into five sub-projects touching
the durable schema, Directus config, and custom extensions. Several change
**production data** (13 users, live test sessions, real equipment), so this spec
records the agreed approach before implementation. Four architectural decisions
were locked with the maintainer (below). Each sub-project ships as its own
migration(s) + extension changes + tests, in the sequence at the end.

### Locked decisions
1. **People** → one `people` table; operator/researcher/owner all reference it;
   optional `user_id` link to a Directus login (operators aren't always app users).
2. **Testable subject** → Directus **many-to-any (M2A)**: one `subject` on a test
   that can point to a `physical_sample`, `insert_edge` (or future targets),
   replacing separate `sample_id` + `insert_edge_id`.
3. **Facilities** → a `facilities` reference table; `equipment.facility_id` FK.
4. **Machine scope** → import all 49 machines (facility, capabilities, image URLs)
   and research settings **per process/test method** to fill missing param fields;
   deep per-machine specs deferred.

---

## ⑤ Equipment code auto-gen  *(quick win — no schema change)*

**Problem:** new `equipment` (and misc items) get no `equipment_code`.
**Approach:** a small hook extension `d1-equipment-code` — on `items.create` for
`equipment`, if `equipment_code` is empty, set a **6-char uppercase alphanumeric**
code (Crockford-style, excluding ambiguous `0/O/1/I`), retrying on the unique
index. Same pattern as `owner-cascade`/`d1-operation-code` hooks.
**Test:** create equipment without a code → gets a unique 6-char code; provided
codes are left untouched.

## ④a Fix broken Imaging/Physical bookmarks  *(quick win)*

**Problem:** `test_sessions` presets filter `test_category _contains 'Imaging'` and
`'Dynamic'`; they return nothing because the `test_category` taxonomy changed.
**Approach:** inspect current `test_category` values, correct the two preset
filters (and rename "Physical" if it should track a different category).
**Test:** each bookmark returns the expected rows.

## ② Machines: facilities + import + capabilities + tiered picker  *(foundational)*

Fixes the "NLX-only" filter (6), enables the tiered picker (8), imports the CSV (7).

- **`facilities` table** (migration): `facility_id`, `name`, `code`, `notes`.
  Seed the 5 facilities (Sorby Centre, Royce Discovery/Translational, Metallography,
  Mechanical Testing).
- **`equipment.facility_id`** FK → facilities. Add `equipment.image_url` (text) for
  externally-sourced photos (keep the existing `image` file field for uploads).
- **Import** `scripts/data/master_lab_equipment_list.csv` (idempotent seed):
  `equipment_name`, `facility_id`, inferred `equipment_type`, `capabilities`
  (mapped to the methods each machine supports so the picker filters correctly),
  `image_url` (researched online), 6-char `equipment_code`.
- **Capabilities → methods:** e.g. SEMs → `sem`/imaging; Zwick/Hounsfield →
  `tensile`/`compression`; dilatometer → `dilatometry`; etc. This is what fixes the
  NLX-only filter.
- **Tiered picker:** extend `d1-machine-picker` (or a new interface) to cascade
  **facility → machine**, like Directus's grouped filter dropdowns.
- **Test:** picking a method shows all capable machines (not just NLX); picking a
  facility narrows the machine list; `phase*`-style checks assert facilities +
  equipment counts.

## ① People unification  *(schema refactor — production data)*

- **`people` table** (migration): `person_id`, `full_name`, `email` (nullable),
  `user_id` FK → `directus_users` (nullable, for app users), `is_operator`,
  `is_researcher`, `active`, `notes`.
- **Migrate:** `Machine_Operators` rows → `people` (operators); distinct `owner`
  users → `people` (linked via `user_id`); dedupe by email/name.
- **Repoint FKs** to `people`: `manufacturing_operations.operator`,
  `test_sessions.operator`, then the `owner` fields (`physical_samples.owner`,
  `manufacturing_operations.owner`, `campaigns.owner`, `test_sessions.owner`, …) —
  done as staged migrations with an explicit old→new mapping, keeping a backup
  column until verified. Retire `Machine_Operators`.
- **Directus:** a `people` collection (nice display template); operator/owner
  fields become M2O → people; one "add a person" flow reused everywhere.
- **Test:** `phase*`-style assertions that every operator/owner FK resolves to a
  person; no orphaned references; a person can be operator + researcher + owner.

## ③ Testable subject (polymorphic M2A)  *(schema refactor — production data)*

- **M2A relation** `subject` on `test_sessions` targeting `physical_samples` +
  `insert_edges` (Directus junction `test_sessions_subject` with `collection` +
  `item`). Extendable to future testable collections.
- **Migrate:** existing `sample_id` → subject(`physical_samples`);
  `insert_edge_id` → subject(`insert_edges`); keep the old columns until verified,
  then drop from the form (retain as nullable for rollback, or drop in a follow-up).
- **UI:** the M2A interface gives one browsable "Subject" picker; remove the
  separate sample / insert-edge fields from the test form.
- **Test:** existing sessions keep their subject; a new test can target a sample
  **or** an insert edge from one picker.

## ④b Per-method test fields  *(depends on ② research)*

- Add inline param fields (+ conditional display by `test_type`) for the methods
  currently missing them: `tribology`, `optical_microscopy`, `tem`, `alicona`,
  `clemx`, `dct`, `ct_scan`, `fatigue`, `creep`, `dma`. Fields chosen from the
  per-method settings researched in ②.
- Follows the existing inline-param pattern (`configure_inline_params.sql` +
  `flatten_param_fields.py`), conditional on the `test_type` discriminator.
- **Test:** picking each method reveals its fields; UI spec extends
  `02-test-session-conditional-params`.

---

## Sequencing & risk

1. **⑤ equipment code** + **④a bookmarks** — safe quick wins, no production-data risk.
2. **② machines** — mostly additive (new facilities table, equipment rows, picker).
3. **① people** — highest-risk (repoints owner/operator across many tables); staged
   migrations, backup columns, verify before dropping `Machine_Operators`.
4. **③ subject M2A** — migrates test sessions to the junction; keep old columns until verified.
5. **④b per-method fields** — additive, informed by ②.

**Production-data safety:** ① and ③ mutate live rows — each does a reversible,
staged migration (add new structure, backfill, verify, then retire old), never a
destructive one-shot. All changes are dbmate migrations + config-as-code so a
redeploy reproduces them.
