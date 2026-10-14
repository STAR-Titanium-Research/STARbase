// Directus endpoint: d1-build  (mounted at /d1-build)
//
// The server half of the process map's edit mode (ADR-0018, ADR-0019; spec
// docs/superpowers/specs/2026-10-14-process-map-edit-mode-design.md sections 5 and 6, migrations 185 and 186).
// The browser builds a DRAFT (a DraftBody, spec 5.1: items, wires, positions) and this endpoint keeps it, checks it,
// and turns the whole draft into real records in ONE database transaction.
//
//   GET    /d1-build/drafts                 -> { data: [{ id, name, updated_at, summary }] }   the caller's drafts, newest first;
//                                              summary is one line of what Create would make ("2 operations, 4 samples")
//   POST   /d1-build/drafts {name?, body}   -> 201 { data: { id, name, body, version, updated_at } }
//   GET    /d1-build/drafts/:id             -> { data: { id, name, body, version, updated_at } }     owner only, else 404
//   PATCH  /d1-build/drafts/:id {name?, body?, version}  -> { data: { id, name, body, version, updated_at } }
//                                              409 CONFLICT when version is not the stored one (another tab saved first)
//   DELETE /d1-build/drafts/:id             -> 204
//   POST   /d1-build/drafts/:id/check       -> { data: { checks: Check[] } }                  (the server's checks, spec E5, E13)
//   POST   /d1-build/drafts/:id/create      -> { data: { created: { [DraftKey]: { collection, id, code } }, sampleIds: string[] } }
//                                              409 { errors: [{ extensions: { code: 'CHECKS', checks } }] } when a blocking check holds
//                                              (nothing is written); a failed write: { errors: [{ extensions: { code: 'WRITE_FAILED', key } }] }
//                                              (everything is rolled back, the draft is untouched)
//   POST   /d1-build/mark-done {collection, id, date?, personId?} -> { data: { id, work_state: 'done' } }  (409 CHECKS as above)
//   GET    /d1-build/templates              -> { data: [{ id, name, scope, role_id, collection, values, user_id, updated_at, version }] }
//   GET    /d1-build/templates/:id, POST /d1-build/templates, PATCH /d1-build/templates/:id, DELETE /d1-build/templates/:id
//   Check = { key: DraftKey (or a record id for mark-done); field?: string; level: 'block' | 'warn'; text: string }
//
// Every route needs a signed-in user (401 otherwise). Errors have the Directus shape
// { errors: [{ message, extensions: { code, source: 'd1-build', ... } }] }.
//
// How it runs (the d1-record-access and d1-people-admin pattern):
//   * Drafts and templates live in d1_private (migration 186): outside the Directus schema scan, reached only here, with
//     plain parameterised SQL. A draft is private to its owner (every query names user_id); a save names the version it was
//     made against (UPDATE ... WHERE version = ?), so a stale tab gets 409 instead of overwriting.
//   * The caller's reads and writes of RECORDS go through Directus's ItemsService with the caller's accountability and, for
//     writes, `knex: trx` (the one transaction), so Directus permissions and every hook (d1-owner-default, d1-access-guard,
//     d1-campaign-inherit, the code triggers' inputs ...) apply exactly as for a form save. Every write transaction starts with
//     set_config('d1.actor_identity', <caller>, true), so the audit trigger names the caller. The Directus data cache is cleared
//     after a commit when CACHE_ENABLED is on (knex writes bypass the services that do it).
//   * Testable without Directus: mount(router, { database, services, getSchema, logger, env }, clock) takes everything it uses,
//     and the pure parts are exported (validateDraftBody, summarise, orderOperations, buildPlan, computeChecks ...).
//
// Naming of keys: a DraftKey names an item (a sample, an operation, a test). An operation's `rows` (one per output piece) have
// their own keys; `created` holds one entry per created record: a sample or test under its item key, an operation under each of
// its row keys (and under its item key too, for its first row, unless a row key is the same).

const SOURCE = 'd1-build';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9_-]{1,40}$/;
const FIELD = /^[a-z_][a-z0-9_]{0,63}$/;

// Limits that keep one draft a draft and not a dump: the body is a few hundred small objects at most.
export const LIMITS = { bodyChars: 1_000_000, items: 300, rows: 100, wires: 1000, name: 200, positions: 1000 };

export const WORK_STATES = ['planned', 'done'];
export const KINDS = ['sample', 'operation', 'test'];

// What each kind of item makes.
export const KIND_COLLECTION = { sample: 'physical_samples', operation: 'manufacturing_operations', test: 'test_sessions' };
export const COLLECTION_PK = {
  physical_samples: 'sample_id',
  manufacturing_operations: 'operation_id',
  test_sessions: 'session_id',
  batches: 'batch_id',
  campaign_samples: 'id',
};
// The column that holds a record's human code.
export const COLLECTION_CODE = {
  physical_samples: 'sample_code',
  manufacturing_operations: 'pass_code',
  test_sessions: 'test_code',
};

