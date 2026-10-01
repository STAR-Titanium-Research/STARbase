-- migrate:up
-- The Geometry dropdown used to offer Cylindrical / Rectangular (before migration 67 moved
-- it to disc / cylinder / block / plate / bar / ...). Samples saved with the old values were
-- never back-filled, so they still draw (the drawing code matches them loosely) but their
-- dimension inputs are hidden: the field conditions only list the current vocabulary.
-- Map them onto the current values, keeping the dimensions the drawing already used:
--   cylindrical -> cylinder (diameter + length)
--   rectangular -> block    (width + length + thickness)
UPDATE physical_samples SET form = 'cylinder' WHERE lower(form) = 'cylindrical';
UPDATE physical_samples SET form = 'block'    WHERE lower(form) = 'rectangular';

-- migrate:down
-- Not reversible: a migrated 'block' cannot be told apart from one that was always a block,
-- and the old values are no longer offered by the dropdown.
