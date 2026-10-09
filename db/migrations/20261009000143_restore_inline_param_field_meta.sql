-- migrate:up
-- Restore the Directus field metadata that a stray run of scripts/configure_directus.sql erased.
--
-- What happened. Between 2026-07-05 and 2026-09-30 scripts/configure_directus.sql was run on its own
-- against the live database. Its blanket DELETE FROM directus_fields for the collections it owns
-- removed every field row of manufacturing_operations, test_sessions, projects and the rest, and
-- scripts/configure_inline_params.sql (which re-creates the inline parameter fields) was not run
-- afterwards. Nothing in the data changed; only the Directus form and Explorer metadata went.
-- The loss was found when the "Log an operation" and test forms showed every parameter field
-- ungrouped at the top and the Explorer pages had lost their labels and units. What was missing:
--   * the 56 inline parameter columns of manufacturing_operations (machining_*, sintering_*, ht_*,
--     deform_*, am_*) and the 60 of test_sessions (tensile_*, hardness_*, charpy_*, compression_*,
--     sem_*, xrd_*) had no directus_fields row;
--   * migration 20260722000101's two sintering group rows survived but had no members except
--     fast_recipe_id, and migration 20260723000102's hidden flag on sintering_recipe_number went
--     with its row;
--   * four parent-side alias fields: manufacturing_operations.prep_steps, .source_recipe_id and
--     .data_file_links, and projects.rollup (their relation rows were still there, except the one
--     for manufacturing_operations.source_recipe_id -> prep_recipes).
--
-- Why a migration and not "run the scripts again". configure_directus.sql is a stale baseline: run
-- again it wipes the field rows that later migrations (062, 126, 141 and others) own, a second time.
-- The scripts cannot restore just the missing rows, and their DELETE-then-INSERT shape is exactly
-- what caused this. The schema is the contract (ADR-0001), so the repair goes in as a migration
-- that only adds what is missing.
--
-- The rule for "already present". Every row is inserted only if no directus_fields row with the
-- same (collection, field) exists (for the relation: none with the same many_collection and
-- many_field). A row that is there is left exactly as it is, correct or not: nothing is updated
-- or deleted unless this migration inserted it (the one exception is group membership and the
-- hidden flag, sections 3 and 4, which fill only a NULL group / an un-hidden flag). That makes `up`
-- safe to run on
--   * the live database, where the rows are missing and all of them are inserted;
--   * a database where configure_all.sh ran (the rows exist): nothing is inserted;
--   * a partly repaired database: only the gaps are filled;
--   * CI, which has no Directus bootstrap: the rows are inserted, then rolled back by the CI loop.
-- It never touches the rows of other migrations; in particular the d1-owner-picker interface that
-- migration 126 sets on every owner_person_id is neither read nor written here.
--
-- Where the row contents come from. The 116 inline parameter rows are the INSERTs of
-- scripts/configure_inline_params.sql, copied verbatim into a temporary staging table, then given
-- the five dropdown presets of scripts/configure_field_presets.sql (its UPDATEs, applied to the
-- staging table). Only those two scripts and migrations 101 and 102 write to these 116 fields (no
-- other migration updates a row of them), so staging + presets + 101 + 102 is the state the
-- database had before the incident. The group membership and the hidden flag are applied the way
-- 101 and 102 apply them (sections 3 and 4). The alias rows and the relation are the statements of
-- scripts/configure_sample_prep.sql, configure_operation_files.sql and configure_project_rollup.sql.
-- The three o2m aliases are inserted only when their relation row exists, because an o2m alias
-- without its relation breaks the Directus form.
--
-- Bookkeeping for `down`. Every row `up` inserts or changes is recorded in
-- d1_private.restore_inline_param_meta_changes (the pattern of migration 141), so `down` undoes
-- only what `up` did here and never a row that was already there.
--
-- Not restored here: relations whose alias field row has never existed
-- (manufacturing_methods.operations, raw_stock_lots.provenance).
-- After applying to a running stack, flush Redis and restart Directus (it caches the field list).

CREATE SCHEMA IF NOT EXISTS d1_private;
COMMENT ON SCHEMA d1_private IS
    'Internal bookkeeping of migrations (backups they restore in `migrate:down`). Not exposed by Directus (outside its schema scan) and not granted to d1_llm_readonly; not in v_schema_dictionary.';

CREATE TABLE IF NOT EXISTS d1_private.restore_inline_param_meta_changes (
    kind       TEXT NOT NULL CHECK (kind IN ('field_row', 'relation_row', 'group_set', 'hidden_set')),
    collection TEXT NOT NULL,
    field      TEXT NOT NULL,
    row_id     INTEGER,
    PRIMARY KEY (kind, collection, field)
);
COMMENT ON TABLE d1_private.restore_inline_param_meta_changes IS
    'Migration 20261009000143: the Directus metadata it inserted or changed (field_row/relation_row: the directus_fields/directus_relations row it inserted, with its id; group_set: a member it put into a sintering group; hidden_set: a field it hid). `migrate:down` undoes exactly these and drops the table.';

-- 1. The 116 inline parameter field rows.
-- Staged in a temporary table so the rows are a verbatim copy of the generator script's INSERTs and
-- the presets can be applied before anything touches directus_fields. No id, no default columns.
CREATE TEMPORARY TABLE d1_inline_param_stage AS
SELECT collection, field, special, interface, options, display, display_options, readonly, hidden,
       sort, width, required, translations, note, conditions
FROM directus_fields
WHERE FALSE;

