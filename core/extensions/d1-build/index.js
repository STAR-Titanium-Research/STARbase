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
//   POST   /d1-build/mark-done {collection, ids (1 to 100 of one collection) | id, date?, personId?}
//                                           -> { data: { ids, work_state: 'done' } }  (one transaction, all or nothing; a single `id` request
//                                              also gets `id`; 409 CHECKS as above, 409 ALREADY_DONE)
//   POST   /d1-build/mark-planned {collection, ids | id} -> { data: { ids, work_state: 'planned' } }  (owner or admin only through the access
//                                              guard; clears the date, done_by and done_at; planned output samples go back to planned unless
//                                              something done hangs off them: 409 CHECKS REMOVE_BLOCKED; 409 ALREADY_PLANNED)
//   GET    /d1-build/templates              -> { data: [{ id, name, scope, role_id, collection, values, user_id, updated_at, version }] }
//   GET    /d1-build/templates/:id, POST /d1-build/templates, PATCH /d1-build/templates/:id, DELETE /d1-build/templates/:id
//   Check = { key: DraftKey (or a record id for mark-done); field?: string; level: 'block' | 'warn'; code: CheckCode; text: string }
//   CheckCode (CHECK_CODES) is a stable reason to branch on: GONE, NOT_ATTACHABLE, STALE_VERSION, REMOVE_BLOCKED, PERMISSION (reserved:
//   no check says it yet, a refused write is WRITE_FAILED), REQUIRED, STRUCTURE, OTHER.
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

// The stable reasons a check carries in `code`.
export const CHECK_CODES = ['GONE', 'NOT_ATTACHABLE', 'STALE_VERSION', 'REMOVE_BLOCKED', 'PERMISSION', 'REQUIRED', 'STRUCTURE', 'OTHER'];
// Aliases a draft's values may set besides the real columns (the form needs none today). A value can never reach an alias
// otherwise: an alias is a relation (a nested create, update or delete through ItemsService), and a draft writes no relations.
export const ALIAS_ALLOWED = { physical_samples: [], manufacturing_operations: [], test_sessions: [] };
export const MAX_RECORDS = 500;
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

// What the checks read of a draft's existing records (as the caller): the version, the state, and the fields a new record may
// inherit.
const READ_FIELDS = {
  physical_samples: ['sample_id', 'version', 'sample_code', 'current_status', 'material_id', 'form', 'primary_method_id', 'project_id'],
  manufacturing_operations: ['operation_id', 'version', 'pass_code', 'sample_id', 'output_sample_id', 'method_id', 'work_state', 'batch_id'],
  test_sessions: ['session_id', 'version', 'test_code', 'work_state', 'test_type'],
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
// The real columns a draft's values may name, by collection, from Directus's schema overview (an alias is not one).
export function realColumns(schema) {
  const out = {};
  for (const collection of Object.values(KIND_COLLECTION)) {
    const fields = schema?.collections?.[collection]?.fields ?? {};
    out[collection] = new Set([
      ...Object.entries(fields).filter(([, f]) => f?.alias !== true && f?.type !== 'alias').map(([name]) => name),
      ...ALIAS_ALLOWED[collection],
    ]);
  }
  return out;
}

export function validateDraftBody(input, opts = {}) {
  if (!isObject(input)) return fail('The draft body must be an object.');
  if (input.v !== 1) return fail('The draft body must have v: 1.');
  for (const f of ['projectId', 'campaignId']) {
    const v = input[f];
    if (v !== null && v !== undefined && !(typeof v === 'string' && UUID.test(v))) return fail(`${f} must be an id or null.`);
  }
  if (!Array.isArray(input.items)) return fail('items must be a list.');
  if (!Array.isArray(input.wires)) return fail('wires must be a list.');
  if (!isObject(input.positions)) return fail('positions must be an object.');
  // seq: the client's key counter; accepted, not used here.
  if (input.seq !== undefined && !isInt(input.seq, 0)) return fail('seq must be a whole number.');
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
      if (opts.columns && !opts.columns[KIND_COLLECTION[item.kind]]?.has(field)) {
        return fail(`${at}.values names ${field}, which is not a column of ${KIND_COLLECTION[item.kind]}: a draft sets columns only.`);
      }
    }
    if (item.existing !== undefined) {
      const e = item.existing;
      if (!isObject(e) || typeof e.id !== 'string' || !UUID.test(e.id) || !isInt(e.version, 0)) {
        return fail(`${at}.existing must be { id, version }.`);
      }
    }
    if (item.remove !== undefined && item.remove !== true) return fail(`${at}.remove must be true when present.`);
    // Absent means planned: a new card is planned until it is marked done.
    if (item.workState !== undefined && !WORK_STATES.includes(item.workState)) return fail(`${at}.workState must be planned or done.`);
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
  // The fields the forms mark required (Directus does not enforce the flag on API saves, so the checks do).
  requiredFields:
    'SELECT collection, field, translations FROM directus_fields WHERE required = true'
    + " AND collection IN ('physical_samples', 'manufacturing_operations', 'test_sessions') ORDER BY collection, sort, field",
  // Each takes the ids as one comma-separated text (all uuids, validated before they get here).
  sampleInfo:
    "SELECT sample_id, sample_code, current_status FROM physical_samples WHERE sample_id = ANY(string_to_array(?, ',')::uuid[])",
  refsOperations:
    'SELECT operation_id, work_state, sample_id, output_sample_id FROM manufacturing_operations'
    + " WHERE sample_id = ANY(string_to_array(?, ',')::uuid[]) OR output_sample_id = ANY(string_to_array(?, ',')::uuid[])",
  // Mark done: the samples a test works on (statuses come from sampleInfo).
  testSubjects: "SELECT item AS sample_id FROM test_sessions_subject WHERE test_sessions_id = ? AND collection = 'physical_samples'",
  refsGenealogy:
    "SELECT parent_sample_id, child_sample_id FROM sample_genealogy WHERE parent_sample_id = ANY(string_to_array(?, ',')::uuid[])",
  refsTests:
    "SELECT session_id, work_state, sample_id FROM test_sessions WHERE sample_id = ANY(string_to_array(?, ',')::uuid[])",
  refsSubjects:
    'SELECT s.test_sessions_id AS session_id, t.work_state, s.item AS sample_id FROM test_sessions_subject s'
    + ' JOIN test_sessions t ON t.session_id = s.test_sessions_id'
    + " WHERE s.collection = 'physical_samples' AND s.item = ANY(string_to_array(?, ',')::text[])",
  // Create: lock the samples a removal would delete before looking at what points at them, so nothing new can start to.
  lockSamples:
    "SELECT sample_id FROM physical_samples WHERE sample_id = ANY(string_to_array(?, ',')::uuid[]) ORDER BY sample_id FOR UPDATE",
  // Create: lock one existing record and read its version and state (work state, or sample status) and its input sample.
  lockRecord: {
    physical_samples: 'SELECT version, current_status AS state, NULL AS sample_id FROM physical_samples WHERE sample_id = ? FOR UPDATE',
    manufacturing_operations:
      'SELECT version, work_state AS state, sample_id FROM manufacturing_operations WHERE operation_id = ? FOR UPDATE',
    test_sessions: 'SELECT version, work_state AS state, NULL AS sample_id FROM test_sessions WHERE session_id = ? FOR UPDATE',
  },
  // Templates. A template is visible to its creator, to callers with its role (scope role) and to everyone (scope global).
  // Bindings of listTemplates: the caller, the caller's role (or null).
  listTemplates:
    'SELECT template_id, user_id, scope, role_id, name, collection, values, version, updated_at FROM d1_private.process_templates'
    + " WHERE user_id = ? OR scope = 'global' OR (scope = 'role' AND role_id = ?::uuid) ORDER BY lower(name), template_id",
  getTemplate:
    'SELECT template_id, user_id, scope, role_id, name, collection, values, version, updated_at'
    + ' FROM d1_private.process_templates WHERE template_id = ?',
  insertTemplate:
    'INSERT INTO d1_private.process_templates (user_id, scope, role_id, name, collection, values) VALUES (?, ?, ?, ?, ?, ?::jsonb)'
    + ' RETURNING template_id, user_id, scope, role_id, name, collection, values, version, updated_at',
  // Bindings: name, scope, role, values JSON, id, the version the edit was made against.
  updateTemplate:
    'UPDATE d1_private.process_templates SET name = ?, scope = ?, role_id = ?, values = ?::jsonb,'
    + ' version = version + 1, updated_at = now() WHERE template_id = ? AND version = ?'
    + ' RETURNING template_id, user_id, scope, role_id, name, collection, values, version, updated_at',
  deleteTemplate: 'DELETE FROM d1_private.process_templates WHERE template_id = ?',
  // Mark done: is this person there, and which person is the caller (a researcher's row first, as d1-owner-default does).
  personExists: 'SELECT person_id FROM people WHERE person_id = ?',
  personOfUser: 'SELECT person_id FROM people WHERE user_id = ? ORDER BY is_researcher DESC, person_id LIMIT 1',
  // The code the triggers gave a new record.
  codeOf: {
    physical_samples: 'SELECT sample_code AS code FROM physical_samples WHERE sample_id = ?',
    manufacturing_operations: 'SELECT pass_code AS code FROM manufacturing_operations WHERE operation_id = ?',
    test_sessions: 'SELECT test_code AS code FROM test_sessions WHERE session_id = ?',
  },
};

