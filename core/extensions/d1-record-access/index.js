// Directus endpoint: d1-record-access  (mounted at /d1-record-access)
//
// The "Who has access" backend of the Explorer record pages (A1a, spec docs/superpowers/specs/2026-10-12-record-access-design.md
// section 5). It is the ONLY writer of the five access tables (sample_access, operation_access, test_access, campaign_access,
// project_access): Lab Member has no write grant on them.
//
//   GET    /d1-record-access/:collection/:id
//     -> { restricted, owner, project_pi, can_manage,
//          entries: [{ person_id, name, role, label, source: 'access'|'co_owner'|'investigator', can_sign_in,
//                      added_by, added_at, blocked_by }] }      (project_pi is null for a caller who cannot read that project)
//   POST   /d1-record-access/:collection/:id/entries            { person_id, role }  -> { entry, email: 'sent'|'skipped'|'failed' }
//   PATCH  /d1-record-access/:collection/:id/entries/:person_id { role }              -> { entry }
//   DELETE /d1-record-access/:collection/:id/entries/:person_id                        -> { removed: true }
//   POST   /d1-record-access/:collection/:id/transfer           { person_id }         -> { owner, email, blocked_by }
//   Team ownership (migration 177): GET answers owner as { kind: 'person', person_id, name, can_sign_in } or, on a record a team owns,
//   { kind: 'team', team_id, name, color, logo, managers: [{ person_id, full_name }] } (null with no owner). Transfer also takes
//   POST   /d1-record-access/:collection/:id/transfer           { team_id }           -> { owner, email, emails, blocked_by: null }
//   for samples, operations, tests and campaigns (409 NOT_OWNABLE_BY_TEAM on a project): owner_team_id is set and owner_person_id cleared in
//   ONE update (the CHECK forbids both), the previous person owner stays on as Can edit, and the team's managers are mailed. A transfer
//   { person_id } of a team-owned record clears owner_team_id in the same update. The database then keeps the owner grant (role 'own') and
//   its derived rows (manage for a manager, edit for a member). Ruling O2: that grant is never listed in teams, entries or members, and no
//   route changes it (409 TEAM_OWNS_RECORD, or 404 where a route only reads): the team shows as the owner. A record becomes team-owned
//   ONLY through this transfer (d1-access-guard refuses owner_team_id on create, Ruling O3).
//   Teams (migration 176): GET also answers teams: [{ team_access_id, team_id, name, color, logo, member_count, role,
//   trust_new_members, waiting, declined }] (waiting = pending joiners worth asking about, Ruling D2; declined = declined joiners).
//   POST   /d1-record-access/:collection/:id/entries            { team_id, role }     -> { team, email: 'sent'|'skipped'|'failed', emails }
//   PATCH  /d1-record-access/:collection/:id/entries/team/:team_id   { role?, trust_new_members? }  -> { team }
//   DELETE /d1-record-access/:collection/:id/entries/team/:team_id                      -> { removed: true }
//   GET    /d1-record-access/:collection/:id/entries/team/:team_id/members              -> { active, pending, declined }
//   POST   /d1-record-access/:collection/:id/entries/team/:team_id/members/:person_id { decision: 'approve' | 'decline' } -> { decision, email }
//   A team grant is expanded by the database triggers into derived <type>_access rows (team_access_id NOT NULL) that only those triggers
//   may write. `entries` and every person flow (add, change, remove, transfer) touch only a person's OWN rows (team_access_id IS NULL).
//   blocked_by (entries, add, transfer): null, or { reason: 'parent' | 'no_login', collection, id, kind, code }. The person is blocked when
//   they have a login that is not in the record's OWN readers table (and is not an admin), or have no login. collection/id/kind/code name
//   the nearest parent they cannot read, only when the CALLER can read that parent, else they are null (generic wording).
//
// collection is one of physical_samples, manufacturing_operations, test_sessions, campaigns, projects. Roles: samples,
// operations, tests and campaigns have `view` (Can view) and `edit` (Can edit); projects have `view` and `investigator`
// (Secondary investigator). Only the record's owner (the PI for a project) or an admin may add, change, remove or transfer;
// anyone who can READ the record may list it. A record with no owner is manageable by admins only.
//
// Errors (the Directus shape { errors: [{ message, extensions: { code, source: 'd1-record-access' } }] }): 401 no user;
// 400 unknown collection, bad uuid, role or person; 404 a record the caller cannot read (or that does not exist); 403 FORBIDDEN
// when the caller may not manage it; 409 adding or transferring to the owner (CONFLICT), NOT_OWNABLE_BY_TEAM, TEAM_OWNS_RECORD.
//
// How a request runs:
//   * readable = ItemsService.readOne as the caller (the real read rule decides), manage = the record's DELETE rule (rules.json
//     `manage`: the owner, with the gates) run through ItemsService.readByQuery as the caller, or admin. Only after both pass does
//     anything write, with knex (the system, not the caller), so Lab Member needs no write grant.
//   * the writes run in ONE knex transaction that first does set_config('d1.actor_identity', <caller>, true), so the audit
//     trigger names the caller. They fire the readers triggers (migration 166) in the same transaction, so the response and the
//     next read are consistent. Every write for a person also deletes that person's row in the OLD table (sample_co_owners,
//     project_investigators) in the same transaction, so the two stores never disagree for one person.
//   * after commit: the Directus data cache is cleared when CACHE_ENABLED is on (knex writes bypass the services that do it),
//     then the email is sent (a new grant, or a transfer) through MailService with a 10 s timeout. A failed email never undoes
//     the change: the answer says email: 'failed'. The address is directus_users.email for a person with a login (an
//     admin-controlled address) and people.email only for a person with no login: Lab Member can edit people.email, so using it
//     for a person with a login would let any member redirect another member's notifications.
//
// MailService (Directus 11.17.4, @directus/api 35.2.0, read from the image): send(data, options) takes { to, subject, html, text }
// and passes them to nodemailer; `html` is used as given (only a `template` makes it render a .liquid file and wrap it), every
// line of html is trimmed, `from` defaults to EMAIL_FROM. The constructor calls getMailer(), which throws on an unknown
// EMAIL_TRANSPORT, so it is built inside the same try/catch as send.
//
// Restricting a record (the `restricted` flag) is NOT a route of this endpoint: it stays a PATCH of the record, guarded by
// d1-access-guard (owner only), and the Restrict switch is hidden in the UI in A1a.

import { readFileSync } from 'node:fs';

const RECORDS = JSON.parse(readFileSync(new URL('./rules.json', import.meta.url), 'utf8')).records;

const SOURCE = 'd1-record-access';
const MAIL_TIMEOUT_MS = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENT_USER = '$CURRENT_USER';

