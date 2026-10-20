// Directus endpoint: d1-bulk-actions  (mounted at /d1-bulk-actions)
//
// Bulk actions on the index pages (spec docs/superpowers/specs/2026-10-20-bulk-actions-design.md): one action on up to 100 ticked records,
// a dry-run preview per record, apply with partial success, a 60-second undo for the person who ran it, a revert for administrators, and
// the journal behind all of it (migration 204: bulk_actions, bulk_action_rows; read and written only here).
//
// This release has three kinds: `restrict`, `unrestrict` and `edit_field` (the ownership and access kinds come with the next ones).
//
//   POST /d1-bulk-actions/:collection/preview   { kind, ids[], params }
//     -> { results: [{ id, code, status: 'ok'|'noop'|'skip', reason? }], counts: { total, ok, noop, skip } }
//   POST /d1-bulk-actions/:collection/apply     { kind, ids[], params }
//     -> { action_id, undo_until, results: [{ id, code, outcome: 'applied'|'noop'|'skipped'|'failed', reason? }],
//          counts: { total, applied, noop, skipped, failed } }
//   POST /d1-bulk-actions/:action_id/undo       -> { state, revert_action_id, results: [{ id, code, revert_outcome, reason? }] }
//        the person who ran it while now < undo_until, or an administrator
//   POST /d1-bulk-actions/:action_id/revert     -> the same shape; administrators only, any time
//   GET  /d1-bulk-actions                       -> { actions: [...], limit, offset, has_more }  (?limit=50 max 200, ?offset=0; administrators see
//        all, everyone else only their own; newest first)
//   GET  /d1-bulk-actions/:action_id            -> { action, rows: [...] }  (the same visibility; 404 for an action you may not see; each row
//        has before and after (the snapshots) for administrators only, null for everyone else)
//   params: restrict and unrestrict {}; edit_field { field, value } (value null clears the field). collection: physical_samples,
//   manufacturing_operations, test_sessions or campaigns (restrict and unrestrict) and the same four for edit_field (BULK_FIELDS below is the
//   allow-list per collection; the index pages mirror it in `bulkFields`).
//
// Errors (the Directus shape { errors: [{ message, extensions: { code, source: 'd1-bulk-actions' } }] }): 401 no user; 403 READ_ONLY_ROLE
// (a Lab Viewer, on preview too: there is nothing a viewer may preview); 400 INVALID_PAYLOAD (collection, kind, ids, field or value);
// 400 NOT_APPLICABLE (the kind is not valid for that collection); 404 NOT_FOUND (an action you may not see); 403 FORBIDDEN (revert by a
// non-administrator, undo by someone else); 403 UNDO_WINDOW_CLOSED; 409 CANNOT_REVERT_A_REVERT, ALREADY_REVERTED (state undone or
// reverted), NOTHING_TO_REVERT (the action applied nothing).
//
// How a request runs, per record (preview and apply run the SAME function; preview in a transaction that is always rolled back, so the
// two cannot disagree):
//   1. requireReadable: ItemsService.readOne as the caller. A record the caller cannot read is skipped as "not found", with no code, never
//      revealed.
//   2. in ONE knex transaction that first does set_config('d1.actor_identity', <caller>, true) (so audit_logs names the caller): the
//      `before` snapshot, then ItemsService.updateOne as the CALLER, so Directus's permissions and d1-access-guard decide (the guard's
//      refusal text becomes the skip reason), then the `after` snapshot. A value already as asked is `noop` and never written.
//   3. apply: the record's journal row is written in the same transaction, so a change and its journal commit together; preview rolls
//      everything back. Directus's action events (the hooks that cascade a project or campaign change) are held back with
//      `bypassEmitAction` and emitted after the commit (never for a preview; filter hooks, including d1-access-guard, still run).
//   After commit: the Directus data cache is cleared once for the whole action when CACHE_ENABLED is on.
//
// Snapshots (what `before` and `after` hold, so "unchanged since" is a plain comparison): restrict and unrestrict keep the ownership and
// access shape of the spec { owner_person_id, owner_team_id, restricted, people: [{ person_id, role }], teams: [{ team_id, role,
// trust_new_members }] } (a person's OWN rows, a team's grants; never the derived rows or the database-held owner grant, which are
// consequences); edit_field keeps { <field>: <value> }.
//
// Undo and revert are one implementation (section 3.3 of the spec): for each applied row, the current snapshot is compared to `after`
// (different: `changed_since`, nothing written), otherwise `before` is written back as the caller (a refusal: `refused`, a crash:
// `failed`). The revert is journaled as a new bulk_actions row (`revert_of` = the original, mail_state 'none', undo_until = created_at, so
// it can never be undone) and the original's state becomes undone (by `undo`), reverted (by `revert`) or partly_reverted. A row already
// reverted is never reverted again; an administrator can run `revert` again on a partly_reverted action to retry the rest.

