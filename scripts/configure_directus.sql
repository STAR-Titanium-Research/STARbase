-- =============================================================================
-- configure_directus.sql
-- Idempotent SQL for Directus 11 metadata: collections, fields, relations.
-- directus_fields and directus_relations have no unique constraint on their
-- logical keys, only on id — so we DELETE existing rows then INSERT fresh.
--
-- ⚠ STALE BASELINE — DO NOT RE-RUN AGAINST A MIGRATED DATABASE.
-- This has already gone wrong once: between 2026-07-05 and 2026-09-30 this file was run on its own
-- against the live database. Its DELETE below removed every directus_fields row of the collections
-- it owns; the 116 inline parameter field rows (configure_inline_params.sql was not run afterwards),
-- the sintering group members of migration 101, migration 102's hidden flag and four relation alias
-- fields were lost, and the operation and test forms ran ungrouped for weeks. Migration
-- 20261009000143_restore_inline_param_field_meta put them back. configure_all.sh runs this file too.
--
-- This script's DELETE FROM directus_fields WHERE collection IN (...) wipes
-- ALL field metadata for those collections, including anything added by later
-- db/migrations/*_directus_meta.sql files (e.g. owner_person_id/
-- operator_person_id/principal_investigator_person from 20260703000062, the
-- test_sessions per-test-type fields from 20260703000059, campaign_samples
-- from 20260710000087, etc.) — this script's own INSERT block below does not
-- know about any of that, so re-running it silently reverts those forms.
-- If a live DB ever needs this replayed (e.g. disaster recovery onto a fresh
-- Directus with no migration history), you must also replay the migrate:up
-- section of every later db/migrations/*.sql file that touches
-- directus_fields/directus_relations for these collections, in chronological
-- order, immediately afterward.
-- Prefer adding a small targeted migration for any new field/collection
-- instead of editing this file and re-running it.
--
-- Run:
--   docker exec -i d1-database-postgres-1 psql -U d1 -d d1_database < scripts/configure_directus.sql
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 0. SETTINGS — the module bar (the icon rail down the left edge)
-- ─────────────────────────────────────────────────────────────────────────────
-- Directus only shows a module entry whose "enabled" is true, so every entry needs
-- it: without it the rail renders empty. The third condition repairs a bar written
-- by an earlier version of this script (which omitted the flag) without touching a
-- bar curated in the UI, since the UI always writes the flag.
-- Home is first and the Data Studio (content) follows the dashboards, the order migration
-- 20261007000138 gives an existing bar (docs/superpowers/specs/2026-10-06-explorer-pages-design.md).
UPDATE directus_settings SET module_bar = '[
  {"type":"module","id":"home","enabled":true},
  {"type":"module","id":"users","enabled":true},
  {"type":"module","id":"files","enabled":true},
  {"type":"module","id":"insights","enabled":true},
  {"type":"module","id":"d1-lab-dashboard","enabled":true},
  {"type":"module","id":"d1-force-dashboard","enabled":true},
  {"type":"module","id":"d1-fast-dashboard","enabled":true},
  {"type":"module","id":"content","enabled":true},
  {"type":"module","id":"settings","enabled":true}
]' WHERE module_bar IS NULL
      OR module_bar::text NOT LIKE '%d1-lab-dashboard%'
      OR module_bar::text NOT LIKE '%"enabled"%';

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. COLLECTIONS  (icon, display_template, sort_field, sort, color, translations)
-- ─────────────────────────────────────────────────────────────────────────────
-- sort_field is NULL everywhere (#115). In Directus it is the drag-and-drop column: dragging a
-- row rewrites that column with integers, so pointing it at a code, name or date can overwrite
-- real data. The default list order comes from the global presets in section 1b instead.
INSERT INTO directus_collections
    (collection, icon, display_template, sort_field, sort, color, translations)
VALUES
    ('materials',
     'science', '{{common_name}} ({{alloy_code}})', NULL, 10, '#4CAF50',
     '[{"language":"en-US","translation":"Alloys / Materials","singular":"Alloy","plural":"Alloys"}]'),
    ('alloying_elements',
     'colorize', '{{symbol}} – {{element_name}}', NULL, 20, '#2196F3',
     '[{"language":"en-US","translation":"Alloying Elements","singular":"Element","plural":"Elements"}]'),
    ('physical_samples',
     'inventory_2', '{{sample_code}} – {{nickname}}', NULL, 30, '#9C27B0',
     '[{"language":"en-US","translation":"Items","singular":"Item","plural":"Items"}]'),
    ('manufacturing_operations',
     'precision_manufacturing', '{{pass_code}}', NULL, 40, '#FF9800',
     '[{"language":"en-US","translation":"Manufacturing Operations","singular":"Operation","plural":"Operations"}]'),
    ('equipment',
     'build', '{{equipment_name}}', NULL, 50, '#607D8B',
     '[{"language":"en-US","translation":"Machines / Equipment","singular":"Machine","plural":"Machines"}]'),
    ('tools',
     'handyman', '{{tool_code}} – {{tool_name}}', NULL, 60, '#795548',
     '[{"language":"en-US","translation":"Tool Holders","singular":"Tool","plural":"Tools"}]'),
    ('insert_types',
     'category', '{{type_code}}', NULL, 70, '#009688',
     '[{"language":"en-US","translation":"Insert Types","singular":"Insert Type","plural":"Insert Types"}]'),
    ('tool_boxes',
     'inventory_2', '{{tool_box_code}}', NULL, 80, '#3F51B5',
     '[{"language":"en-US","translation":"Insert Boxes","singular":"Insert Box","plural":"Insert Boxes"}]'),
    ('cutting_inserts',
     'cut', '{{insert_code}}', NULL, 90, '#F44336',
     '[{"language":"en-US","translation":"Cutting Inserts","singular":"Insert","plural":"Inserts"}]'),
    ('insert_edges',
     'toggle_on', '{{edge_code}}', NULL, 100, '#E91E63',
     '[{"language":"en-US","translation":"Insert Edges","singular":"Edge","plural":"Edges"}]'),
    ('manufacturing_methods',
     'account_tree', '{{method_code}} – {{method_name}}', NULL, 110, '#00BCD4',
     '[{"language":"en-US","translation":"Manufacturing Methods","singular":"Method","plural":"Methods"}]'),
    ('material_iso_classifications',
     'label', '{{iso_code}} – {{description}}', NULL, 120, '#8BC34A',
     '[{"language":"en-US","translation":"ISO Material Classifications","singular":"ISO Class","plural":"ISO Classes"}]'),
    ('material_alloying_elements',
     'link', '{{material_id}}', NULL, 130, NULL, NULL),
    ('raw_stock_lots',
     'inventory', '{{lot_code}}', NULL, 140, '#FF5722',
     '[{"language":"en-US","translation":"Raw Stock Lots","singular":"Lot","plural":"Lots"}]'),
    ('projects',
     'folder', '{{project_code}} – {{project_name}}', NULL, 150, '#673AB7',
     '[{"language":"en-US","translation":"Projects","singular":"Project","plural":"Projects"}]'),
    ('sample_genealogy',
     'device_hub', '{{id}}', NULL, 160, NULL, NULL),
    ('sample_stock_provenance',
     'link', '{{id}}', NULL, 170, NULL, NULL),
    ('test_sessions',
     'analytics', '{{session_date}} – {{test_type}} ({{status}})', NULL, 175, '#00ACC1',
     '[{"language":"en-US","translation":"Test Sessions","singular":"Test Session","plural":"Test Sessions"}]'),
    ('audit_logs',
     'history', '{{action_type}} on {{table_name}}', NULL, 190, NULL, NULL),
    -- NOTE: per-type parameter tables were flattened into inline columns on the
    -- parent tables (migration 032). Their inline fields + conditions live in
    -- scripts/configure_inline_params.sql, which must be run after this file.
    -- ── Co-ownership junction (hidden — managed via physical_samples M2M panel) ──
    ('sample_co_owners',        'group',                   '{{user_id.first_name}} {{user_id.last_name}}',               NULL, 220, NULL,      NULL),
    -- ── Secondary investigators junction (hidden — managed via projects M2M panel) ──
    ('project_investigators',   'group',                   '{{user_id.first_name}} {{user_id.last_name}}',               NULL, 225, NULL,      NULL),
    -- ── Data-file junctions (hidden — managed via the M2M files pickers) ──
    ('operation_data_files',    'attach_file',             '{{directus_files_id.filename_download}}',                     NULL, 230, NULL,      NULL),
    ('sample_data_files',       'attach_file',             '{{directus_files_id.filename_download}}',                     NULL, 231, NULL,      NULL),
    ('session_data_files',      'attach_file',             '{{directus_files_id.filename_download}}',                     NULL, 232, NULL,      NULL)
ON CONFLICT (collection) DO UPDATE SET
    icon             = EXCLUDED.icon,
    display_template = EXCLUDED.display_template,
    sort_field       = EXCLUDED.sort_field,
    sort             = EXCLUDED.sort,
    color            = COALESCE(EXCLUDED.color, directus_collections.color),
    translations     = COALESCE(EXCLUDED.translations, directus_collections.translations);

-- Safety net for collections configured elsewhere (other scripts, the UI): a manual-sort
-- column must be an integer. Clear any sort_field that points at anything else.
UPDATE directus_collections AS dc
SET sort_field = NULL
WHERE dc.sort_field IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM information_schema.columns AS c
      WHERE c.table_schema = 'public'
        AND c.table_name = dc.collection
        AND c.column_name = dc.sort_field
        AND c.data_type IN ('smallint', 'integer', 'bigint')
  );

-- Hide junction / audit / param sub-collections from navigation
UPDATE directus_collections
SET hidden = true
WHERE collection IN (
    'material_alloying_elements','sample_genealogy','sample_stock_provenance',
    'audit_logs','schema_migrations','semantic_embeddings',
    -- co-ownership junction
    'sample_co_owners',
    -- project investigators junction
    'project_investigators',
    -- data-file junctions
    'operation_data_files','sample_data_files','session_data_files'
);

-- ── Inventory nav folder: group stock + asset collections under one tree ──────
-- A collection with no DB table is a Directus "folder"; children set group = it.
INSERT INTO directus_collections (collection, icon, color, translations, sort)
VALUES ('inventory','inventory_2','#9C27B0','[{"language":"en-US","translation":"Inventory"}]',25)
ON CONFLICT (collection) DO UPDATE SET
    icon=EXCLUDED.icon, color=EXCLUDED.color, translations=EXCLUDED.translations;

UPDATE directus_collections SET "group"='inventory'
WHERE collection IN ('physical_samples','tools','insert_types','cutting_inserts','tool_boxes','raw_stock_lots');

-- ── 1b. Default list order (global presets) ──────────────────────────────────
-- A preset with bookmark, user and role all NULL is a collection's global default view.
-- Directus picks the most specific default: the user's own, then the role's, then this one.
-- (The user's own appears as soon as they change the sort, columns or widths.)
-- The code columns use the natural_sort collation (migration 116), so sorting on a code,
-- here or by clicking its column header, orders 9 < 10 < 151 < 1000 and ...-F9 < ...-F10.
--   codes          ascending by the code (samples and operations as in migration 085)
--   names          ascending by the name or short code
--   dated records  newest first
-- Upsert: an existing global default keeps its columns, filter and layout; only the sort
-- of its current layout is set. A missing one is created as a tabular view.
CREATE TEMP TABLE d1_default_sort (collection TEXT PRIMARY KEY, sort JSONB NOT NULL) ON COMMIT DROP;
INSERT INTO d1_default_sort (collection, sort) VALUES
('physical_samples',             '["sample_code"]'),
('manufacturing_operations',     '["pass_code"]'),
('tools',                        '["tool_code"]'),
('tool_boxes',                   '["tool_box_code"]'),
('cutting_inserts',              '["insert_code"]'),
('insert_edges',                 '["edge_code"]'),
('raw_stock_lots',               '["lot_code"]'),
('projects',                     '["project_code"]'),
('materials',                    '["common_name"]'),
('alloying_elements',            '["symbol"]'),
('equipment',                    '["equipment_name"]'),
('insert_types',                 '["type_code"]'),
('manufacturing_methods',        '["method_code"]'),
('material_iso_classifications', '["iso_code"]'),
('test_sessions',                '["-session_date"]'),
('audit_logs',                   '["-event_timestamp"]');

UPDATE directus_presets AS p
SET layout = coalesce(p.layout, 'tabular'),
    layout_query = (
        CASE WHEN jsonb_typeof(p.layout_query::jsonb) = 'object' THEN p.layout_query::jsonb ELSE '{}'::jsonb END
        || jsonb_build_object(
            coalesce(p.layout, 'tabular'),
            CASE WHEN jsonb_typeof(p.layout_query::jsonb -> coalesce(p.layout, 'tabular')) = 'object'
                 THEN p.layout_query::jsonb -> coalesce(p.layout, 'tabular') ELSE '{}'::jsonb END
            || jsonb_build_object('sort', d.sort))
    )::json
FROM d1_default_sort AS d
WHERE p.collection = d.collection
  AND p.bookmark IS NULL AND p."user" IS NULL AND p.role IS NULL;

INSERT INTO directus_presets (bookmark, "user", role, collection, layout, layout_query)
SELECT NULL, NULL, NULL, d.collection, 'tabular',
       jsonb_build_object('tabular', jsonb_build_object('sort', d.sort))::json
FROM d1_default_sort AS d
WHERE NOT EXISTS (
    SELECT 1 FROM directus_presets AS p
    WHERE p.collection = d.collection
      AND p.bookmark IS NULL AND p."user" IS NULL AND p.role IS NULL
);

-- ── Global bookmarks ──────────────────────────────────────────────────────────
-- Inventory is a single full list (no split); Manufacturing Operations is split
-- into the two most common families: Machining and FAST. (user & role NULL = global)
-- A bookmark only uses its own sort (never the default preset's), so each one sets it.
-- "Samples" is the view the d1-home module links to (resolved by name, not by id). It is
-- updated in place, so a filter or columns curated in the UI survive a re-run.
DELETE FROM directus_presets
WHERE collection IN ('physical_samples','manufacturing_operations')
  AND "user" IS NULL AND role IS NULL AND bookmark IS NOT NULL
  AND NOT (collection = 'physical_samples' AND bookmark = 'Samples')
  -- the saved filters below (migration 135) are kept as they are, not recreated
  AND (collection, bookmark) NOT IN (
      ('manufacturing_operations', 'My operations'),
      ('manufacturing_operations', 'FAST runs, last 7 days'),
      ('manufacturing_operations', 'Missing outcome'),
      ('physical_samples', 'My samples'),
      ('physical_samples', 'No location')
  );
INSERT INTO directus_presets (bookmark, "user", role, collection, filter, layout, layout_query, icon, color) VALUES
('Machining', NULL, NULL, 'manufacturing_operations', '{"process_category":{"_eq":"machining"}}', 'tabular', '{"tabular":{"sort":["pass_code"]}}', 'precision_manufacturing', '#FF9800'),
('FAST',      NULL, NULL, 'manufacturing_operations', '{"method_id":{"method_code":{"_eq":"MF"}}}', 'tabular', '{"tabular":{"sort":["pass_code"]}}', 'local_fire_department',   '#F44336');

UPDATE directus_presets AS p
SET layout = coalesce(p.layout, 'tabular'),
    layout_query = (
        CASE WHEN jsonb_typeof(p.layout_query::jsonb) = 'object' THEN p.layout_query::jsonb ELSE '{}'::jsonb END
        || jsonb_build_object(
            coalesce(p.layout, 'tabular'),
            CASE WHEN jsonb_typeof(p.layout_query::jsonb -> coalesce(p.layout, 'tabular')) = 'object'
                 THEN p.layout_query::jsonb -> coalesce(p.layout, 'tabular') ELSE '{}'::jsonb END
            || '{"sort":["sample_code"]}'::jsonb)
    )::json
WHERE p.collection = 'physical_samples' AND p.bookmark = 'Samples'
  AND p."user" IS NULL AND p.role IS NULL;
INSERT INTO directus_presets (bookmark, "user", role, collection, layout, layout_query, icon, color)
SELECT 'Samples', NULL, NULL, 'physical_samples', 'tabular', '{"tabular":{"sort":["sample_code"]}}', 'science', '#9C27B0'
WHERE NOT EXISTS (
    SELECT 1 FROM directus_presets AS p
    WHERE p.collection = 'physical_samples' AND p.bookmark = 'Samples'
      AND p."user" IS NULL AND p.role IS NULL
);

-- Saved filters (migration 135): "mine" goes through the person record
-- (owner_person_id -> people.user_id = $CURRENT_USER). Each is inserted only when missing, so a
-- filter or columns curated in the UI survive a re-run, like "Samples" above. The clean-up
-- DELETE above spares these names; the test_sessions ones are never touched by it.
INSERT INTO directus_presets (bookmark, "user", role, collection, filter, layout, layout_query, icon, color)
SELECT v.bookmark, NULL, NULL, v.collection, v.filter::json, 'tabular', v.layout_query::json, v.icon, v.color
FROM (VALUES
    ('manufacturing_operations', 'My operations',
     '{"_and":[{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}]}',
     '{"tabular":{"sort":["-operation_date"]}}', 'person', '#2196F3'),
    ('manufacturing_operations', 'FAST runs, last 7 days',
     '{"_and":[{"method_id":{"method_code":{"_eq":"MF"}}},{"operation_date":{"_gte":"$NOW(-7 days)"}}]}',
     '{"tabular":{"sort":["-operation_date"]}}', 'date_range', '#F44336'),
    ('manufacturing_operations', 'Missing outcome',
     '{"_and":[{"outcome_notes":{"_empty":true}}]}',
     '{"tabular":{"sort":["pass_code"]}}', 'rule', '#FFC107'),
    ('test_sessions', 'Failed',
     '{"_and":[{"status":{"_eq":"failed"}}]}',
     '{"tabular":{"sort":["-session_date"]}}', 'error', '#F44336'),
    ('test_sessions', 'Needs analysis',
     '{"_and":[{"status":{"_eq":"processed"}}]}',
     '{"tabular":{"sort":["-session_date"]}}', 'query_stats', '#FF9800'),
    ('physical_samples', 'My samples',
     '{"_and":[{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}]}',
     '{"tabular":{"sort":["sample_code"]}}', 'person', '#2196F3'),
    ('physical_samples', 'No location',
     '{"_and":[{"location":{"_empty":true}}]}',
     '{"tabular":{"sort":["sample_code"]}}', 'location_off', '#9E9E9E')
) AS v(collection, bookmark, filter, layout_query, icon, color)
WHERE NOT EXISTS (
    SELECT 1 FROM directus_presets AS p
    WHERE p.collection = v.collection AND p.bookmark = v.bookmark
      AND p."user" IS NULL AND p.role IS NULL
);


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. FIELDS  (DELETE then INSERT per collection — only id is unique in Directus 11)
-- ─────────────────────────────────────────────────────────────────────────────

DELETE FROM directus_fields WHERE collection IN (
    'materials','alloying_elements','physical_samples','manufacturing_operations',
    'equipment','tools','insert_types','tool_boxes','cutting_inserts','insert_edges',
    'manufacturing_methods','material_iso_classifications','raw_stock_lots','projects',
    'test_sessions','material_alloying_elements','Machine_Operators',
    -- co-owner junction
    'sample_co_owners',
    -- project investigators junction
    'project_investigators',
    -- data-file junctions
    'operation_data_files','sample_data_files','session_data_files'
);

-- ── Machine_Operators (technicians who run operations / tests) ────────────────
INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations) VALUES
('Machine_Operators','id',       NULL,'input',NULL,'raw',NULL,true,true,1,'full',false,NULL),
('Machine_Operators','Name',     NULL,'input',NULL,'raw',NULL,false,false,2,'half',true,'[{"language":"en-US","translation":"Operator Name"}]'),
('Machine_Operators','equipment','m2o','select-dropdown-m2o','{"template":"{{equipment_name}}"}','related-values','{"template":"{{equipment_name}}"}',false,false,3,'half',false,'[{"language":"en-US","translation":"Primary Machine"}]'),
('Machine_Operators','user_id','m2o','select-dropdown-m2o','{"template":"{{first_name}} {{last_name}}"}','user',NULL,false,false,4,'half',false,'[{"language":"en-US","translation":"App User (if any)"}]');

-- ── materials ─────────────────────────────────────────────────────────────────
INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations) VALUES
('materials','material_id',  'uuid','input',NULL,'raw',NULL,true,true,1,'full',false,NULL),
('materials','alloy_code',   NULL,'input',NULL,'raw',NULL,false,false,2,'half',true,'[{"language":"en-US","translation":"Alloy Code"}]'),
('materials','common_name',  NULL,'input',NULL,'raw',NULL,false,false,3,'half',true,'[{"language":"en-US","translation":"Alloy Name"}]'),
('materials','iso_code',     'm2o','select-dropdown-m2o','{"template":"{{iso_code}} – {{description}}"}','related-values','{"template":"{{iso_code}}"}',false,false,4,'half',false,'[{"language":"en-US","translation":"ISO Classification"}]'),
('materials','density_g_per_cm3',NULL,'input','{"min":0,"step":0.01,"suffix":"g/cm³"}','raw',NULL,false,false,5,'half',false,'[{"language":"en-US","translation":"Density (g/cm³)"}]'),
('materials','export_controlled','cast-boolean','toggle',NULL,'boolean',NULL,false,false,6,'half',true,'[{"language":"en-US","translation":"Export Controlled?"}]'),
('materials','datasheet_url',NULL,'input','{"type":"url"}','raw',NULL,false,false,7,'half',false,'[{"language":"en-US","translation":"Datasheet / Link"}]'),
('materials','notes',        NULL,'input-multiline',NULL,'raw',NULL,false,false,8,'full',false,NULL),
('materials','alloying_elements','m2m','list-m2m','{"template":"{{symbol}} {{weight_percent}}","junctionFieldLocation":"bottom"}','related-values','{"template":"{{symbol}} – {{element_name}}"}',false,false,9,'full',false,'[{"language":"en-US","translation":"Alloying Elements"}]'),
('materials','composition_preview','alias,no-data','d1-composition-bar',NULL,NULL,NULL,false,false,10,'full',false,'[{"language":"en-US","translation":"Composition Breakdown"}]'),
('materials','physical_samples','o2m','list-o2m','{"template":"{{sample_code}} – {{nickname}}","enableCreate":false}','related-values',NULL,true,false,11,'full',false,'[{"language":"en-US","translation":"Related Samples"}]'),
('materials','created_at','date-created','datetime',NULL,'datetime',NULL,true,true,20,'half',false,NULL);

-- ── alloying_elements ─────────────────────────────────────────────────────────
INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations) VALUES
('alloying_elements','symbol',           NULL,'input',NULL,'raw',NULL,false,false,1,'half',true,'[{"language":"en-US","translation":"Symbol"}]'),
('alloying_elements','element_name',     NULL,'input',NULL,'raw',NULL,false,false,2,'half',true,'[{"language":"en-US","translation":"Element Name"}]'),
('alloying_elements','atomic_number',    NULL,'input','{"min":1,"step":1}','raw',NULL,false,false,3,'half',true,'[{"language":"en-US","translation":"Atomic Number"}]'),
('alloying_elements','atomic_weight',    NULL,'input','{"step":0.001}','raw',NULL,false,false,4,'half',false,'[{"language":"en-US","translation":"Atomic Weight (g/mol)"}]'),
('alloying_elements','density_g_per_cm3',NULL,'input','{"step":0.001,"suffix":"g/cm³"}','raw',NULL,false,false,5,'half',false,'[{"language":"en-US","translation":"Density (g/cm³)"}]'),
('alloying_elements','melting_point_k',  NULL,'input','{"step":0.1,"suffix":"K"}','raw',NULL,false,false,6,'half',false,'[{"language":"en-US","translation":"Melting Point (K)"}]'),
('alloying_elements','boiling_point_k',  NULL,'input','{"step":0.1,"suffix":"K"}','raw',NULL,false,false,7,'half',false,'[{"language":"en-US","translation":"Boiling Point (K)"}]'),
('alloying_elements','electronegativity',NULL,'input','{"step":0.01}','raw',NULL,false,false,8,'half',false,'[{"language":"en-US","translation":"Electronegativity (Pauling)"}]'),
('alloying_elements','atomic_radius_pm', NULL,'input','{"step":0.1,"suffix":"pm"}','raw',NULL,false,false,9,'half',false,'[{"language":"en-US","translation":"Atomic Radius (pm)"}]');

-- ── physical_samples ──────────────────────────────────────────────────────────
INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations) VALUES
('physical_samples','sample_id',          'uuid','input',NULL,'raw',NULL,true,true,1,'full',false,NULL),
('physical_samples','sample_code',        NULL,'d1-sample-code',NULL,'raw',NULL,false,false,2,'half',true,'[{"language":"en-US","translation":"Sample Code (auto)"}]'),
('physical_samples','nickname',           NULL,'input',NULL,'raw',NULL,false,false,3,'half',false,'[{"language":"en-US","translation":"Nickname"}]'),
('physical_samples','material_id',        'm2o','select-dropdown-m2o','{"template":"{{common_name}} ({{alloy_code}})"}','related-values','{"template":"{{common_name}}"}',false,false,4,'half',false,'[{"language":"en-US","translation":"Alloy / Material"}]'),
('physical_samples','primary_method_id',  'm2o','select-dropdown-m2o','{"template":"{{method_code}} – {{method_name}}"}','related-values','{"template":"{{method_code}}"}',false,false,4,'half',false,'[{"language":"en-US","translation":"Primary Method (for code)"}]'),
('physical_samples','project_id',         'm2o','select-dropdown-m2o','{"template":"{{project_code}} – {{project_name}}"}','related-values','{"template":"{{project_code}}"}',false,false,5,'half',false,'[{"language":"en-US","translation":"Project"}]'),
('physical_samples','item_type',          NULL,'select-dropdown','{"choices":[{"text":"Sample","value":"sample"},{"text":"Equipment","value":"equipment"},{"text":"Miscellaneous","value":"miscellaneous"}]}','labels','{"choices":[{"text":"Sample","value":"sample","foreground":"#2E7D32","background":"#E8F5E9"},{"text":"Equipment","value":"equipment","foreground":"#1565C0","background":"#E3F2FD"},{"text":"Miscellaneous","value":"miscellaneous","foreground":"#616161","background":"#F5F5F5"}]}',false,false,6,'half',false,'[{"language":"en-US","translation":"Item Type"}]'),
('physical_samples','form',               NULL,'select-dropdown','{"choices":[{"text":"Disc","value":"disc"},{"text":"Cylinder","value":"cylinder"},{"text":"Block","value":"block"},{"text":"Plate","value":"plate"},{"text":"Bar","value":"bar"},{"text":"Round bar","value":"round_bar"},{"text":"Tensile coupon (ISO 6892)","value":"tensile_coupon"},{"text":"Bend / fatigue bar (ISO 7438)","value":"bend_bar"},{"text":"Powder / Compact","value":"powder"},{"text":"Other","value":"other"}]}','labels',NULL,false,false,7,'half',false,'[{"language":"en-US","translation":"Geometry"}]'),
('physical_samples','stock_category',     NULL,'select-dropdown','{"choices":[{"text":"Bulk (bar / disc / billet)","value":"bulk"},{"text":"Powder (loose / compact)","value":"powder"},{"text":"Specialty (wire / foil / porous)","value":"specialty"}]}','labels',NULL,false,false,7,'half',false,'[{"language":"en-US","translation":"Stock Category"}]'),
('physical_samples','current_status',     NULL,'select-dropdown','{"choices":[{"text":"Active","value":"active"},{"text":"Consumed","value":"consumed"},{"text":"Destroyed","value":"destroyed"},{"text":"Archived","value":"archived"}]}','labels','{"choices":[{"text":"Active","value":"active","foreground":"#2E7D32","background":"#E8F5E9"},{"text":"Consumed","value":"consumed","foreground":"#E65100","background":"#FFF3E0"},{"text":"Destroyed","value":"destroyed","foreground":"#B71C1C","background":"#FFEBEE"},{"text":"Archived","value":"archived","foreground":"#616161","background":"#F5F5F5"}]}',false,false,8,'half',true,'[{"language":"en-US","translation":"Status"}]'),
('physical_samples','export_controlled',  'cast-boolean','toggle',NULL,'boolean',NULL,false,false,9,'half',false,'[{"language":"en-US","translation":"Export Controlled?"}]'),
('physical_samples','mass_grams',         NULL,'input','{"step":0.001,"suffix":"g"}','raw',NULL,false,false,10,'half',false,'[{"language":"en-US","translation":"Weight (g)"}]'),
('physical_samples','diameter_mm',        NULL,'input','{"step":0.001,"suffix":"mm"}','raw',NULL,false,false,11,'half',false,'[{"language":"en-US","translation":"Ø (mm)"}]'),
('physical_samples','width_mm',           NULL,'input','{"step":0.001,"suffix":"mm"}','raw',NULL,false,false,12,'half',false,'[{"language":"en-US","translation":"x / Width (mm)"}]'),
('physical_samples','length_mm',          NULL,'input','{"step":0.001,"suffix":"mm"}','raw',NULL,false,false,13,'half',false,'[{"language":"en-US","translation":"z / Length (mm)"}]'),
('physical_samples','thickness_mm',       NULL,'input','{"step":0.001,"suffix":"mm"}','raw',NULL,false,false,14,'half',false,'[{"language":"en-US","translation":"y / Thickness (mm)"}]'),
('physical_samples','manufactured_date',  NULL,'datetime','{"type":"date"}','datetime','{"format":"dd/MM/yy","relative":false}',false,false,15,'half',false,'[{"language":"en-US","translation":"Manufacturing Date"}]'),
('physical_samples','manufacturing_route',NULL,'input',NULL,'raw',NULL,false,false,16,'half',false,'[{"language":"en-US","translation":"Manufacturing Route"}]'),
('physical_samples','mounted',            'cast-boolean','toggle',NULL,'boolean',NULL,false,false,17,'half',false,'[{"language":"en-US","translation":"Mounted?"}]'),
('physical_samples','mounting_method',    NULL,'select-dropdown','{"choices":[{"text":"Bakelite","value":"Bakelite"},{"text":"PuriFast","value":"PuriFast"},{"text":"Epoxy","value":"Epoxy"},{"text":"Cold mounted","value":"Cold mounted"}],"allowOther":true}','labels',NULL,false,false,18,'half',false,'[{"language":"en-US","translation":"Mounting Method"}]'),
('physical_samples','surface_finish',     NULL,'select-dropdown','{"allowOther":true,"choices":[{"text":"None","value":"none"},{"text":"Rough machined","value":"rough_machined"},{"text":"Finish machined","value":"finish_machined"},{"text":"Ground","value":"ground"},{"text":"Polished","value":"polished"},{"text":"Mirror","value":"mirror"}]}','labels',NULL,false,false,19,'half',false,'[{"language":"en-US","translation":"Surface Finish"}]'),
('physical_samples','location',           NULL,'input',NULL,'raw',NULL,false,false,20,'half',false,'[{"language":"en-US","translation":"Location"}]'),
('physical_samples','gauge_length_mm',  NULL,'input','{"step":0.001,"suffix":"mm"}','raw',NULL,false,false,12,'half',false,'[{"language":"en-US","translation":"Gauge length"}]'),
('physical_samples','gauge_width_mm',   NULL,'input','{"step":0.001,"suffix":"mm"}','raw',NULL,false,false,13,'half',false,'[{"language":"en-US","translation":"Gauge width"}]'),
('physical_samples','report_button','alias,no-data','d1-report-button','{"label":"Generate sample PDF"}',NULL,NULL,false,false,0,'full',false,'[{"language":"en-US","translation":"Report"}]'),
('physical_samples','geometry_preview', 'alias,no-data','d1-geometry-preview',NULL,NULL,NULL,false,false,20,'half',false,'[{"language":"en-US","translation":"Shape Preview"}]'),
('physical_samples','owner',     'm2o','select-dropdown-m2o','{"template":"{{first_name}} {{last_name}}"}','user',NULL,false,false,21,'half',false,'[{"language":"en-US","translation":"Owner"}]'),
('physical_samples','co_owners', 'm2m','list-m2m','{"template":"{{user_id.first_name}} {{user_id.last_name}}","junction_field":"user_id"}','related-values','{"template":"{{user_id.first_name}} {{user_id.last_name}}"}',false,false,22,'full',false,'[{"language":"en-US","translation":"Co-owners"}]'),
('physical_samples','notes',              NULL,'input-multiline',NULL,'raw',NULL,false,false,25,'full',false,NULL),
('physical_samples','legacy_notes',       NULL,'input-multiline',NULL,'raw',NULL,false,false,26,'full',false,'[{"language":"en-US","translation":"Legacy Notes (AppSheet)"}]'),
('physical_samples','manufacturing_operations','o2m','list-o2m','{"template":"{{pass_code}} – {{operation_date}}","enableCreate":true}','related-values',NULL,false,false,30,'full',false,'[{"language":"en-US","translation":"Operations (as input/workpiece)"}]'),
('physical_samples','produced_by_operations','o2m','list-o2m','{"template":"{{pass_code}} – {{operation_date}}","enableCreate":false}','related-values',NULL,false,false,30,'full',false,'[{"language":"en-US","translation":"Produced By (operations)"}]'),
('physical_samples','child_samples','o2m','list-o2m','{"template":"{{child_sample_id.sample_code}}","enableCreate":false}','related-values',NULL,false,false,31,'full',false,'[{"language":"en-US","translation":"Child Samples (Derived From This)"}]'),
('physical_samples','test_sessions','o2m','list-o2m','{"template":"{{session_date}} – {{test_type}}","enableCreate":true}','related-values',NULL,false,false,32,'full',false,'[{"language":"en-US","translation":"Test Sessions"}]'),
('physical_samples','data_files','m2m','files','{"template":"{{directus_files_id.filename_download}}"}','related-values','{"template":"{{directus_files_id.filename_download}}"}',false,false,33,'full',false,'[{"language":"en-US","translation":"Linked Data Files"}]'),
('physical_samples','data_files_open','alias,no-data','d1-archive-links','{"relationField":"data_files"}',NULL,NULL,false,false,34,'full',false,'[{"language":"en-US","translation":"Open / Copy Linked Files"}]'),
('physical_samples','created_by','user-created','select-dropdown-m2o','{"template":"{{first_name}} {{last_name}}"}','user',NULL,true,false,98,'half',false,'[{"language":"en-US","translation":"Created by"}]'),
('physical_samples','created_at','date-created','datetime',NULL,'datetime',NULL,true,true,40,'half',false,NULL),
('physical_samples','updated_at','date-updated','datetime',NULL,'datetime',NULL,true,true,41,'half',false,NULL),
('physical_samples','version',NULL,'input',NULL,'raw',NULL,true,true,42,'half',false,NULL),
-- Generated sort key (migration 085) kept for the Force App; hidden so it is not shown as a field.
('physical_samples','code_sort',NULL,'input',NULL,'raw',NULL,true,true,900,'half',false,NULL);

-- The legacy AppSheet text column (renamed by migration 140) stays hidden and read-only. The DELETE
-- above removed its row, so re-add it, but only where the column exists (the production snapshot
-- no longer has it).
INSERT INTO directus_fields (collection, field, hidden, readonly, note)
SELECT 'physical_samples', 'co_owners_legacy', TRUE, TRUE, 'Legacy AppSheet text. Use the Co-owners field (sample_co_owners).'
WHERE EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'physical_samples' AND column_name = 'co_owners_legacy'
);

-- ── equipment ─────────────────────────────────────────────────────────────────
INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations) VALUES
('equipment','equipment_id',   'uuid','input',NULL,'raw',NULL,true,true,1,'full',false,NULL),
('equipment','equipment_code', NULL,'input',NULL,'raw',NULL,false,false,2,'half',true,'[{"language":"en-US","translation":"Machine Code"}]'),
('equipment','equipment_name', NULL,'input',NULL,'raw',NULL,false,false,3,'half',true,'[{"language":"en-US","translation":"Machine Name"}]'),
('equipment','equipment_type', NULL,'select-dropdown','{"choices":[{"text":"Machining","value":"Machining"},{"text":"FAST","value":"FAST"},{"text":"Additive Manufacturing","value":"AM"}],"allowOther":true}','labels',NULL,false,false,4,'half',false,'[{"language":"en-US","translation":"Type"}]'),
('equipment','manufacturer',   NULL,'input',NULL,'raw',NULL,false,false,5,'half',false,'[{"language":"en-US","translation":"Manufacturer"}]'),
('equipment','capabilities',   'cast-csv','select-multiple-dropdown','{"choices":[{"text":"Machining","value":"machining"},{"text":"Sintering (FAST/HIP)","value":"sintering"},{"text":"Heat Treatment","value":"heat_treatment"},{"text":"Deformation","value":"deformation"},{"text":"Additive","value":"additive"},{"text":"Sample Preparation","value":"sample_prep"},{"text":"NDE / Imaging","value":"nde"},{"text":"Destructive Testing","value":"destructive"},{"text":"Dynamic Testing","value":"dynamic"}]}','labels',NULL,false,false,5,'full',false,'[{"language":"en-US","translation":"Capabilities (usable for)"}]'),
('equipment','image',          'file','file-image','{"crop":false}','image',NULL,false,false,6,'half',false,'[{"language":"en-US","translation":"Photo (paste a URL or upload — stored offline)"}]'),
('equipment','location',       NULL,'input',NULL,'raw',NULL,false,false,6,'half',false,NULL),
('equipment','is_active',      'cast-boolean','toggle',NULL,'boolean',NULL,false,false,7,'half',false,'[{"language":"en-US","translation":"Active?"}]'),
('equipment','notes',          NULL,'input-multiline',NULL,'raw',NULL,false,false,8,'full',false,NULL),
('equipment','project_id',             'm2o','select-dropdown-m2o','{"template":"{{project_code}} – {{project_name}}"}','related-values','{"template":"{{project_code}}"}',false,false,8,'half',false,'[{"language":"en-US","translation":"Primary Project"}]'),
('equipment','manufacturing_operations','o2m','list-o2m','{"template":"{{pass_code}} – {{operation_date}}","enableCreate":false}','related-values',NULL,false,false,9,'full',false,'[{"language":"en-US","translation":"Operations"}]'),
('equipment','test_sessions',          'o2m','list-o2m','{"template":"{{test_type}} – {{session_date}}","enableCreate":false}','related-values',NULL,false,false,10,'full',false,'[{"language":"en-US","translation":"Test Sessions"}]'),
('equipment','created_at','date-created','datetime',NULL,'datetime',NULL,true,true,20,'half',false,NULL),
('equipment','updated_at','date-updated','datetime',NULL,'datetime',NULL,true,true,21,'half',false,NULL),
('equipment','version',NULL,'input',NULL,'raw',NULL,true,true,22,'half',false,NULL);

-- ── tools ─────────────────────────────────────────────────────────────────────
INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations) VALUES
('tools','tool_id',                'uuid','input',NULL,'raw',NULL,true,true,1,'full',false,NULL),
('tools','tool_code',              NULL,'input',NULL,'raw',NULL,false,false,2,'half',true,NULL),
('tools','tool_name',              NULL,'input',NULL,'raw',NULL,false,false,3,'half',true,'[{"language":"en-US","translation":"Name"}]'),
('tools','manufacturer',           NULL,'input',NULL,'raw',NULL,false,false,4,'half',false,NULL),
('tools','tool_type',              NULL,'select-dropdown','{"choices":[{"text":"Turning Tool","value":"Turning"},{"text":"Milling Cutter","value":"Milling"},{"text":"Boring Bar","value":"Boring"},{"text":"Drill","value":"Drilling"},{"text":"Reamer","value":"Reaming"},{"text":"Other","value":"Other"}],"allowOther":true}','labels',NULL,false,false,5,'half',false,'[{"language":"en-US","translation":"Tool Type"}]'),
('tools','op_type',                NULL,'select-dropdown','{"choices":[{"text":"Turning","value":"Turning"},{"text":"Milling","value":"Milling"},{"text":"Boring","value":"Boring"},{"text":"Other","value":"Other"}],"allowOther":true}','labels',NULL,false,false,6,'half',false,'[{"language":"en-US","translation":"Operation Type"}]'),
('tools','shank_type',             NULL,'select-dropdown','{"choices":[{"text":"Capto","value":"Capto"},{"text":"HSK","value":"HSK"},{"text":"ISO","value":"ISO"},{"text":"Weldon","value":"Weldon"}],"allowOther":true}','labels',NULL,false,false,7,'half',false,'[{"language":"en-US","translation":"Shank Type"}]'),
('tools','cutting_direction',      NULL,'select-dropdown','{"choices":[{"text":"Right-Hand","value":"Right-Hand"},{"text":"Left-Hand","value":"Left-Hand"},{"text":"Neutral","value":"Neutral"}]}','labels',NULL,false,false,8,'half',false,NULL),
('tools','cutter_diameter_mm',     NULL,'input','{"step":0.001,"suffix":"mm"}','raw',NULL,false,false,9,'half',false,'[{"language":"en-US","translation":"Cutter Ø (mm)"}]'),
('tools','shank_width_mm',         NULL,'input','{"step":0.001,"suffix":"mm"}','raw',NULL,false,false,10,'half',false,'[{"language":"en-US","translation":"Shank Width B (mm)"}]'),
('tools','shank_length_mm',        NULL,'input','{"step":0.001,"suffix":"mm"}','raw',NULL,false,false,11,'half',false,'[{"language":"en-US","translation":"Shank Length (mm)"}]'),
('tools','overall_length_mm',      NULL,'input','{"step":0.001,"suffix":"mm"}','raw',NULL,false,false,12,'half',false,'[{"language":"en-US","translation":"Overall Length (mm)"}]'),
('tools','insert_clamping_system', NULL,'input',NULL,'raw',NULL,false,false,13,'half',false,'[{"language":"en-US","translation":"Insert Clamping System"}]'),
('tools','datasheet_url',          NULL,'input','{"type":"url"}','raw',NULL,false,false,14,'half',false,'[{"language":"en-US","translation":"Datasheet URL"}]'),
('tools','image',                  'file','file-image','{"crop":false}','image',NULL,false,false,14,'half',false,'[{"language":"en-US","translation":"Photo (paste a URL or upload — stored offline)"}]'),
('tools','is_active',              'cast-boolean','toggle',NULL,'boolean',NULL,false,false,15,'half',false,'[{"language":"en-US","translation":"Active?"}]'),
('tools','project_id',             'm2o','select-dropdown-m2o','{"template":"{{project_code}} – {{project_name}}"}','related-values','{"template":"{{project_code}}"}',false,false,15,'half',false,'[{"language":"en-US","translation":"Primary Project"}]'),
('tools','notes',                  NULL,'input-multiline',NULL,'raw',NULL,false,false,16,'full',false,NULL),
('tools','created_at','date-created','datetime',NULL,'datetime',NULL,true,true,20,'half',false,NULL),
('tools','updated_at','date-updated','datetime',NULL,'datetime',NULL,true,true,21,'half',false,NULL),
('tools','version',NULL,'input',NULL,'raw',NULL,true,true,22,'half',false,NULL);

-- ── insert_types ──────────────────────────────────────────────────────────────
INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations) VALUES
('insert_types','insert_type_id',         'uuid','input',NULL,'raw',NULL,true,true,1,'full',false,NULL),
('insert_types','type_code',              NULL,'input',NULL,'raw',NULL,false,false,2,'half',true,'[{"language":"en-US","translation":"Insert Name / Code"}]'),
('insert_types','short_code',            NULL,'input','{"placeholder":"Auto-derived from name on first delivery"}','raw',NULL,false,false,3,'half',false,'[{"language":"en-US","translation":"Short Code (prefix for box/insert codes)"}]'),
('insert_types','manufacturer',           NULL,'select-dropdown','{"choices":[{"text":"Sandvik Coromant","value":"Sandvik Coromant"},{"text":"SECO Tools","value":"SECO Tools"},{"text":"Element Six","value":"Element Six"},{"text":"Cutwel","value":"Cutwel"}],"allowOther":true}','labels',NULL,false,false,3,'half',false,NULL),
('insert_types','op_type',                NULL,'select-dropdown','{"choices":[{"text":"Turning","value":"Turning"},{"text":"Milling","value":"Milling"},{"text":"Other","value":"Other"}],"allowOther":true}','labels',NULL,false,false,4,'half',false,'[{"language":"en-US","translation":"OP Type"}]'),
('insert_types','material_class',         'm2o','select-dropdown-m2o','{"template":"{{iso_code}} – {{description}}"}','related-values','{"template":"{{iso_code}}"}',false,false,5,'half',false,'[{"language":"en-US","translation":"Material Classification (TMC1)"}]'),
('insert_types','iso_designation',        NULL,'input',NULL,'raw',NULL,false,false,6,'half',false,'[{"language":"en-US","translation":"ISO Designation"}]'),
('insert_types','substrate',              NULL,'input',NULL,'raw',NULL,false,false,7,'half',false,NULL),
('insert_types','coating',                NULL,'input',NULL,'raw',NULL,false,false,8,'half',false,NULL),
('insert_types','mounting_style_code',    NULL,'input',NULL,'raw',NULL,false,false,9,'half',false,'[{"language":"en-US","translation":"Mounting Style Code (IFS)"}]'),
('insert_types','edge_count',             NULL,'input','{"step":1,"min":1}','raw',NULL,false,false,10,'half',false,'[{"language":"en-US","translation":"Usable Edges Per Insert"}]'),
('insert_types','inserts_per_box',        NULL,'input','{"step":1,"min":1}','raw',NULL,false,false,11,'half',false,'[{"language":"en-US","translation":"# Per Box"}]'),
('insert_types','nose_radius_mm',         NULL,'input','{"step":0.001,"suffix":"mm"}','raw',NULL,false,false,12,'half',false,'[{"language":"en-US","translation":"Nose Radius RE (mm)"}]'),
('insert_types','cutting_edge_length_mm', NULL,'input','{"step":0.001,"suffix":"mm"}','raw',NULL,false,false,13,'half',false,'[{"language":"en-US","translation":"Cutting Edge Length L (mm)"}]'),
('insert_types','included_angle_deg',     NULL,'input','{"step":0.001,"suffix":"°"}','raw',NULL,false,false,14,'half',false,'[{"language":"en-US","translation":"Included Angle ESPR (°)"}]'),
('insert_types','fixing_hole_diameter_mm',NULL,'input','{"step":0.001,"suffix":"mm"}','raw',NULL,false,false,15,'half',false,'[{"language":"en-US","translation":"Fixing Hole Ø (mm)"}]'),
('insert_types','datasheet_url',          NULL,'input','{"type":"url"}','raw',NULL,false,false,16,'half',false,'[{"language":"en-US","translation":"Datasheet Link"}]'),
('insert_types','image',                  'file','file-image','{"crop":false}','image',NULL,false,false,16,'half',false,'[{"language":"en-US","translation":"Photo (paste a URL or upload — stored offline)"}]'),
('insert_types','geometry_notes',         NULL,'input-multiline',NULL,'raw',NULL,false,false,17,'full',false,'[{"language":"en-US","translation":"Geometry Notes"}]'),
('insert_types','tool_boxes',             'o2m','list-o2m','{"template":"{{tool_box_code}}","enableCreate":false}','related-values',NULL,false,false,18,'full',false,'[{"language":"en-US","translation":"Insert Box Inventory"}]'),
('insert_types','created_at','date-created','datetime',NULL,'datetime',NULL,true,true,20,'half',false,NULL),
('insert_types','updated_at','date-updated','datetime',NULL,'datetime',NULL,true,true,21,'half',false,NULL),
('insert_types','version',NULL,'input',NULL,'raw',NULL,true,true,22,'half',false,NULL);

-- ── tool_boxes ────────────────────────────────────────────────────────────────
INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations) VALUES
('tool_boxes','tool_box_id',       'uuid','input',NULL,'raw',NULL,true,true,1,'full',false,NULL),
('tool_boxes','tool_box_code',     NULL,'input','{"placeholder":"Auto-generated on save"}','raw',NULL,false,false,2,'half',false,'[{"language":"en-US","translation":"Box ID"}]'),
('tool_boxes','insert_type_id',    'm2o','select-dropdown-m2o','{"template":"{{type_code}}"}','related-values','{"template":"{{type_code}}"}',false,false,3,'half',false,'[{"language":"en-US","translation":"Insert Type"}]'),
('tool_boxes','description',       NULL,'input',NULL,'raw',NULL,false,false,4,'half',false,NULL),
('tool_boxes','location',          NULL,'input',NULL,'raw',NULL,false,false,5,'half',false,NULL),
('tool_boxes','owner',             'm2o','select-dropdown-m2o','{"template":"{{first_name}} {{last_name}}"}','user',NULL,false,false,6,'half',false,'[{"language":"en-US","translation":"Owner"}]'),
('tool_boxes','cascade_ownership', 'cast-boolean','toggle','{"label":"Apply to all inserts and edges below"}','boolean',NULL,false,false,7,'half',false,'[{"language":"en-US","translation":"Cascade Ownership to Children"}]'),
('tool_boxes','package_quantity',  NULL,'input','{"step":1,"min":1,"placeholder":"How many boxes arrived?"}','raw',NULL,false,false,8,'half',false,'[{"language":"en-US","translation":"Boxes Received"}]'),
('tool_boxes','project_id',        'm2o','select-dropdown-m2o','{"template":"{{project_code}} – {{project_name}}"}','related-values','{"template":"{{project_code}}"}',false,false,8,'half',false,'[{"language":"en-US","translation":"Primary Project"}]'),
('tool_boxes','notes',             NULL,'input-multiline',NULL,'raw',NULL,false,false,9,'full',false,NULL),
('tool_boxes','cutting_inserts',   'o2m','list-o2m','{"template":"{{insert_code}}","enableCreate":true}','related-values',NULL,false,false,10,'full',false,'[{"language":"en-US","translation":"Inserts in this Box"}]'),
('tool_boxes','created_by','user-created','select-dropdown-m2o','{"template":"{{first_name}} {{last_name}}"}','user',NULL,true,false,98,'half',false,'[{"language":"en-US","translation":"Created by"}]'),
('tool_boxes','created_at','date-created','datetime',NULL,'datetime',NULL,true,true,20,'half',false,NULL),
('tool_boxes','updated_at','date-updated','datetime',NULL,'datetime',NULL,true,true,21,'half',false,NULL),
('tool_boxes','version',NULL,'input',NULL,'raw',NULL,true,true,22,'half',false,NULL);

-- ── cutting_inserts ───────────────────────────────────────────────────────────
INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations) VALUES
('cutting_inserts','insert_id',      'uuid','input',NULL,'raw',NULL,true,true,1,'full',false,NULL),
('cutting_inserts','insert_code',    NULL,'input','{"placeholder":"Auto-generated on save"}','raw',NULL,false,false,2,'half',false,'[{"language":"en-US","translation":"Insert ID"}]'),
('cutting_inserts','tool_box_id',    'm2o','select-dropdown-m2o','{"template":"{{tool_box_code}}"}','related-values','{"template":"{{tool_box_code}}"}',false,false,3,'half',false,'[{"language":"en-US","translation":"Insert Box"}]'),
('cutting_inserts','insert_type_id', 'm2o','select-dropdown-m2o','{"template":"{{type_code}}"}','related-values','{"template":"{{type_code}}"}',false,false,4,'half',false,'[{"language":"en-US","translation":"Insert Type"}]'),
('cutting_inserts','insert_number',  NULL,'input','{"step":1}','raw',NULL,false,false,5,'half',false,'[{"language":"en-US","translation":"Position In Box"}]'),
('cutting_inserts','location',       NULL,'input',NULL,'raw',NULL,false,false,6,'half',false,NULL),
('cutting_inserts','owner',             'm2o','select-dropdown-m2o','{"template":"{{first_name}} {{last_name}}"}','user',NULL,false,false,7,'half',false,'[{"language":"en-US","translation":"Owner"}]'),
('cutting_inserts','cascade_ownership','cast-boolean','toggle','{"label":"Apply to all edges below"}','boolean',NULL,false,false,8,'half',false,'[{"language":"en-US","translation":"Cascade Ownership to Edges"}]'),
('cutting_inserts','is_depleted',      'cast-boolean','toggle',NULL,'boolean',NULL,false,false,9,'half',false,'[{"language":"en-US","translation":"Depleted?"}]'),
('cutting_inserts','notes',            NULL,'input-multiline',NULL,'raw',NULL,false,false,10,'full',false,NULL),
('cutting_inserts','insert_edges',     'o2m','list-o2m','{"template":"{{edge_code}}","enableCreate":true}','related-values',NULL,false,false,11,'full',false,'[{"language":"en-US","translation":"Insert Edges"}]'),
('cutting_inserts','created_by','user-created','select-dropdown-m2o','{"template":"{{first_name}} {{last_name}}"}','user',NULL,true,false,98,'half',false,'[{"language":"en-US","translation":"Created by"}]'),
('cutting_inserts','created_at','date-created','datetime',NULL,'datetime',NULL,true,true,20,'half',false,NULL),
('cutting_inserts','updated_at','date-updated','datetime',NULL,'datetime',NULL,true,true,21,'half',false,NULL),
('cutting_inserts','version',NULL,'input',NULL,'raw',NULL,true,true,22,'half',false,NULL);

-- ── insert_edges ──────────────────────────────────────────────────────────────
INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations) VALUES
('insert_edges','edge_id',         'uuid','input',NULL,'raw',NULL,true,true,1,'full',false,NULL),
('insert_edges','edge_code',       NULL,'input','{"placeholder":"Auto-generated on save"}','raw',NULL,false,false,2,'half',false,'[{"language":"en-US","translation":"Edge ID"}]'),
('insert_edges','insert_id',       'm2o','select-dropdown-m2o','{"template":"{{insert_code}}"}','related-values','{"template":"{{insert_code}}"}',false,false,3,'half',false,'[{"language":"en-US","translation":"Parent Insert"}]'),
('insert_edges','edge_identifier', NULL,'input',NULL,'raw',NULL,false,false,4,'half',false,'[{"language":"en-US","translation":"Edge Identifier"}]'),
('insert_edges','owner',          'm2o','select-dropdown-m2o','{"template":"{{first_name}} {{last_name}}"}','user',NULL,false,false,5,'half',false,'[{"language":"en-US","translation":"Owner"}]'),
('insert_edges','is_used',        'cast-boolean','toggle',NULL,'boolean',NULL,false,false,6,'half',false,'[{"language":"en-US","translation":"Used?"}]'),
('insert_edges','notes',          NULL,'input-multiline',NULL,'raw',NULL,false,false,7,'full',false,NULL),
('insert_edges','created_by','user-created','select-dropdown-m2o','{"template":"{{first_name}} {{last_name}}"}','user',NULL,true,false,98,'half',false,'[{"language":"en-US","translation":"Created by"}]'),
('insert_edges','created_at','date-created','datetime',NULL,'datetime',NULL,true,true,20,'half',false,NULL),
('insert_edges','updated_at','date-updated','datetime',NULL,'datetime',NULL,true,true,21,'half',false,NULL),
('insert_edges','version',NULL,'input',NULL,'raw',NULL,true,true,22,'half',false,NULL);

-- ── manufacturing_operations ──────────────────────────────────────────────────
INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations) VALUES
('manufacturing_operations','operation_id',           'uuid','input',NULL,'raw',NULL,true,true,1,'full',false,NULL),
('manufacturing_operations','sample_id',              'm2o','select-dropdown-m2o','{"template":"{{sample_code}} – {{nickname}}","enableCreate":true}','related-values','{"template":"{{sample_code}}"}',false,false,2,'half',false,'[{"language":"en-US","translation":"Input Sample / Workpiece"}]'),
('manufacturing_operations','output_sample_id',       'm2o','select-dropdown-m2o','{"template":"{{sample_code}} – {{nickname}}","enableCreate":true}','related-values','{"template":"{{sample_code}}"}',false,false,2,'half',false,'[{"language":"en-US","translation":"Output Sample (Produced)"}]'),
('manufacturing_operations','campaign_id',            'm2o','select-dropdown-m2o','{"template":"{{name}}"}','related-values','{"template":"{{name}}"}',false,false,12,'half',false,'[{"language":"en-US","translation":"Campaign"}]'),
('manufacturing_operations','method_id',              'm2o','select-dropdown-m2o','{"template":"{{method_code}} – {{method_name}}"}','related-values','{"template":"{{method_code}}"}',false,false,3,'half',false,'[{"language":"en-US","translation":"Manufacturing Method"}]'),
-- process_category: scalar discriminator that drives which typed param panel shows (method_id is a relation, can''t drive conditions)
-- process_category is auto-inferred from the selected Manufacturing Method by the
-- d1-process-category interface (readonly); it drives which inline param fields show.
('manufacturing_operations','process_category',       NULL,'d1-process-category',NULL,NULL,NULL,false,false,3,'half',false,'[{"language":"en-US","translation":"Process Category (auto)"}]'),
('manufacturing_operations','equipment_id',           'm2o','d1-machine-picker','{"categoryField":"process_category"}','related-values','{"template":"{{equipment_name}}"}',false,false,4,'half',false,'[{"language":"en-US","translation":"Machine"}]'),
('manufacturing_operations','tool_id',                'm2o','select-dropdown-m2o','{"template":"{{tool_code}} – {{tool_name}}"}','related-values','{"template":"{{tool_code}}"}',false,false,5,'half',false,'[{"language":"en-US","translation":"Tool"}]'),
('manufacturing_operations','insert_edge_id',         'm2o','select-dropdown-m2o','{"template":"{{edge_code}}"}','related-values','{"template":"{{edge_code}}"}',false,false,6,'half',false,'[{"language":"en-US","translation":"Insert Edge"}]'),
('manufacturing_operations','project_id',             'm2o','select-dropdown-m2o','{"template":"{{project_code}}"}','related-values','{"template":"{{project_code}}"}',false,false,7,'half',false,'[{"language":"en-US","translation":"Project"}]'),
('manufacturing_operations','owner',                  'm2o','select-dropdown-m2o','{"template":"{{first_name}} {{last_name}}"}','user',NULL,false,false,8,'half',false,'[{"language":"en-US","translation":"Owner (researcher)"}]'),
('manufacturing_operations','operator',               'm2o','select-dropdown-m2o','{"template":"{{Name}}","enableCreate":true}','related-values','{"template":"{{Name}}"}',false,false,8,'half',false,'[{"language":"en-US","translation":"Operator (technician)"}]'),
('manufacturing_operations','operator_name',          NULL,'input',NULL,'raw',NULL,true,true,8,'half',false,'[{"language":"en-US","translation":"Operator (legacy text)"}]'),
-- Feedstock alloy of the run (FAST/SPS log import). M2O → materials.
('manufacturing_operations','material_id',            'm2o','select-dropdown-m2o','{"template":"{{common_name}} ({{alloy_code}})","enableCreate":false}','related-values','{"template":"{{common_name}} ({{alloy_code}})"}',false,false,9,'half',false,'[{"language":"en-US","translation":"Material / Alloy"}]'),
-- Provenance of imported rows (hidden, readonly)
('manufacturing_operations','source_run_uid',         NULL,'input',NULL,'raw',NULL,true,true,40,'half',false,'[{"language":"en-US","translation":"Source Run UID"}]'),
('manufacturing_operations','source_system',          NULL,'input',NULL,'raw',NULL,true,true,41,'half',false,'[{"language":"en-US","translation":"Source System"}]'),
('manufacturing_operations','operation_date',         NULL,'datetime',NULL,'datetime','{"format":"dd/MM/yy HH:mm","relative":false}',false,false,9,'half',false,'[{"language":"en-US","translation":"Date"}]'),
('manufacturing_operations','operation_sequence',     NULL,'input','{"step":1}','raw',NULL,false,false,10,'half',false,'[{"language":"en-US","translation":"Pass #"}]'),
('manufacturing_operations','pass_code',              NULL,'d1-operation-code','{}','raw',NULL,false,false,13,'full',false,'[{"language":"en-US","translation":"Operation Code"}]'),
('manufacturing_operations','recorded_metadata',      'cast-json','input-code','{"language":"json"}','raw',NULL,false,true,12,'full',false,'[{"language":"en-US","translation":"Parameters (JSON, legacy)"}]'),
('manufacturing_operations','outcome_notes',          NULL,'input-multiline',NULL,'raw',NULL,false,false,13,'full',false,'[{"language":"en-US","translation":"Notes"}]'),
('manufacturing_operations','capture_software',       NULL,'input',NULL,'raw',NULL,false,false,14,'half',false,'[{"language":"en-US","translation":"Capture Software"}]'),
('manufacturing_operations','capture_frequency_khz',  NULL,'input','{"step":0.001,"suffix":"kHz"}','raw',NULL,false,false,15,'half',false,'[{"language":"en-US","translation":"Capture Frequency (kHz)"}]'),
('manufacturing_operations','file_storage_pointer',   NULL,'input','{"type":"url"}','raw',NULL,false,false,16,'full',false,'[{"language":"en-US","translation":"Force File URI"}]'),
('manufacturing_operations','nc_program_text',        NULL,'input-multiline',NULL,'raw',NULL,false,false,17,'full',false,'[{"language":"en-US","translation":"NC Program"}]'),
-- G-code / NC program file: pick an existing upload from the File Library or upload one.
-- Hidden by default; revealed for machining & CNC operations via the condition below.
('manufacturing_operations','gcode_file',            'file','file',NULL,'file',NULL,false,true,18,'full',false,'[{"language":"en-US","translation":"G-code / NC Program File"}]'),
-- Linked Data Files: native M2M file picker → browse the SMB archive in the File Library and attach files
('manufacturing_operations','data_files',             'm2m','files','{"template":"{{directus_files_id.filename_download}}"}','related-values','{"template":"{{directus_files_id.filename_download}}"}',false,true,19,'full',false,'[{"language":"en-US","translation":"Linked Data Files"}]'),
('manufacturing_operations','report_button','alias,no-data','d1-report-button','{"label":"Generate operation PDF"}',NULL,NULL,false,false,0,'full',false,'[{"language":"en-US","translation":"Report"}]'),
('manufacturing_operations','data_files_open',        'alias,no-data','d1-archive-links','{"relationField":"data_files"}',NULL,NULL,false,false,20,'full',false,'[{"language":"en-US","translation":"Open / Copy Linked Files"}]'),
-- (Typed process-parameter fields are inline on this table — see configure_inline_params.sql)
-- Legacy / unused duplicate columns — registered hidden so they don't clutter the form
('manufacturing_operations','force_file_id',       NULL,'input',NULL,'raw',NULL,true,true,33,'half',false,NULL),
('manufacturing_operations','nc_program_file_uri', NULL,'input',NULL,'raw',NULL,true,true,34,'half',false,NULL),
('manufacturing_operations','created_by','user-created','select-dropdown-m2o','{"template":"{{first_name}} {{last_name}}"}','user',NULL,true,false,98,'half',false,'[{"language":"en-US","translation":"Created by"}]'),
('manufacturing_operations','created_at','date-created','datetime',NULL,'datetime',NULL,true,true,30,'half',false,NULL),
('manufacturing_operations','updated_at','date-updated','datetime',NULL,'datetime',NULL,true,true,31,'half',false,NULL),
('manufacturing_operations','version',NULL,'input',NULL,'raw',NULL,true,true,32,'half',false,NULL),
-- Generated sort key (migration 085); hidden so it is not shown as a field.
('manufacturing_operations','code_sort',NULL,'input',NULL,'raw',NULL,true,true,900,'half',false,NULL);

-- Reveal the G-code file picker only for machining & CNC operations (process_category = machining).
UPDATE directus_fields
SET conditions = '[{"name":"show for machining & CNC","rule":{"_and":[{"process_category":{"_eq":"machining"}}]},"hidden":false,"readonly":false,"required":false}]'
WHERE collection = 'manufacturing_operations' AND field = 'gcode_file';

-- Machining-specific base fields: hide by default, show only for machining so they
-- don't clutter FAST/sintering (and other-category) forms.
UPDATE directus_fields
SET hidden = true,
    conditions = '[{"name":"show when machining","rule":{"_and":[{"process_category":{"_eq":"machining"}}]},"hidden":false,"readonly":false,"required":false}]'
WHERE collection = 'manufacturing_operations'
  AND field IN ('tool_id','insert_edge_id','operation_sequence',
                'capture_software','capture_frequency_khz','file_storage_pointer','nc_program_text');

-- ── manufacturing_methods ─────────────────────────────────────────────────────
INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations) VALUES
('manufacturing_methods','method_id',   'uuid','input',NULL,'raw',NULL,true,true,1,'full',false,NULL),
('manufacturing_methods','method_code', NULL,'input',NULL,'raw',NULL,false,false,2,'half',true,'[{"language":"en-US","translation":"Method Code"}]'),
('manufacturing_methods','method_name', NULL,'input',NULL,'raw',NULL,false,false,3,'half',true,'[{"language":"en-US","translation":"Method Name"}]'),
('manufacturing_methods','description', NULL,'input-multiline',NULL,'raw',NULL,false,false,4,'full',false,NULL),
('manufacturing_methods','created_at','date-created','datetime',NULL,'datetime',NULL,true,true,10,'half',false,NULL),
('manufacturing_methods','updated_at','date-updated','datetime',NULL,'datetime',NULL,true,true,11,'half',false,NULL),
('manufacturing_methods','version',NULL,'input',NULL,'raw',NULL,true,true,12,'half',false,NULL);

-- ── material_iso_classifications ──────────────────────────────────────────────
INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations) VALUES
('material_iso_classifications','iso_code',    NULL,'input',NULL,'raw',NULL,false,false,1,'half',true,'[{"language":"en-US","translation":"ISO Code"}]'),
('material_iso_classifications','description', NULL,'input',NULL,'raw',NULL,false,false,2,'half',true,NULL),
('material_iso_classifications','colour_hex',  NULL,'select-color',NULL,'color',NULL,false,false,3,'half',false,'[{"language":"en-US","translation":"Colour"}]');

-- ── raw_stock_lots ────────────────────────────────────────────────────────────
INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations) VALUES
('raw_stock_lots','lot_id',               'uuid','input',NULL,'raw',NULL,true,true,1,'full',false,NULL),
('raw_stock_lots','lot_code',             NULL,'input',NULL,'raw',NULL,false,false,2,'half',true,'[{"language":"en-US","translation":"Lot Code"}]'),
('raw_stock_lots','stock_type',           NULL,'select-dropdown','{"choices":[{"text":"Swarf","value":"swarf"},{"text":"Powder","value":"powder"},{"text":"Billet","value":"billet"},{"text":"Chemical","value":"chemical"},{"text":"Other","value":"other"}]}','labels',NULL,false,false,3,'half',true,'[{"language":"en-US","translation":"Stock Type"}]'),
('raw_stock_lots','material_id',          'm2o','select-dropdown-m2o','{"template":"{{common_name}} ({{alloy_code}})"}','related-values','{"template":"{{common_name}}"}',false,false,4,'half',false,'[{"language":"en-US","translation":"Material"}]'),
('raw_stock_lots','supplier_name',        NULL,'input',NULL,'raw',NULL,false,false,5,'half',false,'[{"language":"en-US","translation":"Supplier"}]'),
('raw_stock_lots','supplier_part_number', NULL,'input',NULL,'raw',NULL,false,false,6,'half',false,'[{"language":"en-US","translation":"Supplier Part #"}]'),
('raw_stock_lots','inbound_mass_grams',   NULL,'input','{"step":0.001,"suffix":"g","min":0}','raw',NULL,false,false,7,'half',true,'[{"language":"en-US","translation":"Inbound Mass (g)"}]'),
('raw_stock_lots','remaining_mass_grams', NULL,'input','{"step":0.001,"suffix":"g","min":0}','raw',NULL,false,false,8,'half',true,'[{"language":"en-US","translation":"Remaining Mass (g)"}]'),
('raw_stock_lots','received_date',        NULL,'datetime','{"type":"date"}','datetime',NULL,false,false,9,'half',false,'[{"language":"en-US","translation":"Received Date"}]'),
('raw_stock_lots','export_controlled',    'cast-boolean','toggle',NULL,'boolean',NULL,false,false,10,'half',false,'[{"language":"en-US","translation":"Export Controlled?"}]'),
('raw_stock_lots','notes',                NULL,'input-multiline',NULL,'raw',NULL,false,false,11,'full',false,NULL),
('raw_stock_lots','created_at','date-created','datetime',NULL,'datetime',NULL,true,true,20,'half',false,NULL),
('raw_stock_lots','updated_at','date-updated','datetime',NULL,'datetime',NULL,true,true,21,'half',false,NULL),
('raw_stock_lots','version',NULL,'input',NULL,'raw',NULL,true,true,22,'half',false,NULL);

-- ── projects ──────────────────────────────────────────────────────────────────
INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations) VALUES
('projects','project_id',                 'uuid','input',NULL,'raw',NULL,true,true,1,'full',false,NULL),
('projects','project_code',               NULL,'input','{"placeholder":"Auto-generated on save"}','raw',NULL,false,false,2,'half',false,'[{"language":"en-US","translation":"Project Code"}]'),
('projects','project_name',               NULL,'input',NULL,'raw',NULL,false,false,3,'half',true,'[{"language":"en-US","translation":"Project Name"}]'),
('projects','principal_investigator',     'm2o','select-dropdown-m2o','{"template":"{{first_name}} {{last_name}}"}','user',NULL,false,true,90,'half',false,'[{"language":"en-US","translation":"Principal Investigator (legacy — use the dropdown above)"}]'),
('projects','principal_investigator_name',NULL,'input',NULL,'raw',NULL,false,true,4,'half',false,'[{"language":"en-US","translation":"Principal Investigator"}]'),
('projects','start_date',                 NULL,'datetime','{"type":"date"}','datetime',NULL,false,false,5,'half',false,NULL),
('projects','end_date',                   NULL,'datetime','{"type":"date"}','datetime',NULL,false,false,6,'half',false,NULL),
('projects','export_controlled',          'cast-boolean','toggle',NULL,'boolean',NULL,false,false,7,'half',false,'[{"language":"en-US","translation":"Export Controlled?"}]'),
('projects','is_active',                  'cast-boolean','toggle',NULL,'boolean',NULL,false,false,8,'half',false,'[{"language":"en-US","translation":"Active?"}]'),
('projects','description',                NULL,'input-multiline',NULL,'raw',NULL,false,false,9,'full',false,NULL),
('projects','document_number',            NULL,'input',NULL,'raw',NULL,false,true,10,'half',false,'[{"language":"en-US","translation":"Document #"}]'),
('projects','Image',                      'file','file-image','{"crop":false}','image',NULL,false,false,13,'half',false,'[{"language":"en-US","translation":"Image"}]'),
('projects','investigator_access_notice', 'alias,no-data','presentation-notice','{"text":"👥 Secondary investigators listed below will be recorded as having viewing access to all samples, operations, and test sessions connected to this project.","color":"blue"}',NULL,NULL,false,false,11,'full',false,NULL),
('projects','secondary_investigators',    'm2m','list-m2m','{"template":"{{user_id.first_name}} {{user_id.last_name}}","junction_field":"user_id"}','related-values','{"template":"{{user_id.first_name}} {{user_id.last_name}}"}',false,false,12,'full',false,'[{"language":"en-US","translation":"Secondary Investigators"}]'),
('projects','created_by','user-created','select-dropdown-m2o','{"template":"{{first_name}} {{last_name}}"}','user',NULL,true,false,98,'half',false,'[{"language":"en-US","translation":"Created by"}]'),
('projects','created_at','date-created','datetime',NULL,'datetime',NULL,true,true,20,'half',false,NULL),
('projects','updated_at','date-updated','datetime',NULL,'datetime',NULL,true,true,21,'half',false,NULL),
('projects','version',NULL,'input',NULL,'raw',NULL,true,true,22,'half',false,NULL),
-- hidden O2M alias over physical_samples.project_id: lets a permission filter say "owns a sample in this project" (ADR-0011)
('projects','samples','o2m','list-o2m','{"enableCreate":false,"enableSelect":false}','related-values',NULL,true,true,23,'full',false,NULL),
-- the same for operations and tests: lets the project read rule say "owns an operation or test in it"
('projects','operations','o2m','list-o2m','{"enableCreate":false,"enableSelect":false}','related-values',NULL,true,true,24,'full',false,NULL),
('projects','sessions','o2m','list-o2m','{"enableCreate":false,"enableSelect":false}','related-values',NULL,true,true,25,'full',false,NULL);

-- ── test_sessions ─────────────────────────────────────────────────────────────
INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations) VALUES
('test_sessions','session_id',           'uuid','input',NULL,'raw',NULL,true,true,1,'full',false,NULL),
('test_sessions','sample_id',            'm2o','select-dropdown-m2o','{"template":"{{sample_code}} – {{nickname}}"}','related-values','{"template":"{{sample_code}}"}',false,false,2,'half',true,'[{"language":"en-US","translation":"Sample / Workpiece"}]'),
('test_sessions','campaign_id',          'm2o','select-dropdown-m2o','{"template":"{{name}}"}','related-values','{"template":"{{name}}"}',false,false,10,'half',false,'[{"language":"en-US","translation":"Campaign"}]'),
('test_sessions','equipment_id',         'm2o','d1-machine-picker','{"categoryField":"test_category"}','related-values','{"template":"{{equipment_name}}"}',false,false,3,'half',false,'[{"language":"en-US","translation":"Machine"}]'),
('test_sessions','insert_edge_id',       'm2o','select-dropdown-m2o','{"template":"{{edge_code}}"}','related-values','{"template":"{{edge_code}}"}',false,false,4,'half',false,'[{"language":"en-US","translation":"Insert Edge Used"}]'),
('test_sessions','project_id',           'm2o','select-dropdown-m2o','{"template":"{{project_code}} – {{project_name}}"}','related-values','{"template":"{{project_code}}"}',false,false,5,'half',false,'[{"language":"en-US","translation":"Project"}]'),
('test_sessions','owner',                'm2o','select-dropdown-m2o','{"template":"{{first_name}} {{last_name}}"}','user',NULL,false,false,6,'half',false,'[{"language":"en-US","translation":"Owner (researcher)"}]'),
('test_sessions','operator',             'm2o','select-dropdown-m2o','{"template":"{{Name}}","enableCreate":true}','related-values','{"template":"{{Name}}"}',false,false,6,'half',false,'[{"language":"en-US","translation":"Operator (technician)"}]'),
('test_sessions','operator_name',        NULL,'input',NULL,'raw',NULL,true,true,6,'half',false,'[{"language":"en-US","translation":"Operator (legacy text)"}]'),
('test_sessions','session_date',         NULL,'datetime',NULL,'datetime','{"format":"dd/MM/yy HH:mm","relative":false}',false,false,7,'half',false,'[{"language":"en-US","translation":"Session Date"}]'),
('test_sessions','test_type',            NULL,'select-dropdown','{"choices":[{"text":"NDE — Optical Microscopy","value":"optical_microscopy"},{"text":"NDE — SEM / EBSD / EDS","value":"sem"},{"text":"NDE — TEM","value":"tem"},{"text":"NDE — XRD","value":"xrd"},{"text":"NDE — Alicona","value":"alicona"},{"text":"NDE — CLEMX Imaging","value":"clemx"},{"text":"NDE — DCT","value":"dct"},{"text":"NDE — CT Scan","value":"ct_scan"},{"text":"Destructive — Tensile","value":"tensile"},{"text":"Destructive — Hardness","value":"hardness"},{"text":"Destructive — Charpy Impact","value":"charpy"},{"text":"Destructive — Compression","value":"compression"},{"text":"Destructive — Tribology","value":"tribology"},{"text":"Dynamic — Fatigue","value":"fatigue"},{"text":"Dynamic — Creep","value":"creep"},{"text":"Dynamic — DMA","value":"dma"},{"text":"Other","value":"other"}]}','labels',NULL,false,false,8,'half',false,'[{"language":"en-US","translation":"Test Type"}]'),
('test_sessions','test_category',         NULL,'d1-test-category',NULL,NULL,NULL,false,false,8,'half',false,'[{"language":"en-US","translation":"Test Category (auto)"}]'),
('test_sessions','status',               NULL,'select-dropdown','{"choices":[{"text":"Registered","value":"registered"},{"text":"Pending Processing","value":"pending_processing"},{"text":"Processing","value":"processing"},{"text":"Processed","value":"processed"},{"text":"Analysing","value":"analysing"},{"text":"Analysed","value":"analysed"},{"text":"Failed","value":"failed"}]}','labels','{"choices":[{"text":"Registered","value":"registered","foreground":"#616161","background":"#F5F5F5"},{"text":"Pending Processing","value":"pending_processing","foreground":"#1565C0","background":"#E3F2FD"},{"text":"Processing","value":"processing","foreground":"#E65100","background":"#FFF3E0"},{"text":"Processed","value":"processed","foreground":"#2E7D32","background":"#E8F5E9"},{"text":"Analysing","value":"analysing","foreground":"#4A148C","background":"#F3E5F5"},{"text":"Analysed","value":"analysed","foreground":"#1B5E20","background":"#C8E6C9"},{"text":"Failed","value":"failed","foreground":"#B71C1C","background":"#FFEBEE"}]}',false,false,9,'half',true,'[{"language":"en-US","translation":"Status"}]'),
('test_sessions','capture_software',     NULL,'input',NULL,'raw',NULL,false,false,10,'half',false,'[{"language":"en-US","translation":"Capture Software"}]'),
('test_sessions','capture_frequency_khz',NULL,'input','{"step":0.001,"suffix":"kHz"}','raw',NULL,false,false,11,'half',false,'[{"language":"en-US","translation":"Capture Frequency (kHz)"}]'),
('test_sessions','file_storage_pointer', NULL,'input','{"type":"url"}','raw',NULL,false,false,12,'full',false,'[{"language":"en-US","translation":"Raw Data File URI (legacy)"}]'),
('test_sessions','data_file_uri',        NULL,'input','{"type":"url"}','raw',NULL,false,false,12,'full',false,'[{"language":"en-US","translation":"Data File URI"}]'),
('test_sessions','file_size_gb',         NULL,'input','{"step":0.0001,"suffix":"GB"}','raw',NULL,false,false,13,'half',false,'[{"language":"en-US","translation":"File Size (GB)"}]'),
('test_sessions','data_file_size_gb',    NULL,'input','{"step":0.0001,"suffix":"GB"}','raw',NULL,false,false,13,'half',false,'[{"language":"en-US","translation":"Data File Size (GB)"}]'),
('test_sessions','notes',                NULL,'input-multiline',NULL,'raw',NULL,false,false,14,'full',false,NULL),
('test_sessions','summary_stats',        'cast-json','input-code','{"language":"json"}','raw',NULL,true,false,20,'full',false,'[{"language":"en-US","translation":"Summary Statistics (auto)"}]'),
('test_sessions','plot_uris',            'cast-json','input-code','{"language":"json"}','raw',NULL,true,false,21,'full',false,'[{"language":"en-US","translation":"Plot URIs (auto)"}]'),
-- (Typed test-parameter fields are inline on this table — see configure_inline_params.sql)
('test_sessions','data_files','m2m','files','{"template":"{{directus_files_id.filename_download}}"}','related-values','{"template":"{{directus_files_id.filename_download}}"}',false,false,31,'full',false,'[{"language":"en-US","translation":"Linked Data Files"}]'),
('test_sessions','report_button','alias,no-data','d1-report-button','{"label":"Generate test PDF"}',NULL,NULL,false,false,0,'full',false,'[{"language":"en-US","translation":"Report"}]'),
('test_sessions','data_files_open','alias,no-data','d1-archive-links','{"relationField":"data_files"}',NULL,NULL,false,false,32,'full',false,'[{"language":"en-US","translation":"Open / Copy Linked Files"}]'),
('test_sessions','created_by','user-created','select-dropdown-m2o','{"template":"{{first_name}} {{last_name}}"}','user',NULL,true,false,98,'half',false,'[{"language":"en-US","translation":"Created by"}]'),
('test_sessions','created_at','date-created','datetime',NULL,'datetime',NULL,true,true,35,'half',false,NULL),
('test_sessions','updated_at','date-updated','datetime',NULL,'datetime',NULL,true,true,36,'half',false,NULL),
('test_sessions','version',NULL,'input',NULL,'raw',NULL,true,true,37,'half',false,NULL);


-- ── material_alloying_elements ────────────────────────────────────────────────
INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations) VALUES
('material_alloying_elements','id',          'uuid','input',NULL,'raw',NULL,true,true,1,'full',false,NULL),
('material_alloying_elements','material_id', 'm2o','select-dropdown-m2o','{"template":"{{common_name}} ({{alloy_code}})"}','related-values',NULL,false,false,2,'half',false,NULL),
('material_alloying_elements','symbol',      'm2o','select-dropdown-m2o','{"template":"{{symbol}} – {{element_name}}"}','related-values',NULL,false,false,3,'half',false,NULL),
('material_alloying_elements','weight_percent',NULL,'input','{"min":0,"max":100,"step":0.001,"suffix":"wt%"}','raw',NULL,false,false,4,'half',false,'[{"language":"en-US","translation":"Content (wt%)"}]');

-- ── project_investigators (junction for projects M2M secondary investigators) ─
INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations) VALUES
('project_investigators','id',         'uuid','input',NULL,'raw',NULL,true,true,1,'full',false,NULL),
('project_investigators','project_id', 'm2o','select-dropdown-m2o','{"template":"{{project_code}} – {{project_name}}"}','related-values',NULL,true,true,2,'half',false,NULL),
('project_investigators','user_id',    'm2o','select-dropdown-m2o','{"template":"{{first_name}} {{last_name}}"}','user',NULL,false,false,3,'half',false,'[{"language":"en-US","translation":"Investigator"}]');

-- ── sample_co_owners (junction for physical_samples M2M co-owners) ───────────
INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations) VALUES
('sample_co_owners','id',        'uuid', 'input',NULL,'raw',NULL,true,true,1,'full',false,NULL),
('sample_co_owners','sample_id', 'm2o',  'select-dropdown-m2o','{"template":"{{sample_code}}"}','related-values',NULL,true,true,2,'half',false,NULL),
('sample_co_owners','user_id',   'm2o',  'select-dropdown-m2o','{"template":"{{first_name}} {{last_name}}"}','user',NULL,false,false,3,'half',false,'[{"language":"en-US","translation":"User"}]');

-- ── operation_data_files (junction for manufacturing_operations M2M data files) ─
INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations) VALUES
('operation_data_files','id',                'uuid','input',NULL,'raw',NULL,true,true,1,'full',false,NULL),
('operation_data_files','operation_id',      'm2o','select-dropdown-m2o','{"template":"{{pass_code}}"}','related-values',NULL,true,true,2,'half',false,NULL),
('operation_data_files','directus_files_id', 'file',NULL,NULL,'file',NULL,false,false,3,'half',false,'[{"language":"en-US","translation":"File"}]');

-- ── sample_data_files (junction for physical_samples M2M data files) ──────────
INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations) VALUES
('sample_data_files','id',                'uuid','input',NULL,'raw',NULL,true,true,1,'full',false,NULL),
('sample_data_files','sample_id',         'm2o','select-dropdown-m2o','{"template":"{{sample_code}}"}','related-values',NULL,true,true,2,'half',false,NULL),
('sample_data_files','directus_files_id', 'file',NULL,NULL,'file',NULL,false,false,3,'half',false,'[{"language":"en-US","translation":"File"}]');

-- ── session_data_files (junction for test_sessions M2M data files) ────────────
INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations) VALUES
('session_data_files','id',                'uuid','input',NULL,'raw',NULL,true,true,1,'full',false,NULL),
('session_data_files','session_id',        'm2o','select-dropdown-m2o','{"template":"{{session_date}} – {{test_type}}"}','related-values',NULL,true,true,2,'half',false,NULL),
('session_data_files','directus_files_id', 'file',NULL,NULL,'file',NULL,false,false,3,'half',false,'[{"language":"en-US","translation":"File"}]');

-- ── conditional field visibility on physical_samples ──────────────────────────
-- Two layers of conditions (Directus stacks them — any matching rule applies):
--   1) hide sample-only fields unless item_type = 'sample'
--   2) hide dimensions that don't apply to the chosen geometry (form)
-- Geometry (form) → dimensions shown (kept in step with migrations 68 and the round_bar one):
--   disc → Ø + thickness          cylinder → Ø + length       round_bar → Ø + length
--   block / plate / bar → width + length + thickness
--   tensile_coupon → length + width + thickness + gauge length + gauge width
--   bend_bar → length + width + thickness        powder / other → none (mass only)

-- Fields that only make sense for actual samples (hidden for equipment / misc).
UPDATE directus_fields
SET conditions = '[{"name":"sample only","rule":{"_and":[{"item_type":{"_neq":"sample"}}]},"hidden":true,"readonly":false,"required":false}]'
WHERE collection = 'physical_samples'
  AND field IN ('material_id','primary_method_id','form','stock_category','surface_finish','manufacturing_route','geometry_preview','mounted','mounting_method');

-- diameter_mm: disc, cylinder and round bar.
UPDATE directus_fields
SET conditions = '[
  {"name":"sample only","rule":{"_and":[{"item_type":{"_neq":"sample"}}]},"hidden":true,"readonly":false,"required":false},
  {"name":"form","rule":{"_and":[{"form":{"_nin":["disc", "cylinder", "round_bar"]}}]},"hidden":true,"readonly":false,"required":false}
]'
WHERE collection = 'physical_samples' AND field = 'diameter_mm';

-- width_mm: block, plate, bar, tensile coupon and bend bar.
UPDATE directus_fields
SET conditions = '[
  {"name":"sample only","rule":{"_and":[{"item_type":{"_neq":"sample"}}]},"hidden":true,"readonly":false,"required":false},
  {"name":"form","rule":{"_and":[{"form":{"_nin":["block", "plate", "bar", "tensile_coupon", "bend_bar"]}}]},"hidden":true,"readonly":false,"required":false}
]'
WHERE collection = 'physical_samples' AND field = 'width_mm';

-- length_mm: everything except disc and powder/other.
UPDATE directus_fields
SET conditions = '[
  {"name":"sample only","rule":{"_and":[{"item_type":{"_neq":"sample"}}]},"hidden":true,"readonly":false,"required":false},
  {"name":"form","rule":{"_and":[{"form":{"_nin":["cylinder", "block", "plate", "bar", "round_bar", "tensile_coupon", "bend_bar"]}}]},"hidden":true,"readonly":false,"required":false}
]'
WHERE collection = 'physical_samples' AND field = 'length_mm';

-- thickness_mm: disc, block, plate, bar, tensile coupon and bend bar.
UPDATE directus_fields
SET conditions = '[
  {"name":"sample only","rule":{"_and":[{"item_type":{"_neq":"sample"}}]},"hidden":true,"readonly":false,"required":false},
  {"name":"form","rule":{"_and":[{"form":{"_nin":["disc", "block", "plate", "bar", "tensile_coupon", "bend_bar"]}}]},"hidden":true,"readonly":false,"required":false}
]'
WHERE collection = 'physical_samples' AND field = 'thickness_mm';

-- gauge_length_mm + gauge_width_mm: tensile coupon only.
UPDATE directus_fields
SET conditions = '[
  {"name":"sample only","rule":{"_and":[{"item_type":{"_neq":"sample"}}]},"hidden":true,"readonly":false,"required":false},
  {"name":"form","rule":{"_and":[{"form":{"_nin":["tensile_coupon"]}}]},"hidden":true,"readonly":false,"required":false}
]'
WHERE collection = 'physical_samples' AND field IN ('gauge_length_mm','gauge_width_mm');

-- mounted / mounting_method: samples only, and not relevant for powder.
UPDATE directus_fields
SET conditions = '[
  {"name":"sample only","rule":{"_and":[{"item_type":{"_neq":"sample"}}]},"hidden":true,"readonly":false,"required":false},
  {"name":"not for powder","rule":{"_and":[{"form":{"_eq":"powder"}}]},"hidden":true,"readonly":false,"required":false}
]'
WHERE collection = 'physical_samples' AND field IN ('mounted','mounting_method');

-- ── project back-links on equipment and tools ─────────────────────────────────
UPDATE directus_fields
SET hidden = false
WHERE collection IN ('equipment','tools','tool_boxes') AND field = 'project_id';

-- ── Field ordering: logical top-down flow as fields appear/disappear ──────────
-- The type-driving field leads; inline params (sort 100+) slot in after the core
-- identity block; capture/files/notes pushed to 300+ so they follow the params.

-- manufacturing_operations: method → category → samples → people → machine/tool →
-- project → date/pass → [inline params] → capture/files/notes
UPDATE directus_fields SET sort = CASE field
  WHEN 'method_id' THEN 2  WHEN 'process_category' THEN 3
  WHEN 'sample_id' THEN 4  WHEN 'output_sample_id' THEN 5
  WHEN 'owner' THEN 6      WHEN 'operator_name' THEN 7
  WHEN 'equipment_id' THEN 8 WHEN 'tool_id' THEN 9 WHEN 'insert_edge_id' THEN 10
  WHEN 'project_id' THEN 11 WHEN 'operation_date' THEN 12
  WHEN 'operation_sequence' THEN 13 WHEN 'pass_code' THEN 14
  WHEN 'capture_software' THEN 610 WHEN 'capture_frequency_khz' THEN 611
  WHEN 'file_storage_pointer' THEN 612 WHEN 'nc_program_text' THEN 613
  WHEN 'outcome_notes' THEN 614 WHEN 'data_files' THEN 615
  ELSE sort END
WHERE collection = 'manufacturing_operations';

-- test_sessions: test type → category → sample → people → machine → project →
-- date/status → [inline params] → capture/files/notes
UPDATE directus_fields SET sort = CASE field
  WHEN 'test_type' THEN 2 WHEN 'test_category' THEN 3
  WHEN 'sample_id' THEN 4 WHEN 'owner' THEN 5 WHEN 'operator_name' THEN 6
  WHEN 'equipment_id' THEN 7 WHEN 'insert_edge_id' THEN 8 WHEN 'project_id' THEN 9
  WHEN 'session_date' THEN 10 WHEN 'status' THEN 11
  WHEN 'capture_software' THEN 610 WHEN 'capture_frequency_khz' THEN 611
  WHEN 'file_storage_pointer' THEN 612 WHEN 'data_file_uri' THEN 613
  WHEN 'file_size_gb' THEN 614 WHEN 'data_file_size_gb' THEN 615
  WHEN 'notes' THEN 616 WHEN 'summary_stats' THEN 617 WHEN 'plot_uris' THEN 618
  WHEN 'data_files' THEN 619
  ELSE sort END
WHERE collection = 'test_sessions';

-- physical_samples: identity → kind → material → geometry → dimensions → preview →
-- status → mounting → finish/location → ownership → project → dates → notes
UPDATE directus_fields SET sort = CASE field
  WHEN 'sample_code' THEN 2 WHEN 'nickname' THEN 3 WHEN 'item_type' THEN 4
  WHEN 'material_id' THEN 5 WHEN 'primary_method_id' THEN 5 WHEN 'form' THEN 6 WHEN 'stock_category' THEN 7
  WHEN 'diameter_mm' THEN 8 WHEN 'width_mm' THEN 9 WHEN 'length_mm' THEN 10
  WHEN 'thickness_mm' THEN 11 WHEN 'mass_grams' THEN 12 WHEN 'geometry_preview' THEN 13
  WHEN 'current_status' THEN 14 WHEN 'export_controlled' THEN 15
  WHEN 'mounted' THEN 16 WHEN 'mounting_method' THEN 17
  WHEN 'surface_finish' THEN 18 WHEN 'manufacturing_route' THEN 19 WHEN 'location' THEN 20
  WHEN 'owner' THEN 21 WHEN 'co_owners' THEN 22 WHEN 'project_id' THEN 23
  WHEN 'manufactured_date' THEN 24 WHEN 'notes' THEN 25 WHEN 'legacy_notes' THEN 26
  ELSE sort END
WHERE collection = 'physical_samples';


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. RELATIONS  (DELETE then INSERT — only id is unique in Directus 11)
-- ─────────────────────────────────────────────────────────────────────────────
DELETE FROM directus_relations WHERE many_collection IN (
    'physical_samples','manufacturing_operations','tool_boxes','cutting_inserts',
    'insert_edges','insert_types','materials','raw_stock_lots','sample_genealogy',
    'sample_stock_provenance','material_alloying_elements',
    'test_sessions','Machine_Operators',
    -- asset → project links
    'equipment','tools',
    -- co-owner junction
    'sample_co_owners',
    -- project investigators junction
    'project_investigators',
    -- data-file junctions
    'operation_data_files','sample_data_files','session_data_files'
);

INSERT INTO directus_relations (many_collection, many_field, one_collection, one_field, one_deselect_action) VALUES
-- physical_samples FK references (nullable → nullify is fine)
('physical_samples',          'material_id',     'materials',                  'physical_samples',         'nullify'),
('physical_samples',          'primary_method_id','manufacturing_methods',     NULL,                       'nullify'),
-- one_field 'samples': the hidden alias the Lab Member project read rule (ADR-0011) filters on
('physical_samples',          'project_id',       'projects',                   'samples',                  'nullify'),
-- manufacturing_operations
-- sample_id NOT NULL → delete operation when sample is deleted
('manufacturing_operations',  'sample_id',        'physical_samples',           'manufacturing_operations',  'delete'),
-- nullable FKs → nullify is fine
('manufacturing_operations',  'equipment_id',     'equipment',                  'manufacturing_operations',  'nullify'),
-- method_id NOT NULL but RESTRICT in DB — block delete of methods with operations
('manufacturing_operations',  'method_id',        'manufacturing_methods',      'operations',                'nullify'),
('manufacturing_operations',  'tool_id',          'tools',                      NULL,                        'nullify'),
('manufacturing_operations',  'insert_edge_id',   'insert_edges',               NULL,                        'nullify'),
('manufacturing_operations',  'campaign_id',      'campaigns',                  'operations',                'nullify'),
-- one_field 'operations': the hidden alias the Lab Member project read rule (ADR-0011) filters on
('manufacturing_operations',  'project_id',       'projects',                   'operations',                'nullify'),
-- output sample (produced by the operation) → O2M back-link on physical_samples
('manufacturing_operations',  'output_sample_id', 'physical_samples',           'produced_by_operations',    'nullify'),
-- tooling hierarchy
-- insert_type_id nullable → nullify
('tool_boxes',                'insert_type_id',   'insert_types',               'tool_boxes',                'nullify'),
-- tool_box_id NOT NULL → delete insert when box is deleted (DB also cascades)
('cutting_inserts',           'tool_box_id',      'tool_boxes',                 'cutting_inserts',           'delete'),
('cutting_inserts',           'insert_type_id',   'insert_types',               NULL,                        'nullify'),
-- insert_id NOT NULL → delete edge when insert is deleted (DB also cascades)
('insert_edges',              'insert_id',        'cutting_inserts',            'insert_edges',              'delete'),
-- material ISO classification (nullable)
('materials',                 'iso_code',         'material_iso_classifications', NULL,                      'nullify'),
('insert_types',              'material_class',   'material_iso_classifications', NULL,                      'nullify'),
-- raw stock (nullable)
('raw_stock_lots',            'material_id',      'materials',                  NULL,                        'nullify'),
-- genealogy NOT NULL → delete links when either sample is deleted (DB also cascades)
('sample_genealogy',          'child_sample_id',  'physical_samples',           'child_samples',             'delete'),
('sample_genealogy',          'parent_sample_id', 'physical_samples',           NULL,                        'delete'),
-- stock provenance NOT NULL → delete links when sample or lot is deleted (DB also cascades)
('sample_stock_provenance',   'sample_id',        'physical_samples',           NULL,                        'delete'),
('sample_stock_provenance',   'lot_id',           'raw_stock_lots',             'provenance',                'delete'),
-- test sessions: sample_id NOT NULL → delete sessions when sample is deleted
('test_sessions',             'sample_id',        'physical_samples',            'test_sessions',            'delete'),
-- nullable FKs
('test_sessions',             'campaign_id',      'campaigns',                   'sessions',                 'nullify'),
('test_sessions',             'equipment_id',     'equipment',                   'test_sessions',            'nullify'),
('test_sessions',             'insert_edge_id',   'insert_edges',                NULL,                       'nullify'),
('test_sessions',             'project_id',       'projects',                    'sessions',                 'nullify'),
-- people links (migration 062). The row filters of ADR-0011 walk owner_person_id -> people.user_id, so
-- these must survive this script (it deletes every relation of these collections above).
('physical_samples',          'owner_person_id',    'people',                     NULL,                       'nullify'),
('manufacturing_operations',  'owner_person_id',    'people',                     NULL,                       'nullify'),
('manufacturing_operations',  'operator_person_id', 'people',                     NULL,                       'nullify'),
('test_sessions',             'owner_person_id',    'people',                     NULL,                       'nullify'),
('test_sessions',             'operator_person_id', 'people',                     NULL,                       'nullify'),
('tool_boxes',                'owner_person_id',    'people',                     NULL,                       'nullify'),
('cutting_inserts',           'owner_person_id',    'people',                     NULL,                       'nullify'),
('insert_edges',              'owner_person_id',    'people',                     NULL,                       'nullify'),
-- owner M2O to directus_users — no DB FK (Directus-only relation, keeps schema portable)
('tool_boxes',                'owner',             'directus_users',              NULL,                       'nullify'),
('cutting_inserts',           'owner',             'directus_users',              NULL,                       'nullify'),
('insert_edges',              'owner',             'directus_users',              NULL,                       'nullify'),
('physical_samples',          'owner',             'directus_users',              NULL,                       'nullify'),
('manufacturing_operations',  'owner',             'directus_users',              NULL,                       'nullify'),
('test_sessions',             'owner',             'directus_users',              NULL,                       'nullify'),
-- operator (technician) M2O → Machine_Operators
('manufacturing_operations',  'operator',          'Machine_Operators',           NULL,                       'nullify'),
('test_sessions',             'operator',          'Machine_Operators',           NULL,                       'nullify'),
('Machine_Operators',         'equipment',         'equipment',                   NULL,                       'nullify'),
('Machine_Operators',         'user_id',           'directus_users',              NULL,                       'nullify'),
-- asset images → directus_files (File Library / MinIO; URL imports stored offline)
('equipment',                 'image',             'directus_files',              NULL,                       'nullify'),
('tools',                     'image',             'directus_files',              NULL,                       'nullify'),
('insert_types',              'image',             'directus_files',              NULL,                       'nullify'),
-- operation G-code / NC program file → directus_files (File Library)
('manufacturing_operations',  'gcode_file',        'directus_files',              NULL,                       'nullify'),
-- operation feedstock material → materials (FAST/SPS import)
('manufacturing_operations',  'material_id',       'materials',                   NULL,                       'nullify'),
-- asset → project primary assignment
('equipment',                 'project_id',        'projects',                    NULL,                        'nullify'),
('tools',                     'project_id',        'projects',                    NULL,                        'nullify'),
('tool_boxes',                'project_id',        'projects',                    NULL,                        'nullify');

-- M2M: physical_samples ↔ directus_users via sample_co_owners junction
-- one_field on physical_samples side = 'co_owners' (the M2M alias field)
INSERT INTO directus_relations (many_collection, many_field, one_collection, one_field, junction_field, one_deselect_action) VALUES
('sample_co_owners', 'sample_id', 'physical_samples', 'co_owners', 'user_id',   'delete'),
('sample_co_owners', 'user_id',   'directus_users',    NULL,        'sample_id', 'nullify');

-- M2M: projects ↔ directus_users via project_investigators junction
INSERT INTO directus_relations (many_collection, many_field, one_collection, one_field, junction_field, one_deselect_action) VALUES
('project_investigators', 'project_id', 'projects',        'secondary_investigators', 'user_id',    'delete'),
('project_investigators', 'user_id',    'directus_users',   NULL,                     'project_id', 'nullify');

-- M2M: materials ↔ alloying_elements via material_alloying_elements junction
-- Junction table now has a UUID PK (id) so Directus can manage it properly.
INSERT INTO directus_relations (many_collection, many_field, one_collection, one_field, junction_field, one_deselect_action) VALUES
('material_alloying_elements', 'material_id', 'materials',         'alloying_elements', 'symbol',      'nullify'),
('material_alloying_elements', 'symbol',       'alloying_elements',  NULL,               'material_id', 'nullify');

-- M2M: manufacturing_operations ↔ directus_files via operation_data_files junction
-- one_field on the operations side = 'data_files' (the M2M files picker)
INSERT INTO directus_relations (many_collection, many_field, one_collection, one_field, junction_field, one_deselect_action) VALUES
('operation_data_files', 'operation_id',      'manufacturing_operations', 'data_files', 'directus_files_id', 'delete'),
('operation_data_files', 'directus_files_id', 'directus_files',            NULL,         'operation_id',      'nullify');

-- M2M: physical_samples ↔ directus_files via sample_data_files junction
INSERT INTO directus_relations (many_collection, many_field, one_collection, one_field, junction_field, one_deselect_action) VALUES
('sample_data_files', 'sample_id',         'physical_samples', 'data_files', 'directus_files_id', 'delete'),
('sample_data_files', 'directus_files_id', 'directus_files',    NULL,        'sample_id',         'nullify');

-- M2M: test_sessions ↔ directus_files via session_data_files junction
INSERT INTO directus_relations (many_collection, many_field, one_collection, one_field, junction_field, one_deselect_action) VALUES
('session_data_files', 'session_id',        'test_sessions',  'data_files', 'directus_files_id', 'delete'),
('session_data_files', 'directus_files_id', 'directus_files',  NULL,        'session_id',        'nullify');

-- ── people pickers (migration 062) ─────────────────────────────────────────────
-- This script deletes the field rows of the collections above, so the Owner / Operator / PI pickers
-- that migration 062 registered (m2o -> people) are re-added here with the same interface, options,
-- display, width, sort and translations, and the legacy backup columns it hid stay hidden. Without
-- them the forms fall back to a raw UUID input. Re-runnable: each row is deleted then inserted.
-- tests/phase1_schema.sh compares them with the rows the migrations leave.
DELETE FROM directus_fields WHERE (collection, field) IN (('physical_samples','owner_person_id'), ('manufacturing_operations','owner_person_id'), ('manufacturing_operations','operator_person_id'), ('test_sessions','owner_person_id'), ('test_sessions','operator_person_id'), ('tool_boxes','owner_person_id'), ('cutting_inserts','owner_person_id'), ('insert_edges','owner_person_id'), ('projects','principal_investigator_person'));
INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations) VALUES ('physical_samples', 'owner_person_id', 'm2o', 'select-dropdown-m2o', '{"template":"{{full_name}}","enableCreate":true}', 'related-values', '{"template":"{{full_name}}"}', FALSE, FALSE, 8, 'half', FALSE, '[{"language": "en-US", "translation": "Owner"}]');
INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations) VALUES ('manufacturing_operations', 'owner_person_id', 'm2o', 'select-dropdown-m2o', '{"template":"{{full_name}}","enableCreate":true}', 'related-values', '{"template":"{{full_name}}"}', FALSE, FALSE, 8, 'half', FALSE, '[{"language": "en-US", "translation": "Owner"}]');
INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations) VALUES ('manufacturing_operations', 'operator_person_id', 'm2o', 'select-dropdown-m2o', '{"template":"{{full_name}}","enableCreate":true}', 'related-values', '{"template":"{{full_name}}"}', FALSE, FALSE, 9, 'half', FALSE, '[{"language": "en-US", "translation": "Operator"}]');
INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations) VALUES ('test_sessions', 'owner_person_id', 'm2o', 'select-dropdown-m2o', '{"template":"{{full_name}}","enableCreate":true}', 'related-values', '{"template":"{{full_name}}"}', FALSE, FALSE, 8, 'half', FALSE, '[{"language": "en-US", "translation": "Owner"}]');
INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations) VALUES ('test_sessions', 'operator_person_id', 'm2o', 'select-dropdown-m2o', '{"template":"{{full_name}}","enableCreate":true}', 'related-values', '{"template":"{{full_name}}"}', FALSE, FALSE, 9, 'half', FALSE, '[{"language": "en-US", "translation": "Operator"}]');
INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations) VALUES ('tool_boxes', 'owner_person_id', 'm2o', 'select-dropdown-m2o', '{"template":"{{full_name}}","enableCreate":true}', 'related-values', '{"template":"{{full_name}}"}', FALSE, FALSE, 8, 'half', FALSE, '[{"language": "en-US", "translation": "Owner"}]');
INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations) VALUES ('cutting_inserts', 'owner_person_id', 'm2o', 'select-dropdown-m2o', '{"template":"{{full_name}}","enableCreate":true}', 'related-values', '{"template":"{{full_name}}"}', FALSE, FALSE, 8, 'half', FALSE, '[{"language": "en-US", "translation": "Owner"}]');
INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations) VALUES ('insert_edges', 'owner_person_id', 'm2o', 'select-dropdown-m2o', '{"template":"{{full_name}}","enableCreate":true}', 'related-values', '{"template":"{{full_name}}"}', FALSE, FALSE, 8, 'half', FALSE, '[{"language": "en-US", "translation": "Owner"}]');
INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations) VALUES ('projects', 'principal_investigator_person', 'm2o', 'select-dropdown-m2o', '{"template":"{{full_name}}","enableCreate":true}', 'related-values', '{"template":"{{full_name}}"}', FALSE, FALSE, 8, 'half', FALSE, '[{"language": "en-US", "translation": "Principal Investigator"}]');
UPDATE directus_fields SET hidden = TRUE WHERE (collection, field) IN (('physical_samples','owner'), ('manufacturing_operations','owner'), ('test_sessions','owner'), ('tool_boxes','owner'), ('cutting_inserts','owner'), ('insert_edges','owner'), ('manufacturing_operations','operator'), ('test_sessions','operator'));

COMMIT;

-- Verify
SELECT
    dc.collection,
    dc.icon,
    dc.display_template,
    (SELECT COUNT(*) FROM directus_fields df WHERE df.collection = dc.collection) AS field_count,
    (SELECT COUNT(*) FROM directus_relations dr WHERE dr.many_collection = dc.collection
        OR dr.one_collection = dc.collection) AS relation_count
FROM directus_collections dc
WHERE dc.collection NOT LIKE 'directus_%'
ORDER BY dc.sort, dc.collection;