// What each record type is called, where its Explorer page is, which columns say what it is, which records sit above it, and
// which old table (keyed by login) also grants access to it. The rules (access table, keys, owner column, roles, the manage
// filter) come from rules.json, generated from scripts/access_rules.json.
const PARENTS = {
  project_id: { collection: 'projects', kind: 'project', key: 'project_id', readers: 'project_readers', access: 'project_access', ownerField: 'principal_investigator_person', code: ['project_code', 'project_name'] },
  campaign_id: { collection: 'campaigns', kind: 'campaign', key: 'campaign_id', readers: 'campaign_readers', access: 'campaign_access', ownerField: 'owner_person_id', code: ['campaign_code', 'name'] },
  sample_id: { collection: 'physical_samples', kind: 'sample', key: 'sample_id', readers: 'sample_readers', access: 'sample_access', ownerField: 'owner_person_id', code: ['sample_code'] },
};
const DETAILS = {
  physical_samples: { ownerTeam: true, readers: 'sample_readers', kind: 'sample', segment: 'samples', code: ['sample_code'], title: ['nickname'], parents: ['project_id'], legacy: { table: 'sample_co_owners', fk: 'sample_id', role: 'edit' } },
  manufacturing_operations: { ownerTeam: true, readers: 'operation_readers', kind: 'operation', segment: 'operations', code: ['pass_code'], title: [], parents: ['sample_id', 'campaign_id', 'project_id'], legacy: null },
  test_sessions: { ownerTeam: true, readers: 'test_readers', kind: 'test', segment: 'tests', code: ['test_code'], title: ['test_type'], parents: ['sample_id', 'campaign_id', 'project_id'], legacy: null },
  campaigns: { ownerTeam: true, readers: 'campaign_readers', kind: 'campaign', segment: 'campaigns', code: ['campaign_code', 'name'], title: [], parents: ['project_id'], legacy: null },
  projects: { ownerTeam: false, readers: 'project_readers', kind: 'project', segment: 'projects', code: ['project_code', 'project_name'], title: ['project_name'], parents: [], legacy: { table: 'project_investigators', fk: 'project_id', role: 'investigator' } },
};

// collection -> { kind, segment, table, fk, key, ownerField, ownerTeam, roles, manage, code, title, parents, legacy }
// ownerTeam: the record has an owner_team_id column (the four ownable types; a project's owner is its PI, never a team)
export const COLLECTIONS = Object.fromEntries(
  Object.entries(DETAILS).map(([collection, d]) => {
    const rule = RECORDS[collection];
    if (!rule) throw new Error(`d1-record-access: rules.json has no record_access entry for ${collection}`);
    return [collection, { collection, ...d, table: rule.table, fk: rule.fk, key: rule.key, ownerField: rule.ownerField, roles: rule.roles, manage: rule.manage }];
  }),
);

// COLLECTIONS is a plain object: only its own keys are collections ('constructor' and '__proto__' are not).
const isCollection = (name) => typeof name === 'string' && Object.hasOwn(COLLECTIONS, name);

const ROLE_RANK = { view: 1, edit: 2, investigator: 2 };

class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const isBlank = (v) => v === undefined || v === null || v === '';
const isForbidden = (e) => e?.status === 403 || e?.code === 'FORBIDDEN';
const toBool = (v) => v === true || v === 'true' || v === 1 || v === '1';
const same = (a, b) => String(a) === String(b);
const trimmed = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---- pure helpers (exported for the tests) ---------------------------------------------------------------

// The words next to a person on the list. A legacy co-owner reads "Co-owner · can edit".
export function roleLabel(collection, role, source = 'access') {
  if (role === 'investigator') return 'Secondary investigator';
  if (role === 'edit') return source === 'co_owner' ? 'Co-owner · can edit' : 'Can edit';
  if (role === 'view') return 'Can view';
  return String(role ?? '');
}

const ownerLabel = (collection) => (collection === 'projects' ? 'Principal investigator' : 'Owner');

// The Explorer page of a record (a test in this folder pins the segment map against the starbase-pages routes).
// STARbase (STARBASE_URL) serves the pages at its root; without it, Directus's Explorer module under /admin/home.
export function recordLink(publicUrl, collection, id, starbaseUrl) {
  const segment = isCollection(collection) ? COLLECTIONS[collection].segment : null;
  if (!segment) return null;
  const tail = `${segment}/${encodeURIComponent(String(id))}`;
  const starbase = String(starbaseUrl ?? '').trim().replace(/\/+$/, '');
  if (starbase) return `${starbase}/${tail}`;
  const base = String(publicUrl ?? '').trim().replace(/\/+$/, '');
  // neither set: no link (a relative one is useless in an email)
  return base ? `${base}/admin/home/${tail}` : null;
}

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
const oneLine = (value) => String(value ?? '').replace(/[\r\n]+/g, ' ').trim();

// The email: { subject, text, html }. Every interpolated value is HTML-escaped; nothing is a template. `transfer` is the
// ownership-transfer wording ("made you the owner of").
//
// `blockedReason` ('parent' or 'no_login') means the person cannot read the record yet: something above it hides it from them
// ('parent'), or they have no login ('no_login'). The mail then says who added them, the record's kind and code, and the GENERIC
// wording for the reason. It carries NO title, NO link (the title is the record's content, the link would only fail) and nothing of
// the parents above the record (their kind, code or the PI): the recipient may not be allowed to know they exist.
export function mailContent({ adder, role, kind, code, title, link, transfer = false, blockedReason = null, via = null, ownerTeam = null }) {
  const who = oneLine(adder) || 'Someone';
  const what = [oneLine(kind), oneLine(code)].filter(Boolean).join(' ') || 'a record';
  const owning = oneLine(ownerTeam); // a team was made the owner: the mail goes to its managers
  const verb = owning ? `made the team ${owning} the owner of` : transfer ? 'made you the owner of' : 'gave you access to';
  const team = oneLine(via);
  const viaText = team ? ` via ${team}` : ''; // access that comes through a team
  const subject = owning ? `${who} made ${owning} the owner of ${what}` : `${who} ${verb} ${what}${viaText}`;
  const blocked = Boolean(blockedReason);
  const named = blocked ? '' : oneLine(title);
  const openLink = blocked ? null : link;
  const roleLine = oneLine(role);
  const wait = !blocked
    ? null
    : blockedReason === 'no_login'
      ? 'You will be able to open it once you have a D1 login and access to it.'
      : 'You cannot open it yet. You will be able to once the owner of what it sits under gives you access.';
  const text = [
    `${who} ${verb} the ${what}${named ? ` (${named})` : ''}${viaText}.`,
    owning ? `As a manager of ${owning} you can share it, transfer it and delete it.` : null,
    roleLine ? `Your role: ${roleLine}.` : null,
    wait,
    openLink ? `Open it here: ${openLink}` : null,
    '',
    'If you did not expect this, you can ignore this email.',
  ]
    .filter((line) => line !== null)
    .join('\n');
  const html = [
    `<p><strong>${escapeHtml(who)}</strong> ${escapeHtml(verb)} the ${escapeHtml(what)}${named ? ` (${escapeHtml(named)})` : ''}${escapeHtml(viaText)}.</p>`,
    owning ? `<p>${escapeHtml(`As a manager of ${owning} you can share it, transfer it and delete it.`)}</p>` : '',
    roleLine ? `<p>Your role: <strong>${escapeHtml(roleLine)}</strong>.</p>` : '',
    wait ? `<p>${escapeHtml(wait)}</p>` : '',
    openLink ? `<p><a href="${escapeHtml(openLink)}">Open it in D1</a><br>${escapeHtml(openLink)}</p>` : '',
    '<p>If you did not expect this, you can ignore this email.</p>',
  ]
    .filter(Boolean)
    .join('\n');
  return { subject, text, html };
}

