// Directus endpoint: d1-bulk-actions  (mounted at /d1-bulk-actions)
//
// Bulk actions on the index pages (spec docs/superpowers/specs/2026-10-20-bulk-actions-design.md): one action on up to 100 ticked records,
// a dry-run preview per record, apply with partial success, a 60-second undo for the person who ran it, a revert for administrators, and
// the journal behind it (migration 204: bulk_actions, bulk_action_rows; read and written only here). Seven kinds: restrict, unrestrict and edit_field
// (an update of the record as the caller) and the ownership and access kinds assign_team, change_owner, share_access and remove_access, which run
// through d1-record-access's extracted bodies (makeAccessOps), so the access rules live in one place.
//
//   POST /d1-bulk-actions/:collection/preview   { kind, ids[], params }
//     -> { results: [{ id, code, status: 'ok'|'noop'|'skip', reason?, warning? }], counts: { total, ok, noop, skip } }
//        warning (a status 'ok' row of an ownership kind only): one plain sentence, or several joined by a space, saying what the change costs the caller
//        (Ruling O5: the managers of the team that owned it are not kept; the caller can no longer manage it, so an undo may be refused; the new
//        owner cannot open it yet). The same words for every row they apply to, so the dialog can list each once.
//   POST /d1-bulk-actions/:collection/apply     { kind, ids[], params }
//     -> { action_id, undo_until, results: [{ id, code, outcome: 'applied'|'noop'|'skipped'|'failed', reason? }],
//          counts: { total, applied, noop, skipped, failed } }
//   POST /d1-bulk-actions/:action_id/undo       -> { state, revert_action_id, results: [{ id, code, revert_outcome, reason? }] }
//        the person who ran it while now < undo_until, or an administrator
//   POST /d1-bulk-actions/:action_id/revert     -> the same shape; administrators only, any time
//   GET  /d1-bulk-actions                       -> { actions: [...], limit, offset, has_more }  (?limit=50 max 200, ?offset=0; administrators
//        see all, everyone else only their own; newest first)
//   GET  /d1-bulk-actions/:action_id            -> { action, rows: [...] }  (the same visibility; 404 otherwise; each row's before and after
//        snapshots are for administrators only, null for everyone else)
//   params: restrict and unrestrict {}; edit_field { field, value } (null clears); assign_team { team_id }; change_owner { person_id };
//   share_access { person_id | team_id, role: 'view' | 'edit' }; remove_access { person_id | team_id }. Collections: physical_samples,
//   manufacturing_operations, test_sessions, campaigns (assign_team is accepted on projects too and skips every row: a team cannot own one);
//   BULK_FIELDS is the allow-list of fields per collection (the index pages mirror it in `bulkFields`).
//   A person or team that does not exist (a person that is not active) is a 400 before any record is touched, except for remove_access (a person
//   or team that is gone is simply not listed: noop).
//
// Errors (the Directus shape, source 'd1-bulk-actions'): 401; 403 READ_ONLY_ROLE (a Lab Viewer, on preview too); 400 INVALID_PAYLOAD,
// NOT_APPLICABLE; 404 NOT_FOUND (an action you may not see); 403 FORBIDDEN (revert by a non-administrator), UNDO_WINDOW_CLOSED;
// 409 CANNOT_REVERT_A_REVERT, ALREADY_REVERTED, NOTHING_TO_REVERT, STILL_APPLYING (an action's counts stay null until its apply has finished).
//
// The ownership and access kinds, per record, in the record's own transaction after the readable check: the caller must manage it (skip 'You are not the
// owner of this record.'), then the kind's rules, then one of d1-record-access's bodies. Skip reasons are those bodies' own plain words: the team has no
// manager (Ruling O4), a team cannot own this kind of record (O3), the person is the owner already, the owner's access cannot be removed, the team owns
// the record. Already as asked is noop (the team or person already owns it; the person or team already has that level; not listed).
// Undo and revert of these put the owner, the person entries and the team grants back to `before` through the same bodies; what the rules forbid now
// (the old team has no manager, the caller cannot manage any more: Rulings O4 and O5) is `refused` with the reason.
//
// Summary emails (spec 3.4): assign_team mails the new team's managers, change_owner the new owner, share_access the person or the team's active members
// that have an address; one mail per recipient lists the codes (the first 20, then 'and N more'), built from the journal when it is sent. At apply the
// action is mail_state 'pending' with mail_due_at = undo_until + 2 s and a timer sends it; undo (or a revert that put anything back) sets 'cancelled'; on
// start a sweep sends what is overdue and re-arms the rest; a revert sends nothing; a failed mail is logged and never undoes the change.
//
// Per record, preview and apply run the SAME function; a preview runs in a transaction that is always rolled back, so the two cannot disagree:
//   1. a record the caller cannot read (ItemsService.readOne as the caller) is skipped as "not found", with no code, never revealed;
//   2. in one transaction (d1.actor_identity set, so audit_logs names the caller): row lock, `before` snapshot, ItemsService.updateOne as the
//      CALLER (Directus's permissions and d1-access-guard decide; the guard's refusal text is the skip reason), `after` snapshot. A value
//      already as asked is `noop` and never written;
//   3. apply also writes the record's journal row in that transaction. Directus's action events (which cascade a project or campaign change)
//      are held back with `bypassEmitAction` and emitted after the commit; filter hooks, including d1-access-guard, still run.
// The data cache is cleared once per action when CACHE_ENABLED is on.
//
// Snapshots (`before` and `after`, so "unchanged since" is a plain comparison): restrict and unrestrict keep the spec's ownership shape
// { owner_person_id, owner_team_id, restricted, people, teams } (a person's OWN rows and a team's grants, never derived rows or the
// database-held owner grant); edit_field keeps { <field>: <value> }.
//
// Undo and revert are one implementation (spec 3.3): per applied row, a current snapshot that differs from `after` is `changed_since` (nothing
// written), otherwise `before` is written back as the caller (a refusal: `refused`, a crash: `failed`). The revert is journaled as a new
// bulk_actions row (revert_of, mail_state 'none', undo_until = created_at so it can never be undone); the original becomes undone, reverted
// or partly_reverted (an administrator can revert a partly_reverted action again to retry the rest).

import {
  COLLECTIONS, HttpError as AccessError, PERSON_COLUMNS, READ_ONLY_ROLE_MESSAGE, escapeHtml, isLabViewer, isWriteRequest, mailContent, makeAccessOps, recipientAddress,
  recordLink, roleLabel, withTimeout,
} from '../d1-record-access/index.js';
import { accountAdmin } from '../d1-people-admin/index.js';

const SOURCE = 'd1-bulk-actions';
const DEFAULT_LAB_ADMIN_ROLE_ID = '10000001-0000-0000-0000-000000000001';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IDS = 100;
const UNDO_WINDOW_MS = 60_000;
const LIST_DEFAULT = 50;
const LIST_MAX = 200;
const MAIL_TIMEOUT_MS = 10_000;
const MAIL_GRACE_MS = 2_000; // the summary mail is due this long after the undo window closes
const MAIL_LIST_MAX = 20; // codes listed in one summary mail, then "and N more"

// The ownership and access kinds run through d1-record-access's extracted bodies; the others update the record as the caller.
export const ACCESS_KINDS = ['assign_team', 'change_owner', 'share_access', 'remove_access'];
export const KINDS = ['restrict', 'unrestrict', 'edit_field', ...ACCESS_KINDS];
// The kinds that tell someone (a summary email, held until the undo window closes); remove access, restrict and edit a field mail nobody.
export const MAILING_KINDS = ['assign_team', 'change_owner', 'share_access'];
const isAccessKind = (kind) => ACCESS_KINDS.includes(kind);

