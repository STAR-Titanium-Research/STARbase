-- migrate:up
-- Review finding 4.9: the audit actor can be lost for writes that come through the Directus API.
--
-- The actor-identity hook sets d1.actor_identity with set_config(..., true) from an items.* filter
-- hook. That is transaction-local, so it only reaches audit_trigger_function() if the hook runs on
-- the SAME transaction as the write. Directus passes `database: trx` to the create filter, but for
-- update and delete it emits the filter before it opens the write's transaction and passes its root
-- connection pool instead (not verifiable here: Directus' API source is not in the repo or in
-- node_modules; see the review report). On the pool the set_config lands in an autocommit
-- statement on some other connection and is gone before the UPDATE runs, so PATCH/DELETE through
-- the API were attributed to NULL.
--
-- Directus does, in the write's own transaction, insert a directus_activity row per item written
-- (collection, item, "user"), after the item itself. This migration uses that as a fallback that
-- does not depend on which connection the hook saw:
--   * audit_log_actors  (log_id -> actor_identity) records the actor for audit rows that carry none.
--     audit_logs itself stays untouched and append-only (its UPDATE rule still discards edits).
--   * an AFTER INSERT trigger on directus_activity attributes EVERY audit row of the same transaction
--     that has no actor yet (event_timestamp = transaction_timestamp(), which is what audit_logs
--     stamps by default) to the activity row's user. A Directus request is one transaction with one
--     actor, so this also covers rows that other triggers wrote in it and that Directus has no
--     activity row for: the children of a box intake (migration 125), the cascade of an owner change
--     (124), the prep_steps copied from a recipe (129). Matching on (collection, item) would have
--     missed them. A GUC-supplied actor always wins: only rows with actor_identity IS NULL are
--     attributed, and the first attribution of a row stands (ON CONFLICT DO NOTHING). Audit rows
--     written after the activity row, in the same transaction, are not covered.
--   * v_audit_logs_with_actor is audit_logs with actor_identity = COALESCE(logged actor, recorded
--     actor). Readers that want "who did this" should use it.
-- audit_log_actors is part of the audit mechanism itself, like audit_logs: it carries no OCC or
-- audit trigger of its own.
-- Writes that bypass Directus (plugins, scripts, psql) are unaffected: they still set
-- d1.actor_identity themselves (docs/api-contract.md section 8.4).
--
-- The trigger is created only when directus_activity exists: it is a Directus-managed table, and on
-- CI's bare Postgres it is not one of the stubs. It is created inside an exception guard so that a
-- deployment where the migration user does not own the table still migrates; the NOTICE says so.
-- If Directus ever drops and recreates directus_activity (a major upgrade), re-run the CREATE TRIGGER
-- below. The trigger's lookup (audit rows of this transaction without an actor) and the common
-- "history of this record" query are served by indexes on audit_logs that migrations 130 and 131 build
-- CONCURRENTLY, so that building them does not block audited writes; this trigger works without
-- them, only slower, until they have run.

CREATE TABLE audit_log_actors (
    log_id          BIGINT      NOT NULL,
    actor_identity  TEXT        NOT NULL,
    source          TEXT        NOT NULL DEFAULT 'directus_activity',
    recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT audit_log_actors_pkey PRIMARY KEY (log_id)
);
-- log_id deliberately has no FOREIGN KEY to audit_logs: audit_logs rows can never be deleted or
-- updated, so the reference cannot dangle, and a foreign key would make Postgres reject TRUNCATE
-- audit_logs before the audit_logs_no_truncate guard (20261003000120) gets to say why.

COMMENT ON TABLE audit_log_actors IS
    'Actor for audit_logs rows whose actor_identity is NULL, filled from directus_activity when a write '
    'came through the Directus API but the actor-identity hook could not reach the write''s transaction. '
    'audit_logs is append-only, so the actor lives here; read both through v_audit_logs_with_actor.';
COMMENT ON COLUMN audit_log_actors.log_id IS 'The audit_logs row this actor belongs to.';
COMMENT ON COLUMN audit_log_actors.actor_identity IS
    'Directus user id of the account that made the change, or ''public'' for an unauthenticated write.';
COMMENT ON COLUMN audit_log_actors.source IS 'Where the actor was read from (directus_activity).';
COMMENT ON COLUMN audit_log_actors.recorded_at IS 'When the attribution was recorded.';

