-- Directus config for sample preparation (etchants, recipes, prep steps).
-- Run AFTER configure_directus.sql. Idempotent (DELETE then INSERT for fields /
-- relations; ON CONFLICT for collections).

BEGIN;

-- ── Collections ───────────────────────────────────────────────────────────────
INSERT INTO directus_collections (collection, icon, display_template, sort_field, sort, color, translations, "group") VALUES
  ('etchants',          'science',      '{{name}}',                 'name', 240, '#8E24AA', '[{"language":"en-US","translation":"Etchants","singular":"Etchant","plural":"Etchants"}]', NULL),
  ('prep_recipes',      'menu_book',    '{{name}}',                 'name', 241, '#5E35B1', '[{"language":"en-US","translation":"Prep Recipes","singular":"Recipe","plural":"Recipes"}]', NULL),
  ('prep_recipe_steps', 'list',         '{{step_order}}. {{step_type}}', NULL, 242, NULL, NULL, NULL),
  ('prep_steps',        'list',         '{{step_order}}. {{step_type}}', NULL, 243, NULL, NULL, NULL)
ON CONFLICT (collection) DO UPDATE SET
  icon=EXCLUDED.icon, display_template=EXCLUDED.display_template, sort=EXCLUDED.sort,
  color=COALESCE(EXCLUDED.color, directus_collections.color),
  translations=COALESCE(EXCLUDED.translations, directus_collections.translations);

UPDATE directus_collections SET hidden = true WHERE collection IN ('prep_recipe_steps','prep_steps');

-- ── Fields ────────────────────────────────────────────────────────────────────
DELETE FROM directus_fields WHERE collection IN ('etchants','prep_recipes','prep_recipe_steps','prep_steps');

-- etchants
INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations) VALUES
('etchants','etchant_id',   'uuid','input',NULL,'raw',NULL,true,true,1,'full',false,NULL),
('etchants','name',         NULL,'input',NULL,'raw',NULL,false,false,2,'half',true,'[{"language":"en-US","translation":"Name"}]'),
('etchants','composition',  NULL,'input',NULL,'raw',NULL,false,false,3,'full',false,'[{"language":"en-US","translation":"Composition"}]'),
('etchants','suited_metals',NULL,'input',NULL,'raw',NULL,false,false,4,'full',false,'[{"language":"en-US","translation":"Suited Metals"}]'),
('etchants','notes',        NULL,'input-multiline',NULL,'raw',NULL,false,false,5,'full',false,NULL),
('etchants','owner',        'm2o','select-dropdown-m2o','{"template":"{{first_name}} {{last_name}}"}','user',NULL,false,false,6,'half',false,'[{"language":"en-US","translation":"Added By"}]'),
('etchants','created_by','user-created','select-dropdown-m2o','{"template":"{{first_name}} {{last_name}}"}','user',NULL,true,false,98,'half',false,'[{"language":"en-US","translation":"Created by"}]'),
('etchants','created_at','date-created','datetime',NULL,'datetime',NULL,true,true,20,'half',false,NULL),
('etchants','updated_at','date-updated','datetime',NULL,'datetime',NULL,true,true,21,'half',false,NULL),
('etchants','version',NULL,'input',NULL,'raw',NULL,true,true,22,'half',false,NULL);