// ---- planning: what a draft means (pure) -----------------------------------------------------------------------------
//
// buildPlan(body, ctx) reads a DraftBody against what the database knows and answers { checks, plan }:
//   * checks: the Check list (spec E5, E13), blocking or warning;
//   * plan: what Create would write, in order (spec 6.1), with every wire already resolved to a "ref":
//       'item:<key>'  a sample card of the draft (new, or created in this Create; resolved to its id when written)
//       'id:<uuid>'   a sample that exists already
//     Nothing in the plan is written unless no check blocks.
// ctx (all optional, as loaded by the endpoint):
//   existing  Map(lower-case id -> row)  the draft's existing records as the CALLER can read them (a record missing here is
//             gone or unreadable); samples also carry material_id, form ... for inheritance
//   required  { [collection]: [{ field, label }] }  the fields the forms mark required (parseRequired)
//   outputs   Map(sample id -> { code, status })    the output samples of removed operations, and removed samples
//   refs      [{ kind: 'operation'|'test', id, work_state, sampleIds }]  every record that points at a sample that would go

const lower = (s) => String(s).toLowerCase();
const idRef = (id) => (isBlank(id) ? null : `id:${lower(id)}`);
const itemRef = (key) => `item:${key}`;
const keyOrder = (a, b) => String(a).localeCompare(String(b), 'en', { numeric: true });
// A card's work state: planned unless it says done.
const stateOf = (item) => (item.workState === 'done' ? 'done' : 'planned');
const hasValues = (item) => isObject(item.values) && Object.keys(item.values).length > 0;

// The fields the forms mark required, by collection, with their label: [{ collection, field, translations }] rows from
// directus_fields.
export function parseRequired(rows) {
  const out = {};
  for (const r of rows ?? []) {
    let t = r.translations;
    if (typeof t === 'string') {
      try { t = JSON.parse(t); } catch { t = null; }
    }
    const en = Array.isArray(t) ? (t.find((x) => x?.language === 'en-US') ?? t[0]) : null;
    (out[r.collection] ??= []).push({ field: r.field, label: trimmed(en?.translation) ?? r.field });
  }
  return out;
}

// Put operation records in the order they must be written (spec 6.1 step 6). A record waits for the records that make the
// sample it works on (its input is another record's output) and for the records it is wired from; everything else keeps the
// order of the draft (`index`), so the passes of an in-place chain are numbered as they were laid out. records:
// [{ key, index, input, output, after? }]. Returns { order: records, cyclic: keys } (a loop is appended in draft order).
export function orderOperations(records) {
  const sorted = [...records].sort((a, b) => a.index - b.index);
  const byKey = new Map(sorted.map((r) => [r.key, r]));
  const makers = new Map();
  for (const r of sorted) if (r.output) makers.set(r.output, [...(makers.get(r.output) ?? []), r.key]);
  const needs = new Map(sorted.map((r) => [r.key, new Set()]));
  for (const r of sorted) {
    for (const maker of r.input ? (makers.get(r.input) ?? []) : []) if (maker !== r.key) needs.get(r.key).add(maker);
    for (const before of r.after ?? []) if (byKey.has(before) && before !== r.key) needs.get(r.key).add(before);
  }
  const placed = new Set();
  const order = [];
  for (;;) {
    const next = sorted.find((r) => !placed.has(r.key) && [...needs.get(r.key)].every((k) => placed.has(k)));
    if (!next) break;
    placed.add(next.key);
    order.push(next);
  }
  const cyclic = sorted.filter((r) => !placed.has(r.key));
  return { order: [...order, ...cyclic], cyclic: cyclic.map((r) => r.key) };
}

