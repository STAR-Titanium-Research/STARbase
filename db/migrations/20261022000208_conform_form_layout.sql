-- migrate:up
-- Conform runs, part 3 of 3: the Conform field group on the Operation form
-- (docs/superpowers/specs/2026-10-21-conform-runs-design.md, "Form layout"; ADR-0025; plan task A3). Directus metadata only:
-- no stored value changes. Follows the form layout of migration 20261014000174 and its group conventions.
--
-- `grp_conform` ("Conform") sits at sort 105 on manufacturing_operations, between Sample preparation (100) and Notes & files
-- (110). A conditional group is base-visible plus a "hide unless" condition (the convention of 174: without both, the form
-- crashes or the group cannot be shown again), here "Hide unless conform" on process_category.
--
-- Field order in the group: run number, feedstock, feedstock form, feed mass, die diameter, tooling, then wheel speed and IPS
-- setpoint, then extrusion length, extrusion mass, yield, flash. The twelve conform_* fields come from migration 206 (base
-- hidden, shown by their own "show when conform" condition). The O2M alias conform_run (migration 207) joins Related records
-- at the next free sort of that group and, like fast_run, shows only for a Conform run.
--
-- The pre-image of the thirteen field rows this migration touches (group, sort, width, hidden, conditions) is kept in
-- d1_private.conform_form_layout_208_backup for the down section, as 174 does. An up that runs again keeps the first pre-image.
--
-- scripts/configure_form_layout.sql repeats the block between "-- BEGIN CONFORM FORM LAYOUT" and "-- END CONFORM FORM LAYOUT"
-- exactly (tests/phase1_schema.sh compares them), so a configure run on a brand-new Directus ends with the same form. The block
-- has its own markers because the "-- BEGIN FORM LAYOUT" block of 174 stays byte-identical to its migration.

DO $$
BEGIN
IF to_regclass('d1_private.conform_form_layout_208_backup') IS NULL THEN
CREATE TABLE d1_private.conform_form_layout_208_backup (
    collection TEXT NOT NULL,
    field      TEXT NOT NULL,
    row_data   JSON NOT NULL,
    PRIMARY KEY (collection, field)
);
COMMENT ON TABLE d1_private.conform_form_layout_208_backup IS 'Pre-image of the directus_fields rows that migration 20261022000208 (Conform form layout) regrouped: the twelve conform_* fields and the conform_run alias. migrate:down puts group, sort, width, hidden and conditions back and drops the table.';
COMMENT ON COLUMN d1_private.conform_form_layout_208_backup.collection IS 'The Directus collection (manufacturing_operations).';
COMMENT ON COLUMN d1_private.conform_form_layout_208_backup.field IS 'The field name.';
COMMENT ON COLUMN d1_private.conform_form_layout_208_backup.row_data IS 'to_json of the directus_fields row as it was before the migration, including its id.';

INSERT INTO d1_private.conform_form_layout_208_backup (collection, field, row_data)
SELECT f.collection, f.field, to_json(f) FROM directus_fields AS f
WHERE f.collection = 'manufacturing_operations'
  AND f.field IN ('conform_run_number', 'conform_feedstock', 'conform_feedstock_form', 'conform_feed_mass_g',
                  'conform_die_diameter_mm', 'conform_tooling_id', 'conform_wheel_speed_rpm', 'conform_ips_setpoint_c',
                  'conform_extrusion_length_mm', 'conform_extrusion_mass_g', 'conform_yield_pct', 'conform_flash_mass_g',
                  'conform_run')
ON CONFLICT (collection, field) DO NOTHING;
END IF;
END
$$;

-- BEGIN CONFORM FORM LAYOUT (scripts/configure_form_layout.sql repeats this block exactly; tests/phase1_schema.sh compares them)
-- The group. No unique key on (collection, field), so NOT EXISTS.
INSERT INTO directus_fields (collection, field, special, interface, options, hidden, readonly, sort, width, translations, conditions, "group")
SELECT 'manufacturing_operations', 'grp_conform', 'alias,no-data,group', 'group-detail', json_build_object('start', 'open'), false, false, 105, 'full',
       '[{"language":"en-US","translation":"Conform"}]'::json,
       '[{"name":"Hide unless conform","rule":{"_and":[{"process_category":{"_neq":"conform"}}]},"hidden":true}]'::json, NULL
WHERE NOT EXISTS (SELECT 1 FROM directus_fields AS d WHERE d.collection = 'manufacturing_operations' AND d.field = 'grp_conform');

-- Its members, in order.
UPDATE directus_fields AS f
SET "group" = 'grp_conform', sort = v.sort, width = 'half'
FROM (VALUES
    ('conform_run_number', 10),
    ('conform_feedstock', 20),
    ('conform_feedstock_form', 30),
    ('conform_feed_mass_g', 40),
    ('conform_die_diameter_mm', 50),
    ('conform_tooling_id', 60),
    ('conform_wheel_speed_rpm', 70),
    ('conform_ips_setpoint_c', 80),
    ('conform_extrusion_length_mm', 90),
    ('conform_extrusion_mass_g', 100),
    ('conform_yield_pct', 110),
    ('conform_flash_mass_g', 120)
) AS v (field, sort)
WHERE f.collection = 'manufacturing_operations' AND f.field = v.field;

-- The run-data alias goes into Related records at the next free sort there, hidden unless it is a Conform run.
UPDATE directus_fields AS f
SET "group" = 'grp_related',
    sort = (SELECT coalesce(max(o.sort), 0) + 10 FROM directus_fields AS o
            WHERE o.collection = 'manufacturing_operations' AND o."group" = 'grp_related' AND o.field <> 'conform_run'),
    hidden = true,
    conditions = '[{"name":"show when conform","rule":{"_and":[{"process_category":{"_eq":"conform"}}]},"hidden":false,"readonly":false,"required":false}]'::json
WHERE f.collection = 'manufacturing_operations' AND f.field = 'conform_run';
-- END CONFORM FORM LAYOUT

-- migrate:down
-- Restores the exact prior metadata from d1_private.conform_form_layout_208_backup: the group row goes, the thirteen field rows get
-- their group, sort, width, hidden flag and conditions back; then the backup table is dropped. Metadata edited in Data Studio after
-- the up section is lost for these columns.
UPDATE directus_fields AS f
SET "group" = r."group", sort = r.sort, width = r.width, hidden = r.hidden, conditions = r.conditions
FROM d1_private.conform_form_layout_208_backup AS b,
     LATERAL json_populate_record(NULL::directus_fields, b.row_data) AS r
WHERE f.collection = b.collection AND f.field = b.field;

DELETE FROM directus_fields WHERE collection = 'manufacturing_operations' AND field = 'grp_conform';

DROP TABLE IF EXISTS d1_private.conform_form_layout_208_backup;
