-- Directus metadata for the campaigns layer (machining trials + testing campaigns).
-- Idempotent: safe to re-run. Apply after migration 20260628000047_campaigns.sql.
--   docker exec -i d1-database-postgres-1 sh -c "PGPASSWORD=change_me psql -h localhost -U d1 -d d1_database" < scripts/configure_campaigns.sql
-- then flush Redis + restart Directus.

-- ─── 1. COLLECTION ────────────────────────────────────────────────────────────
BEGIN;

INSERT INTO directus_collections (collection, icon, color, display_template, sort_field, sort, translations)
VALUES ('campaigns','campaign','#3F51B5','{{name}}',NULL,26,
        '[{"language":"en-US","translation":"Campaigns","singular":"Campaign","plural":"Campaigns"}]')
ON CONFLICT (collection) DO UPDATE SET
    icon=EXCLUDED.icon, color=EXCLUDED.color, display_template=EXCLUDED.display_template,
    sort_field=EXCLUDED.sort_field, sort=EXCLUDED.sort, translations=EXCLUDED.translations;

-- No sort_field: it is Directus's drag-to-reorder column and would overwrite start_date
-- (#115). The default order, newest first, is the global preset (bookmark/user/role NULL);
-- an existing one keeps its columns and filter, only its sort is set.
UPDATE directus_presets AS p
SET layout = coalesce(p.layout, 'tabular'),
    layout_query = (
        CASE WHEN jsonb_typeof(p.layout_query::jsonb) = 'object' THEN p.layout_query::jsonb ELSE '{}'::jsonb END
        || jsonb_build_object(
            coalesce(p.layout, 'tabular'),
            CASE WHEN jsonb_typeof(p.layout_query::jsonb -> coalesce(p.layout, 'tabular')) = 'object'
                 THEN p.layout_query::jsonb -> coalesce(p.layout, 'tabular') ELSE '{}'::jsonb END
            || '{"sort":["-start_date"]}'::jsonb)
    )::json
WHERE p.collection = 'campaigns' AND p.bookmark IS NULL AND p."user" IS NULL AND p.role IS NULL;
INSERT INTO directus_presets (bookmark, "user", role, collection, layout, layout_query)
SELECT NULL, NULL, NULL, 'campaigns', 'tabular', '{"tabular":{"sort":["-start_date"]}}'
WHERE NOT EXISTS (
    SELECT 1 FROM directus_presets AS p
    WHERE p.collection = 'campaigns' AND p.bookmark IS NULL AND p."user" IS NULL AND p.role IS NULL
);

-- ─── 2. FIELDS ────────────────────────────────────────────────────────────────
-- campaigns: full reset (new collection). Children: only the campaign_id field.
-- projects: only the 'campaigns' O2M alias. (Do NOT wipe other managed fields.)
DELETE FROM directus_fields WHERE collection='campaigns';
DELETE FROM directus_fields WHERE collection IN ('manufacturing_operations','test_sessions') AND field='campaign_id';
DELETE FROM directus_fields WHERE collection='projects' AND field='campaigns';

INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations) VALUES
('campaigns','campaign_id',  'uuid','input',NULL,'raw',NULL,true,true,1,'full',false,NULL),
('campaigns','project_id',   'm2o','select-dropdown-m2o','{"template":"{{project_code}} – {{project_name}}"}','related-values','{"template":"{{project_code}}"}',false,false,2,'half',false,'[{"language":"en-US","translation":"Project (optional)"}]'),
('campaigns','campaign_type',NULL,'select-dropdown','{"choices":[{"text":"Machining Trial","value":"machining_trial"},{"text":"Testing Campaign","value":"testing_campaign"}]}','labels','{"choices":[{"text":"Machining Trial","value":"machining_trial","foreground":"#FFFFFF","background":"#FF9800"},{"text":"Testing Campaign","value":"testing_campaign","foreground":"#FFFFFF","background":"#2196F3"}]}',false,false,3,'half',true,'[{"language":"en-US","translation":"Campaign Type"}]'),
('campaigns','name',         NULL,'input',NULL,'raw',NULL,false,false,4,'half',true,'[{"language":"en-US","translation":"Name"}]'),
('campaigns','campaign_code',NULL,'input',NULL,'raw',NULL,false,false,5,'half',false,'[{"language":"en-US","translation":"Campaign Code"}]'),
('campaigns','owner',        'm2o','select-dropdown-m2o','{"template":"{{first_name}} {{last_name}}"}','user',NULL,false,false,6,'half',false,'[{"language":"en-US","translation":"Owner (researcher)"}]'),
('campaigns','default_equipment_id','m2o','select-dropdown-m2o','{"template":"{{equipment_name}}"}','related-values','{"template":"{{equipment_name}}"}',false,false,7,'half',false,'[{"language":"en-US","translation":"Default Machine"}]'),
('campaigns','default_material_id', 'm2o','select-dropdown-m2o','{"template":"{{common_name}} ({{alloy_code}})"}','related-values','{"template":"{{alloy_code}}"}',false,false,8,'half',false,'[{"language":"en-US","translation":"Default Material / Alloy"}]'),
('campaigns','start_date',   NULL,'datetime','{"type":"date"}','datetime',NULL,false,false,9,'half',false,'[{"language":"en-US","translation":"Start Date"}]'),
('campaigns','end_date',     NULL,'datetime','{"type":"date"}','datetime',NULL,false,false,10,'half',false,'[{"language":"en-US","translation":"End Date"}]'),
('campaigns','status',       NULL,'select-dropdown','{"choices":[{"text":"Planned","value":"planned"},{"text":"Active","value":"active"},{"text":"Complete","value":"complete"},{"text":"On Hold","value":"on_hold"}]}','labels','{"choices":[{"text":"Planned","value":"planned"},{"text":"Active","value":"active"},{"text":"Complete","value":"complete"},{"text":"On Hold","value":"on_hold"}]}',false,false,11,'half',false,NULL),
('campaigns','notes',        NULL,'input-multiline',NULL,'raw',NULL,false,false,12,'full',false,NULL),
('campaigns','operations',   'o2m','list-o2m','{"template":"{{pass_code}} – {{operation_date}}","enableCreate":true}','related-values',NULL,false,true,13,'full',false,'[{"language":"en-US","translation":"Operations (this trial)"}]'),
('campaigns','sessions',     'o2m','list-o2m','{"template":"{{session_date}} – {{test_type}}","enableCreate":true}','related-values',NULL,false,true,14,'full',false,'[{"language":"en-US","translation":"Test Sessions (this campaign)"}]'),
('campaigns','created_by','user-created','select-dropdown-m2o','{"template":"{{first_name}} {{last_name}}"}','user',NULL,true,false,98,'half',false,'[{"language":"en-US","translation":"Created by"}]'),
('campaigns','created_at','date-created','datetime',NULL,'datetime',NULL,true,true,20,'half',false,NULL),
('campaigns','updated_at','date-updated','datetime',NULL,'datetime',NULL,true,true,21,'half',false,NULL),
('campaigns','version',NULL,'input',NULL,'raw',NULL,true,true,22,'half',false,NULL);