export function buildPlan(body, ctx = {}) {
  const existing = ctx.existing ?? new Map();
  const required = ctx.required ?? {};
  const outputsInfo = ctx.outputs ?? new Map();
  const columns = ctx.columns ?? null;
  const refs = ctx.refs ?? [];
  const items = Array.isArray(body?.items) ? body.items : [];
  const wires = Array.isArray(body?.wires) ? body.wires : [];

  const checks = [];
  const seen = new Set();
  const blockedFields = new Set();
  // code: a stable reason a client can branch on (CHECK_CODES); STRUCTURE is the default (wiring, method, nothing to work on).
  const note = (level) => (key, text, field, code = 'STRUCTURE') => {
    const id = `${level}|${key}|${field ?? ''}|${text}`;
    if (seen.has(id)) return;
    seen.add(id);
    if (level === 'block' && field) blockedFields.add(`${key}|${field}`);
    checks.push({ key, ...(field ? { field } : {}), level, code, text });
  };
  const block = note('block');
  const warn = note('warn');

  // -- the cards ------------------------------------------------------------------------------------------------
  const byKey = new Map();
  const existingOwner = new Map(); // collection:id -> the first card that holds that record
  for (const item of items) {
    if (byKey.has(item.key)) {
      block(item.key, 'Two cards in this draft share a key. Reload the draft.');
      continue;
    }
    byKey.set(item.key, item);
    if (item.existing) {
      const ek = `${KIND_COLLECTION[item.kind]}:${lower(item.existing.id)}`;
      if (existingOwner.has(ek)) block(item.key, 'This record is on the draft twice, on another card too. Keep one.');
      else existingOwner.set(ek, item.key);
    }
    // values may name real columns only (a draft writes no relations); re-checked here for a draft saved before a schema change
    if (columns) {
      for (const field of Object.keys(item.values ?? {})) {
        if (!columns[KIND_COLLECTION[item.kind]]?.has(field)) block(item.key, `${field} is not a field a draft can set.`, field);
      }
    }
  }
  const rowsFor = (item) => (Array.isArray(item.rows) && item.rows.length ? item.rows : [{ key: item.key }]);
  const owners = new Map([...byKey.keys()].map((k) => [k, k]));
  for (const item of items) {
    if (item.kind !== 'operation') continue;
    for (const row of rowsFor(item)) {
      if (row.key === item.key) continue;
      if (owners.has(row.key)) block(item.key, 'Two rows or cards in this draft share a key. Reload the draft.');
      else owners.set(row.key, item.key);
    }
  }
  const existingKey = (collection, id) => `${collection}:${lower(id)}`;
  const stored = (item) => (item.existing ? existing.get(existingKey(KIND_COLLECTION[item.kind], item.existing.id)) : undefined);
  const isNew = (item) => !item.existing;
  const live = (item) => !item.remove;

  // The rows that Create writes or works through: new operations, attached operations (an existing operation given an input)
  // and, for wiring only, the stored wiring of existing operations. rowId = `${itemKey}#${index}`.
  const opRows = new Map();
  for (const item of items) {
    if (item.kind !== 'operation' || !live(item) || byKey.get(item.key) !== item) continue;
    const mode = isNew(item) ? 'new' : item.attach ? 'attach' : 'existing';
    rowsFor(item).forEach((row, i) => {
      opRows.set(`${item.key}#${i}`, { item, index: i, rowKey: row.key, mode, row: stored(item), count: rowsFor(item).length });
    });
  }

  // -- the wires ------------------------------------------------------------------------------------------------
  const inWires = new Map(); // rowId -> [{ kind: 'sample'|'op', key, row? }]
  const outWires = new Map(); // rowId -> [sample key]
  const subjects = new Map(); // test key -> [{ kind: 'sample'|'op', key, row? }]
  const push = (map, k, v) => map.set(k, [...(map.get(k) ?? []), v]);
  const rowSel = (end, label) => {
    const count = rowsFor(end.item).length;
    if (end.row === undefined) {
      if (count > 1) block(end.item.key, `Say which row ${label}: this operation has ${count}.`);
      return 0;
    }
    if (end.row >= count) {
      block(end.item.key, 'A wire names a row this operation does not have.');
      return null;
    }
    return end.row;
  };
  for (const w of wires) {
    const from = byKey.has(w.from.key) ? { item: byKey.get(w.from.key), row: w.from.row } : null;
    const to = byKey.has(w.to.key) ? { item: byKey.get(w.to.key), row: w.to.row } : null;
    if (!from || !to) {
      block((from ?? to)?.item.key ?? w.from.key, 'A wire points at a card that is no longer in the draft.');
      continue;
    }
    if (from.item.remove || to.item.remove) {
      block(from.item.remove ? to.item.key : from.item.key, 'This card is wired to something that is being removed.', undefined, 'REMOVE_BLOCKED');
      continue;
    }
    const fk = from.item.kind;
    const tk = to.item.kind;
    if (tk === 'operation' && (fk === 'sample' || fk === 'operation')) {
      if (!isNew(to.item) && !to.item.attach) continue; // an existing operation keeps the wiring it has
      const src = fk === 'sample' ? { kind: 'sample', key: from.item.key } : { kind: 'op', key: from.item.key, row: rowSel(from, 'it comes from') };
      if (src.row === null) continue;
      const rows = to.row === undefined ? rowsFor(to.item).map((_, i) => i) : [rowSel(to, 'it goes into')];
      for (const i of rows) if (i !== null) push(inWires, `${to.item.key}#${i}`, src);
    } else if (fk === 'operation' && tk === 'sample') {
      if (!isNew(from.item) && !from.item.attach) {
        block(from.item.key, 'An existing operation keeps the sample it made: a new wire out of it cannot be created.');
        continue;
      }
      const i = rowSel(from, 'the sample comes from');
      if (i !== null) push(outWires, `${from.item.key}#${i}`, to.item.key);
    } else if (tk === 'test' && (fk === 'sample' || fk === 'operation')) {
      if (!isNew(to.item)) {
        block(to.item.key, 'An existing test keeps the samples it has: a sample cannot be wired into it here.');
        continue;
      }
      const src = fk === 'sample' ? { kind: 'sample', key: from.item.key } : { kind: 'op', key: from.item.key, row: rowSel(from, 'it comes from') };
      if (src.row !== null) push(subjects, to.item.key, src);
    } else {
      block(from.item.key, 'These two cards cannot be wired together.');
    }
  }

  // -- who works on which sample ----------------------------------------------------------------------------------
  const distinct = (list) => {
    const out = [];
    for (const s of list ?? []) if (!out.some((o) => o.kind === s.kind && o.key === s.key && o.row === s.row)) out.push(s);
    return out;
  };
  const refOfSampleItem = (item) => (item.existing ? idRef(item.existing.id) : itemRef(item.key));
  const memo = new Map();
  const BUSY = Symbol('busy');
  let looped = false;
  const memoised = (id, fn, key) => {
    if (memo.has(id)) {
      const v = memo.get(id);
      if (v === BUSY) {
        if (!looped) block(key, 'These operations are wired in a loop.');
        looped = true;
        return null;
      }
      return v;
    }
    memo.set(id, BUSY);
    const v = fn();
    memo.set(id, v);
    return v;
  };
  const inputOf = (rowId) => {
    const info = opRows.get(rowId);
    if (!info) return null;
    return memoised(`in:${rowId}`, () => {
      if (info.mode === 'existing') return idRef(info.row?.sample_id);
      const srcs = distinct(inWires.get(rowId));
      if (srcs.length > 1) block(info.item.key, 'More than one wire goes into this operation.');
      const s = srcs[0];
      if (!s) return null;
      return s.kind === 'sample' ? refOfSampleItem(byKey.get(s.key)) : continuesAs(`${s.key}#${s.row}`);
    }, info.item.key);
  };
  const outputOf = (rowId) => {
    const info = opRows.get(rowId);
    if (!info) return null;
    return memoised(`out:${rowId}`, () => {
      if (info.mode !== 'new') return idRef(info.row?.output_sample_id);
      const outs = [...new Set(outWires.get(rowId) ?? [])];
      if (outs.length > 1) block(info.item.key, 'More than one sample is wired out of this row.');
      if (!outs.length) return null;
      const target = refOfSampleItem(byKey.get(outs[0]));
      return target === inputOf(rowId) ? null : target; // the same sample out: in place
    }, info.item.key);
  };
  function continuesAs(rowId) {
    return outputOf(rowId) ?? inputOf(rowId);
  }

  // -- operations (new and attached) -------------------------------------------------------------------------------
  const records = [];
  let order = 0;
  for (const item of items) {
    if (item.kind !== 'operation' || !live(item) || byKey.get(item.key) !== item || (!isNew(item) && !item.attach)) continue;
    const mode = isNew(item) ? 'new' : 'attach';
    const rowCount = rowsFor(item).length;
    rowsFor(item).forEach((row, i) => {
      const rowId = `${item.key}#${i}`;
      const input = inputOf(rowId);
      const output = outputOf(rowId);
      // Each row is its own record, and the database refuses one with neither a sample nor an output.
      if (mode === 'new' && !input && !output) {
        block(item.key, rowCount > 1 ? `Row ${i + 1} needs a sample wired into it, or an output.` : 'Wire a sample into this operation, or give it an output.');
      }
      const after = distinct(inWires.get(rowId)).filter((s) => s.kind === 'op').map((s) => opRows.get(`${s.key}#${s.row}`)?.rowKey).filter(Boolean);
      records.push({
        key: row.key, itemKey: item.key, rowIndex: i, mode, input, output, workState: stateOf(item), values: item.values,
        existingId: item.existing ? lower(item.existing.id) : null, version: item.existing?.version ?? null,
        batchKey: mode === 'new' && rowsFor(item).length > 1 ? item.key : null, after, index: order,
      });
      order += 1;
    });
    if (mode === 'new' && isBlank(item.values.method_id)) block(item.key, 'Choose a method.', 'method_id');
    if (mode === 'attach' && rowCount > 1) block(item.key, 'An attached operation is one existing record: it cannot have several rows.');
    if (mode === 'attach' && !records.some((r) => r.itemKey === item.key && r.input)) {
      block(item.key, 'Wire a sample into this operation to attach it.');
    }
  }
  const ordered = orderOperations(records);
  for (const key of ordered.cyclic) block(records.find((r) => r.key === key).itemKey, 'These operations are wired in a loop.');

  // Who makes each sample: one operation row at most.
  const makers = new Map();
  for (const r of records) if (r.output) makers.set(r.output, [...(makers.get(r.output) ?? []), r]);
  for (const [ref, rs] of makers) {
    if (rs.length > 1 && ref.startsWith('item:')) block(ref.slice(5), 'More than one operation makes this sample.');
  }

  // Done work needs a sample that exists: an operation marked done on a sample that is still planned has nothing to work on.
  const SAMPLE_PLANNED = 'Its sample is still planned; mark the operation that makes it done first.';
  const plannedSample = (ref) => !!ref && (ref.startsWith('item:')
    ? makers.get(ref)?.[0]?.workState === 'planned'
    : existing.get(existingKey('physical_samples', ref.slice(3)))?.current_status === 'planned');
  for (const r of records) if (r.mode === 'new' && r.workState === 'done' && plannedSample(r.input)) block(r.itemKey, SAMPLE_PLANNED);

  // -- samples (new) ------------------------------------------------------------------------------------------------------
  const sampleValues = (ref, trail = new Set()) => {
    if (!ref) return {};
    if (ref.startsWith('id:')) return existing.get(existingKey('physical_samples', ref.slice(3))) ?? {};
    const item = byKey.get(ref.slice(5));
    if (!item) return {};
    if (item.existing) return { ...(stored(item) ?? {}), ...item.values };
    return effectiveSample(item, trail);
  };
  const effectCache = new Map();
  const effectiveSample = (item, trail = new Set()) => {
    if (effectCache.has(item.key)) return effectCache.get(item.key);
    if (trail.has(item.key)) return { ...item.values };
    trail.add(item.key);
    const made = makers.get(itemRef(item.key))?.[0];
    const inherited = {};
    if (made) {
      const from = sampleValues(made.input, trail);
      inherited.material_id = from.material_id;
      inherited.form = from.form;
      const opItem = byKey.get(made.itemKey);
      inherited.primary_method_id = made.mode === 'new' ? opItem.values.method_id : opRows.get(`${made.itemKey}#0`)?.row?.method_id;
    }
    inherited.project_id = body?.projectId ?? undefined;
    const out = { ...Object.fromEntries(Object.entries(inherited).filter(([, v]) => !isBlank(v))) };
    for (const [k, v] of Object.entries(item.values)) if (!isBlank(v)) out[k] = v;
    trail.delete(item.key);
    effectCache.set(item.key, out);
    return out;
  };

  const samples = [];
  for (const item of [...items].sort((a, b) => keyOrder(a.key, b.key))) {
    if (item.kind !== 'sample' || !isNew(item) || !live(item) || byKey.get(item.key) !== item) continue;
    const made = makers.get(itemRef(item.key))?.[0];
    const planned = made?.workState === 'planned';
    const values = effectiveSample(item);
    if (isBlank(values.sample_code)) block(item.key, 'Give the sample a code.', 'sample_code', 'REQUIRED');
    if (!planned) {
      for (const { field, label } of required.physical_samples ?? []) {
        if (RESERVED_FIELDS.sample.includes(field) || blockedFields.has(`${item.key}|${field}`)) continue;
        if (isBlank(values[field])) block(item.key, `${label} is required.`, field, 'REQUIRED');
      }
    }
    samples.push({ key: item.key, values, planned });
  }

  // -- tests (new) --------------------------------------------------------------------------------------------------------
  const tests = [];
  for (const item of items) {
    if (item.kind !== 'test' || !isNew(item) || !live(item) || byKey.get(item.key) !== item) continue;
    const subjectRefs = [];
    for (const s of distinct(subjects.get(item.key))) {
      const ref = s.kind === 'sample' ? refOfSampleItem(byKey.get(s.key)) : continuesAs(`${s.key}#${s.row}`);
      if (ref && !subjectRefs.includes(ref)) subjectRefs.push(ref);
    }
    if (stateOf(item) === 'done' && subjectRefs.some(plannedSample)) block(item.key, SAMPLE_PLANNED);
    if (isBlank(item.values.test_type)) block(item.key, 'Choose a test type.', 'test_type');
    if (!subjectRefs.length) block(item.key, 'Wire a sample into this test.', 'subject');
    tests.push({ key: item.key, values: item.values, workState: stateOf(item), subjects: subjectRefs });
  }

  // -- required for done, and the warnings ----------------------------------------------------------------------------------
  const needDone = (kind, collection, item) => {
    if (stateOf(item) !== 'done') return;
    for (const { field, label } of required[collection] ?? []) {
      if (RESERVED_FIELDS[kind].includes(field) || blockedFields.has(`${item.key}|${field}`)) continue;
      if (isBlank(item.values[field])) block(item.key, `${label} is required.`, field, 'REQUIRED');
    }
  };
  for (const item of items) {
    if (!isNew(item) || !live(item) || byKey.get(item.key) !== item || item.kind === 'sample') continue;
    const collection = KIND_COLLECTION[item.kind];
    needDone(item.kind, collection, item);
    if (isBlank(item.values.equipment_id)) warn(item.key, 'No machine chosen.', 'equipment_id', 'OTHER');
    if (stateOf(item) === 'planned' && isBlank(item.values.planned_date)) warn(item.key, 'No planned date.', 'planned_date', 'OTHER');
  }

  // -- records that exist already -------------------------------------------------------------------------------------------
  const edits = [];
  const removals = { tests: [], operations: [], samples: [] };
  const deleting = { operations: new Set(), tests: new Set(), samples: new Map() }; // sample id -> the card that causes it
  for (const item of items) {
    if (!item.existing || byKey.get(item.key) !== item) continue;
    const row = stored(item);
    if (!row) {
      if (item.remove) warn(item.key, 'This record is already gone; there is nothing to remove.', undefined, 'GONE');
      else block(item.key, 'This record no longer exists, or you can no longer see it.', undefined, 'GONE');
      continue;
    }
    const editing = !item.remove && (item.attach === true || hasValues(item));
    if (Number(row.version) !== item.existing.version) {
      if (editing) block(item.key, 'Changed since you added it. Your edits were made against an older version, so review it first.', undefined, 'STALE_VERSION');
      else warn(item.key, 'Changed since you added it — review.', undefined, 'STALE_VERSION');
    }
    if (item.attach && !isBlank(row.sample_id)) block(item.key, 'It got an input in the meantime, so it cannot be attached any more.', undefined, 'NOT_ATTACHABLE');
    if (item.remove) {
      const state = item.kind === 'sample' ? row.current_status : row.work_state;
      if (state !== 'planned') {
        block(item.key, 'Done records are never deleted from the map.', undefined, 'REMOVE_BLOCKED');
        continue;
      }
      const id = lower(item.existing.id);
      if (item.kind === 'test') {
        removals.tests.push({ key: item.key, id });
        deleting.tests.add(id);
      } else if (item.kind === 'operation') {
        removals.operations.push({ key: item.key, id });
        deleting.operations.add(id);
        const out = row.output_sample_id ? lower(row.output_sample_id) : null;
        if (out && outputsInfo.get(out)?.status === 'planned' && !deleting.samples.has(out)) deleting.samples.set(out, item.key);
      } else {
        deleting.samples.set(id, item.key);
      }
    } else if (hasValues(item) && !item.attach) {
      edits.push({ key: item.key, collection: KIND_COLLECTION[item.kind], id: lower(item.existing.id), version: item.existing.version, values: item.values });
    }
  }
  // Samples that go (explicitly, or as the planned outputs of a removed operation): nothing may hang off them. What hangs off:
  // operations and tests that point at the sample, and samples made from it (a genealogy row with it as the parent). Other
  // rows that point at a sample cascade silently when it is deleted, and that is fine for a planned sample, which has none of
  // their data yet: stock provenance, data files, campaign_samples, the access tables (sample_access, co-owners, team access),
  // the readers table and its own genealogy rows as the child.
  // A code only goes into a check's text when the caller can read the sample (outputsInfo holds it only then, or the sample is
  // a card the caller read); otherwise it says "a sample", so a check never tells a caller a code they cannot see.
  for (const [sid, cause] of deleting.samples) {
    const code = outputsInfo.get(sid)?.code ?? existing.get(existingKey('physical_samples', sid))?.sample_code ?? 'a sample';
    const mine = refs.filter((r) => r.sampleIds.map(lower).includes(sid));
    const hanging = mine.filter((r) => r.kind !== 'genealogy' && !(r.kind === 'operation' ? deleting.operations : deleting.tests).has(lower(r.id)));
    const children = mine.filter((r) => r.kind === 'genealogy' && !deleting.samples.has(lower(r.id)));
    if (hanging.some((r) => r.work_state === 'done')) block(cause, `Something done hangs off ${code}, so it cannot be removed.`, undefined, 'REMOVE_BLOCKED');
    else if (hanging.length) block(cause, `Something planned still hangs off ${code}. Remove that too.`, undefined, 'REMOVE_BLOCKED');
    if (children.length) block(cause, `A sample made from ${code} still exists, so it cannot be removed.`, undefined, 'REMOVE_BLOCKED');
    for (const r of records) if (r.input === `id:${sid}` || r.output === `id:${sid}`) block(r.itemKey, `This is wired to ${code}, which is being removed.`, undefined, 'REMOVE_BLOCKED');
    for (const t of tests) if (t.subjects.includes(`id:${sid}`)) block(t.key, `This is wired to ${code}, which is being removed.`, undefined, 'REMOVE_BLOCKED');
  }
  for (const item of items) {
    if (item.kind === 'sample' && item.remove && item.existing && deleting.samples.get(lower(item.existing.id)) === item.key) {
      removals.samples.push({ key: item.key, id: lower(item.existing.id) });
    }
  }
  for (const [sid, cause] of deleting.samples) {
    if (!removals.samples.some((s) => s.id === sid)) removals.samples.push({ key: cause, id: sid });
  }

  const batches = [];
  for (const r of records) if (r.batchKey && !batches.some((b) => b.key === r.batchKey)) batches.push({ key: r.batchKey, workState: r.workState, values: r.values });

  // One Create is one transaction: keep it to a size a request and a lock can carry.
  const total = samples.length * (body?.campaignId ? 2 : 1) + ordered.order.length + tests.length + batches.length + edits.length
    + removals.tests.length + removals.operations.length + removals.samples.length;
  if (total > MAX_RECORDS) {
    block(items[0].key, `This draft would write ${total} records and a Create is limited to ${MAX_RECORDS}. Split it into several drafts.`);
  }

  return {
    checks,
    plan: { removals, edits, samples, batches, operations: ordered.order, tests },
  };
}

