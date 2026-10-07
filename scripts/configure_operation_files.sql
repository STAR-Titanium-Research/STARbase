-- Directus metadata for operation_files (external data-file links on an operation).
-- Idempotent. Apply after migration 20260628000049_operation_files.sql, then flush + restart.

BEGIN;

INSERT INTO directus_collections (collection, icon, color, display_template, sort, translations)
VALUES ('operation_files','attach_file','#607D8B','{{file_name}}',27,
        '[{"language":"en-US","translation":"Operation Files","singular":"Operation File","plural":"Operation Files"}]')
ON CONFLICT (collection) DO UPDATE SET
    icon=EXCLUDED.icon, color=EXCLUDED.color, display_template=EXCLUDED.display_template,
    sort=EXCLUDED.sort, translations=EXCLUDED.translations;
UPDATE directus_collections SET hidden=true WHERE collection='operation_files';  -- reached via the O2M panel

DELETE FROM directus_fields WHERE collection='operation_files';
DELETE FROM directus_fields WHERE collection='manufacturing_operations' AND field='data_file_links';

INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations) VALUES
('operation_files','file_id','uuid','input',NULL,'raw',NULL,true,true,1,'full',false,NULL),
('operation_files','operation_id','m2o','select-dropdown-m2o','{"template":"{{pass_code}}"}','related-values','{"template":"{{pass_code}}"}',false,true,2,'full',false,NULL),
('operation_files','file_name',NULL,'input',NULL,'raw',NULL,false,false,3,'full',false,'[{"language":"en-US","translation":"File Name"}]'),
('operation_files','file_kind',NULL,'select-dropdown','{"choices":[{"text":"MAT","value":"mat"},{"text":"CSV","value":"csv"},{"text":"BIN","value":"bin"},{"text":"Other","value":"other"}]}','labels','{"choices":[{"text":"MAT","value":"mat"},{"text":"CSV","value":"csv"},{"text":"BIN","value":"bin"},{"text":"Other","value":"other"}]}',false,false,4,'half',false,'[{"language":"en-US","translation":"Kind"}]'),
('operation_files','file_path',NULL,'d1-file-link','{}','raw',NULL,false,false,5,'full',false,'[{"language":"en-US","translation":"File Location (network path)"}]'),
('operation_files','created_at','date-created','datetime',NULL,'datetime',NULL,true,true,6,'half',false,NULL);

-- O2M panel on manufacturing_operations (top-level so it shows for any op with links).
INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations) VALUES
('manufacturing_operations','data_file_links','o2m','list-o2m','{"template":"{{file_name}} – {{file_kind}}","enableCreate":true,"enableSelect":false}','related-values',NULL,false,false,620,'full',false,'[{"language":"en-US","translation":"Data File Links"}]');

DELETE FROM directus_relations WHERE many_collection='operation_files' AND many_field='operation_id';
INSERT INTO directus_relations (many_collection, many_field, one_collection, one_field, one_deselect_action) VALUES
('operation_files','operation_id','manufacturing_operations','data_file_links','delete');

COMMIT;
