// Directus endpoint: d1-teams  (mounted at /d1-teams)
//
// Teams, their members and managers, and the approvals of members who joined after a record was shared with the team
// (People 2, spec docs/superpowers/specs/2026-10-14-people-and-teams-design.md sections 2 and 3.1; tables of migrations 181 and 182).
// Teams and membership change ONLY through this endpoint (a Lab Member's Directus rights on the team tables are read-only).
//
//   GET    /d1-teams                       -> { teams: [{ team_id, name, description, color, logo, member_count,
//                                                         managers: [{ person_id, full_name }], is_member, is_manager }] }
//   GET    /d1-teams/:id                   -> { team, members: [{ person_id, full_name, can_sign_in, is_manager, joined_at }],
//                                               counts: { view, edit, investigator, owns }, records: [{ collection, id, kind, code, title, role }],
//                                               hidden_count, events: [...] }
//        counts are over every grant of the team (owns: the records the team OWNS, owner_team_id; their owner grant is a record with role
//        'own'). records are the granted records the caller READS (<kind>_readers; an administrator
//        reads all); hidden_count is the rest. events: the last 20, newest first (?events=all for every one); an event about a
//        record the caller cannot read carries no record, no person and no detail (record_hidden: true; kind, at and actor stay).
//        team_events has no Lab Member read permission in Directus: this endpoint is the only way to read the history.
//   GET    /d1-teams/:id/records?collection=<c>&limit=<n>  -> { ids: [...], truncated }  the ids of the records of ONE collection
//                                          (physical_samples, manufacturing_operations, test_sessions, campaigns or projects) that the team owns
//                                          (owner_team_id) or has a grant on (<kind>_team_access, which includes the hidden 'own' grant of an owned
//                                          record: deduplicated), INTERSECTED with the caller's <kind>_readers (an administrator reads all), newest
//                                          first by the record's updated_at. limit defaults to and is capped at 300 (300 ids fit a GET URL under
//                                          Node's 16 KiB header limit); < 1 or not a number is 400. truncated: there were more than `limit`.
//                                          The index pages filter on these ids.
//   GET    /d1-teams/mine/recent?limit=20  -> { items: [{ collection, id, kind, code, title, team_id, team_name, team_color, changed_at }] }
//                                          the most recently changed records (updated_at) of the caller's own teams (as owner or grantee),
//                                          only those the caller reads; a record of two of their teams appears once; limit defaults to 20, max 100.
//   POST   /d1-teams                       { name, description?, color? } -> 201 team; the caller (who needs a person, else 409 NO_PERSON)
//                                          becomes its manager; 409 TEAM_NAME_TAKEN
//   PATCH  /d1-teams/:id                   { name?, description?, color?, logo? }  manager or administrator. logo: a directus_files id of an
//                                          image/png, image/jpeg or image/svg+xml of at most 1 MB (else 400 BAD_LOGO), or null to clear it
//   DELETE /d1-teams/:id                   manager or administrator; the grants go with the team; each affected record's owner is mailed once.
//                                          A team that owns records is refused: 409 TEAM_OWNS_RECORDS, extensions.counts = records per
//                                          collection (physical_samples, manufacturing_operations, test_sessions, campaigns); the foreign
//                                          key owner_team_id (ON DELETE RESTRICT, migration 183) raises 23503 and nothing is deleted
//   POST   /d1-teams/:id/members           { person_id, is_manager? }  manager or administrator
//                                          -> 201 { pending, owners_asked, owned_edit }
//        pending: the joiner's pending rows that are worth asking about (Ruling D2, d1_private.team_pending_actionable). owners_asked: the
//        owners of those records, not counting the caller. Each of those owners is mailed ONCE for this joiner, listing kind and code of
//        their records (the owner of a team-owned record is the team's managers). owned_edit: the records the team owns: the joiner has
//        Can edit on them at once (a manager: manage), the owner grant trusts new members.
//   PATCH  /d1-teams/:id/members/:person_id  { is_manager }   manager or administrator
//   DELETE /d1-teams/:id/members/:person_id  manager, administrator, or the person themself
//        The last manager cannot leave or be demoted while others remain: the deferred constraint of migration 181 raises 23514 at COMMIT,
//        which is answered as 409 LAST_MANAGER "Make someone else a manager first".
//   GET    /d1-teams/pending               -> { items: [{ team_id, team_name, person_id, full_name, records: [{ collection, id, kind, code,
//                                               title, role }] }] }  the actionable pending rows on records the caller OWNS (owner column,
//                                               or the PI for a project; an administrator included), grouped by joiner and team
//   POST   /d1-teams/pending/decide        { team_id, person_id, decision: 'approve' | 'decline', records?: [{ collection, id }] }
//                                          -> { decision, decided, records }  d1_private.team_decide for each record the caller owns (all of
//                                          them when `records` is absent, an administrator included), or only `records` (deduplicated), where an
//                                          administrator may decide any single record; one the caller may not decide is 403 and nothing is
//                                          applied. The joiner is mailed on approve.
//
// "Owns a record": the caller's person is the record's owner (owner_person_id; principal_investigator_person for a project), or a MANAGER
// of the team that owns it (owner_team_id, migration 183). "Manages" (decide with an explicit record) is owns, or an administrator.
//
// After a commit nothing may turn the answer into a 500: the reads that build the answer or the mail are logged and fall back to what is
// known (afterCommit), as d1-record-access does.
//
// Writes: one knex transaction with set_config('d1.actor_identity', <caller>, true) so the history triggers name the caller; the Directus
// data cache is cleared after the commit (CACHE_ENABLED); mail goes out after the commit and NEVER undoes a change (a failure is logged).
// The recipient is directus_users.email for a person with a login, people.email only for a person without one (as d1-record-access).
//
// Errors use the Directus shape { errors: [{ message, extensions: { code, source: 'd1-teams' } }] }.

import { accountAdmin } from '../d1-people-admin/index.js';
import { COLLECTIONS, READ_ONLY_ROLE_MESSAGE, isLabViewer, isWriteRequest, recipientAddress, roleLabel, withTimeout } from '../d1-record-access/index.js';

