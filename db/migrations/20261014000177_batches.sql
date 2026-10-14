-- migrate:up
-- Recorded batches (docs/superpowers/specs/2026-10-14-process-map-design.md section 9, decisions D14, D27 and
-- D28; docs/adr/0017-batches-are-recorded.md): a `batches` table so that several operations, or several
-- tests, done together as one job on several samples can be tied together on purpose. Each sample keeps its
-- own operation or test row; `batch_id` on `manufacturing_operations` and `test_sessions` says they were one
-- job. A batch holds no sample data of its own, only a code, a date, notes and an owner.
--
-- `batch_id` is nullable everywhere (Directus treats a NOT NULL column without a default as required: the
-- short_id incident) and ON DELETE SET NULL, so deleting a batch leaves its operations and tests as they were.
--
-- `batches.code` is NOT NULL UNIQUE and gets 'B-0001', 'B-0002', ... from `batches_code_seq` through
-- `batches_next_code()`: four digits, more when the number needs them (B-10000), because a plain
-- lpad(n, 4, '0') would truncate to B-1000 and fail the unique constraint from the 10000th batch on. The
-- function is the column DEFAULT (so Directus does not mark it required): the code is filled when the insert
-- leaves it out, which is what the Data Studio form does (it never sends the default). A BEFORE INSERT trigger
-- also fills a blank code, which a column default does not cover. An explicit NULL never reaches the database
-- through Directus (it refuses it itself, 400, because the column is NOT NULL). The d1-next-number endpoint has
-- no prefix config for this and needs no change.
--
-- It also relabels the FAST press's free-text field `manufacturing_operations.sintering_batch_number` as
-- "Powder batch" (D28), so the word "batch" means only several samples done together (CONTEXT.md).
--
-- Permissions (ADR-0017): every Lab Member reads and creates; update and delete only where owner_person_id is
-- the signed-in user's person (the way ADR-0014 expresses ownership); admins (admin_access policy) do
-- everything. The d1-owner-default hook fills the owner on create. The Lab Member rows are the ones
-- scripts/access_rules.json generates for `batches` (custom rows: `gen_access_rules.py --values --only batches`).
-- Directus caches permissions and schema: restart Directus after applying (no Redis cache is configured for it).

-- Fail fast instead of queueing behind a long import: migrate while no import runs; on a lock timeout, re-run.
SET LOCAL lock_timeout = '10s';

CREATE SEQUENCE batches_code_seq;

-- The next batch code: 'B-' and the sequence number padded to at least four digits (never truncated).
CREATE FUNCTION batches_next_code() RETURNS text
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $$
DECLARE
    n BIGINT := nextval('public.batches_code_seq');
BEGIN
    RETURN 'B-' || lpad(n::text, greatest(4, length(n::text)), '0');
END;
$$;
COMMENT ON FUNCTION batches_next_code() IS 'The next batch code, B-0001, B-0002, ... (four digits, more once the number needs them), from batches_code_seq. Column default of batches.code.';

CREATE TABLE batches (
    batch_id        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code            TEXT NOT NULL DEFAULT batches_next_code(),
    batch_date      DATE,
    notes           TEXT,
    owner_person_id UUID REFERENCES people (person_id) ON DELETE SET NULL,
    user_created    UUID REFERENCES directus_users (id) ON DELETE SET NULL,
    date_created    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    version         INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT batches_code_key UNIQUE (code)
);

ALTER SEQUENCE batches_code_seq OWNED BY batches.code;

CREATE INDEX idx_batches_owner_person_id ON batches (owner_person_id);

COMMENT ON TABLE batches IS 'A recorded batch: several operations, or several tests, done together as one job on several samples. Each sample keeps its own operation or test row; manufacturing_operations.batch_id and test_sessions.batch_id tie them together.';
COMMENT ON COLUMN batches.batch_id IS 'Primary key.';
COMMENT ON COLUMN batches.code IS 'Unique human code, B-0001, B-0002, ... taken from batches_next_code() (batches_code_seq) when the insert leaves it out (column default) or sends it blank (trigger); Directus itself refuses an explicit null; any other unique text is kept.';
COMMENT ON COLUMN batches.batch_date IS 'The day the job was done.';
COMMENT ON COLUMN batches.notes IS 'Free-text note on the job.';
COMMENT ON COLUMN batches.owner_person_id IS 'The person who owns the batch; only they (and admins) can update or delete it. Filled with the creator by the d1-owner-default hook.';
COMMENT ON COLUMN batches.user_created IS 'Directus user who created the batch (set by Directus).';
COMMENT ON COLUMN batches.date_created IS 'When the batch was created (set by Directus).';
COMMENT ON COLUMN batches.updated_at IS 'Last update time, maintained by the occ_batches trigger.';
COMMENT ON COLUMN batches.version IS 'Optimistic-concurrency counter, incremented by the occ_batches trigger.';

