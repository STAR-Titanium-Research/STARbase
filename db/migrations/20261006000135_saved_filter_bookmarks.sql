-- migrate:up
-- D12: saved filters for the everyday "show me my ..." questions, as global Directus bookmarks
-- (directus_presets with bookmark set and "user" and role NULL, so every user sees them in the
-- collection's sidebar). The existing Machining / FAST / Samples bookmarks are untouched.
--
-- "Mine" resolves through the person record: owner_person_id -> people.user_id = $CURRENT_USER.
-- The legacy `owner` column (a direct Directus-user uuid, hidden since the people unification,
-- migration 062) is no longer what the owner picker writes, so it is not used.
--
--   manufacturing_operations  My operations            owner's people.user_id = $CURRENT_USER
--                             FAST runs, last 7 days   FAST method (method_code MF, as the FAST
--                                                      bookmark) and operation_date in the last 7 days
--                             Missing outcome          outcome_notes empty (the only outcome column)
--   test_sessions             Failed                   status = failed
--                             Needs analysis           status = processed (the pipeline has finished
--                                                      and no analysis has started: the next states
--                                                      are analysing then analysed; see migration 013)
--   physical_samples          My samples               owner's people.user_id = $CURRENT_USER
--                             No location              location empty (NULL or '')
--
-- Idempotent: a bookmark that already exists (same collection and name) is left alone, so a
-- filter or columns curated in the Directus UI survive a re-run; scripts/configure_directus.sql
-- seeds the same rows and its bookmark clean-up spares these names. On CI the directus_presets
-- stub starts empty, so the rows are inserted there too.

INSERT INTO directus_presets (bookmark, "user", role, collection, filter, layout, layout_query, icon, color)
SELECT v.bookmark, NULL, NULL, v.collection, v.filter::json, 'tabular', v.layout_query::json, v.icon, v.color
FROM (VALUES
    ('manufacturing_operations', 'My operations',
     '{"_and":[{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}]}',
     '{"tabular":{"sort":["-operation_date"]}}', 'person', '#2196F3'),
    ('manufacturing_operations', 'FAST runs, last 7 days',
     '{"_and":[{"method_id":{"method_code":{"_eq":"MF"}}},{"operation_date":{"_gte":"$NOW(-7 days)"}}]}',
     '{"tabular":{"sort":["-operation_date"]}}', 'date_range', '#F44336'),
    ('manufacturing_operations', 'Missing outcome',
     '{"_and":[{"outcome_notes":{"_empty":true}}]}',
     '{"tabular":{"sort":["pass_code"]}}', 'rule', '#FFC107'),
    ('test_sessions', 'Failed',
     '{"_and":[{"status":{"_eq":"failed"}}]}',
     '{"tabular":{"sort":["-session_date"]}}', 'error', '#F44336'),
    ('test_sessions', 'Needs analysis',
     '{"_and":[{"status":{"_eq":"processed"}}]}',
     '{"tabular":{"sort":["-session_date"]}}', 'query_stats', '#FF9800'),
    ('physical_samples', 'My samples',
     '{"_and":[{"owner_person_id":{"user_id":{"_eq":"$CURRENT_USER"}}}]}',
     '{"tabular":{"sort":["sample_code"]}}', 'person', '#2196F3'),
    ('physical_samples', 'No location',
     '{"_and":[{"location":{"_empty":true}}]}',
     '{"tabular":{"sort":["sample_code"]}}', 'location_off', '#9E9E9E')
) AS v(collection, bookmark, filter, layout_query, icon, color)
WHERE NOT EXISTS (
    SELECT 1 FROM directus_presets AS p
    WHERE p.collection = v.collection AND p.bookmark = v.bookmark
      AND p."user" IS NULL AND p.role IS NULL
);

-- migrate:down
-- Matches on collection + name, so a copy of one of these bookmarks curated in the UI goes too.
DELETE FROM directus_presets
WHERE "user" IS NULL AND role IS NULL
  AND (collection, bookmark) IN (
      ('manufacturing_operations', 'My operations'),
      ('manufacturing_operations', 'FAST runs, last 7 days'),
      ('manufacturing_operations', 'Missing outcome'),
      ('test_sessions', 'Failed'),
      ('test_sessions', 'Needs analysis'),
      ('physical_samples', 'My samples'),
      ('physical_samples', 'No location')
  );
