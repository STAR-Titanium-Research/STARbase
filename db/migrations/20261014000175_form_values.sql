-- migrate:up
-- Form QA (2026-10-14, plan docs/superpowers/plans/2026-10-14-form-layout.md, decisions 1 and 8): the Sample
-- form's dropdowns showed a blank for many existing rows, because the stored value is not one of the choices.
-- This back-fills the stored values onto the current choices (migration 174 adds the two new Surface Finish
-- choices as_produced and medium_machined).
--
-- 1. item_type: "Sample is the record". The column gets the default 'sample' (so STARbase's Register-sample
--    screen and every API caller get it, and the form can hide the field); the 4 rows with NULL become 'sample'.
--    The 16 'equipment' rows are left as they are.
-- 2. form (Geometry), matched case-insensitively and trimmed: rectangular -> block, cylindrical -> cylinder,
--    coupon -> tensile_coupon, billet -> cylinder, l-profile -> other. Everything else is left.
-- 3. surface_finish: Machined -> medium_machined, Polished -> polished, Mirror -> mirror, Ground -> ground,
--    "As produced" / "As-sintered" in any case, spacing or hyphenation -> as_produced, N/A -> none. Existing
--    codes (none, rough_machined, finish_machined, ground, polished, mirror) are untouched.
--
-- The original (item_type, form, surface_finish) of every row changed is kept in d1_private.form_values_175_backup
-- so down restores them exactly (migration 115 did the same kind of back-fill with no way back).
-- The UPDATE fires the optimistic-lock trigger (version + 1) and the audit trigger (one audit row per changed
-- sample): both are expected. The readers triggers of migration 166 only look at owner_person_id, project_id and
-- restricted, which this does not touch, so no visibility is recomputed.

CREATE SCHEMA IF NOT EXISTS d1_private;

CREATE TABLE d1_private.form_values_175_backup AS
SELECT sample_id, item_type, form, surface_finish
FROM physical_samples
WHERE item_type IS NULL
    OR lower(btrim(form)) IN ('rectangular', 'cylindrical', 'coupon', 'billet', 'l-profile')
    OR lower(btrim(surface_finish)) IN ('machined', 'polished', 'mirror', 'ground', 'n/a')
    OR lower(btrim(surface_finish)) ~ '^as[[:space:]_-]*(produced|sintered)$';

ALTER TABLE d1_private.form_values_175_backup ADD PRIMARY KEY (sample_id);
COMMENT ON TABLE d1_private.form_values_175_backup IS 'Migration 175: the original item_type, form and surface_finish of every physical_samples row it changed, so its down restores them. Safe to drop once migration 175 is final.';

ALTER TABLE physical_samples ALTER COLUMN item_type SET DEFAULT 'sample';

UPDATE physical_samples AS ps
SET item_type = COALESCE(ps.item_type, 'sample'),
    form = CASE lower(btrim(ps.form))
        WHEN 'rectangular' THEN 'block'
        WHEN 'cylindrical' THEN 'cylinder'
        WHEN 'coupon' THEN 'tensile_coupon'
        WHEN 'billet' THEN 'cylinder'
        WHEN 'l-profile' THEN 'other'
        ELSE ps.form
    END,
    surface_finish = CASE
        WHEN lower(btrim(ps.surface_finish)) = 'machined' THEN 'medium_machined'
        WHEN lower(btrim(ps.surface_finish)) = 'polished' THEN 'polished'
        WHEN lower(btrim(ps.surface_finish)) = 'mirror' THEN 'mirror'
        WHEN lower(btrim(ps.surface_finish)) = 'ground' THEN 'ground'
        WHEN lower(btrim(ps.surface_finish)) ~ '^as[[:space:]_-]*(produced|sintered)$' THEN 'as_produced'
        WHEN lower(btrim(ps.surface_finish)) = 'n/a' THEN 'none'
        ELSE ps.surface_finish
    END
FROM d1_private.form_values_175_backup AS b
WHERE ps.sample_id = b.sample_id;

-- migrate:down
-- Restores item_type, form and surface_finish of exactly the rows the up section changed, from the backup table
-- (the OCC and audit triggers fire again, as in up). Lossy only for a row someone edited again after up: its
-- three columns go back to the pre-175 values.
UPDATE physical_samples AS ps
SET item_type = b.item_type,
    form = b.form,
    surface_finish = b.surface_finish
FROM d1_private.form_values_175_backup AS b
WHERE ps.sample_id = b.sample_id;

ALTER TABLE physical_samples ALTER COLUMN item_type DROP DEFAULT;
DROP TABLE d1_private.form_values_175_backup;