-- A BEFORE INSERT trigger as well as the column default: a blank code (an empty string, or NULL from direct SQL)
-- does not take the default. It calls the same function the default uses.
CREATE FUNCTION batches_fill_code() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $$
BEGIN
    IF NEW.code IS NULL OR btrim(NEW.code) = '' THEN
        NEW.code := batches_next_code();
    END IF;
    RETURN NEW;
END;
$$;
COMMENT ON FUNCTION batches_fill_code() IS 'BEFORE INSERT on batches: fills code with batches_next_code() when the insert sends it blank (empty, or NULL from direct SQL).';

CREATE TRIGGER batches_fill_code
    BEFORE INSERT ON batches
    FOR EACH ROW EXECUTE FUNCTION batches_fill_code();
CREATE TRIGGER occ_batches
    BEFORE UPDATE ON batches
    FOR EACH ROW EXECUTE FUNCTION occ_update_trigger_function();
CREATE TRIGGER audit_batches
    AFTER INSERT OR UPDATE OR DELETE ON batches
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

-- batch_id on operations and tests: nullable, a deleted batch just leaves them unbatched.
ALTER TABLE manufacturing_operations ADD COLUMN batch_id UUID REFERENCES batches (batch_id) ON DELETE SET NULL;
ALTER TABLE test_sessions ADD COLUMN batch_id UUID REFERENCES batches (batch_id) ON DELETE SET NULL;
CREATE INDEX idx_manufacturing_operations_batch_id ON manufacturing_operations (batch_id);
CREATE INDEX idx_test_sessions_batch_id ON test_sessions (batch_id);

COMMENT ON COLUMN manufacturing_operations.batch_id IS 'The recorded batch this operation was done in, when several samples were processed together as one job; NULL otherwise.';
COMMENT ON COLUMN test_sessions.batch_id IS 'The recorded batch this test was done in, when several samples were tested together as one job; NULL otherwise.';

-- Directus metadata for batches.
INSERT INTO directus_collections (collection, icon, note, display_template, hidden, sort)
VALUES ('batches', 'inventory_2', 'Several operations or tests done together as one job', '{{code}}', false, 94)
ON CONFLICT (collection) DO NOTHING;

INSERT INTO directus_fields (
    collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width,
    translations, note
)
SELECT v.collection, v.field, v.special, v.interface, v.options::json, v.display, v.display_options::json,
       v.readonly, v.hidden, v.sort, v.width, v.translations::json, v.note
FROM (VALUES
    ('batches', 'batch_id', 'uuid', 'input', NULL, NULL, NULL, true, true, 1, 'full', NULL, NULL),
    ('batches', 'code', NULL, 'input', NULL, NULL, NULL, false, false, 2, 'half', NULL,
        'Left empty, it is filled in as B-0001, B-0002, ...'),
    ('batches', 'batch_date', NULL, 'datetime', NULL, 'datetime', '{"relative":false}', false, false, 3, 'half',
        '[{"language":"en-US","translation":"Date"}]', 'The day the job was done.'),
    ('batches', 'owner_person_id', 'm2o', 'select-dropdown-m2o', '{"template":"{{full_name}}","enableCreate":true}',
        'related-values', '{"template":"{{full_name}}"}', false, false, 4, 'half',
        '[{"language":"en-US","translation":"Owner"}]', NULL),
    ('batches', 'notes', NULL, 'input-multiline', NULL, NULL, NULL, false, false, 5, 'full', NULL, NULL),
    ('batches', 'user_created', 'user-created', 'select-dropdown-m2o', '{"template":"{{first_name}} {{last_name}}"}',
        'user', NULL, true, true, 6, 'half', NULL, NULL),
    ('batches', 'date_created', 'date-created', 'datetime', NULL, 'datetime', '{"relative":true}', true, true, 7, 'half', NULL, NULL),
    ('batches', 'updated_at', NULL, 'datetime', NULL, NULL, NULL, true, true, 8, 'half', NULL, NULL),
    ('batches', 'version', NULL, 'input', NULL, NULL, NULL, true, true, 9, 'half', NULL, NULL),
    -- The pickers sit beside the date fields: operation_date is 9 and operation_sequence 10 on operations,
    -- session_date is 7 and test_category 8 on tests.
    ('manufacturing_operations', 'batch_id', 'm2o', 'select-dropdown-m2o', '{"template":"{{code}}","enableCreate":true}',
        'related-values', '{"template":"{{code}}"}', false, false, 11, 'half',
        '[{"language":"en-US","translation":"Batch"}]', 'Set when several samples were processed together as one job.'),
    ('test_sessions', 'batch_id', 'm2o', 'select-dropdown-m2o', '{"template":"{{code}}","enableCreate":true}',
        'related-values', '{"template":"{{code}}"}', false, false, 9, 'half',
        '[{"language":"en-US","translation":"Batch"}]', 'Set when several samples were processed together as one job.')
) v(collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, translations, note)
WHERE NOT EXISTS (SELECT 1 FROM directus_fields f WHERE f.collection = v.collection AND f.field = v.field);