export const computeChecks = (body, ctx) => buildPlan(body, ctx).checks;

// ---- templates (pure) ---------------------------------------------------------------------------------------------------

export const TEMPLATE_SCOPES = ['private', 'role', 'global'];
export const TEMPLATE_COLLECTIONS = ['manufacturing_operations', 'test_sessions'];
const TEMPLATE_KIND = { manufacturing_operations: 'operation', test_sessions: 'test' };
const TEMPLATE_VALUES_CHARS = 100_000;

// A template's prefilled fields: an object of field names (none of the wiring-owned ones) that includes what makes it an
// operation (method_id) or a test (test_type). Returns { ok: true, values } or { ok: false, message }.
export function validateTemplateValues(collection, values, columns) {
  const kind = TEMPLATE_KIND[collection];
  if (!kind) return fail('A template makes operations or tests.');
  if (!isObject(values)) return fail('values must be an object.');
  for (const field of Object.keys(values)) {
    if (!FIELD.test(field)) return fail(`values has a field name that is not allowed: ${field.slice(0, 40)}.`);
    if (RESERVED_FIELDS[kind].includes(field)) return fail(`values must not set ${field}: the wiring and the server decide it.`);
    if (columns && !columns[collection]?.has(field)) return fail(`values names ${field}, which is not a column of ${collection}: a template sets columns only.`);
  }
  if (JSON.stringify(values).length > TEMPLATE_VALUES_CHARS) return fail('The template is too large.');
  if (kind === 'operation' && !(typeof values.method_id === 'string' && UUID.test(values.method_id))) {
    return fail('An operation template needs a method.');
  }
  if (kind === 'test' && isBlank(values.test_type)) return fail('A test template needs a test type.');
  return { ok: true, values };
}

