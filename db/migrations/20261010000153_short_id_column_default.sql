-- migrate:up
-- Hotfix for 20261010000150_short_ids (found on live minutes after it was applied, 2026-10-10).
--
-- Why: Directus treats a NOT NULL column without a default as required and refused to create a
-- sample, operation or test without it ("Validation failed for field short_id. Value is
-- required"), although the BEFORE INSERT trigger always assigns it. A column default makes
-- Directus treat the field as optional. The trigger still overwrites short_id on every INSERT,
-- so the empty default never reaches a row (NOT NULL and the short_ids registry are unchanged).

ALTER TABLE physical_samples ALTER COLUMN short_id SET DEFAULT '';
ALTER TABLE manufacturing_operations ALTER COLUMN short_id SET DEFAULT '';
ALTER TABLE test_sessions ALTER COLUMN short_id SET DEFAULT '';

-- migrate:down
ALTER TABLE test_sessions ALTER COLUMN short_id DROP DEFAULT;
ALTER TABLE manufacturing_operations ALTER COLUMN short_id DROP DEFAULT;
ALTER TABLE physical_samples ALTER COLUMN short_id DROP DEFAULT;
