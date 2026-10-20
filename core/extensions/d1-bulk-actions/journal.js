// d1-bulk-actions: reading the journal (bulk_actions, bulk_action_rows). Administrators see every action, everyone else only their own, and each
// row's before and after snapshots (which can hold values and access lists the actor may not see) are for administrators only.

import { HttpError, isBlank, isUuid, iso, parseJson, sameUser } from './rules.js';

const LIST_DEFAULT = 50;
const LIST_MAX = 200;

export function makeJournal({ database }) {
  // An action the caller may see (administrators: any; everyone else: their own), else 404. `lockRow` holds the row for the transaction.
  async function visibleAction(db, { req, acc, admin }, lockRow = false) {
    const id = req.params?.action_id;
    if (!isUuid(id)) throw new HttpError(400, 'INVALID_PAYLOAD', 'The action id is not valid.');
    const query = db('bulk_actions').where('action_id', id);
    const action = await (lockRow ? query.forUpdate() : query).first();
    if (!action || (!admin && !sameUser(action.actor_user, acc.user))) throw new HttpError(404, 'NOT_FOUND', 'That bulk action does not exist, or you cannot see it.');
    return action;
  }

  async function actorNames(actions) {
    const users = [...new Set(actions.map((a) => String(a.actor_user)))];
    const names = new Map();
    if (!users.length) return names;
    for (const p of await database('people').whereIn('user_id', users).select('user_id', 'full_name')) if (!isBlank(p.full_name)) names.set(String(p.user_id), String(p.full_name).trim());
    const missing = users.filter((u) => !names.has(u));
    if (missing.length) {
      for (const u of await database('directus_users').whereIn('id', missing).select('id', 'first_name', 'last_name', 'email')) {
        const name = [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || u.email;
        if (!isBlank(name)) names.set(String(u.id), String(name));
      }
    }
    return names;
  }

  const actionOut = (a, names) => ({
    action_id: a.action_id, actor_user: a.actor_user, actor_name: names.get(String(a.actor_user)) ?? null, collection: a.collection, kind: a.kind,
    params: parseJson(a.params), created_at: iso(a.created_at), undo_until: iso(a.undo_until), state: a.state, revert_of: a.revert_of ?? null,
    mail_state: a.mail_state, n_applied: a.n_applied ?? 0, n_skipped: a.n_skipped ?? 0, n_failed: a.n_failed ?? 0,
  });

  // GET / and GET /:action_id, registered on `router` behind the endpoint's `route` wrapper.
  function mountReads(router, route) {
    router.get('/', route(async ({ req, res, acc, admin }) => {
      const limit = Math.min(LIST_MAX, Math.max(1, Number.parseInt(req.query?.limit, 10) || LIST_DEFAULT));
      const offset = Math.max(0, Number.parseInt(req.query?.offset, 10) || 0);
      let q = database('bulk_actions');
      if (!admin) q = q.where('actor_user', String(acc.user));
      const rows = await q.orderBy('created_at', 'desc').limit(limit + 1).offset(offset).select();
      const page = rows.slice(0, limit);
      const names = await actorNames(page);
      res.json({ actions: page.map((a) => actionOut(a, names)), limit, offset, has_more: rows.length > limit });
    }));

    router.get('/:action_id', route(async (c) => {
      const { res, admin } = c;
      const action = await visibleAction(database, c);
      const names = await actorNames([action]);
      const rows = await database('bulk_action_rows').where('action_id', action.action_id).select();
      res.json({
        action: actionOut(action, names),
        rows: rows
          .map((r) => ({
            record_id: r.record_id, record_code: r.record_code ?? null, outcome: r.outcome, reason: r.reason ?? null,
            before: admin ? parseJson(r.before) : null, after: admin ? parseJson(r.after) : null, revert_outcome: r.revert_outcome ?? null, revert_reason: r.revert_reason ?? null,
          }))
          .sort((a, b) => String(a.record_code ?? '').localeCompare(String(b.record_code ?? '')) || a.record_id.localeCompare(b.record_id)),
      });
    }));
  }

  return { visibleAction, mountReads };
}
