-- migrate:up
-- X2 (docs/reviews/2026-10-05-ux-utility-review.md): a Lab Member cannot save a cut from the Force
-- App. The save path (apps/force-app/web/src/record/workspace.ts and uploadCapture.ts) does, as the
-- signed-in user: POST /items/manufacturing_operations (already allowed), POST /files twice (the
-- capture.mat and the live cache), then POST /items/machining_force_analysis. Lab Member had no
-- directus_files permission at all and only read+update (20260911000111) on
-- machining_force_analysis, so the operation row was created and the upload then failed with 403,
-- leaving an orphan run. The Force Analysis viewer fetches each live cache with GET /assets/<id>,
-- which also needs directus_files read.
-- Grant create on both, and read on directus_files (Directus answers a file upload with the new
-- row, so create without read returns an empty body and the app cannot get the file id).
-- directus_files read is deliberately not scoped to the uploader: the viewer opens caches that
-- colleagues uploaded. No update/delete: the app never edits or removes files. fields='*' matches
-- every other Lab Member permission in this schema.

INSERT INTO directus_permissions (policy, collection, action, permissions, validation, fields)
SELECT '20000002-0000-0000-0000-000000000002', g.collection, g.action, '{}', '{}', '*'
FROM (VALUES
    ('directus_files', 'create'),
    ('directus_files', 'read'),
    ('machining_force_analysis', 'create')
) g(collection, action)
WHERE NOT EXISTS (
    SELECT 1 FROM directus_permissions p
    WHERE p.policy = '20000002-0000-0000-0000-000000000002'
      AND p.collection = g.collection AND p.action = g.action
);

-- migrate:down
DELETE FROM directus_permissions
WHERE policy = '20000002-0000-0000-0000-000000000002'
  AND ((collection = 'directus_files' AND action IN ('create', 'read'))
    OR (collection = 'machining_force_analysis' AND action = 'create'));
