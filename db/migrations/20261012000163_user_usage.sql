-- migrate:up
-- Per-user "Frequently used" scores for the Explorer Home panel
-- (spec docs/superpowers/specs/2026-10-12-explorer-frequently-used-design.md).
--
-- Both tables live in d1_private (created by migration 141), so Directus, which only scans `public`,
-- never lists them as collections: the rows are reachable only through the d1-usage endpoint
-- (core/extensions/d1-usage), which touches nothing but the caller's own rows. The endpoint decays
-- scores on write and on read (half-life 10 days), so there is no job and no audit trigger: this is
-- derived, per-user convenience data.
SET LOCAL lock_timeout = '10s';

CREATE TABLE d1_private.user_usage (
    user_id   UUID        NOT NULL REFERENCES directus_users (id) ON DELETE CASCADE,
    kind      TEXT        NOT NULL CHECK (kind IN ('page', 'record')),
    target    TEXT        NOT NULL,
    score     FLOAT8      NOT NULL DEFAULT 0,
    last_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    pinned    BOOLEAN     NOT NULL DEFAULT FALSE,
    hidden_at TIMESTAMPTZ,
    PRIMARY KEY (user_id, kind, target)
);

-- The PK already starts with (user_id, kind), so this is redundant for lookups; it is kept as
-- specified for the "all of one user's rows of one kind" read the endpoint does.
CREATE INDEX user_usage_user_kind_idx ON d1_private.user_usage (user_id, kind);

CREATE TABLE d1_private.user_usage_cursor (
    user_id          UUID PRIMARY KEY REFERENCES directus_users (id) ON DELETE CASCADE,
    last_activity_id INTEGER NOT NULL
);

COMMENT ON TABLE d1_private.user_usage IS
    'Per-user use scores behind the Explorer Home "Frequently used" panel (migration 163). One row per user and thing used. Read and written only by the d1-usage endpoint, never through the items API (d1_private is outside the Directus schema scan). Derived data: no audit trigger.';
COMMENT ON COLUMN d1_private.user_usage.user_id IS 'The directus_users.id whose list this is. Rows go with the user (ON DELETE CASCADE).';
COMMENT ON COLUMN d1_private.user_usage.kind IS 'page: an Explorer page or quick action. record: one record of the seven record collections.';
COMMENT ON COLUMN d1_private.user_usage.target IS 'page: a route key such as samples, or action:log-operation. record: <collection>:<primary key>, e.g. physical_samples:<uuid>.';
COMMENT ON COLUMN d1_private.user_usage.score IS 'The score as of last_at: each use adds a weight (visit 1, create/update 3, quick action 3) after the old score has faded with a half-life of 10 days. The endpoint fades it again to now when it reads.';
COMMENT ON COLUMN d1_private.user_usage.last_at IS 'Time of the latest use that counted; the moment score is stated at.';
COMMENT ON COLUMN d1_private.user_usage.pinned IS 'Pinned by the user: listed first and kept by "Clear my history".';
COMMENT ON COLUMN d1_private.user_usage.hidden_at IS 'When the user hid it with the x button. Hidden until last_at is later than this (used again); NULL when never hidden.';
COMMENT ON INDEX d1_private.user_usage_user_kind_idx IS 'All of one user''s rows of one kind (the Home panel read).';
COMMENT ON TABLE d1_private.user_usage_cursor IS 'How far the d1-usage endpoint has read each user''s directus_activity rows (migration 163), so a create or update is counted once.';
COMMENT ON COLUMN d1_private.user_usage_cursor.user_id IS 'The directus_users.id. Rows go with the user (ON DELETE CASCADE).';
COMMENT ON COLUMN d1_private.user_usage_cursor.last_activity_id IS 'The highest directus_activity.id already folded into user_usage for this user. A new user starts at the newest activity older than 30 days.';

-- migrate:down
SET LOCAL lock_timeout = '10s';
DROP TABLE IF EXISTS d1_private.user_usage_cursor;
DROP TABLE IF EXISTS d1_private.user_usage;
