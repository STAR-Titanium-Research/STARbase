// Directus endpoint: d1-people-admin  (mounted at /d1-people-admin)
//
// The data behind the admin People page (People 1, spec docs/superpowers/specs/2026-10-14-people-and-teams-design.md). Reads, and the writes:
//
//   GET /d1-people-admin/people
//     -> { can_administer_accounts, roles: [{ id, name }],
//          people: [{ person_id, full_name, email, is_researcher, is_operator, active, notes, user_id, created_at,
//                     login: null | { status, role_id, role_name, last_access, email }, attention: [key],
//                     teams: [{ team_id, name, color, logo, is_manager }] }],
//          logins_without_person: [{ user_id, email, first_name, last_name, status, role_id, role_name, last_access }] }
//        A login that login_aliases lists as an alias (merged into another person's login, suspended) is left out of
//        logins_without_person, and out of the user_ids that /attention counts. A Former person (active = false) is never in
//        missing_email: not on their row's attention list, not in the /attention count.
//   GET /d1-people-admin/attention
//     -> { items: [{ key, count }] }      (d1_private.people_attention(); zero counts omitted)
//   GET /d1-people-admin/people/:person_id/access[?list=owns|shared|investigator|teams]
//     -> { owns, shared, investigator, teams, waiting, waiting_owners }   (d1_private.person_access: five counts; teams = the rows their teams
//        give them, waiting = their pending rows on team grants worth asking about (Ruling D2), waiting_owners = how many distinct owners
//        those records have)
//        + records: [{ collection, id, kind, code, title, level, source, granted_by, added_at }] for the asked list (teams: source 'team',
//          granted_by the team's name)
//   PATCH /d1-people-admin/logins/:user_id   body { role?: uuid, status?: 'active' | 'suspended' }
//     -> { user_id, role_id, role_name, status }
//        Account administrators only (403 ACCOUNTS_ADMIN_ONLY for a Lab Admin or anyone else). The role must exist in directus_roles (400).
//        Suspending also deletes the login's rows in directus_sessions, in the same transaction. Refused with 409 LAST_ADMINISTRATOR when
//        the change would leave no active account administrator (a role change that drops the target's account-administrator status, or
//        suspending the target). The write goes through Directus's UsersService.updateOne as the caller (so directus_activity and
//        directus_revisions record it under their name), in one transaction with d1.actor_identity set and an advisory lock; Directus's own
//        last-admin check (422) is answered as LAST_ADMINISTRATOR too. The data cache is cleared after the commit
//        when CACHE_ENABLED is on (the same as d1-record-access). status 'active' is only for a suspended login (409 NOT_SUSPENDED otherwise;
//        an already active login is a no-op), because an invited login set active could no longer accept its invite; an invited login
//        cannot be suspended either (409 NOT_ACTIVE: delete the login instead).
//   POST /d1-people-admin/invite   body { email, role?: uuid, person_id?: uuid, full_name?: string }
//     -> 201 { user_id, person_id, status: 'invited', email_sent }   (200 when an invited login for that e-mail is sent the invite again)
//        Any administrator. Only an account administrator may choose a role; otherwise the role is Lab Member (D1_LAB_MEMBER_ROLE_ID),
//        and another one is 403 ACCOUNTS_ADMIN_ONLY. person_id: that person must exist and have no login (409 PERSON_HAS_LOGIN); without it
//        full_name is required and a person is created (is_researcher, email = the invite e-mail), unless exactly one unlinked person has
//        that e-mail (compared lower(btrim)): that person is linked instead (several: 409 PERSON_AMBIGUOUS with extensions.person_ids).
//        Every person the endpoint links becomes a researcher, as in d1-person-link. An e-mail with a login that is not
//        'invited' is 409 EMAIL_HAS_LOGIN (extensions.person_id when the login is linked). The login is made by Directus's
//        UsersService.inviteUser, the person link set in the same transaction. The invite link is STARBASE_URL + '/accept-invite'
//        (503 STARBASE_URL_UNSET when blank; docker-compose.yml puts it in USER_INVITE_URL_ALLOW_LIST).
//        email_sent: Directus sends the mail without waiting, so true means "handed to its mailer", and a delivery failure shows only
//        in Directus's log. A mail error that does surface keeps the login and the link: email_sent false, a warning logged.
//   POST /d1-people-admin/invite/resend   body { user_id }  -> { email_sent }   (409 NOT_INVITED unless the login's status is 'invited')
//
// Who may call: /people and /attention are for administrators and Lab Viewers (401 without a user, 403 otherwise; a viewer reads what an
// administrator reads and changes nothing, so every write route answers a viewer 403 READ_ONLY_ROLE). /access is for an administrator, a
// Lab Viewer, or the person whose login the caller is. A plain non-administrator sees every count, but the list leaves out a record they no
// longer read (their own readers row is missing): it is counted, not listed; an administrator gets every record listed. A Lab Viewer is filtered the same way as a member: an active viewer is a reader of every record (so reads all of them), a suspended one with a live token reads nothing Restricted.
//
// can_administer_accounts: an administrator whose role is not the Lab Admin role (D1_LAB_ADMIN_ROLE_ID). An admin policy attached to
// the USER with no role (the preview's admin) is an account administrator; the Lab Admin is not.
//
// Counting rule for /attention (migration 180): login_without_person and invite_not_accepted are counted by cardinality(user_ids), every
// other key (former_in_team among them) by cardinality(person_ids). Summing both arrays would count a person who has a login twice.
//
// Errors use the Directus shape { errors: [{ message, extensions: { code, source: 'd1-people-admin' } }] }.