-- The generator script's INSERTs, retargeted at the staging table (scripts/configure_inline_params.sql).
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'tensile_specimen_geometry', NULL, 'select-dropdown', '{"choices": [{"text": "Dog bone", "value": "dog_bone"}, {"text": "Waisted", "value": "waisted"}, {"text": "Flat", "value": "flat"}, {"text": "Round", "value": "round"}, {"text": "Other", "value": "other"}]}', 'labels', NULL, FALSE, TRUE, 100, 'half', FALSE, '[{"language": "en-US", "translation": "Specimen Geometry"}]', NULL, '[{"name": "show when tensile", "rule": {"_and": [{"test_type": {"_eq": "tensile"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'tensile_gauge_length_mm', NULL, 'input', '{"step": 0.01, "suffix": "mm"}', 'raw', NULL, FALSE, TRUE, 101, 'half', FALSE, '[{"language": "en-US", "translation": "Gauge Length"}]', NULL, '[{"name": "show when tensile", "rule": {"_and": [{"test_type": {"_eq": "tensile"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'tensile_gauge_diameter_mm', NULL, 'input', '{"step": 0.001, "suffix": "mm"}', 'raw', NULL, FALSE, TRUE, 102, 'half', FALSE, '[{"language": "en-US", "translation": "Gauge Diameter"}]', NULL, '[{"name": "show when tensile", "rule": {"_and": [{"test_type": {"_eq": "tensile"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'tensile_gauge_width_mm', NULL, 'input', '{"step": 0.001, "suffix": "mm"}', 'raw', NULL, FALSE, TRUE, 103, 'half', FALSE, '[{"language": "en-US", "translation": "Gauge Width"}]', NULL, '[{"name": "show when tensile", "rule": {"_and": [{"test_type": {"_eq": "tensile"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'tensile_gauge_thickness_mm', NULL, 'input', '{"step": 0.001, "suffix": "mm"}', 'raw', NULL, FALSE, TRUE, 104, 'half', FALSE, '[{"language": "en-US", "translation": "Gauge Thickness"}]', NULL, '[{"name": "show when tensile", "rule": {"_and": [{"test_type": {"_eq": "tensile"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'tensile_crosshead_speed_mm_per_min', NULL, 'input', '{"step": 0.001, "suffix": "mm/min"}', 'raw', NULL, FALSE, TRUE, 105, 'half', FALSE, '[{"language": "en-US", "translation": "Crosshead Speed"}]', NULL, '[{"name": "show when tensile", "rule": {"_and": [{"test_type": {"_eq": "tensile"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'tensile_strain_rate_per_s', NULL, 'input', '{"step": 1e-06, "suffix": "s\u207b\u00b9"}', 'raw', NULL, FALSE, TRUE, 106, 'half', FALSE, '[{"language": "en-US", "translation": "Strain Rate"}]', NULL, '[{"name": "show when tensile", "rule": {"_and": [{"test_type": {"_eq": "tensile"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'tensile_test_temp_celsius', NULL, 'input', '{"step": 0.1, "suffix": "\u00b0C"}', 'raw', NULL, FALSE, TRUE, 107, 'half', FALSE, '[{"language": "en-US", "translation": "Test Temperature"}]', NULL, '[{"name": "show when tensile", "rule": {"_and": [{"test_type": {"_eq": "tensile"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'tensile_extensometer_used', 'cast-boolean', 'toggle', NULL, 'boolean', NULL, FALSE, TRUE, 108, 'half', FALSE, '[{"language": "en-US", "translation": "Extensometer Used?"}]', NULL, '[{"name": "show when tensile", "rule": {"_and": [{"test_type": {"_eq": "tensile"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'tensile_yield_strength_mpa', NULL, 'input', '{"step": 0.01, "suffix": "MPa"}', 'raw', NULL, FALSE, TRUE, 109, 'half', FALSE, '[{"language": "en-US", "translation": "0.2% Yield Strength (Rp0.2)"}]', NULL, '[{"name": "show when tensile", "rule": {"_and": [{"test_type": {"_eq": "tensile"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'tensile_uts_mpa', NULL, 'input', '{"step": 0.01, "suffix": "MPa"}', 'raw', NULL, FALSE, TRUE, 110, 'half', FALSE, '[{"language": "en-US", "translation": "UTS (Rm)"}]', NULL, '[{"name": "show when tensile", "rule": {"_and": [{"test_type": {"_eq": "tensile"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'tensile_elongation_pct', NULL, 'input', '{"step": 0.01, "suffix": "%"}', 'raw', NULL, FALSE, TRUE, 111, 'half', FALSE, '[{"language": "en-US", "translation": "Elongation at Break (A%)"}]', NULL, '[{"name": "show when tensile", "rule": {"_and": [{"test_type": {"_eq": "tensile"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'tensile_reduction_of_area_pct', NULL, 'input', '{"step": 0.01, "suffix": "%"}', 'raw', NULL, FALSE, TRUE, 112, 'half', FALSE, '[{"language": "en-US", "translation": "Reduction of Area (Z%)"}]', NULL, '[{"name": "show when tensile", "rule": {"_and": [{"test_type": {"_eq": "tensile"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'tensile_youngs_modulus_gpa', NULL, 'input', '{"step": 0.01, "suffix": "GPa"}', 'raw', NULL, FALSE, TRUE, 113, 'half', FALSE, '[{"language": "en-US", "translation": "Young''s Modulus (E)"}]', NULL, '[{"name": "show when tensile", "rule": {"_and": [{"test_type": {"_eq": "tensile"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'tensile_fracture_mode', NULL, 'input', NULL, 'raw', NULL, FALSE, TRUE, 114, 'half', FALSE, '[{"language": "en-US", "translation": "Fracture Mode"}]', NULL, '[{"name": "show when tensile", "rule": {"_and": [{"test_type": {"_eq": "tensile"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'hardness_hardness_scale', NULL, 'select-dropdown', '{"choices": [{"text": "Vickers (HV)", "value": "HV"}, {"text": "Rockwell C (HRC)", "value": "HRC"}, {"text": "Rockwell B (HRB)", "value": "HRB"}, {"text": "Brinell (HB)", "value": "HB"}, {"text": "Knoop (HK)", "value": "HK"}, {"text": "Shore A", "value": "Shore_A"}, {"text": "Shore D", "value": "Shore_D"}]}', 'labels', NULL, FALSE, TRUE, 140, 'half', FALSE, '[{"language": "en-US", "translation": "Hardness Scale"}]', NULL, '[{"name": "show when hardness", "rule": {"_and": [{"test_type": {"_eq": "hardness"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'hardness_load_gf', NULL, 'input', '{"step": 0.1, "suffix": "gf"}', 'raw', NULL, FALSE, TRUE, 141, 'half', FALSE, '[{"language": "en-US", "translation": "Test Load"}]', NULL, '[{"name": "show when hardness", "rule": {"_and": [{"test_type": {"_eq": "hardness"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'hardness_dwell_time_s', NULL, 'input', '{"step": 0.1, "suffix": "s"}', 'raw', NULL, FALSE, TRUE, 142, 'half', FALSE, '[{"language": "en-US", "translation": "Dwell Time"}]', NULL, '[{"name": "show when hardness", "rule": {"_and": [{"test_type": {"_eq": "hardness"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'hardness_indenter_type', NULL, 'input', NULL, 'raw', NULL, FALSE, TRUE, 143, 'half', FALSE, '[{"language": "en-US", "translation": "Indenter Type"}]', NULL, '[{"name": "show when hardness", "rule": {"_and": [{"test_type": {"_eq": "hardness"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'hardness_n_indentations', NULL, 'input', '{"step": 1}', 'raw', NULL, FALSE, TRUE, 144, 'half', FALSE, '[{"language": "en-US", "translation": "# Indentations"}]', NULL, '[{"name": "show when hardness", "rule": {"_and": [{"test_type": {"_eq": "hardness"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'hardness_surface_finish', NULL, 'input', NULL, 'raw', NULL, FALSE, TRUE, 145, 'half', FALSE, '[{"language": "en-US", "translation": "Surface Finish"}]', NULL, '[{"name": "show when hardness", "rule": {"_and": [{"test_type": {"_eq": "hardness"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'hardness_mean_hardness', NULL, 'input', '{"step": 0.01}', 'raw', NULL, FALSE, TRUE, 146, 'half', FALSE, '[{"language": "en-US", "translation": "Mean Hardness"}]', NULL, '[{"name": "show when hardness", "rule": {"_and": [{"test_type": {"_eq": "hardness"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'hardness_std_dev_hardness', NULL, 'input', '{"step": 0.01}', 'raw', NULL, FALSE, TRUE, 147, 'half', FALSE, '[{"language": "en-US", "translation": "Std Dev"}]', NULL, '[{"name": "show when hardness", "rule": {"_and": [{"test_type": {"_eq": "hardness"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'hardness_min_hardness', NULL, 'input', '{"step": 0.01}', 'raw', NULL, FALSE, TRUE, 148, 'half', FALSE, '[{"language": "en-US", "translation": "Min"}]', NULL, '[{"name": "show when hardness", "rule": {"_and": [{"test_type": {"_eq": "hardness"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'hardness_max_hardness', NULL, 'input', '{"step": 0.01}', 'raw', NULL, FALSE, TRUE, 149, 'half', FALSE, '[{"language": "en-US", "translation": "Max"}]', NULL, '[{"name": "show when hardness", "rule": {"_and": [{"test_type": {"_eq": "hardness"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'charpy_specimen_standard', NULL, 'select-dropdown', '{"choices": [{"text": "ISO 148", "value": "ISO_148"}, {"text": "ASTM E23", "value": "ASTM_E23"}, {"text": "Other", "value": "other"}]}', 'labels', NULL, FALSE, TRUE, 180, 'half', FALSE, '[{"language": "en-US", "translation": "Specimen Standard"}]', NULL, '[{"name": "show when charpy", "rule": {"_and": [{"test_type": {"_eq": "charpy"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'charpy_notch_type', NULL, 'select-dropdown', '{"choices": [{"text": "V-notch", "value": "V"}, {"text": "U-notch", "value": "U"}, {"text": "Keyhole", "value": "keyhole"}, {"text": "None", "value": "none"}]}', 'labels', NULL, FALSE, TRUE, 181, 'half', FALSE, '[{"language": "en-US", "translation": "Notch Type"}]', NULL, '[{"name": "show when charpy", "rule": {"_and": [{"test_type": {"_eq": "charpy"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'charpy_notch_depth_mm', NULL, 'input', '{"step": 0.01, "suffix": "mm"}', 'raw', NULL, FALSE, TRUE, 182, 'half', FALSE, '[{"language": "en-US", "translation": "Notch Depth"}]', NULL, '[{"name": "show when charpy", "rule": {"_and": [{"test_type": {"_eq": "charpy"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'charpy_specimen_width_mm', NULL, 'input', '{"step": 0.01, "suffix": "mm"}', 'raw', NULL, FALSE, TRUE, 183, 'half', FALSE, '[{"language": "en-US", "translation": "Specimen Width"}]', NULL, '[{"name": "show when charpy", "rule": {"_and": [{"test_type": {"_eq": "charpy"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'charpy_specimen_height_mm', NULL, 'input', '{"step": 0.01, "suffix": "mm"}', 'raw', NULL, FALSE, TRUE, 184, 'half', FALSE, '[{"language": "en-US", "translation": "Specimen Height"}]', NULL, '[{"name": "show when charpy", "rule": {"_and": [{"test_type": {"_eq": "charpy"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'charpy_test_temp_celsius', NULL, 'input', '{"step": 0.1, "suffix": "\u00b0C"}', 'raw', NULL, FALSE, TRUE, 185, 'half', FALSE, '[{"language": "en-US", "translation": "Test Temperature"}]', NULL, '[{"name": "show when charpy", "rule": {"_and": [{"test_type": {"_eq": "charpy"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'charpy_orientation', NULL, 'input', NULL, 'raw', NULL, FALSE, TRUE, 186, 'half', FALSE, '[{"language": "en-US", "translation": "Orientation (e.g. L-T)"}]', NULL, '[{"name": "show when charpy", "rule": {"_and": [{"test_type": {"_eq": "charpy"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'charpy_absorbed_energy_j', NULL, 'input', '{"step": 0.1, "suffix": "J"}', 'raw', NULL, FALSE, TRUE, 187, 'half', FALSE, '[{"language": "en-US", "translation": "Absorbed Energy"}]', NULL, '[{"name": "show when charpy", "rule": {"_and": [{"test_type": {"_eq": "charpy"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'charpy_lateral_expansion_mm', NULL, 'input', '{"step": 0.01, "suffix": "mm"}', 'raw', NULL, FALSE, TRUE, 188, 'half', FALSE, '[{"language": "en-US", "translation": "Lateral Expansion"}]', NULL, '[{"name": "show when charpy", "rule": {"_and": [{"test_type": {"_eq": "charpy"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'charpy_shear_fracture_pct', NULL, 'input', '{"step": 0.1, "suffix": "%"}', 'raw', NULL, FALSE, TRUE, 189, 'half', FALSE, '[{"language": "en-US", "translation": "Shear Fracture %"}]', NULL, '[{"name": "show when charpy", "rule": {"_and": [{"test_type": {"_eq": "charpy"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'compression_specimen_diameter_mm', NULL, 'input', '{"step": 0.001, "suffix": "mm"}', 'raw', NULL, FALSE, TRUE, 220, 'half', FALSE, '[{"language": "en-US", "translation": "Specimen Diameter"}]', NULL, '[{"name": "show when compression", "rule": {"_and": [{"test_type": {"_eq": "compression"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'compression_specimen_height_mm', NULL, 'input', '{"step": 0.001, "suffix": "mm"}', 'raw', NULL, FALSE, TRUE, 221, 'half', FALSE, '[{"language": "en-US", "translation": "Specimen Height"}]', NULL, '[{"name": "show when compression", "rule": {"_and": [{"test_type": {"_eq": "compression"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'compression_crosshead_speed_mm_per_min', NULL, 'input', '{"step": 0.001, "suffix": "mm/min"}', 'raw', NULL, FALSE, TRUE, 222, 'half', FALSE, '[{"language": "en-US", "translation": "Crosshead Speed"}]', NULL, '[{"name": "show when compression", "rule": {"_and": [{"test_type": {"_eq": "compression"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'compression_strain_rate_per_s', NULL, 'input', '{"step": 1e-06, "suffix": "s\u207b\u00b9"}', 'raw', NULL, FALSE, TRUE, 223, 'half', FALSE, '[{"language": "en-US", "translation": "Strain Rate"}]', NULL, '[{"name": "show when compression", "rule": {"_and": [{"test_type": {"_eq": "compression"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'compression_test_temp_celsius', NULL, 'input', '{"step": 0.1, "suffix": "\u00b0C"}', 'raw', NULL, FALSE, TRUE, 224, 'half', FALSE, '[{"language": "en-US", "translation": "Test Temperature"}]', NULL, '[{"name": "show when compression", "rule": {"_and": [{"test_type": {"_eq": "compression"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'compression_lubrication', NULL, 'input', NULL, 'raw', NULL, FALSE, TRUE, 225, 'half', FALSE, NULL, NULL, '[{"name": "show when compression", "rule": {"_and": [{"test_type": {"_eq": "compression"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'compression_yield_strength_mpa', NULL, 'input', '{"step": 0.01, "suffix": "MPa"}', 'raw', NULL, FALSE, TRUE, 226, 'half', FALSE, '[{"language": "en-US", "translation": "Yield Strength"}]', NULL, '[{"name": "show when compression", "rule": {"_and": [{"test_type": {"_eq": "compression"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'compression_peak_stress_mpa', NULL, 'input', '{"step": 0.01, "suffix": "MPa"}', 'raw', NULL, FALSE, TRUE, 227, 'half', FALSE, '[{"language": "en-US", "translation": "Peak Stress"}]', NULL, '[{"name": "show when compression", "rule": {"_and": [{"test_type": {"_eq": "compression"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'compression_strain_at_fracture_pct', NULL, 'input', '{"step": 0.01, "suffix": "%"}', 'raw', NULL, FALSE, TRUE, 228, 'half', FALSE, '[{"language": "en-US", "translation": "Strain at Fracture"}]', NULL, '[{"name": "show when compression", "rule": {"_and": [{"test_type": {"_eq": "compression"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'sem_imaging_mode', NULL, 'select-dropdown', '{"choices": [{"text": "Secondary Electron (SE)", "value": "SE"}, {"text": "Backscatter (BSE)", "value": "BSE"}, {"text": "EBSD", "value": "EBSD"}, {"text": "EDS", "value": "EDS"}, {"text": "WDS", "value": "WDS"}, {"text": "Cathodoluminescence (CL)", "value": "CL"}, {"text": "Other", "value": "other"}]}', 'labels', NULL, FALSE, TRUE, 260, 'half', FALSE, '[{"language": "en-US", "translation": "Imaging Mode"}]', NULL, '[{"name": "show when sem", "rule": {"_and": [{"test_type": {"_eq": "sem"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'sem_accelerating_voltage_kv', NULL, 'input', '{"step": 0.1, "suffix": "kV"}', 'raw', NULL, FALSE, TRUE, 261, 'half', FALSE, '[{"language": "en-US", "translation": "Accelerating Voltage"}]', NULL, '[{"name": "show when sem", "rule": {"_and": [{"test_type": {"_eq": "sem"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'sem_working_distance_mm', NULL, 'input', '{"step": 0.1, "suffix": "mm"}', 'raw', NULL, FALSE, TRUE, 262, 'half', FALSE, '[{"language": "en-US", "translation": "Working Distance"}]', NULL, '[{"name": "show when sem", "rule": {"_and": [{"test_type": {"_eq": "sem"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'sem_magnification_range', NULL, 'input', NULL, 'raw', NULL, FALSE, TRUE, 263, 'half', FALSE, '[{"language": "en-US", "translation": "Magnification Range"}]', NULL, '[{"name": "show when sem", "rule": {"_and": [{"test_type": {"_eq": "sem"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'sem_beam_current_na', NULL, 'input', '{"step": 0.0001, "suffix": "nA"}', 'raw', NULL, FALSE, TRUE, 264, 'half', FALSE, '[{"language": "en-US", "translation": "Beam Current"}]', NULL, '[{"name": "show when sem", "rule": {"_and": [{"test_type": {"_eq": "sem"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'sem_coating_material', NULL, 'input', NULL, 'raw', NULL, FALSE, TRUE, 265, 'half', FALSE, '[{"language": "en-US", "translation": "Coating Material"}]', NULL, '[{"name": "show when sem", "rule": {"_and": [{"test_type": {"_eq": "sem"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'sem_coating_thickness_nm', NULL, 'input', '{"step": 0.1, "suffix": "nm"}', 'raw', NULL, FALSE, TRUE, 266, 'half', FALSE, '[{"language": "en-US", "translation": "Coating Thickness"}]', NULL, '[{"name": "show when sem", "rule": {"_and": [{"test_type": {"_eq": "sem"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'sem_etchant', NULL, 'input', NULL, 'raw', NULL, FALSE, TRUE, 267, 'half', FALSE, NULL, NULL, '[{"name": "show when sem", "rule": {"_and": [{"test_type": {"_eq": "sem"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'sem_step_size_um', NULL, 'input', '{"step": 0.001, "suffix": "\u03bcm"}', 'raw', NULL, FALSE, TRUE, 268, 'half', FALSE, '[{"language": "en-US", "translation": "EBSD Step Size"}]', NULL, '[{"name": "show when sem", "rule": {"_and": [{"test_type": {"_eq": "sem"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'xrd_radiation_source', NULL, 'input', NULL, 'raw', NULL, FALSE, TRUE, 300, 'half', FALSE, '[{"language": "en-US", "translation": "Radiation Source (e.g. Cu K\u03b1)"}]', NULL, '[{"name": "show when xrd", "rule": {"_and": [{"test_type": {"_eq": "xrd"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'xrd_wavelength_angstrom', NULL, 'input', '{"step": 1e-05, "suffix": "\u00c5"}', 'raw', NULL, FALSE, TRUE, 301, 'half', FALSE, '[{"language": "en-US", "translation": "Wavelength"}]', NULL, '[{"name": "show when xrd", "rule": {"_and": [{"test_type": {"_eq": "xrd"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'xrd_two_theta_range_deg', NULL, 'input', NULL, 'raw', NULL, FALSE, TRUE, 302, 'half', FALSE, '[{"language": "en-US", "translation": "2\u03b8 Range (e.g. 10\u201390\u00b0)"}]', NULL, '[{"name": "show when xrd", "rule": {"_and": [{"test_type": {"_eq": "xrd"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'xrd_step_size_deg', NULL, 'input', '{"step": 0.0001, "suffix": "\u00b0"}', 'raw', NULL, FALSE, TRUE, 303, 'half', FALSE, '[{"language": "en-US", "translation": "Step Size"}]', NULL, '[{"name": "show when xrd", "rule": {"_and": [{"test_type": {"_eq": "xrd"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'xrd_scan_speed_deg_per_min', NULL, 'input', '{"step": 0.001, "suffix": "\u00b0/min"}', 'raw', NULL, FALSE, TRUE, 304, 'half', FALSE, '[{"language": "en-US", "translation": "Scan Speed"}]', NULL, '[{"name": "show when xrd", "rule": {"_and": [{"test_type": {"_eq": "xrd"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'xrd_detector_type', NULL, 'input', NULL, 'raw', NULL, FALSE, TRUE, 305, 'half', FALSE, '[{"language": "en-US", "translation": "Detector Type"}]', NULL, '[{"name": "show when xrd", "rule": {"_and": [{"test_type": {"_eq": "xrd"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('test_sessions', 'xrd_sample_prep', NULL, 'input-multiline', NULL, 'raw', NULL, FALSE, TRUE, 306, 'full', FALSE, '[{"language": "en-US", "translation": "Sample Preparation"}]', NULL, '[{"name": "show when xrd", "rule": {"_and": [{"test_type": {"_eq": "xrd"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('manufacturing_operations', 'machining_operation_subtype', NULL, 'select-dropdown', '{"choices": [{"text": "Turning", "value": "turning"}, {"text": "Facing", "value": "facing"}, {"text": "Boring", "value": "boring"}, {"text": "Threading", "value": "threading"}, {"text": "Grooving", "value": "grooving"}, {"text": "Parting", "value": "parting"}, {"text": "Milling", "value": "milling"}, {"text": "Drilling", "value": "drilling"}, {"text": "Other", "value": "other"}]}', 'labels', NULL, FALSE, TRUE, 340, 'half', FALSE, '[{"language": "en-US", "translation": "Operation Sub-type"}]', NULL, '[{"name": "show when machining", "rule": {"_and": [{"process_category": {"_eq": "machining"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('manufacturing_operations', 'machining_spindle_speed_rpm', NULL, 'input', '{"step": 0.5, "suffix": "rpm"}', 'raw', NULL, FALSE, TRUE, 341, 'half', FALSE, '[{"language": "en-US", "translation": "Spindle Speed"}]', NULL, '[{"name": "show when machining", "rule": {"_and": [{"process_category": {"_eq": "machining"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('manufacturing_operations', 'machining_cutting_speed_m_per_min', NULL, 'input', '{"step": 0.1, "suffix": "m/min"}', 'raw', NULL, FALSE, TRUE, 342, 'half', FALSE, '[{"language": "en-US", "translation": "Cutting Speed Vc"}]', NULL, '[{"name": "show when machining", "rule": {"_and": [{"process_category": {"_eq": "machining"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('manufacturing_operations', 'machining_feed_mm_per_rev', NULL, 'input', '{"step": 0.001, "suffix": "mm/rev"}', 'raw', NULL, FALSE, TRUE, 343, 'half', FALSE, '[{"language": "en-US", "translation": "Feed"}]', NULL, '[{"name": "show when machining", "rule": {"_and": [{"process_category": {"_eq": "machining"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('manufacturing_operations', 'machining_axial_depth_of_cut_mm', NULL, 'input', '{"step": 0.001, "suffix": "mm"}', 'raw', NULL, FALSE, TRUE, 344, 'half', FALSE, '[{"language": "en-US", "translation": "Axial Depth of Cut (ap)"}]', NULL, '[{"name": "show when machining", "rule": {"_and": [{"process_category": {"_eq": "machining"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('manufacturing_operations', 'machining_radial_depth_of_cut_mm', NULL, 'input', '{"step": 0.001, "suffix": "mm"}', 'raw', NULL, FALSE, TRUE, 345, 'half', FALSE, '[{"language": "en-US", "translation": "Radial Depth of Cut (ae)"}]', NULL, '[{"name": "show when machining", "rule": {"_and": [{"process_category": {"_eq": "machining"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('manufacturing_operations', 'machining_cutting_length_mm', NULL, 'input', '{"step": 0.1, "suffix": "mm"}', 'raw', NULL, FALSE, TRUE, 346, 'half', FALSE, '[{"language": "en-US", "translation": "Cutting Length"}]', NULL, '[{"name": "show when machining", "rule": {"_and": [{"process_category": {"_eq": "machining"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('manufacturing_operations', 'machining_workpiece_diameter_mm', NULL, 'input', '{"step": 0.01, "suffix": "mm"}', 'raw', NULL, FALSE, TRUE, 347, 'half', FALSE, '[{"language": "en-US", "translation": "Workpiece Diameter"}]', NULL, '[{"name": "show when machining", "rule": {"_and": [{"process_category": {"_eq": "machining"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('manufacturing_operations', 'machining_new_edge', 'cast-boolean', 'toggle', NULL, 'boolean', NULL, FALSE, TRUE, 348, 'half', FALSE, '[{"language": "en-US", "translation": "New Edge Used?"}]', NULL, '[{"name": "show when machining", "rule": {"_and": [{"process_category": {"_eq": "machining"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('manufacturing_operations', 'machining_coolant_used', 'cast-boolean', 'toggle', NULL, 'boolean', NULL, FALSE, TRUE, 349, 'half', FALSE, '[{"language": "en-US", "translation": "Coolant Used?"}]', NULL, '[{"name": "show when machining", "rule": {"_and": [{"process_category": {"_eq": "machining"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('manufacturing_operations', 'machining_coolant_pressure_bar', NULL, 'input', '{"step": 0.1, "suffix": "bar"}', 'raw', NULL, FALSE, TRUE, 350, 'half', FALSE, '[{"language": "en-US", "translation": "Coolant Pressure"}]', NULL, '[{"name": "show when machining", "rule": {"_and": [{"process_category": {"_eq": "machining"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('manufacturing_operations', 'machining_tacho_used', 'cast-boolean', 'toggle', NULL, 'boolean', NULL, FALSE, TRUE, 351, 'half', FALSE, '[{"language": "en-US", "translation": "Tachometer Used?"}]', NULL, '[{"name": "show when machining", "rule": {"_and": [{"process_category": {"_eq": "machining"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('manufacturing_operations', 'machining_force_captured', 'cast-boolean', 'toggle', NULL, 'boolean', NULL, FALSE, TRUE, 352, 'half', FALSE, '[{"language": "en-US", "translation": "Force Data Captured?"}]', NULL, '[{"name": "show when machining", "rule": {"_and": [{"process_category": {"_eq": "machining"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('manufacturing_operations', 'machining_chips_collected', 'cast-boolean', 'toggle', NULL, 'boolean', NULL, FALSE, TRUE, 353, 'half', FALSE, '[{"language": "en-US", "translation": "Chips Collected?"}]', NULL, '[{"name": "show when machining", "rule": {"_and": [{"process_category": {"_eq": "machining"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('manufacturing_operations', 'machining_chips_ref_code', NULL, 'input', NULL, 'raw', NULL, FALSE, TRUE, 354, 'half', FALSE, '[{"language": "en-US", "translation": "Chips Reference Code"}]', NULL, '[{"name": "show when machining", "rule": {"_and": [{"process_category": {"_eq": "machining"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('manufacturing_operations', 'machining_experiment_sheet_url', NULL, 'input', '{"type": "url"}', 'raw', NULL, FALSE, TRUE, 355, 'full', FALSE, '[{"language": "en-US", "translation": "Experiment Sheet URL"}]', NULL, '[{"name": "show when machining", "rule": {"_and": [{"process_category": {"_eq": "machining"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('manufacturing_operations', 'machining_legacy_insert_edge_id', NULL, 'input', NULL, 'raw', NULL, FALSE, TRUE, 356, 'half', FALSE, '[{"language": "en-US", "translation": "Legacy Edge ID"}]', NULL, '[{"name": "show when machining", "rule": {"_and": [{"process_category": {"_eq": "machining"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('manufacturing_operations', 'machining_legacy_machining_uid', NULL, 'input', NULL, 'raw', NULL, FALSE, TRUE, 357, 'half', FALSE, '[{"language": "en-US", "translation": "Legacy Machining UID"}]', NULL, '[{"name": "show when machining", "rule": {"_and": [{"process_category": {"_eq": "machining"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('manufacturing_operations', 'sintering_recipe_number', NULL, 'input', NULL, 'raw', NULL, FALSE, TRUE, 380, 'half', FALSE, '[{"language": "en-US", "translation": "Recipe #"}]', NULL, '[{"name": "show when sintering", "rule": {"_and": [{"process_category": {"_eq": "sintering"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('manufacturing_operations', 'sintering_batch_number', NULL, 'input', NULL, 'raw', NULL, FALSE, TRUE, 381, 'half', FALSE, '[{"language": "en-US", "translation": "Batch #"}]', NULL, '[{"name": "show when sintering", "rule": {"_and": [{"process_category": {"_eq": "sintering"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('manufacturing_operations', 'sintering_mould_diameter_mm', NULL, 'input', '{"step": 0.1, "suffix": "mm"}', 'raw', NULL, FALSE, TRUE, 382, 'half', FALSE, '[{"language": "en-US", "translation": "Mould Diameter"}]', NULL, '[{"name": "show when sintering", "rule": {"_and": [{"process_category": {"_eq": "sintering"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('manufacturing_operations', 'sintering_atmosphere', NULL, 'input', NULL, 'raw', NULL, FALSE, TRUE, 383, 'half', FALSE, NULL, NULL, '[{"name": "show when sintering", "rule": {"_and": [{"process_category": {"_eq": "sintering"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('manufacturing_operations', 'sintering_tc_pyro_control', NULL, 'input', NULL, 'raw', NULL, FALSE, TRUE, 384, 'half', FALSE, '[{"language": "en-US", "translation": "TC / Pyrometer Control"}]', NULL, '[{"name": "show when sintering", "rule": {"_and": [{"process_category": {"_eq": "sintering"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('manufacturing_operations', 'sintering_max_temp_celsius', NULL, 'input', '{"step": 0.1, "suffix": "\u00b0C"}', 'raw', NULL, FALSE, TRUE, 385, 'half', FALSE, '[{"language": "en-US", "translation": "Peak Temperature"}]', NULL, '[{"name": "show when sintering", "rule": {"_and": [{"process_category": {"_eq": "sintering"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('manufacturing_operations', 'sintering_mass_grams', NULL, 'input', '{"step": 0.001, "suffix": "g"}', 'raw', NULL, FALSE, TRUE, 384, 'half', FALSE, '[{"language": "en-US", "translation": "Charge Mass (g)"}]', NULL, '[{"name": "show when sintering", "rule": {"_and": [{"process_category": {"_eq": "sintering"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('manufacturing_operations', 'sintering_max_force_kn', NULL, 'input', '{"step": 0.1, "suffix": "kN"}', 'raw', NULL, FALSE, TRUE, 386, 'half', FALSE, '[{"language": "en-US", "translation": "Peak Force"}]', NULL, '[{"name": "show when sintering", "rule": {"_and": [{"process_category": {"_eq": "sintering"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('manufacturing_operations', 'sintering_voltage_at_max_t_v', NULL, 'input', '{"step": 0.01, "suffix": "V"}', 'raw', NULL, FALSE, TRUE, 387, 'half', FALSE, '[{"language": "en-US", "translation": "Voltage at Peak T"}]', NULL, '[{"name": "show when sintering", "rule": {"_and": [{"process_category": {"_eq": "sintering"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('manufacturing_operations', 'sintering_power_at_max_t_kw', NULL, 'input', '{"step": 0.01, "suffix": "kW"}', 'raw', NULL, FALSE, TRUE, 388, 'half', FALSE, '[{"language": "en-US", "translation": "Power at Peak T"}]', NULL, '[{"name": "show when sintering", "rule": {"_and": [{"process_category": {"_eq": "sintering"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('manufacturing_operations', 'sintering_ptc_top_celsius', NULL, 'input', '{"step": 0.1, "suffix": "\u00b0C"}', 'raw', NULL, FALSE, TRUE, 389, 'half', FALSE, '[{"language": "en-US", "translation": "PTC Top (\u00b0C)"}]', NULL, '[{"name": "show when sintering", "rule": {"_and": [{"process_category": {"_eq": "sintering"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('manufacturing_operations', 'sintering_ptc_bot_celsius', NULL, 'input', '{"step": 0.1, "suffix": "\u00b0C"}', 'raw', NULL, FALSE, TRUE, 390, 'half', FALSE, '[{"language": "en-US", "translation": "PTC Bottom (\u00b0C)"}]', NULL, '[{"name": "show when sintering", "rule": {"_and": [{"process_category": {"_eq": "sintering"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('manufacturing_operations', 'sintering_coshh_ref', NULL, 'input', NULL, 'raw', NULL, FALSE, TRUE, 391, 'half', FALSE, '[{"language": "en-US", "translation": "CoSHH Ref #"}]', NULL, '[{"name": "show when sintering", "rule": {"_and": [{"process_category": {"_eq": "sintering"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('manufacturing_operations', 'sintering_material_type_note', NULL, 'input', NULL, 'raw', NULL, FALSE, TRUE, 392, 'full', FALSE, '[{"language": "en-US", "translation": "Material Type Note"}]', NULL, '[{"name": "show when sintering", "rule": {"_and": [{"process_category": {"_eq": "sintering"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('manufacturing_operations', 'ht_treatment_type', NULL, 'select-dropdown', '{"choices": [{"text": "Anneal", "value": "anneal"}, {"text": "Solution Treat", "value": "solution_treat"}, {"text": "Age", "value": "age"}, {"text": "Quench", "value": "quench"}, {"text": "Temper", "value": "temper"}, {"text": "Stress Relieve", "value": "stress_relieve"}, {"text": "Normalise", "value": "normalise"}, {"text": "Other", "value": "other"}]}', 'labels', NULL, FALSE, TRUE, 420, 'half', FALSE, '[{"language": "en-US", "translation": "Treatment Type"}]', NULL, '[{"name": "show when heat_treatment", "rule": {"_and": [{"process_category": {"_eq": "heat_treatment"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('manufacturing_operations', 'ht_atmosphere', NULL, 'input', NULL, 'raw', NULL, FALSE, TRUE, 421, 'half', FALSE, NULL, NULL, '[{"name": "show when heat_treatment", "rule": {"_and": [{"process_category": {"_eq": "heat_treatment"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('manufacturing_operations', 'ht_peak_temp_celsius', NULL, 'input', '{"step": 0.1, "suffix": "\u00b0C"}', 'raw', NULL, FALSE, TRUE, 422, 'half', FALSE, '[{"language": "en-US", "translation": "Peak Temperature"}]', NULL, '[{"name": "show when heat_treatment", "rule": {"_and": [{"process_category": {"_eq": "heat_treatment"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('manufacturing_operations', 'ht_hold_time_min', NULL, 'input', '{"step": 0.1, "suffix": "min"}', 'raw', NULL, FALSE, TRUE, 423, 'half', FALSE, '[{"language": "en-US", "translation": "Hold Time"}]', NULL, '[{"name": "show when heat_treatment", "rule": {"_and": [{"process_category": {"_eq": "heat_treatment"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('manufacturing_operations', 'ht_heating_rate_c_per_min', NULL, 'input', '{"step": 0.1, "suffix": "\u00b0C/min"}', 'raw', NULL, FALSE, TRUE, 424, 'half', FALSE, '[{"language": "en-US", "translation": "Heating Rate"}]', NULL, '[{"name": "show when heat_treatment", "rule": {"_and": [{"process_category": {"_eq": "heat_treatment"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('manufacturing_operations', 'ht_cooling_method', NULL, 'select-dropdown', '{"choices": [{"text": "Furnace cool", "value": "furnace"}, {"text": "Air cool", "value": "air"}, {"text": "Water quench", "value": "water_quench"}, {"text": "Oil quench", "value": "oil_quench"}, {"text": "Forced air", "value": "forced_air"}, {"text": "Other", "value": "other"}]}', 'labels', NULL, FALSE, TRUE, 425, 'half', FALSE, '[{"language": "en-US", "translation": "Cooling Method"}]', NULL, '[{"name": "show when heat_treatment", "rule": {"_and": [{"process_category": {"_eq": "heat_treatment"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('manufacturing_operations', 'ht_cooling_rate_c_per_min', NULL, 'input', '{"step": 0.1, "suffix": "\u00b0C/min"}', 'raw', NULL, FALSE, TRUE, 426, 'half', FALSE, '[{"language": "en-US", "translation": "Cooling Rate"}]', NULL, '[{"name": "show when heat_treatment", "rule": {"_and": [{"process_category": {"_eq": "heat_treatment"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('manufacturing_operations', 'ht_quench_medium', NULL, 'input', NULL, 'raw', NULL, FALSE, TRUE, 427, 'half', FALSE, '[{"language": "en-US", "translation": "Quench Medium"}]', NULL, '[{"name": "show when heat_treatment", "rule": {"_and": [{"process_category": {"_eq": "heat_treatment"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('manufacturing_operations', 'deform_deformation_type', NULL, 'select-dropdown', '{"choices": [{"text": "Rolling", "value": "rolling"}, {"text": "Forging", "value": "forging"}, {"text": "Extrusion", "value": "extrusion"}, {"text": "Drawing", "value": "drawing"}, {"text": "Other", "value": "other"}]}', 'labels', NULL, FALSE, TRUE, 460, 'half', FALSE, '[{"language": "en-US", "translation": "Deformation Type"}]', NULL, '[{"name": "show when deformation", "rule": {"_and": [{"process_category": {"_eq": "deformation"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('manufacturing_operations', 'deform_deformation_temp_celsius', NULL, 'input', '{"step": 0.1, "suffix": "\u00b0C"}', 'raw', NULL, FALSE, TRUE, 461, 'half', FALSE, '[{"language": "en-US", "translation": "Deformation Temperature"}]', NULL, '[{"name": "show when deformation", "rule": {"_and": [{"process_category": {"_eq": "deformation"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('manufacturing_operations', 'deform_pass_count', NULL, 'input', '{"step": 1}', 'raw', NULL, FALSE, TRUE, 462, 'half', FALSE, '[{"language": "en-US", "translation": "Pass Count"}]', NULL, '[{"name": "show when deformation", "rule": {"_and": [{"process_category": {"_eq": "deformation"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('manufacturing_operations', 'deform_total_reduction_pct', NULL, 'input', '{"step": 0.1, "suffix": "%"}', 'raw', NULL, FALSE, TRUE, 463, 'half', FALSE, '[{"language": "en-US", "translation": "Total Reduction"}]', NULL, '[{"name": "show when deformation", "rule": {"_and": [{"process_category": {"_eq": "deformation"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('manufacturing_operations', 'deform_reduction_per_pass_pct', NULL, 'input', '{"step": 0.1, "suffix": "%"}', 'raw', NULL, FALSE, TRUE, 464, 'half', FALSE, '[{"language": "en-US", "translation": "Reduction per Pass"}]', NULL, '[{"name": "show when deformation", "rule": {"_and": [{"process_category": {"_eq": "deformation"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('manufacturing_operations', 'deform_strain_rate_per_sec', NULL, 'input', '{"step": 0.0001, "suffix": "s\u207b\u00b9"}', 'raw', NULL, FALSE, TRUE, 465, 'half', FALSE, '[{"language": "en-US", "translation": "Strain Rate"}]', NULL, '[{"name": "show when deformation", "rule": {"_and": [{"process_category": {"_eq": "deformation"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('manufacturing_operations', 'deform_roll_speed_m_per_min', NULL, 'input', '{"step": 0.01, "suffix": "m/min"}', 'raw', NULL, FALSE, TRUE, 466, 'half', FALSE, '[{"language": "en-US", "translation": "Roll Speed"}]', NULL, '[{"name": "show when deformation", "rule": {"_and": [{"process_category": {"_eq": "deformation"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('manufacturing_operations', 'deform_lubricant', NULL, 'input', NULL, 'raw', NULL, FALSE, TRUE, 467, 'half', FALSE, NULL, NULL, '[{"name": "show when deformation", "rule": {"_and": [{"process_category": {"_eq": "deformation"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('manufacturing_operations', 'am_process_variant', NULL, 'select-dropdown', '{"choices": [{"text": "SLM", "value": "SLM"}, {"text": "EBM", "value": "EBM"}, {"text": "DED", "value": "DED"}, {"text": "WAAM", "value": "WAAM"}, {"text": "Binder Jetting", "value": "binder_jet"}, {"text": "Other", "value": "other"}]}', 'labels', NULL, FALSE, TRUE, 500, 'half', FALSE, '[{"language": "en-US", "translation": "Process Variant"}]', NULL, '[{"name": "show when additive", "rule": {"_and": [{"process_category": {"_eq": "additive"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('manufacturing_operations', 'am_layer_thickness_mm', NULL, 'input', '{"step": 0.001, "suffix": "mm"}', 'raw', NULL, FALSE, TRUE, 501, 'half', FALSE, '[{"language": "en-US", "translation": "Layer Thickness"}]', NULL, '[{"name": "show when additive", "rule": {"_and": [{"process_category": {"_eq": "additive"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('manufacturing_operations', 'am_laser_power_w', NULL, 'input', '{"step": 0.1, "suffix": "W"}', 'raw', NULL, FALSE, TRUE, 502, 'half', FALSE, '[{"language": "en-US", "translation": "Laser Power"}]', NULL, '[{"name": "show when additive", "rule": {"_and": [{"process_category": {"_eq": "additive"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('manufacturing_operations', 'am_scan_speed_mm_per_s', NULL, 'input', '{"step": 0.1, "suffix": "mm/s"}', 'raw', NULL, FALSE, TRUE, 503, 'half', FALSE, '[{"language": "en-US", "translation": "Scan Speed"}]', NULL, '[{"name": "show when additive", "rule": {"_and": [{"process_category": {"_eq": "additive"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('manufacturing_operations', 'am_hatch_spacing_mm', NULL, 'input', '{"step": 0.001, "suffix": "mm"}', 'raw', NULL, FALSE, TRUE, 504, 'half', FALSE, '[{"language": "en-US", "translation": "Hatch Spacing"}]', NULL, '[{"name": "show when additive", "rule": {"_and": [{"process_category": {"_eq": "additive"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('manufacturing_operations', 'am_energy_density_j_per_mm3', NULL, 'input', '{"step": 0.01, "suffix": "J/mm\u00b3"}', 'raw', NULL, FALSE, TRUE, 505, 'half', FALSE, '[{"language": "en-US", "translation": "Volumetric Energy Density"}]', NULL, '[{"name": "show when additive", "rule": {"_and": [{"process_category": {"_eq": "additive"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('manufacturing_operations', 'am_build_atmosphere', NULL, 'input', NULL, 'raw', NULL, FALSE, TRUE, 506, 'half', FALSE, '[{"language": "en-US", "translation": "Build Atmosphere"}]', NULL, '[{"name": "show when additive", "rule": {"_and": [{"process_category": {"_eq": "additive"}}]}, "hidden": false, "readonly": false, "required": false}]');
INSERT INTO d1_inline_param_stage (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, note, conditions) VALUES ('manufacturing_operations', 'am_preheat_temp_celsius', NULL, 'input', '{"step": 1, "suffix": "\u00b0C"}', 'raw', NULL, FALSE, TRUE, 507, 'half', FALSE, '[{"language": "en-US", "translation": "Preheat Temperature"}]', NULL, '[{"name": "show when additive", "rule": {"_and": [{"process_category": {"_eq": "additive"}}]}, "hidden": false, "readonly": false, "required": false}]');

-- The five dropdown presets (scripts/configure_field_presets.sql), applied to the staged rows.
UPDATE d1_inline_param_stage SET interface='select-dropdown',
  options='{"allowOther":true,"choices":[{"text":"100×–1,000×","value":"100x-1000x"},{"text":"1,000×–10,000×","value":"1000x-10000x"},{"text":"10,000×–50,000×","value":"10000x-50000x"},{"text":"50,000×–100,000×","value":"50000x-100000x"},{"text":">100,000×","value":">100000x"}]}'
WHERE collection='test_sessions' AND field='sem_magnification_range';

UPDATE d1_inline_param_stage SET interface='select-dropdown',
  options='{"allowOther":true,"choices":[{"text":"Gold (Au)","value":"Au"},{"text":"Platinum (Pt)","value":"Pt"},{"text":"Gold/Palladium (Au/Pd)","value":"Au/Pd"},{"text":"Carbon (C)","value":"C"},{"text":"Iridium (Ir)","value":"Ir"},{"text":"None (uncoated)","value":"none"}]}'
WHERE collection='test_sessions' AND field='sem_coating_material';

UPDATE d1_inline_param_stage SET interface='select-dropdown',
  options='{"allowOther":true,"choices":[{"text":"Kalling''s No.2","value":"Kallings 2"},{"text":"Marble''s","value":"Marbles"},{"text":"Nital","value":"Nital"},{"text":"Kroll''s","value":"Krolls"},{"text":"Electrolytic","value":"electrolytic"},{"text":"None","value":"none"}]}'
WHERE collection='test_sessions' AND field='sem_etchant';

-- ── XRD ───────────────────────────────────────────────────────────────────────
UPDATE d1_inline_param_stage SET interface='select-dropdown',
  options='{"allowOther":true,"choices":[{"text":"Cu Kα","value":"Cu Ka"},{"text":"Co Kα","value":"Co Ka"},{"text":"Cr Kα","value":"Cr Ka"},{"text":"Mo Kα","value":"Mo Ka"},{"text":"Fe Kα","value":"Fe Ka"}]}'
WHERE collection='test_sessions' AND field='xrd_radiation_source';

UPDATE d1_inline_param_stage SET interface='select-dropdown',
  options='{"allowOther":true,"choices":[{"text":"Scintillation","value":"scintillation"},{"text":"Si strip (LynxEye)","value":"si_strip"},{"text":"CCD","value":"ccd"},{"text":"Image plate","value":"image_plate"}]}'
WHERE collection='test_sessions' AND field='xrd_detector_type';


DO $$
DECLARE
    staged INTEGER;
BEGIN
    SELECT count(*) INTO staged FROM d1_inline_param_stage;
    IF staged <> 116 THEN
        RAISE EXCEPTION 'restore_inline_param_field_meta: expected 116 staged inline parameter rows, got %', staged;
    END IF;
END
$$;

WITH inserted AS (
    INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options,
                                 readonly, hidden, sort, width, required, translations, note, conditions)
    SELECT s.collection, s.field, s.special, s.interface, s.options, s.display, s.display_options,
           s.readonly, s.hidden, s.sort, s.width, s.required, s.translations, s.note, s.conditions
    FROM d1_inline_param_stage AS s
    WHERE NOT EXISTS (
        SELECT 1 FROM directus_fields AS f
        WHERE f.collection = s.collection AND f.field = s.field
    )
    ORDER BY s.collection, s.sort
    RETURNING id, collection, field
)
INSERT INTO d1_private.restore_inline_param_meta_changes (kind, collection, field, row_id)
SELECT 'field_row', collection, field, id FROM inserted
ON CONFLICT (kind, collection, field) DO UPDATE SET row_id = EXCLUDED.row_id;

DROP TABLE d1_inline_param_stage;

-- 2. The two sintering group rows of migration 101 (present on the live database; a fresh
-- install that ran configure_directus.sql has lost them).
WITH inserted AS (
    INSERT INTO directus_fields (collection, field, special, interface, options, conditions, sort, width, hidden)
    SELECT 'manufacturing_operations', v.field, 'alias,no-data,group', 'group-detail',
           v.options::json, v.conditions::json, v.sort, 'full', FALSE
    FROM (VALUES
        ('sintering_machine_group',
         '{"start":"open"}',
         '[{"name":"Hide unless sintering","rule":{"_and":[{"process_category":{"_neq":"sintering"}}]},"hidden":true}]',
         60),
        ('sintering_qa_group',
         '{"start":"closed"}',
         '[{"name":"Hide unless sintering","rule":{"_and":[{"process_category":{"_neq":"sintering"}}]},"hidden":true}]',
         61)
    ) AS v(field, options, conditions, sort)
    WHERE NOT EXISTS (
        SELECT 1 FROM directus_fields AS f
        WHERE f.collection = 'manufacturing_operations' AND f.field = v.field
    )
    RETURNING id, collection, field
)
INSERT INTO d1_private.restore_inline_param_meta_changes (kind, collection, field, row_id)
SELECT 'field_row', collection, field, id FROM inserted
ON CONFLICT (kind, collection, field) DO UPDATE SET row_id = EXCLUDED.row_id;

-- 3. Group membership, as migration 101 leaves it. Only a member that is in no group yet is put in
-- one; a member someone already grouped is left where it is.
WITH changed AS (
    UPDATE directus_fields SET "group" = 'sintering_machine_group'
    WHERE collection = 'manufacturing_operations' AND "group" IS NULL
      AND field IN ('fast_recipe_id', 'sintering_recipe_number', 'sintering_batch_number',
                    'sintering_max_temp_celsius', 'sintering_max_force_kn',
                    'sintering_mould_diameter_mm', 'sintering_mass_grams',
                    'sintering_atmosphere', 'sintering_tc_pyro_control',
                    'sintering_material_type_note')
    RETURNING collection, field
)
INSERT INTO d1_private.restore_inline_param_meta_changes (kind, collection, field)
SELECT 'group_set', collection, field FROM changed
ON CONFLICT (kind, collection, field) DO NOTHING;

WITH changed AS (
    UPDATE directus_fields SET "group" = 'sintering_qa_group'
    WHERE collection = 'manufacturing_operations' AND "group" IS NULL
      AND field IN ('sintering_coshh_ref', 'sintering_ptc_top_celsius', 'sintering_ptc_bot_celsius',
                    'sintering_voltage_at_max_t_v', 'sintering_power_at_max_t_kw')
    RETURNING collection, field
)
INSERT INTO d1_private.restore_inline_param_meta_changes (kind, collection, field)
SELECT 'group_set', collection, field FROM changed
ON CONFLICT (kind, collection, field) DO NOTHING;

-- 4. Migration 102's hidden flag on the free-text recipe number. The generator row already carries
-- hidden = TRUE (with a "show when sintering" condition), so on rows inserted above this changes
-- nothing; it is kept so a database whose row was un-hidden ends up as 102 left it.
WITH changed AS (
    UPDATE directus_fields SET hidden = TRUE
    WHERE collection = 'manufacturing_operations' AND field = 'sintering_recipe_number'
      AND hidden IS NOT TRUE
    RETURNING collection, field
)
INSERT INTO d1_private.restore_inline_param_meta_changes (kind, collection, field)
SELECT 'hidden_set', collection, field FROM changed
ON CONFLICT (kind, collection, field) DO NOTHING;

-- 5. The relation manufacturing_operations.source_recipe_id -> prep_recipes
-- (scripts/configure_sample_prep.sql, relations block). Its field row follows in section 6a.
WITH inserted AS (
    INSERT INTO directus_relations (many_collection, many_field, one_collection, one_field, one_deselect_action)
    SELECT 'manufacturing_operations', 'source_recipe_id', 'prep_recipes', NULL, 'nullify'
    WHERE NOT EXISTS (
        SELECT 1 FROM directus_relations AS r
        WHERE r.many_collection = 'manufacturing_operations' AND r.many_field = 'source_recipe_id'
    )
    RETURNING id, many_collection, many_field
)
INSERT INTO d1_private.restore_inline_param_meta_changes (kind, collection, field, row_id)
SELECT 'relation_row', many_collection, many_field, id FROM inserted
ON CONFLICT (kind, collection, field) DO UPDATE SET row_id = EXCLUDED.row_id;

-- 6. The four parent-side alias fields.
-- 6a. manufacturing_operations.source_recipe_id (m2o; scripts/configure_sample_prep.sql).
WITH inserted AS (
    INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options,
                                 readonly, hidden, sort, width, required, translations, conditions)
    SELECT 'manufacturing_operations', 'source_recipe_id', 'm2o', 'select-dropdown-m2o',
           '{"template":"{{name}}"}'::json, 'related-values', '{"template":"{{name}}"}'::json,
           FALSE, TRUE, 15, 'half', FALSE,
           '[{"language":"en-US","translation":"Prefill From Recipe"}]'::json,
           '[{"name":"prep only","rule":{"_and":[{"process_category":{"_eq":"sample_prep"}}]},"hidden":false,"readonly":false,"required":false}]'::json
    WHERE NOT EXISTS (
        SELECT 1 FROM directus_fields AS f
        WHERE f.collection = 'manufacturing_operations' AND f.field = 'source_recipe_id'
    )
    RETURNING id, collection, field
)
INSERT INTO d1_private.restore_inline_param_meta_changes (kind, collection, field, row_id)
SELECT 'field_row', collection, field, id FROM inserted
ON CONFLICT (kind, collection, field) DO UPDATE SET row_id = EXCLUDED.row_id;

-- 6b. The three o2m aliases, inserted only when their relation row (which names the alias) exists.
WITH inserted AS (
    INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options,
                                 readonly, hidden, sort, width, required, translations, conditions)
    SELECT v.collection, v.field, 'o2m', 'list-o2m', v.options::json, 'related-values', NULL,
           v.readonly, v.hidden, v.sort, 'full', FALSE, v.translations::json, v.conditions::json
    FROM (VALUES
        -- scripts/configure_sample_prep.sql
        ('manufacturing_operations', 'prep_steps',
         '{"template":"{{step_order}}. {{step_type}}","enableCreate":true,"enableSelect":false}',
         FALSE, TRUE, 16,
         '[{"language":"en-US","translation":"Preparation Steps"}]',
         '[{"name":"prep only","rule":{"_and":[{"process_category":{"_eq":"sample_prep"}}]},"hidden":false,"readonly":false,"required":false}]'),
        -- scripts/configure_operation_files.sql
        ('manufacturing_operations', 'data_file_links',
         '{"template":"{{file_name}} – {{file_kind}}","enableCreate":true,"enableSelect":false}',
         FALSE, FALSE, 620,
         '[{"language":"en-US","translation":"Data File Links"}]',
         NULL),
        -- scripts/configure_project_rollup.sql
        ('projects', 'rollup',
         '{"template":"{{kind}} – {{code}}","enableCreate":false,"enableSelect":false}',
         TRUE, FALSE, 14,
         '[{"language":"en-US","translation":"Project Rollup (read-only: operations + tooling used)"}]',
         NULL)
    ) AS v(collection, field, options, readonly, hidden, sort, translations, conditions)
    WHERE EXISTS (
        SELECT 1 FROM directus_relations AS r
        WHERE r.one_collection = v.collection AND r.one_field = v.field
    )
    AND NOT EXISTS (
        SELECT 1 FROM directus_fields AS f
        WHERE f.collection = v.collection AND f.field = v.field
    )
    RETURNING id, collection, field
)
INSERT INTO d1_private.restore_inline_param_meta_changes (kind, collection, field, row_id)
SELECT 'field_row', collection, field, id FROM inserted
ON CONFLICT (kind, collection, field) DO UPDATE SET row_id = EXCLUDED.row_id;

-- migrate:down
-- Undo exactly what `up` recorded, then drop the record. The prior state on the live database was
-- the broken one (these rows missing), and on a fresh install the rows pre-existed `up` and were
-- therefore never recorded, so there is nothing of theirs for this to remove. Rows are matched by
-- the id `up` stored, not by name: a configure_all.sh run after `up` deletes and re-inserts the
-- rows with new ids, and those belong to the scripts, not to this migration.
-- The sintering group rows go too if `up` created them; migration 101's own `down` runs after this
-- one and copes with their absence.
DO $$
BEGIN
    IF to_regclass('d1_private.restore_inline_param_meta_changes') IS NOT NULL THEN
        UPDATE directus_fields AS f SET hidden = FALSE
        FROM d1_private.restore_inline_param_meta_changes AS c
        WHERE c.kind = 'hidden_set' AND f.collection = c.collection AND f.field = c.field;

        UPDATE directus_fields AS f SET "group" = NULL
        FROM d1_private.restore_inline_param_meta_changes AS c
        WHERE c.kind = 'group_set' AND f.collection = c.collection AND f.field = c.field
          AND f."group" IN ('sintering_machine_group', 'sintering_qa_group');

        DELETE FROM directus_fields AS f
        USING d1_private.restore_inline_param_meta_changes AS c
        WHERE c.kind = 'field_row' AND f.id = c.row_id
          AND f.collection = c.collection AND f.field = c.field;

        DELETE FROM directus_relations AS r
        USING d1_private.restore_inline_param_meta_changes AS c
        WHERE c.kind = 'relation_row' AND r.id = c.row_id
          AND r.many_collection = c.collection AND r.many_field = c.field;

        DROP TABLE d1_private.restore_inline_param_meta_changes;
    END IF;
END
$$;
