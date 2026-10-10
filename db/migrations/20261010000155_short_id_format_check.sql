-- migrate:up
-- short_id must look like a short ID (T0b, carry-over from T0a's review). Since 153 gave short_id
-- an empty default for Directus's sake, an INSERT that bypasses the trigger (triggers disabled,
-- session_replication_role = replica) would silently store '' instead of failing on NOT NULL.
-- CHECK runs after the BEFORE triggers, so the normal path is unaffected; Directus does not read
-- CHECK constraints, so it does not start demanding the field.
ALTER TABLE physical_samples
    ADD CONSTRAINT physical_samples_short_id_format_check CHECK (short_id ~ '^[0-9a-f]{8,32}$');
ALTER TABLE manufacturing_operations
    ADD CONSTRAINT manufacturing_operations_short_id_format_check CHECK (short_id ~ '^[0-9a-f]{8,32}$');
ALTER TABLE test_sessions
    ADD CONSTRAINT test_sessions_short_id_format_check CHECK (short_id ~ '^[0-9a-f]{8,32}$');
COMMENT ON CONSTRAINT physical_samples_short_id_format_check ON physical_samples IS 'short_id is 8-32 lower-case hex (never the empty column default).';
COMMENT ON CONSTRAINT manufacturing_operations_short_id_format_check ON manufacturing_operations IS 'short_id is 8-32 lower-case hex (never the empty column default).';
COMMENT ON CONSTRAINT test_sessions_short_id_format_check ON test_sessions IS 'short_id is 8-32 lower-case hex (never the empty column default).';

-- migrate:down
ALTER TABLE test_sessions DROP CONSTRAINT IF EXISTS test_sessions_short_id_format_check;
ALTER TABLE manufacturing_operations DROP CONSTRAINT IF EXISTS manufacturing_operations_short_id_format_check;
ALTER TABLE physical_samples DROP CONSTRAINT IF EXISTS physical_samples_short_id_format_check;
