// Directus endpoint: d1-people-admin  (mounted at /d1-people-admin)
//
// The data behind the admin People page (People 1, spec docs/superpowers/specs/2026-10-14-people-and-teams-design.md). Reads, and one write:
//
//   GET /d1-people-admin/people
//     -> { can_administer_accounts, roles: [{ id, name }],
//          people: [{ person_id, full_name, email, is_researcher, is_operator, active, notes, user_id,
//                     login: null | { status, role_id, role_name, last_access, email }, attention: [key] }],
//          logins_without_person: [{ user_id, email, first_name, last_name, status, role_id, role_name, last_access }] }
//   GET /d1-people-admin/attention
//     -> { items: [{ key, count }] }      (d1_private.people_attention(); zero counts omitted)
//   GET /d1-people-admin/people/:person_id/access[?list=owns|shared|investigator]
//     -> { owns, shared, investigator }   (d1_private.person_access: three counts)
//        + records: [{ collection, id, kind, code, title, level, source, granted_by, added_at }] for the asked list
//   PATCH /d1-people-admin/logins/:user_id   body { role?: uuid, status?: 'active' | 'suspended' }
//     -> { user_id, role_id, role_name, status }
//        Account administrators only (403 ACCOUNTS_ADMIN_ONLY for a Lab Admin or anyone else). The role must exist in directus_roles (400).
//        Suspending also deletes the login's rows in directus_sessions, in the same transaction. Refused with 409 LAST_ADMINISTRATOR when
//        the change would leave no active account administrator (a role change that drops the target's account-administrator status, or
//        suspending the target). The write runs in one transaction with d1.actor_identity set; the data cache is cleared after the commit
//        when CACHE_ENABLED is on (the same as d1-record-access).
//
// Who may call: /people and /attention are for administrators only (401 without a user, 403 otherwise). /access is for an
// administrator, or for the person whose login the caller is. A non-administrator sees every count, but the list leaves out a record
// they no longer read (their own readers row is missing): it is counted, not listed.
//
// can_administer_accounts: an administrator whose role is not the Lab Admin role (D1_LAB_ADMIN_ROLE_ID). An admin policy attached to
// the USER with no role (the preview's admin) is an account administrator; the Lab Admin is not.
//
// Counting rule for /attention (migration 173): login_without_person and invite_not_accepted are counted by cardinality(user_ids), every
// other key by cardinality(person_ids). Summing both arrays would count a person who has a login twice.
//
// Errors use the Directus shape { errors: [{ message, extensions: { code, source: 'd1-people-admin' } }] }.

import { COLLECTIONS } from '../d1-record-access/index.js';

const SOURCE = 'd1-people-admin';
const DEFAULT_LAB_ADMIN_ROLE_ID = '10000001-0000-0000-0000-000000000001';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LISTS = ['owns', 'shared', 'investigator'];
const CHUNK = 1000;
const STATUSES = ['active', 'suspended'];
const toBool = (v) => v === true || v === 'true' || v === 1 || v === '1';

// Keys counted by login; every other key is counted by person.
export const COUNTED_BY_LOGIN = ['login_without_person', 'invite_not_accepted'];

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const isBlank = (v) => v === undefined || v === null || v === '';
const trimmed = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const iso = (v) => {
  if (isBlank(v)) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const firstOf = (row, fields) => {
  for (const field of fields) if (!isBlank(row?.[field]) && String(row[field]).trim() !== '') return String(row[field]);
  return null;
};
const chunks = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};
const byText = (field) => (a, b) => String(a[field] ?? '').localeCompare(String(b[field] ?? ''));

// The number behind one attention item (see the counting rule above).
export function attentionCount(row) {
  const list = COUNTED_BY_LOGIN.includes(row?.key) ? row?.user_ids : row?.person_ids;
  return Array.isArray(list) ? list.length : 0;
}

