-- Surface project_rollup as a read-only Directus collection + an O2M panel on projects.
-- Idempotent.
BEGIN;

INSERT INTO directus_collections (collection, icon, color, display_template, hidden, translations)
VALUES ('project_rollup','account_tree','#795548','{{kind}}: {{code}}',true,
        '[{"language":"en-US","translation":"Project Rollup","singular":"Rollup Item","plural":"Project Rollup"}]')
ON CONFLICT (collection) DO UPDATE SET icon=EXCLUDED.icon, display_template=EXCLUDED.display_template, hidden=EXCLUDED.hidden;

DELETE FROM directus_fields WHERE collection='project_rollup';
DELETE FROM directus_fields WHERE collection='projects' AND field='rollup';

INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations) VALUES
('project_rollup','row_id',NULL,'input',NULL,'raw',NULL,true,true,1,'full',false,NULL),
('project_rollup','project_id','m2o','select-dropdown-m2o','{"template":"{{project_code}}"}','related-values','{"template":"{{project_code}}"}',true,true,2,'half',false,NULL),
('project_rollup','kind',NULL,'select-dropdown','{"choices":[{"text":"Operation","value":"operation"},{"text":"Sample","value":"sample"},{"text":"Tool","value":"tool"},{"text":"Insert Edge","value":"insert_edge"},{"text":"Cutting Insert","value":"cutting_insert"},{"text":"Material","value":"material"},{"text":"Equipment","value":"equipment"}]}','labels','{"choices":[{"text":"Operation","value":"operation"},{"text":"Sample","value":"sample"},{"text":"Tool","value":"tool"},{"text":"Insert Edge","value":"insert_edge"},{"text":"Cutting Insert","value":"cutting_insert"},{"text":"Material","value":"material"},{"text":"Equipment","value":"equipment"}]}',true,false,3,'half',false,'[{"language":"en-US","translation":"Kind"}]'),
('project_rollup','code',NULL,'input',NULL,'raw',NULL,true,false,4,'half',false,'[{"language":"en-US","translation":"Code"}]'),
('project_rollup','detail',NULL,'input',NULL,'raw',NULL,true,false,5,'half',false,'[{"language":"en-US","translation":"Detail"}]'),
('project_rollup','campaign_id','m2o','select-dropdown-m2o','{"template":"{{name}}"}','related-values','{"template":"{{name}}"}',true,false,6,'half',false,'[{"language":"en-US","translation":"Campaign"}]');

INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations) VALUES
('projects','rollup','o2m','list-o2m','{"template":"{{kind}} – {{code}}","enableCreate":false,"enableSelect":false}','related-values',NULL,true,false,14,'full',false,'[{"language":"en-US","translation":"Project Rollup (read-only: operations + tooling used)"}]');

DELETE FROM directus_relations WHERE many_collection='project_rollup' AND many_field='project_id';
INSERT INTO directus_relations (many_collection, many_field, one_collection, one_field, one_deselect_action) VALUES
('project_rollup','project_id','projects','rollup','nullify');

COMMIT;
