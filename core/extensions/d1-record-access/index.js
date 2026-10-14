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
// when the caller may not manage it; 409 adding or transferring to the owner.
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
  physical_samples: { readers: 'sample_readers', kind: 'sample', segment: 'samples', code: ['sample_code'], title: ['nickname'], parents: ['project_id'], legacy: { table: 'sample_co_owners', fk: 'sample_id', role: 'edit' } },
  manufacturing_operations: { readers: 'operation_readers', kind: 'operation', segment: 'operations', code: ['pass_code'], title: [], parents: ['sample_id', 'campaign_id', 'project_id'], legacy: null },
  test_sessions: { readers: 'test_readers', kind: 'test', segment: 'tests', code: ['test_code'], title: ['test_type'], parents: ['sample_id', 'campaign_id', 'project_id'], legacy: null },
  campaigns: { readers: 'campaign_readers', kind: 'campaign', segment: 'campaigns', code: ['campaign_code', 'name'], title: [], parents: ['project_id'], legacy: null },
  projects: { readers: 'project_readers', kind: 'project', segment: 'projects', code: ['project_code', 'project_name'], title: ['project_name'], parents: [], legacy: { table: 'project_investigators', fk: 'project_id', role: 'investigator' } },
};

// collection -> { kind, segment, table, fk, key, ownerField, roles, manage, code, title, parents, legacy }
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
export function mailContent({ adder, role, kind, code, title, link, transfer = false, blockedReason = null }) {
  const who = oneLine(adder) || 'Someone';
  const what = [oneLine(kind), oneLine(code)].filter(Boolean).join(' ') || 'a record';
  const verb = transfer ? 'made you the owner of' : 'gave you access to';
  const subject = `${who} ${verb} ${what}`;
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
    `${who} ${verb} the ${what}${named ? ` (${named})` : ''}.`,
    roleLine ? `Your role: ${roleLine}.` : null,
    wait,
    openLink ? `Open it here: ${openLink}` : null,
    '',
    'If you did not expect this, you can ignore this email.',
  ]
    .filter((line) => line !== null)
    .join('\n');
  const html = [
    `<p><strong>${escapeHtml(who)}</strong> ${verb} the ${escapeHtml(what)}${named ? ` (${escapeHtml(named)})` : ''}.</p>`,
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
      const columns = [cfg.key, cfg.ownerField, 'restricted', ...cfg.parents, ...cfg.code, ...cfg.title];
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
      const accessRows = await db(cfg.table).where(cfg.fk, id).select('person_id', 'role', 'added_by_person_id', 'created_at');
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
    async function sendMail({ req, acc, cfg, id, record, person, role, transfer, blocked }) {
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
          link: recordLink(env?.PUBLIC_URL, cfg.collection, id, env?.STARBASE_URL), transfer, blockedReason: stop?.reason ?? null,
        });
        const mail = new services.MailService({ schema: req.schema, knex: database });
        await withTimeout(mail.send({ to, subject: content.subject, html: content.html, text: content.text }), MAIL_TIMEOUT_MS);
        return 'sent';
      } catch (err) {
        warn(`email for ${cfg.collection} ${id} was not sent: ${err?.message || err}`);
        return 'failed';
      }
    }

    // -- the routes ------------------------------------------------------------------------------------------
    router.get('/:collection/:id', route(async (args) => {
      const { res, cfg, id, acc } = args;
      await requireReadable(args);
      const record = await loadRecord(database, cfg, id);
      const owner = isBlank(record[cfg.ownerField]) ? null : await personById(database, record[cfg.ownerField]);
      // the project's PI is named only to a caller who can read that project (a sample reader need not): no hidden parent's details
      const pi = (await callerReadsParent(args, 'project_id', record)) ? await projectPi(database, cfg, record) : null;
      const manage = await canManage(args);
      const entries = await buildEntries(database, cfg, id, record, acc);
      res.json({ restricted: toBool(record.restricted), owner: personRef(owner), project_pi: personRef(pi), can_manage: manage, entries });
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
      const access = (await trx(cfg.table).where({ [cfg.fk]: id, person_id: person.person_id }).first('person_id', 'role')) ?? null;
      const legacy = cfg.legacy && !isBlank(person.user_id)
        ? ((await trx(cfg.legacy.table).where({ [cfg.legacy.fk]: id, user_id: person.user_id }).first('user_id')) ?? null)
        : null;
      return { access, legacy };
    }
    const dropLegacy = (trx, cfg, id, person) =>
      cfg.legacy && !isBlank(person.user_id) ? trx(cfg.legacy.table).where({ [cfg.legacy.fk]: id, user_id: person.user_id }).del() : null;
    const upsertAccess = (trx, cfg, id, person, role, addedBy) =>
      trx(cfg.table).insert({ [cfg.fk]: id, person_id: person.person_id, role, added_by_person_id: addedBy }).onConflict([cfg.fk, 'person_id']).merge({ role });

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
        await trx(cfg.table).where({ [cfg.fk]: id, person_id: person.person_id }).del();
        await dropLegacy(trx, cfg, id, person);
      });
      await clearDataCache(req);
      res.json({ removed: true });
    }));

    router.post('/:collection/:id/transfer', route(async (args) => {
      const { req, res, acc, cfg, id } = args;
      if (!isObject(req.body)) throw new HttpError(400, 'INVALID_PAYLOAD', 'Send a JSON body.');
      const personId = parsePersonId(req.body.person_id);
      await requireReadable(args);
      const keepRole = cfg.collection === 'projects' ? 'investigator' : 'edit';
      const done = await inTransaction(acc, async (trx) => {
        await requireManage(args, trx);
        const record = await loadRecord(trx, cfg, id);
        const next = await requireActivePerson(trx, personId);
        const previousId = record[cfg.ownerField];
        if (!isBlank(previousId) && String(previousId) === String(next.person_id)) throw new HttpError(409, 'CONFLICT', 'That person is the owner already.');
        const caller = await callerName(trx, acc);
        await trx(cfg.collection).where(cfg.key, id).update({ [cfg.ownerField]: next.person_id });
        // the previous owner stays on the record (Can edit; Secondary investigator on a project) ...
        if (!isBlank(previousId)) {
          const previous = await personById(trx, previousId);
          if (previous) {
            await upsertAccess(trx, cfg, id, previous, keepRole, caller.personId);
            await dropLegacy(trx, cfg, id, previous);
          }
        }
        // ... and the new owner needs no list entry
        await trx(cfg.table).where({ [cfg.fk]: id, person_id: next.person_id }).del();
        await dropLegacy(trx, cfg, id, next);
        return { record, next };
      });
      await clearDataCache(req);
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
      res.json({ owner: personRef(done.next), email, blocked_by });
    }));
  },
};
