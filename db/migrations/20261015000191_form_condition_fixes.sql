-- migrate:up
-- Form condition fixes: three rules of migration 20261014000174 (form layout) do not do in Directus 11 what their
-- names say, because Directus's `_empty` matches only the empty string, never null, and `_nempty` matches null:
--
--   * "Hide until saved once" on the Related records group of samples, operations and tests used
--     `short_id {_empty: true}`. A record that has not been saved has a NULL short_id in the form, so the rule never fired
--     and the group showed on a new record. It is now `{_or: [short_id {_null: true}, short_id {_empty: true}]}`: a null
--     short_id (a new record) or an empty one both hide the group.
--   * "show when it has a value" on six operation fields (the two legacy machining fields, file_storage_pointer,
--     capture_software, capture_frequency_khz, nc_program_text) used `{field: {_nempty: true}}`, which is true for a NULL
--     and so showed every empty field. Each is now `{_and: [{field: {_nnull: true}}, {field: {_neq: ''}}]}` (not null,
--     and not the empty string). The coordinator named two of the six; the other four had the same flaw.
--
-- Only those nine rows are touched, and only the rule text inside their conditions (the rule names, the hidden / readonly /
-- required flags and any other condition stay as they are). The jsonb text form is what is rewritten, so the stored JSON
-- is re-serialised by Postgres (same meaning). The down section puts the 174 rules back; it restores them by meaning, not
-- by the byte, and does not touch a row whose rule it did not write.
-- Directus caches schema and permissions: restart Directus after applying.
SET LOCAL lock_timeout = '10s';

UPDATE directus_fields
SET conditions = replace(
        conditions::jsonb::text,
        '{"_and": [{"short_id": {"_empty": true}}]}',
        '{"_or": [{"short_id": {"_null": true}}, {"short_id": {"_empty": true}}]}'
    )::json
WHERE field = 'grp_related'
  AND collection IN ('physical_samples', 'manufacturing_operations', 'test_sessions')
  AND conditions IS NOT NULL;

UPDATE directus_fields
SET conditions = regexp_replace(
        conditions::jsonb::text,
        '\{"([a-z_]+)": \{"_nempty": true\}\}',
        '{"\1": {"_nnull": true}}, {"\1": {"_neq": ""}}',
        'g'
    )::json
WHERE collection = 'manufacturing_operations'
  AND field IN (
      'machining_legacy_insert_edge_id', 'machining_legacy_machining_uid', 'file_storage_pointer', 'capture_software',
      'capture_frequency_khz', 'nc_program_text'
  )
  AND conditions IS NOT NULL;

-- migrate:down
SET LOCAL lock_timeout = '10s';

UPDATE directus_fields
SET conditions = replace(
        conditions::jsonb::text,
        '{"_or": [{"short_id": {"_null": true}}, {"short_id": {"_empty": true}}]}',
        '{"_and": [{"short_id": {"_empty": true}}]}'
    )::json
WHERE field = 'grp_related'
  AND collection IN ('physical_samples', 'manufacturing_operations', 'test_sessions')
  AND conditions IS NOT NULL;

UPDATE directus_fields
SET conditions = regexp_replace(
        conditions::jsonb::text,
        '\{"([a-z_]+)": \{"_nnull": true\}\}, \{"\1": \{"_neq": ""\}\}',
        '{"\1": {"_nempty": true}}',
        'g'
    )::json
WHERE collection = 'manufacturing_operations'
  AND field IN (
      'machining_legacy_insert_edge_id', 'machining_legacy_machining_uid', 'file_storage_pointer', 'capture_software',
      'capture_frequency_khz', 'nc_program_text'
  )
  AND conditions IS NOT NULL;