const SOURCE = 'd1-teams';
const DEFAULT_LAB_ADMIN_ROLE_ID = '10000001-0000-0000-0000-000000000001';
const MAIL_TIMEOUT_MS = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PALETTE = ['teal', 'blue', 'indigo', 'violet', 'pink', 'red', 'orange', 'amber', 'green', 'slate'];
const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/svg+xml'];
const MAX_LOGO_BYTES = 1048576;
const EVENTS_SHOWN = 20;
const CHUNK = 1000;
const MAX_TEAM_RECORDS = 300;
const LEVELS = ['view', 'edit', 'investigator'];
const RECORD_TYPES = Object.values(COLLECTIONS);
const OWNABLE_TYPES = RECORD_TYPES.filter((cfg) => cfg.ownerTeam); // the four types a team can own (not projects)

class HttpError extends Error {
  constructor(status, code, message, extensions = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extensions = extensions;
  }
}

const isBlank = (v) => v === undefined || v === null || v === '';
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const toBool = (v) => v === true || v === 'true' || v === 1 || v === '1';
const trimmed = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const sameId = (a, b) => !isBlank(a) && !isBlank(b) && String(a).toLowerCase() === String(b).toLowerCase();
const isUuid = (v) => typeof v === 'string' && UUID.test(v);
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
const personName = (p) => trimmed(p?.full_name) ?? 'Unnamed person';
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const accessTable = (cfg) => `${cfg.kind}_team_access`;
const pendingTable = (cfg) => `${cfg.kind}_team_pending`;
const recordKey = (collection, id) => `${collection}/${String(id).toLowerCase()}`;

// ---- mail text (exported for the tests) ---------------------------------------------------------------------

// { subject, text, html } from an intro, the record lines and an outro; every interpolated value is HTML-escaped, nothing is a template.
export function mailContent({ subject, intro, lines = [], outro = null, link = null }) {
  const text = [intro, '', ...lines.map((l) => `- ${l}`), ...(lines.length ? [''] : []), ...(outro ? [outro] : []), ...(link ? [link] : [])].join('\n').trim();
  const html = [
    `<p>${escapeHtml(intro)}</p>`,
    lines.length ? `<ul>${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>` : '',
    outro ? `<p>${escapeHtml(outro)}</p>` : '',
    link ? `<p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>` : '',
  ].filter(Boolean).join('\n');
  return { subject, text, html };
}

// ---- the endpoint -----------------------------------------------------------------------------------------