CREATE FUNCTION audit_attribute_directus_activity() RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public
AS $$
BEGIN
    INSERT INTO public.audit_log_actors (log_id, actor_identity)
    SELECT a.log_id, COALESCE(NEW."user"::text, 'public')
    FROM   public.audit_logs a
    WHERE  a.actor_identity IS NULL
      AND  a.event_timestamp = pg_catalog.transaction_timestamp()
    ON CONFLICT (log_id) DO NOTHING;
    RETURN NULL;
END;
$$;

COMMENT ON FUNCTION audit_attribute_directus_activity() IS
    'AFTER INSERT trigger body for directus_activity: attributes every audit_logs row written in this '
    'transaction that carries no actor (including rows written by other triggers, such as intake and '
    'cascade children) to the Directus user of the activity row (review 4.9).';

DO $$
BEGIN
    IF to_regclass('public.directus_activity') IS NULL THEN
        RAISE NOTICE 'directus_activity not found; audit actor fallback trigger not installed';
    ELSIF (SELECT count(*) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'directus_activity'
             AND column_name IN ('collection', 'item', 'user')) < 3 THEN
        RAISE NOTICE 'directus_activity lacks collection/item/user; audit actor fallback trigger not installed';
    ELSE
        BEGIN
            CREATE TRIGGER audit_actor_from_activity
                AFTER INSERT ON directus_activity
                FOR EACH ROW EXECUTE FUNCTION audit_attribute_directus_activity();
        EXCEPTION WHEN insufficient_privilege THEN
            RAISE NOTICE 'not the owner of directus_activity; create trigger audit_actor_from_activity by hand';
        END;
    END IF;
END
$$;

CREATE VIEW v_audit_logs_with_actor AS
SELECT l.log_id,
       l.event_timestamp,
       l.table_name,
       l.record_id,
       l.action_type,
       l.row_before,
       l.row_after,
       l.changed_fields,
       COALESCE(l.actor_identity, a.actor_identity) AS actor_identity,
       (l.actor_identity IS NULL AND a.actor_identity IS NOT NULL) AS actor_from_directus_activity
FROM   audit_logs l
LEFT   JOIN audit_log_actors a ON a.log_id = l.log_id;

COMMENT ON VIEW v_audit_logs_with_actor IS
    'audit_logs with the actor filled in: the logged actor_identity, else the one recorded from '
    'directus_activity (audit_log_actors). Use this to ask who made a change.';

-- migrate:down
-- audit_log_actors is the only place those actors are recorded (audit_logs is append-only and its
-- rows stay actor-less), so dropping a populated table loses audit information for good. The
-- rollback therefore stops with an error while the table has rows, unless the loss is accepted
-- explicitly by setting d1.allow_audit_actor_loss to 'on' for the session, e.g.
--     PGOPTIONS='-c d1.allow_audit_actor_loss=on' dbmate down
-- (or `SET d1.allow_audit_actor_loss = on;` in a psql session that runs this section). An empty
-- table, as after CI's purge before the full rollback, needs no override.
DO $$
BEGIN
    IF to_regclass('public.audit_log_actors') IS NOT NULL
       AND COALESCE(pg_catalog.current_setting('d1.allow_audit_actor_loss', true), '') <> 'on'
       AND EXISTS (SELECT 1 FROM public.audit_log_actors)
    THEN
        RAISE EXCEPTION 'audit_log_actors holds % row(s) that exist nowhere else; rolling back migration 20261003000128 would delete them',
            (SELECT count(*) FROM public.audit_log_actors)
            USING HINT = 'Export them first, or accept the loss with: SET d1.allow_audit_actor_loss = on (PGOPTIONS=''-c d1.allow_audit_actor_loss=on'' for dbmate).';
    END IF;
END
$$;
DROP VIEW IF EXISTS v_audit_logs_with_actor;
DO $$
BEGIN
    IF to_regclass('public.directus_activity') IS NOT NULL THEN
        DROP TRIGGER IF EXISTS audit_actor_from_activity ON directus_activity;
    END IF;
END
$$;
DROP FUNCTION IF EXISTS audit_attribute_directus_activity();
DROP TABLE IF EXISTS audit_log_actors;