// The fields a bulk edit may set, per collection: { field: { kind, label, clearable, values?, relation? } }. The server's own allow-list, mirrored by
// `bulkFields` of the index pages (packages/d1-ui/src/index/indexConfig.ts); the value is validated against the kind, then Directus's permissions
// and d1-access-guard decide per record. `clearable` is false for NOT NULL columns. `values` are the database's CHECK values. Left out on purpose:
// session_date and operation_date (timestamps), work_state and process_category (they change through Mark done and the builder), campaigns.status
// (no CHECK, so no known values), 'planned' as a sample status (it leaves when its operation is marked done), free text.
export const BULK_FIELDS = {
  physical_samples: {
    current_status: { kind: 'enum', label: 'Status', clearable: false, values: ['active', 'consumed', 'destroyed', 'archived'] },
    project_id: { kind: 'relation', label: 'Project', clearable: true, relation: { collection: 'projects', key: 'project_id' } },
    mounted: { kind: 'bool', label: 'Mounted', clearable: true },
    manufactured_date: { kind: 'date', label: 'Manufactured date', clearable: true },
  },
  manufacturing_operations: {
    project_id: { kind: 'relation', label: 'Project', clearable: true, relation: { collection: 'projects', key: 'project_id' } },
    campaign_id: { kind: 'relation', label: 'Campaign', clearable: true, relation: { collection: 'campaigns', key: 'campaign_id' } },
    planned_date: { kind: 'date', label: 'Planned date', clearable: true },
  },
  test_sessions: {
    status: { kind: 'enum', label: 'Status', clearable: false, values: ['registered', 'pending_processing', 'processing', 'processed', 'analysing', 'analysed', 'failed'] },
    project_id: { kind: 'relation', label: 'Project', clearable: true, relation: { collection: 'projects', key: 'project_id' } },
    campaign_id: { kind: 'relation', label: 'Campaign', clearable: true, relation: { collection: 'campaigns', key: 'campaign_id' } },
    planned_date: { kind: 'date', label: 'Planned date', clearable: true },
  },
  campaigns: {
    project_id: { kind: 'relation', label: 'Project', clearable: true, relation: { collection: 'projects', key: 'project_id' } },
    start_date: { kind: 'date', label: 'Start date', clearable: true },
    end_date: { kind: 'date', label: 'End date', clearable: true },
  },
};

const NOT_FOUND_REASON = 'That record does not exist, or you cannot see it.';
const NO_PERMISSION_REASON = 'You do not have permission to change this record.';
const FAILED_REASON = 'Something went wrong changing this record.';
const NOT_OWNER_REASON = 'You are not the owner of this record.';
const OWNER_REMOVE_REASON = 'That person is the owner of this record, so their access cannot be removed. Change the owner instead.';
const NOT_OWNABLE_REASON = 'A team cannot own this kind of record.';
const NO_MANAGER_REASON = 'That team has no manager to look after the record — add a manager first'; // d1-record-access's TEAM_HAS_NO_MANAGER wording
// what an undo or revert says when the rules no longer allow putting a record back (Rulings O4 and O5)
const REVERT_NOT_MANAGER = 'You can no longer manage this record, so it cannot be handed back. Ask an administrator to revert it.';
const REVERT_NO_MANAGER = 'The team that owned this record has no manager now, so it cannot be handed back.';
const REVERT_NO_OWNER = 'This record had no owner, so the owner cannot be put back automatically.';
const REVERT_MISMATCH = 'The record could not be put back exactly as it was, so it was left alone.';

// Preview warnings (Ruling O5): plain words, the same for every record they apply to (the dialog lists each distinct one once).
export const WARN_TEAM_MANAGERS_LOSE = 'The managers of the team that owns it now do not keep their access.';
export const WARN_YOU_LOSE_MANAGE = 'You will no longer be able to manage this record yourself, so an undo may be refused.';
export const warnBlocked = (name, blocked) =>
  blocked?.reason === 'no_login'
    ? `${name} has no D1 login yet, so they cannot open this record.`
    : `${name} cannot open this record yet: something it sits under is hidden from them.`;

class HttpError extends Error {
  constructor(status, code, message, extensions = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extensions = extensions;
  }
}

// Thrown inside a row's transaction to roll it back on purpose (a preview, a record that is skipped, already as asked, or failed).
class Rollback extends Error {}
// Thrown when an undo or revert of an access change did not end exactly where it began: that record's transaction is rolled back.
class Mismatch extends Error {}

const isBlank = (v) => v === undefined || v === null || v === '';
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const toBool = (v) => v === true || v === 'true' || v === 1 || v === '1' || v === 't';
const isUuid = (v) => typeof v === 'string' && UUID.test(v);
const { hasOwn } = Object;
const iso = (v) => {
  if (isBlank(v)) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const firstOf = (row, fields) => {
  for (const field of fields) if (!isBlank(row?.[field]) && String(row[field]).trim() !== '') return String(row[field]);
  return null;
};
const isForbidden = (e) => e?.status === 403 || e?.code === 'FORBIDDEN';
const isCollection = (name) => typeof name === 'string' && hasOwn(COLLECTIONS, name);
const ownable = (cfg) => cfg.ownerTeam === true; // samples, operations, tests, campaigns (not projects)
const ROLE_RANK = { view: 1, edit: 2, investigator: 2 };

// ---- pure helpers (exported for the tests) ---------------------------------------------------------------

// A value as the snapshots and comparisons hold it: blank is null, a yes/no is a boolean, a date is YYYY-MM-DD, an id is lower case.
export function normaliseValue(kind, value) {
  if (isBlank(value)) return null;
  if (kind === 'bool') return toBool(value);
  if (kind === 'date') {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
    return String(value).slice(0, 10);
  }
  if (kind === 'relation') return String(value).toLowerCase();
  return String(value);
}

// JSON with sorted keys: two snapshots are equal when their canonical text is (jsonb reorders keys, so a plain stringify would not do).
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value === undefined ? null : value);
}
export const snapshotsEqual = (a, b) => canonical(a) === canonical(b);

// Validates the shape of a value against a field's kind and returns it normalised; throws a message (string) when it is wrong.
// Relations are checked against the database separately (the caller must be able to read the target).
export function checkValue(def, value) {
  if (value === null) {
    if (!def.clearable) throw new Error(`${def.label} cannot be cleared.`);
    return null;
  }
  if (def.kind === 'enum') {
    if (typeof value !== 'string' || !def.values.includes(value)) throw new Error(`${def.label} must be one of: ${def.values.join(', ')}.`);
    return value;
  }
  if (def.kind === 'bool') {
    if (typeof value !== 'boolean') throw new Error(`${def.label} must be yes or no.`);
    return value;
  }
  if (def.kind === 'date') {
    const ok = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
    if (!ok) throw new Error(`${def.label} must be a date as YYYY-MM-DD.`);
    return value;
  }
  if (def.kind === 'relation') {
    if (!isUuid(value)) throw new Error(`${def.label} must be an id.`);
    return value.toLowerCase();
  }
  throw new Error(`${def.label} cannot be edited in bulk.`);
}

// What a kind does to one record: the update payload and the snapshot keys it cares about.
//   { payload, noop(before) }  noop: is the record already as asked?
export function planFor(kind, params, fieldDef) {
  if (isAccessKind(kind)) return { access: true }; // runs through runAccess (it decides noop itself)
  if (kind === 'restrict' || kind === 'unrestrict') {
    const want = kind === 'restrict';
    return { payload: { restricted: want }, noop: (before) => before.restricted === want };
  }
  const { field } = params;
  const value = normaliseValue(fieldDef.kind, params.value);
  return { payload: { [field]: value }, noop: (before) => before[field] === value };
}

// ---- the summary email (pure) --------------------------------------------------------------------------------

const oneLine = (v) => String(v ?? '').replace(/[\r\n]+/g, ' ').trim();

