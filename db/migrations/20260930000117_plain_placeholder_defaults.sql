-- migrate:up
-- Directus's new-item form prefills a field with the raw text of its column's
-- DEFAULT expression (information_schema.column_default), rather than
-- evaluating it — so tool_box_code's existing '('TMP-'::text || ...)' default
-- (predates this migration; see 20260621000022) showed up literally as
-- "('TMP-" in the Box ID field, and the equivalent defaults added in
-- 20260930000114 (insert_code, edge_code, project_code, campaign_code) have
-- the same problem. edge_identifier already used a plain '' default and
-- never leaked anything, which is the model this migration copies: give
-- every one of these columns a trivial empty-string default (still enough
-- for Directus to treat the field as non-required, and invisible if it ever
-- gets prefilled) and let the existing BEFORE INSERT triggers — which
-- already treat NULL/'' as "not set yet" — do the real code generation.

ALTER TABLE tool_boxes      ALTER COLUMN tool_box_code SET DEFAULT '';
ALTER TABLE cutting_inserts ALTER COLUMN insert_code   SET DEFAULT '';
ALTER TABLE insert_edges    ALTER COLUMN edge_code      SET DEFAULT '';
ALTER TABLE projects        ALTER COLUMN project_code   SET DEFAULT '';
ALTER TABLE campaigns       ALTER COLUMN campaign_code  SET DEFAULT '';

-- migrate:down
ALTER TABLE tool_boxes      ALTER COLUMN tool_box_code SET DEFAULT ('TMP-'::text || (uuid_generate_v4())::text);
ALTER TABLE cutting_inserts ALTER COLUMN insert_code   SET DEFAULT ('TMP-'::text || (uuid_generate_v4())::text);
ALTER TABLE insert_edges    ALTER COLUMN edge_code      SET DEFAULT ('TMP-'::text || (uuid_generate_v4())::text);
ALTER TABLE projects        ALTER COLUMN project_code   SET DEFAULT next_project_code();
ALTER TABLE campaigns       ALTER COLUMN campaign_code  SET DEFAULT next_campaign_code();