// Where the email goes: the LOGIN's address for a person who has a login (even if that is empty: then nobody is mailed, the
// People address is NOT a fallback, see the header), the People address only for a person with no login.
export function recipientAddress(person, user) {
  if (!person) return null;
  if (!isBlank(person.user_id)) return trimmed(user?.email);
  return trimmed(person.email);
}

// Reject after `ms`, clear the timer when the promise settles, and never leave the losing promise's rejection unhandled
// (a send that fails after the timeout must not take the Directus process down).
export function withTimeout(promise, ms) {
  let timer;
  const work = Promise.resolve(promise);
  work.catch(() => {});
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

// $CURRENT_USER anywhere in a filter (ItemsService does not substitute it, the REST layer does).
function substitute(node, user) {
  if (node === CURRENT_USER) return user;
  if (Array.isArray(node)) return node.map((item) => substitute(item, user));
  if (isObject(node)) return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, substitute(v, user)]));
  return node;
}

const firstOf = (row, fields) => {
  for (const field of fields) if (!isBlank(row?.[field])) return String(row[field]);
  return null;
};
const personName = (p) => trimmed(p?.full_name) ?? 'Unnamed person';
const userName = (u) => trimmed([u?.first_name, u?.last_name].filter(Boolean).join(' ')) ?? trimmed(u?.email) ?? 'Unknown user';

// ---- the endpoint ----------------------------------------------------------------------------------------