export default {
  id: SOURCE,
  handler: (router, context) => {
    const { database, logger, services, env } = context;
    const warn = (message) => logger?.warn?.(`${SOURCE}: ${message}`);
    const labAdminRoleId = trimmed(env?.D1_LAB_ADMIN_ROLE_ID) ?? DEFAULT_LAB_ADMIN_ROLE_ID;
    const starbaseLink = () => {
      const base = trimmed(env?.STARBASE_URL);
      return base ? base.replace(/\/+$/, '') : null;
    };

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
        // a Lab Viewer changes nothing: no team, member, decision or pending approval (a viewer may manage a team or own records; that must not matter)
        const labViewer = await isLabViewer(database, acc.user);
        if (labViewer && isWriteRequest(req)) throw new HttpError(403, 'READ_ONLY_ROLE', READ_ONLY_ROLE_MESSAGE);
        const caller = await accountAdmin(database, acc.user, labAdminRoleId);
        const admin = acc.admin === true || caller.admin;
        // `admin` stays the right to CHANGE things (a viewer has none); a Lab Viewer's lists are filtered by the readers rows as that viewer, like any member's (only an administrator is unfiltered)
        await fn({ req, res, acc, admin, labViewer });
      } catch (err) {
        return sendError(res, err);
      }
    };

    // ---- reading helpers ---------------------------------------------------------------------------------

    // rows of `table` whose `col` is in `ids`, in chunks; `scope` adds conditions to each query
    async function selectIn(db, table, col, ids, cols, scope = (q) => q) {
      const out = [];
      for (const part of chunks([...new Set(ids.map(String))], CHUNK)) out.push(...(await scope(db(table)).whereIn(col, part).select(...cols)));
      return out;
    }
    async function loadPeople(db, ids) {
      const rows = await selectIn(db, 'people', 'person_id', ids.filter((v) => !isBlank(v)), ['person_id', 'full_name', 'email', 'user_id']);
      return new Map(rows.map((p) => [String(p.person_id), p]));
    }
    const callerPerson = async (db, acc) => (await db('people').where('user_id', acc.user).first('person_id', 'full_name', 'email', 'user_id')) ?? null;

    async function teamOr404(db, id) {
      if (!isUuid(id)) throw new HttpError(400, 'INVALID_PAYLOAD', 'The team id is not valid.');
      const team = await db('teams').where('team_id', id).first('team_id', 'name', 'description', 'color', 'logo', 'created_by_person_id');
      if (!team) throw new HttpError(404, 'NOT_FOUND', 'That team does not exist.');
      return team;
    }
    async function isManagerOf(db, teamId, person) {
      if (!person) return false;
      const row = await db('team_members').where('team_id', teamId).where('person_id', person.person_id).first('is_manager');
      return row?.is_manager === true;
    }
    async function requireManager(db, teamId, person, admin) {
      if (!admin && !(await isManagerOf(db, teamId, person))) throw new HttpError(403, 'FORBIDDEN', 'Only a team manager can do this.');
    }

    // [{ team_id, name, description, color, logo, member_count, managers, is_member, is_manager }] for `teams`, in name order
    async function teamItems(db, me, teams) {
      if (!teams.length) return [];
      const members = await selectIn(db, 'team_members', 'team_id', teams.map((t) => t.team_id), ['team_id', 'person_id', 'is_manager']);
      const people = await loadPeople(db, members.filter((m) => m.is_manager).map((m) => m.person_id));
      return teams
        .map((t) => {
          const mine = members.filter((m) => sameId(m.team_id, t.team_id));
          const myRow = me ? mine.find((m) => sameId(m.person_id, me.person_id)) : null;
          return {
            team_id: t.team_id,
            name: t.name,
            description: t.description ?? null,
            color: t.color ?? 'teal',
            logo: t.logo ?? null,
            member_count: mine.length,
            managers: mine
              .filter((m) => m.is_manager)
              .map((m) => ({ person_id: m.person_id, full_name: people.get(String(m.person_id))?.full_name ?? null }))
              .sort(byText('full_name')),
            is_member: Boolean(myRow),
            is_manager: myRow?.is_manager === true,
          };
        })
        .sort(byText('name'));
    }
    async function teamItem(db, me, teamId) {
      const team = await teamOr404(db, teamId);
      return (await teamItems(db, me, [team]))[0];
    }

    // Code and title of records, only those the viewer reads (viewer = login id; null = an administrator, who reads every existing record).
    // pairs: [{ collection, id }]. -> Map recordKey -> { collection, id, kind, code, title }
    async function describeRecords(db, pairs, viewer) {
      const out = new Map();
      for (const cfg of RECORD_TYPES) {
        const ids = pairs.filter((p) => p.collection === cfg.collection).map((p) => p.id);
        if (!ids.length) continue;
        const visible = viewer
          ? (await selectIn(db, cfg.readers, 'record_id', ids, ['record_id'], (q) => q.where('user_id', viewer))).map((r) => r.record_id)
          : ids;
        const fields = [...new Set([cfg.key, ...cfg.code, ...cfg.title])];
        for (const row of await selectIn(db, cfg.collection, cfg.key, visible, fields)) {
          out.set(recordKey(cfg.collection, row[cfg.key]), {
            collection: cfg.collection, id: row[cfg.key], kind: cfg.kind, code: firstOf(row, cfg.code), title: firstOf(row, cfg.title),
          });
        }
      }
      return out;
    }

    // Records of one collection that a team owns (owner_team_id) or has a grant on, that the viewer reads, newest first.
    // viewer: login id, or null = an administrator (reads every existing record). The date is updated_at (every record table has it;
    // a row without one sorts last). -> { items: [{ id, at }] of at most `limit`, truncated: more existed }.
    async function teamRecords(db, cfg, teamId, viewer, limit) {
      const ids = new Map(); // lower-case id -> id; the owner grant ('own') is also a grant row, so an owned record comes twice
      if (cfg.ownerTeam) for (const r of await db(cfg.collection).where('owner_team_id', teamId).select(cfg.key)) ids.set(String(r[cfg.key]).toLowerCase(), r[cfg.key]);
      for (const g of await db(accessTable(cfg)).where('team_id', teamId).select(cfg.fk)) ids.set(String(g[cfg.fk]).toLowerCase(), g[cfg.fk]);
      if (!ids.size) return { items: [], truncated: false };
      const readable = viewer
        ? (await selectIn(db, cfg.readers, 'record_id', [...ids.values()], ['record_id'], (q) => q.where('user_id', viewer))).map((r) => r.record_id)
        : [...ids.values()];
      const rows = await selectIn(db, cfg.collection, cfg.key, readable, [cfg.key, 'updated_at']);
      const stamp = (r) => { const t = r.updated_at ? new Date(r.updated_at).getTime() : NaN; return Number.isNaN(t) ? -Infinity : t; };
      const sorted = rows
        .map((r) => ({ id: r[cfg.key], at: iso(r.updated_at), t: stamp(r) }))
        .sort((a, b) => (b.t === a.t ? String(a.id).localeCompare(String(b.id)) : b.t > a.t ? 1 : -1));
      return { items: sorted.slice(0, limit).map(({ id, at }) => ({ id, at })), truncated: sorted.length > limit };
    }
    // ?limit=: a whole number from 1; absent = `fallback`; larger than `max` = `max`.
    function limitOf(raw, fallback, max) {
      if (isBlank(raw)) return fallback;
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'INVALID_PAYLOAD', 'limit must be a whole number from 1.');
      return Math.min(n, max);
    }

    // The records a team owns (owner_team_id), per collection: { physical_samples, manufacturing_operations, test_sessions, campaigns }.
    async function ownedCounts(db, teamId) {
      const counts = {};
      for (const cfg of OWNABLE_TYPES) counts[cfg.collection] = (await db(cfg.collection).where('owner_team_id', teamId).select(cfg.key)).length;
      return counts;
    }
    const sumOf = (counts) => Object.values(counts).reduce((a, b) => a + b, 0);
    // The teams the person manages (lower-case ids): a manager acts as the owner of what the team owns.
    async function managedTeamIds(db, me) {
      if (!me) return new Set();
      const rows = await db('team_members').where('person_id', me.person_id).where('is_manager', true).select('team_id');
      return new Set(rows.map((r) => String(r.team_id).toLowerCase()));
    }
    // Who owns a record for the purposes of asking and telling: its person owner, or the managers of its owner team. -> [person_id]
    async function ownerIds(db, cfg, record) {
      if (cfg.ownerTeam && !isBlank(record.owner_team_id)) {
        return (await db('team_members').where('team_id', record.owner_team_id).where('is_manager', true).select('person_id')).map((m) => String(m.person_id));
      }
      return isBlank(record[cfg.ownerField]) ? [] : [String(record[cfg.ownerField])];
    }
    const ownerColumns = (cfg) => [cfg.key, cfg.ownerField, ...(cfg.ownerTeam ? ['owner_team_id'] : [])];

    // ---- writing helpers ---------------------------------------------------------------------------------

    // Postgres errors of a team write -> an HttpError. `what`: 'team' (the name is unique) or 'member' (a person is in a team once).
    // 23514 is the deferred manager rule of migration 181, judged at COMMIT; the other two check constraints of `teams`
    // (teams_color_check, teams_name_not_blank) are validated in code and stay an internal error if they ever fire.
    function mapDbError(err, what) {
      if (err instanceof HttpError) return err;
      if (err?.code === '23514' && (isBlank(err.constraint) || err.constraint === 'team_members_need_manager')) {
        return new HttpError(409, 'LAST_MANAGER', 'Make someone else a manager first');
      }
      if (err?.code === '23505' && what === 'team' && (isBlank(err.constraint) || err.constraint === 'teams_name_key')) {
        return new HttpError(409, 'TEAM_NAME_TAKEN', 'Another team already has that name.');
      }
      if (err?.code === '23505' && what === 'member' && (isBlank(err.constraint) || err.constraint === 'team_members_team_id_person_id_key')) {
        return new HttpError(409, 'ALREADY_MEMBER', 'That person is already in the team.');
      }
      // owner_team_id of a record table is ON DELETE RESTRICT: a team that owns records cannot be deleted (constraint <table>_owner_team_id_fkey)
      if (err?.code === '23503' && what === 'team-delete' && (isBlank(err.constraint) || /_owner_team_id_fkey$/.test(String(err.constraint)))) {
        return new HttpError(409, 'TEAM_OWNS_RECORDS', 'This team owns records.');
      }
      if (err?.code === 'P0002') return new HttpError(409, 'NOTHING_TO_DECIDE', 'That person is not waiting for approval on that record.');
      return err;
    }
    // One write transaction: the actor first, so the history triggers name the caller. The commit can fail too (the deferred manager
    // constraint), so the error is mapped around the whole transaction, not inside the callback; nothing after this call runs then.
    async function write(acc, work, what = null) {
      try {
        return await database.transaction(async (trx) => {
          await trx.raw("SELECT set_config('d1.actor_identity', ?, true)", [String(acc.user)]);
          return work(trx);
        });
      } catch (err) {
        throw mapDbError(err, what);
      }
    }
    // Knex writes bypass the Directus services that clear the data cache, so clear it after the commit (as d1-record-access does).
    async function clearDataCache(req) {
      if (!toBool(env?.CACHE_ENABLED)) return;
      try {
        await new services.UtilsService({ schema: req.schema, accountability: { user: null, role: null, admin: true, app: false } }).clearCache({ system: false });
      } catch (err) {
        warn(`could not clear the data cache: ${err?.message || err}`);
      }
    }
    // A read AFTER a commit: the change stands whatever happens here, so a failure is logged and answers `fallback` (the committed
    // write never turns into a 500; the same rule as d1-record-access's entryOf and teamOf).
    async function afterCommit(what, read, fallback) {
      try {
        return await read();
      } catch (err) {
        logger?.error?.(`${SOURCE}: ${what} is committed but reading it back failed: ${err?.stack || err?.message || err}`);
        return typeof fallback === 'function' ? fallback() : fallback;
      }
    }
    // 'sent' | 'skipped' | 'failed'; never throws. person: { person_id, user_id, email }.
    async function deliver(req, person, content) {
      try {
        const user = isBlank(person?.user_id) ? null : await database('directus_users').where('id', person.user_id).first('email');
        const to = recipientAddress(person, user);
        if (!to) return 'skipped';
        const mail = new services.MailService({ schema: req.schema, knex: database });
        await withTimeout(mail.send({ to, subject: content.subject, html: content.html, text: content.text }), MAIL_TIMEOUT_MS);
        return 'sent';
      } catch (err) {
        warn(`an email to person ${person?.person_id} was not sent: ${err?.message || err}`);
        return 'failed';
      }
    }

    // ---- validation --------------------------------------------------------------------------------------

    const bodyOf = (req) => (isObject(req.body) ? req.body : {});
    const invalid = (message) => new HttpError(400, 'INVALID_PAYLOAD', message);
    // the fields of a team body that are present, validated: { name?, description?, color? }
    function teamFields(body) {
      const out = {};
      if (body.name !== undefined) {
        if (typeof body.name !== 'string' || !body.name.trim()) throw invalid('name must be some text.');
        out.name = body.name.trim();
      }
      if (body.description !== undefined) {
        if (body.description !== null && typeof body.description !== 'string') throw invalid('description must be text.');
        out.description = trimmed(body.description);
      }
      if (body.color !== undefined) {
        if (!PALETTE.includes(body.color)) throw invalid(`color must be one of ${PALETTE.join(', ')}.`);
        out.color = body.color;
      }
      return out;
    }
    async function checkLogo(db, logo) {
      if (logo === null) return null;
      const bad = (message) => new HttpError(400, 'BAD_LOGO', message);
      if (!isUuid(logo)) throw bad('logo must be the id of an uploaded image.');
      const file = await db('directus_files').where('id', logo).first('id', 'type', 'filesize');
      if (!file) throw bad('That file does not exist.');
      if (!LOGO_TYPES.includes(String(file.type ?? '').toLowerCase())) throw bad('A logo must be a png, jpeg or svg image.');
      const size = Number(file.filesize); // bigint comes back as a string
      if (isBlank(file.filesize) || !Number.isFinite(size) || size > MAX_LOGO_BYTES) throw bad('A logo can be at most 1 MB.');
      return file.id;
    }

    // ---- pending rows ------------------------------------------------------------------------------------

    // d1_private.team_pending_actionable (Ruling D2): is it worth asking about?
    async function actionable(db, collection, teamAccessId, personId) {
      const answer = (await db.raw('SELECT d1_private.team_pending_actionable(?, ?, ?) AS ok', [collection, teamAccessId, personId]))?.rows?.[0];
      return answer?.ok === true;
    }
    // The pending rows (state pending) that are worth asking about, optionally of one team and/or joiner; `keep(row)` is asked before the
    // function is (to skip records nobody asked for). Each: { cfg, collection, record_id, record, team_access_id, team_id, person_id,
    // role, owner_person_id }.
    async function pendingRows(db, { teamId = null, personId = null, keep = () => true } = {}) {
      const out = [];
      for (const cfg of RECORD_TYPES) {
        let query = db(pendingTable(cfg)).where('state', 'pending');
        if (personId) query = query.where('person_id', personId);
        const pending = await query.select('team_access_id', 'person_id');
        if (!pending.length) continue;
        const grants = await selectIn(db, accessTable(cfg), 'team_access_id', pending.map((p) => p.team_access_id),
          ['team_access_id', cfg.fk, 'team_id', 'role'], teamId ? (q) => q.where('team_id', teamId) : undefined);
        const grantOf = new Map(grants.map((g) => [String(g.team_access_id), g]));
        const fields = [...new Set([...ownerColumns(cfg), ...cfg.code, ...cfg.title])];
        const records = new Map((await selectIn(db, cfg.collection, cfg.key, grants.map((g) => g[cfg.fk]), fields)).map((r) => [String(r[cfg.key]), r]));
        for (const p of pending) {
          const grant = grantOf.get(String(p.team_access_id));
          const record = grant ? records.get(String(grant[cfg.fk])) : null;
          if (!record) continue;
          const row = {
            cfg, collection: cfg.collection, record_id: record[cfg.key], record, team_access_id: p.team_access_id, team_id: grant.team_id,
            person_id: p.person_id, role: grant.role, owner_person_id: record[cfg.ownerField] ?? null, owner_team_id: record.owner_team_id ?? null,
          };
          if (!keep(row)) continue;
          if (await actionable(db, cfg.collection, p.team_access_id, p.person_id)) out.push(row);
        }
      }
      return out;
    }
    // owns: the caller's person owns the record, or manages the team that owns it (`managed`: managedTeamIds)
    const owns = (row, me, managed) => Boolean(me && (sameId(row.owner_person_id, me.person_id) || (!isBlank(row.owner_team_id) && managed.has(String(row.owner_team_id).toLowerCase()))));
    const manages = (row, me, admin, managed) => admin || owns(row, me, managed);
    const recordOf = (row) => ({
      collection: row.collection, id: row.record_id, kind: row.cfg.kind, code: firstOf(row.record, row.cfg.code), title: firstOf(row.record, row.cfg.title), role: row.role,
    });
    const lineOf = (row) => `${capital(row.cfg.kind)} ${firstOf(row.record, row.cfg.code) ?? '(no code)'}`;

    // "<team> owns 2 samples and 1 campaign. Transfer them to a person or another team first."
    const NOUNS = { physical_samples: ['sample', 'samples'], manufacturing_operations: ['operation', 'operations'], test_sessions: ['test', 'tests'], campaigns: ['campaign', 'campaigns'] };
    function ownsMessage(name, counts) {
      const parts = Object.entries(counts ?? {}).filter(([, n]) => n > 0).map(([collection, n]) => `${n} ${NOUNS[collection][n === 1 ? 0 : 1]}`);
      const what = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0] ?? 'records';
      return `${name} owns ${what}. Transfer ownership of them to a person or another team before deleting the team.`;
    }

    // ---- GET / ---------------------------------------------------------------------------------------------

    router.get('/', route(async ({ res, acc }) => {
      const me = await callerPerson(database, acc);
      res.json({ teams: await teamItems(database, me, await database('teams').select('team_id', 'name', 'description', 'color', 'logo', 'created_by_person_id')) });
    }));

    // ---- the Waiting-for-you list and the decision (before the /:id routes) -----------------------------------

    router.get('/pending', route(async ({ res, acc, labViewer }) => {
      const me = await callerPerson(database, acc);
      // a Lab Viewer decides nothing, so nothing waits for them (even a record they own)
      if (!me || labViewer) return res.json({ items: [] });
      // Waiting for you is the caller's own queue: only records they OWN (or that a team they manage owns), an administrator included
      // (an administrator approves or declines a single record from Who has access).
      const managed = await managedTeamIds(database, me);
      const rows = await pendingRows(database, { keep: (row) => owns(row, me, managed) });
      const [teams, people] = await Promise.all([
        selectIn(database, 'teams', 'team_id', rows.map((r) => r.team_id), ['team_id', 'name']),
        loadPeople(database, rows.map((r) => r.person_id)),
      ]);
      const teamName = new Map(teams.map((t) => [String(t.team_id), t.name]));
      const groups = new Map();
      for (const row of rows) {
        const key = `${String(row.team_id)}/${String(row.person_id)}`;
        if (!groups.has(key)) {
          groups.set(key, {
            team_id: row.team_id, team_name: teamName.get(String(row.team_id)) ?? null, person_id: row.person_id,
            full_name: people.get(String(row.person_id))?.full_name ?? null, records: [],
          });
        }
        groups.get(key).records.push(recordOf(row));
      }
      const items = [...groups.values()].sort((a, b) => String(a.team_name ?? '').localeCompare(String(b.team_name ?? '')) || String(a.full_name ?? '').localeCompare(String(b.full_name ?? '')));
      for (const item of items) item.records.sort((a, b) => a.kind.localeCompare(b.kind) || String(a.code ?? '').localeCompare(String(b.code ?? '')));
      res.json({ items });
    }));

    router.post('/pending/decide', route(async ({ req, res, acc, admin }) => {
      const body = bodyOf(req);
      if (!isUuid(body.team_id)) throw invalid('team_id must be a team id.');
      if (!isUuid(body.person_id)) throw invalid('person_id must be a person id.');
      if (body.decision !== 'approve' && body.decision !== 'decline') throw invalid('decision must be approve or decline.');
      let asked = null; // [{ cfg, id }] when `records` is given
      if (body.records !== undefined) {
        if (!Array.isArray(body.records)) throw invalid('records must be a list.');
        asked = body.records.map((r) => {
          const cfg = isObject(r) && typeof r.collection === 'string' && Object.hasOwn(COLLECTIONS, r.collection) ? COLLECTIONS[r.collection] : null;
          if (!cfg || !isUuid(r.id)) throw invalid('Each record needs a collection (samples, operations, tests, campaigns or projects) and an id.');
          return { cfg, id: r.id };
        }).filter((r, i, all) => all.findIndex((o) => o.cfg === r.cfg && sameId(o.id, r.id)) === i); // the same record twice is decided once
      }
      const me = await callerPerson(database, acc);
      const managed = await managedTeamIds(database, me);

      const done = await write(acc, async (trx) => {
        // what to decide: [{ cfg, collection, record_id, record, team_access_id, role }]
        let targets;
        if (asked) {
          targets = [];
          for (const { cfg, id } of asked) {
            const fields = [...new Set([...ownerColumns(cfg), ...cfg.code, ...cfg.title])];
            const record = await trx(cfg.collection).where(cfg.key, id).first(...fields);
            if (!record) throw new HttpError(404, 'NOT_FOUND', 'That record does not exist.');
            const grant = await trx(accessTable(cfg)).where(cfg.fk, id).where('team_id', body.team_id).first('team_access_id', 'role');
            const row = { cfg, collection: cfg.collection, record_id: id, record, owner_person_id: record[cfg.ownerField] ?? null, owner_team_id: record.owner_team_id ?? null, team_access_id: grant?.team_access_id, role: grant?.role };
            // checked for every record before any is decided, so a refusal leaves nothing half applied
            if (!manages(row, me, admin, managed)) throw new HttpError(403, 'FORBIDDEN', 'You can only decide on records you own.');
            const waiting = grant ? await trx(pendingTable(cfg)).where('team_access_id', grant.team_access_id).where('person_id', body.person_id).first('state') : null;
            if (!waiting) throw new HttpError(409, 'NOTHING_TO_DECIDE', 'That person is not waiting for approval on that record.');
            targets.push(row);
          }
        } else {
          const all = await pendingRows(trx, { teamId: body.team_id, personId: body.person_id });
          targets = all.filter((row) => owns(row, me, managed)); // the whole queue is the caller's own records, an administrator included
          if (all.length && !targets.length) throw new HttpError(403, 'FORBIDDEN', 'You can only decide on records you own.');
        }
        for (const t of targets) {
          await trx.raw('SELECT d1_private.team_decide(?, ?, ?, ?)', [t.collection, t.team_access_id, body.person_id, body.decision]);
        }
        return targets;
      });
      await clearDataCache(req);

      if (body.decision === 'approve' && done.length) {
        const [team, people] = await afterCommit('the approval', () => Promise.all([database('teams').where('team_id', body.team_id).first('name'), loadPeople(database, [body.person_id])]), [null, new Map()]);
        const joiner = people.get(String(body.person_id));
        if (joiner && !sameId(joiner.user_id, acc.user)) {
          const teamName = team?.name ?? 'a team';
          await deliver(req, joiner, mailContent({
            subject: `You now have access through ${teamName}`,
            intro: `Your access through the team ${teamName} was approved. You can now open:`,
            lines: done.map((t) => `${lineOf(t)} (${roleLabel(t.collection, t.role)})`),
            link: starbaseLink(),
          }));
        }
      }
      res.json({ decision: body.decision, decided: done.length, records: done.map((t) => ({ collection: t.collection, id: t.record_id })) });
    }));

    // ---- the records of a team (index filters) and the recent ones (Home), before /:id ------------------------------

    router.get('/mine/recent', route(async ({ req, res, acc, admin }) => {
      const limit = limitOf(req.query?.limit, 20, 100);
      const me = await callerPerson(database, acc);
      if (!me) return res.json({ items: [] });
      const viewer = admin ? null : String(acc.user);
      const memberships = await database('team_members').where('person_id', me.person_id).select('team_id');
      const teams = (await selectIn(database, 'teams', 'team_id', memberships.map((m) => m.team_id), ['team_id', 'name', 'color'])).sort(byText('name'));
      const found = new Map(); // recordKey -> { cfg, id, at, team }: a record of two of the caller's teams is listed once (the first by team name)
      for (const team of teams) {
        for (const cfg of RECORD_TYPES) {
          for (const r of (await teamRecords(database, cfg, team.team_id, viewer, limit)).items) {
            const key = recordKey(cfg.collection, r.id);
            if (!found.has(key)) found.set(key, { cfg, id: r.id, at: r.at, team });
          }
        }
      }
      const newest = [...found.values()]
        .sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')) || String(a.id).localeCompare(String(b.id)))
        .slice(0, limit);
      const described = await describeRecords(database, newest.map((n) => ({ collection: n.cfg.collection, id: n.id })), viewer);
      res.json({
        items: newest
          .map((n) => ({ n, d: described.get(recordKey(n.cfg.collection, n.id)) }))
          .filter(({ d }) => d)
          .map(({ n, d }) => ({
            collection: d.collection, id: d.id, kind: d.kind, code: d.code, title: d.title,
            team_id: n.team.team_id, team_name: n.team.name, team_color: n.team.color ?? 'teal', changed_at: n.at,
          })),
      });
    }));

    router.get('/:id/records', route(async ({ req, res, acc, admin }) => {
      const team = await teamOr404(database, req.params?.id);
      const collection = req.query?.collection;
      if (typeof collection !== 'string' || !Object.hasOwn(COLLECTIONS, collection)) {
        throw invalid('collection must be physical_samples, manufacturing_operations, test_sessions, campaigns or projects.');
      }
      const limit = limitOf(req.query?.limit, MAX_TEAM_RECORDS, MAX_TEAM_RECORDS);
      const { items, truncated } = await teamRecords(database, COLLECTIONS[collection], team.team_id, admin ? null : String(acc.user), limit);
      res.json({ ids: items.map((i) => i.id), truncated });
    }));

    // ---- one team --------------------------------------------------------------------------------------------

    router.get('/:id', route(async ({ req, res, acc, admin }) => {
      const team = await teamOr404(database, req.params?.id);
      const me = await callerPerson(database, acc);
      const viewer = admin ? null : String(acc.user);

      const [item, memberRows] = await Promise.all([
        teamItem(database, me, team.team_id),
        database('team_members').where('team_id', team.team_id).select('person_id', 'is_manager', 'joined_at'),
      ]);
      const people = await loadPeople(database, memberRows.map((m) => m.person_id));
      const members = memberRows
        .map((m) => {
          const person = people.get(String(m.person_id));
          return { person_id: m.person_id, full_name: person?.full_name ?? null, can_sign_in: !isBlank(person?.user_id), is_manager: m.is_manager === true, joined_at: iso(m.joined_at) };
        })
        .sort((a, b) => Number(b.is_manager) - Number(a.is_manager) || String(a.full_name ?? '').localeCompare(String(b.full_name ?? '')));

      // the grants of the team, over all five record types
      const grants = [];
      for (const cfg of RECORD_TYPES) {
        for (const g of await database(accessTable(cfg)).where('team_id', team.team_id).select('team_access_id', cfg.fk, 'role')) {
          grants.push({ collection: cfg.collection, id: g[cfg.fk], role: g.role });
        }
      }
      const counts = Object.fromEntries(LEVELS.map((level) => [level, 0]));
      for (const g of grants) if (Object.hasOwn(counts, g.role)) counts[g.role] += 1;
      counts.owns = sumOf(await ownedCounts(database, team.team_id));
      const described = await describeRecords(database, grants, viewer);
      const order = (collection) => RECORD_TYPES.findIndex((c) => c.collection === collection);
      const records = grants
        .map((g) => ({ ...described.get(recordKey(g.collection, g.id)), role: g.role }))
        .filter((r) => r.collection)
        .sort((a, b) => order(a.collection) - order(b.collection) || String(a.code ?? '').localeCompare(String(b.code ?? '')))
        .map((r) => ({ collection: r.collection, id: r.id, kind: r.kind, code: r.code, title: r.title, role: r.role }));

      // the history, newest first
      let eventsQuery = database('team_events').where('team_id', team.team_id).orderBy('event_id', 'desc');
      if (req.query?.events !== 'all') eventsQuery = eventsQuery.limit(EVENTS_SHOWN);
      const raw = await eventsQuery.select('event_id', 'at', 'kind', 'actor_person_id', 'person_id', 'collection', 'record_id', 'detail');
      const eventPeople = await loadPeople(database, raw.flatMap((e) => [e.actor_person_id, e.person_id]));
      const eventRecords = await describeRecords(database, raw.filter((e) => e.collection && e.record_id).map((e) => ({ collection: e.collection, id: e.record_id })), viewer);
      const events = raw.map((e) => {
        const about = e.collection && e.record_id;
        const record = about ? eventRecords.get(recordKey(e.collection, e.record_id)) : null;
        const hidden = Boolean(about && !record);
        // An event about a record the caller cannot read keeps only what happened, when and by whom: who it concerned and the detail
        // could name the record or the people with access to it.
        return {
          event_id: Number(e.event_id),
          at: iso(e.at),
          kind: e.kind,
          actor_person_id: e.actor_person_id ?? null,
          actor_name: isBlank(e.actor_person_id) ? null : eventPeople.get(String(e.actor_person_id))?.full_name ?? null,
          person_id: hidden ? null : e.person_id ?? null,
          person_name: hidden || isBlank(e.person_id) ? null : eventPeople.get(String(e.person_id))?.full_name ?? null,
          collection: record ? record.collection : null,
          record_id: record ? record.id : null,
          record_kind: record ? record.kind : null,
          record_code: record ? record.code : null,
          record_hidden: hidden,
          detail: hidden ? null : e.detail ?? null,
        };
      });

      res.json({ team: item, members, counts, records, hidden_count: grants.length - records.length, events });
    }));

    // ---- create, edit, delete ---------------------------------------------------------------------------------

    router.post('/', route(async ({ req, res, acc }) => {
      const body = bodyOf(req);
      if (body.name === undefined) throw invalid('name is required.');
      const fields = teamFields(body);
      const me = await callerPerson(database, acc);
      if (!me) throw new HttpError(409, 'NO_PERSON', 'Your login is not linked to a person yet, so you cannot create a team.');
      const teamId = await write(acc, async (trx) => {
        const made = await trx('teams')
          .insert({ name: fields.name, description: fields.description ?? null, color: fields.color ?? 'teal', created_by_person_id: me.person_id })
          .returning('team_id');
        const id = made?.[0]?.team_id ?? made?.[0];
        await trx('team_members').insert({ team_id: id, person_id: me.person_id, is_manager: true });
        return id;
      }, 'team');
      await clearDataCache(req);
      res.status(201).json(await afterCommit(`the new team ${teamId}`, () => teamItem(database, me, teamId), () => ({
        team_id: teamId, name: fields.name, description: fields.description ?? null, color: fields.color ?? 'teal', logo: null, member_count: 1,
        managers: [{ person_id: me.person_id, full_name: me.full_name ?? null }], is_member: true, is_manager: true,
      })));
    }));

    router.patch('/:id', route(async ({ req, res, acc, admin }) => {
      const team = await teamOr404(database, req.params?.id);
      const me = await callerPerson(database, acc);
      await requireManager(database, team.team_id, me, admin);
      const body = bodyOf(req);
      const changes = teamFields(body);
      if (body.logo !== undefined) changes.logo = await checkLogo(database, body.logo);
      if (!Object.keys(changes).length) throw invalid('Send a name, description, color or logo.');
      await write(acc, (trx) => trx('teams').where('team_id', team.team_id).update(changes), 'team');
      await clearDataCache(req);
      res.json(await afterCommit(`the change to team ${team.team_id}`, () => teamItem(database, me, team.team_id), () => ({
        team_id: team.team_id, name: changes.name ?? team.name, description: changes.description === undefined ? team.description ?? null : changes.description,
        color: changes.color ?? team.color ?? 'teal', logo: changes.logo === undefined ? team.logo ?? null : changes.logo,
        member_count: null, managers: [], is_member: null, is_manager: null,
      })));
    }));

    router.delete('/:id', route(async ({ req, res, acc, admin }) => {
      const team = await teamOr404(database, req.params?.id);
      const me = await callerPerson(database, acc);
      await requireManager(database, team.team_id, me, admin);

      let owners;
      try {
        owners = await write(acc, async (trx) => {
          // who owns the records the team has access to, read before the grants go with the team (a record a team owns: its managers)
          const byOwner = new Map(); // owner person id -> [line]
          for (const cfg of RECORD_TYPES) {
            const grants = await trx(accessTable(cfg)).where('team_id', team.team_id).select(cfg.fk);
            const fields = [...new Set([...ownerColumns(cfg), ...cfg.code])];
            for (const record of await selectIn(trx, cfg.collection, cfg.key, grants.map((g) => g[cfg.fk]), fields)) {
              for (const owner of await ownerIds(trx, cfg, record)) {
                if (sameId(owner, me?.person_id)) continue; // the one deleting the team
                byOwner.set(owner, [...(byOwner.get(owner) ?? []), `${capital(cfg.kind)} ${firstOf(record, cfg.code) ?? '(no code)'}`]);
              }
            }
          }
          await trx('teams').where('team_id', team.team_id).del(); // RESTRICT: raises 23503 while the team owns a record
          return byOwner;
        }, 'team-delete');
      } catch (err) {
        if (!(err instanceof HttpError) || err.code !== 'TEAM_OWNS_RECORDS') throw err;
        // the transaction rolled back; say what the team owns (a failed read here still answers the refusal)
        const counts = await afterCommit(`the refusal to delete team ${team.team_id}`, () => ownedCounts(database, team.team_id), null);
        throw new HttpError(409, 'TEAM_OWNS_RECORDS', ownsMessage(team.name, counts), counts ? { counts } : {});
      }
      await clearDataCache(req);

      const people = await afterCommit(`the deletion of team ${team.team_id}`, () => loadPeople(database, [...owners.keys()]), new Map());
      let mailed = 0;
      await Promise.all([...owners].map(async ([ownerId, lines]) => {
        const owner = people.get(ownerId);
        if (!owner) return;
        const result = await deliver(req, owner, mailContent({
          subject: `${team.name} was deleted`,
          intro: `${team.name} was deleted; it no longer has access to:`,
          lines: lines.sort(),
          link: starbaseLink(),
        }));
        if (result === 'sent') mailed += 1;
      }));
      res.json({ deleted: true, owners_mailed: mailed });
    }));

    // ---- members -----------------------------------------------------------------------------------------------

    router.post('/:id/members', route(async ({ req, res, acc, admin }) => {
      const team = await teamOr404(database, req.params?.id);
      const me = await callerPerson(database, acc);
      await requireManager(database, team.team_id, me, admin);
      const body = bodyOf(req);
      if (!isUuid(body.person_id)) throw invalid('person_id must be a person id.');
      if (body.is_manager !== undefined && typeof body.is_manager !== 'boolean') throw invalid('is_manager must be true or false.');
      const joiner = [...(await loadPeople(database, [body.person_id])).values()][0];
      if (!joiner) throw new HttpError(404, 'NOT_FOUND', 'That person does not exist.');

      // The triggers of migration 182 give the joiner a derived row (a grant that trusts new members) or a pending row (any other) for each
      // grant of the team; the pending rows are visible in this transaction right after the insert.
      const pending = await write(acc, async (trx) => {
        await trx('team_members').insert({ team_id: team.team_id, person_id: joiner.person_id, is_manager: body.is_manager === true });
        return pendingRows(trx, { teamId: team.team_id, personId: joiner.person_id });
      }, 'member');
      await clearDataCache(req);

      // one mail per owner (not the caller), listing their records; the owner of a record a team owns is that team's managers
      const byOwner = new Map();
      for (const row of pending) {
        for (const owner of await afterCommit(`the owners of ${row.collection} ${row.record_id}`, () => ownerIds(database, row.cfg, row.record), [])) {
          if (sameId(owner, me?.person_id)) continue;
          byOwner.set(owner, [...(byOwner.get(owner) ?? []), row]);
        }
      }
      const owners = await afterCommit(`the new member of team ${team.team_id}`, () => loadPeople(database, [...byOwner.keys()]), new Map());
      await Promise.all([...byOwner].map(async ([ownerId, rows]) => {
        const owner = owners.get(ownerId);
        if (!owner) return;
        await deliver(req, owner, mailContent({
          subject: `${personName(joiner)} joined ${team.name}: your approval is needed`,
          intro: `${personName(joiner)} joined the team ${team.name}, which has access to records you own. They will not get access to these until you approve:`,
          lines: rows.map((r) => `${lineOf(r)} (${roleLabel(r.collection, r.role)})`).sort(),
          outro: 'Approve or decline in STARbase, under Waiting for you.',
          link: starbaseLink(),
        }));
      }));
      const owned = await afterCommit(`the records team ${team.team_id} owns`, () => ownedCounts(database, team.team_id), {});
      res.status(201).json({ pending: pending.length, owners_asked: byOwner.size, owned_edit: sumOf(owned) });
    }));

    router.patch('/:id/members/:person_id', route(async ({ req, res, acc, admin }) => {
      const team = await teamOr404(database, req.params?.id);
      if (!isUuid(req.params?.person_id)) throw invalid('The person id is not valid.');
      const me = await callerPerson(database, acc);
      await requireManager(database, team.team_id, me, admin);
      const body = bodyOf(req);
      if (typeof body.is_manager !== 'boolean') throw invalid('is_manager must be true or false.');
      const personId = req.params.person_id;
      const hit = await write(acc, async (trx) => {
        if (!(await trx('team_members').where('team_id', team.team_id).where('person_id', personId).first('member_id'))) return false;
        await trx('team_members').where('team_id', team.team_id).where('person_id', personId).update({ is_manager: body.is_manager });
        return true;
      }, 'member');
      if (!hit) throw new HttpError(404, 'NOT_FOUND', 'That person is not in the team.');
      await clearDataCache(req);
      res.json({ team_id: team.team_id, person_id: personId, is_manager: body.is_manager });
    }));

    router.delete('/:id/members/:person_id', route(async ({ req, res, acc, admin }) => {
      const team = await teamOr404(database, req.params?.id);
      if (!isUuid(req.params?.person_id)) throw invalid('The person id is not valid.');
      const personId = req.params.person_id;
      const me = await callerPerson(database, acc);
      if (!sameId(me?.person_id, personId)) await requireManager(database, team.team_id, me, admin);
      const hit = await write(acc, async (trx) => {
        if (!(await trx('team_members').where('team_id', team.team_id).where('person_id', personId).first('member_id'))) return false;
        await trx('team_members').where('team_id', team.team_id).where('person_id', personId).del();
        return true;
      }, 'member');
      if (!hit) throw new HttpError(404, 'NOT_FOUND', 'That person is not in the team.');
      await clearDataCache(req);
      res.json({ team_id: team.team_id, person_id: personId, removed: true });
    }));
  },
};