-- prep_recipes
INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations) VALUES
('prep_recipes','recipe_id',       'uuid','input',NULL,'raw',NULL,true,true,1,'full',false,NULL),
('prep_recipes','name',            NULL,'input',NULL,'raw',NULL,false,false,2,'half',true,'[{"language":"en-US","translation":"Recipe Name"}]'),
('prep_recipes','suited_materials',NULL,'input',NULL,'raw',NULL,false,false,3,'half',false,'[{"language":"en-US","translation":"Suited Materials"}]'),
('prep_recipes','description',     NULL,'input-multiline',NULL,'raw',NULL,false,false,4,'full',false,NULL),
('prep_recipes','owner',           'm2o','select-dropdown-m2o','{"template":"{{first_name}} {{last_name}}"}','user',NULL,false,false,5,'half',false,'[{"language":"en-US","translation":"Owner"}]'),
('prep_recipes','steps',           'o2m','list-o2m','{"template":"{{step_order}}. {{step_type}}","enableCreate":true,"enableSelect":false}','related-values',NULL,false,false,10,'full',false,'[{"language":"en-US","translation":"Steps"}]'),
('prep_recipes','created_by','user-created','select-dropdown-m2o','{"template":"{{first_name}} {{last_name}}"}','user',NULL,true,false,98,'half',false,'[{"language":"en-US","translation":"Created by"}]'),
('prep_recipes','created_at','date-created','datetime',NULL,'datetime',NULL,true,true,20,'half',false,NULL),
('prep_recipes','updated_at','date-updated','datetime',NULL,'datetime',NULL,true,true,21,'half',false,NULL),
('prep_recipes','version',NULL,'input',NULL,'raw',NULL,true,true,22,'half',false,NULL);

-- prep_recipe_steps  (template steps)
INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations) VALUES
('prep_recipe_steps','step_id',      'uuid','input',NULL,'raw',NULL,true,true,1,'full',false,NULL),
('prep_recipe_steps','recipe_id',    'm2o','select-dropdown-m2o','{"template":"{{name}}"}','related-values',NULL,true,true,2,'full',false,NULL),
('prep_recipe_steps','step_order',   NULL,'input','{"min":1,"step":1}','raw',NULL,false,false,3,'half',false,'[{"language":"en-US","translation":"Step #"}]'),
('prep_recipe_steps','step_type',    NULL,'select-dropdown','{"choices":[{"text":"Sectioning","value":"sectioning"},{"text":"Mounting","value":"mounting"},{"text":"Grinding","value":"grinding"},{"text":"Polishing","value":"polishing"},{"text":"Etching","value":"etching"},{"text":"Cleaning","value":"cleaning"},{"text":"Other","value":"other"}]}','labels',NULL,false,false,4,'half',false,'[{"language":"en-US","translation":"Step Type"}]'),
('prep_recipe_steps','grit',         NULL,'select-dropdown','{"allowOther":true,"choices":[{"text":"P50","value":"P50"},{"text":"P80","value":"P80"},{"text":"P120","value":"P120"},{"text":"P180","value":"P180"},{"text":"P240","value":"P240"},{"text":"P320","value":"P320"},{"text":"P400","value":"P400"},{"text":"P600","value":"P600"},{"text":"P800","value":"P800"},{"text":"P1200","value":"P1200"},{"text":"P2400","value":"P2400"},{"text":"P4000","value":"P4000"}]}','labels',NULL,false,false,5,'half',false,'[{"language":"en-US","translation":"Grit (grinding)"}]'),
('prep_recipe_steps','suspension_um',NULL,'select-dropdown','{"allowOther":true,"choices":[{"text":"9 µm","value":"9"},{"text":"6 µm","value":"6"},{"text":"3 µm","value":"3"},{"text":"1 µm","value":"1"},{"text":"0.25 µm","value":"0.25"},{"text":"0.05 µm","value":"0.05"}]}','labels',NULL,false,false,6,'half',false,'[{"language":"en-US","translation":"Suspension (polishing)"}]'),
('prep_recipe_steps','cloth',        NULL,'input',NULL,'raw',NULL,false,false,7,'half',false,'[{"language":"en-US","translation":"Cloth"}]'),
('prep_recipe_steps','etchant_id',   'm2o','select-dropdown-m2o','{"template":"{{name}}","enableCreate":true}','related-values','{"template":"{{name}}"}',false,false,8,'half',false,'[{"language":"en-US","translation":"Etchant"}]'),
('prep_recipe_steps','duration_s',   NULL,'input','{"step":1,"suffix":"s"}','raw',NULL,false,false,9,'half',false,'[{"language":"en-US","translation":"Duration"}]'),
('prep_recipe_steps','force_n',      NULL,'input','{"step":0.5,"suffix":"N"}','raw',NULL,false,false,10,'half',false,'[{"language":"en-US","translation":"Force"}]'),
('prep_recipe_steps','rpm',          NULL,'input','{"step":1,"suffix":"rpm"}','raw',NULL,false,false,11,'half',false,'[{"language":"en-US","translation":"Wheel Speed"}]'),
('prep_recipe_steps','temperature_c',NULL,'input','{"step":0.5,"suffix":"°C"}','raw',NULL,false,false,12,'half',false,'[{"language":"en-US","translation":"Temperature"}]'),
('prep_recipe_steps','lubricant',    NULL,'input',NULL,'raw',NULL,false,false,13,'half',false,'[{"language":"en-US","translation":"Lubricant"}]'),
('prep_recipe_steps','resin_type',   NULL,'input',NULL,'raw',NULL,false,false,14,'half',false,'[{"language":"en-US","translation":"Resin (mounting)"}]'),
('prep_recipe_steps','notes',        NULL,'input-multiline',NULL,'raw',NULL,false,false,15,'full',false,NULL),
('prep_recipe_steps','created_at','date-created','datetime',NULL,'datetime',NULL,true,true,20,'half',false,NULL),
('prep_recipe_steps','updated_at','date-updated','datetime',NULL,'datetime',NULL,true,true,21,'half',false,NULL),
('prep_recipe_steps','version',NULL,'input',NULL,'raw',NULL,true,true,22,'half',false,NULL);

