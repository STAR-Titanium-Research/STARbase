-- migrate:up
-- Form QA (2026-10-14): four bugs that stop or spoil the everyday create/edit forms. Each was reproduced by
-- driving the Directus form as a Lab Member on a restored copy of live (no live writes).
--
-- 1. A test session could not be saved from the form at all. test_sessions.sample_id is a hidden field, kept
--    equal to the first sample of the Subject rows by the trigger of migration 139, but its Directus row was
--    marked required, so the form refused every save with "Sample / Workpiece (Hidden): Value is required".
--    The trigger sets it; the form must not ask for it.
-- 2. Saving a campaign of type "Imaging / Analysis" returned HTTP 500. Migration 087 added the choice (and the
--    @d1/ui kit labels it), but the CHECK of migration 047 still allowed only the first two types.
-- 3. Every Owner field (and the project's Principal Investigator) showed a raw person UUID in a text box. The
--    fields name the interface d1-owner-picker, set by migration 20261001000126, but neither that migration file
--    nor the extension was ever committed: core/extensions/d1-owner-picker has no package.json and an empty
--    dist/, so Directus falls back to a plain input. They go back to the standard related-item dropdown that
--    scripts/configure_directus.sql, configure_campaigns.sql and configure_sample_prep.sql already define (the
--    picker's "same as parent" shortcut goes with it; d1-owner-default still makes the creator the owner).
--    Creating a person from the dropdown is off: a Lab Member who made a new, login-less person the owner lost
--    read and edit of the record the moment it was saved (checked on the copy).
-- 4. The machining Operation Sub-type offered generic words (turning, facing, ...) while every stored value is a
--    method code + letter (MT-F 159 rows, MT-R 18, MT-O 4, MM-R 1 on live), so existing operations showed a blank
--    sub-type and a new one got a value the operation-code rule (migration 156) cannot shorten. Migration 143
--    restored these choices from configure_inline_params.sql, which had the wrong list; the list here is the
--    one the field had before (directus_revisions 2348).

UPDATE directus_fields SET required = false
WHERE collection = 'test_sessions' AND field = 'sample_id';

ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS campaigns_campaign_type_check;
ALTER TABLE campaigns ADD CONSTRAINT campaigns_campaign_type_check
    CHECK (campaign_type IN ('machining_trial', 'testing_campaign', 'imaging_analysis'));

-- By name, not by interface: a database built from the migrations alone (CI) never had d1-owner-picker, and the
-- configure scripts write these same rows (phase1 checks the two agree).
UPDATE directus_fields
SET interface = 'select-dropdown-m2o',
    options = '{"template":"{{full_name}}","enableCreate":false}'
WHERE (collection, field) IN (
    ('campaigns', 'owner_person_id'), ('cutting_inserts', 'owner_person_id'), ('etchants', 'owner_person_id'),
    ('insert_edges', 'owner_person_id'), ('manufacturing_operations', 'owner_person_id'),
    ('physical_samples', 'owner_person_id'), ('prep_recipes', 'owner_person_id'),
    ('projects', 'principal_investigator_person'), ('test_sessions', 'owner_person_id'),
    ('tool_boxes', 'owner_person_id'));

UPDATE directus_fields
SET options = '{"choices":[{"text":"Turning – Facing","value":"MT-F"},{"text":"Turning – Roughing","value":"MT-R"},{"text":"Turning – OD","value":"MT-O"},{"text":"Turning – Grooving","value":"MT-G"},{"text":"Turning – Boring","value":"MT-B"},{"text":"Turning – Threading","value":"MT-H"},{"text":"Turning – Parting","value":"MT-P"},{"text":"Turning – Drilling","value":"MT-D"},{"text":"Milling – Facing","value":"MM-F"},{"text":"Milling – Roughing","value":"MM-R"},{"text":"Milling – Slotting","value":"MM-S"},{"text":"Milling – Drilling","value":"MM-D"},{"text":"Other","value":"other"}]}',
    display_options = '{"choices":[{"text":"Turning – Facing","value":"MT-F"},{"text":"Turning – Roughing","value":"MT-R"},{"text":"Turning – OD","value":"MT-O"},{"text":"Turning – Grooving","value":"MT-G"},{"text":"Turning – Boring","value":"MT-B"},{"text":"Turning – Threading","value":"MT-H"},{"text":"Turning – Parting","value":"MT-P"},{"text":"Turning – Drilling","value":"MT-D"},{"text":"Milling – Facing","value":"MM-F"},{"text":"Milling – Roughing","value":"MM-R"},{"text":"Milling – Slotting","value":"MM-S"},{"text":"Milling – Drilling","value":"MM-D"},{"text":"Other","value":"other"}]}'
WHERE collection = 'manufacturing_operations' AND field = 'machining_operation_subtype';

-- migrate:down
-- Restores the previous metadata exactly, including the uninstalled d1-owner-picker and its per-field options.
-- An imaging_analysis campaign saved under the new CHECK would block the old one, so those rows are moved to
-- testing_campaign first (lossy: the type is all that changes).
UPDATE directus_fields SET required = true
WHERE collection = 'test_sessions' AND field = 'sample_id';

UPDATE campaigns SET campaign_type = 'testing_campaign' WHERE campaign_type = 'imaging_analysis';
ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS campaigns_campaign_type_check;
ALTER TABLE campaigns ADD CONSTRAINT campaigns_campaign_type_check
    CHECK (campaign_type IN ('machining_trial', 'testing_campaign'));

UPDATE directus_fields AS f
SET interface = 'd1-owner-picker', options = v.options::json
FROM (VALUES
    ('campaigns', 'owner_person_id', '{"parentField":"project_id","parentCollection":"projects","parentOwnerField":"principal_investigator_person"}'),
    ('cutting_inserts', 'owner_person_id', '{"parentField":"tool_box_id","parentCollection":"tool_boxes","parentOwnerField":"owner_person_id"}'),
    ('etchants', 'owner_person_id', '{}'),
    ('insert_edges', 'owner_person_id', '{"parentField":"insert_id","parentCollection":"cutting_inserts","parentOwnerField":"owner_person_id"}'),
    ('manufacturing_operations', 'owner_person_id', '{"parentField":"campaign_id","parentCollection":"campaigns","parentOwnerField":"owner_person_id"}'),
    ('physical_samples', 'owner_person_id', '{}'),
    ('prep_recipes', 'owner_person_id', '{}'),
    ('projects', 'principal_investigator_person', '{}'),
    ('test_sessions', 'owner_person_id', '{"parentField":"campaign_id","parentCollection":"campaigns","parentOwnerField":"owner_person_id"}'),
    ('tool_boxes', 'owner_person_id', '{}')
) AS v (collection, field, options)
WHERE f.collection = v.collection AND f.field = v.field;

UPDATE directus_fields
SET options = '{"choices": [{"text": "Turning", "value": "turning"}, {"text": "Facing", "value": "facing"}, {"text": "Boring", "value": "boring"}, {"text": "Threading", "value": "threading"}, {"text": "Grooving", "value": "grooving"}, {"text": "Parting", "value": "parting"}, {"text": "Milling", "value": "milling"}, {"text": "Drilling", "value": "drilling"}, {"text": "Other", "value": "other"}]}',
    display_options = NULL
WHERE collection = 'manufacturing_operations' AND field = 'machining_operation_subtype';
