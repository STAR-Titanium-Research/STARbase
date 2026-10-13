-- migrate:up
-- Explorer sidebar B2: ordered pins across every kind, saved-view pins and a per-user preferences row
-- (spec docs/superpowers/specs/2026-10-13-explorer-sidebar-b2-design.md, "Data"; builds on migration 163,
-- spec 2026-10-12-explorer-frequently-used-design.md).
--
-- user_usage gets a third kind, `view` (a saved view: a directus_presets bookmark, target = the preset id as
-- text), and a pin_order column that numbers a person's pins, gapless from 0, across all kinds. The U1 pins
-- that already exist have no order yet, so they are numbered here by last_at (newest first) per person: U1's
-- Home listed pins highest score first, so the most recently used pin stays first, and a new pin goes after
-- them. user_prefs holds one row per person (whether the default pins were given, and the sidebar / theme
-- preferences).
--
-- Both tables stay in d1_private (migration 141), outside the Directus schema scan, reached only through the
-- d1-usage endpoint, with no audit trigger: this is derived, per-user convenience data (as in migration 163).
SET LOCAL lock_timeout = '10s';

-- The inline CHECK of migration 163 was named user_usage_kind_check by Postgres.
ALTER TABLE d1_private.user_usage
    DROP CONSTRAINT user_usage_kind_check,
    ADD CONSTRAINT user_usage_kind_check CHECK (kind IN ('page', 'record', 'view')),
    ADD COLUMN pin_order INTEGER;

-- Back-fill: number each person's existing pins by last_at, newest first, from 0. The kind and target
-- tie-break keeps the result deterministic when two pins share a timestamp. Unpinned rows stay NULL.
UPDATE d1_private.user_usage AS u
   SET pin_order = n.pin_order
  FROM (
      SELECT user_id, kind, target,
             (ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY last_at DESC, kind ASC, target ASC) - 1)::INTEGER AS pin_order
        FROM d1_private.user_usage
       WHERE pinned
  ) AS n
 WHERE u.user_id = n.user_id AND u.kind = n.kind AND u.target = n.target;

CREATE TABLE d1_private.user_prefs (
    user_id     UUID        PRIMARY KEY REFERENCES directus_users (id) ON DELETE CASCADE,
    pins_seeded BOOLEAN     NOT NULL DEFAULT FALSE,
    prefs       JSONB       NOT NULL DEFAULT '{}',
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON COLUMN d1_private.user_usage.kind IS 'page: an Explorer page or quick action. record: one record of the seven record collections. view: a saved view (a directus_presets bookmark; migration 170).';
COMMENT ON COLUMN d1_private.user_usage.target IS 'page: a route key such as samples, or action:log-operation. record: <collection>:<primary key>, e.g. physical_samples:<uuid>. view: the directus_presets id as text, a positive integer.';
COMMENT ON COLUMN d1_private.user_usage.pin_order IS 'Position among this person''s pins, gapless from 0 across every kind (migration 170). NULL when the row is not pinned. A new pin goes last; a drop or reorder rewrites the whole order; unpinning clears it.';
COMMENT ON TABLE d1_private.user_prefs IS 'One row per person: whether the default sidebar pins were given, and their sidebar / theme preferences (migration 170). Read and written only by the d1-usage endpoint, never through the items API (d1_private is outside the Directus schema scan). Per-user convenience data: no audit trigger.';
COMMENT ON COLUMN d1_private.user_prefs.user_id IS 'The directus_users.id these preferences belong to. The row goes with the user (ON DELETE CASCADE).';
COMMENT ON COLUMN d1_private.user_prefs.pins_seeded IS 'TRUE once the default pins have been given to this person (once only, so a pin they remove does not come back).';
COMMENT ON COLUMN d1_private.user_prefs.prefs IS 'Sidebar and theme preferences as JSON: {sidebarCollapsed, autoCollapse, theme}. The endpoint validates the keys and types and rejects unknown keys.';
COMMENT ON COLUMN d1_private.user_prefs.updated_at IS 'When the preferences or pins_seeded last changed. Set by the endpoint on write.';

-- migrate:down
SET LOCAL lock_timeout = '10s';
DROP TABLE IF EXISTS d1_private.user_prefs;

-- Saved-view pins cannot exist under the old CHECK: they are deleted (lossy, and by design, since the old
-- schema has no kind for them). Page and record pins keep pinned = TRUE; only their order is lost.
DELETE FROM d1_private.user_usage WHERE kind = 'view';

ALTER TABLE d1_private.user_usage
    DROP COLUMN IF EXISTS pin_order,
    DROP CONSTRAINT user_usage_kind_check,
    ADD CONSTRAINT user_usage_kind_check CHECK (kind IN ('page', 'record'));

COMMENT ON COLUMN d1_private.user_usage.kind IS 'page: an Explorer page or quick action. record: one record of the seven record collections.';
COMMENT ON COLUMN d1_private.user_usage.target IS 'page: a route key such as samples, or action:log-operation. record: <collection>:<primary key>, e.g. physical_samples:<uuid>.';
