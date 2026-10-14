-- migrate:up
-- Form layout (plan docs/superpowers/plans/2026-10-14-form-layout.md, decisions 2-12; follows the form QA of migration 173).
-- Directus metadata only: no stored value changes here (migration 175 converts the data, and defaults item_type to 'sample').
--
-- What this does, per decision:
--  2/3. Headed Field groups on the Sample, Operation, Test, Project, Campaign and Raw stock lot forms, in the order
--       What -> Who & where -> type-specific groups (parameters before results) -> Notes & files -> Related records -> Legacy / system.
--       Every group is a group-detail with special 'alias,no-data,group'; open by default except Related records and Legacy / system.
--       A conditional group is base-visible plus a "hide unless" condition. Related records is also hidden until the record has
--       been saved once for samples, operations and tests (a new form still carries short_id's default '', the first save sets it;
--       the primary key is absent from a new form's values, so a rule on it never matches). Projects and campaigns have no such column. Sintering keeps its two groups, now nested inside "Sintering".
--       The test groups: one "<Type> parameters" and, where the type measures outcomes, one "<Type> results" group. Results are the
--       measured outcomes: tensile Rp0.2/UTS/A%/Z%/E/fracture mode; hardness mean/std/min/max; charpy energy/lateral expansion/shear;
--       compression yield/peak stress/strain at fracture; tribology friction/wear rate/wear volume; optical microscopy, TEM and DCT notable
--       features (+ DCT grains indexed); Alicona Sa/Sz; CLEMX grain size/ASTM number/phase fraction; CT scan porosity + notable features;
--       fatigue cycles to failure/runout; creep time to rupture/steady-state rate/elongation/reduction of area; DMA storage and loss modulus,
--       tan delta, Tg. SEM and XRD have no result fields, so only a parameters group. Everything else of a type is a parameter.
--       Item Type is hidden; the blank-form bug it hid is fixed in step 5.
--  4.   Sorts are unique inside every (collection, group) of the six forms, and the tied sorts of tools, equipment, insert_types and
--       cutting_inserts are made unique without regrouping them.
--  5.   Lab Members cannot edit Co-owners or Secondary Investigators in the form: both aliases leave the create/update field lists of
--       their record's Lab Member rows (scripts/access_rules.json). READ stays '*' on purpose: STARbase's sample page and "mine" filters
--       query `co_owners` / `secondary_investigators`, and Directus answers any query that names a field the policy cannot read with
--       HTTP 403 (checked on the copy). So members see the picker read-only instead of not at all; admins (Administrator and Lab Admin
--       policies have admin_access) are unaffected.
--  6.   Legacy fields leave the forms (hidden, columns kept): the test capture/file/summary fields; the operation G-code file and
--       Experiment Sheet URL. The other operation legacy fields sit in Legacy / system and each shows only when it has a value.
--  7.   project_id on operations and tests uses d1-project-inherit; the Campaign picker is no longer filtered by campaign type.
--  8.   Choices: Surface Finish gains As produced / Medium machined; Equipment Type is the 29 stored values with readable text (AM
--       dropped, stored values unchanged); insert type Application, tools Op Type + Shank Type; the machining sub-type is exactly the
--       Force App's 12 MT-/MM- codes ("Other" dropped).
--  9.   Dimension labels (axes in the field notes), 10. collection names Samples / Operations / Tests (display names only).
--  11.  Required in the form: Sample Material, Manufacturing method, Geometry (not for rig kit); Operation Method, Date and, for
--       machining, Input sample; Test Test Type and Session Date. Directus enforces `required` in the form only, not on API saves.
--  And raw_stock_lots gets rows for purity_percent, mesh_size_micrometres and certificate_url, which had none.
--
-- A new sample form used to hide Material, Geometry and every dimension: those fields had a condition "item_type <> sample", true while
-- Item Type is still NULL. They now hide only for the explicit rig-kit values.
--
-- directus_fields has no unique key on (collection, field): new rows use NOT EXISTS. On CI the table is only partly filled (migration
-- 143's inline parameter rows), so the UPDATEs there touch what exists; tests/phase1_schema.sh seeds the rest and asserts both directions.
-- The pre-image of every touched row is kept in d1_private.form_layout_174_backup for the down section.

-- Step 1: bookkeeping. The pre-image of every row this migration touches goes to a table in d1_private (no grant to the
-- Ask-DB role), plus the ids of the rows it inserts, so the down section can restore the exact prior state.
-- Idempotent: a second run keeps the first pre-image (the table is the sign that the snapshot was taken).
DO $$
BEGIN
IF to_regclass('d1_private.form_layout_174_backup') IS NULL THEN
CREATE TABLE d1_private.form_layout_174_backup (
    kind       TEXT NOT NULL CHECK (kind IN ('field', 'collection', 'permission', 'inserted_field')),
    collection TEXT NOT NULL,
    item       TEXT NOT NULL,
    row_data   JSON
);
COMMENT ON TABLE d1_private.form_layout_174_backup IS 'Pre-image of the directus_fields, directus_collections and Lab Member directus_permissions rows that migration 20261014000174 (form layout) rewrote, and the field rows it inserted. Read by its down section, which drops the table. Never granted to the Ask-DB role.';
COMMENT ON COLUMN d1_private.form_layout_174_backup.kind IS 'field and collection: a full row before the change; permission: a Lab Member directus_permissions row before the change; inserted_field: a (collection, field) the migration added.';
COMMENT ON COLUMN d1_private.form_layout_174_backup.collection IS 'The Directus collection the row belongs to.';
COMMENT ON COLUMN d1_private.form_layout_174_backup.item IS 'The field name (field, inserted_field), the collection (collection) or the action (permission).';
COMMENT ON COLUMN d1_private.form_layout_174_backup.row_data IS 'to_json of the row as it was (json columns byte for byte), including its id; NULL for inserted_field.';

INSERT INTO d1_private.form_layout_174_backup (kind, collection, item, row_data)
SELECT 'field', collection, field, to_json(f) FROM directus_fields AS f
WHERE collection IN ('physical_samples', 'manufacturing_operations', 'test_sessions', 'projects', 'campaigns', 'raw_stock_lots', 'tools', 'equipment', 'insert_types', 'cutting_inserts');
INSERT INTO d1_private.form_layout_174_backup (kind, collection, item, row_data)
SELECT 'collection', collection, collection, to_json(c) FROM directus_collections AS c
WHERE collection IN ('physical_samples', 'manufacturing_operations', 'test_sessions');
INSERT INTO d1_private.form_layout_174_backup (kind, collection, item, row_data)
SELECT 'permission', collection, action, to_json(p) FROM directus_permissions AS p
WHERE policy = '20000002-0000-0000-0000-000000000002' AND action IN ('create', 'update') AND collection IN ('physical_samples', 'projects');
END IF;
END
$$;

-- BEGIN FORM LAYOUT (scripts/configure_form_layout.sql repeats this block exactly; tests/phase1_schema.sh compares them)
-- Step 2: the new Field groups and the three raw-stock columns that had no row. No unique key on (collection, field),
-- so NOT EXISTS. group-detail needs special = 'alias,no-data,group'; a conditional group is base-visible plus a
-- "hide unless" condition (without both the form crashes or the group cannot be shown again).
INSERT INTO directus_fields (collection, field, special, interface, options, hidden, readonly, sort, width, translations, conditions, "group")
SELECT v.collection, v.field, 'alias,no-data,group', 'group-detail', json_build_object('start', v.start), false, false, v.sort, 'full',
       v.label::json, v.cond::json, v.parent
FROM (VALUES
    ('physical_samples', 'grp_what', '[{"language":"en-US","translation":"What"}]', 'open', NULL, 10, NULL),
    ('physical_samples', 'grp_material', '[{"language":"en-US","translation":"Material & origin"}]', 'open', NULL, 20, '[{"name":"Hide for rig kit","rule":{"_and":[{"item_type":{"_in":["equipment","miscellaneous"]}}]},"hidden":true}]'),
    ('physical_samples', 'grp_geometry', '[{"language":"en-US","translation":"Geometry"}]', 'open', NULL, 30, '[{"name":"Hide for rig kit","rule":{"_and":[{"item_type":{"_in":["equipment","miscellaneous"]}}]},"hidden":true}]'),
    ('physical_samples', 'grp_surface', '[{"language":"en-US","translation":"Surface & mounting"}]', 'open', NULL, 40, '[{"name":"Hide for rig kit","rule":{"_and":[{"item_type":{"_in":["equipment","miscellaneous"]}}]},"hidden":true}]'),
    ('physical_samples', 'grp_who_where', '[{"language":"en-US","translation":"Who & where"}]', 'open', NULL, 50, NULL),
    ('physical_samples', 'grp_notes', '[{"language":"en-US","translation":"Notes"}]', 'open', NULL, 60, NULL),
    ('physical_samples', 'grp_related', '[{"language":"en-US","translation":"Related records"}]', 'closed', NULL, 70, '[{"name":"Hide until saved once","rule":{"_and":[{"short_id":{"_empty":true}}]},"hidden":true}]'),
    ('physical_samples', 'grp_legacy', '[{"language":"en-US","translation":"Legacy / system"}]', 'closed', NULL, 80, NULL),
    ('manufacturing_operations', 'grp_what', '[{"language":"en-US","translation":"What"}]', 'open', NULL, 10, NULL),
    ('manufacturing_operations', 'grp_who_where', '[{"language":"en-US","translation":"Who & where"}]', 'open', NULL, 20, NULL),
    ('manufacturing_operations', 'grp_tooling', '[{"language":"en-US","translation":"Tooling"}]', 'open', NULL, 30, '[{"name":"Hide unless machining","rule":{"_and":[{"process_category":{"_neq":"machining"}}]},"hidden":true}]'),
    ('manufacturing_operations', 'grp_cutting', '[{"language":"en-US","translation":"Cutting parameters"}]', 'open', NULL, 40, '[{"name":"Hide unless machining","rule":{"_and":[{"process_category":{"_neq":"machining"}}]},"hidden":true}]'),
    ('manufacturing_operations', 'grp_capture', '[{"language":"en-US","translation":"Data capture"}]', 'open', NULL, 50, '[{"name":"Hide unless machining","rule":{"_and":[{"process_category":{"_neq":"machining"}}]},"hidden":true}]'),
    ('manufacturing_operations', 'grp_sintering', '[{"language":"en-US","translation":"Sintering"}]', 'open', NULL, 60, '[{"name":"Hide unless sintering","rule":{"_and":[{"process_category":{"_neq":"sintering"}}]},"hidden":true}]'),
    ('manufacturing_operations', 'grp_heat_treatment', '[{"language":"en-US","translation":"Heat treatment"}]', 'open', NULL, 70, '[{"name":"Hide unless heat_treatment","rule":{"_and":[{"process_category":{"_neq":"heat_treatment"}}]},"hidden":true}]'),
    ('manufacturing_operations', 'grp_deformation', '[{"language":"en-US","translation":"Deformation"}]', 'open', NULL, 80, '[{"name":"Hide unless deformation","rule":{"_and":[{"process_category":{"_neq":"deformation"}}]},"hidden":true}]'),
    ('manufacturing_operations', 'grp_additive', '[{"language":"en-US","translation":"Additive"}]', 'open', NULL, 90, '[{"name":"Hide unless additive","rule":{"_and":[{"process_category":{"_neq":"additive"}}]},"hidden":true}]'),
    ('manufacturing_operations', 'grp_sample_prep', '[{"language":"en-US","translation":"Sample preparation"}]', 'open', NULL, 100, '[{"name":"Hide unless sample_prep","rule":{"_and":[{"process_category":{"_neq":"sample_prep"}}]},"hidden":true}]'),
    ('manufacturing_operations', 'grp_notes_files', '[{"language":"en-US","translation":"Notes & files"}]', 'open', NULL, 110, NULL),
    ('manufacturing_operations', 'grp_related', '[{"language":"en-US","translation":"Related records"}]', 'closed', NULL, 120, '[{"name":"Hide until saved once","rule":{"_and":[{"short_id":{"_empty":true}}]},"hidden":true}]'),
    ('manufacturing_operations', 'grp_legacy', '[{"language":"en-US","translation":"Legacy / system"}]', 'closed', NULL, 130, NULL),
    ('test_sessions', 'grp_what', '[{"language":"en-US","translation":"What"}]', 'open', NULL, 10, NULL),
    ('test_sessions', 'grp_who_where', '[{"language":"en-US","translation":"Who & where"}]', 'open', NULL, 20, NULL),
    ('test_sessions', 'grp_tensile_params', '[{"language":"en-US","translation":"Tensile parameters"}]', 'open', NULL, 30, '[{"name":"Hide unless tensile","rule":{"_and":[{"test_type":{"_neq":"tensile"}}]},"hidden":true}]'),
    ('test_sessions', 'grp_tensile_results', '[{"language":"en-US","translation":"Tensile results"}]', 'open', NULL, 40, '[{"name":"Hide unless tensile","rule":{"_and":[{"test_type":{"_neq":"tensile"}}]},"hidden":true}]'),
    ('test_sessions', 'grp_hardness_params', '[{"language":"en-US","translation":"Hardness parameters"}]', 'open', NULL, 50, '[{"name":"Hide unless hardness","rule":{"_and":[{"test_type":{"_neq":"hardness"}}]},"hidden":true}]'),
    ('test_sessions', 'grp_hardness_results', '[{"language":"en-US","translation":"Hardness results"}]', 'open', NULL, 60, '[{"name":"Hide unless hardness","rule":{"_and":[{"test_type":{"_neq":"hardness"}}]},"hidden":true}]'),
    ('test_sessions', 'grp_charpy_params', '[{"language":"en-US","translation":"Charpy impact parameters"}]', 'open', NULL, 70, '[{"name":"Hide unless charpy","rule":{"_and":[{"test_type":{"_neq":"charpy"}}]},"hidden":true}]'),
    ('test_sessions', 'grp_charpy_results', '[{"language":"en-US","translation":"Charpy impact results"}]', 'open', NULL, 80, '[{"name":"Hide unless charpy","rule":{"_and":[{"test_type":{"_neq":"charpy"}}]},"hidden":true}]'),
    ('test_sessions', 'grp_compression_params', '[{"language":"en-US","translation":"Compression parameters"}]', 'open', NULL, 90, '[{"name":"Hide unless compression","rule":{"_and":[{"test_type":{"_neq":"compression"}}]},"hidden":true}]'),
    ('test_sessions', 'grp_compression_results', '[{"language":"en-US","translation":"Compression results"}]', 'open', NULL, 100, '[{"name":"Hide unless compression","rule":{"_and":[{"test_type":{"_neq":"compression"}}]},"hidden":true}]'),
    ('test_sessions', 'grp_tribology_params', '[{"language":"en-US","translation":"Tribology parameters"}]', 'open', NULL, 110, '[{"name":"Hide unless tribology","rule":{"_and":[{"test_type":{"_neq":"tribology"}}]},"hidden":true}]'),
    ('test_sessions', 'grp_tribology_results', '[{"language":"en-US","translation":"Tribology results"}]', 'open', NULL, 120, '[{"name":"Hide unless tribology","rule":{"_and":[{"test_type":{"_neq":"tribology"}}]},"hidden":true}]'),
    ('test_sessions', 'grp_sem_params', '[{"language":"en-US","translation":"SEM / EBSD / EDS parameters"}]', 'open', NULL, 130, '[{"name":"Hide unless sem","rule":{"_and":[{"test_type":{"_neq":"sem"}}]},"hidden":true}]'),
    ('test_sessions', 'grp_xrd_params', '[{"language":"en-US","translation":"XRD parameters"}]', 'open', NULL, 140, '[{"name":"Hide unless xrd","rule":{"_and":[{"test_type":{"_neq":"xrd"}}]},"hidden":true}]'),
    ('test_sessions', 'grp_optical_microscopy_params', '[{"language":"en-US","translation":"Optical microscopy parameters"}]', 'open', NULL, 150, '[{"name":"Hide unless optical_microscopy","rule":{"_and":[{"test_type":{"_neq":"optical_microscopy"}}]},"hidden":true}]'),
    ('test_sessions', 'grp_optical_microscopy_results', '[{"language":"en-US","translation":"Optical microscopy results"}]', 'open', NULL, 160, '[{"name":"Hide unless optical_microscopy","rule":{"_and":[{"test_type":{"_neq":"optical_microscopy"}}]},"hidden":true}]'),
    ('test_sessions', 'grp_tem_params', '[{"language":"en-US","translation":"TEM parameters"}]', 'open', NULL, 170, '[{"name":"Hide unless tem","rule":{"_and":[{"test_type":{"_neq":"tem"}}]},"hidden":true}]'),
    ('test_sessions', 'grp_tem_results', '[{"language":"en-US","translation":"TEM results"}]', 'open', NULL, 180, '[{"name":"Hide unless tem","rule":{"_and":[{"test_type":{"_neq":"tem"}}]},"hidden":true}]'),
    ('test_sessions', 'grp_alicona_params', '[{"language":"en-US","translation":"Alicona parameters"}]', 'open', NULL, 190, '[{"name":"Hide unless alicona","rule":{"_and":[{"test_type":{"_neq":"alicona"}}]},"hidden":true}]'),
    ('test_sessions', 'grp_alicona_results', '[{"language":"en-US","translation":"Alicona results"}]', 'open', NULL, 200, '[{"name":"Hide unless alicona","rule":{"_and":[{"test_type":{"_neq":"alicona"}}]},"hidden":true}]'),
    ('test_sessions', 'grp_clemx_params', '[{"language":"en-US","translation":"CLEMX parameters"}]', 'open', NULL, 210, '[{"name":"Hide unless clemx","rule":{"_and":[{"test_type":{"_neq":"clemx"}}]},"hidden":true}]'),
    ('test_sessions', 'grp_clemx_results', '[{"language":"en-US","translation":"CLEMX results"}]', 'open', NULL, 220, '[{"name":"Hide unless clemx","rule":{"_and":[{"test_type":{"_neq":"clemx"}}]},"hidden":true}]'),
    ('test_sessions', 'grp_dct_params', '[{"language":"en-US","translation":"DCT parameters"}]', 'open', NULL, 230, '[{"name":"Hide unless dct","rule":{"_and":[{"test_type":{"_neq":"dct"}}]},"hidden":true}]'),
    ('test_sessions', 'grp_dct_results', '[{"language":"en-US","translation":"DCT results"}]', 'open', NULL, 240, '[{"name":"Hide unless dct","rule":{"_and":[{"test_type":{"_neq":"dct"}}]},"hidden":true}]'),
    ('test_sessions', 'grp_ct_scan_params', '[{"language":"en-US","translation":"CT scan parameters"}]', 'open', NULL, 250, '[{"name":"Hide unless ct_scan","rule":{"_and":[{"test_type":{"_neq":"ct_scan"}}]},"hidden":true}]'),
    ('test_sessions', 'grp_ct_scan_results', '[{"language":"en-US","translation":"CT scan results"}]', 'open', NULL, 260, '[{"name":"Hide unless ct_scan","rule":{"_and":[{"test_type":{"_neq":"ct_scan"}}]},"hidden":true}]'),
    ('test_sessions', 'grp_fatigue_params', '[{"language":"en-US","translation":"Fatigue parameters"}]', 'open', NULL, 270, '[{"name":"Hide unless fatigue","rule":{"_and":[{"test_type":{"_neq":"fatigue"}}]},"hidden":true}]'),
    ('test_sessions', 'grp_fatigue_results', '[{"language":"en-US","translation":"Fatigue results"}]', 'open', NULL, 280, '[{"name":"Hide unless fatigue","rule":{"_and":[{"test_type":{"_neq":"fatigue"}}]},"hidden":true}]'),
    ('test_sessions', 'grp_creep_params', '[{"language":"en-US","translation":"Creep parameters"}]', 'open', NULL, 290, '[{"name":"Hide unless creep","rule":{"_and":[{"test_type":{"_neq":"creep"}}]},"hidden":true}]'),
    ('test_sessions', 'grp_creep_results', '[{"language":"en-US","translation":"Creep results"}]', 'open', NULL, 300, '[{"name":"Hide unless creep","rule":{"_and":[{"test_type":{"_neq":"creep"}}]},"hidden":true}]'),
    ('test_sessions', 'grp_dma_params', '[{"language":"en-US","translation":"DMA parameters"}]', 'open', NULL, 310, '[{"name":"Hide unless dma","rule":{"_and":[{"test_type":{"_neq":"dma"}}]},"hidden":true}]'),
    ('test_sessions', 'grp_dma_results', '[{"language":"en-US","translation":"DMA results"}]', 'open', NULL, 320, '[{"name":"Hide unless dma","rule":{"_and":[{"test_type":{"_neq":"dma"}}]},"hidden":true}]'),
    ('test_sessions', 'grp_notes_files', '[{"language":"en-US","translation":"Notes & files"}]', 'open', NULL, 330, NULL),
    ('test_sessions', 'grp_related', '[{"language":"en-US","translation":"Related records"}]', 'closed', NULL, 340, '[{"name":"Hide until saved once","rule":{"_and":[{"short_id":{"_empty":true}}]},"hidden":true}]'),
    ('test_sessions', 'grp_legacy', '[{"language":"en-US","translation":"Legacy / system"}]', 'closed', NULL, 350, NULL),
    ('projects', 'grp_what', '[{"language":"en-US","translation":"What"}]', 'open', NULL, 10, NULL),
    ('projects', 'grp_who', '[{"language":"en-US","translation":"Who"}]', 'open', NULL, 20, NULL),
    ('projects', 'grp_related', '[{"language":"en-US","translation":"Related records"}]', 'closed', NULL, 30, NULL),
    ('projects', 'grp_legacy', '[{"language":"en-US","translation":"Legacy / system"}]', 'closed', NULL, 40, NULL),
    ('campaigns', 'grp_what', '[{"language":"en-US","translation":"What"}]', 'open', NULL, 10, NULL),
    ('campaigns', 'grp_who_where', '[{"language":"en-US","translation":"Who & where"}]', 'open', NULL, 20, NULL),
    ('campaigns', 'grp_notes', '[{"language":"en-US","translation":"Notes"}]', 'open', NULL, 30, NULL),
    ('campaigns', 'grp_related', '[{"language":"en-US","translation":"Related records"}]', 'closed', NULL, 40, NULL),
    ('campaigns', 'grp_legacy', '[{"language":"en-US","translation":"Legacy / system"}]', 'closed', NULL, 50, NULL),
    ('raw_stock_lots', 'grp_what', '[{"language":"en-US","translation":"What"}]', 'open', NULL, 10, NULL),
    ('raw_stock_lots', 'grp_supplier', '[{"language":"en-US","translation":"Supplier"}]', 'open', NULL, 20, NULL),
    ('raw_stock_lots', 'grp_quantity', '[{"language":"en-US","translation":"Quantity"}]', 'open', NULL, 30, NULL),
    ('raw_stock_lots', 'grp_notes', '[{"language":"en-US","translation":"Notes"}]', 'open', NULL, 40, NULL)
) AS v (collection, field, label, start, parent, sort, cond)
WHERE NOT EXISTS (SELECT 1 FROM directus_fields AS d WHERE d.collection = v.collection AND d.field = v.field);

INSERT INTO directus_fields (collection, field, interface, options, hidden, readonly, sort, width, translations, note)
SELECT v.collection, v.field, 'input', v.options::json, false, false, 0, v.width, v.label::json, v.note
FROM (VALUES
    ('raw_stock_lots', 'purity_percent', '{"step":0.001,"suffix":"%","min":0,"max":100}', 'half', '[{"language":"en-US","translation":"Purity %"}]', 'Supplier-stated purity of the lot.'),
    ('raw_stock_lots', 'mesh_size_micrometres', '{"step":0.1,"suffix":"µm","min":0}', 'half', '[{"language":"en-US","translation":"Mesh Size µm"}]', 'Powder only: the sieve mesh.'),
    ('raw_stock_lots', 'certificate_url', '{}', 'full', '[{"language":"en-US","translation":"Certificate URL"}]', 'Link to the supplier certificate of analysis.')
) AS v (collection, field, options, width, label, note)
WHERE NOT EXISTS (SELECT 1 FROM directus_fields AS d WHERE d.collection = v.collection AND d.field = v.field);

-- Step 3: place every field: its Field group and a sort that is unique inside that group (decision 3), and its width. The Inventory
-- and Reference forms keep their groups (none): their rows only get a unique sort each, in their current order (decision 4).
UPDATE directus_fields AS f
SET "group" = v.grp, sort = v.sort, width = COALESCE(v.width, f.width)
FROM (VALUES
    ('physical_samples', 'report_button', NULL, 0, NULL),
    ('physical_samples', 'sample_code', 'grp_what', 10, NULL),
    ('physical_samples', 'nickname', 'grp_what', 20, NULL),
    ('physical_samples', 'current_status', 'grp_what', 30, NULL),
    ('physical_samples', 'material_id', 'grp_material', 10, NULL),
    ('physical_samples', 'primary_method_id', 'grp_material', 20, NULL),
    ('physical_samples', 'stock_category', 'grp_material', 30, NULL),
    ('physical_samples', 'manufactured_date', 'grp_material', 40, NULL),
    ('physical_samples', 'form', 'grp_geometry', 10, NULL),
    ('physical_samples', 'mass_grams', 'grp_geometry', 20, NULL),
    ('physical_samples', 'diameter_mm', 'grp_geometry', 30, NULL),
    ('physical_samples', 'inner_diameter_mm', 'grp_geometry', 40, NULL),
    ('physical_samples', 'width_mm', 'grp_geometry', 50, NULL),
    ('physical_samples', 'thickness_mm', 'grp_geometry', 60, NULL),
    ('physical_samples', 'length_mm', 'grp_geometry', 70, NULL),
    ('physical_samples', 'gauge_length_mm', 'grp_geometry', 80, NULL),
    ('physical_samples', 'gauge_width_mm', 'grp_geometry', 90, NULL),
    ('physical_samples', 'geometry_preview', 'grp_geometry', 100, 'full'),
    ('physical_samples', 'surface_finish', 'grp_surface', 10, NULL),
    ('physical_samples', 'mounted', 'grp_surface', 20, NULL),
    ('physical_samples', 'mounting_method', 'grp_surface', 30, NULL),
    ('physical_samples', 'owner_person_id', 'grp_who_where', 10, NULL),
    ('physical_samples', 'project_id', 'grp_who_where', 20, NULL),
    ('physical_samples', 'co_owners', 'grp_who_where', 30, NULL),
    ('physical_samples', 'location', 'grp_who_where', 40, NULL),
    ('physical_samples', 'export_controlled', 'grp_who_where', 50, NULL),
    ('physical_samples', 'notes', 'grp_notes', 10, NULL),
    ('physical_samples', 'campaigns', 'grp_related', 10, NULL),
    ('physical_samples', 'manufacturing_operations', 'grp_related', 20, NULL),
    ('physical_samples', 'produced_by_operations', 'grp_related', 30, NULL),
    ('physical_samples', 'child_samples', 'grp_related', 40, NULL),
    ('physical_samples', 'test_sessions', 'grp_related', 50, NULL),
    ('physical_samples', 'data_files', 'grp_related', 60, NULL),
    ('physical_samples', 'data_files_open', 'grp_related', 70, NULL),
    ('physical_samples', 'short_id', 'grp_legacy', 10, NULL),
    ('physical_samples', 'created_by', 'grp_legacy', 20, NULL),
    ('manufacturing_operations', 'report_button', NULL, 0, NULL),
    ('manufacturing_operations', 'method_id', 'grp_what', 10, NULL),
    ('manufacturing_operations', 'process_category', 'grp_what', 20, NULL),
    ('manufacturing_operations', 'sample_id', 'grp_what', 30, NULL),
    ('manufacturing_operations', 'output_sample_id', 'grp_what', 40, NULL),
    ('manufacturing_operations', 'operation_date', 'grp_what', 50, NULL),
    ('manufacturing_operations', 'machining_operation_subtype', 'grp_what', 60, NULL),
    ('manufacturing_operations', 'pass_code', 'grp_what', 70, 'full'),
    ('manufacturing_operations', 'equipment_id', 'grp_who_where', 10, NULL),
    ('manufacturing_operations', 'operator_person_id', 'grp_who_where', 20, NULL),
    ('manufacturing_operations', 'owner_person_id', 'grp_who_where', 30, NULL),
    ('manufacturing_operations', 'additional_operators', 'grp_who_where', 40, NULL),
    ('manufacturing_operations', 'campaign_id', 'grp_who_where', 50, NULL),
    ('manufacturing_operations', 'project_id', 'grp_who_where', 60, NULL),
    ('manufacturing_operations', 'material_id', 'grp_who_where', 70, NULL),
    ('manufacturing_operations', 'tool_id', 'grp_tooling', 10, NULL),
    ('manufacturing_operations', 'insert_edge_id', 'grp_tooling', 20, NULL),
    ('manufacturing_operations', 'machining_new_edge', 'grp_tooling', 30, NULL),
    ('manufacturing_operations', 'operation_sequence', 'grp_cutting', 10, NULL),
    ('manufacturing_operations', 'machining_spindle_speed_rpm', 'grp_cutting', 20, NULL),
    ('manufacturing_operations', 'machining_cutting_speed_m_per_min', 'grp_cutting', 30, NULL),
    ('manufacturing_operations', 'machining_feed_mm_per_rev', 'grp_cutting', 40, NULL),
    ('manufacturing_operations', 'machining_axial_depth_of_cut_mm', 'grp_cutting', 50, NULL),
    ('manufacturing_operations', 'machining_radial_depth_of_cut_mm', 'grp_cutting', 60, NULL),
    ('manufacturing_operations', 'machining_cutting_length_mm', 'grp_cutting', 70, NULL),
    ('manufacturing_operations', 'machining_workpiece_diameter_mm', 'grp_cutting', 80, NULL),
    ('manufacturing_operations', 'machining_coolant_used', 'grp_cutting', 90, NULL),
    ('manufacturing_operations', 'machining_coolant_pressure_bar', 'grp_cutting', 100, NULL),
    ('manufacturing_operations', 'machining_chips_collected', 'grp_cutting', 110, NULL),
    ('manufacturing_operations', 'machining_chips_ref_code', 'grp_cutting', 120, NULL),
    ('manufacturing_operations', 'machining_force_captured', 'grp_capture', 10, NULL),
    ('manufacturing_operations', 'machining_tacho_used', 'grp_capture', 20, NULL),
    ('manufacturing_operations', 'sintering_machine_group', 'grp_sintering', 10, NULL),
    ('manufacturing_operations', 'sintering_run_number', 'sintering_machine_group', 10, NULL),
    ('manufacturing_operations', 'fast_recipe_id', 'sintering_machine_group', 20, NULL),
    ('manufacturing_operations', 'sintering_recipe_number', 'sintering_machine_group', 30, NULL),
    ('manufacturing_operations', 'sintering_batch_number', 'sintering_machine_group', 40, NULL),
    ('manufacturing_operations', 'sintering_mould_diameter_mm', 'sintering_machine_group', 50, NULL),
    ('manufacturing_operations', 'sintering_atmosphere', 'sintering_machine_group', 60, NULL),
    ('manufacturing_operations', 'sintering_tc_pyro_control', 'sintering_machine_group', 70, NULL),
    ('manufacturing_operations', 'sintering_mass_grams', 'sintering_machine_group', 80, NULL),
    ('manufacturing_operations', 'sintering_max_temp_celsius', 'sintering_machine_group', 90, NULL),
    ('manufacturing_operations', 'sintering_max_force_kn', 'sintering_machine_group', 100, NULL),
    ('manufacturing_operations', 'sintering_material_type_note', 'sintering_machine_group', 110, NULL),
    ('manufacturing_operations', 'sintering_qa_group', 'grp_sintering', 20, NULL),
    ('manufacturing_operations', 'sintering_voltage_at_max_t_v', 'sintering_qa_group', 10, NULL),
    ('manufacturing_operations', 'sintering_power_at_max_t_kw', 'sintering_qa_group', 20, NULL),
    ('manufacturing_operations', 'sintering_ptc_top_celsius', 'sintering_qa_group', 30, NULL),
    ('manufacturing_operations', 'sintering_ptc_bot_celsius', 'sintering_qa_group', 40, NULL),
    ('manufacturing_operations', 'sintering_coshh_ref', 'sintering_qa_group', 50, NULL),
    ('manufacturing_operations', 'ht_treatment_type', 'grp_heat_treatment', 10, NULL),
    ('manufacturing_operations', 'ht_atmosphere', 'grp_heat_treatment', 20, NULL),
    ('manufacturing_operations', 'ht_peak_temp_celsius', 'grp_heat_treatment', 30, NULL),
    ('manufacturing_operations', 'ht_hold_time_min', 'grp_heat_treatment', 40, NULL),
    ('manufacturing_operations', 'ht_heating_rate_c_per_min', 'grp_heat_treatment', 50, NULL),
    ('manufacturing_operations', 'ht_cooling_method', 'grp_heat_treatment', 60, NULL),
    ('manufacturing_operations', 'ht_cooling_rate_c_per_min', 'grp_heat_treatment', 70, NULL),
    ('manufacturing_operations', 'ht_quench_medium', 'grp_heat_treatment', 80, NULL),
    ('manufacturing_operations', 'deform_deformation_type', 'grp_deformation', 10, NULL),
    ('manufacturing_operations', 'deform_deformation_temp_celsius', 'grp_deformation', 20, NULL),
    ('manufacturing_operations', 'deform_pass_count', 'grp_deformation', 30, NULL),
    ('manufacturing_operations', 'deform_total_reduction_pct', 'grp_deformation', 40, NULL),
    ('manufacturing_operations', 'deform_reduction_per_pass_pct', 'grp_deformation', 50, NULL),
    ('manufacturing_operations', 'deform_strain_rate_per_sec', 'grp_deformation', 60, NULL),
    ('manufacturing_operations', 'deform_roll_speed_m_per_min', 'grp_deformation', 70, NULL),
    ('manufacturing_operations', 'deform_lubricant', 'grp_deformation', 80, NULL),
    ('manufacturing_operations', 'am_process_variant', 'grp_additive', 10, NULL),
    ('manufacturing_operations', 'am_layer_thickness_mm', 'grp_additive', 20, NULL),
    ('manufacturing_operations', 'am_laser_power_w', 'grp_additive', 30, NULL),
    ('manufacturing_operations', 'am_scan_speed_mm_per_s', 'grp_additive', 40, NULL),
    ('manufacturing_operations', 'am_hatch_spacing_mm', 'grp_additive', 50, NULL),
    ('manufacturing_operations', 'am_energy_density_j_per_mm3', 'grp_additive', 60, NULL),
    ('manufacturing_operations', 'am_build_atmosphere', 'grp_additive', 70, NULL),
    ('manufacturing_operations', 'am_preheat_temp_celsius', 'grp_additive', 80, NULL),
    ('manufacturing_operations', 'source_recipe_id', 'grp_sample_prep', 10, NULL),
    ('manufacturing_operations', 'prep_steps', 'grp_sample_prep', 20, NULL),
    ('manufacturing_operations', 'outcome_notes', 'grp_notes_files', 10, NULL),
    ('manufacturing_operations', 'data_file_links', 'grp_notes_files', 20, NULL),
    ('manufacturing_operations', 'force_analyses', 'grp_related', 10, NULL),
    ('manufacturing_operations', 'fast_run', 'grp_related', 20, NULL),
    ('manufacturing_operations', 'data_files_open', 'grp_related', 30, NULL),
    ('manufacturing_operations', 'short_id', 'grp_legacy', 10, NULL),
    ('manufacturing_operations', 'created_by', 'grp_legacy', 20, NULL),
    ('manufacturing_operations', 'machining_legacy_insert_edge_id', 'grp_legacy', 30, NULL),
    ('manufacturing_operations', 'machining_legacy_machining_uid', 'grp_legacy', 40, NULL),
    ('manufacturing_operations', 'file_storage_pointer', 'grp_legacy', 50, NULL),
    ('manufacturing_operations', 'capture_software', 'grp_legacy', 60, NULL),
    ('manufacturing_operations', 'capture_frequency_khz', 'grp_legacy', 70, NULL),
    ('manufacturing_operations', 'nc_program_text', 'grp_legacy', 80, NULL),
    ('test_sessions', 'report_button', NULL, 0, NULL),
    ('test_sessions', 'test_type', 'grp_what', 10, NULL),
    ('test_sessions', 'test_category', 'grp_what', 20, NULL),
    ('test_sessions', 'subject', 'grp_what', 30, 'full'),
    ('test_sessions', 'session_date', 'grp_what', 40, NULL),
    ('test_sessions', 'status', 'grp_what', 50, NULL),
    ('test_sessions', 'equipment_id', 'grp_who_where', 10, NULL),
    ('test_sessions', 'operator_person_id', 'grp_who_where', 20, NULL),
    ('test_sessions', 'owner_person_id', 'grp_who_where', 30, NULL),
    ('test_sessions', 'additional_operators', 'grp_who_where', 40, NULL),
    ('test_sessions', 'campaign_id', 'grp_who_where', 50, NULL),
    ('test_sessions', 'project_id', 'grp_who_where', 60, NULL),
    ('test_sessions', 'tensile_specimen_geometry', 'grp_tensile_params', 10, NULL),
    ('test_sessions', 'tensile_gauge_length_mm', 'grp_tensile_params', 20, NULL),
    ('test_sessions', 'tensile_gauge_diameter_mm', 'grp_tensile_params', 30, NULL),
    ('test_sessions', 'tensile_gauge_width_mm', 'grp_tensile_params', 40, NULL),
    ('test_sessions', 'tensile_gauge_thickness_mm', 'grp_tensile_params', 50, NULL),
    ('test_sessions', 'tensile_crosshead_speed_mm_per_min', 'grp_tensile_params', 60, NULL),
    ('test_sessions', 'tensile_strain_rate_per_s', 'grp_tensile_params', 70, NULL),
    ('test_sessions', 'tensile_test_temp_celsius', 'grp_tensile_params', 80, NULL),
    ('test_sessions', 'tensile_extensometer_used', 'grp_tensile_params', 90, NULL),
    ('test_sessions', 'tensile_yield_strength_mpa', 'grp_tensile_results', 10, NULL),
    ('test_sessions', 'tensile_uts_mpa', 'grp_tensile_results', 20, NULL),
    ('test_sessions', 'tensile_elongation_pct', 'grp_tensile_results', 30, NULL),
    ('test_sessions', 'tensile_reduction_of_area_pct', 'grp_tensile_results', 40, NULL),
    ('test_sessions', 'tensile_youngs_modulus_gpa', 'grp_tensile_results', 50, NULL),
    ('test_sessions', 'tensile_fracture_mode', 'grp_tensile_results', 60, NULL),
    ('test_sessions', 'hardness_hardness_scale', 'grp_hardness_params', 10, NULL),
    ('test_sessions', 'hardness_load_gf', 'grp_hardness_params', 20, NULL),
    ('test_sessions', 'hardness_dwell_time_s', 'grp_hardness_params', 30, NULL),
    ('test_sessions', 'hardness_indenter_type', 'grp_hardness_params', 40, NULL),
    ('test_sessions', 'hardness_n_indentations', 'grp_hardness_params', 50, NULL),
    ('test_sessions', 'hardness_surface_finish', 'grp_hardness_params', 60, NULL),
    ('test_sessions', 'hardness_mean_hardness', 'grp_hardness_results', 10, NULL),
    ('test_sessions', 'hardness_std_dev_hardness', 'grp_hardness_results', 20, NULL),
    ('test_sessions', 'hardness_min_hardness', 'grp_hardness_results', 30, NULL),
    ('test_sessions', 'hardness_max_hardness', 'grp_hardness_results', 40, NULL),
    ('test_sessions', 'charpy_specimen_standard', 'grp_charpy_params', 10, NULL),
    ('test_sessions', 'charpy_notch_type', 'grp_charpy_params', 20, NULL),
    ('test_sessions', 'charpy_notch_depth_mm', 'grp_charpy_params', 30, NULL),
    ('test_sessions', 'charpy_specimen_width_mm', 'grp_charpy_params', 40, NULL),
    ('test_sessions', 'charpy_specimen_height_mm', 'grp_charpy_params', 50, NULL),
    ('test_sessions', 'charpy_test_temp_celsius', 'grp_charpy_params', 60, NULL),
    ('test_sessions', 'charpy_orientation', 'grp_charpy_params', 70, NULL),
    ('test_sessions', 'charpy_absorbed_energy_j', 'grp_charpy_results', 10, NULL),
    ('test_sessions', 'charpy_lateral_expansion_mm', 'grp_charpy_results', 20, NULL),
    ('test_sessions', 'charpy_shear_fracture_pct', 'grp_charpy_results', 30, NULL),
    ('test_sessions', 'compression_specimen_diameter_mm', 'grp_compression_params', 10, NULL),
    ('test_sessions', 'compression_specimen_height_mm', 'grp_compression_params', 20, NULL),
    ('test_sessions', 'compression_crosshead_speed_mm_per_min', 'grp_compression_params', 30, NULL),
    ('test_sessions', 'compression_strain_rate_per_s', 'grp_compression_params', 40, NULL),
    ('test_sessions', 'compression_test_temp_celsius', 'grp_compression_params', 50, NULL),
    ('test_sessions', 'compression_lubrication', 'grp_compression_params', 60, NULL),
    ('test_sessions', 'compression_yield_strength_mpa', 'grp_compression_results', 10, NULL),
    ('test_sessions', 'compression_peak_stress_mpa', 'grp_compression_results', 20, NULL),
    ('test_sessions', 'compression_strain_at_fracture_pct', 'grp_compression_results', 30, NULL),
    ('test_sessions', 'tribology_test_standard', 'grp_tribology_params', 10, NULL),
    ('test_sessions', 'tribology_configuration', 'grp_tribology_params', 20, NULL),
    ('test_sessions', 'tribology_counterface_material', 'grp_tribology_params', 30, NULL),
    ('test_sessions', 'tribology_normal_load_n', 'grp_tribology_params', 40, NULL),
    ('test_sessions', 'tribology_sliding_speed_m_per_s', 'grp_tribology_params', 50, NULL),
    ('test_sessions', 'tribology_sliding_distance_m', 'grp_tribology_params', 60, NULL),
    ('test_sessions', 'tribology_lubrication', 'grp_tribology_params', 70, NULL),
    ('test_sessions', 'tribology_test_temp_celsius', 'grp_tribology_params', 80, NULL),
    ('test_sessions', 'tribology_coefficient_of_friction', 'grp_tribology_results', 10, NULL),
    ('test_sessions', 'tribology_wear_rate_mm3_per_nm', 'grp_tribology_results', 20, NULL),
    ('test_sessions', 'tribology_wear_volume_mm3', 'grp_tribology_results', 30, NULL),
    ('test_sessions', 'sem_imaging_mode', 'grp_sem_params', 10, NULL),
    ('test_sessions', 'sem_accelerating_voltage_kv', 'grp_sem_params', 20, NULL),
    ('test_sessions', 'sem_working_distance_mm', 'grp_sem_params', 30, NULL),
    ('test_sessions', 'sem_magnification_range', 'grp_sem_params', 40, NULL),
    ('test_sessions', 'sem_beam_current_na', 'grp_sem_params', 50, NULL),
    ('test_sessions', 'sem_coating_material', 'grp_sem_params', 60, NULL),
    ('test_sessions', 'sem_coating_thickness_nm', 'grp_sem_params', 70, NULL),
    ('test_sessions', 'sem_etchant', 'grp_sem_params', 80, NULL),
    ('test_sessions', 'sem_step_size_um', 'grp_sem_params', 90, NULL),
    ('test_sessions', 'xrd_radiation_source', 'grp_xrd_params', 10, NULL),
    ('test_sessions', 'xrd_wavelength_angstrom', 'grp_xrd_params', 20, NULL),
    ('test_sessions', 'xrd_two_theta_range_deg', 'grp_xrd_params', 30, NULL),
    ('test_sessions', 'xrd_step_size_deg', 'grp_xrd_params', 40, NULL),
    ('test_sessions', 'xrd_scan_speed_deg_per_min', 'grp_xrd_params', 50, NULL),
    ('test_sessions', 'xrd_detector_type', 'grp_xrd_params', 60, NULL),
    ('test_sessions', 'xrd_sample_prep', 'grp_xrd_params', 70, NULL),
    ('test_sessions', 'optical_microscopy_mode', 'grp_optical_microscopy_params', 10, NULL),
    ('test_sessions', 'optical_microscopy_objective_magnification', 'grp_optical_microscopy_params', 20, NULL),
    ('test_sessions', 'optical_microscopy_etchant', 'grp_optical_microscopy_params', 30, NULL),
    ('test_sessions', 'optical_microscopy_etch_time_s', 'grp_optical_microscopy_params', 40, NULL),
    ('test_sessions', 'optical_microscopy_image_scale_um_per_px', 'grp_optical_microscopy_params', 50, NULL),
    ('test_sessions', 'optical_microscopy_notable_features', 'grp_optical_microscopy_results', 10, NULL),
    ('test_sessions', 'tem_operating_voltage_kv', 'grp_tem_params', 10, NULL),
    ('test_sessions', 'tem_imaging_mode', 'grp_tem_params', 20, NULL),
    ('test_sessions', 'tem_camera_length_mm', 'grp_tem_params', 30, NULL),
    ('test_sessions', 'tem_specimen_prep', 'grp_tem_params', 40, NULL),
    ('test_sessions', 'tem_magnification_range', 'grp_tem_params', 50, NULL),
    ('test_sessions', 'tem_notable_features', 'grp_tem_results', 10, NULL),
    ('test_sessions', 'alicona_objective_magnification', 'grp_alicona_params', 10, NULL),
    ('test_sessions', 'alicona_vertical_resolution_nm', 'grp_alicona_params', 20, NULL),
    ('test_sessions', 'alicona_lateral_resolution_um', 'grp_alicona_params', 30, NULL),
    ('test_sessions', 'alicona_measured_area', 'grp_alicona_params', 40, NULL),
    ('test_sessions', 'alicona_sa_um', 'grp_alicona_results', 10, NULL),
    ('test_sessions', 'alicona_sz_um', 'grp_alicona_results', 20, NULL),
    ('test_sessions', 'clemx_analysis_type', 'grp_clemx_params', 10, NULL),
    ('test_sessions', 'clemx_objective_magnification', 'grp_clemx_params', 20, NULL),
    ('test_sessions', 'clemx_n_fields_analysed', 'grp_clemx_params', 30, NULL),
    ('test_sessions', 'clemx_etchant', 'grp_clemx_params', 40, NULL),
    ('test_sessions', 'clemx_mean_grain_size_um', 'grp_clemx_results', 10, NULL),
    ('test_sessions', 'clemx_astm_grain_size_number', 'grp_clemx_results', 20, NULL),
    ('test_sessions', 'clemx_phase_fraction_pct', 'grp_clemx_results', 30, NULL),
    ('test_sessions', 'dct_beam_energy_kev', 'grp_dct_params', 10, NULL),
    ('test_sessions', 'dct_voxel_size_um', 'grp_dct_params', 20, NULL),
    ('test_sessions', 'dct_n_projections', 'grp_dct_params', 30, NULL),
    ('test_sessions', 'dct_scan_time_min', 'grp_dct_params', 40, NULL),
    ('test_sessions', 'dct_n_grains_indexed', 'grp_dct_results', 10, NULL),
    ('test_sessions', 'dct_notable_features', 'grp_dct_results', 20, NULL),
    ('test_sessions', 'ct_scan_tube_voltage_kv', 'grp_ct_scan_params', 10, NULL),
    ('test_sessions', 'ct_scan_tube_current_ua', 'grp_ct_scan_params', 20, NULL),
    ('test_sessions', 'ct_scan_voxel_size_um', 'grp_ct_scan_params', 30, NULL),
    ('test_sessions', 'ct_scan_n_projections', 'grp_ct_scan_params', 40, NULL),
    ('test_sessions', 'ct_scan_exposure_time_ms', 'grp_ct_scan_params', 50, NULL),
    ('test_sessions', 'ct_scan_filter_material', 'grp_ct_scan_params', 60, NULL),
    ('test_sessions', 'ct_scan_porosity_pct', 'grp_ct_scan_results', 10, NULL),
    ('test_sessions', 'ct_scan_notable_features', 'grp_ct_scan_results', 20, NULL),
    ('test_sessions', 'fatigue_loading_mode', 'grp_fatigue_params', 10, NULL),
    ('test_sessions', 'fatigue_stress_ratio_r', 'grp_fatigue_params', 20, NULL),
    ('test_sessions', 'fatigue_max_stress_mpa', 'grp_fatigue_params', 30, NULL),
    ('test_sessions', 'fatigue_stress_amplitude_mpa', 'grp_fatigue_params', 40, NULL),
    ('test_sessions', 'fatigue_frequency_hz', 'grp_fatigue_params', 50, NULL),
    ('test_sessions', 'fatigue_waveform', 'grp_fatigue_params', 60, NULL),
    ('test_sessions', 'fatigue_test_temp_celsius', 'grp_fatigue_params', 70, NULL),
    ('test_sessions', 'fatigue_cycles_to_failure', 'grp_fatigue_results', 10, NULL),
    ('test_sessions', 'fatigue_runout', 'grp_fatigue_results', 20, NULL),
    ('test_sessions', 'creep_applied_stress_mpa', 'grp_creep_params', 10, NULL),
    ('test_sessions', 'creep_test_temp_celsius', 'grp_creep_params', 20, NULL),
    ('test_sessions', 'creep_atmosphere', 'grp_creep_params', 30, NULL),
    ('test_sessions', 'creep_time_to_rupture_h', 'grp_creep_results', 10, NULL),
    ('test_sessions', 'creep_steady_state_creep_rate_per_s', 'grp_creep_results', 20, NULL),
    ('test_sessions', 'creep_rupture_elongation_pct', 'grp_creep_results', 30, NULL),
    ('test_sessions', 'creep_reduction_of_area_pct', 'grp_creep_results', 40, NULL),
    ('test_sessions', 'dma_deformation_mode', 'grp_dma_params', 10, NULL),
    ('test_sessions', 'dma_frequency_hz', 'grp_dma_params', 20, NULL),
    ('test_sessions', 'dma_temperature_range', 'grp_dma_params', 30, NULL),
    ('test_sessions', 'dma_heating_rate_c_per_min', 'grp_dma_params', 40, NULL),
    ('test_sessions', 'dma_amplitude_um', 'grp_dma_params', 50, NULL),
    ('test_sessions', 'dma_storage_modulus_mpa', 'grp_dma_results', 10, NULL),
    ('test_sessions', 'dma_loss_modulus_mpa', 'grp_dma_results', 20, NULL),
    ('test_sessions', 'dma_tan_delta', 'grp_dma_results', 30, NULL),
    ('test_sessions', 'dma_glass_transition_celsius', 'grp_dma_results', 40, NULL),
    ('test_sessions', 'notes', 'grp_notes_files', 10, NULL),
    ('test_sessions', 'data_files', 'grp_notes_files', 20, NULL),
    ('test_sessions', 'data_files_open', 'grp_related', 10, NULL),
    ('test_sessions', 'test_code', 'grp_legacy', 10, NULL),
    ('test_sessions', 'short_id', 'grp_legacy', 20, NULL),
    ('test_sessions', 'created_by', 'grp_legacy', 30, NULL),
    ('projects', 'project_name', 'grp_what', 10, NULL),
    ('projects', 'project_code', 'grp_what', 20, NULL),
    ('projects', 'is_active', 'grp_what', 30, NULL),
    ('projects', 'start_date', 'grp_what', 40, NULL),
    ('projects', 'end_date', 'grp_what', 50, NULL),
    ('projects', 'description', 'grp_what', 60, NULL),
    ('projects', 'Image', 'grp_what', 70, 'full'),
    ('projects', 'principal_investigator_person', 'grp_who', 10, NULL),
    ('projects', 'export_controlled', 'grp_who', 20, NULL),
    ('projects', 'investigator_access_notice', 'grp_who', 30, NULL),
    ('projects', 'secondary_investigators', 'grp_who', 40, NULL),
    ('projects', 'campaigns', 'grp_related', 10, NULL),
    ('projects', 'project_items', 'grp_related', 20, NULL),
    ('projects', 'rollup', 'grp_related', 30, NULL),
    ('projects', 'created_by', 'grp_legacy', 10, NULL),
    ('campaigns', 'name', 'grp_what', 10, NULL),
    ('campaigns', 'campaign_type', 'grp_what', 20, NULL),
    ('campaigns', 'campaign_code', 'grp_what', 30, NULL),
    ('campaigns', 'status', 'grp_what', 40, NULL),
    ('campaigns', 'start_date', 'grp_what', 50, NULL),
    ('campaigns', 'end_date', 'grp_what', 60, NULL),
    ('campaigns', 'project_id', 'grp_who_where', 10, NULL),
    ('campaigns', 'owner_person_id', 'grp_who_where', 20, NULL),
    ('campaigns', 'notes', 'grp_notes', 10, NULL),
    ('campaigns', 'samples', 'grp_related', 10, NULL),
    ('campaigns', 'campaign_operations', 'grp_related', 20, NULL),
    ('campaigns', 'created_by', 'grp_legacy', 10, NULL),
    ('raw_stock_lots', 'lot_code', 'grp_what', 10, NULL),
    ('raw_stock_lots', 'stock_type', 'grp_what', 20, NULL),
    ('raw_stock_lots', 'material_id', 'grp_what', 30, NULL),
    ('raw_stock_lots', 'received_date', 'grp_what', 40, NULL),
    ('raw_stock_lots', 'supplier_name', 'grp_supplier', 10, NULL),
    ('raw_stock_lots', 'supplier_part_number', 'grp_supplier', 20, NULL),
    ('raw_stock_lots', 'certificate_url', 'grp_supplier', 30, 'full'),
    ('raw_stock_lots', 'inbound_mass_grams', 'grp_quantity', 10, NULL),
    ('raw_stock_lots', 'remaining_mass_grams', 'grp_quantity', 20, NULL),
    ('raw_stock_lots', 'purity_percent', 'grp_quantity', 30, NULL),
    ('raw_stock_lots', 'mesh_size_micrometres', 'grp_quantity', 40, NULL),
    ('raw_stock_lots', 'export_controlled', 'grp_notes', 10, NULL),
    ('raw_stock_lots', 'notes', 'grp_notes', 20, NULL),
    ('tools', 'tool_id', NULL, 10, NULL),
    ('tools', 'tool_code', NULL, 20, NULL),
    ('tools', 'tool_name', NULL, 30, NULL),
    ('tools', 'manufacturer', NULL, 40, NULL),
    ('tools', 'tool_type', NULL, 50, NULL),
    ('tools', 'op_type', NULL, 60, NULL),
    ('tools', 'shank_type', NULL, 70, NULL),
    ('tools', 'cutting_direction', NULL, 80, NULL),
    ('tools', 'cutter_diameter_mm', NULL, 90, NULL),
    ('tools', 'shank_width_mm', NULL, 100, NULL),
    ('tools', 'shank_length_mm', NULL, 110, NULL),
    ('tools', 'overall_length_mm', NULL, 120, NULL),
    ('tools', 'insert_clamping_system', NULL, 130, NULL),
    ('tools', 'datasheet_url', NULL, 140, NULL),
    ('tools', 'image', NULL, 150, NULL),
    ('tools', 'is_active', NULL, 160, NULL),
    ('tools', 'project_id', NULL, 170, NULL),
    ('tools', 'notes', NULL, 180, NULL),
    ('tools', 'created_at', NULL, 190, NULL),
    ('tools', 'updated_at', NULL, 200, NULL),
    ('tools', 'version', NULL, 210, NULL),
    ('equipment', 'equipment_id', NULL, 10, NULL),
    ('equipment', 'equipment_code', NULL, 20, NULL),
    ('equipment', 'equipment_name', NULL, 30, NULL),
    ('equipment', 'equipment_type', NULL, 40, NULL),
    ('equipment', 'manufacturer', NULL, 50, NULL),
    ('equipment', 'capabilities', NULL, 60, NULL),
    ('equipment', 'image', NULL, 70, NULL),
    ('equipment', 'location', NULL, 80, NULL),
    ('equipment', 'facility_id', NULL, 90, NULL),
    ('equipment', 'is_active', NULL, 100, NULL),
    ('equipment', 'image_url', NULL, 110, NULL),
    ('equipment', 'notes', NULL, 120, NULL),
    ('equipment', 'project_id', NULL, 130, NULL),
    ('equipment', 'manufacturing_operations', NULL, 140, NULL),
    ('equipment', 'test_sessions', NULL, 150, NULL),
    ('equipment', 'created_at', NULL, 160, NULL),
    ('equipment', 'updated_at', NULL, 170, NULL),
    ('equipment', 'version', NULL, 180, NULL),
    ('insert_types', 'insert_type_id', NULL, 10, NULL),
    ('insert_types', 'type_code', NULL, 20, NULL),
    ('insert_types', 'short_code', NULL, 30, NULL),
    ('insert_types', 'manufacturer', NULL, 40, NULL),
    ('insert_types', 'op_type', NULL, 50, NULL),
    ('insert_types', 'material_class', NULL, 60, NULL),
    ('insert_types', 'iso_designation', NULL, 70, NULL),
    ('insert_types', 'substrate', NULL, 80, NULL),
    ('insert_types', 'coating', NULL, 90, NULL),
    ('insert_types', 'mounting_style_code', NULL, 100, NULL),
    ('insert_types', 'edge_count', NULL, 110, NULL),
    ('insert_types', 'inserts_per_box', NULL, 120, NULL),
    ('insert_types', 'nose_radius_mm', NULL, 130, NULL),
    ('insert_types', 'cutting_edge_length_mm', NULL, 140, NULL),
    ('insert_types', 'included_angle_deg', NULL, 150, NULL),
    ('insert_types', 'fixing_hole_diameter_mm', NULL, 160, NULL),
    ('insert_types', 'datasheet_url', NULL, 170, NULL),
    ('insert_types', 'image', NULL, 180, NULL),
    ('insert_types', 'geometry_notes', NULL, 190, NULL),
    ('insert_types', 'tool_boxes', NULL, 200, NULL),
    ('insert_types', 'created_at', NULL, 210, NULL),
    ('insert_types', 'updated_at', NULL, 220, NULL),
    ('insert_types', 'version', NULL, 230, NULL),
    ('cutting_inserts', 'insert_id', NULL, 10, NULL),
    ('cutting_inserts', 'insert_code', NULL, 20, NULL),
    ('cutting_inserts', 'tool_box_id', NULL, 30, NULL),
    ('cutting_inserts', 'insert_type_id', NULL, 40, NULL),
    ('cutting_inserts', 'insert_number', NULL, 50, NULL),
    ('cutting_inserts', 'location', NULL, 60, NULL),
    ('cutting_inserts', 'owner', NULL, 70, NULL),
    ('cutting_inserts', 'cascade_ownership', NULL, 80, NULL),
    ('cutting_inserts', 'owner_person_id', NULL, 90, NULL),
    ('cutting_inserts', 'is_depleted', NULL, 100, NULL),
    ('cutting_inserts', 'notes', NULL, 110, NULL),
    ('cutting_inserts', 'insert_edges', NULL, 120, NULL),
    ('cutting_inserts', 'created_at', NULL, 130, NULL),
    ('cutting_inserts', 'updated_at', NULL, 140, NULL),
    ('cutting_inserts', 'version', NULL, 150, NULL),
    ('cutting_inserts', 'created_by', NULL, 160, NULL)
) AS v (collection, field, grp, sort, width)
WHERE f.collection = v.collection AND f.field = v.field;

-- Step 4: labels (decisions 8-9 and the form specs), notes, required, hidden, interfaces.
UPDATE directus_fields AS f SET translations = v.label::json
FROM (VALUES
    ('physical_samples', 'sample_code', '[{"language":"en-US","translation":"Sample Code"}]'),
    ('physical_samples', 'current_status', '[{"language":"en-US","translation":"Status"}]'),
    ('physical_samples', 'material_id', '[{"language":"en-US","translation":"Material"}]'),
    ('physical_samples', 'primary_method_id', '[{"language":"en-US","translation":"Manufacturing method"}]'),
    ('physical_samples', 'form', '[{"language":"en-US","translation":"Geometry"}]'),
    ('physical_samples', 'mass_grams', '[{"language":"en-US","translation":"Weight"}]'),
    ('physical_samples', 'diameter_mm', '[{"language":"en-US","translation":"Diameter Ø"}]'),
    ('physical_samples', 'inner_diameter_mm', '[{"language":"en-US","translation":"Inner diameter Ø"}]'),
    ('physical_samples', 'width_mm', '[{"language":"en-US","translation":"Width"}]'),
    ('physical_samples', 'thickness_mm', '[{"language":"en-US","translation":"Thickness"}]'),
    ('physical_samples', 'length_mm', '[{"language":"en-US","translation":"Length"}]'),
    ('physical_samples', 'gauge_length_mm', '[{"language":"en-US","translation":"Gauge length"}]'),
    ('physical_samples', 'gauge_width_mm', '[{"language":"en-US","translation":"Gauge width"}]'),
    ('physical_samples', 'owner_person_id', '[{"language":"en-US","translation":"Owner"}]'),
    ('physical_samples', 'manufacturing_operations', '[{"language":"en-US","translation":"Operations (as input)"}]'),
    ('physical_samples', 'produced_by_operations', '[{"language":"en-US","translation":"Produced by"}]'),
    ('physical_samples', 'child_samples', '[{"language":"en-US","translation":"Child samples"}]'),
    ('manufacturing_operations', 'method_id', '[{"language":"en-US","translation":"Method"}]'),
    ('manufacturing_operations', 'process_category', '[{"language":"en-US","translation":"Process Category"}]'),
    ('manufacturing_operations', 'sample_id', '[{"language":"en-US","translation":"Input sample"}]'),
    ('manufacturing_operations', 'output_sample_id', '[{"language":"en-US","translation":"Output sample"}]'),
    ('manufacturing_operations', 'operation_date', '[{"language":"en-US","translation":"Date"}]'),
    ('manufacturing_operations', 'campaign_id', '[{"language":"en-US","translation":"Campaign"}]'),
    ('manufacturing_operations', 'material_id', '[{"language":"en-US","translation":"Material"}]'),
    ('manufacturing_operations', 'outcome_notes', '[{"language":"en-US","translation":"Notes"}]'),
    ('test_sessions', 'test_category', '[{"language":"en-US","translation":"Test Category"}]'),
    ('test_sessions', 'subject', '[{"language":"en-US","translation":"Subject"}]'),
    ('test_sessions', 'campaign_id', '[{"language":"en-US","translation":"Campaign"}]'),
    ('projects', 'project_name', '[{"language":"en-US","translation":"Project Name"}]'),
    ('projects', 'is_active', '[{"language":"en-US","translation":"Active?"}]'),
    ('projects', 'start_date', '[{"language":"en-US","translation":"Start"}]'),
    ('projects', 'end_date', '[{"language":"en-US","translation":"End"}]'),
    ('projects', 'campaigns', '[{"language":"en-US","translation":"Campaigns"}]'),
    ('campaigns', 'status', '[{"language":"en-US","translation":"Status"}]'),
    ('campaigns', 'start_date', '[{"language":"en-US","translation":"Start"}]'),
    ('campaigns', 'end_date', '[{"language":"en-US","translation":"End"}]'),
    ('campaigns', 'notes', '[{"language":"en-US","translation":"Notes"}]'),
    ('insert_types', 'op_type', '[{"language":"en-US","translation":"Application"}]'),
    ('manufacturing_operations', 'sintering_machine_group', '[{"language":"en-US","translation":"Machine data"}]'),
    ('manufacturing_operations', 'sintering_qa_group', '[{"language":"en-US","translation":"QA records"}]'),
    ('manufacturing_operations', 'sintering_run_number', '[{"language":"en-US","translation":"Run Number"}]'),
    ('manufacturing_operations', 'fast_recipe_id', '[{"language":"en-US","translation":"FAST Recipe"}]')
) AS v (collection, field, label)
WHERE f.collection = v.collection AND f.field = v.field;

UPDATE directus_fields AS f SET note = v.note
FROM (VALUES
    ('physical_samples', 'diameter_mm', 'Outer diameter, across the x and y axes.'),
    ('physical_samples', 'inner_diameter_mm', 'Bore of a ring; smaller than the outer diameter.'),
    ('physical_samples', 'width_mm', 'x axis.'),
    ('physical_samples', 'thickness_mm', 'y axis.'),
    ('physical_samples', 'length_mm', 'z axis (along the length).'),
    ('physical_samples', 'gauge_length_mm', 'z axis, parallel section of the coupon.'),
    ('physical_samples', 'gauge_width_mm', 'x axis, parallel section of the coupon.'),
    ('physical_samples', 'co_owners', 'Members share a sample through Who has access in STARbase.'),
    ('projects', 'secondary_investigators', 'Members share a project through Who has access in STARbase.')
) AS v (collection, field, note)
WHERE f.collection = v.collection AND f.field = v.field;

-- Decision 11: required in the form (Directus 11 does not enforce it on API saves, so no caller breaks).
UPDATE directus_fields SET required = true WHERE (collection, field) IN (
    ('physical_samples', 'material_id'),
    ('physical_samples', 'primary_method_id'),
    ('physical_samples', 'form'),
    ('manufacturing_operations', 'method_id'),
    ('manufacturing_operations', 'operation_date'),
    ('test_sessions', 'test_type'),
    ('test_sessions', 'session_date'),
    ('projects', 'project_name'),
    ('campaigns', 'name'),
    ('campaigns', 'campaign_type'),
    ('raw_stock_lots', 'lot_code'),
    ('raw_stock_lots', 'stock_type'),
    ('raw_stock_lots', 'inbound_mass_grams'),
    ('raw_stock_lots', 'remaining_mass_grams')
);

-- Decision 1 and 6: Item Type is hidden (the database defaults it to sample); the legacy fields leave the forms.
UPDATE directus_fields SET hidden = true WHERE (collection, field) IN (
    ('physical_samples', 'item_type'),
    ('manufacturing_operations', 'force_analyses'),
    ('manufacturing_operations', 'fast_run'),
    ('manufacturing_operations', 'machining_legacy_insert_edge_id'),
    ('manufacturing_operations', 'machining_legacy_machining_uid'),
    ('manufacturing_operations', 'file_storage_pointer'),
    ('manufacturing_operations', 'capture_software'),
    ('manufacturing_operations', 'capture_frequency_khz'),
    ('manufacturing_operations', 'nc_program_text'),
    ('manufacturing_operations', 'gcode_file'),
    ('manufacturing_operations', 'machining_experiment_sheet_url'),
    ('test_sessions', 'capture_software'),
    ('test_sessions', 'capture_frequency_khz'),
    ('test_sessions', 'file_storage_pointer'),
    ('test_sessions', 'data_file_uri'),
    ('test_sessions', 'file_size_gb'),
    ('test_sessions', 'data_file_size_gb'),
    ('test_sessions', 'summary_stats'),
    ('test_sessions', 'plot_uris')
);

-- Decision 7: Project fills from the Campaign; the Campaign picker is not filtered by campaign type.
UPDATE directus_fields SET interface = 'd1-project-inherit'
WHERE (collection, field) IN (('manufacturing_operations', 'project_id'), ('test_sessions', 'project_id'));
UPDATE directus_fields SET options = (options::jsonb - 'filter')::json
WHERE (collection, field) IN (('manufacturing_operations', 'campaign_id'), ('test_sessions', 'campaign_id')) AND options IS NOT NULL;

-- Step 5: conditions. A new sample form has no Item Type yet, and "item_type <> sample" is true for NULL, which hid Material,
-- Geometry and every dimension on a blank form; hide only for the two explicit rig-kit values instead.
UPDATE directus_fields
SET conditions = regexp_replace(conditions::text, '"item_type"\s*:\s*\{\s*"_neq"\s*:\s*"sample"\s*\}', '"item_type":{"_in":["equipment","miscellaneous"]}', 'g')::json
WHERE collection = 'physical_samples' AND conditions::text ~ '"item_type"\s*:\s*\{\s*"_neq"';

UPDATE directus_fields AS f SET conditions = v.cond::json
FROM (VALUES
    ('manufacturing_operations', 'sample_id', '[{"name":"machining needs an input sample","rule":{"_and":[{"process_category":{"_eq":"machining"}}]},"hidden":false,"readonly":false,"required":true}]'),
    ('manufacturing_operations', 'force_analyses', '[{"name":"show when machining","rule":{"_and":[{"process_category":{"_eq":"machining"}}]},"hidden":false,"readonly":false,"required":false}]'),
    ('manufacturing_operations', 'fast_run', '[{"name":"show when sintering","rule":{"_and":[{"process_category":{"_eq":"sintering"}}]},"hidden":false,"readonly":false,"required":false}]'),
    ('manufacturing_operations', 'machining_legacy_insert_edge_id', '[{"name":"show when it has a value","rule":{"_and":[{"machining_legacy_insert_edge_id":{"_nempty":true}}]},"hidden":false,"readonly":false,"required":false}]'),
    ('manufacturing_operations', 'machining_legacy_machining_uid', '[{"name":"show when it has a value","rule":{"_and":[{"machining_legacy_machining_uid":{"_nempty":true}}]},"hidden":false,"readonly":false,"required":false}]'),
    ('manufacturing_operations', 'file_storage_pointer', '[{"name":"show when it has a value","rule":{"_and":[{"file_storage_pointer":{"_nempty":true}}]},"hidden":false,"readonly":false,"required":false}]'),
    ('manufacturing_operations', 'capture_software', '[{"name":"show when it has a value","rule":{"_and":[{"capture_software":{"_nempty":true}}]},"hidden":false,"readonly":false,"required":false}]'),
    ('manufacturing_operations', 'capture_frequency_khz', '[{"name":"show when it has a value","rule":{"_and":[{"capture_frequency_khz":{"_nempty":true}}]},"hidden":false,"readonly":false,"required":false}]'),
    ('manufacturing_operations', 'nc_program_text', '[{"name":"show when it has a value","rule":{"_and":[{"nc_program_text":{"_nempty":true}}]},"hidden":false,"readonly":false,"required":false}]'),
    ('manufacturing_operations', 'gcode_file', NULL),
    ('manufacturing_operations', 'machining_experiment_sheet_url', NULL),
    ('raw_stock_lots', 'mesh_size_micrometres', '[{"name":"powder only","rule":{"_and":[{"stock_type":{"_neq":"powder"}}]},"hidden":true,"readonly":false,"required":false}]'),
    ('physical_samples', 'diameter_mm', '[{"name":"sample only","rule":{"_and":[{"item_type":{"_in":["equipment","miscellaneous"]}}]},"hidden":true,"readonly":false,"required":false},{"name":"form","rule":{"_and":[{"form":{"_nin":["disc","ring","cylinder","round_bar"]}}]},"hidden":true,"readonly":false,"required":false}]'),
    ('physical_samples', 'inner_diameter_mm', '[{"name":"sample only","rule":{"_and":[{"item_type":{"_in":["equipment","miscellaneous"]}}]},"hidden":true,"readonly":false,"required":false},{"name":"form","rule":{"_and":[{"form":{"_nin":["ring"]}}]},"hidden":true,"readonly":false,"required":false}]'),
    ('physical_samples', 'width_mm', '[{"name":"sample only","rule":{"_and":[{"item_type":{"_in":["equipment","miscellaneous"]}}]},"hidden":true,"readonly":false,"required":false},{"name":"form","rule":{"_and":[{"form":{"_nin":["ring","block","plate","bar","tensile_coupon","fatigue_specimen","bend_bar","charpy_specimen"]}}]},"hidden":true,"readonly":false,"required":false}]'),
    ('physical_samples', 'length_mm', '[{"name":"sample only","rule":{"_and":[{"item_type":{"_in":["equipment","miscellaneous"]}}]},"hidden":true,"readonly":false,"required":false},{"name":"form","rule":{"_and":[{"form":{"_nin":["cylinder","block","plate","bar","round_bar","tensile_coupon","fatigue_specimen","bend_bar","charpy_specimen"]}}]},"hidden":true,"readonly":false,"required":false}]'),
    ('physical_samples', 'thickness_mm', '[{"name":"sample only","rule":{"_and":[{"item_type":{"_in":["equipment","miscellaneous"]}}]},"hidden":true,"readonly":false,"required":false},{"name":"form","rule":{"_and":[{"form":{"_nin":["disc","ring","block","plate","bar","tensile_coupon","fatigue_specimen","bend_bar","charpy_specimen"]}}]},"hidden":true,"readonly":false,"required":false}]'),
    ('physical_samples', 'gauge_length_mm', '[{"name":"sample only","rule":{"_and":[{"item_type":{"_in":["equipment","miscellaneous"]}}]},"hidden":true,"readonly":false,"required":false},{"name":"form","rule":{"_and":[{"form":{"_nin":["tensile_coupon","fatigue_specimen"]}}]},"hidden":true,"readonly":false,"required":false}]'),
    ('physical_samples', 'gauge_width_mm', '[{"name":"sample only","rule":{"_and":[{"item_type":{"_in":["equipment","miscellaneous"]}}]},"hidden":true,"readonly":false,"required":false},{"name":"form","rule":{"_and":[{"form":{"_nin":["tensile_coupon","fatigue_specimen"]}}]},"hidden":true,"readonly":false,"required":false}]')
) AS v (collection, field, cond)
WHERE f.collection = v.collection AND f.field = v.field;

-- Step 6: choices (decision 8). Stored values are unchanged here; the data conversions are migration 175.
UPDATE directus_fields AS f
SET options = (COALESCE(f.options::jsonb, '{}'::jsonb) || jsonb_build_object('choices', v.choices::jsonb)
               || CASE WHEN v.other THEN '{"allowOther":true}'::jsonb ELSE '{}'::jsonb END)::json,
    display_options = jsonb_build_object('choices', v.choices::jsonb)::json
FROM (VALUES
    ('physical_samples', 'form', '[{"text":"Disc","value":"disc"},{"text":"Ring","value":"ring"},{"text":"Cylinder","value":"cylinder"},{"text":"Block","value":"block"},{"text":"Plate","value":"plate"},{"text":"Bar","value":"bar"},{"text":"Round bar","value":"round_bar"},{"text":"Tensile coupon (ISO 6892)","value":"tensile_coupon"},{"text":"Fatigue specimen","value":"fatigue_specimen"},{"text":"Bend bar (ISO 7438)","value":"bend_bar"},{"text":"Charpy specimen (ISO 148-1)","value":"charpy_specimen"},{"text":"Powder / Compact","value":"powder"},{"text":"Other","value":"other"}]', false),
    ('physical_samples', 'surface_finish', '[{"text":"None","value":"none"},{"text":"As produced","value":"as_produced"},{"text":"Rough machined","value":"rough_machined"},{"text":"Medium machined","value":"medium_machined"},{"text":"Finish machined","value":"finish_machined"},{"text":"Ground","value":"ground"},{"text":"Polished","value":"polished"},{"text":"Mirror","value":"mirror"}]', true),
    ('equipment', 'equipment_type', '[{"text":"Atomiser","value":"Atomiser"},{"text":"Binder jet printer","value":"Binder_Jet_Printer"},{"text":"Cutter","value":"Cutter"},{"text":"DED printer","value":"DED_Printer"},{"text":"Dilatometer","value":"Dilatometer"},{"text":"EBM printer","value":"EBM_Printer"},{"text":"EPMA","value":"EPMA"},{"text":"Extrusion","value":"Extrusion"},{"text":"FAST","value":"FAST"},{"text":"Grinder / polisher","value":"Grinder_Polisher"},{"text":"Heating stage","value":"Heating_Stage"},{"text":"HIP","value":"HIP"},{"text":"Impregnation unit","value":"Impregnation_Unit"},{"text":"Indentation plastometer","value":"Indentation_Plastometer"},{"text":"LPBF printer","value":"LPBF_Printer"},{"text":"Machining","value":"Machining"},{"text":"Melting furnace","value":"Melting_Furnace"},{"text":"Mill","value":"Mill"},{"text":"Mounting press","value":"Mounting_Press"},{"text":"Optical microscope","value":"Optical_Microscope"},{"text":"Powder mixer","value":"Powder_Mixer"},{"text":"Sample prep","value":"Sample_Prep"},{"text":"SEM","value":"SEM"},{"text":"SEM / FIB","value":"SEM_FIB"},{"text":"Spheroidiser","value":"Spheroidiser"},{"text":"TEM","value":"TEM"},{"text":"Thermomechanical simulator","value":"Thermomechanical_Sim"},{"text":"Universal tester","value":"Universal_Tester"},{"text":"Welder","value":"Welder"}]', true),
    ('insert_types', 'op_type', '[{"text":"Finishing","value":"Finishing"},{"text":"Medium","value":"Medium"},{"text":"Roughing","value":"Roughing"}]', false),
    ('tools', 'op_type', '[{"text":"Turning","value":"Turning"},{"text":"Milling","value":"Milling"},{"text":"Boring","value":"Boring"},{"text":"Parting","value":"Parting"},{"text":"Other","value":"Other"}]', true),
    ('tools', 'shank_type', '[{"text":"Capto","value":"Capto"},{"text":"HSK","value":"HSK"},{"text":"ISO","value":"ISO"},{"text":"Weldon","value":"Weldon"},{"text":"Square","value":"Square"},{"text":"Other","value":"Other"}]', true),
    ('manufacturing_operations', 'machining_operation_subtype', '[{"text":"Turning – Facing","value":"MT-F"},{"text":"Turning – Roughing","value":"MT-R"},{"text":"Turning – OD","value":"MT-O"},{"text":"Turning – Grooving","value":"MT-G"},{"text":"Turning – Boring","value":"MT-B"},{"text":"Turning – Threading","value":"MT-H"},{"text":"Turning – Parting","value":"MT-P"},{"text":"Turning – Drilling","value":"MT-D"},{"text":"Milling – Facing","value":"MM-F"},{"text":"Milling – Roughing","value":"MM-R"},{"text":"Milling – Slotting","value":"MM-S"},{"text":"Milling – Drilling","value":"MM-D"}]', false)
) AS v (collection, field, choices, other)
WHERE f.collection = v.collection AND f.field = v.field;
-- allowOther is dropped where the list is closed (the Application choices and the sub-type codes).
UPDATE directus_fields SET options = (options::jsonb - 'allowOther')::json
WHERE (collection, field) IN (('insert_types', 'op_type'), ('manufacturing_operations', 'machining_operation_subtype'));

-- Step 7: names in Data Studio's sidebar (decision 10); display names only, the tables keep theirs.
UPDATE directus_collections AS c SET translations = v.t::json
FROM (VALUES
    ('physical_samples', '[{"language":"en-US","translation":"Samples","singular":"Sample","plural":"Samples"}]'),
    ('manufacturing_operations', '[{"language":"en-US","translation":"Operations","singular":"Operation","plural":"Operations"}]'),
    ('test_sessions', '[{"language":"en-US","translation":"Tests","singular":"Test","plural":"Tests"}]')
) AS v (collection, t)
WHERE c.collection = v.collection;

-- END FORM LAYOUT

-- Step 8: Lab Members do not edit co-owners or secondary investigators in the form (decision 5): they are left out of the
-- create and update field lists (scripts/access_rules.json "field_sets"; gen_access_rules.py --values prints these rows).
-- Read stays '*': STARbase's record pages and "mine" filters read both aliases, and a read refusal is an HTTP 403 for every
-- query that names them. The picker therefore shows read-only to members; admins and Lab Admins (admin policies) are unaffected.
UPDATE directus_permissions AS p SET fields = v.fields
FROM (VALUES
    ('physical_samples', 'create', 'sample_id,sample_code,material_id,project_id,form,mass_grams,diameter_mm,length_mm,thickness_mm,current_status,manufactured_date,export_controlled,notes,created_at,updated_at,version,nickname,location,surface_finish,legacy_notes,width_mm,owner,manufacturing_route,mounted,mounting_method,item_type,stock_category,primary_method_id,owner_person_id,gauge_length_mm,gauge_width_mm,created_by,code_sort,short_id,inner_diameter_mm,restricted,co_owners_legacy,report_button,campaigns,access,readers,manufacturing_operations,produced_by_operations,child_samples,test_sessions,data_files,data_files_open,geometry_preview'),
    ('projects', 'create', 'project_id,project_code,project_name,description,document_number,principal_investigator_name,start_date,end_date,export_controlled,is_active,created_at,updated_at,version,principal_investigator,Image,principal_investigator_person,created_by,restricted,operations,sessions,campaigns,samples,investigator_access_notice,rollup,project_items,access,readers'),
    ('physical_samples', 'update', 'sample_id,sample_code,material_id,project_id,form,mass_grams,diameter_mm,length_mm,thickness_mm,current_status,manufactured_date,export_controlled,notes,created_at,updated_at,version,nickname,location,surface_finish,legacy_notes,width_mm,owner,manufacturing_route,mounted,mounting_method,item_type,stock_category,primary_method_id,owner_person_id,gauge_length_mm,gauge_width_mm,created_by,code_sort,short_id,inner_diameter_mm,restricted,co_owners_legacy,report_button,campaigns,access,readers,manufacturing_operations,produced_by_operations,child_samples,test_sessions,data_files,data_files_open,geometry_preview'),
    ('projects', 'update', 'project_id,project_code,project_name,description,document_number,principal_investigator_name,start_date,end_date,export_controlled,is_active,created_at,updated_at,version,principal_investigator,Image,principal_investigator_person,created_by,restricted,operations,sessions,campaigns,samples,investigator_access_notice,rollup,project_items,access,readers')
) AS v (collection, action, fields)
WHERE p.policy = '20000002-0000-0000-0000-000000000002' AND p.collection = v.collection AND p.action = v.action;

-- The rows this migration added, for the down section.
INSERT INTO d1_private.form_layout_174_backup (kind, collection, item)
SELECT 'inserted_field', d.collection, d.field FROM directus_fields AS d
WHERE d.collection IN ('physical_samples', 'manufacturing_operations', 'test_sessions', 'projects', 'campaigns', 'raw_stock_lots', 'tools', 'equipment', 'insert_types', 'cutting_inserts')
  AND NOT EXISTS (SELECT 1 FROM d1_private.form_layout_174_backup AS b WHERE b.kind IN ('field', 'inserted_field') AND b.collection = d.collection AND b.item = d.field);

-- migrate:down
-- Restores the exact prior metadata from d1_private.form_layout_174_backup: rows added by the up section are deleted, every
-- field row it touched is put back as it was (by delete and re-insert, ids included), as are the three collection names and the
-- Lab Member field lists; then the backup table is dropped. Metadata edited in Data Studio after the up section is lost.
DELETE FROM directus_fields AS d
USING d1_private.form_layout_174_backup AS b
WHERE b.kind IN ('inserted_field', 'field') AND d.collection = b.collection AND d.field = b.item;

INSERT INTO directus_fields
SELECT (json_populate_record(NULL::directus_fields, b.row_data)).*
FROM d1_private.form_layout_174_backup AS b
WHERE b.kind = 'field';

UPDATE directus_collections AS c
SET translations = (json_populate_record(NULL::directus_collections, b.row_data)).translations
FROM d1_private.form_layout_174_backup AS b
WHERE b.kind = 'collection' AND c.collection = b.collection;

UPDATE directus_permissions AS p
SET fields = b.row_data ->> 'fields'
FROM d1_private.form_layout_174_backup AS b
WHERE b.kind = 'permission' AND p.id = (b.row_data ->> 'id')::integer;

DROP TABLE d1_private.form_layout_174_backup;
