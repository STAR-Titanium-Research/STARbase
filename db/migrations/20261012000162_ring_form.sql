-- migrate:up
-- Add a ring form: a disc with a bore (e.g. the Super CMV machining rings, OD 151 / ID 19.5).
-- The bore needs its own column, `inner_diameter_mm`; the outer diameter stays `diameter_mm`,
-- the axial thickness `thickness_mm` (drawn, as for a disc) and `width_mm` is offered as well.
--
-- The form dropdown and the dimension conditions are rewritten in full rather than patched. On the
-- production database they had lost round_bar (added by 20260930000114) to a later metadata
-- rewrite, so this also puts round_bar back.

ALTER TABLE physical_samples ADD COLUMN inner_diameter_mm NUMERIC(10, 4);
ALTER TABLE physical_samples ADD CONSTRAINT physical_samples_inner_diameter_mm_check
CHECK (
    inner_diameter_mm IS NULL
    OR (inner_diameter_mm > 0 AND (diameter_mm IS NULL OR inner_diameter_mm < diameter_mm))
);
COMMENT ON COLUMN physical_samples.inner_diameter_mm
IS 'Bore (inner) diameter in mm of a ring-form sample; diameter_mm is the outer diameter.';

DELETE FROM directus_fields WHERE collection = 'physical_samples' AND field = 'inner_diameter_mm';
INSERT INTO directus_fields (
    collection, field, special, interface, options, display, display_options, readonly, hidden,
    sort, width, required, translations, conditions
) VALUES (
    'physical_samples', 'inner_diameter_mm', NULL, 'input', '{"step":0.001,"suffix":"mm"}', 'raw', NULL,
    false, false, 8, 'half', false, '[{"language":"en-US","translation":"Ø Inner (mm)"}]',
    '[{"name": "sample only", "rule": {"_and": [{"item_type": {"_neq": "sample"}}]}, "hidden": true, "readonly": false, "required": false}, {"name": "form", "rule": {"_and": [{"form": {"_nin": ["ring"]}}]}, "hidden": true, "readonly": false, "required": false}]'
);

UPDATE directus_fields
SET options = '{"choices":[{"text":"Disc","value":"disc"},{"text":"Ring","value":"ring"},{"text":"Cylinder","value":"cylinder"},{"text":"Block","value":"block"},{"text":"Plate","value":"plate"},{"text":"Bar","value":"bar"},{"text":"Round bar","value":"round_bar"},{"text":"Tensile coupon (ISO 6892)","value":"tensile_coupon"},{"text":"Bend / fatigue bar (ISO 7438)","value":"bend_bar"},{"text":"Powder / Compact","value":"powder"},{"text":"Other","value":"other"}]}'
WHERE collection = 'physical_samples' AND field = 'form';

UPDATE directus_fields SET conditions = '[{"name": "sample only", "rule": {"_and": [{"item_type": {"_neq": "sample"}}]}, "hidden": true, "readonly": false, "required": false}, {"name": "form", "rule": {"_and": [{"form": {"_nin": ["disc", "ring", "cylinder", "round_bar"]}}]}, "hidden": true, "readonly": false, "required": false}]'
WHERE collection = 'physical_samples' AND field = 'diameter_mm';
UPDATE directus_fields SET conditions = '[{"name": "sample only", "rule": {"_and": [{"item_type": {"_neq": "sample"}}]}, "hidden": true, "readonly": false, "required": false}, {"name": "form", "rule": {"_and": [{"form": {"_nin": ["ring", "block", "plate", "bar", "tensile_coupon", "bend_bar"]}}]}, "hidden": true, "readonly": false, "required": false}]'
WHERE collection = 'physical_samples' AND field = 'width_mm';
UPDATE directus_fields SET conditions = '[{"name": "sample only", "rule": {"_and": [{"item_type": {"_neq": "sample"}}]}, "hidden": true, "readonly": false, "required": false}, {"name": "form", "rule": {"_and": [{"form": {"_nin": ["cylinder", "block", "plate", "bar", "round_bar", "tensile_coupon", "bend_bar"]}}]}, "hidden": true, "readonly": false, "required": false}]'
WHERE collection = 'physical_samples' AND field = 'length_mm';
UPDATE directus_fields SET conditions = '[{"name": "sample only", "rule": {"_and": [{"item_type": {"_neq": "sample"}}]}, "hidden": true, "readonly": false, "required": false}, {"name": "form", "rule": {"_and": [{"form": {"_nin": ["disc", "ring", "block", "plate", "bar", "tensile_coupon", "bend_bar"]}}]}, "hidden": true, "readonly": false, "required": false}]'
WHERE collection = 'physical_samples' AND field = 'thickness_mm';

-- migrate:down
-- Lossy for ring rows: they become discs and their bore diameter is dropped with the column.
-- The dropdown and conditions go back to the 20260930000114 state (round_bar included).
UPDATE physical_samples SET form = 'disc' WHERE form = 'ring';

DELETE FROM directus_fields WHERE collection = 'physical_samples' AND field = 'inner_diameter_mm';

UPDATE directus_fields
SET options = '{"choices":[{"text":"Disc","value":"disc"},{"text":"Cylinder","value":"cylinder"},{"text":"Block","value":"block"},{"text":"Plate","value":"plate"},{"text":"Bar","value":"bar"},{"text":"Round bar","value":"round_bar"},{"text":"Tensile coupon (ISO 6892)","value":"tensile_coupon"},{"text":"Bend / fatigue bar (ISO 7438)","value":"bend_bar"},{"text":"Powder / Compact","value":"powder"},{"text":"Other","value":"other"}]}'
WHERE collection = 'physical_samples' AND field = 'form';

UPDATE directus_fields SET conditions = '[{"name": "sample only", "rule": {"_and": [{"item_type": {"_neq": "sample"}}]}, "hidden": true, "readonly": false, "required": false}, {"name": "form", "rule": {"_and": [{"form": {"_nin": ["disc", "cylinder", "round_bar"]}}]}, "hidden": true, "readonly": false, "required": false}]'
WHERE collection = 'physical_samples' AND field = 'diameter_mm';
UPDATE directus_fields SET conditions = '[{"name": "sample only", "rule": {"_and": [{"item_type": {"_neq": "sample"}}]}, "hidden": true, "readonly": false, "required": false}, {"name": "form", "rule": {"_and": [{"form": {"_nin": ["block", "plate", "bar", "tensile_coupon", "bend_bar"]}}]}, "hidden": true, "readonly": false, "required": false}]'
WHERE collection = 'physical_samples' AND field = 'width_mm';
UPDATE directus_fields SET conditions = '[{"name": "sample only", "rule": {"_and": [{"item_type": {"_neq": "sample"}}]}, "hidden": true, "readonly": false, "required": false}, {"name": "form", "rule": {"_and": [{"form": {"_nin": ["disc", "block", "plate", "bar", "tensile_coupon", "bend_bar"]}}]}, "hidden": true, "readonly": false, "required": false}]'
WHERE collection = 'physical_samples' AND field = 'thickness_mm';

ALTER TABLE physical_samples DROP CONSTRAINT physical_samples_inner_diameter_mm_check;
ALTER TABLE physical_samples DROP COLUMN inner_diameter_mm;