// { admin, accounts } for a login. admin: one of its policies (direct, or through its role) has admin_access (the same walk as
// d1-record-access's isAdminLogin). accounts: admin, and the role is not the Lab Admin role.
export async function accountAdmin(db, userId, labAdminRoleId) {
  if (isBlank(userId)) return { admin: false, accounts: false };
  const user = await db('directus_users').where('id', userId).first('role');
  const direct = await db('directus_access').where('user', userId).select('policy');
  const viaRole = !isBlank(user?.role) ? await db('directus_access').where('role', user.role).select('policy') : [];
  const policies = [...new Set([...direct, ...viaRole].map((a) => a.policy).filter((v) => !isBlank(v)))];
  const admin = policies.length > 0 && Boolean(await db('directus_policies').whereIn('id', policies).where('admin_access', true).first('id'));
  const accounts = admin && String(user?.role ?? '') !== String(labAdminRoleId ?? '');
  return { admin, accounts };
}

export default {
  id: SOURCE,
  handler: (router, { database, logger, env, services }) => {
    const labAdminRoleId = trimmed(env?.D1_LAB_ADMIN_ROLE_ID) ?? DEFAULT_LAB_ADMIN_ROLE_ID;

    const sendError = (res, err) => {
      const known = err instanceof HttpError;
      if (!known) logger?.error?.(`${SOURCE}: ${err?.stack || err?.message || err}`);
      return res.status(known ? err.status : 500).json({
        errors: [{
          message: known ? err.message : 'Something went wrong on the server.',
          extensions: { code: known ? err.code : 'INTERNAL_SERVER_ERROR', source: SOURCE },
        }],
      });
    };
    const route = (fn) => async (req, res) => {
      try {
        const acc = req.accountability;
        if (!acc?.user) throw new HttpError(401, 'UNAUTHORIZED', 'Sign in first.');
        const caller = await accountAdmin(database, acc.user, labAdminRoleId);
        await fn({ req, res, acc, admin: acc.admin === true || caller.admin, accounts: caller.accounts });
      } catch (err) {
        return sendError(res, err);
      }
    };
    const requireAdmin = (admin) => {
      if (!admin) throw new HttpError(403, 'FORBIDDEN', 'Only an administrator can open this.');
    };

    // d1_private.people_attention() rows: { key, person_ids, user_ids }
    const attentionRows = async () => (await database.raw('SELECT key, person_ids, user_ids FROM d1_private.people_attention()'))?.rows ?? [];

    router.get('/people', route(async ({ res, admin, accounts }) => {
      requireAdmin(admin);
      const [people, users, roles, attention] = await Promise.all([
        database('people').select('person_id', 'full_name', 'email', 'is_researcher', 'is_operator', 'active', 'notes', 'user_id'),
        database('directus_users').select('id', 'email', 'first_name', 'last_name', 'status', 'role', 'last_access'),
        database('directus_roles').select('id', 'name'),
        attentionRows(),
      ]);
      const roleName = new Map(roles.map((r) => [String(r.id), r.name ?? null]));
      const userById = new Map(users.map((u) => [String(u.id), u]));
      const loginOf = (u) => ({
        status: u.status ?? null,
        role_id: u.role ?? null,
        role_name: isBlank(u.role) ? null : roleName.get(String(u.role)) ?? null,
        last_access: iso(u.last_access),
        email: u.email ?? null,
      });

      const keysOf = new Map(); // person_id -> attention keys, in the function's order
      for (const row of attention) {
        for (const id of row.person_ids ?? []) keysOf.set(String(id), [...(keysOf.get(String(id)) ?? []), row.key]);
      }

      const linked = new Set();
      const list = people.map((p) => {
        const user = isBlank(p.user_id) ? null : userById.get(String(p.user_id));
        if (user) linked.add(String(user.id));
        return {
          person_id: p.person_id,
          full_name: p.full_name,
          email: p.email ?? null,
          is_researcher: p.is_researcher === true,
          is_operator: p.is_operator === true,
          active: p.active !== false,
          notes: p.notes ?? null,
          user_id: p.user_id ?? null,
          login: user ? loginOf(user) : null,
          attention: keysOf.get(String(p.person_id)) ?? [],
        };
      }).sort(byText('full_name'));

      const logins_without_person = users
        .filter((u) => !linked.has(String(u.id)))
        .map((u) => {
          const login = loginOf(u);
          return {
            user_id: u.id,
            email: u.email ?? null,
            first_name: u.first_name ?? null,
            last_name: u.last_name ?? null,
            status: login.status,
            role_id: login.role_id,
            role_name: login.role_name,
            last_access: login.last_access,
          };
        })
        .sort(byText('email'));

      res.json({
        can_administer_accounts: accounts,
        roles: roles.map((r) => ({ id: r.id, name: r.name ?? null })).sort(byText('name')),
        people: list,
        logins_without_person,
      });
    }));

    router.get('/attention', route(async ({ res, admin }) => {
      requireAdmin(admin);
      const items = (await attentionRows())
        .map((row) => ({ key: row.key, count: attentionCount(row) }))
        .filter((item) => item.count > 0);
      res.json({ items });
    }));

    // -- change a login's role or status ---------------------------------------------------------------------

    // One write transaction: the actor first, so the audit trigger names the caller (as d1-record-access does).
    const inTransaction = (acc, work) =>
      database.transaction(async (trx) => {
        await trx.raw("SELECT set_config('d1.actor_identity', ?, true)", [String(acc.user)]);
        return work(trx);
      });

    // Knex writes bypass the Directus services that clear the data cache, so clear it after the commit (as d1-record-access does).
    async function clearDataCache(req) {
      if (!toBool(env?.CACHE_ENABLED)) return;
      try {
        await new services.UtilsService({ schema: req.schema, accountability: { user: null, role: null, admin: true, app: false } }).clearCache({ system: false });
      } catch (err) {
        logger?.warn?.(`${SOURCE}: could not clear the data cache: ${err?.message || err}`);
      }
    }

    // The number of active logins that are account administrators.
    async function activeAccountAdmins(db) {
      const active = await db('directus_users').where('status', 'active').select('id');
      let count = 0;
      for (const { id } of active) if ((await accountAdmin(db, id, labAdminRoleId)).accounts) count += 1;
      return count;
    }

    router.patch('/logins/:user_id', route(async ({ req, res, acc, accounts }) => {
      if (!accounts) throw new HttpError(403, 'ACCOUNTS_ADMIN_ONLY', 'Only an Administrator can change a login.');
      const userId = req.params?.user_id;
      if (typeof userId !== 'string' || !UUID.test(userId)) throw new HttpError(400, 'INVALID_PAYLOAD', 'The login id is not valid.');
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      const hasRole = body.role !== undefined;
      const hasStatus = body.status !== undefined;
      if (!hasRole && !hasStatus) throw new HttpError(400, 'INVALID_PAYLOAD', 'Send a role or a status.');
      if (hasRole && (typeof body.role !== 'string' || !UUID.test(body.role))) throw new HttpError(400, 'INVALID_PAYLOAD', 'role must be a role id.');
      if (hasStatus && !STATUSES.includes(body.status)) throw new HttpError(400, 'INVALID_PAYLOAD', 'status must be active or suspended.');

      const result = await inTransaction(acc, async (trx) => {
        // one change at a time, so two requests cannot each see the other administrator still there
        await trx.raw("SELECT pg_advisory_xact_lock(hashtext('d1-people-admin.logins'))");
        const target = await trx('directus_users').where('id', userId).first('id', 'status', 'role');
        if (!target) throw new HttpError(404, 'NOT_FOUND', 'That login does not exist.');
        if (hasRole && !(await trx('directus_roles').where('id', body.role).first('id'))) throw new HttpError(400, 'INVALID_PAYLOAD', 'That role does not exist.');

        const wasAccountAdmin = target.status === 'active' && (await accountAdmin(trx, userId, labAdminRoleId)).accounts;
        const changes = {};
        if (hasRole) changes.role = body.role;
        if (hasStatus) changes.status = body.status;
        await trx('directus_users').where('id', userId).update(changes);
        if (body.status === 'suspended') await trx('directus_sessions').where('user', userId).del();

        // counted after the change, so the target counts only if it is still an active account administrator
        if (wasAccountAdmin && (await activeAccountAdmins(trx)) === 0) {
          throw new HttpError(409, 'LAST_ADMINISTRATOR', 'Make someone else an Administrator first');
        }

        const user = await trx('directus_users').where('id', userId).first('id', 'status', 'role');
        const role = isBlank(user.role) ? null : await trx('directus_roles').where('id', user.role).first('name');
        return { user_id: user.id, role_id: user.role ?? null, role_name: role?.name ?? null, status: user.status ?? null };
      });
      await clearDataCache(req);
      res.json(result);
    }));

    router.get('/people/:person_id/access', route(async ({ req, res, acc, admin }) => {
      const personId = req.params?.person_id;
      if (typeof personId !== 'string' || !UUID.test(personId)) throw new HttpError(400, 'INVALID_PAYLOAD', 'The person id is not valid.');
      const person = await database('people').where('person_id', personId).first('person_id', 'user_id');
      if (!admin && !(person && !isBlank(person.user_id) && String(person.user_id) === String(acc.user))) {
        throw new HttpError(403, 'FORBIDDEN', 'You can only see your own access.');
      }
      if (!person) throw new HttpError(404, 'NOT_FOUND', 'That person does not exist.');
      const which = req.query?.list;
      if (!isBlank(which) && !LISTS.includes(which)) throw new HttpError(400, 'INVALID_QUERY', 'list must be owns, shared or investigator.');

      const counts = (await database.raw('SELECT owns, shared, investigator FROM d1_private.person_access(?)', [personId]))?.rows?.[0] ?? {};
      const body = { owns: Number(counts.owns) || 0, shared: Number(counts.shared) || 0, investigator: Number(counts.investigator) || 0 };
      if (!isBlank(which)) body.records = await recordsOf({ personId, which, viewer: admin ? null : String(acc.user) });
      res.json(body);
    }));

    // The records behind one count, with code and title read from each record. `viewer` (a non-administrator) leaves out the
    // records their own readers row does not list: counted above, not listed here.
    async function recordsOf({ personId, which, viewer }) {
      const listed = (await database.raw(
        'SELECT collection, record_id, level, source, granted_by, added_at FROM d1_private.person_access_list(?, ?)',
        [personId, which],
      ))?.rows ?? [];
      const byCollection = new Map();
      for (const row of listed) {
        if (!Object.hasOwn(COLLECTIONS, row.collection)) continue;
        byCollection.set(row.collection, [...(byCollection.get(row.collection) ?? []), String(row.record_id)]);
      }
      const rowsOf = new Map(); // "collection/id" -> the record row
      for (const [collection, ids] of byCollection) {
        const cfg = COLLECTIONS[collection];
        let visible = ids;
        if (viewer) {
          visible = [];
          for (const part of chunks(ids, CHUNK)) {
            const rows = await database(cfg.readers).where('user_id', viewer).whereIn('record_id', part).select('record_id');
            visible.push(...rows.map((r) => String(r.record_id)));
          }
        }
        const fields = [...new Set([cfg.key, ...cfg.code, ...cfg.title])];
        for (const part of chunks(visible, CHUNK)) {
          const rows = await database(collection).whereIn(cfg.key, part).select(...fields);
          for (const r of rows) rowsOf.set(`${collection}/${r[cfg.key]}`, r);
        }
      }
      const records = [];
      for (const row of listed) {
        const record = rowsOf.get(`${row.collection}/${row.record_id}`);
        if (!record) continue; // not readable by a non-administrator, or gone
        const cfg = COLLECTIONS[row.collection];
        records.push({
          collection: row.collection,
          id: row.record_id,
          kind: cfg.kind,
          code: firstOf(record, cfg.code),
          title: firstOf(record, cfg.title),
          level: row.level ?? null,
          source: row.source ?? null,
          granted_by: row.granted_by ?? null,
          added_at: iso(row.added_at),
        });
      }
      return records;
    }
  },
};