// Who may see a template: its creator, callers with its role (scope role), everyone (scope global).
export function templateVisibleTo(t, acc) {
  return String(t.user_id) === String(acc.user)
    || t.scope === 'global'
    || (t.scope === 'role' && !!acc.role && String(t.role_id) === String(acc.role));
}

// ---- writing: values and failures (pure) ---------------------------------------------------------------------------------

// What a card's values become as the payload of a new record: blank values are left out (an empty string would not cast to a
// uuid or a number), everything else goes as it is; `drop` names fields that must not be sent (the date of the other work state).
export function cleanValues(values, drop = []) {
  const out = {};
  for (const [field, v] of Object.entries(values ?? {})) {
    if (!isBlank(v) && !drop.includes(field)) out[field] = v;
  }
  return out;
}

// An existing record's edit: a blank value clears the field.
export function editValues(values) {
  return Object.fromEntries(Object.entries(values ?? {}).map(([f, v]) => [f, isBlank(v) ? null : v]));
}

// The day of a batch: the first 10 characters of an ISO date or datetime, when they are one.
export function dayOf(v) {
  const t = typeof v === 'string' ? v.slice(0, 10) : '';
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null;
}

// A failed write, in the contract's words: { status, message } for an error thrown by ItemsService (a Directus error, or a
// database error that came through) or by a hook. The access guard's own refusal says why in plain words, so it is passed on;
// anything else gets a generic line (a database message can name tables), and an unknown failure is a 500.
export function describeFailure(err) {
  const code = String(err?.code ?? '');
  const reason = err?.extensions?.reason;
  if (err?.extensions?.source === 'd1-access-guard' && typeof reason === 'string') return { status: 403, message: reason };
  if (err?.status === 403 || code === 'FORBIDDEN') return { status: 403, message: 'You are not allowed to write that record.' };
  if (code === 'RECORD_NOT_UNIQUE' || code === '23505') return { status: 409, message: 'That code or value is already used by another record.' };
  if (code === 'INVALID_FOREIGN_KEY' || code === '23503') return { status: 409, message: 'It points at a record that does not exist, or is still in use.' };
  if (code === 'NOT_NULL_VIOLATION' || code === '23502') return { status: 400, message: 'A required value is missing.' };
  if (code === '23514') return { status: 400, message: 'A value is not allowed here.' };
  if (/^22/.test(code) || code === 'VALUE_OUT_OF_RANGE' || code === 'VALUE_TOO_LONG') return { status: 400, message: 'A value has the wrong format or is too large.' };
  if (Number.isInteger(err?.status) && err.status >= 400 && err.status < 500 && typeof err.message === 'string' && err.message) {
    return { status: err.status, message: err.message };
  }
  return { status: 500, message: 'That record could not be written.' };
}

// ---- the endpoint ----------------------------------------------------------------------------------------------------

const draftOut = (r) => ({
  id: r.draft_id,
  name: r.name,
  body: typeof r.body === 'string' ? JSON.parse(r.body) : r.body,
  version: Number(r.version),
  updated_at: toIso(r.updated_at),
});