-- prep_steps  (actual applied steps — same fields, operation_id instead of recipe_id)
INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations) VALUES
('prep_steps','step_id',      'uuid','input',NULL,'raw',NULL,true,true,1,'full',false,NULL),
('prep_steps','operation_id', 'm2o','select-dropdown-m2o','{"template":"{{pass_code}}"}','related-values',NULL,true,true,2,'full',false,NULL),
('prep_steps','step_order',   NULL,'input','{"min":1,"step":1}','raw',NULL,false,false,3,'half',false,'[{"language":"en-US","translation":"Step #"}]'),
('prep_steps','step_type',    NULL,'select-dropdown','{"choices":[{"text":"Sectioning","value":"sectioning"},{"text":"Mounting","value":"mounting"},{"text":"Grinding","value":"grinding"},{"text":"Polishing","value":"polishing"},{"text":"Etching","value":"etching"},{"text":"Cleaning","value":"cleaning"},{"text":"Other","value":"other"}]}','labels',NULL,false,false,4,'half',false,'[{"language":"en-US","translation":"Step Type"}]'),
('prep_steps','grit',         NULL,'select-dropdown','{"allowOther":true,"choices":[{"text":"P50","value":"P50"},{"text":"P80","value":"P80"},{"text":"P120","value":"P120"},{"text":"P180","value":"P180"},{"text":"P240","value":"P240"},{"text":"P320","value":"P320"},{"text":"P400","value":"P400"},{"text":"P600","value":"P600"},{"text":"P800","value":"P800"},{"text":"P1200","value":"P1200"},{"text":"P2400","value":"P2400"},{"text":"P4000","value":"P4000"}]}','labels',NULL,false,false,5,'half',false,'[{"language":"en-US","translation":"Grit (grinding)"}]'),
('prep_steps','suspension_um',NULL,'select-dropdown','{"allowOther":true,"choices":[{"text":"9 µm","value":"9"},{"text":"6 µm","value":"6"},{"text":"3 µm","value":"3"},{"text":"1 µm","value":"1"},{"text":"0.25 µm","value":"0.25"},{"text":"0.05 µm","value":"0.05"}]}','labels',NULL,false,false,6,'half',false,'[{"language":"en-US","translation":"Suspension (polishing)"}]'),
('prep_steps','cloth',        NULL,'input',NULL,'raw',NULL,false,false,7,'half',false,'[{"language":"en-US","translation":"Cloth"}]'),
('prep_steps','etchant_id',   'm2o','select-dropdown-m2o','{"template":"{{name}}","enableCreate":true}','related-values','{"template":"{{name}}"}',false,false,8,'half',false,'[{"language":"en-US","translation":"Etchant"}]'),
('prep_steps','duration_s',   NULL,'input','{"step":1,"suffix":"s"}','raw',NULL,false,false,9,'half',false,'[{"language":"en-US","translation":"Duration"}]'),
('prep_steps','force_n',      NULL,'input','{"step":0.5,"suffix":"N"}','raw',NULL,false,false,10,'half',false,'[{"language":"en-US","translation":"Force"}]'),
('prep_steps','rpm',          NULL,'input','{"step":1,"suffix":"rpm"}','raw',NULL,false,false,11,'half',false,'[{"language":"en-US","translation":"Wheel Speed"}]'),
('prep_steps','temperature_c',NULL,'input','{"step":0.5,"suffix":"°C"}','raw',NULL,false,false,12,'half',false,'[{"language":"en-US","translation":"Temperature"}]'),
('prep_steps','lubricant',    NULL,'input',NULL,'raw',NULL,false,false,13,'half',false,'[{"language":"en-US","translation":"Lubricant"}]'),
('prep_steps','resin_type',   NULL,'input',NULL,'raw',NULL,false,false,14,'half',false,'[{"language":"en-US","translation":"Resin (mounting)"}]'),
('prep_steps','notes',        NULL,'input-multiline',NULL,'raw',NULL,false,false,15,'full',false,NULL),
('prep_steps','created_at','date-created','datetime',NULL,'datetime',NULL,true,true,20,'half',false,NULL),
('prep_steps','updated_at','date-updated','datetime',NULL,'datetime',NULL,true,true,21,'half',false,NULL),
('prep_steps','version',NULL,'input',NULL,'raw',NULL,true,true,22,'half',false,NULL);