import { COLLECTIONS, READ_ONLY_ROLE_MESSAGE, isLabViewer, isWriteRequest } from '../d1-record-access/index.js';

const SOURCE = 'd1-people-admin';
const DEFAULT_LAB_ADMIN_ROLE_ID = '10000001-0000-0000-0000-000000000001';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_LAB_MEMBER_ROLE_ID = '10000001-0000-0000-0000-000000000002';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// The accountability Directus's UsersService runs under for an invite: the caller is already checked, and d1.actor_identity names them.
const SYSTEM_ADMIN = { user: null, role: null, admin: true, app: false };
const LISTS = ['owns', 'shared', 'investigator', 'teams'];
const CHUNK = 1000;
const STATUSES = ['active', 'suspended'];
const toBool = (v) => v === true || v === 'true' || v === 1 || v === '1';

// Keys counted by login; every other key is counted by person.
export const COUNTED_BY_LOGIN = ['login_without_person', 'invite_not_accepted'];

class HttpError extends Error {
  constructor(status, code, message, extensions = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extensions = extensions; // extra fields for the error's `extensions` (e.g. the person an e-mail already belongs to)
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
          extensions: { ...(known ? err.extensions : {}), code: known ? err.code : 'INTERNAL_SERVER_ERROR', source: SOURCE },
        }],
      });
    };
    const route = (fn) => async (req, res) => {
      try {
        const acc = req.accountability;
        if (!acc?.user) throw new HttpError(401, 'UNAUTHORIZED', 'Sign in first.');
        // a Lab Viewer changes nothing: no role or status change, no invite (also refused below: a viewer is no administrator)
        const viewer = await isLabViewer(database, acc.user);
        if (viewer && isWriteRequest(req)) throw new HttpError(403, 'READ_ONLY_ROLE', READ_ONLY_ROLE_MESSAGE);
        const caller = await accountAdmin(database, acc.user, labAdminRoleId);
        const admin = acc.admin === true || caller.admin;
        // `admin` stays the right to CHANGE things (a viewer has none); `readAll` is the right to LOOK at everyone's access: an administrator, or a Lab Viewer
        await fn({ req, res, acc, admin, accounts: caller.accounts, readAll: admin || viewer, unfiltered: admin && !viewer });
      } catch (err) {
        return sendError(res, err);
      }
    };
    const requireAdmin = (admin) => {
      if (!admin) throw new HttpError(403, 'FORBIDDEN', 'Only an administrator can open this.');
    };
    // the read routes of the People page: an administrator or a Lab Viewer (migration 185); the writes below use requireAdmin / accounts
    const requireReadAll = (readAll) => {
      if (!readAll) throw new HttpError(403, 'FORBIDDEN', 'Only an administrator or a Lab Viewer can open this.');
    };

    // d1_private.people_attention() rows: { key, person_ids, user_ids }
    // Logins merged into another person (login_aliases: alias -> canonical, and suspended): never a row and never counted.
    // It only guards the list, so it fails soft: if it cannot be read the page still loads (a warning is logged).
    const aliasIds = async () => {
      try {
        return new Set((await database('login_aliases').select('alias_user_id')).map((a) => String(a.alias_user_id)));
      } catch (err) {
        logger?.warn?.(`${SOURCE}: could not read login_aliases: ${err?.message || err}`);
        return new Set();
      }
    };
    // A Former person (people.active = false) has nothing to fix in an email: missing_email never names them.
    // `aliasesP`: a request that has already asked for the aliases passes them in, so they are read once.
    const attentionRows = async (aliasesP = aliasIds()) => {
      const [rows, aliases, former] = await Promise.all([
        database.raw('SELECT key, person_ids, user_ids FROM d1_private.people_attention()').then((r) => r?.rows ?? []),
        aliasesP,
        database('people').where('active', false).select('person_id').then((l) => new Set(l.map((x) => String(x.person_id)))),
      ]);
      return rows.map((row) => {
        let out = row;
        if (aliases.size && Array.isArray(row.user_ids)) out = { ...out, user_ids: row.user_ids.filter((id) => !aliases.has(String(id))) };
        if (row.key === 'missing_email' && former.size && Array.isArray(row.person_ids)) out = { ...out, person_ids: row.person_ids.filter((id) => !former.has(String(id))) };
        return out;
      });
    };

    // One query for every membership: team_members joined with teams, in team-name order.
    const membershipRows = async () =>
      (await database.raw(
        'SELECT tm.person_id, t.team_id, t.name, t.color, t.logo, tm.is_manager FROM team_members tm JOIN teams t ON t.team_id = tm.team_id ORDER BY lower(t.name), t.team_id',
      ))?.rows ?? [];

    router.get('/people', route(async ({ res, readAll, accounts }) => {
      requireReadAll(readAll);
      const aliasesP = aliasIds();
      const [people, users, roles, attention, memberships, aliases] = await Promise.all([
        database('people').select('person_id', 'full_name', 'email', 'is_researcher', 'is_operator', 'active', 'notes', 'user_id', 'created_at'),
        database('directus_users').select('id', 'email', 'first_name', 'last_name', 'status', 'role', 'last_access'),
        database('directus_roles').select('id', 'name'),
        attentionRows(aliasesP),
        membershipRows(),
        aliasesP,
      ]);
      const teamsOf = new Map(); // person_id -> their teams
      for (const m of memberships) {
        teamsOf.set(String(m.person_id), [...(teamsOf.get(String(m.person_id)) ?? []), {
          team_id: m.team_id, name: m.name, color: m.color ?? 'teal', logo: m.logo ?? null, is_manager: m.is_manager === true,
        }]);
      }
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
          created_at: iso(p.created_at),
          login: user ? loginOf(user) : null,
          attention: keysOf.get(String(p.person_id)) ?? [],
          teams: teamsOf.get(String(p.person_id)) ?? [],
        };
      }).sort(byText('full_name'));

      const logins_without_person = users
        .filter((u) => !linked.has(String(u.id)) && !aliases.has(String(u.id)))
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

    router.get('/attention', route(async ({ res, readAll }) => {
      requireReadAll(readAll);
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
        // Setting an invited login active would make its invite unacceptable (Directus accepts an invite only while the status is
        // 'invited'), so 'active' is for a suspended login, or one already active (a no-op).
        if (body.status === 'active' && !['suspended', 'active'].includes(target.status)) {
          throw new HttpError(409, 'NOT_SUSPENDED', 'Only a suspended login can be reactivated');
        }
        // an invite that was never accepted has no sessions and nothing to suspend; deleting the login is the way to withdraw it
        if (body.status === 'suspended' && target.status === 'invited') {
          throw new HttpError(409, 'NOT_ACTIVE', 'An invite that has not been accepted cannot be suspended — delete the login instead');
        }
        if (hasRole && !(await trx('directus_roles').where('id', body.role).first('id'))) throw new HttpError(400, 'INVALID_PAYLOAD', 'That role does not exist.');

        const wasAccountAdmin = target.status === 'active' && (await accountAdmin(trx, userId, labAdminRoleId)).accounts;
        const changes = {};
        if (hasRole) changes.role = body.role;
        if (hasStatus) changes.status = body.status;
        // Through Directus's UsersService, as the caller, so the change lands in directus_activity / directus_revisions under their name
        // (verified in a throwaway directus/directus:11: it joins the `knex` transaction, so a rollback undoes the activity row too, and
        // it has its own "last admin" check that throws 422 UNPROCESSABLE_CONTENT, mapped below).
        try {
          await new services.UsersService({ schema: req.schema, accountability: req.accountability, knex: trx }).updateOne(userId, changes);
        } catch (err) {
          if (err?.code === 'UNPROCESSABLE_CONTENT' && /last admin/i.test(String(err?.extensions?.reason ?? err?.message ?? ''))) {
            throw new HttpError(409, 'LAST_ADMINISTRATOR', 'Make someone else an Administrator first');
          }
          throw err;
        }
        // UsersService already ends the sessions of a login that is no longer active; this stays as the guarantee
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

    // -- invites -----------------------------------------------------------------------------------------------

    // Directus 11.17 UsersService.inviteUser(email, role, url) (verified in the image, @directus/api 35.2.0, services/users.js):
    //  - the URL must pass USER_INVITE_URL_ALLOW_LIST, but only when a row is written (an unknown e-mail, or an invited login whose
    //    role changes); that failure is thrown from createOne/updateOne;
    //  - an unknown e-mail gets a new 'invited' user; an 'invited' login has its role changed if another one is asked; a login in
    //    any other status is left alone and gets NO mail;
    //  - the mail is fire-and-forget (`mailService.send(...).catch(log)`): it is never awaited and can never throw out of
    //    inviteUser; a delivery failure shows only in Directus's log ("Could not send user invitation mail").
    // So `email_sent: true` means "handed to Directus's mailer without an error", not "delivered". The catch below is for a mail
    // error that ever does reach us: the rule (d1-record-access) is that mail never undoes a change.
    const labMemberRoleId = trimmed(env?.D1_LAB_MEMBER_ROLE_ID) ?? DEFAULT_LAB_MEMBER_ROLE_ID;
    const sameId = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
    const inviteUrl = () => {
      const base = trimmed(env?.STARBASE_URL);
      if (!base) throw new HttpError(503, 'STARBASE_URL_UNSET', 'STARBASE_URL is not set, so an invitation has nowhere to point.');
      return `${base}/accept-invite`; // verbatim, as USER_INVITE_URL_ALLOW_LIST is set in docker-compose.yml
    };
    const loginByEmail = (db, email) =>
      db('directus_users').whereRaw('LOWER(??) = ?', ['email', email.toLowerCase()]).first('id', 'email', 'status', 'role');

    // Calls UsersService.inviteUser on the transaction. `existed`: the login was already there (invited) before this call, so inviteUser
    // only re-sends or changes its role. Returns true when the mail was handed off, false when it failed but the invited login is there
    // as asked (made by this call, or already holding `roleId`); any other failure is rethrown, which rolls the transaction back.
    async function sendInvite(trx, req, email, roleId, url, existed) {
      const users = new services.UsersService({ schema: req.schema, accountability: SYSTEM_ADMIN, knex: trx });
      try {
        await users.inviteUser(email, roleId, url);
        return true;
      } catch (err) {
        let kept = null;
        try { kept = await loginByEmail(trx, email); } catch { /* an aborted transaction: report the first error instead */ }
        // Swallow only when the invited login is there as asked: made by this call, or already holding the requested role. Anything else
        // (e.g. a role update that failed, such as a USER_INVITE_URL_ALLOW_LIST out of step with STARBASE_URL) is a real failure: roll back.
        const asRequested = kept?.status === 'invited' && (!existed || sameId(kept.role ?? '', roleId ?? ''));
        if (!asRequested) throw err;
        logger?.warn?.(`${SOURCE}: the invitation mail for login ${kept.id} was not sent: ${err?.message || err}`);
        return false;
      }
    }

    router.post('/invite', route(async ({ req, res, acc, admin, accounts }) => {
      requireAdmin(admin);
      const url = inviteUrl();
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      const email = trimmed(body.email);
      if (!email || !EMAIL.test(email)) throw new HttpError(400, 'INVALID_PAYLOAD', 'email must be an e-mail address.');
      const hasRole = !isBlank(body.role);
      if (hasRole && (typeof body.role !== 'string' || !UUID.test(body.role))) throw new HttpError(400, 'INVALID_PAYLOAD', 'role must be a role id.');
      const hasPerson = !isBlank(body.person_id);
      if (hasPerson && (typeof body.person_id !== 'string' || !UUID.test(body.person_id))) throw new HttpError(400, 'INVALID_PAYLOAD', 'person_id must be a person id.');
      const fullName = trimmed(body.full_name);
      // an account administrator may choose any role; everyone else invites Lab Members only
      const roleId = hasRole ? body.role : labMemberRoleId;
      if (!accounts && !sameId(roleId, labMemberRoleId)) throw new HttpError(403, 'ACCOUNTS_ADMIN_ONLY', 'Only an Administrator can invite someone as anything but a Lab Member.');

      const result = await inTransaction(acc, async (trx) => {
        await trx.raw("SELECT pg_advisory_xact_lock(hashtext('d1-people-admin.logins'))");
        if (hasRole && !sameId(roleId, labMemberRoleId) && !(await trx('directus_roles').where('id', roleId).first('id'))) {
          throw new HttpError(400, 'INVALID_PAYLOAD', 'That role does not exist.');
        }
        const existing = await loginByEmail(trx, email);
        const linked = existing ? await trx('people').where('user_id', existing.id).first('person_id') : undefined;
        if (existing && existing.status !== 'invited') {
          throw new HttpError(409, 'EMAIL_HAS_LOGIN', 'That e-mail already has a login.', linked ? { person_id: linked.person_id } : {});
        }

        // who the login belongs to: the person it is already linked to, the one asked for, the one unlinked person who has this
        // e-mail (d1-person-link's rule), or a new one made from full_name
        let personId = linked?.person_id ?? null;
        if (hasPerson) {
          if (linked && !sameId(linked.person_id, body.person_id)) {
            throw new HttpError(409, 'EMAIL_HAS_LOGIN', 'That e-mail already has a login, linked to someone else.', { person_id: linked.person_id });
          }
          if (!linked) {
            const person = await trx('people').where('person_id', body.person_id).first('person_id', 'user_id');
            if (!person) throw new HttpError(404, 'NOT_FOUND', 'That person does not exist.');
            if (!isBlank(person.user_id)) throw new HttpError(409, 'PERSON_HAS_LOGIN', 'That person already has a login.');
            personId = person.person_id;
          }
        } else if (!linked) {
          // the header invite names no person: an unlinked person with this e-mail is that person, not a new one (no duplicate)
          const sameEmail = await trx('people').whereNull('user_id').whereRaw('lower(btrim(??)) = ?', ['email', email.toLowerCase()]).select('person_id');
          if (sameEmail.length > 1) {
            throw new HttpError(409, 'PERSON_AMBIGUOUS', 'Several people have this email — invite from the right person\'s panel', { person_ids: sameEmail.map((p) => p.person_id) });
          }
          if (sameEmail.length === 1) personId = sameEmail[0].person_id;
          else if (!fullName) throw new HttpError(400, 'INVALID_PAYLOAD', 'full_name is required when no person is chosen.');
        }

        // an invited login keeps its role unless an account administrator asks for another one
        const inviteRole = existing && !(accounts && hasRole) ? existing.role : roleId;
        const emailSent = await sendInvite(trx, req, existing?.email ?? email, inviteRole, url, Boolean(existing));

        const login = await loginByEmail(trx, email);
        if (!login) throw new Error('inviteUser returned without leaving a login');
        if (linked) {
          // already linked: nothing to do
        } else if (personId) {
          // Directus's users.create event also reaches d1-person-link, but on its own connection: its insert points at a login this
          // transaction has not committed yet, so it fails on the foreign key and returns quietly. This write is the one that links.
          // Whoever has a login is a researcher (as the hook sets it).
          await trx('people').where('person_id', personId).update({ user_id: login.id, is_researcher: true });
        } else {
          const made = await trx('people').insert({ full_name: fullName, email, is_researcher: true, user_id: login.id }).returning('person_id');
          personId = made?.[0]?.person_id ?? made?.[0];
        }
        return { created: !existing, body: { user_id: login.id, person_id: personId, status: 'invited', email_sent: emailSent } };
      });
      await clearDataCache(req);
      res.status(result.created ? 201 : 200).json(result.body);
    }));

    router.post('/invite/resend', route(async ({ req, res, acc, admin }) => {
      requireAdmin(admin);
      const url = inviteUrl();
      const userId = req.body?.user_id;
      if (typeof userId !== 'string' || !UUID.test(userId)) throw new HttpError(400, 'INVALID_PAYLOAD', 'user_id must be a login id.');
      const emailSent = await inTransaction(acc, async (trx) => {
        const login = await trx('directus_users').where('id', userId).first('id', 'email', 'status', 'role');
        if (!login) throw new HttpError(404, 'NOT_FOUND', 'That login does not exist.');
        if (login.status !== 'invited') throw new HttpError(409, 'NOT_INVITED', 'Only an invited login can be sent a new invite.');
        return sendInvite(trx, req, login.email, login.role, url, true);
      });
      res.json({ email_sent: emailSent });
    }));

    router.get('/people/:person_id/access', route(async ({ req, res, acc, unfiltered, readAll }) => {
      const personId = req.params?.person_id;
      if (typeof personId !== 'string' || !UUID.test(personId)) throw new HttpError(400, 'INVALID_PAYLOAD', 'The person id is not valid.');
      const person = await database('people').where('person_id', personId).first('person_id', 'user_id');
      if (!readAll && !(person && !isBlank(person.user_id) && String(person.user_id) === String(acc.user))) {
        throw new HttpError(403, 'FORBIDDEN', 'You can only see your own access.');
      }
      if (!person) throw new HttpError(404, 'NOT_FOUND', 'That person does not exist.');
      const which = req.query?.list;
      if (!isBlank(which) && !LISTS.includes(which)) throw new HttpError(400, 'INVALID_QUERY', 'list must be owns, shared, investigator or teams.');

      const counts = (await database.raw('SELECT owns, shared, investigator, teams, waiting FROM d1_private.person_access(?)', [personId]))?.rows?.[0] ?? {};
      const waiting = Number(counts.waiting) || 0;
      const body = {
        owns: Number(counts.owns) || 0,
        shared: Number(counts.shared) || 0,
        investigator: Number(counts.investigator) || 0,
        teams: Number(counts.teams) || 0,
        waiting,
        waiting_owners: waiting ? await waitingOwners(personId) : 0,
      };
      if (!isBlank(which)) body.records = await recordsOf({ personId, which, viewer: unfiltered ? null : String(acc.user) });
      res.json(body);
    }));

    // How many distinct owners the person's waiting records have: the pending rows d1_private.person_access counts as waiting (pending, and
    // d1_private.team_pending_actionable says approving would raise their access), each joined to its record's owner column.
    async function waitingOwners(personId) {
      const kinds = Object.values(COLLECTIONS);
      const parts = kinds.map((c) =>
        `SELECT r.${c.ownerField} AS owner FROM ${c.kind}_team_pending x JOIN ${c.kind}_team_access g ON g.team_access_id = x.team_access_id JOIN ${c.collection} r ON r.${c.key} = g.${c.key} WHERE x.person_id = ? AND x.state = 'pending' AND d1_private.team_pending_actionable('${c.collection}', x.team_access_id, ?)`,
      );
      const sql = `SELECT count(DISTINCT w.owner)::int AS owners FROM (${parts.join(' UNION ALL ')}) w WHERE w.owner IS NOT NULL`;
      const row = (await database.raw(sql, kinds.flatMap(() => [personId, personId])))?.rows?.[0];
      return Number(row?.owners) || 0;
    }

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
