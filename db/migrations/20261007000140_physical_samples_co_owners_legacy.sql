-- migrate:up
-- ADR-0011 (row-level visibility), step 1: free the name `co_owners` on physical_samples.
--
-- physical_samples.co_owners was a legacy TEXT column (migration 019: the AppSheet comma-separated
-- list) and, at the same time, the Directus M2M alias over the sample_co_owners junction
-- (scripts/configure_directus.sql: relation one_field = 'co_owners'). Bare reads of `co_owners`
-- printed ids or the old comma list, and the Lab Member permission filters of ADR-0011 use
-- `co_owners._some.user_id`, which must resolve to the junction and not to a real column of that
-- name. The TEXT column is renamed to co_owners_legacy; nothing else changes.
--
-- Readers checked (grep of db/, scripts/, plugins/, core/, apps/, packages/, tests/, docs/):
--   * scripts/migrate_legacy.py wrote and read the TEXT column: updated in the same commit;
--   * no view, function, trigger, allow-list grant (table level) or semantic dictionary names it
--     (v_schema_dictionary reads information_schema, so it follows the rename);
--   * the Explorer pages and @d1/ui read `co_owners` as the M2M alias, which is what they want.
--
-- The production snapshot (db/schema.sql) no longer has the column, so both directions only act
-- when it is there. The Directus field row keeps the legacy column hidden and read-only in the Data
-- Studio; without one Directus would show the new column in the sample form.

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'physical_samples'
          AND column_name = 'co_owners' AND data_type = 'text'
    ) THEN
        ALTER TABLE physical_samples RENAME COLUMN co_owners TO co_owners_legacy;
        COMMENT ON COLUMN physical_samples.co_owners_legacy IS
            'Legacy comma-separated list of co-owner e-mails from the AppSheet import (kept for scripts/migrate_legacy.py). The live co-owners are the sample_co_owners rows, shown in Directus as the co_owners M2M field.';
        INSERT INTO directus_fields (collection, field, hidden, readonly, note)
        SELECT 'physical_samples', 'co_owners_legacy', TRUE, TRUE,
               'Legacy AppSheet text. Use the Co-owners field (sample_co_owners).'
        WHERE NOT EXISTS (
            SELECT 1 FROM directus_fields
            WHERE collection = 'physical_samples' AND field = 'co_owners_legacy'
        );
    END IF;
END
$$;

-- migrate:down
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'physical_samples'
          AND column_name = 'co_owners_legacy'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'physical_samples'
          AND column_name = 'co_owners'
    ) THEN
        DELETE FROM directus_fields
        WHERE collection = 'physical_samples' AND field = 'co_owners_legacy';
        ALTER TABLE physical_samples RENAME COLUMN co_owners_legacy TO co_owners;
        COMMENT ON COLUMN physical_samples.co_owners IS 'Comma-separated list of co-owners.';
    END IF;
END
$$;
