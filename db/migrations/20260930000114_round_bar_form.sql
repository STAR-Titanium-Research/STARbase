-- migrate:up
-- Add a round bar form (diameter_mm + length_mm) alongside the existing rectangular `bar`
-- (a square bar is just a `bar` with width = thickness).

UPDATE directus_fields
SET options = '{"choices":[{"text":"Disc","value":"disc"},{"text":"Cylinder","value":"cylinder"},{"text":"Block","value":"block"},{"text":"Plate","value":"plate"},{"text":"Bar","value":"bar"},{"text":"Round bar","value":"round_bar"},{"text":"Tensile coupon (ISO 6892)","value":"tensile_coupon"},{"text":"Bend / fatigue bar (ISO 7438)","value":"bend_bar"},{"text":"Powder / Compact","value":"powder"},{"text":"Other","value":"other"}]}'
WHERE collection = 'physical_samples' AND field = 'form';

UPDATE directus_fields SET conditions='[{"name": "sample only", "rule": {"_and": [{"item_type": {"_neq": "sample"}}]}, "hidden": true, "readonly": false, "required": false}, {"name": "form", "rule": {"_and": [{"form": {"_nin": ["disc", "cylinder", "round_bar"]}}]}, "hidden": true, "readonly": false, "required": false}]' WHERE collection='physical_samples' AND field='diameter_mm';
UPDATE directus_fields SET conditions='[{"name": "sample only", "rule": {"_and": [{"item_type": {"_neq": "sample"}}]}, "hidden": true, "readonly": false, "required": false}, {"name": "form", "rule": {"_and": [{"form": {"_nin": ["cylinder", "block", "plate", "bar", "round_bar", "tensile_coupon", "bend_bar"]}}]}, "hidden": true, "readonly": false, "required": false}]' WHERE collection='physical_samples' AND field='length_mm';

-- migrate:down
-- Rows saved as round_bar would otherwise be orphaned (missing from the dropdown, with their
-- diameter/length inputs hidden), so map them to the closest older form. This is lossy:
-- they become 'cylinder' and will draw upright rather than along their length.
UPDATE physical_samples SET form = 'cylinder' WHERE form = 'round_bar';

UPDATE directus_fields
SET options = '{"choices":[{"text":"Disc","value":"disc"},{"text":"Cylinder","value":"cylinder"},{"text":"Block","value":"block"},{"text":"Plate","value":"plate"},{"text":"Bar","value":"bar"},{"text":"Tensile coupon (ISO 6892)","value":"tensile_coupon"},{"text":"Bend / fatigue bar (ISO 7438)","value":"bend_bar"},{"text":"Powder / Compact","value":"powder"},{"text":"Other","value":"other"}]}'
WHERE collection = 'physical_samples' AND field = 'form';

UPDATE directus_fields SET conditions='[{"name": "sample only", "rule": {"_and": [{"item_type": {"_neq": "sample"}}]}, "hidden": true, "readonly": false, "required": false}, {"name": "form", "rule": {"_and": [{"form": {"_nin": ["disc", "cylinder"]}}]}, "hidden": true, "readonly": false, "required": false}]' WHERE collection='physical_samples' AND field='diameter_mm';
UPDATE directus_fields SET conditions='[{"name": "sample only", "rule": {"_and": [{"item_type": {"_neq": "sample"}}]}, "hidden": true, "readonly": false, "required": false}, {"name": "form", "rule": {"_and": [{"form": {"_nin": ["cylinder", "block", "plate", "bar", "tensile_coupon", "bend_bar"]}}]}, "hidden": true, "readonly": false, "required": false}]' WHERE collection='physical_samples' AND field='length_mm';