-- ── manufacturing_operations: source recipe + prep steps panel (sample_prep) ──
DELETE FROM directus_fields WHERE collection='manufacturing_operations' AND field IN ('source_recipe_id','prep_steps');
INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations, conditions) VALUES
('manufacturing_operations','source_recipe_id','m2o','select-dropdown-m2o','{"template":"{{name}}"}','related-values','{"template":"{{name}}"}',false,true,15,'half',false,'[{"language":"en-US","translation":"Prefill From Recipe"}]',
  '[{"name":"prep only","rule":{"_and":[{"process_category":{"_eq":"sample_prep"}}]},"hidden":false,"readonly":false,"required":false}]'),
('manufacturing_operations','prep_steps','o2m','list-o2m','{"template":"{{step_order}}. {{step_type}}","enableCreate":true,"enableSelect":false}','related-values',NULL,false,true,16,'full',false,'[{"language":"en-US","translation":"Preparation Steps"}]',
  '[{"name":"prep only","rule":{"_and":[{"process_category":{"_eq":"sample_prep"}}]},"hidden":false,"readonly":false,"required":false}]');

-- ── Relations ─────────────────────────────────────────────────────────────────
DELETE FROM directus_relations
WHERE many_collection IN ('prep_recipe_steps','prep_steps','etchants','prep_recipes')
   OR (many_collection='manufacturing_operations' AND many_field='source_recipe_id');
INSERT INTO directus_relations (many_collection, many_field, one_collection, one_field, one_deselect_action) VALUES
('prep_recipe_steps','recipe_id',  'prep_recipes',             'steps',      'delete'),
('prep_recipe_steps','etchant_id', 'etchants',                 NULL,         'nullify'),
('prep_steps','operation_id',      'manufacturing_operations', 'prep_steps', 'delete'),
('prep_steps','etchant_id',        'etchants',                 NULL,         'nullify'),
('manufacturing_operations','source_recipe_id','prep_recipes', NULL,         'nullify'),
('etchants','owner',               'directus_users',           NULL,         'nullify'),
('prep_recipes','owner',           'directus_users',           NULL,         'nullify');

COMMIT;
