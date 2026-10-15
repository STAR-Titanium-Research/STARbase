-- migrate:up
-- Let a person clear a geometry once set: the sample's Geometry (`physical_samples.form`) and a test's
-- Specimen Geometry (`test_sessions.tensile_specimen_geometry`) dropdowns get Directus's "None" choice
-- (`allowNone`), which writes NULL. Merged into the existing options so the live choice lists, which have
-- drifted from the migrations (e.g. fatigue_specimen, charpy_specimen), are kept as they are.

UPDATE directus_fields
SET options = (COALESCE(options::jsonb, '{}'::jsonb) || '{"allowNone": true}'::jsonb)::json
WHERE (collection, field) IN (('physical_samples', 'form'), ('test_sessions', 'tensile_specimen_geometry'))
  AND interface = 'select-dropdown';

-- migrate:down
UPDATE directus_fields
SET options = (options::jsonb - 'allowNone')::json
WHERE (collection, field) IN (('physical_samples', 'form'), ('test_sessions', 'tensile_specimen_geometry'))
  AND options IS NOT NULL;