// Fields the wiring or the server decides, so a draft's `values` may not carry them (the endpoint writes them from the wires,
// the work state and the database). Refusing them on save keeps a client bug from silently rewiring or marking something done.
const COMMON_RESERVED = ['version', 'created_at', 'updated_at', 'short_id', 'code_sort', 'created_by', 'restricted'];
export const RESERVED_FIELDS = {
  sample: ['sample_id', 'current_status', ...COMMON_RESERVED],
  operation: [
    'operation_id', 'sample_id', 'output_sample_id', 'work_state', 'done_by_person_id', 'done_at', 'batch_id',
    ...COMMON_RESERVED,
  ],
  test: [
    'session_id', 'sample_id', 'subject', 'work_state', 'done_by_person_id', 'done_at', 'batch_id', 'insert_edge_id',
    ...COMMON_RESERVED,
  ],
};

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const isBlank = (v) => v === undefined || v === null || v === '' || (typeof v === 'string' && v.trim() === '');
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const trimmed = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const toBool = (v) => v === true || v === 'true' || v === 1 || v === '1';
const rowsOf = (out) => out?.rows ?? [];
const toIso = (t) => (t instanceof Date ? t.toISOString() : t == null ? null : new Date(t).toISOString());

// ---- the draft body: validation (spec 5.1) ---------------------------------------------------------------------------

const fail = (message) => ({ ok: false, message });
const isInt = (v, min = 0) => Number.isInteger(v) && v >= min;