// One mail to one recipient listing what an action gave them: { subject, text, html }. `items`: [{ code, link, blocked }] in the order to list; `blocked`
// means the recipient cannot read that record yet (no link is shown, as in the single-record mail; `blockedReason` 'parent' or 'no_login' words it). `mode`: 'team_owner' (a team
// was made the owner; the mail goes to its managers, `teamName`), 'owner' (the recipient was made the owner) or 'share' (the recipient was given access;
// `role` is the level in words, `teamName` when it comes through a team). One record reads exactly as the single-record mail of d1-record-access
// (mailContent); more list the first MAIL_LIST_MAX codes, then "and N more". Every interpolated value is HTML-escaped.
export function summaryContent({ adder, kind, items, mode, role = null, teamName = null, blockedReason = null }) {
  if (items.length === 1) {
    const [only] = items;
    return mailContent({
      adder, role, kind, code: only.code, title: null, link: only.blocked ? null : only.link, transfer: mode === 'owner', blockedReason: only.blocked ? blockedReason : null,
      via: mode === 'share' ? teamName : null, ownerTeam: mode === 'team_owner' ? teamName : null,
    });
  }
  const who = oneLine(adder) || 'Someone';
  const team = oneLine(teamName);
  const what = `${items.length} ${oneLine(kind)}s`;
  const phrase = mode === 'team_owner' ? `made the team ${team} the owner of ${what}` : mode === 'owner' ? `made you the owner of ${what}` : `gave you access to ${what}${team ? ` via ${team}` : ''}`;
  const listed = items.slice(0, MAIL_LIST_MAX);
  const more = items.length - listed.length;
  const roleLine = oneLine(role);
  const manager = mode === 'team_owner' ? `As a manager of ${team} you can share them, transfer them and delete them.` : null;
  const wait = items.some((i) => i.blocked)
    ? 'You cannot open some of them yet. You will be able to once you have a D1 login and access to what they sit under.'
    : null;
  const text = [
    `${who} ${phrase}.`,
    manager,
    mode === 'share' && roleLine ? `Your role: ${roleLine}.` : null,
    '',
    ...listed.map((i) => `- ${oneLine(i.code)}${i.link && !i.blocked ? `: ${i.link}` : ''}`),
    more > 0 ? `- and ${more} more` : null,
    wait ? '' : null,
    wait,
    '',
    'If you did not expect this, you can ignore this email.',
  ].filter((line) => line !== null).join('\n');
  const html = [
    `<p><strong>${escapeHtml(who)}</strong> ${escapeHtml(phrase)}.</p>`,
    manager ? `<p>${escapeHtml(manager)}</p>` : '',
    mode === 'share' && roleLine ? `<p>Your role: <strong>${escapeHtml(roleLine)}</strong>.</p>` : '',
    `<ul>${listed.map((i) => `<li>${i.link && !i.blocked ? `<a href="${escapeHtml(i.link)}">${escapeHtml(oneLine(i.code))}</a>` : escapeHtml(oneLine(i.code))}</li>`).join('')}${more > 0 ? `<li>and ${more} more</li>` : ''}</ul>`,
    wait ? `<p>${escapeHtml(wait)}</p>` : '',
    '<p>If you did not expect this, you can ignore this email.</p>',
  ].filter(Boolean).join('\n');
  return { subject: `${who} ${phrase}`, text, html };
}

// ---- the endpoint ----------------------------------------------------------------------------------------

export default {
  id: SOURCE,
  handler: (router, context) => {
    mount(router, context);
  },
};

