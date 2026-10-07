// Directus hook: actor-identity
//
// The Postgres audit trigger (db/migrations/...0009_audit.sql) records who made each change by
// reading current_setting('d1.actor_identity', TRUE). This hook sets that GUC for writes made
// through the Directus API.
//
// set_config(..., true) is transaction-local, so it only helps when it runs on the SAME database
// transaction as the write. Directus gives a filter hook `context.database`; that is the write's
// transaction for item creates, but for updates and deletes Directus emits the filter before it
// opens the write's transaction and hands the hook its root connection pool instead (review
// finding 4.9; Directus' source is not in this repo, so this is from knowledge of Directus 11's
// ItemsService, not verified against a live stack -- the safety net below makes the answer matter
// less). On the pool, set_config runs in its own autocommit statement and is gone before the write.
//
// So the hook:
//   * sets the GUC only when context.database really is a transaction (knex marks transactions with
//     `isTransaction`, which Directus' own `transaction()` helper also checks), and
//   * logs once when it is handed a pool, instead of pretending the actor was set.
// For writes where the GUC cannot be set, migration 20261003000128 attributes the audit rows from
// the directus_activity rows Directus writes in the write's own transaction; read the result through
// v_audit_logs_with_actor.
//
// We use the authenticated Directus user id (machine tokens each have their own user, e.g. the
// Rig_1 sampling node) rather than a client-supplied header: it cannot be spoofed by the caller and
// is always present for authenticated writes.

export default ({ filter }, { logger } = {}) => {
  let warned = false;

  const setActor = async (payload, _meta, context) => {
    // accountability is null for unauthenticated/public requests.
    const actor = context?.accountability?.user || "public";
    const db = context?.database;
    if (db?.isTransaction) {
      await db.raw("SELECT set_config('d1.actor_identity', ?, true)", [
        String(actor),
      ]);
    } else if (db && !warned) {
      warned = true;
      logger?.warn?.(
        "actor-identity: Directus passed a connection pool, not the write's transaction, to an " +
          "items.* filter; the audit actor for such writes comes from directus_activity " +
          "(see v_audit_logs_with_actor).",
      );
    }
    // Filter hooks MUST return the (first) payload argument unchanged.
    return payload;
  };

  filter("items.create", setActor);
  filter("items.update", setActor);
  filter("items.delete", setActor);
};