// Checks the SHAPE of a DraftBody and returns { ok: true, body } or { ok: false, message }. What a draft means (a wire to
// nothing, an operation without a method) is the checks' job, not the save's: a draft is saved while it is still being built.
// Unknown extra properties are kept as they come (a client may carry its own), the known ones must be well-formed.
export function validateDraftBody(input) {
  if (!isObject(input)) return fail('The draft body must be an object.');
  if (input.v !== 1) return fail('The draft body must have v: 1.');
  for (const f of ['projectId', 'campaignId']) {
    const v = input[f];
    if (v !== null && v !== undefined && !(typeof v === 'string' && UUID.test(v))) return fail(`${f} must be an id or null.`);
  }
  if (!Array.isArray(input.items)) return fail('items must be a list.');
  if (!Array.isArray(input.wires)) return fail('wires must be a list.');
  if (!isObject(input.positions)) return fail('positions must be an object.');
  if (input.items.length > LIMITS.items) return fail(`A draft holds at most ${LIMITS.items} items.`);
  if (input.wires.length > LIMITS.wires) return fail(`A draft holds at most ${LIMITS.wires} wires.`);
  if (Object.keys(input.positions).length > LIMITS.positions) return fail('positions holds too many entries.');

  for (const [i, item] of input.items.entries()) {
    const at = `items[${i}]`;
    if (!isObject(item)) return fail(`${at} must be an object.`);
    if (typeof item.key !== 'string' || !KEY.test(item.key)) return fail(`${at}.key must be a short key (letters, digits, - and _).`);
    if (!KINDS.includes(item.kind)) return fail(`${at}.kind must be sample, operation or test.`);
    if (!isObject(item.values)) return fail(`${at}.values must be an object.`);
    for (const field of Object.keys(item.values)) {
      if (!FIELD.test(field)) return fail(`${at}.values has a field name that is not allowed: ${field.slice(0, 40)}.`);
      if (RESERVED_FIELDS[item.kind].includes(field)) {
        return fail(`${at}.values must not set ${field}: the wiring and the server decide it.`);
      }
    }
    if (item.existing !== undefined) {
      const e = item.existing;
      if (!isObject(e) || typeof e.id !== 'string' || !UUID.test(e.id) || !isInt(e.version, 0)) {
        return fail(`${at}.existing must be { id, version }.`);
      }
    }
    if (item.remove !== undefined && item.remove !== true) return fail(`${at}.remove must be true when present.`);
    if (item.kind !== 'sample' && !WORK_STATES.includes(item.workState)) return fail(`${at}.workState must be planned or done.`);
    if (item.attach !== undefined && (item.attach !== true || item.kind !== 'operation')) {
      return fail(`${at}.attach is true on an operation only.`);
    }
    if (item.kind === 'operation') {
      if (!Array.isArray(item.rows)) return fail(`${at}.rows must be a list.`);
      if (item.rows.length > LIMITS.rows) return fail(`${at} has too many rows.`);
      for (const [r, row] of item.rows.entries()) {
        if (!isObject(row) || typeof row.key !== 'string' || !KEY.test(row.key)) return fail(`${at}.rows[${r}].key must be a short key.`);
      }
    }
  }
  for (const [i, wire] of input.wires.entries()) {
    const at = `wires[${i}]`;
    if (!isObject(wire)) return fail(`${at} must be an object.`);
    for (const end of ['from', 'to']) {
      const e = wire[end];
      if (!isObject(e) || typeof e.key !== 'string' || !KEY.test(e.key)) return fail(`${at}.${end}.key must be a short key.`);
      if (e.row !== undefined && !isInt(e.row, 0)) return fail(`${at}.${end}.row must be a row number.`);
    }
  }
  for (const [key, p] of Object.entries(input.positions)) {
    if (!KEY.test(key)) return fail('positions has a key that is not a short key.');
    if (!isObject(p) || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return fail(`positions.${key} must be { x, y } numbers.`);
  }
  if (JSON.stringify(input).length > LIMITS.bodyChars) return fail('The draft is too large.');
  return { ok: true, body: input };
}

// A name: 1 to 200 characters once trimmed.
export function validateName(name) {
  const t = trimmed(name);
  if (!t) return fail('A name is needed.');
  if (t.length > LIMITS.name) return fail(`A name is at most ${LIMITS.name} characters.`);
  return { ok: true, name: t };
}

// ---- the summary line (spec 5.2 summary.ts, server side) -------------------------------------------------------------

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// What Create would make or change, in words: "2 operations, 4 samples". New records only count as records (an operation with
// four rows is four operations); existing records count when they carry edits or a removal. An empty draft says so.
export function summarise(body) {
  const items = Array.isArray(body?.items) ? body.items : [];
  let operations = 0;
  let samples = 0;
  let tests = 0;
  let edits = 0;
  let removals = 0;
  for (const item of items) {
    if (item?.remove) {
      removals += 1;
    } else if (item?.existing) {
      if (item.attach || (isObject(item.values) && Object.keys(item.values).length > 0)) edits += 1;
    } else if (item?.kind === 'operation') {
      operations += Array.isArray(item.rows) && item.rows.length > 0 ? item.rows.length : 1;
    } else if (item?.kind === 'sample') {
      samples += 1;
    } else if (item?.kind === 'test') {
      tests += 1;
    }
  }
  const parts = [];
  if (operations) parts.push(plural(operations, 'operation', 'operations'));
  if (samples) parts.push(plural(samples, 'sample', 'samples'));
  if (tests) parts.push(plural(tests, 'test', 'tests'));
  if (edits) parts.push(plural(edits, 'change to an existing record', 'changes to existing records'));
  if (removals) parts.push(plural(removals, 'removal', 'removals'));
  return parts.length ? parts.join(', ') : 'Empty';
}

// ---- SQL (parameterised; exported so the schema tests can run these exact statements) ---------------------------------

export const SQL = {
  setActor: "SELECT set_config('d1.actor_identity', ?, true)",
  listDrafts:
    'SELECT draft_id, name, body, updated_at FROM d1_private.process_drafts'
    + ' WHERE user_id = ? ORDER BY updated_at DESC, draft_id LIMIT 200',
  getDraft:
    'SELECT draft_id, name, body, version, updated_at FROM d1_private.process_drafts WHERE draft_id = ? AND user_id = ?',
  lockDraft:
    'SELECT draft_id, name, body, version, updated_at FROM d1_private.process_drafts'
    + ' WHERE draft_id = ? AND user_id = ? FOR UPDATE',
  insertDraft:
    'INSERT INTO d1_private.process_drafts (user_id, name, body) VALUES (?, ?, ?::jsonb)'
    + ' RETURNING draft_id, name, body, version, updated_at',
  // Bindings: name (or null), body JSON (or null), id, user, the version the save was made against.
  updateDraft:
    'UPDATE d1_private.process_drafts SET name = COALESCE(?, name), body = COALESCE(?::jsonb, body),'
    + ' version = version + 1, updated_at = now()'
    + ' WHERE draft_id = ? AND user_id = ? AND version = ?'
    + ' RETURNING draft_id, name, body, version, updated_at',
  deleteDraft: 'DELETE FROM d1_private.process_drafts WHERE draft_id = ? AND user_id = ?',
};

// ---- the endpoint ----------------------------------------------------------------------------------------------------

const draftOut = (r) => ({
  id: r.draft_id,
  name: r.name,
  body: typeof r.body === 'string' ? JSON.parse(r.body) : r.body,
  version: Number(r.version),
  updated_at: toIso(r.updated_at),
});

export function mount(router, context, clock = () => new Date()) {
  const { database, logger } = context;

  const sendError = (res, err) => {
    const known = err instanceof HttpError;
    if (!known) logger?.error?.(`${SOURCE}: ${err?.stack || err?.message || err}`);
    return res.status(known ? err.status : 500).json({
      errors: [{
        message: known ? err.message : 'Something went wrong on the server.',
        extensions: { ...(known ? err.extra : {}), code: known ? err.code : 'INTERNAL_SERVER_ERROR', source: SOURCE },
      }],
    });
  };
  // Routes: need a signed-in user, hand the handler the request, turn every failure into a Directus-shaped answer.
  const route = (fn) => async (req, res) => {
    try {
      const acc = req.accountability;
      if (!acc?.user) throw new HttpError(401, 'UNAUTHORIZED', 'Sign in first.');
      await fn({ req, res, acc });
    } catch (err) {
      sendError(res, err);
    }
  };
  const idParam = (req, what) => {
    const id = req.params?.id;
    if (typeof id !== 'string' || !UUID.test(id)) throw new HttpError(404, 'NOT_FOUND', `That ${what} does not exist.`);
    return id.toLowerCase();
  };

  // -- drafts -----------------------------------------------------------------------------------------------------

  router.get('/drafts', route(async ({ res, acc }) => {
    const rows = rowsOf(await database.raw(SQL.listDrafts, [acc.user]));
    res.json({
      data: rows.map((r) => ({
        id: r.draft_id,
        name: r.name,
        updated_at: toIso(r.updated_at),
        summary: summarise(typeof r.body === 'string' ? JSON.parse(r.body) : r.body),
      })),
    });
  }));

  router.post('/drafts', route(async ({ req, res, acc }) => {
    const b = req.body;
    if (!isObject(b)) throw new HttpError(400, 'INVALID_PAYLOAD', 'Send a JSON body with { name?, body }.');
    const body = validateDraftBody(b.body);
    if (!body.ok) throw new HttpError(400, 'INVALID_PAYLOAD', body.message);
    let name = `Draft · ${clock().toISOString().slice(0, 10)}`;
    if (b.name !== undefined && b.name !== null) {
      const n = validateName(b.name);
      if (!n.ok) throw new HttpError(400, 'INVALID_PAYLOAD', n.message);
      name = n.name;
    }
    const [row] = rowsOf(await database.raw(SQL.insertDraft, [acc.user, name, JSON.stringify(body.body)]));
    res.status(201).json({ data: draftOut(row) });
  }));

  router.get('/drafts/:id', route(async ({ req, res, acc }) => {
    const id = idParam(req, 'draft');
    const [row] = rowsOf(await database.raw(SQL.getDraft, [id, acc.user]));
    if (!row) throw new HttpError(404, 'NOT_FOUND', 'That draft does not exist.');
    res.json({ data: draftOut(row) });
  }));

  router.patch('/drafts/:id', route(async ({ req, res, acc }) => {
    const id = idParam(req, 'draft');
    const b = req.body;
    if (!isObject(b)) throw new HttpError(400, 'INVALID_PAYLOAD', 'Send a JSON body with { name?, body?, version }.');
    if (!isInt(b.version, 1)) throw new HttpError(400, 'INVALID_PAYLOAD', 'version must be the version this save was made against.');
    if (b.name === undefined && b.body === undefined) throw new HttpError(400, 'INVALID_PAYLOAD', 'Send a name or a body to save.');
    let name = null;
    if (b.name !== undefined) {
      const n = validateName(b.name);
      if (!n.ok) throw new HttpError(400, 'INVALID_PAYLOAD', n.message);
      name = n.name;
    }
    let body = null;
    if (b.body !== undefined) {
      const v = validateDraftBody(b.body);
      if (!v.ok) throw new HttpError(400, 'INVALID_PAYLOAD', v.message);
      body = JSON.stringify(v.body);
    }
    const [row] = rowsOf(await database.raw(SQL.updateDraft, [name, body, id, acc.user, b.version]));
    if (row) return res.json({ data: draftOut(row) });
    // Nothing changed: the draft is not the caller's (or gone), or another save came first.
    const [there] = rowsOf(await database.raw(SQL.getDraft, [id, acc.user]));
    if (!there) throw new HttpError(404, 'NOT_FOUND', 'That draft does not exist.');
    throw new HttpError(409, 'CONFLICT', 'This draft changed in another tab. Reload it to see the latest version.');
  }));

  router.delete('/drafts/:id', route(async ({ req, res, acc }) => {
    const id = idParam(req, 'draft');
    const out = await database.raw(SQL.deleteDraft, [id, acc.user]);
    if (!(out?.rowCount > 0)) throw new HttpError(404, 'NOT_FOUND', 'That draft does not exist.');
    res.status(204).end();
  }));
}

export default {
  id: SOURCE,
  handler: (router, context) => mount(router, context),
};