export function mount(router, context, clock = () => new Date()) {
  const { database, logger, services, getSchema, env } = context;

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

  // -- what the database knows about a draft (reads as the caller) ---------------------------------------------------

  const isDenied = (e) => e?.status === 403 || e?.code === 'FORBIDDEN';
  const schemaOf = async (req) => req.schema ?? (await getSchema());
  const itemsFor = (schema, acc, collection, knex) =>
    new services.ItemsService(collection, { schema, accountability: acc, ...(knex ? { knex } : {}) });

  // The draft's existing records, read through ItemsService as the caller (the real read rules decide: a record the caller
  // cannot read is "gone"), then the samples those records work on (for inheritance), the fields the forms mark required, and,
  // for what a draft removes, the planned outputs and everything that points at them. `db` / `knex` are the transaction when
  // Create calls this.
  async function loadContext(req, body, { db = database, knex, lock = false } = {}) {
    const schema = await schemaOf(req);
    const acc = req.accountability;
    const read = async (collection, ids) => {
      if (!ids.length) return [];
      try {
        return await itemsFor(schema, acc, collection, knex).readByQuery({
          fields: READ_FIELDS[collection],
          filter: { [COLLECTION_PK[collection]]: { _in: ids } },
          limit: ids.length,
        });
      } catch (err) {
        if (isDenied(err)) return [];
        throw err;
      }
    };
    const existing = new Map();
    const take = (collection, rows) => {
      for (const r of rows ?? []) existing.set(`${collection}:${lower(r[COLLECTION_PK[collection]])}`, { ...r, _collection: collection });
    };
    const ids = { physical_samples: new Set(), manufacturing_operations: new Set(), test_sessions: new Set() };
    for (const item of body.items) if (item.existing) ids[KIND_COLLECTION[item.kind]].add(lower(item.existing.id));
    for (const collection of Object.keys(ids)) take(collection, await read(collection, [...ids[collection]]));
    const more = new Set();
    for (const r of existing.values()) {
      if (r._collection !== 'manufacturing_operations') continue;
      for (const f of ['sample_id', 'output_sample_id']) {
        if (r[f] && !existing.has(`physical_samples:${lower(r[f])}`)) more.add(lower(r[f]));
      }
    }
    take('physical_samples', await read('physical_samples', [...more]));

    const required = parseRequired(rowsOf(await db.raw(SQL.requiredFields)));

    // Samples a removal would delete: the removed samples, and the output of each removed operation.
    const candidates = new Set();
    for (const item of body.items) {
      if (!item.remove || !item.existing) continue;
      if (item.kind === 'sample') candidates.add(lower(item.existing.id));
      const out = item.kind === 'operation' ? existing.get(`manufacturing_operations:${lower(item.existing.id)}`)?.output_sample_id : null;
      if (out) candidates.add(lower(out));
    }
    const outputs = new Map();
    const refs = [];
    if (candidates.size) {
      const csv = [...candidates].join(',');
      if (lock) await db.raw(SQL.lockSamples, [csv]);
      // The status comes from the database (the check needs it whoever asks); the code only when the caller can read the sample.
      const readable = new Map((await read('physical_samples', [...candidates].filter((c) => !existing.has(`physical_samples:${c}`))))
        .map((r) => [lower(r.sample_id), r.sample_code]));
      for (const r of rowsOf(await db.raw(SQL.sampleInfo, [csv]))) {
        const sid = lower(r.sample_id);
        outputs.set(sid, { code: existing.get(`physical_samples:${sid}`)?.sample_code ?? readable.get(sid) ?? null, status: r.current_status });
      }
      for (const r of rowsOf(await db.raw(SQL.refsGenealogy, [csv]))) {
        refs.push({ kind: 'genealogy', id: r.child_sample_id, work_state: null, sampleIds: [lower(r.parent_sample_id)] });
      }
      for (const r of rowsOf(await db.raw(SQL.refsOperations, [csv, csv]))) {
        refs.push({
          kind: 'operation', id: r.operation_id, work_state: r.work_state,
          sampleIds: [r.sample_id, r.output_sample_id].filter(Boolean).map(lower),
        });
      }
      const tests = new Map();
      for (const r of [...rowsOf(await db.raw(SQL.refsTests, [csv])), ...rowsOf(await db.raw(SQL.refsSubjects, [csv]))]) {
        const t = tests.get(r.session_id) ?? { kind: 'test', id: r.session_id, work_state: r.work_state, sampleIds: [] };
        if (r.sample_id) t.sampleIds.push(lower(r.sample_id));
        tests.set(r.session_id, t);
      }
      refs.push(...tests.values());
    }
    return { existing, required, outputs, refs, columns: realColumns(schema) };
  }

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
    const body = validateDraftBody(b.body, { columns: realColumns(await schemaOf(req)) });
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
      const v = validateDraftBody(b.body, { columns: realColumns(await schemaOf(req)) });
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

  // -- checks (spec E5, E13) -----------------------------------------------------------------------------------------

  router.post('/drafts/:id/check', route(async ({ req, res, acc }) => {
    const id = idParam(req, 'draft');
    const [row] = rowsOf(await database.raw(SQL.getDraft, [id, acc.user]));
    if (!row) throw new HttpError(404, 'NOT_FOUND', 'That draft does not exist.');
    const body = draftOut(row).body;
    const ctx = await loadContext(req, body);
    res.json({ data: { checks: buildPlan(body, ctx).checks } });
  }));

  // -- writing ------------------------------------------------------------------------------------------------------------

  // Knex writes bypass the Directus services that clear the data cache, and ItemsService only does so when it owns the
  // transaction, so clear it after the commit (as d1-record-access does).
  async function clearDataCache(req) {
    if (!toBool(env?.CACHE_ENABLED)) return;
    try {
      const schema = await schemaOf(req);
      await new services.UtilsService({ schema, accountability: { user: null, role: null, admin: true, app: false } }).clearCache({ system: false });
    } catch (err) {
      logger?.warn?.(`${SOURCE}: could not clear the data cache: ${err?.message || err}`);
    }
  }
  // One write transaction: the actor first, so the audit trigger names the caller.
  const inTransaction = (acc, work) =>
    database.transaction(async (trx) => {
      await trx.raw(SQL.setActor, [String(acc.user)]);
      return work(trx);
    });
  // A write of the draft's card `key` that failed: roll everything back (the throw does) and name the card.
  const writeFailed = (key, err) => {
    if (err instanceof HttpError) return err;
    const { status, message } = describeFailure(err);
    if (status === 500) logger?.error?.(`${SOURCE}: writing ${key} failed: ${err?.stack || err?.message || err}`);
    return new HttpError(status, 'WRITE_FAILED', message, { key });
  };
  const staleChecks = (key, text, code) =>
    new HttpError(409, 'CHECKS', 'Something changed, so nothing was created. Review the checks.', { checks: [{ key, level: 'block', code, text }] });

  // -- templates (spec E11) ------------------------------------------------------------------------------------------------

  const templateOut = (r) => ({
    id: r.template_id,
    name: r.name,
    scope: r.scope,
    role_id: r.role_id ?? null,
    collection: r.collection,
    values: typeof r.values === 'string' ? JSON.parse(r.values) : r.values,
    user_id: r.user_id,
    updated_at: toIso(r.updated_at),
    version: Number(r.version),
  });
  // The role a template of this scope is shared with: the caller's own, except that an administrator may name any role.
  const roleFor = (scope, requested, acc) => {
    if (scope !== 'role') return null;
    if (requested !== undefined && requested !== null && !(typeof requested === 'string' && UUID.test(requested))) {
      throw new HttpError(400, 'INVALID_PAYLOAD', 'role_id must be a role id.');
    }
    const role = requested ? requested.toLowerCase() : (acc.role ? String(acc.role).toLowerCase() : null);
    if (!role) throw new HttpError(400, 'INVALID_PAYLOAD', 'You have no account role to share this with.');
    if (requested && acc.admin !== true && role !== String(acc.role ?? '').toLowerCase()) {
      throw new HttpError(400, 'INVALID_PAYLOAD', 'A template can only be shared with your own account role.');
    }
    return role;
  };
  const scopeOf = (v) => {
    if (typeof v !== 'string' || !TEMPLATE_SCOPES.includes(v)) {
      throw new HttpError(400, 'INVALID_PAYLOAD', 'scope must be private, role or global.');
    }
    return v;
  };
  const templateRow = async (id) => rowsOf(await database.raw(SQL.getTemplate, [id]))[0];
  const visibleTemplate = async (acc, id) => {
    const row = await templateRow(id);
    // An administrator can reach any template by its id (to tidy shared ones); everyone else only those they can see.
    if (!row || !(acc.admin === true || templateVisibleTo(row, acc))) throw new HttpError(404, 'NOT_FOUND', 'That template does not exist.');
    return row;
  };
  const editable = (acc, row) => {
    if (String(row.user_id) !== String(acc.user) && acc.admin !== true) {
      throw new HttpError(403, 'FORBIDDEN', 'Only the person who made a template, or an administrator, can change it.');
    }
  };

  router.get('/templates', route(async ({ res, acc }) => {
    const rows = rowsOf(await database.raw(SQL.listTemplates, [acc.user, acc.role ?? null]));
    res.json({ data: rows.map(templateOut) });
  }));

  router.get('/templates/:id', route(async ({ req, res, acc }) => {
    res.json({ data: templateOut(await visibleTemplate(acc, idParam(req, 'template'))) });
  }));

  router.post('/templates', route(async ({ req, res, acc }) => {
    const b = req.body;
    if (!isObject(b)) throw new HttpError(400, 'INVALID_PAYLOAD', 'Send a JSON body with { name, collection, values, scope? }.');
    const name = validateName(b.name);
    if (!name.ok) throw new HttpError(400, 'INVALID_PAYLOAD', name.message);
    if (typeof b.collection !== 'string' || !TEMPLATE_COLLECTIONS.includes(b.collection)) {
      throw new HttpError(400, 'INVALID_PAYLOAD', 'collection must be manufacturing_operations or test_sessions.');
    }
    const scope = b.scope === undefined || b.scope === null ? 'private' : scopeOf(b.scope);
    const role = roleFor(scope, b.role_id, acc);
    const values = validateTemplateValues(b.collection, b.values, realColumns(await schemaOf(req)));
    if (!values.ok) throw new HttpError(400, 'INVALID_PAYLOAD', values.message);
    const [row] = rowsOf(await database.raw(SQL.insertTemplate, [acc.user, scope, role, name.name, b.collection, JSON.stringify(values.values)]));
    res.status(201).json({ data: templateOut(row) });
  }));

  router.patch('/templates/:id', route(async ({ req, res, acc }) => {
    const id = idParam(req, 'template');
    const b = req.body;
    if (!isObject(b)) throw new HttpError(400, 'INVALID_PAYLOAD', 'Send a JSON body with { name?, scope?, values?, version }.');
    if (!isInt(b.version, 1)) throw new HttpError(400, 'INVALID_PAYLOAD', 'version must be the version this edit was made against.');
    if (['name', 'scope', 'role_id', 'values'].every((f) => b[f] === undefined)) throw new HttpError(400, 'INVALID_PAYLOAD', 'Send something to change.');
    if (b.collection !== undefined) throw new HttpError(400, 'INVALID_PAYLOAD', 'A template always makes the same kind of record.');
    const row = await visibleTemplate(acc, id);
    editable(acc, row);
    let name = row.name;
    if (b.name !== undefined) {
      const n = validateName(b.name);
      if (!n.ok) throw new HttpError(400, 'INVALID_PAYLOAD', n.message);
      name = n.name;
    }
    const scope = b.scope === undefined ? row.scope : scopeOf(b.scope);
    // Keeping the role scope keeps the role unless a new one is named.
    const role = scope === 'role' && b.role_id === undefined && row.scope === 'role' ? row.role_id : roleFor(scope, b.role_id, acc);
    let values = typeof row.values === 'string' ? JSON.parse(row.values) : row.values;
    if (b.values !== undefined) {
      const v = validateTemplateValues(row.collection, b.values, realColumns(await schemaOf(req)));
      if (!v.ok) throw new HttpError(400, 'INVALID_PAYLOAD', v.message);
      values = v.values;
    }
    const [saved] = rowsOf(await database.raw(SQL.updateTemplate, [name, scope, role, JSON.stringify(values), id, b.version]));
    if (saved) return res.json({ data: templateOut(saved) });
    if (!(await templateRow(id))) throw new HttpError(404, 'NOT_FOUND', 'That template does not exist.');
    throw new HttpError(409, 'CONFLICT', 'This template changed since you opened it. Reload it to see the latest version.');
  }));

  router.delete('/templates/:id', route(async ({ req, res, acc }) => {
    const id = idParam(req, 'template');
    editable(acc, await visibleTemplate(acc, id));
    await database.raw(SQL.deleteTemplate, [id]);
    res.status(204).end();
  }));

  // -- mark done and mark planned (spec 6.2, ADR-0019) ---------------------------------------------------------------------

  const DONE = {
    manufacturing_operations: { dateField: 'operation_date', kind: 'operation' },
    test_sessions: { dateField: 'session_date', kind: 'test' },
  };
  const isRealDate = (v) => {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v);
  };
  const MAX_IDS = 100;
  // { collection, ids } from the body: `ids` (1 to 100 ids of one collection) or the older single `id`; duplicates count once.
  const containerIds = (b) => {
    if (!isObject(b)) throw new HttpError(400, 'INVALID_PAYLOAD', 'Send a JSON body with { collection, ids, ... }.');
    if (typeof b.collection !== 'string' || !Object.hasOwn(DONE, b.collection)) {
      throw new HttpError(400, 'INVALID_PAYLOAD', 'collection must be manufacturing_operations or test_sessions.');
    }
    const list = b.ids !== undefined && b.ids !== null ? b.ids : (b.id !== undefined && b.id !== null ? [b.id] : null);
    if (!Array.isArray(list) || list.length < 1 || list.length > MAX_IDS || !list.every((i) => typeof i === 'string' && UUID.test(i))) {
      throw new HttpError(400, 'INVALID_PAYLOAD', `ids must be 1 to ${MAX_IDS} ids of ${b.collection}.`);
    }
    return { collection: b.collection, ids: [...new Set(list.map((i) => i.toLowerCase()))], single: b.ids === undefined || b.ids === null };
  };
  const answer = (ids, state, single) => ({ ids, work_state: state, ...(single ? { id: ids[0] } : {}) });
  // A write ItemsService refused, as a 403 (with the access guard's reason) or a 400.
  const refused = (err) => {
    if (err instanceof HttpError) return err;
    const { status, message } = describeFailure(err);
    if (status === 500) return err;
    return new HttpError(status, status === 403 ? 'FORBIDDEN' : 'INVALID_PAYLOAD', message);
  };
  const notThere = () => new HttpError(404, 'NOT_FOUND', 'That record does not exist, or you cannot see it.');

  // The records as the caller reads them, locked, with their state. A record the caller cannot read is not there.
  async function readContainers(svc, trx, collection, ids) {
    const recs = [];
    for (const id of ids) {
      let rec;
      try {
        rec = await svc(collection).readOne(id, { fields: ['*'] });
      } catch (err) {
        if (isDenied(err)) throw notThere();
        throw err;
      }
      if (!rec) throw notThere();
      const [locked] = rowsOf(await trx.raw(SQL.lockRecord[collection], [id]));
      if (!locked) throw notThere();
      recs.push({ id, rec, state: locked.state });
    }
    return recs;
  }
  // The sample a record leaves behind as its output, when it is one: the order of a call follows output to input.
  const refOf = (v) => (v ? `id:${lower(v)}` : null);
  const inOrder = (recs) => orderOperations(recs.map((r, index) => ({
    key: r.id, index, input: refOf(r.rec.sample_id), output: refOf(r.rec.output_sample_id) === refOf(r.rec.sample_id) ? null : refOf(r.rec.output_sample_id),
  }))).order.map((o) => recs.find((r) => r.id === o.key));

  router.post('/mark-done', route(async ({ req, res, acc }) => {
    const b = req.body;
    const { collection, ids, single } = containerIds(b);
    if (b.date !== undefined && b.date !== null && !isRealDate(b.date)) throw new HttpError(400, 'INVALID_PAYLOAD', 'date must be a day, YYYY-MM-DD.');
    if (b.personId !== undefined && b.personId !== null && !(typeof b.personId === 'string' && UUID.test(b.personId))) {
      throw new HttpError(400, 'INVALID_PAYLOAD', 'personId must be the id of a person.');
    }
    const { dateField } = DONE[collection];
    const schema = await schemaOf(req);
    // All of them, in ONE transaction: all done or none.
    await inTransaction(acc, async (trx) => {
      const svc = (c) => itemsFor(schema, req.accountability, c, trx);
      const recs = await readContainers(svc, trx, collection, ids);
      if (recs.some((r) => r.state !== 'planned')) throw new HttpError(409, 'ALREADY_DONE', recs.length > 1 ? 'One of those records is already marked done.' : 'That record is already marked done.');
      const checks = [];
      // What the forms mark required must be filled in; the date is the one thing this action supplies.
      const required = parseRequired(rowsOf(await trx.raw(SQL.requiredFields)));
      for (const { id, rec } of recs) {
        for (const { field, label } of (required[collection] ?? []).filter((f) => f.field !== dateField)) {
          if (isBlank(rec[field])) checks.push({ key: id, field, level: 'block', code: 'REQUIRED', text: `${label} is required before this can be marked done.` });
        }
      }
      // Done work needs samples that exist. A sample that is still planned is a block, unless a record marked done in this very
      // call makes it (they are written in that order).
      const making = new Set(recs.map((r) => refOf(r.rec.output_sample_id)).filter(Boolean));
      const inputs = new Map(); // record id -> the samples it works on
      for (const { id, rec } of recs) {
        if (collection === 'manufacturing_operations') inputs.set(id, [rec.sample_id].filter(Boolean).map(lower));
        else inputs.set(id, rowsOf(await trx.raw(SQL.testSubjects, [id])).map((r) => lower(r.sample_id)));
      }
      const wanted = [...new Set([...inputs.values()].flat())];
      const status = new Map();
      if (wanted.length) for (const r of rowsOf(await trx.raw(SQL.sampleInfo, [wanted.join(',')]))) status.set(lower(r.sample_id), r.current_status);
      for (const [id, samples] of inputs) {
        if (samples.some((sid) => status.get(sid) === 'planned' && !making.has(`id:${sid}`))) {
          checks.push({ key: id, level: 'block', code: 'STRUCTURE', text: 'Its sample is still planned; mark the operation that makes it done first.' });
        }
      }
      // An operation's planned output turns active, so what the sample's form marks required must be there too (as the caller
      // reads it; an output they cannot read is left to the update, which will refuse it).
      const outputs = new Map(); // record id -> output sample id
      if (collection === 'manufacturing_operations') {
        for (const { id, rec } of recs) {
          if (!rec.output_sample_id) continue;
          const sid = lower(rec.output_sample_id);
          if (sid === lower(rec.sample_id ?? '')) continue;
          const [sample] = rowsOf(await trx.raw(SQL.lockRecord.physical_samples, [sid]));
          if (sample?.state !== 'planned') continue;
          outputs.set(id, sid);
          let row = null;
          try {
            row = await svc('physical_samples').readOne(sid, { fields: ['*'] });
          } catch (err) {
            if (!isDenied(err)) throw err;
          }
          if (!row) continue;
          for (const { field, label } of required.physical_samples ?? []) {
            if (isBlank(row[field])) checks.push({ key: sid, field, level: 'block', code: 'REQUIRED', text: `${label} is required before the sample it makes can be made active.` });
          }
        }
      }
      if (checks.length) throw new HttpError(409, 'CHECKS', 'Fill in what is missing before marking this done.', { checks });

      let person = null;
      if (b.personId) {
        const [p] = rowsOf(await trx.raw(SQL.personExists, [b.personId.toLowerCase()]));
        if (!p) throw new HttpError(400, 'INVALID_PAYLOAD', 'That person does not exist.');
        person = p.person_id;
      } else {
        const [p] = rowsOf(await trx.raw(SQL.personOfUser, [acc.user]));
        person = p?.person_id ?? null;
      }
      const day = b.date ?? clock().toISOString().slice(0, 10);
      const data = { work_state: 'done', [dateField]: `${day}T00:00:00.000Z`, done_at: clock().toISOString() };
      if (person) data.done_by_person_id = person;
      // Each record first (the caller's update rule decides), then its planned output turns active: what makes a sample first.
      for (const { id } of collection === 'manufacturing_operations' ? inOrder(recs) : recs) {
        try {
          await svc(collection).updateOne(id, data);
          if (outputs.has(id)) await svc('physical_samples').updateOne(outputs.get(id), { current_status: 'active' });
        } catch (err) {
          throw refused(err);
        }
      }
    });
    await clearDataCache(req);
    res.json({ data: answer(ids, 'done', single) });
  }));

  // Back to planned: one transaction for the whole container. The access guard (owner or admin) is the rule, run by ItemsService
  // for each record; the output samples go back to planned unless something done hangs off them.
  router.post('/mark-planned', route(async ({ req, res, acc }) => {
    const { collection, ids, single } = containerIds(req.body);
    const { dateField } = DONE[collection];
    const schema = await schemaOf(req);
    await inTransaction(acc, async (trx) => {
      const svc = (c) => itemsFor(schema, req.accountability, c, trx);
      const recs = await readContainers(svc, trx, collection, ids);
      if (recs.some((r) => r.state !== 'done')) {
        throw new HttpError(409, 'ALREADY_PLANNED', recs.length > 1 ? 'One of those records is not marked done.' : 'That record is not marked done.');
      }
      const checks = [];
      const back = new Map(); // record id -> the output sample that goes back to planned
      if (collection === 'manufacturing_operations') {
        const outs = recs.map((r) => ({ id: r.id, sid: r.rec.output_sample_id ? lower(r.rec.output_sample_id) : null, input: r.rec.sample_id ? lower(r.rec.sample_id) : null }))
          .filter((o) => o.sid && o.sid !== o.input);
        const csv = outs.map((o) => o.sid).join(',');
        const hanging = new Map(); // sample id -> done records that point at it, other than the ones going back
        if (outs.length) {
          const mine = new Set(ids);
          const add = (sid, id) => { if (sid && !mine.has(lower(id))) hanging.set(lower(sid), [...(hanging.get(lower(sid)) ?? []), id]); };
          for (const r of rowsOf(await trx.raw(SQL.refsOperations, [csv, csv]))) {
            if (r.work_state === 'done') { add(r.sample_id, r.operation_id); add(r.output_sample_id, r.operation_id); }
          }
          for (const r of [...rowsOf(await trx.raw(SQL.refsTests, [csv])), ...rowsOf(await trx.raw(SQL.refsSubjects, [csv]))]) {
            if (r.work_state === 'done') add(r.sample_id, r.session_id);
          }
        }
        for (const { id, sid } of outs) {
          const [sample] = rowsOf(await trx.raw(SQL.lockRecord.physical_samples, [sid]));
          if (sample?.state !== 'active') continue; // consumed, archived ...: not ours to move
          if (hanging.has(sid)) {
            let code = 'a sample';
            try {
              code = (await svc('physical_samples').readOne(sid, { fields: ['sample_code'] }))?.sample_code ?? code;
            } catch (err) {
              if (!isDenied(err)) throw err;
            }
            checks.push({ key: id, level: 'block', code: 'REMOVE_BLOCKED', text: `Something done hangs off ${code}, so it cannot go back to planned.` });
          } else {
            back.set(id, sid);
          }
        }
      }
      if (checks.length) throw new HttpError(409, 'CHECKS', 'Something done depends on this, so it cannot go back to planned.', { checks });
      const data = { work_state: 'planned', [dateField]: null, done_by_person_id: null, done_at: null };
      for (const { id } of recs) {
        try {
          await svc(collection).updateOne(id, data);
          if (back.has(id)) await svc('physical_samples').updateOne(back.get(id), { current_status: 'planned' });
        } catch (err) {
          throw refused(err);
        }
      }
    });
    await clearDataCache(req);
    res.json({ data: answer(ids, 'planned', single) });
  }));

  // -- create (spec 6.1) ----------------------------------------------------------------------------------------------------

  router.post('/drafts/:id/create', route(async ({ req, res, acc }) => {
    const id = idParam(req, 'draft');
    const schema = await schemaOf(req);
    const out = await inTransaction(acc, async (trx) => {
      // 1. The draft, locked, and its checks re-run inside the transaction.
      const [row] = rowsOf(await trx.raw(SQL.lockDraft, [id, acc.user]));
      if (!row) throw new HttpError(404, 'NOT_FOUND', 'That draft does not exist. It may have been created already.');
      const body = draftOut(row).body;
      const valid = validateDraftBody(body);
      if (!valid.ok) throw new HttpError(400, 'INVALID_PAYLOAD', valid.message);
      const ctx = await loadContext(req, body, { db: trx, knex: trx, lock: true });
      const { checks, plan } = buildPlan(body, ctx);
      if (checks.some((c) => c.level === 'block')) {
        throw new HttpError(409, 'CHECKS', 'Some things are missing, so nothing was created.', { checks });
      }

      const svc = (collection) => itemsFor(schema, req.accountability, collection, trx);
      const attempt = async (key, fn) => {
        try {
          return await fn();
        } catch (err) {
          throw writeFailed(key, err);
        }
      };
      // The record is still as the checks saw it (it is locked now): its version, and that it is still planned.
      const lock = async (key, collection, idValue) => {
        const [r] = rowsOf(await trx.raw(SQL.lockRecord[collection], [idValue]));
        return r ?? null;
      };
      const created = {};
      const newSampleIds = [];
      const sampleId = new Map(); // item key -> the id of the sample made for it
      const refId = (ref) => (ref ? (ref.startsWith('id:') ? ref.slice(3) : sampleId.get(ref.slice(5))) : undefined);
      const record = async (key, collection, idValue) => {
        const [r] = rowsOf(await trx.raw(SQL.codeOf[collection], [idValue]));
        created[key] = { collection, id: idValue, code: r?.code ?? null };
      };
      const project = (values) => (isBlank(values.project_id) ? (body.projectId ?? undefined) : values.project_id);
      const campaign = (values) => (isBlank(values.campaign_id) ? (body.campaignId ?? undefined) : values.campaign_id);

      // 2. Removals: tests, operations, then the samples that go with them (each locked, and still planned).
      for (const [list, collection] of [
        [plan.removals.tests, 'test_sessions'], [plan.removals.operations, 'manufacturing_operations'], [plan.removals.samples, 'physical_samples'],
      ]) {
        for (const r of list) {
          const now = await attempt(r.key, () => lock(r.key, collection, r.id));
          if (now && now.state !== 'planned') throw staleChecks(r.key, 'Done records are never deleted from the map.', 'REMOVE_BLOCKED');
          await attempt(r.key, () => svc(collection).deleteOne(r.id));
        }
      }
      // 3. Edits to existing records, each against the version it was made on.
      for (const e of plan.edits) {
        const now = await attempt(e.key, () => lock(e.key, e.collection, e.id));
        if (!now || Number(now.version) !== e.version) throw staleChecks(e.key, 'Changed since you added it. Your edits were made against an older version, so review it first.', 'STALE_VERSION');
        await attempt(e.key, () => svc(e.collection).updateOne(e.id, editValues(e.values)));
      }
      // 4. New samples, in key order (the code trigger numbers them in this order).
      for (const s of plan.samples) {
        const data = cleanValues(s.values);
        if (s.planned) data.current_status = 'planned';
        const newId = await attempt(s.key, () => svc('physical_samples').createOne(data));
        sampleId.set(s.key, newId);
        newSampleIds.push(newId);
        await record(s.key, 'physical_samples', newId);
        if (body.campaignId) {
          await attempt(s.key, () => svc('campaign_samples').createOne({ campaign_id: body.campaignId, sample_id: newId }));
        }
      }
      // 5. One batch for every operation with several rows.
      const batchId = new Map();
      for (const b of plan.batches) {
        const day = dayOf(b.workState === 'done' ? b.values.operation_date : b.values.planned_date);
        batchId.set(b.key, await attempt(b.key, () => svc('batches').createOne(day ? { batch_date: day } : {})));
      }
      // 6. New and attached operations, in the order of the wires.
      for (const r of plan.operations) {
        if (r.mode === 'attach') {
          const now = await attempt(r.itemKey, () => lock(r.itemKey, 'manufacturing_operations', r.existingId));
          if (!now || Number(now.version) !== r.version) throw staleChecks(r.itemKey, 'Changed since you added it. Your edits were made against an older version, so review it first.', 'STALE_VERSION');
          if (now.sample_id) throw staleChecks(r.itemKey, 'It got an input in the meantime, so it cannot be attached any more.', 'NOT_ATTACHABLE');
          await attempt(r.itemKey, () => svc('manufacturing_operations').updateOne(r.existingId, { ...editValues(r.values), sample_id: refId(r.input) }));
          continue;
        }
        const data = {
          ...cleanValues(r.values, r.workState === 'planned' ? ['operation_date'] : []),
          work_state: r.workState,
        };
        if (r.input) data.sample_id = refId(r.input);
        if (r.output) data.output_sample_id = refId(r.output);
        if (r.batchKey) data.batch_id = batchId.get(r.batchKey);
        const pid = project(r.values);
        if (pid !== undefined) data.project_id = pid;
        const cid = campaign(r.values);
        if (cid !== undefined) data.campaign_id = cid;
        const newId = await attempt(r.itemKey, () => svc('manufacturing_operations').createOne(data));
        await record(r.key, 'manufacturing_operations', newId);
        if (!(r.itemKey in created)) created[r.itemKey] = created[r.key];
      }
      // 7. New tests, with their samples as subjects.
      for (const t of plan.tests) {
        const data = {
          ...cleanValues(t.values, t.workState === 'planned' ? ['session_date'] : []),
          work_state: t.workState,
          subject: { create: t.subjects.map((ref) => ({ collection: 'physical_samples', item: refId(ref) })) },
        };
        const pid = project(t.values);
        if (pid !== undefined) data.project_id = pid;
        const cid = campaign(t.values);
        if (cid !== undefined) data.campaign_id = cid;
        const newId = await attempt(t.key, () => svc('test_sessions').createOne(data));
        await record(t.key, 'test_sessions', newId);
      }
      // 8. The draft is done with.
      await trx.raw(SQL.deleteDraft, [id, acc.user]);
      return { created, sampleIds: newSampleIds };
    });
    await clearDataCache(req);
    res.json({ data: out });
  }));
}

export default {
  id: SOURCE,
  handler: (router, context) => mount(router, context),
};