// `clock` is injectable for the tests (the undo window); so are `timers` (the per-action mail timer: { set, clear }; `sweep: false` skips the startup sweep).
// Returns { swept }: the promise of the startup sweep of overdue summary mails (for the tests).
export function mount(router, context, clock = () => new Date(), timers = {}) {
  const { database, logger, services, env, emitter } = context;
  const setTimer = timers.set ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = timers.clear ?? ((handle) => clearTimeout(handle));
  const ops = makeAccessOps(context); // the rules of the access tables: the extracted bodies of d1-record-access, used as they are
  const warn = (message) => logger?.warn?.(`${SOURCE}: ${message}`);
  const labAdminRoleId = (typeof env?.D1_LAB_ADMIN_ROLE_ID === 'string' && env.D1_LAB_ADMIN_ROLE_ID.trim()) || DEFAULT_LAB_ADMIN_ROLE_ID;

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
      // a Lab Viewer changes nothing (preview is a POST that writes nothing, but there is nothing a viewer may preview)
      const labViewer = await isLabViewer(database, acc.user);
      if (labViewer && isWriteRequest(req)) throw new HttpError(403, 'READ_ONLY_ROLE', READ_ONLY_ROLE_MESSAGE);
      const caller = await accountAdmin(database, acc.user, labAdminRoleId);
      const admin = acc.admin === true || caller.admin;
      await fn({ req, res, acc, admin });
    } catch (err) {
      return sendError(res, err);
    }
  };

  // -- services ---------------------------------------------------------------------------------------
  // as the caller (Directus's permissions and filter hooks decide)
  const itemsFor = (req, collection, knex) =>
    new services.ItemsService(collection, { accountability: req.accountability, schema: req.schema, ...(knex ? { knex } : {}) });
  // as the system (to read what a snapshot needs: no permission rule hides a field from the journal)
  const systemItems = (req, collection, knex) => new services.ItemsService(collection, { schema: req.schema, ...(knex ? { knex } : {}) });

  // One write transaction: the actor first, so the audit trigger names the caller.
  const inTransaction = (acc, work) =>
    database.transaction(async (trx) => {
      await trx.raw("SELECT set_config('d1.actor_identity', ?, true)", [String(acc.user)]);
      return work(trx);
    });

  // A journal row for an action (or a revert); returns its id (the driver answers an id or { action_id }).
  async function insertAction(db, acc, { params, ...row }) {
    const person = await db('people').where('user_id', acc.user).first('person_id');
    const [created] = await db('bulk_actions').insert({
      actor_user: String(acc.user), actor_person: person?.person_id ?? null, params: JSON.stringify(params), mail_state: 'none', mail_due_at: null, ...row,
    }).returning('action_id');
    return typeof created === 'object' && created !== null ? created.action_id : created;
  }

  async function clearDataCache(req) {
    if (!toBool(env?.CACHE_ENABLED)) return;
    try {
      await new services.UtilsService({ schema: req.schema, accountability: { user: null, role: null, admin: true, app: false } }).clearCache({ system: false });
    } catch (err) {
      warn(`could not clear the data cache: ${err?.message || err}`);
    }
  }

  // Directus's action events held back during a row's transaction, emitted once it has committed (as Directus does for its own writes).
  function emitAfterCommit(events) {
    for (const e of events) {
      try {
        emitter?.emitAction?.(e.event, e.meta, e.context);
      } catch (err) {
        warn(`an action event was not emitted: ${err?.message || err}`);
      }
    }
  }

  // 404 for a record the caller cannot read (the read rule decides) or that does not exist.
  async function readable({ req, cfg }, id) {
    try {
      const row = await itemsFor(req, cfg.collection).readOne(id, { fields: [cfg.key] });
      return Boolean(row);
    } catch (err) {
      if (isForbidden(err) || err?.status === 404) return false;
      throw err;
    }
  }

  // -- snapshots --------------------------------------------------------------------------------------
  const snapshotFields = (cfg, kind, params) => (kind === 'edit_field' ? [params.field] : [cfg.ownerField, ...(cfg.ownerTeam ? ['owner_team_id'] : []), 'restricted']);

  // The record's fields. A field edit reads as the CALLER, so a field Directus hides from them (a 403) makes the record a skip and its value is
  // never journaled; restrict and unrestrict read the ownership columns as the system (the caller may not see who is on the access list, and the
  // journal returns those snapshots to administrators only).
  async function readRecord(trx, req, cfg, id, fields, asCaller) {
    const service = asCaller ? itemsFor(req, cfg.collection, trx) : systemItems(req, cfg.collection, trx);
    const row = await service.readOne(id, { fields });
    if (!row) throw new HttpError(404, 'NOT_FOUND', NOT_FOUND_REASON);
    return row;
  }

  // Row lock for the rest of the transaction: a concurrent edit waits instead of slipping in between the snapshot and the write.
  const lockRecord = (trx, cfg, id) => trx(cfg.collection).where(cfg.key, id).forUpdate().first(cfg.key);

  // The state of one record, in the shape of `before` and `after`.
  async function snapshot(trx, req, cfg, id, kind, params) {
    const rec = await readRecord(trx, req, cfg, id, snapshotFields(cfg, kind, params), kind === 'edit_field');
    if (kind === 'edit_field') {
      const def = BULK_FIELDS[cfg.collection][params.field];
      return { [params.field]: normaliseValue(def.kind, rec[params.field]) };
    }
    const ownerId = rec[cfg.ownerField];
    // a person's OWN list entry: the access row, or the old co-owner row (samples) read as the role it stands for; the stronger one when both exist
    const own = new Map();
    const put = (personId, role) => {
      const key = String(personId).toLowerCase();
      if (!own.has(key) || (ROLE_RANK[role] ?? 0) > (ROLE_RANK[own.get(key)] ?? 0)) own.set(key, role);
    };
    for (const r of await trx(cfg.table).where(cfg.fk, id).whereNull('team_access_id').select('person_id', 'role')) {
      if (r.role !== 'own' && String(r.person_id) !== String(ownerId ?? '')) put(r.person_id, r.role);
    }
    if (cfg.legacy) {
      const logins = (await trx(cfg.legacy.table).where(cfg.legacy.fk, id).select('user_id')).map((r) => r.user_id).filter((v) => !isBlank(v));
      if (logins.length) {
        for (const p of await trx('people').whereIn('user_id', logins).select('person_id')) {
          if (String(p.person_id) !== String(ownerId ?? '')) put(p.person_id, cfg.legacy.role);
        }
      }
    }
    const people = [...own].map(([person_id, role]) => ({ person_id, role })).sort((a, b) => a.person_id.localeCompare(b.person_id));
    const teams = (await trx(`${cfg.kind}_team_access`).where(cfg.fk, id).select('team_id', 'role', 'trust_new_members'))
      .filter((r) => r.role !== 'own')
      .map((r) => ({ team_id: String(r.team_id).toLowerCase(), role: r.role, trust_new_members: toBool(r.trust_new_members) }))
      .sort((a, b) => a.team_id.localeCompare(b.team_id));
    return {
      owner_person_id: isBlank(ownerId) ? null : String(ownerId).toLowerCase(),
      owner_team_id: cfg.ownerTeam && !isBlank(rec.owner_team_id) ? String(rec.owner_team_id).toLowerCase() : null,
      restricted: toBool(rec.restricted),
      people,
      teams,
    };
  }

  // -- errors from the update ---------------------------------------------------------------------------
  // The refusal text of d1-access-guard is plain words made for the person; Directus's own 403 gets one sentence of ours.
  // Directus validation errors (a 4xx with a message) are shown as they are; anything else (a database error) is logged and generic.
  function classify(err, phase = 'apply') {
    if (err instanceof AccessError) {
      // d1-record-access's own refusals (a 4xx with plain words): a skip, or for an undo that can no longer be done, a refusal
      if (err.code === 'FORBIDDEN') return { outcome: 'skipped', reason: phase === 'revert' ? REVERT_NOT_MANAGER : NOT_OWNER_REASON };
      if (err.code === 'TEAM_HAS_NO_MANAGER' && phase === 'revert') return { outcome: 'skipped', reason: REVERT_NO_MANAGER };
      if (err.status >= 500) {
        logger?.error?.(`${SOURCE}: ${err?.stack || err?.message || err}`);
        return { outcome: 'failed', reason: FAILED_REASON };
      }
      return { outcome: 'skipped', reason: err.message };
    }
    if (err instanceof Mismatch) return { outcome: 'failed', reason: REVERT_MISMATCH };
    if (isForbidden(err)) {
      const reason = err?.extensions?.source === 'd1-access-guard' && !isBlank(err.extensions.reason) ? String(err.extensions.reason) : NO_PERMISSION_REASON;
      return { outcome: 'skipped', reason };
    }
    if (typeof err?.status === 'number' && err.status >= 400 && err.status < 500 && !isBlank(err.message) && typeof err.code !== 'number') {
      return { outcome: 'failed', reason: String(err.message) };
    }
    logger?.error?.(`${SOURCE}: ${err?.stack || err?.message || err}`);
    return { outcome: 'failed', reason: FAILED_REASON };
  }

  // -- the ownership and access kinds, one record -----------------------------------------------------------
  // Inside the record's transaction (the row is locked and `before` is read): the caller must manage the record (a refusal is a skip), then the kind's own
  // rules, then the write, which is one of d1-record-access's own bodies (never a copy of its rules). Returns { noop: true } (nothing written) or
  // { noop: false, warning? }; a preview adds the warning, worked out after the change inside the transaction the preview rolls back. A refusal is
  // thrown as d1-record-access's HttpError and becomes the row's skip reason.
  async function transferWarnings(trx, args, before) {
    const { acc } = args;
    const out = [];
    const me = await ops.callerName(trx, acc);
    // the acting person managed it through the team that owned it: that team's managers are not kept (Ruling O5)
    if (before.owner_team_id && me.personId
      && (await trx('team_members').where({ team_id: before.owner_team_id, person_id: me.personId, is_manager: true }).first('person_id'))) out.push(WARN_TEAM_MANAGERS_LOSE);
    if (!(await ops.canManage(args, trx))) out.push(WARN_YOU_LOSE_MANAGE);
    return out;
  }

  async function runAccess(trx, ctx, id, before, preview) {
    const { req, acc, cfg, kind, params } = ctx;
    const args = { req, acc, cfg, id };
    await ops.requireManage(args, trx);
    const warnings = [];
    if (kind === 'assign_team') {
      if (!cfg.ownerTeam) throw new AccessError(409, 'NOT_OWNABLE_BY_TEAM', NOT_OWNABLE_REASON);
      if (before.owner_team_id === params.team_id) return { noop: true };
      await ops.transfer(trx, args, { team_id: params.team_id });
      if (preview) warnings.push(...(await transferWarnings(trx, args, before)));
    } else if (kind === 'change_owner') {
      if (before.owner_person_id === params.person_id) return { noop: true };
      const done = await ops.transfer(trx, args, { person_id: params.person_id });
      if (preview) {
        warnings.push(...(await transferWarnings(trx, args, before)));
        try {
          const stop = await ops.blockedFor(trx, cfg, id, done.record, done.next, acc);
          if (stop) warnings.push(warnBlocked(firstOf(done.next, ['full_name']) ?? 'The new owner', stop));
        } catch (err) {
          warn(`could not tell whether the new owner can open ${cfg.collection} ${id}: ${err?.message || err}`);
        }
      }
    } else if (kind === 'share_access' && params.person_id) {
      if (before.owner_person_id === params.person_id) await ops.addPerson(trx, args, { person_id: params.person_id, role: params.role }); // refuses: the owner already
      const person = await ops.personById(trx, params.person_id);
      const had = person ? await ops.rowsOf(trx, cfg, id, person) : { access: null, legacy: null };
      const level = had.access?.role ?? (had.legacy ? cfg.legacy.role : null);
      if (level === params.role) return { noop: true };
      if (level) await ops.changePersonRole(trx, args, { person_id: params.person_id, role: params.role });
      else await ops.addPerson(trx, args, { person_id: params.person_id, role: params.role });
    } else if (kind === 'share_access') {
      const grant = await ops.grantOf(trx, cfg, id, params.team_id);
      const listed = grant && grant.role !== 'own'; // the owning team is the owner, not a share (addTeam refuses it)
      if (listed && grant.role === params.role) return { noop: true };
      if (listed) await ops.changeTeam(trx, args, { team_id: params.team_id, patch: { role: params.role } });
      else await ops.addTeam(trx, args, { team_id: params.team_id, role: params.role });
    } else if (params.person_id) {
      // remove_access, a person
      const person = await ops.personById(trx, params.person_id);
      if (!person) return { noop: true };
      if (before.owner_person_id === params.person_id) throw new AccessError(409, 'CONFLICT', OWNER_REMOVE_REASON);
      const had = await ops.rowsOf(trx, cfg, id, person);
      if (!had.access && !had.legacy) return { noop: true };
      await ops.removePerson(trx, args, { person_id: params.person_id });
    } else {
      // remove_access, a team
      if (!(await ops.grantOf(trx, cfg, id, params.team_id))) return { noop: true };
      await ops.removeTeam(trx, args, { team_id: params.team_id }); // refuses the owning team (TEAM_OWNS_RECORD)
    }
    return { noop: false, ...(warnings.length ? { warning: warnings.join(' ') } : {}) };
  }

  // Undo and revert of an access change: from `current` (equal to what the action left) back to `before`, through the same bodies (no mail). The owner first
  // (a transfer keeps the previous person owner as Can edit and removes the new owner's own row, so the list is read again), then people, then team grants.
  // Refusals (the old owner team has no manager now; the caller cannot manage any more, Rulings O4 and O5) are thrown and become `refused`.
  async function restoreAccess(trx, args, current, before) {
    const { req, cfg, id } = args;
    let now = current;
    if (now.owner_team_id !== before.owner_team_id || now.owner_person_id !== before.owner_person_id) {
      if (before.owner_team_id) await ops.transfer(trx, args, { team_id: before.owner_team_id });
      else if (before.owner_person_id) await ops.transfer(trx, args, { person_id: before.owner_person_id });
      else throw new AccessError(409, 'CONFLICT', REVERT_NO_OWNER);
      now = await snapshot(trx, req, cfg, id, 'assign_team', {});
    }
    const haveP = new Map(now.people.map((p) => [p.person_id, p.role]));
    const wantP = new Map(before.people.map((p) => [p.person_id, p.role]));
    for (const personId of haveP.keys()) if (!wantP.has(personId)) await ops.removePerson(trx, args, { person_id: personId });
    for (const [personId, role] of wantP) {
      if (!haveP.has(personId)) await ops.addPerson(trx, args, { person_id: personId, role });
      else if (haveP.get(personId) !== role) await ops.changePersonRole(trx, args, { person_id: personId, role });
    }
    const haveT = new Map(now.teams.map((t) => [t.team_id, t]));
    const wantT = new Map(before.teams.map((t) => [t.team_id, t]));
    for (const teamId of haveT.keys()) if (!wantT.has(teamId)) await ops.removeTeam(trx, args, { team_id: teamId });
    for (const [teamId, want] of wantT) {
      const had = haveT.get(teamId);
      if (!had) {
        await ops.addTeam(trx, args, { team_id: teamId, role: want.role });
        if (want.trust_new_members) await ops.changeTeam(trx, args, { team_id: teamId, patch: { trust_new_members: true } });
      } else {
        const patch = {};
        if (had.role !== want.role) patch.role = want.role;
        if (had.trust_new_members !== want.trust_new_members) patch.trust_new_members = want.trust_new_members;
        if (Object.keys(patch).length) await ops.changeTeam(trx, args, { team_id: teamId, patch });
      }
    }
    if (!snapshotsEqual(await snapshot(trx, req, cfg, id, 'assign_team', {}), before)) throw new Mismatch();
  }

  // -- one record, preview or apply -----------------------------------------------------------------------
  // `commit`: keep the change (apply) or roll it back (preview). `journal`: { action_id } writes the record's journal row inside the same
  // transaction. Returns { id, code, outcome, reason, before, after, events }.
  async function runOne(ctx, id, { commit, journal = null }) {
    const { req, acc, cfg, kind, params, fieldDef, plan } = ctx;
    const result = { id, code: null, outcome: 'skipped', reason: null, warning: null, before: null, after: null, events: [] };
    try {
      if (!(await readable(ctx, id))) {
        result.reason = NOT_FOUND_REASON;
        return result;
      }
      await inTransaction(acc, async (trx) => {
        await lockRecord(trx, cfg, id); // the snapshot and the write see the same row
        result.code = firstOf(await readRecord(trx, req, cfg, id, cfg.code, true), cfg.code); // the label, as the caller
        result.before = await snapshot(trx, req, cfg, id, kind, params);
        if (plan.access) {
          // ownership and access: a refusal is thrown (d1-record-access's HttpError) and rolls the record's transaction back
          const done = await runAccess(trx, ctx, id, result.before, !commit);
          if (done.noop) {
            result.outcome = 'noop';
            result.after = result.before;
            throw new Rollback();
          }
          result.warning = done.warning ?? null;
        } else {
          if (plan.noop(result.before)) {
            result.outcome = 'noop';
            result.after = result.before;
            throw new Rollback();
          }
          try {
            await itemsFor(req, cfg.collection, trx).updateOne(id, plan.payload, { bypassEmitAction: (e) => result.events.push(e), autoPurgeCache: false });
          } catch (err) {
            Object.assign(result, classify(err));
            throw new Rollback();
          }
        }
        result.after = await snapshot(trx, req, cfg, id, kind, params);
        if (snapshotsEqual(result.before, result.after)) {
          // Directus accepted it and nothing changed (a hook put it back): not an applied change
          result.outcome = 'noop';
          throw new Rollback();
        }
        result.outcome = 'applied';
        if (journal && commit) {
          await trx('bulk_action_rows').insert({
            action_id: journal.action_id, record_id: String(id), record_code: result.code, outcome: 'applied', reason: null,
            before: JSON.stringify(result.before), after: JSON.stringify(result.after),
          });
        }
        if (!commit) throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) {
        if (err instanceof HttpError && err.status === 404) {
          result.outcome = 'skipped';
          result.reason = NOT_FOUND_REASON;
        } else {
          Object.assign(result, classify(err));
        }
      }
    }
    if (!commit || result.outcome !== 'applied') result.events = [];
    return result;
  }

  // -- request parsing ------------------------------------------------------------------------------------
  function parseRequest(req) {
    const collection = req.params?.collection;
    const cfg = isCollection(collection) ? COLLECTIONS[collection] : null;
    if (!cfg) throw new HttpError(400, 'INVALID_PAYLOAD', 'That kind of record has no bulk actions.');
    const body = isObject(req.body) ? req.body : {};
    const kind = body.kind;
    if (typeof kind !== 'string' || !KINDS.includes(kind)) throw new HttpError(400, 'INVALID_PAYLOAD', 'That action is not available.');
    // restrict, change owner, share and remove access are for the four ownable record types; assign to a team is accepted anywhere (a record that no team
    // can own is skipped per row, Ruling O3)
    if (kind !== 'edit_field' && kind !== 'assign_team' && !ownable(cfg)) throw new HttpError(400, 'NOT_APPLICABLE', 'That action does not apply to this kind of record.');
    if (kind === 'edit_field' && !hasOwn(BULK_FIELDS, cfg.collection)) throw new HttpError(400, 'NOT_APPLICABLE', 'That action does not apply to this kind of record.');

    const rawIds = body.ids;
    if (!Array.isArray(rawIds) || rawIds.length === 0) throw new HttpError(400, 'INVALID_PAYLOAD', 'Pick at least one record.');
    if (!rawIds.every(isUuid)) throw new HttpError(400, 'INVALID_PAYLOAD', 'One of the record ids is not valid.');
    const ids = [];
    const seen = new Set();
    for (const id of rawIds) {
      const key = id.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        ids.push(id);
      }
    }
    if (ids.length > MAX_IDS) throw new HttpError(400, 'INVALID_PAYLOAD', `Pick at most ${MAX_IDS} records at a time.`);

    let params = {};
    let fieldDef = null;
    if (kind === 'edit_field') {
      const given = isObject(body.params) ? body.params : {};
      const field = given.field;
      if (typeof field !== 'string' || !hasOwn(BULK_FIELDS[cfg.collection], field)) throw new HttpError(400, 'INVALID_PAYLOAD', 'That field cannot be edited in bulk.');
      if (!hasOwn(given, 'value')) throw new HttpError(400, 'INVALID_PAYLOAD', 'Say what to set the field to (null clears it).');
      fieldDef = BULK_FIELDS[cfg.collection][field];
      try {
        params = { field, value: checkValue(fieldDef, given.value) };
      } catch (err) {
        throw new HttpError(400, 'INVALID_PAYLOAD', err.message);
      }
    }
    if (isAccessKind(kind)) params = parseAccessParams(cfg, kind, isObject(body.params) ? body.params : {});
    return { cfg, kind, ids, params, fieldDef };
  }

  // params of the access kinds: assign_team { team_id }, change_owner { person_id }, share_access { person_id | team_id, role }, remove_access { person_id | team_id }.
  // Ids are lower-cased (the snapshots hold them so).
  function parseAccessParams(cfg, kind, given) {
    const ask = (key, label) => {
      if (!isUuid(given[key])) throw new HttpError(400, 'INVALID_PAYLOAD', `${key} must be ${label}.`);
      return given[key].toLowerCase();
    };
    if (kind === 'assign_team') return { team_id: ask('team_id', 'a team id') };
    if (kind === 'change_owner') return { person_id: ask('person_id', 'a person id') };
    const hasPerson = given.person_id !== undefined;
    const hasTeam = given.team_id !== undefined;
    if (hasPerson && hasTeam) throw new HttpError(400, 'INVALID_PAYLOAD', 'Send a person_id or a team_id, not both.');
    if (!hasPerson && !hasTeam) throw new HttpError(400, 'INVALID_PAYLOAD', 'Choose a person or a team.');
    const target = hasPerson ? { person_id: ask('person_id', 'a person id') } : { team_id: ask('team_id', 'a team id') };
    if (kind === 'remove_access') return target;
    if (given.role !== 'view' && given.role !== 'edit') throw new HttpError(400, 'INVALID_PAYLOAD', 'The access level must be view or edit.');
    if (!cfg.roles.includes(given.role)) throw new HttpError(400, 'INVALID_PAYLOAD', `The access level must be one of: ${cfg.roles.join(', ')}.`);
    return { ...target, role: given.role };
  }

  // The person or team the action points at must exist (and a person be active) before any record is touched, so one wrong choice is one 400, not a
  // skip on every row. Removing access needs neither: a person or team that is gone is simply not listed.
  async function checkTarget(kind, params) {
    if (kind === 'remove_access') return;
    if (params.team_id) {
      if (!(await database('teams').where('team_id', params.team_id).first('team_id'))) throw new HttpError(400, 'INVALID_PAYLOAD', 'That team does not exist.');
    } else if (params.person_id) {
      const person = await ops.personById(database, params.person_id);
      if (!person) throw new HttpError(400, 'INVALID_PAYLOAD', 'That person does not exist.');
      if (person.active === false) throw new HttpError(400, 'INVALID_PAYLOAD', 'That person is not active.');
    }
  }

  // A relation value must be something the CALLER can read (else a person could probe for ids they may not see). Checked once per request.
  async function checkRelation(req, fieldDef, value) {
    if (fieldDef?.kind !== 'relation' || value === null) return;
    const { collection, key } = fieldDef.relation;
    let found = false;
    try {
      found = Boolean(await itemsFor(req, collection).readOne(value, { fields: [key] }));
    } catch (err) {
      if (!isForbidden(err) && err?.status !== 404) throw err;
    }
    if (!found) throw new HttpError(400, 'INVALID_PAYLOAD', `That ${fieldDef.label.toLowerCase()} does not exist, or you cannot see it.`);
  }

  async function prepare(req, acc) {
    const parsed = parseRequest(req);
    await checkRelation(req, parsed.fieldDef, parsed.params.value);
    await checkTarget(parsed.kind, parsed.params);
    return { ...parsed, req, acc, plan: planFor(parsed.kind, parsed.params, parsed.fieldDef) };
  }

  // -- preview -----------------------------------------------------------------------------------------
  router.post('/:collection/preview', route(async ({ req, res, acc }) => {
    const ctx = await prepare(req, acc);
    const results = [];
    const counts = { total: ctx.ids.length, ok: 0, noop: 0, skip: 0 };
    for (const id of ctx.ids) {
      const r = await runOne(ctx, id, { commit: false });
      const status = r.outcome === 'applied' ? 'ok' : r.outcome === 'noop' ? 'noop' : 'skip';
      counts[status] += 1;
      results.push({ id: r.id, code: r.code, status, ...(r.reason ? { reason: r.reason } : {}), ...(status === 'ok' && r.warning ? { warning: r.warning } : {}) });
    }
    res.json({ results, counts });
  }));

  // -- apply -------------------------------------------------------------------------------------------
  router.post('/:collection/apply', route(async ({ req, res, acc }) => {
    const ctx = await prepare(req, acc);
    const started = clock();
    // The action row first, so every record's journal row (written in that record's own transaction) has a parent. Its counts stay null until
    // the loop is over: undo and revert refuse an action that is still being applied (STILL_APPLYING).
    const actionId = await insertAction(database, acc, {
      collection: ctx.cfg.collection, kind: ctx.kind, params: ctx.params, created_at: started, undo_until: new Date(started.getTime() + UNDO_WINDOW_MS),
      n_applied: null, n_skipped: null, n_failed: null,
    });

    const results = [];
    const counts = { total: ctx.ids.length, applied: 0, noop: 0, skipped: 0, failed: 0 };
    const unjournaled = [];
    let undoUntil;
    let mailDue = null;
    try {
      for (const id of ctx.ids) {
        const r = await runOne(ctx, id, { commit: true, journal: { action_id: actionId } });
        counts[r.outcome] += 1;
        if (r.outcome === 'applied') emitAfterCommit(r.events);
        else {
          unjournaled.push({
            action_id: actionId, record_id: String(id), record_code: r.code, outcome: r.outcome, reason: r.reason ?? null,
            before: null, after: null, // snapshots are kept only for records that were changed
          });
        }
        results.push({ id: r.id, code: r.code, outcome: r.outcome, ...(r.reason ? { reason: r.reason } : {}) });
      }
    } finally {
      // Whatever happened, the counts are written so the action can be reverted. The window starts when the work is done (up to 100 records take a while).
      undoUntil = new Date(clock().getTime() + UNDO_WINDOW_MS);
      // The summary email is held until the window closes (plus a moment), and only when something changed and the kind tells someone.
      if (counts.applied && MAILING_KINDS.includes(ctx.kind)) mailDue = new Date(undoUntil.getTime() + MAIL_GRACE_MS);
      await database.transaction(async (trx) => {
        if (unjournaled.length) await trx('bulk_action_rows').insert(unjournaled);
        await trx('bulk_actions').where('action_id', actionId).update({
          n_applied: counts.applied, n_skipped: counts.skipped + counts.noop, n_failed: counts.failed, undo_until: undoUntil,
          ...(mailDue ? { mail_state: 'pending', mail_due_at: mailDue } : {}),
        });
      });
    }
    if (mailDue) scheduleMail(actionId, mailDue, req.schema);
    if (counts.applied) await clearDataCache(req);
    res.json({ action_id: actionId, undo_until: undoUntil.toISOString(), results, counts });
  }));

  // -- undo and revert -----------------------------------------------------------------------------------
  const sameUser = (a, b) => !isBlank(a) && !isBlank(b) && String(a).toLowerCase() === String(b).toLowerCase();
  const parseJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v ?? null);

  // An action the caller may see (administrators: any; everyone else: their own), else 404. `lockRow` holds the row for the transaction.
  async function visibleAction(db, { req, acc, admin }, lockRow = false) {
    const id = req.params?.action_id;
    if (!isUuid(id)) throw new HttpError(400, 'INVALID_PAYLOAD', 'The action id is not valid.');
    const query = db('bulk_actions').where('action_id', id);
    const action = await (lockRow ? query.forUpdate() : query).first();
    if (!action || (!admin && !sameUser(action.actor_user, acc.user))) throw new HttpError(404, 'NOT_FOUND', 'That bulk action does not exist, or you cannot see it.');
    return action;
  }

  // One record of an undo or revert, in its own transaction. Returns { revert_outcome, reason, before, after, events }.
  async function revertOne(ctx, row) {
    const { req, acc, cfg, kind, params } = ctx;
    const out = { id: row.record_id, code: row.record_code ?? null, revert_outcome: 'failed', reason: null, before: null, after: null, events: [] };
    const fieldDef = kind === 'edit_field' ? (BULK_FIELDS[cfg.collection] ?? {})[params.field] : null;
    const before = parseJson(row.before);
    const after = parseJson(row.after);
    const refuse = (reason) => Object.assign(out, { revert_outcome: 'refused', reason });
    // what happened to this record, written to its journal row: inside the record's transaction when it commits, else on its own below
    const finish = (db) => db('bulk_action_rows').where({ action_id: row.action_id, record_id: row.record_id }).update({ revert_outcome: out.revert_outcome, revert_reason: out.reason });
    let journaled = false;
    try {
      if (kind === 'edit_field' && !fieldDef) {
        refuse('That field can no longer be edited in bulk.');
      } else if (!(await readable({ req, cfg }, row.record_id))) {
        refuse(NOT_FOUND_REASON);
      } else {
        await inTransaction(acc, async (trx) => {
          await lockRecord(trx, cfg, row.record_id); // compared and written under the row lock
          const current = await snapshot(trx, req, cfg, row.record_id, kind, params);
          out.before = current;
          if (!snapshotsEqual(current, after)) {
            Object.assign(out, { revert_outcome: 'changed_since', reason: 'Changed since this action ran, so it was left alone.', after: current });
          } else {
            if (isAccessKind(kind)) {
              // owner, access list and team grants go back through d1-record-access's bodies (no mail); a rule that forbids it now is a refusal
              await restoreAccess(trx, { req, acc, cfg, id: row.record_id }, current, before);
            } else {
              const payload = kind === 'edit_field'
                ? { [params.field]: normaliseValue(fieldDef.kind, before[params.field]) }
                : { restricted: before.restricted === true };
              try {
                await itemsFor(req, cfg.collection, trx).updateOne(row.record_id, payload, { bypassEmitAction: (e) => out.events.push(e), autoPurgeCache: false });
              } catch (err) {
                out.after = current;
                throw err;
              }
            }
            out.after = await snapshot(trx, req, cfg, row.record_id, kind, params);
            Object.assign(out, { revert_outcome: 'reverted', reason: null });
          }
          await finish(trx);
        });
        journaled = true; // the outcome committed with the record
      }
    } catch (err) {
      // a refusal or a failure rolled the record's transaction back
      const c = classify(err, 'revert');
      Object.assign(out, { revert_outcome: c.outcome === 'skipped' ? 'refused' : 'failed', reason: c.reason });
    }
    if (!journaled) {
      try {
        await finish(database);
      } catch (e) {
        warn(`could not journal the revert outcome of ${row.record_id}: ${e?.message || e}`);
      }
    }
    if (out.revert_outcome !== 'reverted') out.events = [];
    return out;
  }

  // mode 'undo': the actor inside the window, or an administrator. mode 'revert': administrators, any time.
  async function undoOrRevert(c, mode) {
    const { req, res, acc, admin } = c;
    const actionId = req.params?.action_id;
    if (mode === 'revert' && !admin) throw new HttpError(403, 'FORBIDDEN', 'Only an administrator can revert a bulk action.');
    const finished = await database.transaction(async (lock) => {
      // The action row is locked for the whole run: a second undo or revert waits, then finds the state changed (409).
      const action = await visibleAction(lock, c, true);
      if (action.n_applied === null || action.n_applied === undefined) throw new HttpError(409, 'STILL_APPLYING', 'That bulk action is still being applied. Try again in a moment.');
      if (!isBlank(action.revert_of)) throw new HttpError(409, 'CANNOT_REVERT_A_REVERT', 'A revert cannot be reverted. Run the action again instead.');
      const now = clock();
      if (mode === 'undo' && !admin && !(now.getTime() < new Date(action.undo_until).getTime())) {
        throw new HttpError(403, 'UNDO_WINDOW_CLOSED', 'The 60 seconds to undo have passed. Ask an administrator to revert it.');
      }
      // undone and reverted are final; applied and partly_reverted (a retry of what was changed since or refused) can go on
      if (action.state === 'undone' || action.state === 'reverted' || (mode === 'undo' && action.state !== 'applied')) {
        throw new HttpError(409, 'ALREADY_REVERTED', 'That bulk action has already been undone or reverted.');
      }
      const cfg = COLLECTIONS[action.collection];
      if (!cfg) throw new HttpError(400, 'INVALID_PAYLOAD', 'That kind of record has no bulk actions.');
      const kind = action.kind;
      const params = parseJson(action.params) ?? {};
      const all = await lock('bulk_action_rows').where('action_id', actionId).select();
      const applied = all.filter((r) => r.outcome === 'applied');
      const todo = applied.filter((r) => r.revert_outcome !== 'reverted');
      if (!applied.length) throw new HttpError(409, 'NOTHING_TO_REVERT', 'That bulk action has nothing left to revert.');
      if (!todo.length) {
        // every record is reverted but the state never got written (a crash after the records committed): put it right, then answer 409
        await lock('bulk_actions').where('action_id', actionId).update({ state: mode === 'undo' ? 'undone' : 'reverted', ...(action.mail_state === 'pending' ? { mail_state: 'cancelled' } : {}) });
        return { healed: true };
      }

      const ctx = { req, acc, cfg, kind, params };
      const outs = [];
      for (const row of todo) {
        const o = await revertOne(ctx, row);
        if (o.revert_outcome === 'reverted') emitAfterCommit(o.events);
        outs.push(o);
      }
      const revertedNow = outs.filter((o) => o.revert_outcome === 'reverted').length;
      const totalReverted = applied.length - todo.length + revertedNow;
      const state = totalReverted === applied.length ? (mode === 'undo' ? 'undone' : 'reverted') : 'partly_reverted';

      // The revert is itself a journaled bulk action: same kind, linked to the original, never undone, mails nobody.
      const revertId = await insertAction(lock, acc, {
        collection: action.collection, kind, params, created_at: now, undo_until: now, state: 'applied', revert_of: actionId,
        n_applied: revertedNow, n_skipped: outs.filter((o) => o.revert_outcome === 'changed_since' || o.revert_outcome === 'refused').length,
        n_failed: outs.filter((o) => o.revert_outcome === 'failed').length,
      });
      if (outs.length) {
        await lock('bulk_action_rows').insert(outs.map((o) => ({
          action_id: revertId, record_id: String(o.id), record_code: o.code,
          outcome: o.revert_outcome === 'reverted' ? 'applied' : o.revert_outcome === 'failed' ? 'failed' : 'skipped',
          reason: o.reason,
          before: o.revert_outcome === 'reverted' ? JSON.stringify(o.before) : null,
          after: o.revert_outcome === 'reverted' ? JSON.stringify(o.after) : null,
        })));
      }
      // The held summary mail: an undo cancels it; so does a revert that put anything back (the mail would announce what is no longer so). This runs under the
      // action's row lock, and the sender claims the mail under the same lock, so one of the two wins and never both.
      const cancelMail = action.mail_state === 'pending' && (mode === 'undo' || revertedNow > 0);
      await lock('bulk_actions').where('action_id', actionId).update({ state, ...(cancelMail ? { mail_state: 'cancelled' } : {}) });
      return { state, revertId, outs, revertedNow, cancelMail };
    });
    if (finished.cancelMail && mailTimers.has(keyOf(actionId))) {
      clearTimer(mailTimers.get(keyOf(actionId)));
      mailTimers.delete(keyOf(actionId));
    }
    if (finished.healed) throw new HttpError(409, 'ALREADY_REVERTED', 'That bulk action has already been undone or reverted.');
    if (finished.revertedNow) await clearDataCache(req);
    res.json({
      state: finished.state,
      revert_action_id: finished.revertId,
      results: finished.outs.map((o) => ({ id: o.id, code: o.code, revert_outcome: o.revert_outcome, ...(o.reason ? { reason: o.reason } : {}) })),
    });
  }
  router.post('/:action_id/undo', route((c) => undoOrRevert(c, 'undo')));
  router.post('/:action_id/revert', route((c) => undoOrRevert(c, 'revert')));

  // -- the journal ---------------------------------------------------------------------------------------
  async function actorNames(db, actions) {
    const users = [...new Set(actions.map((a) => String(a.actor_user)))];
    const names = new Map();
    if (!users.length) return names;
    for (const p of await db('people').whereIn('user_id', users).select('user_id', 'full_name')) if (!isBlank(p.full_name)) names.set(String(p.user_id), String(p.full_name).trim());
    const missing = users.filter((u) => !names.has(u));
    if (missing.length) {
      for (const u of await db('directus_users').whereIn('id', missing).select('id', 'first_name', 'last_name', 'email')) {
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

  router.get('/', route(async ({ req, res, acc, admin }) => {
    const limit = Math.min(LIST_MAX, Math.max(1, Number.parseInt(req.query?.limit, 10) || LIST_DEFAULT));
    const offset = Math.max(0, Number.parseInt(req.query?.offset, 10) || 0);
    let q = database('bulk_actions');
    if (!admin) q = q.where('actor_user', String(acc.user));
    const rows = await q.orderBy('created_at', 'desc').limit(limit + 1).offset(offset).select();
    const page = rows.slice(0, limit);
    const names = await actorNames(database, page);
    res.json({ actions: page.map((a) => actionOut(a, names)), limit, offset, has_more: rows.length > limit });
  }));

  router.get('/:action_id', route(async (c) => {
    const { res, admin } = c;
    const action = await visibleAction(database, c);
    const names = await actorNames(database, [action]);
    const rows = await database('bulk_action_rows').where('action_id', action.action_id).select();
    res.json({
      action: actionOut(action, names),
      rows: rows
        .map((r) => ({
          record_id: r.record_id, record_code: r.record_code ?? null, outcome: r.outcome, reason: r.reason ?? null,
          // the snapshots can hold values and access lists the actor may not see: administrators only
          before: admin ? parseJson(r.before) : null, after: admin ? parseJson(r.after) : null, revert_outcome: r.revert_outcome ?? null, revert_reason: r.revert_reason ?? null,
        }))
        .sort((a, b) => String(a.record_code ?? '').localeCompare(String(b.record_code ?? '')) || a.record_id.localeCompare(b.record_id)),
    });
  }));

  // -- summary emails, held until the undo window closes (spec 3.4) --------------------------------------------
  // At apply an action that tells someone is `pending` with mail_due_at = undo_until + 2 s, and a timer (one per action) sends it then. Undo (and a revert
  // that put anything back) sets `cancelled` under the action's row lock. The sender CLAIMS the held mail under the same lock (pending -> sent, committed)
  // before it sends, so an undo and a send can never both happen; a mail that fails afterwards is logged and never undoes the change (the claim stands: one
  // try). On start a sweep sends every overdue pending action and re-arms the ones not yet due, so a restart only delays mail, it never loses it.
  const mailTimers = new Map();
  const keyOf = (actionId) => String(actionId).toLowerCase();

  function scheduleMail(actionId, dueAt, schema) {
    const key = keyOf(actionId);
    if (mailTimers.has(key)) clearTimer(mailTimers.get(key));
    const handle = setTimer(() => {
      mailTimers.delete(key);
      sendActionMail(actionId, schema).catch((err) => warn(`the summary mail of bulk action ${actionId} failed: ${err?.message || err}`));
    }, Math.max(0, dueAt.getTime() - clock().getTime()));
    handle?.unref?.(); // a pending mail timer must never keep the process (or a test run) alive
    mailTimers.set(key, handle);
  }

  // Who is mailed, read now (a person removed since is not mailed): { person, mode, role, teamName }
  async function mailRecipients(action, params, cfg) {
    const keep = (p) => p && p.active !== false && String(p.user_id ?? '') !== String(action.actor_user); // never the one who ran it
    if (action.kind === 'assign_team') {
      const team = await database('teams').where('team_id', params.team_id).first('team_id', 'name');
      if (!team) return [];
      const ids = (await database('team_members').where('team_id', team.team_id).where('is_manager', true).select('person_id')).map((m) => m.person_id);
      const people = ids.length ? await database('people').whereIn('person_id', ids).select(...PERSON_COLUMNS) : [];
      return people.filter((p) => keep(p) && !isBlank(p.user_id)).map((person) => ({ person, mode: 'team_owner', role: null, teamName: team.name }));
    }
    if (action.kind === 'change_owner') {
      const person = await ops.personById(database, params.person_id);
      return keep(person) ? [{ person, mode: 'owner', role: null, teamName: null }] : [];
    }
    if (action.kind !== 'share_access') return [];
    const role = roleLabel(cfg.collection, params.role);
    if (params.person_id) {
      const person = await ops.personById(database, params.person_id);
      return keep(person) ? [{ person, mode: 'share', role, teamName: null }] : [];
    }
    const team = await database('teams').where('team_id', params.team_id).first('team_id', 'name');
    if (!team) return [];
    const ids = (await database('team_members').where('team_id', team.team_id).select('person_id')).map((m) => m.person_id);
    const people = ids.length ? await database('people').whereIn('person_id', ids).select(...PERSON_COLUMNS) : [];
    return people.filter(keep).map((person) => ({ person, mode: 'share', role, teamName: team.name }));
  }

  // The records among `ids` this person can open now (their readers rows; an administrator opens all; a person with no login none)
  async function openableBy(person, cfg, ids) {
    if (isBlank(person.user_id)) return new Set();
    if (await ops.isAdminLogin(database, person.user_id)) return new Set(ids.map(String));
    const rows = await database(cfg.readers).whereIn('record_id', ids).where('user_id', person.user_id).select('record_id');
    return new Set(rows.map((r) => String(r.record_id)));
  }

  async function deliverMail(action, schema, tally) {
    const cfg = COLLECTIONS[action.collection];
    const params = parseJson(action.params) ?? {};
    // built from the journal now: what was applied and has not been put back since
    const rows = (await database('bulk_action_rows').where('action_id', action.action_id).select())
      .filter((r) => r.outcome === 'applied' && r.revert_outcome !== 'reverted')
      .sort((a, b) => String(a.record_code ?? '').localeCompare(String(b.record_code ?? '')) || String(a.record_id).localeCompare(String(b.record_id)));
    if (!cfg || !rows.length) return;
    const recipients = await mailRecipients(action, params, cfg);
    if (!recipients.length) return;
    const logins = [...new Set(recipients.map((r) => r.person.user_id).filter((v) => !isBlank(v)))];
    const users = new Map();
    if (logins.length) for (const u of await database('directus_users').whereIn('id', logins).select('id', 'email')) users.set(String(u.id), u);
    const { name: adder } = await ops.callerName(database, { user: action.actor_user });
    const ids = rows.map((r) => String(r.record_id));
    const resolved = schema ?? (typeof context.getSchema === 'function' ? await context.getSchema() : undefined);
    await Promise.all(recipients.map(async ({ person, mode, role, teamName }) => {
      try {
        const to = recipientAddress(person, isBlank(person.user_id) ? null : users.get(String(person.user_id)));
        if (!to) {
          tally.skipped += 1;
          return;
        }
        const open = await openableBy(person, cfg, ids);
        const items = rows.map((r) => ({ code: r.record_code ?? '', link: recordLink(env?.PUBLIC_URL, cfg.collection, r.record_id, env?.STARBASE_URL), blocked: !open.has(String(r.record_id)) }));
        const content = summaryContent({ adder, kind: cfg.kind, items, mode, role, teamName, blockedReason: isBlank(person.user_id) ? 'no_login' : 'parent' });
        const mail = new services.MailService({ schema: resolved, knex: database });
        await withTimeout(mail.send({ to, subject: content.subject, html: content.html, text: content.text }), MAIL_TIMEOUT_MS);
        tally.sent += 1;
      } catch (err) {
        tally.failed += 1;
        warn(`the summary mail of bulk action ${action.action_id} to ${person?.person_id} was not sent: ${err?.message || err}`);
      }
    }));
  }

  // Claim the held mail (under the row lock) and send it. Returns { sent, skipped, failed }, or null when there was nothing to send (already sent, undone).
  async function sendActionMail(actionId, schema) {
    const action = await database.transaction(async (trx) => {
      const a = await trx('bulk_actions').where('action_id', actionId).forUpdate().first();
      if (!a || a.mail_state !== 'pending') return null;
      const gone = a.state === 'undone' || a.state === 'reverted';
      await trx('bulk_actions').where('action_id', actionId).update({ mail_state: gone ? 'cancelled' : 'sent' });
      return gone ? null : a;
    });
    if (!action) return null;
    const tally = { sent: 0, skipped: 0, failed: 0 };
    try {
      await deliverMail(action, schema, tally);
    } catch (err) {
      warn(`the summary mail of bulk action ${actionId} was not sent: ${err?.message || err}`);
    }
    return tally;
  }

  async function sweepMail() {
    const now = clock().getTime();
    for (const a of await database('bulk_actions').where('mail_state', 'pending').select('action_id', 'mail_due_at')) {
      const due = a.mail_due_at ? new Date(a.mail_due_at).getTime() : 0;
      if (due <= now) await sendActionMail(a.action_id, undefined);
      else scheduleMail(a.action_id, new Date(due), undefined);
    }
  }
  const swept = timers.sweep === false ? Promise.resolve() : sweepMail().catch((err) => warn(`the sweep of held summary mails failed: ${err?.message || err}`));
  return { swept };
}