export default {
  id: SOURCE,
  handler: (router, context) => {
    const { database, logger, services, env } = context;
    // logger methods must be called ON the logger (pino reads this), never detached
    const warn = (message) => logger?.warn?.(`${SOURCE}: ${message}`);
    if (!trimmed(env?.PUBLIC_URL) && !trimmed(env?.STARBASE_URL)) warn('Neither STARBASE_URL nor PUBLIC_URL is set: notification emails will carry no link to the record');

    const sendError = (res, err) => {
      const status = err instanceof HttpError ? err.status : 500;
      const code = err instanceof HttpError ? err.code : 'INTERNAL_SERVER_ERROR';
      const message = err instanceof HttpError ? err.message : 'Something went wrong on the server.';
      if (!(err instanceof HttpError)) logger?.error?.(`${SOURCE}: ${err?.stack || err?.message || err}`);
      return res.status(status).json({ errors: [{ message, extensions: { code, source: SOURCE, ...(err instanceof HttpError ? err.extra : {}) } }] });
    };
    const route = (fn) => async (req, res) => {
      try {
        const acc = req.accountability;
        if (!acc?.user) throw new HttpError(401, 'UNAUTHORIZED', 'Sign in first.');
        const collection = req.params?.collection;
        const cfg = isCollection(collection) ? COLLECTIONS[collection] : null;
        if (!cfg) throw new HttpError(400, 'INVALID_PAYLOAD', 'That kind of record has no access list.');
        const id = req.params?.id;
        if (typeof id !== 'string' || !UUID.test(id)) throw new HttpError(400, 'INVALID_PAYLOAD', 'The record id is not valid.');
        await fn({ req, res, acc, cfg, id });
      } catch (err) {
        return sendError(res, err);
      }
    };

    // -- reads as the caller ---------------------------------------------------------------------------
    const itemsFor = (req, collection, knex) =>
      new services.ItemsService(collection, { accountability: req.accountability, schema: req.schema, ...(knex ? { knex } : {}) });

    // 404 for a record the caller cannot read (the read rule decides) or that does not exist.
    async function requireReadable({ req, cfg, id }) {
      try {
        const row = await itemsFor(req, cfg.collection).readOne(id, { fields: [cfg.key] });
        if (!row) throw new HttpError(404, 'NOT_FOUND', 'That record does not exist, or you cannot see it.');
      } catch (err) {
        if (err instanceof HttpError) throw err;
        if (isForbidden(err)) throw new HttpError(404, 'NOT_FOUND', 'That record does not exist, or you cannot see it.');
        throw err;
      }
    }

    // admin, or the manage filter (the delete rule) matches the record as the caller
    async function canManage({ req, acc, cfg, id }, knex) {
      if (acc.admin === true) return true;
      try {
        const rows = await itemsFor(req, cfg.collection, knex).readByQuery({
          fields: [cfg.key],
          filter: { _and: [{ [cfg.key]: { _eq: id } }, substitute(cfg.manage, acc.user)] },
          limit: 1,
        });
        return rows.length > 0;
      } catch (err) {
        if (isForbidden(err)) return false;
        throw err;
      }
    }
    // `knex`: the write transaction, so the check and the write see the same state (a transfer committed a moment ago is seen)
    async function requireManage(args, knex) {
      if (!(await canManage(args, knex))) {
        throw new HttpError(403, 'FORBIDDEN', 'Only the owner of this record (or an administrator) can change who has access.');
      }
    }

    // -- reads with the database (after the checks above) ------------------------------------------------
    const personRef = (person) =>
      person ? { person_id: person.person_id, name: personName(person), can_sign_in: !isBlank(person.user_id) } : null;

    async function loadRecord(db, cfg, id) {
      const columns = [cfg.key, cfg.ownerField, ...(cfg.ownerTeam ? ['owner_team_id'] : []), 'restricted', ...cfg.parents, ...cfg.code, ...cfg.title];
      const row = await db(cfg.collection).where(cfg.key, id).first(...new Set(columns));
      if (!row) throw new HttpError(404, 'NOT_FOUND', 'That record does not exist, or you cannot see it.');
      return row;
    }

    const PERSON_COLUMNS = ['person_id', 'full_name', 'email', 'user_id', 'active'];
    async function personById(db, personId) {
      return (await db('people').where('person_id', personId).first(...PERSON_COLUMNS)) ?? null;
    }

    // The merged entries: the access table plus the old co-owner / investigator rows, one per person, strongest role.
    async function buildEntries(db, cfg, id, record, acc) {
      // a person's OWN rows only: the derived rows of a team grant (team_access_id set) are the teams list, not entries
      const accessRows = await db(cfg.table).where(cfg.fk, id).whereNull('team_access_id').select('person_id', 'role', 'added_by_person_id', 'created_at');
      const legacyRows = cfg.legacy ? await db(cfg.legacy.table).where(cfg.legacy.fk, id).select('user_id') : [];

      const personIds = [...new Set([...accessRows.map((r) => r.person_id), ...accessRows.map((r) => r.added_by_person_id)].filter((v) => !isBlank(v)))];
      const byPerson = new Map();
      if (personIds.length) for (const p of await db('people').whereIn('person_id', personIds).select(...PERSON_COLUMNS)) byPerson.set(String(p.person_id), p);
      const legacyUserIds = [...new Set(legacyRows.map((r) => r.user_id).filter((v) => !isBlank(v)))];
      const byLogin = new Map();
      if (legacyUserIds.length) for (const p of await db('people').whereIn('user_id', legacyUserIds).select(...PERSON_COLUMNS)) byLogin.set(String(p.user_id), p);
      const loginOnly = legacyUserIds.filter((u) => !byLogin.has(String(u)));
      const users = new Map();
      if (loginOnly.length) for (const u of await db('directus_users').whereIn('id', loginOnly).select('id', 'first_name', 'last_name', 'email')) users.set(String(u.id), u);

      const ownerId = record[cfg.ownerField];
      const merged = new Map(); // person_id (or 'login:<id>') -> entry
      const put = (key, entry) => {
        const had = merged.get(key);
        if (!had || ROLE_RANK[entry.role] > ROLE_RANK[had.role]) merged.set(key, entry);
      };
      for (const row of accessRows) {
        const person = byPerson.get(String(row.person_id));
        if (!person || String(row.person_id) === String(ownerId ?? '')) continue; // the owner is not an entry
        const adder = byPerson.get(String(row.added_by_person_id));
        put(String(row.person_id), {
          person_id: person.person_id, name: personName(person), role: row.role, source: 'access', user_id: person.user_id ?? null,
          can_sign_in: !isBlank(person.user_id), added_by: adder ? personName(adder) : null,
          added_at: row.created_at instanceof Date ? row.created_at.toISOString() : (row.created_at ?? null),
        });
      }
      for (const row of legacyRows) {
        const person = byLogin.get(String(row.user_id));
        if (person && String(person.person_id) === String(ownerId ?? '')) continue;
        const source = cfg.legacy.role === 'investigator' ? 'investigator' : 'co_owner';
        // A login with no People row cannot be managed through person_id: listed with person_id null, by its login's name.
        put(person ? String(person.person_id) : `login:${row.user_id}`, {
          person_id: person?.person_id ?? null, name: person ? personName(person) : userName(users.get(String(row.user_id))),
          role: cfg.legacy.role, source, user_id: row.user_id, can_sign_in: true, added_by: null, added_at: null,
        });
      }
      const entries = [...merged.values()];
      await markBlocked(db, cfg, id, record, entries, acc);
      return entries
        .sort((a, b) => ROLE_RANK[b.role] - ROLE_RANK[a.role] || a.name.localeCompare(b.name))
        .map(({ user_id, ...entry }) => ({ ...entry, label: roleLabel(cfg.collection, entry.role, entry.source), blocked_by: entry.blocked_by ?? null }));
    }

    // blocked_by: can this person read the record now? Asked of the record's OWN readers table (the read rule itself, kept in step by the
    // triggers of migration 166, so it is exact whatever hides the record: a restricted sample, campaign or project, a campaign shield,
    // the sample's project). A person with a login who is in the table (or an admin: admins are not listed) is not blocked; a person
    // with a login who is not is blocked by a parent; a person with NO login is blocked until an admin links one.
    //   { reason: 'parent' | 'no_login', collection, id, kind, code }
    // collection, id, kind and code name the nearest parent (sample, campaign, project) that the person cannot read, and ONLY when the
    // CALLER can read that parent: a restricted parent's code is never sent to someone who cannot see it. Otherwise they are all null
    // and the dialog and the email use the generic words.
    const NO_PARENT = { collection: null, id: null, kind: null, code: null };
    const blockedLogin = () => ({ reason: 'no_login', ...NO_PARENT });

    async function isAdminLogin(db, userId) {
      const user = await db('directus_users').where('id', userId).first('role');
      const direct = await db('directus_access').where('user', userId).select('policy');
      const viaRole = !isBlank(user?.role) ? await db('directus_access').where('role', user.role).select('policy') : [];
      const policies = [...new Set([...direct, ...viaRole].map((a) => a.policy).filter((v) => !isBlank(v)))];
      if (!policies.length) return false;
      return Boolean(await db('directus_policies').whereIn('id', policies).where('admin_access', true).first('id'));
    }

    async function readersAmong(db, table, recordId, userIds) {
      if (!userIds.length) return new Set();
      const rows = await db(table).where('record_id', recordId).whereIn('user_id', userIds).select('user_id');
      return new Set(rows.map((r) => String(r.user_id)));
    }

    // Fills entry.blocked_by (null, or the object above) for every entry. Each entry needs `user_id` (the login or null) and `person_id`.
    async function markBlocked(db, cfg, id, record, entries, acc) {
      const logins = [...new Set(entries.filter((e) => !isBlank(e.user_id)).map((e) => String(e.user_id)))];
      const readers = await readersAmong(db, cfg.readers, id, logins);
      const pending = [];
      for (const entry of entries) {
        if (isBlank(entry.user_id)) entry.blocked_by = blockedLogin();
        else if (readers.has(String(entry.user_id))) entry.blocked_by = null;
        else pending.push(entry);
      }
      const blocked = [];
      for (const entry of pending) {
        if (await isAdminLogin(db, entry.user_id)) entry.blocked_by = null;
        else blocked.push(entry);
      }
      if (!blocked.length) return;
      const named = new Map(); // user id -> the nearest parent the caller can read and the person cannot
      for (const column of cfg.parents) {
        const parentId = record[column];
        const parent = PARENTS[column];
        if (isBlank(parentId)) continue;
        const callerReads = acc.admin === true || (await readersAmong(db, parent.readers, parentId, [String(acc.user)])).size > 0;
        if (!callerReads) continue;
        const theirs = await readersAmong(db, parent.readers, parentId, [...new Set(blocked.map((e) => String(e.user_id)))]);
        const open = blocked.filter((e) => !theirs.has(String(e.user_id)) && !named.has(String(e.user_id)));
        if (!open.length) continue;
        const row = await db(parent.collection).where(parent.key, parentId).first(parent.key, ...parent.code);
        if (!row) continue;
        for (const e of open) named.set(String(e.user_id), { collection: parent.collection, id: String(parentId), kind: parent.kind, code: firstOf(row, parent.code) });
      }
      for (const entry of blocked) entry.blocked_by = { reason: 'parent', ...(named.get(String(entry.user_id)) ?? NO_PARENT) };
    }

    // The blocked_by of one person (a recipient, a new owner), or null.
    async function blockedFor(db, cfg, id, record, person, acc) {
      const probe = { person_id: person.person_id, user_id: person.user_id ?? null, blocked_by: null };
      await markBlocked(db, cfg, id, record, [probe], acc);
      return probe.blocked_by;
    }

    // Can the caller read the record's parent (project, campaign, sample)? A projects record is its own project, already readable.
    async function callerReadsParent({ acc, cfg }, column, record) {
      if (cfg.collection === 'projects' || acc.admin === true) return true;
      const parentId = record[column];
      if (isBlank(parentId)) return true;
      return (await readersAmong(database, PARENTS[column].readers, parentId, [String(acc.user)])).size > 0;
    }

    async function projectPi(db, cfg, record) {
      if (cfg.collection === 'projects') return isBlank(record[cfg.ownerField]) ? null : personById(db, record[cfg.ownerField]);
      if (isBlank(record.project_id)) return null;
      const project = await db('projects').where('project_id', record.project_id).first('principal_investigator_person');
      return project && !isBlank(project.principal_investigator_person) ? personById(db, project.principal_investigator_person) : null;
    }

    // -- email and cache (after the commit) ----------------------------------------------------------------
    async function clearDataCache(req) {
      if (!toBool(env?.CACHE_ENABLED)) return;
      try {
        await new services.UtilsService({ schema: req.schema, accountability: { user: null, role: null, admin: true, app: false } }).clearCache({ system: false });
      } catch (err) {
        warn(`could not clear the data cache: ${err?.message || err}`);
      }
    }

    async function callerName(db, acc) {
      const person = await db('people').where('user_id', acc.user).first('person_id', 'full_name');
      if (person) return { name: personName(person), personId: person.person_id };
      const user = await db('directus_users').where('id', acc.user).first('first_name', 'last_name', 'email');
      return { name: user ? userName(user) : 'Someone', personId: null };
    }

    // 'sent' | 'skipped' | 'failed'. Never throws.
    // `blocked`: the person's blocked_by when the caller already has it (the transfer answers with it), else it is looked up here.
    // `via`: the team the access comes through ("via <team name>" in the mail).
    async function sendMail({ req, acc, cfg, id, record, person, role, transfer, blocked, via = null, ownerTeam = null }) {
      try {
        if (isBlank(person?.person_id) || String(person.user_id ?? '') === String(acc.user)) return 'skipped'; // never mail the adder
        const user = isBlank(person.user_id) ? null : await database('directus_users').where('id', person.user_id).first('email');
        const to = recipientAddress(person, user);
        if (!to) return 'skipped';
        const { name } = await callerName(database, acc);
        // a person who cannot read the record yet (their own readers row is missing, or they have no login) is mailed the generic
        // wording: no title, no link, nothing of the parents above the record
        const stop = blocked === undefined ? await blockedFor(database, cfg, id, record, person, acc) : blocked;
        const content = mailContent({
          adder: name, role, kind: cfg.kind, code: firstOf(record, cfg.code), title: firstOf(record, cfg.title) !== firstOf(record, cfg.code) ? firstOf(record, cfg.title) : null,
          link: recordLink(env?.PUBLIC_URL, cfg.collection, id, env?.STARBASE_URL), transfer, blockedReason: stop?.reason ?? null, via, ownerTeam,
        });
        const mail = new services.MailService({ schema: req.schema, knex: database });
        await withTimeout(mail.send({ to, subject: content.subject, html: content.html, text: content.text }), MAIL_TIMEOUT_MS);
        return 'sent';
      } catch (err) {
        warn(`email for ${cfg.collection} ${id} was not sent: ${err?.message || err}`);
        return 'failed';
      }
    }

    // -- teams (derived rows are written by the database triggers; this endpoint writes only the grant) -------------------------
    const grantTable = (cfg) => `${cfg.kind}_team_access`;
    const pendingTable = (cfg) => `${cfg.kind}_team_pending`;

    // d1_private.team_pending_actionable (Ruling D2): is a pending member worth asking about?
    async function actionable(db, cfg, teamAccessId, personId) {
      const answer = (await db.raw('SELECT d1_private.team_pending_actionable(?, ?, ?) AS ok', [cfg.collection, teamAccessId, personId]))?.rows?.[0];
      return answer?.ok === true;
    }

    async function grantOf(db, cfg, id, teamId) {
      return (await db(grantTable(cfg)).where({ [cfg.fk]: id, team_id: teamId }).first('team_access_id', 'team_id', 'role', 'trust_new_members')) ?? null;
    }
    // The grant a route reads or changes: a team that only OWNS the record has none (the owner grant is not a team entry, Ruling O2).
    const NOT_LISTED = () => new HttpError(404, 'NOT_FOUND', 'That team does not have access to this record.');
    const OWNING = () => new HttpError(409, 'TEAM_OWNS_RECORD', 'That team owns this record, so its access follows the owner. Use Transfer ownership to change it.');
    async function requireGrant(db, cfg, id, teamId, { owning = NOT_LISTED } = {}) {
      const grant = await grantOf(db, cfg, id, teamId);
      if (!grant) throw NOT_LISTED();
      if (grant.role === 'own') throw owning();
      return grant;
    }

    // The team entries of a record: [{ team_access_id, team_id, name, color, logo, member_count, role, trust_new_members, waiting, declined }]
    async function buildTeams(db, cfg, id) {
      // Ruling O2: the owner grant (role own) is the owner row, never a team entry
      const grants = (await db(grantTable(cfg)).where(cfg.fk, id).select('team_access_id', 'team_id', 'role', 'trust_new_members')).filter((g) => g.role !== 'own');
      if (!grants.length) return [];
      const teamIds = [...new Set(grants.map((g) => g.team_id))];
      const teams = new Map((await db('teams').whereIn('team_id', teamIds).select('team_id', 'name', 'color', 'logo')).map((t) => [String(t.team_id), t]));
      const members = await db('team_members').whereIn('team_id', teamIds).select('team_id');
      const pending = await db(pendingTable(cfg)).whereIn('team_access_id', grants.map((g) => g.team_access_id)).select('team_access_id', 'person_id', 'state');
      const out = [];
      for (const g of grants) {
        const team = teams.get(String(g.team_id));
        if (!team) continue;
        const mine = pending.filter((p) => same(p.team_access_id, g.team_access_id));
        let waiting = 0;
        for (const p of mine.filter((x) => x.state === 'pending')) if (await actionable(db, cfg, g.team_access_id, p.person_id)) waiting += 1;
        out.push({
          team_access_id: g.team_access_id, team_id: g.team_id, name: team.name, color: team.color ?? null, logo: team.logo ?? null,
          member_count: members.filter((m) => same(m.team_id, g.team_id)).length, role: g.role, trust_new_members: g.trust_new_members === true,
          waiting, declined: mine.filter((x) => x.state === 'declined').length,
        });
      }
      return out.sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')));
    }

    // The team entry as it reads now, for the answer (a failure after the commit answers team: null, like entryOf).
    async function teamOf(cfg, id, teamId) {
      try {
        return (await buildTeams(database, cfg, id)).find((t) => String(t.team_id) === String(teamId)) ?? null;
      } catch (err) {
        logger?.error?.(`${SOURCE}: the change to ${cfg.collection} ${id} is committed but reading its teams back failed: ${err?.stack || err?.message || err}`);
        return null;
      }
    }

    // The owner as the page shows it: a person, a team (with its managers, who act as the owner), or null.
    async function teamOwnerRef(db, teamId) {
      const team = await db('teams').where('team_id', teamId).first('team_id', 'name', 'color', 'logo');
      if (!team) return null;
      const managerIds = (await db('team_members').where('team_id', teamId).where('is_manager', true).select('person_id')).map((m) => m.person_id);
      const people = managerIds.length ? await db('people').whereIn('person_id', managerIds).select('person_id', 'full_name') : [];
      const managers = people.map((p) => ({ person_id: p.person_id, full_name: personName(p) })).sort((a, b) => a.full_name.localeCompare(b.full_name));
      return { kind: 'team', team_id: team.team_id, name: team.name, color: team.color ?? null, logo: team.logo ?? null, managers };
    }
    async function ownerOf(db, cfg, record) {
      if (cfg.ownerTeam && !isBlank(record.owner_team_id)) return teamOwnerRef(db, record.owner_team_id);
      if (isBlank(record[cfg.ownerField])) return null;
      const person = await personById(db, record[cfg.ownerField]);
      return person ? { kind: 'person', ...personRef(person) } : null;
    }

    // -- the routes ------------------------------------------------------------------------------------------
    router.get('/:collection/:id', route(async (args) => {
      const { res, cfg, id, acc } = args;
      await requireReadable(args);
      const record = await loadRecord(database, cfg, id);
      const owner = await ownerOf(database, cfg, record);
      // the project's PI is named only to a caller who can read that project (a sample reader need not): no hidden parent's details
      const pi = (await callerReadsParent(args, 'project_id', record)) ? await projectPi(database, cfg, record) : null;
      const manage = await canManage(args);
      const entries = await buildEntries(database, cfg, id, record, acc);
      const teams = await buildTeams(database, cfg, id);
      res.json({ restricted: toBool(record.restricted), owner, project_pi: personRef(pi), can_manage: manage, entries, teams });
    }));

    const parseRole = (cfg, body) => {
      if (!isObject(body)) throw new HttpError(400, 'INVALID_PAYLOAD', 'Send a JSON body.');
      if (typeof body.role !== 'string' || !cfg.roles.includes(body.role)) {
        throw new HttpError(400, 'INVALID_PAYLOAD', `The role must be one of: ${cfg.roles.join(', ')}.`);
      }
      return body.role;
    };
    const parsePersonId = (value) => {
      if (typeof value !== 'string' || !UUID.test(value)) throw new HttpError(400, 'INVALID_PAYLOAD', 'person_id must be a person id.');
      return value;
    };

    // One write transaction: the actor first, so the audit trigger names the caller.
    const inTransaction = (acc, work) =>
      database.transaction(async (trx) => {
        await trx.raw("SELECT set_config('d1.actor_identity', ?, true)", [String(acc.user)]);
        return work(trx);
      });

    async function requireActivePerson(trx, personId) {
      const person = await personById(trx, personId);
      if (!person) throw new HttpError(400, 'INVALID_PAYLOAD', 'That person does not exist.');
      if (person.active === false) throw new HttpError(400, 'INVALID_PAYLOAD', 'That person is not active.');
      return person;
    }

    // The person's rows in both stores: the access row and the old-table row (by the person's login).
    async function rowsOf(trx, cfg, id, person) {
      const access = (await trx(cfg.table).where({ [cfg.fk]: id, person_id: person.person_id }).whereNull('team_access_id').first('person_id', 'role')) ?? null;
      const legacy = cfg.legacy && !isBlank(person.user_id)
        ? ((await trx(cfg.legacy.table).where({ [cfg.legacy.fk]: id, user_id: person.user_id }).first('user_id')) ?? null)
        : null;
      return { access, legacy };
    }
    const dropLegacy = (trx, cfg, id, person) =>
      cfg.legacy && !isBlank(person.user_id) ? trx(cfg.legacy.table).where({ [cfg.legacy.fk]: id, user_id: person.user_id }).del() : null;
    // The conflict target names the partial unique index of a person's own rows (a derived team row of the same person is another row):
    // ON CONFLICT (fk, person_id) WHERE team_access_id IS NULL. (A `where` after merge() would be the DO UPDATE filter, not the index.)
    const upsertAccess = (trx, cfg, id, person, role, addedBy) =>
      trx(cfg.table)
        .insert({ [cfg.fk]: id, person_id: person.person_id, role, added_by_person_id: addedBy })
        .onConflict(trx.raw('(??, ??) WHERE ?? IS NULL', [cfg.fk, 'person_id', 'team_access_id']))
        .merge({ role });

    // The entry as it reads now, for the answer. The change is already committed (and the mail sent), so a failure here is logged and
    // answers entry: null instead of turning a committed change into a 500.
    async function entryOf(cfg, id, personId, acc) {
      try {
        const record = await loadRecord(database, cfg, id);
        return (await buildEntries(database, cfg, id, record, acc)).find((e) => String(e.person_id) === String(personId)) ?? null;
      } catch (err) {
        logger?.error?.(`${SOURCE}: the change to ${cfg.collection} ${id} is committed but reading it back failed: ${err?.stack || err?.message || err}`);
        return null;
      }
    }

    router.post('/:collection/:id/entries', route(async (args) => {
      const { req, res, acc, cfg, id } = args;
      if (isObject(req.body) && req.body.team_id !== undefined) return addTeam(args);
      const role = parseRole(cfg, req.body);
      const personId = parsePersonId(req.body.person_id);
      await requireReadable(args);
      const done = await inTransaction(acc, async (trx) => {
        await requireManage(args, trx);
        const record = await loadRecord(trx, cfg, id);
        const person = await requireActivePerson(trx, personId);
        if (!isBlank(record[cfg.ownerField]) && String(record[cfg.ownerField]) === String(person.person_id)) {
          throw new HttpError(409, 'CONFLICT', 'That person is the owner already.');
        }
        const had = await rowsOf(trx, cfg, id, person);
        const caller = await callerName(trx, acc);
        await upsertAccess(trx, cfg, id, person, role, caller.personId);
        await dropLegacy(trx, cfg, id, person);
        return { record, person, newGrant: !had.access && !had.legacy };
      });
      await clearDataCache(req);
      const email = done.newGrant ? await sendMail({ req, acc, cfg, id, record: done.record, person: done.person, role: roleLabel(cfg.collection, role), transfer: false }) : 'skipped';
      res.json({ entry: await entryOf(cfg, id, personId, acc), email });
    }));

    router.patch('/:collection/:id/entries/:person_id', route(async (args) => {
      const { req, res, acc, cfg, id } = args;
      const role = parseRole(cfg, req.body);
      const personId = parsePersonId(req.params.person_id);
      await requireReadable(args);
      await inTransaction(acc, async (trx) => {
        await requireManage(args, trx);
        const person = await personById(trx, personId);
        const had = person ? await rowsOf(trx, cfg, id, person) : { access: null, legacy: null };
        if (!person || (!had.access && !had.legacy)) throw new HttpError(404, 'NOT_FOUND', 'That person is not on the list.');
        const caller = await callerName(trx, acc);
        await upsertAccess(trx, cfg, id, person, role, caller.personId); // a legacy-only person becomes an access row
        await dropLegacy(trx, cfg, id, person);
      });
      await clearDataCache(req);
      res.json({ entry: await entryOf(cfg, id, personId, acc), email: 'skipped' });
    }));

    router.delete('/:collection/:id/entries/:person_id', route(async (args) => {
      const { req, res, acc, cfg, id } = args;
      const personId = parsePersonId(req.params.person_id);
      await requireReadable(args);
      await inTransaction(acc, async (trx) => {
        await requireManage(args, trx);
        const person = await personById(trx, personId);
        const had = person ? await rowsOf(trx, cfg, id, person) : { access: null, legacy: null };
        if (!person || (!had.access && !had.legacy)) throw new HttpError(404, 'NOT_FOUND', 'That person is not on the list.');
        await trx(cfg.table).where({ [cfg.fk]: id, person_id: person.person_id }).whereNull('team_access_id').del(); // derived rows stay
        await dropLegacy(trx, cfg, id, person);
      });
      await clearDataCache(req);
      res.json({ removed: true });
    }));

    // -- teams: the routes -------------------------------------------------------------------------------------
    const parseTeamId = (value) => {
      if (typeof value !== 'string' || !UUID.test(value)) throw new HttpError(400, 'INVALID_PAYLOAD', 'team_id must be a team id.');
      return value;
    };

    // The active members of a team (they get a derived row of their own), mailed when the team is given access: an active person with a
    // login, minus those waiting or declined on this grant. sendMail then looks at the login's address and never mails the adder.
    async function teamRecipients(cfg, grant) {
      const memberIds = (await database('team_members').where('team_id', grant.team_id).select('person_id')).map((m) => m.person_id);
      if (!memberIds.length) return [];
      const held = new Set((await database(pendingTable(cfg)).where('team_access_id', grant.team_access_id).select('person_id')).map((p) => String(p.person_id)));
      const people = await database('people').whereIn('person_id', memberIds).select(...PERSON_COLUMNS);
      return people.filter((p) => p.active !== false && !isBlank(p.user_id) && !held.has(String(p.person_id)));
    }

    async function addTeam(args) {
      const { req, res, acc, cfg, id } = args;
      const role = parseRole(cfg, req.body);
      const teamId = parseTeamId(req.body.team_id);
      await requireReadable(args);
      const done = await inTransaction(acc, async (trx) => {
        await requireManage(args, trx);
        const record = await loadRecord(trx, cfg, id);
        const team = await trx('teams').where('team_id', teamId).first('team_id', 'name');
        if (!team) throw new HttpError(400, 'INVALID_PAYLOAD', 'That team does not exist.');
        const listed = () => new HttpError(409, 'TEAM_ALREADY_LISTED', 'That team already has access to this record.');
        const held = await grantOf(trx, cfg, id, teamId);
        if (held?.role === 'own') throw OWNING(); // the owning team is the owner, not a share
        if (held) throw listed();
        const caller = await callerName(trx, acc);
        try {
          await trx(grantTable(cfg)).insert({ [cfg.fk]: id, team_id: teamId, role, added_by_person_id: caller.personId });
        } catch (err) {
          if (err?.code === '23505') throw listed(); // two owners adding the same team at once
          throw err;
        }
        return { record, team, grant: await grantOf(trx, cfg, id, teamId) };
      });
      await clearDataCache(req);
      // one mail per active member with a login (the trigger gave them their rows); a failed mail never undoes the grant
      const emails = { sent: 0, skipped: 0, failed: 0 };
      let recipients = [];
      try {
        recipients = await teamRecipients(cfg, done.grant);
      } catch (err) {
        warn(`could not list the members to mail for ${cfg.collection} ${id}: ${err?.message || err}`);
      }
      const results = await Promise.all(
        recipients.map((person) => sendMail({ req, acc, cfg, id, record: done.record, person, role: roleLabel(cfg.collection, role), transfer: false, via: done.team.name })),
      );
      for (const r of results) emails[r] += 1;
      const email = emails.sent ? 'sent' : emails.failed ? 'failed' : 'skipped';
      res.json({ team: await teamOf(cfg, id, teamId), email, emails });
    }

    router.patch('/:collection/:id/entries/team/:team_id', route(async (args) => {
      const { req, res, acc, cfg, id } = args;
      const teamId = parseTeamId(req.params.team_id);
      if (!isObject(req.body)) throw new HttpError(400, 'INVALID_PAYLOAD', 'Send a JSON body.');
      const patch = {};
      if (req.body.role !== undefined) patch.role = parseRole(cfg, req.body);
      if (req.body.trust_new_members !== undefined) {
        if (typeof req.body.trust_new_members !== 'boolean') throw new HttpError(400, 'INVALID_PAYLOAD', 'trust_new_members must be true or false.');
        patch.trust_new_members = req.body.trust_new_members;
      }
      if (!Object.keys(patch).length) throw new HttpError(400, 'INVALID_PAYLOAD', 'Send a role or trust_new_members.');
      await requireReadable(args);
      await inTransaction(acc, async (trx) => {
        await requireManage(args, trx);
        await requireGrant(trx, cfg, id, teamId, { owning: OWNING });
        await trx(grantTable(cfg)).where({ [cfg.fk]: id, team_id: teamId }).update(patch); // the triggers move the derived and pending rows
      });
      await clearDataCache(req);
      res.json({ team: await teamOf(cfg, id, teamId) });
    }));

    router.delete('/:collection/:id/entries/team/:team_id', route(async (args) => {
      const { req, res, acc, cfg, id } = args;
      const teamId = parseTeamId(req.params.team_id);
      await requireReadable(args);
      await inTransaction(acc, async (trx) => {
        await requireManage(args, trx);
        await requireGrant(trx, cfg, id, teamId, { owning: OWNING });
        await trx(grantTable(cfg)).where({ [cfg.fk]: id, team_id: teamId }).del(); // the derived and pending rows go with it
      });
      await clearDataCache(req);
      res.json({ removed: true });
    }));

    // Who gets access through the grant: active (they have a derived row), waiting for approval, or declined. Anyone who can read the
    // record may look (the record's own list names its people to the same readers).
    router.get('/:collection/:id/entries/team/:team_id/members', route(async (args) => {
      const { res, cfg, id } = args;
      const teamId = parseTeamId(args.req.params.team_id);
      await requireReadable(args);
      const grant = await requireGrant(database, cfg, id, teamId);
      const derived = await database(cfg.table).where(cfg.fk, id).where('team_access_id', grant.team_access_id).select('person_id');
      const pending = await database(pendingTable(cfg)).where('team_access_id', grant.team_access_id).select('person_id', 'state', 'decided_at');
      const ids = [...new Set([...derived, ...pending].map((r) => r.person_id))];
      const byPerson = new Map();
      if (ids.length) for (const p of await database('people').whereIn('person_id', ids).select(...PERSON_COLUMNS)) byPerson.set(String(p.person_id), p);
      const named = (row, extra = {}) => {
        const person = byPerson.get(String(row.person_id));
        return { person_id: row.person_id, name: personName(person), can_sign_in: !isBlank(person?.user_id), ...extra };
      };
      const byName = (a, b) => a.name.localeCompare(b.name);
      const waiting = [];
      for (const row of pending.filter((r) => r.state === 'pending')) waiting.push(named(row, { actionable: await actionable(database, cfg, grant.team_access_id, row.person_id) }));
      res.json({
        active: derived.map((r) => named(r)).sort(byName),
        pending: waiting.sort(byName),
        declined: pending.filter((r) => r.state === 'declined').map((r) => named(r, { decided_at: r.decided_at instanceof Date ? r.decided_at.toISOString() : (r.decided_at ?? null) })).sort(byName),
      });
    }));

    // Approve or decline a waiting member on this record (d1_private.team_decide). The caller must manage the record. After an approval
    // the joiner is mailed, as for any new grant.
    router.post('/:collection/:id/entries/team/:team_id/members/:person_id', route(async (args) => {
      const { req, res, acc, cfg, id } = args;
      const teamId = parseTeamId(req.params.team_id);
      const personId = parsePersonId(req.params.person_id);
      if (!isObject(req.body) || (req.body.decision !== 'approve' && req.body.decision !== 'decline')) {
        throw new HttpError(400, 'INVALID_PAYLOAD', 'decision must be approve or decline.');
      }
      const { decision } = req.body;
      await requireReadable(args);
      const done = await inTransaction(acc, async (trx) => {
        await requireManage(args, trx);
        const record = await loadRecord(trx, cfg, id);
        const grant = await requireGrant(trx, cfg, id, teamId);
        const nothing = () => new HttpError(409, 'NOTHING_TO_DECIDE', 'That person is not waiting for approval on this record.');
        if (!(await trx(pendingTable(cfg)).where({ team_access_id: grant.team_access_id, person_id: personId }).first('state'))) throw nothing();
        try {
          await trx.raw('SELECT d1_private.team_decide(?, ?, ?, ?)', [cfg.collection, grant.team_access_id, personId, decision]);
        } catch (err) {
          if (err?.code === 'P0002') throw nothing(); // decided by someone else a moment ago
          throw err;
        }
        const team = await trx('teams').where('team_id', teamId).first('name');
        return { record, grant, team };
      });
      await clearDataCache(req);
      let email = 'skipped';
      if (decision === 'approve') {
        try {
          const person = await personById(database, personId);
          if (person) email = await sendMail({ req, acc, cfg, id, record: done.record, person, role: roleLabel(cfg.collection, done.grant.role), transfer: false, via: done.team?.name ?? null });
        } catch (err) {
          warn(`email for ${cfg.collection} ${id} was not sent: ${err?.message || err}`);
          email = 'failed';
        }
      }
      res.json({ decision, email });
    }));

    // Transfer ownership: to a person ({ person_id }) or, for the four ownable types, to a team ({ team_id }, Ruling O3: the only way a
    // record becomes team-owned). owner_person_id and owner_team_id change in ONE update, because the CHECK allows at most one of them.
    router.post('/:collection/:id/transfer', route(async (args) => {
      const { req, res, acc, cfg, id } = args;
      if (!isObject(req.body)) throw new HttpError(400, 'INVALID_PAYLOAD', 'Send a JSON body.');
      const toTeam = req.body.team_id !== undefined;
      if (toTeam && req.body.person_id !== undefined) throw new HttpError(400, 'INVALID_PAYLOAD', 'Send a person_id or a team_id, not both.');
      const targetId = toTeam ? parseTeamId(req.body.team_id) : parsePersonId(req.body.person_id);
      if (toTeam && !cfg.ownerTeam) throw new HttpError(409, 'NOT_OWNABLE_BY_TEAM', 'A team cannot own this kind of record.');
      await requireReadable(args);
      const keepRole = cfg.collection === 'projects' ? 'investigator' : 'edit';
      const done = await inTransaction(acc, async (trx) => {
        await requireManage(args, trx);
        const record = await loadRecord(trx, cfg, id);
        const caller = await callerName(trx, acc);
        const previousId = record[cfg.ownerField];
        let next = null;
        let team = null;
        if (toTeam) {
          team = await trx('teams').where('team_id', targetId).first('team_id', 'name');
          if (!team) throw new HttpError(400, 'INVALID_PAYLOAD', 'That team does not exist.');
          if (!isBlank(record.owner_team_id) && String(record.owner_team_id) === String(team.team_id)) throw new HttpError(409, 'CONFLICT', 'That team is the owner already.');
          await trx(cfg.collection).where(cfg.key, id).update({ owner_team_id: team.team_id, [cfg.ownerField]: null });
        } else {
          next = await requireActivePerson(trx, targetId);
          if (!isBlank(previousId) && String(previousId) === String(next.person_id)) throw new HttpError(409, 'CONFLICT', 'That person is the owner already.');
          await trx(cfg.collection).where(cfg.key, id).update({ [cfg.ownerField]: next.person_id, ...(cfg.ownerTeam ? { owner_team_id: null } : {}) });
        }
        // the previous PERSON owner stays on the record (Can edit; Secondary investigator on a project) ...
        if (!isBlank(previousId)) {
          const previous = await personById(trx, previousId);
          if (previous) {
            await upsertAccess(trx, cfg, id, previous, keepRole, caller.personId);
            await dropLegacy(trx, cfg, id, previous);
          }
        }
        // ... and a new person owner needs no list entry (a team owner's members get their rows from the database)
        if (next) {
          await trx(cfg.table).where({ [cfg.fk]: id, person_id: next.person_id }).whereNull('team_access_id').del(); // derived team rows stay
          await dropLegacy(trx, cfg, id, next);
        }
        return { record, next, team };
      });
      await clearDataCache(req);
      if (toTeam) return transferredToTeam(args, done);

      // blocked_by of the new owner (the spec: the dialog says so "on add and on transfer"); the change is made either way. A failed
      // lookup answers null here and the generic mail wording (the safe side).
      let blocked_by = null;
      let blockedKnown = true;
      try {
        blocked_by = await blockedFor(database, cfg, id, done.record, done.next, acc);
      } catch (err) {
        blockedKnown = false;
        logger?.error?.(`${SOURCE}: blocked_by of the new owner of ${cfg.collection} ${id} could not be read: ${err?.stack || err?.message || err}`);
      }
      const email = await sendMail({ req, acc, cfg, id, record: done.record, person: done.next, role: ownerLabel(cfg.collection), transfer: true, blocked: blockedKnown ? blocked_by : { reason: 'parent' } });
      res.json({ owner: { kind: 'person', ...personRef(done.next) }, email, blocked_by });
    }));

    // After a transfer to a team: the team's managers (they act as the owner) are mailed once each; the answer names the team as the owner.
    async function transferredToTeam({ req, res, acc, cfg, id }, done) {
      const emails = { sent: 0, skipped: 0, failed: 0 };
      try {
        const managerIds = (await database('team_members').where('team_id', done.team.team_id).where('is_manager', true).select('person_id')).map((m) => m.person_id);
        const managers = managerIds.length ? await database('people').whereIn('person_id', managerIds).select(...PERSON_COLUMNS) : [];
        const results = await Promise.all(
          managers
            .filter((p) => p.active !== false && !isBlank(p.user_id))
            .map((person) => sendMail({ req, acc, cfg, id, record: done.record, person, role: null, transfer: true, ownerTeam: done.team.name })),
        );
        for (const r of results) emails[r] += 1;
      } catch (err) {
        warn(`could not list the managers to mail for ${cfg.collection} ${id}: ${err?.message || err}`);
      }
      const email = emails.sent ? 'sent' : emails.failed ? 'failed' : 'skipped';
      let owner = { kind: 'team', team_id: done.team.team_id, name: done.team.name, color: null, logo: null, managers: [] };
      try {
        owner = (await teamOwnerRef(database, done.team.team_id)) ?? owner;
      } catch (err) {
        logger?.error?.(`${SOURCE}: the change to ${cfg.collection} ${id} is committed but reading its team owner back failed: ${err?.stack || err?.message || err}`);
      }
      res.json({ owner, email, emails, blocked_by: null });
    }
  },
};