INSERT INTO directus_relations (many_collection, many_field, one_collection, one_field, one_deselect_action)
SELECT v.many_collection, v.many_field, v.one_collection, v.one_field, v.one_deselect_action
FROM (VALUES
    ('batches', 'owner_person_id', 'people', NULL, 'nullify'),
    ('batches', 'user_created', 'directus_users', NULL, 'nullify'),
    ('manufacturing_operations', 'batch_id', 'batches', NULL, 'nullify'),
    ('test_sessions', 'batch_id', 'batches', NULL, 'nullify')
) v(many_collection, many_field, one_collection, one_field, one_deselect_action)
WHERE NOT EXISTS (SELECT 1 FROM directus_relations r WHERE r.many_collection = v.many_collection AND r.many_field = v.many_field);

-- D28: the FAST press's free-text batch field is the powder batch. The label stays editable in Directus.
UPDATE directus_fields
SET translations = '[{"language":"en-US","translation":"Powder batch"}]'::json,
    note = 'The powder batch typed on the FAST press, e.g. TIMET 45-150. Names a raw stock lot but is not linked to it.'
WHERE collection = 'manufacturing_operations' AND field = 'sintering_batch_number';

-- Lab Member permissions: the rows scripts/access_rules.json generates for batches
-- (`python3 scripts/gen_access_rules.py --values --only batches`). Read is open. Create and update are limited
-- to the content columns, so the system columns (user_created, date_created, updated_at, version, batch_id)
-- are admin-only. Update and delete only where the batch's owner is the signed-in user.
INSERT INTO directus_permissions (collection, action, permissions, validation, presets, fields, policy)
SELECT 'batches', v.action, v.permissions::json, '{}'::json, NULL, v.fields, '20000002-0000-0000-0000-000000000002'
FROM (VALUES
    ('create', '{}', 'code,batch_date,notes,owner_person_id'),
    ('read', '{}', '*'),
    ('update', '{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}', 'code,batch_date,notes,owner_person_id'),
    ('delete', '{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}', '*')
) v(action, permissions, fields)
WHERE NOT EXISTS (
    SELECT 1 FROM directus_permissions p
    WHERE p.policy = '20000002-0000-0000-0000-000000000002'
      AND p.collection = 'batches' AND p.action = v.action
);

-- migrate:down
SET LOCAL lock_timeout = '10s';

-- Restores the sintering_batch_number translation exactly as migration 20261009000143 stages it
-- ("Batch #", no note). Dropping batches drops the recorded batches; operations and tests keep their rows.
DELETE FROM directus_permissions WHERE collection = 'batches';
DELETE FROM directus_relations WHERE many_collection = 'batches' OR one_collection = 'batches';
DELETE FROM directus_fields
WHERE collection = 'batches'
   OR (field = 'batch_id' AND collection IN ('manufacturing_operations', 'test_sessions'));
DELETE FROM directus_collections WHERE collection = 'batches';
UPDATE directus_fields
SET translations = '[{"language": "en-US", "translation": "Batch #"}]'::json, note = NULL
WHERE collection = 'manufacturing_operations' AND field = 'sintering_batch_number';
DROP INDEX IF EXISTS idx_test_sessions_batch_id;
DROP INDEX IF EXISTS idx_manufacturing_operations_batch_id;
ALTER TABLE test_sessions DROP COLUMN IF EXISTS batch_id;
ALTER TABLE manufacturing_operations DROP COLUMN IF EXISTS batch_id;
DROP TRIGGER IF EXISTS audit_batches ON batches;
DROP TRIGGER IF EXISTS occ_batches ON batches;
DROP TRIGGER IF EXISTS batches_fill_code ON batches;
DROP TABLE IF EXISTS batches;
DROP FUNCTION IF EXISTS batches_fill_code();
DROP FUNCTION IF EXISTS batches_next_code();
DROP SEQUENCE IF EXISTS batches_code_seq;