-- Child M2O fields → campaigns, filtered to the matching campaign type.
INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations) VALUES
('manufacturing_operations','campaign_id','m2o','select-dropdown-m2o','{"template":"{{name}}","filter":{"campaign_type":{"_eq":"machining_trial"}}}','related-values','{"template":"{{name}}"}',false,false,10,'half',false,'[{"language":"en-US","translation":"Machining Trial"}]'),
('test_sessions','campaign_id','m2o','select-dropdown-m2o','{"template":"{{name}}","filter":{"campaign_type":{"_eq":"testing_campaign"}}}','related-values','{"template":"{{name}}"}',false,false,5,'half',false,'[{"language":"en-US","translation":"Testing Campaign"}]');

-- O2M panel on projects.
INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations) VALUES
('projects','campaigns','o2m','list-o2m','{"template":"{{name}} – {{campaign_type}}","enableCreate":true}','related-values',NULL,false,false,13,'full',false,'[{"language":"en-US","translation":"Campaigns (trials & testing)"}]');

-- Children's project_id uses the live "inherit from campaign" interface. (configure_directus.sql
-- re-creates project_id as a plain m2o; this runs after it, so re-apply the inherit interface.)
UPDATE directus_fields SET interface='d1-project-inherit'
WHERE collection IN ('manufacturing_operations','test_sessions') AND field='project_id';

-- Conditional visibility of the two O2M panels on campaigns by type.
UPDATE directus_fields
SET conditions='[{"name":"machining trials only","rule":{"_and":[{"campaign_type":{"_eq":"machining_trial"}}]},"hidden":false,"readonly":false,"required":false}]'
WHERE collection='campaigns' AND field='operations';
UPDATE directus_fields
SET conditions='[{"name":"testing campaigns only","rule":{"_and":[{"campaign_type":{"_eq":"testing_campaign"}}]},"hidden":false,"readonly":false,"required":false}]'
WHERE collection='campaigns' AND field='sessions';

-- ─── 3. RELATIONS ─────────────────────────────────────────────────────────────
DELETE FROM directus_relations
WHERE one_collection='campaigns'
   OR many_collection='campaigns'
   OR (many_collection IN ('manufacturing_operations','test_sessions') AND many_field='campaign_id');

INSERT INTO directus_relations (many_collection, many_field, one_collection, one_field, one_deselect_action) VALUES
('campaigns','project_id','projects','campaigns','nullify'),
('campaigns','owner','directus_users',NULL,'nullify'),
('campaigns','default_equipment_id','equipment',NULL,'nullify'),
('campaigns','default_material_id','materials',NULL,'nullify'),
('manufacturing_operations','campaign_id','campaigns','operations','nullify'),
('test_sessions','campaign_id','campaigns','sessions','nullify');

COMMIT;
