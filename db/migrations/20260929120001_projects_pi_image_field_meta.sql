-- migrate:up
-- projects.principal_investigator (legacy FK -> directus_users) and
-- projects."Image" both have real DB columns and directus_relations entries,
-- but no directus_fields row, so Directus auto-renders them as generic raw
-- fields — unhidden, labelled from the bare column name ("Principal
-- Investigator" / "Image"). That produced three "Principal Investigator"
-- labels on the form at once: this raw fallback, the proper
-- principal_investigator_person dropdown, and principal_investigator_name
-- (whose own translation is also "Principal Investigator").
-- Gave a migrate:down assuming a prior row existed for
-- ('projects','principal_investigator'), but no earlier migration or the
-- configure_directus.sql baseline ever actually inserted one, so that UPDATE
-- was always a no-op — this field has likely never been hidden in Directus.

INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options, readonly, hidden, sort, width, required, translations)
SELECT 'projects', 'principal_investigator', 'm2o', 'select-dropdown-m2o',
       '{"template":"{{first_name}} {{last_name}}"}', 'user', NULL, false, true, 90, 'half', false,
       '[{"language":"en-US","translation":"Principal Investigator (legacy — use the dropdown above)"}]'
WHERE NOT EXISTS (
    SELECT 1 FROM directus_fields WHERE collection = 'projects' AND field = 'principal_investigator'
);

INSERT INTO directus_fields (collection, field, special, interface, options, display, readonly, hidden, sort, width, required, translations)
SELECT 'projects', 'Image', 'file', 'file-image', '{"crop":false}', 'image', false, false, 13, 'half', false,
       '[{"language":"en-US","translation":"Image"}]'
WHERE NOT EXISTS (
    SELECT 1 FROM directus_fields WHERE collection = 'projects' AND field = 'Image'
);

-- principal_investigator_name (plain free text) was only ever a one-time
-- backfill source for principal_investigator (see 20260627000046), itself
-- superseded by principal_investigator_person. Its translation label is
-- also literally "Principal Investigator", so it read as a third duplicate
-- of the same field. Hide it; nothing else reads this column.
UPDATE directus_fields SET hidden = true
WHERE collection = 'projects' AND field = 'principal_investigator_name';

-- document_number: hidden from the form per request. Still used by the
-- manufacturing_operations view (20260618000012), which reads the column
-- directly and is unaffected by this Directus-only UI flag.
UPDATE directus_fields SET hidden = true
WHERE collection = 'projects' AND field = 'document_number';

-- migrate:down
DELETE FROM directus_fields WHERE collection = 'projects' AND field = 'principal_investigator';
DELETE FROM directus_fields WHERE collection = 'projects' AND field = 'Image';
UPDATE directus_fields SET hidden = false
WHERE collection = 'projects' AND field = 'principal_investigator_name';
UPDATE directus_fields SET hidden = false
WHERE collection = 'projects' AND field = 'document_number';
