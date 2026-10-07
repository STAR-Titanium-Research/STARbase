-- migrate:up
-- Put the "Generate PDF" button (d1-report-button interface) on the sample, operation and
-- test forms. The extension and the /d1-report endpoint were shipped, but no directus_fields
-- row ever placed the button, so it never appeared on a record. The field is a presentation
-- alias (no column), sorted first so it sits at the top of the form. The report type is not
-- stored: the interface picks it from the collection (its 'auto' setting). Idempotent: a
-- button an admin already added by hand under the same field name is left alone.
INSERT INTO directus_fields (collection, field, special, interface, options, sort, translations)
SELECT v.collection, 'report_button', 'alias,no-data', 'd1-report-button',
       json_build_object('label', 'Generate ' || v.kind || ' PDF'), 0,
       '[{"language":"en-US","translation":"Report"}]'::json
FROM (VALUES
    ('physical_samples', 'sample'),
    ('manufacturing_operations', 'operation'),
    ('test_sessions', 'test')
) v(collection, kind)
WHERE NOT EXISTS (
    SELECT 1 FROM directus_fields f WHERE f.collection = v.collection AND f.field = 'report_button'
);

-- migrate:down
-- Only the rows the up created (matched by their generated label); a hand-made button that the
-- up skipped is left alone.
DELETE FROM directus_fields
WHERE field = 'report_button'
  AND interface = 'd1-report-button'
  AND collection IN ('physical_samples', 'manufacturing_operations', 'test_sessions')
  AND options::jsonb ->> 'label' IN ('Generate sample PDF', 'Generate operation PDF', 'Generate test PDF');