import { COLLECTIONS, READ_ONLY_ROLE_MESSAGE, isLabViewer, isWriteRequest } from '../d1-record-access/index.js';
import { accountAdmin } from '../d1-people-admin/index.js';

const SOURCE = 'd1-bulk-actions';
const DEFAULT_LAB_ADMIN_ROLE_ID = '10000001-0000-0000-0000-000000000001';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IDS = 100;
const UNDO_WINDOW_MS = 60_000;
const LIST_DEFAULT = 50;
const LIST_MAX = 200;

// The kinds this release implements (the others are in the journal's CHECK already, for the next ones).
export const KINDS = ['restrict', 'unrestrict', 'edit_field'];

// The fields a bulk edit may set, per collection: { field: { kind, label, clearable, values?, relation? } }. The server's own allow-list, mirrored by
// `bulkFields` of the index pages (packages/d1-ui/src/index/indexConfig.ts); the value is validated against the kind, then Directus's permissions
// and d1-access-guard decide per record. `clearable` is false for NOT NULL columns. `values` are the database's CHECK values. Left out on purpose:
// session_date and operation_date (timestamps), work_state and process_category (they change through Mark done and the builder), campaigns.status
// (no CHECK, so no known values), 'planned' as a sample status (it leaves when its operation is marked done), free text.
export const BULK_FIELDS = {
  physical_samples: {
    current_status: { kind: 'enum', label: 'Status', clearable: false, values: ['active', 'consumed', 'destroyed', 'archived'] },
    project_id: { kind: 'relation', label: 'Project', clearable: true, relation: { collection: 'projects', key: 'project_id' } },
    export_controlled: { kind: 'bool', label: 'Export control', clearable: false },
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

const isBlank = (v) => v === undefined || v === null || v === '';
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const toBool = (v) => v === true || v === 'true' || v === 1 || v === '1' || v === 't';
const isUuid = (v) => typeof v === 'string' && UUID.test(v);
const hasOwn = (obj, key) => Object.hasOwn(obj, key);
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
  if (kind === 'restrict' || kind === 'unrestrict') {
    const want = kind === 'restrict';
    return { payload: { restricted: want }, noop: (before) => before.restricted === want };
  }
  const { field } = params;
  const value = normaliseValue(fieldDef.kind, params.value);
  return { payload: { [field]: value }, noop: (before) => before[field] === value };
}

// ---- the endpoint ----------------------------------------------------------------------------------------

export default {
  id: SOURCE,
  handler: (router, context) => mount(router, context),
};

// `clock` is injectable for the tests (the undo window).
export function mount(router, context, clock = () => new Date()) {
  const { database, logger, services, env, emitter } = context;
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
      await fn({ req, res, acc, admin, labViewer });
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

  async function clearDataCache(req) {
    if (!(env?.CACHE_ENABLED === true || env?.CACHE_ENABLED === 'true' || env?.CACHE_ENABLED === 1 || env?.CACHE_ENABLED === '1')) return;
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
    const people = (await trx(cfg.table).where(cfg.fk, id).whereNull('team_access_id').select('person_id', 'role'))
      .filter((r) => r.role !== 'own' && String(r.person_id) !== String(ownerId ?? ''))
      .map((r) => ({ person_id: String(r.person_id).toLowerCase(), role: r.role }))
      .sort((a, b) => a.person_id.localeCompare(b.person_id));
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
  function classify(err) {
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

  // -- one record, preview or apply -----------------------------------------------------------------------
  // `commit`: keep the change (apply) or roll it back (preview). `journal`: { action_id } writes the record's journal row inside the same
  // transaction. Returns { id, code, outcome, reason, before, after, events }.
  async function runOne(ctx, id, { commit, journal = null }) {
    const { req, acc, cfg, kind, params, fieldDef, plan } = ctx;
    const result = { id, code: null, outcome: 'skipped', reason: null, before: null, after: null, events: [] };
    if (!(await readable(ctx, id))) {
      result.reason = NOT_FOUND_REASON;
      return result;
    }
    try {
      await inTransaction(acc, async (trx) => {
        await lockRecord(trx, cfg, id); // the snapshot and the write see the same row
        result.code = firstOf(await readRecord(trx, req, cfg, id, cfg.code, true), cfg.code); // the label, as the caller
        result.before = await snapshot(trx, req, cfg, id, kind, params);
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
        result.events = [];
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
    if ((kind === 'restrict' || kind === 'unrestrict') && !ownable(cfg)) throw new HttpError(400, 'NOT_APPLICABLE', 'That action does not apply to this kind of record.');
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
    return { cfg, kind, ids, params, fieldDef };
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
      results.push({ id: r.id, code: r.code, status, ...(r.reason ? { reason: r.reason } : {}) });
    }
    res.json({ results, counts });
  }));

  // -- apply -------------------------------------------------------------------------------------------
  router.post('/:collection/apply', route(async ({ req, res, acc }) => {
    const ctx = await prepare(req, acc);
    const person = await database('people').where('user_id', acc.user).first('person_id');
    const started = clock();
    const header = {
      actor_user: String(acc.user), actor_person: person?.person_id ?? null, collection: ctx.cfg.collection, kind: ctx.kind,
      params: JSON.stringify(ctx.params), created_at: started, undo_until: new Date(started.getTime() + UNDO_WINDOW_MS),
      mail_state: 'none', mail_due_at: null, n_applied: 0, n_skipped: 0, n_failed: 0,
    };
    // The action row first, so every record's journal row (written in that record's own transaction) has a parent.
    const [created] = await database('bulk_actions').insert(header).returning('action_id');
    const actionId = typeof created === 'object' && created !== null ? created.action_id : created;

    const results = [];
    const counts = { total: ctx.ids.length, applied: 0, noop: 0, skipped: 0, failed: 0 };
    const unjournaled = [];
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
    // The window starts when the answer is ready, not when the work began (up to 100 records take a while).
    const undoUntil = new Date(clock().getTime() + UNDO_WINDOW_MS);
    await database.transaction(async (trx) => {
      if (unjournaled.length) await trx('bulk_action_rows').insert(unjournaled);
      await trx('bulk_actions').where('action_id', actionId).update({
        n_applied: counts.applied, n_skipped: counts.skipped + counts.noop, n_failed: counts.failed, undo_until: undoUntil,
      });
    });
    if (counts.applied) await clearDataCache(req);
    res.json({ action_id: actionId, undo_until: undoUntil.toISOString(), results, counts });
  }));

  // -- undo and revert -----------------------------------------------------------------------------------
  const actionOr404 = async (db, id) => {
    if (!isUuid(id)) throw new HttpError(400, 'INVALID_PAYLOAD', 'The action id is not valid.');
    return db('bulk_actions').where('action_id', id).first();
  };
  const NO_SUCH_ACTION = () => new HttpError(404, 'NOT_FOUND', 'That bulk action does not exist, or you cannot see it.');
  const sameUser = (a, b) => !isBlank(a) && !isBlank(b) && String(a).toLowerCase() === String(b).toLowerCase();
  const parseJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v ?? null);

  // One record of an undo or revert, in its own transaction. Returns { revert_outcome, reason, before, after, events }.
  async function revertOne(ctx, row) {
    const { req, acc, cfg, kind, params } = ctx;
    const out = { id: row.record_id, code: row.record_code ?? null, revert_outcome: 'failed', reason: null, before: null, after: null, events: [] };
    const fieldDef = kind === 'edit_field' ? (BULK_FIELDS[cfg.collection] ?? {})[params.field] : null;
    const before = parseJson(row.before);
    const after = parseJson(row.after);
    // what happened to this record, written to its journal row (inside the record's transaction when there is one)
    let journaled = false;
    const finish = async (db) => {
      journaled = true;
      await db('bulk_action_rows').where({ action_id: row.action_id, record_id: row.record_id }).update({ revert_outcome: out.revert_outcome, revert_reason: out.reason });
    };
    if (kind === 'edit_field' && !fieldDef) {
      out.revert_outcome = 'refused';
      out.reason = 'That field can no longer be edited in bulk.';
      await finish(database);
      return out;
    }
    if (!(await readable({ req, cfg }, row.record_id))) {
      out.revert_outcome = 'refused';
      out.reason = NOT_FOUND_REASON;
      await finish(database);
      return out;
    }
    try {
      await inTransaction(acc, async (trx) => {
        await lockRecord(trx, cfg, row.record_id); // compared and written under the row lock
        const current = await snapshot(trx, req, cfg, row.record_id, kind, params);
        out.before = current;
        if (!snapshotsEqual(current, after)) {
          out.revert_outcome = 'changed_since';
          out.reason = 'Changed since this action ran, so it was left alone.';
          out.after = current;
          await finish(trx);
          return;
        }
        const payload = kind === 'edit_field'
          ? { [params.field]: normaliseValue(fieldDef.kind, before[params.field]) }
          : { restricted: before.restricted === true };
        try {
          await itemsFor(req, cfg.collection, trx).updateOne(row.record_id, payload, { bypassEmitAction: (e) => out.events.push(e), autoPurgeCache: false });
        } catch (err) {
          const c = classify(err);
          out.revert_outcome = c.outcome === 'skipped' ? 'refused' : 'failed';
          out.reason = c.reason;
          out.after = current;
          out.events = [];
          throw new Rollback();
        }
        out.after = await snapshot(trx, req, cfg, row.record_id, kind, params);
        out.revert_outcome = 'reverted';
        out.reason = null;
        await finish(trx);
      });
    } catch (err) {
      if (!(err instanceof Rollback)) {
        const c = classify(err);
        out.revert_outcome = c.outcome === 'skipped' ? 'refused' : 'failed';
        out.reason = c.reason;
        journaled = false;
      }
    }
    if (!journaled) {
      // a refusal or a failure rolled the record's transaction back: remember what happened to it on its own
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
  async function undoOrRevert({ req, res, acc, admin }, mode) {
    const actionId = req.params?.action_id;
    if (mode === 'revert' && !admin) throw new HttpError(403, 'FORBIDDEN', 'Only an administrator can revert a bulk action.');
    const finished = await database.transaction(async (lock) => {
      // The action row is locked for the whole run: a second undo or revert waits, then finds the state changed (409).
      if (!isUuid(actionId)) throw new HttpError(400, 'INVALID_PAYLOAD', 'The action id is not valid.');
      const action = await lock('bulk_actions').where('action_id', actionId).forUpdate().first();
      if (!action || (!admin && !sameUser(action.actor_user, acc.user))) throw NO_SUCH_ACTION();
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
        await lock('bulk_actions').where('action_id', actionId).update({ state: mode === 'undo' ? 'undone' : 'reverted' });
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
      const person = await lock('people').where('user_id', acc.user).first('person_id');
      const [created] = await lock('bulk_actions').insert({
        actor_user: String(acc.user), actor_person: person?.person_id ?? null, collection: action.collection, kind, params: JSON.stringify(params),
        created_at: now, undo_until: now, state: 'applied', revert_of: actionId, mail_state: 'none', mail_due_at: null,
        n_applied: revertedNow, n_skipped: outs.filter((o) => o.revert_outcome === 'changed_since' || o.revert_outcome === 'refused').length,
        n_failed: outs.filter((o) => o.revert_outcome === 'failed').length,
      }).returning('action_id');
      const revertId = typeof created === 'object' && created !== null ? created.action_id : created;
      if (outs.length) {
        await lock('bulk_action_rows').insert(outs.map((o) => ({
          action_id: revertId, record_id: String(o.id), record_code: o.code,
          outcome: o.revert_outcome === 'reverted' ? 'applied' : o.revert_outcome === 'failed' ? 'failed' : 'skipped',
          reason: o.reason,
          before: o.revert_outcome === 'reverted' ? JSON.stringify(o.before) : null,
          after: o.revert_outcome === 'reverted' ? JSON.stringify(o.after) : null,
        })));
      }
      await lock('bulk_actions').where('action_id', actionId).update({ state });
      return { state, revertId, outs, revertedNow };
    });
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

  router.get('/:action_id', route(async ({ req, res, acc, admin }) => {
    const action = await actionOr404(database, req.params?.action_id);
    if (!action || (!admin && !sameUser(action.actor_user, acc.user))) throw NO_SUCH_ACTION();
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
}
