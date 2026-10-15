-- migrate:up
-- The process map's edit mode keeps drafts and templates on the server (ADR-0018; spec
-- docs/superpowers/specs/2026-10-14-process-map-edit-mode-design.md section 4.2):
--
--   * d1_private.process_drafts: a person's unfinished build (the DraftBody JSON of spec 5.1), named, several per
--     person, private to its owner, deleted once it is created. Saved automatically while they work, so the row
--     takes many small updates; the endpoint does the optimistic-concurrency check (UPDATE ... WHERE version = ?)
--     and sets updated_at itself.
--   * d1_private.process_templates: saved prefilled fields for a new operation or test, in the three scopes of
--     saved views: private (the creator), role (everyone with that account role), global (everyone).
--
-- Both stay in d1_private (migration 141), outside the Directus schema scan, with no Directus collection, no
-- permissions and no audit trigger, and are reached only through the d1-build endpoint (the d1-usage pattern, migrations
-- 163 and 170): this is private scratch state, not lab data. The schema's REVOKE ALL FROM PUBLIC keeps the Ask-DB role
-- out. A person's drafts go with their login (ON DELETE CASCADE); so do their templates; a role template goes with its role.
SET LOCAL lock_timeout = '10s';

CREATE TABLE d1_private.process_drafts (
    draft_id   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID        NOT NULL REFERENCES directus_users (id) ON DELETE CASCADE,
    name       TEXT        NOT NULL,
    body       JSONB       NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    version    INTEGER     NOT NULL DEFAULT 1,
    CONSTRAINT process_drafts_name_check CHECK (length(btrim(name)) > 0),
    CONSTRAINT process_drafts_body_check CHECK (jsonb_typeof(body) = 'object')
);

CREATE INDEX idx_process_drafts_user_updated ON d1_private.process_drafts (user_id, updated_at DESC);

CREATE TABLE d1_private.process_templates (
    template_id UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID        NOT NULL REFERENCES directus_users (id) ON DELETE CASCADE,
    scope       TEXT        NOT NULL,
    role_id     UUID        REFERENCES directus_roles (id) ON DELETE CASCADE,
    name        TEXT        NOT NULL,
    collection  TEXT        NOT NULL,
    values      JSONB       NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    version     INTEGER     NOT NULL DEFAULT 1,
    CONSTRAINT process_templates_scope_check CHECK (scope IN ('private', 'role', 'global')),
    CONSTRAINT process_templates_role_scope_check CHECK ((scope = 'role') = (role_id IS NOT NULL)),
    CONSTRAINT process_templates_collection_check CHECK (collection IN ('manufacturing_operations', 'test_sessions')),
    CONSTRAINT process_templates_name_check CHECK (length(btrim(name)) > 0),
    CONSTRAINT process_templates_values_check CHECK (jsonb_typeof(values) = 'object')
);

CREATE INDEX idx_process_templates_user_updated ON d1_private.process_templates (user_id, updated_at DESC);
CREATE INDEX idx_process_templates_scope_role ON d1_private.process_templates (scope, role_id);

COMMENT ON TABLE d1_private.process_drafts IS 'A person''s unfinished process-map build (edit mode): the DraftBody JSON, named, several per person, private to the owner, deleted when it is created (migration 190, ADR-0018). Read and written only by the d1-build endpoint, never through the items API (d1_private is outside the Directus schema scan). Private scratch data: no audit trigger; the endpoint does the version check.';
COMMENT ON COLUMN d1_private.process_drafts.draft_id IS 'Primary key.';
COMMENT ON COLUMN d1_private.process_drafts.user_id IS 'The directus_users.id of the owner. Only the owner can see or change the draft. The draft goes with the login (ON DELETE CASCADE).';
COMMENT ON COLUMN d1_private.process_drafts.name IS 'The draft''s name; the client defaults it to "<first sample code> · <date>" and lets the owner rename it.';
COMMENT ON COLUMN d1_private.process_drafts.body IS 'DraftBody, version 1 (packages/d1-ui/src/build/types.ts): {v, projectId, campaignId, items, wires, positions}. Validated by the d1-build endpoint on every save.';
COMMENT ON COLUMN d1_private.process_drafts.created_at IS 'When the draft was started.';
COMMENT ON COLUMN d1_private.process_drafts.updated_at IS 'When the draft was last saved. Set by the endpoint on every write.';
COMMENT ON COLUMN d1_private.process_drafts.version IS 'Optimistic-concurrency counter. A save must name the version it was made against; the endpoint writes version + 1 and answers 409 on a mismatch (another tab saved first).';

COMMENT ON TABLE d1_private.process_templates IS 'A saved set of prefilled fields for a new operation or test on the process map (edit mode), with the three scopes of saved views: private (its creator), role (everyone with that account role), global (everyone) (migration 190, ADR-0018). Read and written only by the d1-build endpoint. Private convenience data: no audit trigger.';
COMMENT ON COLUMN d1_private.process_templates.template_id IS 'Primary key.';
COMMENT ON COLUMN d1_private.process_templates.user_id IS 'The directus_users.id of the creator; only they (or an administrator) can edit or delete the template. The template goes with the login (ON DELETE CASCADE).';
COMMENT ON COLUMN d1_private.process_templates.scope IS 'Who can use the template: private (the creator), role (callers whose account role is role_id), global (everyone).';
COMMENT ON COLUMN d1_private.process_templates.role_id IS 'The directus_roles.id the template is shared with; set exactly when scope = role. The template goes with the role (ON DELETE CASCADE).';
COMMENT ON COLUMN d1_private.process_templates.name IS 'The template''s name as shown in the socket menu and the Templates shelf.';
COMMENT ON COLUMN d1_private.process_templates.collection IS 'What the template makes: manufacturing_operations or test_sessions. Templates hold operations and tests only.';
COMMENT ON COLUMN d1_private.process_templates.values IS 'Field name to value, the prefilled fields; method_id (operations) or test_type (tests) is included. A template changes only what is made from it from then on.';
COMMENT ON COLUMN d1_private.process_templates.created_at IS 'When the template was saved.';
COMMENT ON COLUMN d1_private.process_templates.updated_at IS 'When the template was last edited. Set by the endpoint on every write.';
COMMENT ON COLUMN d1_private.process_templates.version IS 'Optimistic-concurrency counter, as on process_drafts: an edit must name the version it was made against.';

-- migrate:down
SET LOCAL lock_timeout = '10s';
-- Drops every saved draft and template (lossy by design: they are private scratch state with no other copy).
DROP TABLE IF EXISTS d1_private.process_templates;
DROP TABLE IF EXISTS d1_private.process_drafts;
