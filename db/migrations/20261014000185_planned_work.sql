-- migrate:up
-- Planned work (docs/adr/0019-operations-and-tests-can-be-planned.md; spec
-- docs/superpowers/specs/2026-10-14-process-map-edit-mode-design.md section 4.1): operations and tests can be
-- laid out before they are done, and the samples an operation is going to make exist as "planned samples" so
-- their labels can be printed before the cut.
--
--   * manufacturing_operations and test_sessions get `work_state` ('planned' | 'done', NOT NULL DEFAULT 'done'),
--     `planned_date` (when it is meant to happen), `done_by_person_id` (who marked it done) and `done_at`.
--     The default keeps every existing writer (Data Studio forms, the FAST importer, the Force App) writing
--     done records with no change; every existing row becomes 'done'. `test_sessions.status` keeps its
--     pipeline meaning (registered -> ... -> analysed).
--   * `operation_date` / `session_date` stay the date the work happened and stay empty on a planned record.
--   * physical_samples.current_status gains 'planned'. The down section maps those rows to 'archived'.
--   * Partial indexes on work_state = 'planned' (the minority) on both tables.
--
-- Directus metadata: work_state is a read-only dropdown (Planned / Done: it changes through Mark done, or the
-- owner's back-to-planned, so the date, the person and the outputs move together), placed with the other
-- "Who & where" fields; planned_date beside it; done_by_person_id and done_at read-only. current_status gains
-- a Planned choice (and label colour). Lab Member permissions need no change: the ruled rows of both tables
-- grant '*' (scripts/access_rules.json lists fields explicitly only for samples and projects, and samples gain
-- no column here). The back-to-planned refusal is the d1-access-guard hook (same change set).
-- Directus caches permissions and schema: restart Directus after applying (no Redis cache is configured for it).

-- Fail fast instead of queueing behind a long import: migrate while no import runs; on a lock timeout, re-run.
SET LOCAL lock_timeout = '10s';

ALTER TABLE manufacturing_operations
    ADD COLUMN work_state TEXT NOT NULL DEFAULT 'done',
    ADD COLUMN planned_date DATE,
    ADD COLUMN done_by_person_id UUID REFERENCES people (person_id) ON DELETE SET NULL,
    ADD COLUMN done_at TIMESTAMPTZ,
    ADD CONSTRAINT manufacturing_operations_work_state_check CHECK (work_state IN ('planned', 'done'));

ALTER TABLE test_sessions
    ADD COLUMN work_state TEXT NOT NULL DEFAULT 'done',
    ADD COLUMN planned_date DATE,
    ADD COLUMN done_by_person_id UUID REFERENCES people (person_id) ON DELETE SET NULL,
    ADD COLUMN done_at TIMESTAMPTZ,
    ADD CONSTRAINT test_sessions_work_state_check CHECK (work_state IN ('planned', 'done'));

CREATE INDEX idx_manufacturing_operations_work_state_planned ON manufacturing_operations (work_state) WHERE work_state = 'planned';
CREATE INDEX idx_test_sessions_work_state_planned ON test_sessions (work_state) WHERE work_state = 'planned';

COMMENT ON COLUMN manufacturing_operations.work_state IS 'Whether the operation has been done or is only planned: done (default; everything recorded before planning existed) or planned. Set to done by Mark done in the d1-build endpoint, which also sets operation_date, done_by_person_id, done_at and turns the planned output samples active. Setting a done operation back to planned is refused by d1-access-guard unless the caller owns it or is an admin.';
COMMENT ON COLUMN manufacturing_operations.planned_date IS 'The day the operation is meant to happen. NULL when not planned for a day. operation_date stays the day it happened and stays empty while the operation is planned.';
COMMENT ON COLUMN manufacturing_operations.done_by_person_id IS 'The person who marked the operation done (Mark done); NULL while planned and for operations recorded as done directly.';
COMMENT ON COLUMN manufacturing_operations.done_at IS 'When the operation was marked done (Mark done); NULL while planned and for operations recorded as done directly.';
COMMENT ON COLUMN test_sessions.work_state IS 'Whether the test has been done or is only planned: done (default; everything recorded before planning existed) or planned. Not the pipeline state: that is test_sessions.status, which a planned test simply has nothing to process for. Set to done by Mark done in the d1-build endpoint. Setting a done test back to planned is refused by d1-access-guard unless the caller owns it or is an admin.';
COMMENT ON COLUMN test_sessions.planned_date IS 'The day the test is meant to happen. NULL when not planned for a day. session_date stays the day it happened and stays empty while the test is planned.';
COMMENT ON COLUMN test_sessions.done_by_person_id IS 'The person who marked the test done (Mark done); NULL while planned and for tests recorded as done directly.';
COMMENT ON COLUMN test_sessions.done_at IS 'When the test was marked done (Mark done); NULL while planned and for tests recorded as done directly.';

-- Planned samples: the status of a sample that a planned operation is going to make.
ALTER TABLE physical_samples DROP CONSTRAINT physical_samples_status_check;
ALTER TABLE physical_samples
    ADD CONSTRAINT physical_samples_status_check
    CHECK (current_status IN ('active', 'consumed', 'destroyed', 'archived', 'planned'));
COMMENT ON COLUMN physical_samples.current_status IS 'Lifecycle state: active | consumed | destroyed | archived | planned. planned = a sample that a planned operation is going to make: it has its final code already (labels can be printed) and becomes active when that operation is marked done. Filters that mean "exists physically" must use active.';

-- Directus metadata: the four columns of each collection, with the other Who & where fields. The group is looked
-- up, not assumed, so a database without the form layout (migration 174) gets ungrouped fields instead of a dangling name.
INSERT INTO directus_fields (
    collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width,
    translations, note, "group"
)
SELECT v.collection, v.field, v.special, v.interface, v.options::json, v.display, v.display_options::json,
       v.readonly, false, v.sort, v.width, v.translations::json, v.note,
       (SELECT g.field FROM directus_fields g
         WHERE g.collection = v.collection AND g.field = 'grp_who_where' AND g.interface = 'group-detail')
FROM (VALUES
    ('manufacturing_operations', 'work_state', NULL, 'select-dropdown',
        '{"choices":[{"text":"Planned","value":"planned"},{"text":"Done","value":"done"}]}',
        'labels', '{"choices":[{"text":"Planned","value":"planned","foreground":"#1565C0","background":"#E3F2FD"},{"text":"Done","value":"done","foreground":"#2E7D32","background":"#E8F5E9"}]}',
        true, 80, 'half', '[{"language":"en-US","translation":"Work state"}]',
        'Planned work has not happened yet. Use Mark done (on the process map) to record it as done.'),
    ('manufacturing_operations', 'planned_date', NULL, 'datetime', NULL, 'datetime', '{"relative":false}',
        false, 90, 'half', '[{"language":"en-US","translation":"Planned date"}]',
        'The day the operation is meant to happen. The date it happened is Operation date.'),
    ('manufacturing_operations', 'done_by_person_id', 'm2o', 'select-dropdown-m2o', '{"template":"{{full_name}}"}',
        'related-values', '{"template":"{{full_name}}"}',
        true, 100, 'half', '[{"language":"en-US","translation":"Done by"}]', 'Who marked it done.'),
    ('manufacturing_operations', 'done_at', NULL, 'datetime', NULL, 'datetime', '{"relative":false}',
        true, 110, 'half', '[{"language":"en-US","translation":"Marked done at"}]', 'When it was marked done.'),
    ('test_sessions', 'work_state', NULL, 'select-dropdown',
        '{"choices":[{"text":"Planned","value":"planned"},{"text":"Done","value":"done"}]}',
        'labels', '{"choices":[{"text":"Planned","value":"planned","foreground":"#1565C0","background":"#E3F2FD"},{"text":"Done","value":"done","foreground":"#2E7D32","background":"#E8F5E9"}]}',
        true, 70, 'half', '[{"language":"en-US","translation":"Work state"}]',
        'Planned work has not happened yet. Use Mark done (on the process map) to record it as done.'),
    ('test_sessions', 'planned_date', NULL, 'datetime', NULL, 'datetime', '{"relative":false}',
        false, 80, 'half', '[{"language":"en-US","translation":"Planned date"}]',
        'The day the test is meant to happen. The date it happened is Session date.'),
    ('test_sessions', 'done_by_person_id', 'm2o', 'select-dropdown-m2o', '{"template":"{{full_name}}"}',
        'related-values', '{"template":"{{full_name}}"}',
        true, 90, 'half', '[{"language":"en-US","translation":"Done by"}]', 'Who marked it done.'),
    ('test_sessions', 'done_at', NULL, 'datetime', NULL, 'datetime', '{"relative":false}',
        true, 100, 'half', '[{"language":"en-US","translation":"Marked done at"}]', 'When it was marked done.')
) v(collection, field, special, interface, options, display, display_options, readonly, sort, width, translations, note)
WHERE NOT EXISTS (SELECT 1 FROM directus_fields f WHERE f.collection = v.collection AND f.field = v.field);

INSERT INTO directus_relations (many_collection, many_field, one_collection, one_field, one_deselect_action)
SELECT v.many_collection, v.many_field, v.one_collection, v.one_field, v.one_deselect_action
FROM (VALUES
    ('manufacturing_operations', 'done_by_person_id', 'people', NULL, 'nullify'),
    ('test_sessions', 'done_by_person_id', 'people', NULL, 'nullify')
) v(many_collection, many_field, one_collection, one_field, one_deselect_action)
WHERE NOT EXISTS (SELECT 1 FROM directus_relations r WHERE r.many_collection = v.many_collection AND r.many_field = v.many_field);

-- The Status dropdown and its label colours gain Planned (appended once; a field without choices is left alone).
UPDATE directus_fields
SET options = jsonb_set(options::jsonb, '{choices}',
        (options::jsonb -> 'choices') || '[{"text":"Planned","value":"planned"}]'::jsonb)::json
WHERE collection = 'physical_samples' AND field = 'current_status'
  AND jsonb_typeof(options::jsonb -> 'choices') = 'array'
  AND NOT ((options::jsonb -> 'choices') @> '[{"value":"planned"}]'::jsonb);
UPDATE directus_fields
SET display_options = jsonb_set(display_options::jsonb, '{choices}',
        (display_options::jsonb -> 'choices')
        || '[{"text":"Planned","value":"planned","foreground":"#1565C0","background":"#E3F2FD"}]'::jsonb)::json
WHERE collection = 'physical_samples' AND field = 'current_status'
  AND jsonb_typeof(display_options::jsonb -> 'choices') = 'array'
  AND NOT ((display_options::jsonb -> 'choices') @> '[{"value":"planned"}]'::jsonb);

-- migrate:down
SET LOCAL lock_timeout = '10s';

-- Lossy by design: a planned sample has no "before" state in the old vocabulary, so it becomes archived (the
-- spec's mapping); planned operations and tests lose their work state with the column and read as done again.
UPDATE directus_fields
SET options = jsonb_set(options::jsonb, '{choices}',
        coalesce((SELECT jsonb_agg(c) FROM jsonb_array_elements(options::jsonb -> 'choices') c
                   WHERE c ->> 'value' <> 'planned'), '[]'::jsonb))::json
WHERE collection = 'physical_samples' AND field = 'current_status'
  AND jsonb_typeof(options::jsonb -> 'choices') = 'array'
  AND (options::jsonb -> 'choices') @> '[{"value":"planned"}]'::jsonb;
UPDATE directus_fields
SET display_options = jsonb_set(display_options::jsonb, '{choices}',
        coalesce((SELECT jsonb_agg(c) FROM jsonb_array_elements(display_options::jsonb -> 'choices') c
                   WHERE c ->> 'value' <> 'planned'), '[]'::jsonb))::json
WHERE collection = 'physical_samples' AND field = 'current_status'
  AND jsonb_typeof(display_options::jsonb -> 'choices') = 'array'
  AND (display_options::jsonb -> 'choices') @> '[{"value":"planned"}]'::jsonb;

DELETE FROM directus_relations
WHERE many_field = 'done_by_person_id' AND many_collection IN ('manufacturing_operations', 'test_sessions');
DELETE FROM directus_fields
WHERE collection IN ('manufacturing_operations', 'test_sessions')
  AND field IN ('work_state', 'planned_date', 'done_by_person_id', 'done_at');

UPDATE physical_samples SET current_status = 'archived' WHERE current_status = 'planned';
ALTER TABLE physical_samples DROP CONSTRAINT physical_samples_status_check;
ALTER TABLE physical_samples
    ADD CONSTRAINT physical_samples_status_check
    CHECK (current_status IN ('active', 'consumed', 'destroyed', 'archived'));
COMMENT ON COLUMN physical_samples.current_status IS 'Lifecycle state: active | consumed | destroyed | archived.';

DROP INDEX IF EXISTS idx_test_sessions_work_state_planned;
DROP INDEX IF EXISTS idx_manufacturing_operations_work_state_planned;
ALTER TABLE test_sessions
    DROP CONSTRAINT IF EXISTS test_sessions_work_state_check,
    DROP COLUMN IF EXISTS done_at,
    DROP COLUMN IF EXISTS done_by_person_id,
    DROP COLUMN IF EXISTS planned_date,
    DROP COLUMN IF EXISTS work_state;
ALTER TABLE manufacturing_operations
    DROP CONSTRAINT IF EXISTS manufacturing_operations_work_state_check,
    DROP COLUMN IF EXISTS done_at,
    DROP COLUMN IF EXISTS done_by_person_id,
    DROP COLUMN IF EXISTS planned_date,
    DROP COLUMN IF EXISTS work_state;
