# ADR-0024 — Conform is its own process category

- **Status:** Accepted
- **Date:** 2026-10-21
- **Deciders:** Maintainer + Claude (Conform runs)

## Context

The lab's Conform machine performs continuous rotary extrusion. In the existing model an extrusion is a
`deformation` operation with `deform_deformation_type = 'extrusion'`, and the Conform machine is seeded
with the `deformation` capability (migration `20260703000056_seed_equipment.sql`).

A Conform run differs from the other deformation operations:

- It has its own parameters: feedstock form and mass, die, tooling, extrusion length and mass, and yield.
- It has a machine log that is shared between runs.
- It has derived energy and steps.
- It has its own plotter.

Across STARbase the choice of panel, plotter link, key settings, Parameters-panel prefix and code rule
is made on `manufacturing_operations.process_category`, a scalar. It is a scalar because Directus field
conditions cannot read through the method M2O (migration `20260623000031_process_category.sql`).

## Decision

Conform runs get a new process category, **`conform`**, with method code **`CF`**:

- `conform` is added to the `process_category` CHECKs on `manufacturing_operations` and
  `manufacturing_methods`.
- The Conform machine gains the `conform` capability.
- The parameters are inline `conform_*` columns, in a `grp_conform` form group.
- Every per-category switch gets a `conform` entry, as each existing category has.

Spec: [`2026-10-21-conform-runs-design.md`](../superpowers/specs/2026-10-21-conform-runs-design.md).

## Alternatives considered

- **Keep Conform under `deformation`, with a new method code.** This means less schema change. But every
  switch that picks a panel, plotter or key settings would also have to test the method. The Conform
  fields would sit under the forging, rolling and extrusion group, with conditions on two fields. And
  the process map's per-category key settings could not tell a Conform run from a rolling pass.
- **A sub-type field on deformation** (`deform_deformation_type = 'conform'`). This has the same switching
  problem, and it hides a machine-specific workflow behind a free choice list.

## Consequences

- **Easier.** Conform behaves like FAST (`sintering`) everywhere a category is switched on, with no
  special cases.
- **Harder.** Each new category touches about a dozen enumerations:
  - the two CHECKs, `PROCESS_LABEL`, `CAT_LABEL`
  - `OPERATION_PARAM_PREFIX`
  - the map's `ProcessCategory`, `CATEGORIES` and `KEY_SETTING_FIELDS`
  - `operation_code_for()`, the genealogy trigger, `tests/phase1_schema.sh`

  The spec lists them.
- **Old records.** Any older Conform extrusions recorded as `deformation` stay as they are. Moving them
  is a manual edit (change the method to CF), not a migration.
- **The machine stays a deformation machine as well.** It keeps the `deformation` capability, so those
  old records remain valid.

## Verification

- `tests/phase1_schema.sh` asserts the method → category map, including `CF → conform`.
- The STARbase unit tests cover `analysisLink(…, 'conform')`, `KEY_SETTING_FIELDS.conform` and the
  `dataPreview` kind.

## References

- Migrations `20261022000206_conform_category.sql`, `…207_conform_logs_and_run_data.sql`,
  `…208_conform_form_layout.sql`
- ADR-0004 (JSONB for dynamic method parameters, superseded by the inline columns)
- `CONTEXT.md`: Conform run, Conform log, Run window, Step
